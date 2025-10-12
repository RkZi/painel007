// workers/auditWorker.js
import express from "express";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { logInfo, logError } from "../utils/logger.js";

dotenv.config();
const router = express.Router();

// ============================
// Conexão com o banco do Painel
// ============================
async function connectPanelDB() {
  return await mysql.createConnection({
    host: process.env.PANEL_DB_HOST,
    port: process.env.PANEL_DB_PORT || 3306,
    user: process.env.PANEL_DB_USER,
    password: process.env.PANEL_DB_PASS,
    database: process.env.PANEL_DB_NAME,
    multipleStatements: false,
    connectTimeout: 60000,
  });
}

// ============================
// Helpers
// ============================

function cents(n) {
  // evita problemas de ponto flutuante
  return Math.round(Number(n) * 100);
}
function moneyEqual(a, b, tolerance = 1) {
  // compara em centavos (tolerance em centavos; 1 = R$0,01)
  return Math.abs(cents(a) - cents(b)) <= tolerance;
}

async function logAudit(conn, action, details, userId = null, casinoId = null) {
  try {
    const id = uuidv4();
    await conn.execute(
      `INSERT INTO audit_logs (id, user_id, action, details, created_at, casino_id)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      [id, userId, action, JSON.stringify(details || {}), casinoId]
    );
  } catch (e) {
    // não falha a auditoria por causa de log
    logError("[AUDIT] Falha ao registrar audit_logs", e);
  }
}

// Busca 1 contrato aplicável para o depósito (prioriza o mais recente)
async function pickApplicableContract(conn, influencerId, casinoId, depositedAt) {
  const [rows] = await conn.execute(
    `SELECT id, influencer_id, base_commission_percent, contract_type, start_date, end_date, active, casino_id
     FROM affiliate_contracts
     WHERE influencer_id = ?
       AND active = 1
       AND (casino_id IS NULL OR casino_id = ?)
       AND (start_date IS NULL OR ? >= start_date)
       AND (end_date IS NULL OR ? <= end_date)
     ORDER BY 
       (start_date IS NULL) ASC,   -- prefere start_date definido
       start_date DESC,            -- mais recente primeiro
       base_commission_percent DESC
     LIMIT 1`,
    [influencerId, casinoId, depositedAt, depositedAt]
  );
  return rows[0] || null;
}

// ============================
// Etapas de auditoria
// ============================

async function fixPlayersInfluencerLink(conn) {
  // Preenche players_sync.influencer_id via inviter_code -> influencers.code
  const [result] = await conn.execute(
    `UPDATE players_sync p
     JOIN influencers i ON i.code = p.inviter_code
     SET p.influencer_id = i.id
     WHERE p.influencer_id IS NULL AND p.inviter_code IS NOT NULL`
  );
  if (result.affectedRows > 0) {
    logInfo(`[AUDIT] players_sync vinculados ao influencer: ${result.affectedRows}`);
    await logAudit(conn, "AUDIT_FIX_PLAYER_INFLUENCER", { affected: result.affectedRows });
  }
  return result.affectedRows || 0;
}

async function fixDepositsMissingInfluencer(conn) {
  // Tenta puxar influencer a partir do player
  const [result] = await conn.execute(
    `UPDATE deposits_sync d
     JOIN players_sync p ON p.id = d.player_id
     SET d.influencer_id = p.influencer_id
     WHERE d.influencer_id IS NULL
       AND p.influencer_id IS NOT NULL`
  );
  if (result.affectedRows > 0) {
    logInfo(`[AUDIT] deposits_sync com influencer_id corrigido: ${result.affectedRows}`);
    await logAudit(conn, "AUDIT_FIX_DEPOSIT_INFLUENCER", { affected: result.affectedRows });
  }
  return result.affectedRows || 0;
}

async function normalizeFirstDepositFlag(conn) {
  // Garante is_first = 1 somente no primeiro depósito do player
  const [result] = await conn.execute(
    `UPDATE deposits_sync d
     JOIN (
       SELECT player_id, MIN(deposited_at) AS first_at
       FROM deposits_sync
       GROUP BY player_id
     ) x ON x.player_id = d.player_id
     SET d.is_first = CASE WHEN d.deposited_at = x.first_at THEN 1 ELSE 0 END`
  );
  if (result.affectedRows > 0) {
    logInfo(`[AUDIT] Normalização de is_first aplicada em ${result.affectedRows} linhas`);
    await logAudit(conn, "AUDIT_NORMALIZE_FIRST_DEPOSIT", { affected: result.affectedRows });
  }
  return result.affectedRows || 0;
}

async function createMissingCommissions(conn) {
  // Seleciona depósitos sem comissão gerada
  const [deposits] = await conn.execute(
    `SELECT d.id, d.player_id, d.influencer_id, d.amount, d.deposited_at, d.is_first, d.casino_id, d.casino_deposit_id
     FROM deposits_sync d
     LEFT JOIN commissions c ON c.deposit_id = d.id
     WHERE c.id IS NULL
       AND d.influencer_id IS NOT NULL
       AND d.casino_deposit_id IS NOT NULL`
  );

  let created = 0;
  for (const d of deposits) {
    try {
      const contract = await pickApplicableContract(conn, d.influencer_id, d.casino_id, d.deposited_at);
      if (!contract) {
        logInfo("[AUDIT] Sem contrato aplicável para depósito", { deposit: d.id, influencer: d.influencer_id });
        continue;
      }
      if (contract.contract_type === "first_deposit" && Number(d.is_first) !== 1) {
        // contrato só paga primeiro depósito
        continue;
      }

      const percent = Number(contract.base_commission_percent || 0);
      const commissionAmount = (Number(d.amount) * percent) / 100;

      const commissionId = uuidv4();
      await conn.execute(
        `INSERT INTO commissions
           (id, deposit_id, influencer_id, commission_amount, status, created_at, updated_at, casino_id, casino_deposit_id)
         VALUES (?, ?, ?, ?, 'available', NOW(), NOW(), ?, ?)`,
        [commissionId, d.id, d.influencer_id, commissionAmount, d.casino_id, d.casino_deposit_id]
      );
      created++;
      logInfo("[AUDIT] Comissão criada", {
        commission_id: commissionId,
        deposit_id: d.id,
        amount: commissionAmount,
        percent,
      });
      await logAudit(
        conn,
        "AUDIT_CREATE_COMMISSION",
        { commission_id: commissionId, deposit_id: d.id, amount: commissionAmount, percent },
        d.influencer_id,
        d.casino_id
      );
    } catch (e) {
      // pode violar UNIQUE (casino_id, casino_deposit_id) em corrida com outro worker; ignora com log
      logError("[AUDIT] Falha ao criar comissão", { deposit_id: d.id, err: e?.message || e });
    }
  }
  if (created > 0) logInfo(`[AUDIT] Comissões criadas: ${created}`);
  return created;
}

async function fixDivergentCommissions(conn) {
  // Recalcula e ajusta comissões já existentes se divergirem do contrato
  const [rows] = await conn.execute(
    `SELECT c.id AS commission_id, c.commission_amount, c.status, c.influencer_id, c.casino_id,
            d.id AS deposit_id, d.amount AS deposit_amount, d.deposited_at, d.is_first
     FROM commissions c
     JOIN deposits_sync d ON d.id = c.deposit_id
     WHERE c.influencer_id IS NOT NULL`
  );

  let updated = 0;
  for (const row of rows) {
    const contract = await pickApplicableContract(conn, row.influencer_id, row.casino_id, row.deposited_at);
    if (!contract) continue;

    if (contract.contract_type === "first_deposit" && Number(row.is_first) !== 1) {
      // Se não deveria ter comissão (first_deposit), opcionalmente poderíamos zerar/invalidar.
      // Aqui só logamos divergência.
      continue;
    }

    const expected = (Number(row.deposit_amount) * Number(contract.base_commission_percent || 0)) / 100;

    if (!moneyEqual(row.commission_amount, expected)) {
      await conn.execute(
        `UPDATE commissions SET commission_amount = ?, updated_at = NOW() WHERE id = ?`,
        [expected, row.commission_id]
      );
      updated++;
      logInfo("[AUDIT] Comissão ajustada", {
        commission_id: row.commission_id,
        from: row.commission_amount,
        to: expected,
      });
      await logAudit(
        conn,
        "AUDIT_FIX_COMMISSION_AMOUNT",
        { commission_id: row.commission_id, from: row.commission_amount, to: expected },
        row.influencer_id,
        row.casino_id
      );
    }
  }
  if (updated > 0) logInfo(`[AUDIT] Comissões ajustadas: ${updated}`);
  return updated;
}

async function verifyPendingCommissions(conn) {
  // Busca comissões pendentes e dados do cassino
  const [pending] = await conn.execute(`
    SELECT c.id AS commission_id, c.deposit_id, c.casino_id, c.casino_deposit_id,
           d.player_id,
           ca.name AS casino_name, ca.db_host, ca.db_port, ca.db_user, ca.db_password, ca.db_name
    FROM commissions c
    JOIN deposits_sync d ON d.id = c.deposit_id
    JOIN casinos ca ON ca.id = c.casino_id
    WHERE c.status = 'pending'
  `);

  if (pending.length === 0) {
    logInfo("[AUDIT] Nenhuma comissão pendente para verificar.");
    return 0;
  }

  let confirmed = 0;

  for (const c of pending) {
    let casinoConn;
    try {
      casinoConn = await mysql.createConnection({
        host: c.db_host,
        port: c.db_port || 3306,
        user: c.db_user,
        password: c.db_password,
        database: c.db_name,
        connectTimeout: 60000,
      });

      // 1️⃣ Busca o payment_id na tabela deposits do cassino
      const [depositRow] = await casinoConn.execute(
        `SELECT payment_id FROM deposits WHERE id = ? LIMIT 1`,
        [c.casino_deposit_id]
      );

      if (!depositRow.length) {
        logInfo(`[AUDIT] Nenhum depósito encontrado no cassino ${c.casino_name} para casino_deposit_id ${c.casino_deposit_id}`);
        continue;
      }

      const paymentId = depositRow[0].payment_id;

      // 2️⃣ Busca o status na tabela transactions
      const [txRow] = await casinoConn.execute(
        `SELECT status FROM transactions WHERE payment_id = ? LIMIT 1`,
        [paymentId]
      );

      if (txRow.length && Number(txRow[0].status) === 1) {
        await conn.execute(
          `UPDATE commissions
             SET status = 'available',
                 confirmed_at = NOW(),
                 notes = 'Transaction verified (status=1) via auditWorker'
           WHERE id = ?`,
          [c.commission_id]
        );
        confirmed++;
        logInfo(`[AUDIT] Comissão ${c.commission_id} confirmada (cassino ${c.casino_name})`);
        await logAudit(conn, "AUDIT_COMMISSION_CONFIRMED", { commission_id: c.commission_id, casino: c.casino_name });
      } else {
        logInfo(`[AUDIT] Comissão ${c.commission_id} ainda pendente (transaction status != 1)`);
      }

      await casinoConn.end();
    } catch (err) {
      logError(`[AUDIT] Erro ao verificar comissão ${c.commission_id}`, err);
    }
  }

  if (confirmed > 0) logInfo(`[AUDIT] Comissões confirmadas: ${confirmed}`);
  return confirmed;
}

async function refreshWalletBalances(conn) {
  // total_earned = SUM(commissions WHERE status='available')
  // total_withdrawn = SUM(payouts WHERE status='approved')  (conforme orientação)
  // current_balance = total_earned - total_withdrawn
  const [rows] = await conn.execute(
    `SELECT i.id AS influencer_id,
            COALESCE(SUM(CASE WHEN c.status='available' THEN c.commission_amount ELSE 0 END),0) AS total_earned,
            COALESCE(SUM(CASE WHEN p.status='approved' THEN p.total_amount ELSE 0 END),0) AS total_withdrawn
     FROM influencers i
     LEFT JOIN commissions c ON c.influencer_id = i.id
     LEFT JOIN payouts p ON p.influencer_id = i.id
     GROUP BY i.id`
  );

  let upserts = 0;
  let negatives = 0;
  for (const r of rows) {
    const current = Number(r.total_earned) - Number(r.total_withdrawn);
    if (current < 0) negatives++;

    await conn.execute(
      `INSERT INTO wallet_balances (influencer_id, total_earned, total_withdrawn, current_balance, updated_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         total_earned = VALUES(total_earned),
         total_withdrawn = VALUES(total_withdrawn),
         current_balance = VALUES(current_balance),
         updated_at = NOW()`,
      [r.influencer_id, r.total_earned, r.total_withdrawn, current]
    );
    upserts++;
  }

  logInfo(`[AUDIT] wallet_balances atualizadas: ${upserts}`);
  if (negatives > 0) {
    logError(`[AUDIT] Carteiras negativas detectadas: ${negatives}`);
    await logAudit(conn, "AUDIT_WALLET_NEGATIVE", { count: negatives });
  }
  return { upserts, negatives };
}

// ============================
// Runner
// ============================

async function runAuditOnce() {
  const conn = await connectPanelDB();
  const startedAt = new Date().toISOString();
  const summary = {
    startedAt,
    fixedPlayerLinks: 0,
    fixedDepositInfluencers: 0,
    normalizedFirst: 0,
    commissionsCreated: 0,
    commissionsAdjusted: 0,
    verifiedPending: 0,
    walletUpserts: 0,
    walletNegatives: 0,
  };

  try {
    logInfo("[AUDIT] ================== Início do ciclo de auditoria ==================");
    summary.fixedPlayerLinks = await fixPlayersInfluencerLink(conn);
    summary.fixedDepositInfluencers = await fixDepositsMissingInfluencer(conn);
    summary.normalizedFirst = await normalizeFirstDepositFlag(conn);
    summary.commissionsCreated = await createMissingCommissions(conn);
    summary.commissionsAdjusted = await fixDivergentCommissions(conn);
    summary.verifiedPending = await verifyPendingCommissions(conn);
    const wallet = await refreshWalletBalances(conn);
    summary.walletUpserts = wallet.upserts;
    summary.walletNegatives = wallet.negatives;
    logInfo("[AUDIT] Ciclo concluído", summary);
    await logAudit(conn, "AUDIT_CYCLE_SUMMARY", summary);
  } catch (err) {
    logError("[AUDIT] Erro no ciclo de auditoria", err);
    await logAudit(conn, "AUDIT_CYCLE_ERROR", { error: String(err?.message || err) });
  } finally {
    await conn.end();
  }

  return summary;
}

// ============================
// Rotas HTTP
// ============================

router.post("/worker/audit/run", async (_req, res) => {
  const summary = await runAuditOnce();
  res.json({ status: "ok", summary });
});

router.get("/worker/audit/health", async (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ============================
// Agendamento automático
// ============================
const intervalMs = Number(process.env.AUDIT_INTERVAL_MS || 5000);
setInterval(() => {
  runAuditOnce();
}, intervalMs);

logInfo(`[AUDIT] Worker carregado. Intervalo: ${intervalMs}ms`);

export default router;