import { v4 as uuidv4 } from "uuid";
import { logInfo, logError } from "../utils/logger.js";

/**
 * Gera comissões a partir de deposits_sync
 * - Respeita contract_type (first_deposit vs all_deposits)
 * - Evita duplicação pelo UNIQUE (casino_id + casino_deposit_id)
 */
export async function syncCommissions(casino, panelConn) {
  try {
    // buscar depósitos que ainda não têm comissão
    const [pendingDeposits] = await panelConn.execute(
      `SELECT d.id AS deposit_id,
              d.amount,
              d.is_first,
              d.influencer_id,
              d.casino_deposit_id,
              ac.base_commission_percent,
              ac.contract_type,
              ap.level_id,
              al.bonus_percent
       FROM deposits_sync d
       JOIN influencers i ON d.influencer_id = i.id
       JOIN affiliate_contracts ac ON ac.influencer_id = i.id 
                                   AND ac.casino_id = d.casino_id 
                                   AND ac.active = 1
       LEFT JOIN affiliate_progress ap ON ap.influencer_id = i.id 
                                       AND ap.casino_id = d.casino_id
       LEFT JOIN affiliate_levels al ON al.id = ap.level_id
       WHERE d.casino_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM commissions c 
           WHERE c.casino_id = d.casino_id 
             AND c.casino_deposit_id = d.casino_deposit_id
         )`,
      [casino.id]
    );

    for (const dep of pendingDeposits) {
      // regra de contrato
      if (dep.contract_type === "first_deposit" && dep.is_first !== 1) {
        continue; // contrato é só para primeiro depósito
      }

      // calcular comissão: base + bônus do nível atual
      const bonus = dep.bonus_percent || 0;
      const percent = parseFloat(dep.base_commission_percent) + parseFloat(bonus);
      const commissionAmount = (dep.amount * percent) / 100;

      await panelConn.execute(
        `INSERT INTO commissions 
         (id, deposit_id, influencer_id, commission_amount, status, casino_id, casino_deposit_id)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        [uuidv4(), dep.deposit_id, dep.influencer_id, commissionAmount, casino.id, dep.casino_deposit_id]
      );

      logInfo(
        `[${casino.name}] Comissão gerada (${commissionAmount}) para influencer ${dep.influencer_id} no depósito ${dep.deposit_id}`
      );
    }
  } catch (err) {
    logError(`[${casino.name}] Erro no syncCommissions`, err);
  }
}