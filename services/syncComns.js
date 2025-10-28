import { v4 as uuidv4 } from "uuid";
import { logInfo, logError } from "../utils/logger.js";

/**
 * Gera comissões a partir dos depósitos
 */
export async function syncComns(casino, panelConn) {
  logInfo(`[${casino.name}] [syncComns] Iniciando sincronização de comissões...`);

  try {
    const [deposits] = await panelConn.execute(
      `SELECT d.id, d.affiliate_id, d.amount, d.is_first, d.casino_deposit_id
       FROM deposits_sync d
       LEFT JOIN commissions c ON c.deposit_id = d.id
       WHERE d.casino_id = ? AND c.id IS NULL`,
      [casino.id]
    );
    logInfo(`[${casino.name}] [syncComns] Depósitos sem comissão: ${deposits.length}`);

    for (const dep of deposits) {
      try {
        // Buscar contrato do affiliate
        const [contracts] = await panelConn.execute(
          `SELECT base_commission_percent, contract_type
           FROM affiliate_contracts
           WHERE affiliate_id = ? AND casino_id = ? AND active = 1`,
          [dep.affiliate_id, casino.id]
        );
        if (contracts.length === 0) {
          logError(`[${casino.name}] [syncComns] Nenhum contrato encontrado para affiliate ${dep.affiliate_id}`);
          continue;
        }
        const contract = contracts[0];
        if (contract.contract_type === "first_deposit" && dep.is_first === 0) {
          logInfo(`[${casino.name}] [syncComns] Ignorando depósito ${dep.id}, contrato apenas primeiro depósito`);
          continue;
        }

        const commissionAmount = (dep.amount * contract.base_commission_percent) / 100;
        const commissionId = uuidv4();

        await panelConn.execute(
          `INSERT INTO commissions
            (id, deposit_id, affiliate_id, commission_amount, status, casino_id, casino_deposit_id)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          [
            commissionId,
            dep.id,
            dep.affiliate_id,
            commissionAmount,
            casino.id,
            dep.casino_deposit_id,
          ]
        );

        logInfo(`[${casino.name}] [syncComns] Comissão criada: ${commissionId} (${commissionAmount})`);
      } catch (innerErr) {
        logError(`[${casino.name}] [syncComns] Erro processando comissão de depósito ${dep.id}`, innerErr);
      }
    }
  } catch (err) {
    logError(`[${casino.name}] [syncComns] Erro geral`, err);
  }
}