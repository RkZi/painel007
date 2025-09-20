import { v4 as uuidv4 } from "uuid";
import { logInfo, logError } from "../utils/logger.js";

/**
 * Sincroniza depósitos do cassino para deposits_sync
 * - Evita duplicados pelo UNIQUE (casino_id + casino_deposit_id)
 * - Marca se é primeiro depósito do player
 * - Liga ao influencer_id herdado de players_sync
 */
export async function syncDeposits(casino, deposits, panelConn) {
  try {
    for (const dep of deposits) {
      // verificar se já existe no painel
      const [exists] = await panelConn.execute(
        `SELECT id FROM deposits_sync 
         WHERE casino_id = ? AND casino_deposit_id = ?`,
        [casino.id, dep.casino_deposit_id]
      );
      if (exists.length > 0) continue;

      // localizar player no painel
      const [playerRows] = await panelConn.execute(
        `SELECT id, influencer_id, total_deposits 
         FROM players_sync 
         WHERE casino_id = ? AND casino_user_id = ?`,
        [casino.id, dep.casino_user_id]
      );
      if (playerRows.length === 0) {
        logError(`[${casino.name}] Player não encontrado para depósito ${dep.casino_deposit_id}`);
        continue;
      }

      const player = playerRows[0];
      const isFirst = player.total_deposits === 0 ? 1 : 0;

      // inserir depósito
      const depositId = uuidv4();
      await panelConn.execute(
        `INSERT INTO deposits_sync 
         (id, player_id, influencer_id, amount, currency, is_first, deposited_at, casino_id, casino_deposit_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          depositId,
          player.id,
          player.influencer_id,
          dep.amount,
          dep.currency || "BRL",
          isFirst,
          dep.created_at,
          casino.id,
          dep.casino_deposit_id,
        ]
      );

      logInfo(`[${casino.name}] Depósito sync ID ${depositId} (${dep.amount})`);
    }
  } catch (err) {
    logError(`[${casino.name}] Erro no syncDeposits`, err);
  }
}