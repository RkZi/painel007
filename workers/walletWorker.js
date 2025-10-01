import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { logInfo, logError } from "../utils/logger.js";

dotenv.config();

/**
 * Conexão com painel (global)
 */
async function connectPanelDB() {
  return await mysql.createConnection({
    host: process.env.PANEL_DB_HOST,
    port: process.env.PANEL_DB_PORT || 3306,
    user: process.env.PANEL_DB_USER,
    password: process.env.PANEL_DB_PASS,
    database: process.env.PANEL_DB_NAME,
    connectTimeout: 60000,
  });
}

/**
 * Worker: recalcula os saldos das carteiras
 */
export async function runWalletWorker() {
  let conn;
  try {
    conn = await connectPanelDB();

    // Buscar todos influencers
    const [influencers] = await conn.execute(`SELECT id FROM influencers`);
    logInfo(`[WALLET] Encontrados ${influencers.length} influencers para processar.`);

    for (const inf of influencers) {
      // Total ganho: todas comissões disponíveis
      const [earnedRows] = await conn.execute(
        `SELECT COALESCE(SUM(commission_amount), 0) AS total_earned
         FROM commissions
         WHERE influencer_id = ? AND status = 'available'`,
        [inf.id]
      );
      const totalEarned = parseFloat(earnedRows[0].total_earned);

      // Total sacado: apenas payouts aprovados
      const [withdrawnRows] = await conn.execute(
        `SELECT COALESCE(SUM(total_amount), 0) AS total_withdrawn
         FROM payouts
         WHERE influencer_id = ? AND status = 'approved'`,
        [inf.id]
      );
      const totalWithdrawn = parseFloat(withdrawnRows[0].total_withdrawn);

      const currentBalance = totalEarned - totalWithdrawn;

      logInfo(
        `[WALLET] Influencer ${inf.id} -> Ganhou: ${totalEarned}, Sacou: ${totalWithdrawn}, Saldo: ${currentBalance}`
      );

      // Upsert no wallet_balances
      await conn.execute(
        `INSERT INTO wallet_balances (influencer_id, total_earned, total_withdrawn, current_balance)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           total_earned = VALUES(total_earned),
           total_withdrawn = VALUES(total_withdrawn),
           current_balance = VALUES(current_balance),
           updated_at = CURRENT_TIMESTAMP`,
        [inf.id, totalEarned, totalWithdrawn, currentBalance]
      );
    }

    logInfo("[WALLET] Worker finalizado com sucesso.");
  } catch (err) {
    logError("[WALLET] Erro no worker", err);
  } finally {
    if (conn) await conn.end();
  }
}

// Executar a cada 3 segundos
setInterval(runWalletWorker, 3000);