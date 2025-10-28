import { v4 as uuidv4 } from "uuid";
import { logInfo, logError } from "../utils/logger.js";
import mysql from "mysql2/promise";

/**
 * Sincroniza depósitos do cassino para deposits_sync
 */
export async function syncDeposits(casino, panelConn) {
  logInfo(`[${casino.name}] [syncDeposits] Iniciando sincronização de depósitos...`);

  let casinoConn;
  try {
    casinoConn = await mysql.createConnection({
      host: casino.db_host,
      port: casino.db_port,
      user: casino.db_user,
      password: casino.db_password,
      database: casino.db_name,
      connectTimeout: 60000,
    });
    logInfo(`[${casino.name}] [syncDeposits] Conectado ao DB do cassino.`);

    // Buscar depósitos do cassino
    const [deposits] = await casinoConn.execute(`
      SELECT d.id AS casino_deposit_id,
             d.user_id AS casino_user_id,
             d.amount,
             d.currency,
             d.created_at
      FROM deposits d
    `);
    logInfo(`[${casino.name}] [syncDeposits] Total de depósitos encontrados: ${deposits.length}`);

    for (const dep of deposits) {
      try {
        // Verificar duplicados
        const [exists] = await panelConn.execute(
          `SELECT id FROM deposits_sync WHERE casino_id = ? AND casino_deposit_id = ?`,
          [casino.id, dep.casino_deposit_id]
        );
        if (exists.length > 0) {
          logInfo(`[${casino.name}] [syncDeposits] Depósito já existe: ${dep.casino_deposit_id}`);
          continue;
        }

        // Localizar player
        const [playerRows] = await panelConn.execute(
          `SELECT id, affiliate_id, total_deposits 
           FROM players_sync WHERE casino_id = ? AND casino_user_id = ?`,
          [casino.id, dep.casino_user_id]
        );
        if (playerRows.length === 0) {
          logError(`[${casino.name}] [syncDeposits] Player não encontrado para depósito ${dep.casino_deposit_id}`);
          continue;
        }
        const player = playerRows[0];
        const isFirst = player.total_deposits === 0 ? 1 : 0;

        const depositId = uuidv4();
        await panelConn.execute(
          `INSERT INTO deposits_sync
            (id, player_id, affiliate_id, amount, currency, is_first, deposited_at, casino_id, casino_deposit_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            depositId,
            player.id,
            player.affiliate_id,
            dep.amount,
            dep.currency || "BRL",
            isFirst,
            dep.created_at,
            casino.id,
            dep.casino_deposit_id,
          ]
        );
        logInfo(`[${casino.name}] [syncDeposits] Novo depósito inserido: ${dep.casino_deposit_id} (${dep.amount})`);
      } catch (innerErr) {
        logError(`[${casino.name}] [syncDeposits] Erro processando depósito ${dep.casino_deposit_id}`, innerErr);
      }
    }
  } catch (err) {
    logError(`[${casino.name}] [syncDeposits] Erro geral`, err);
  } finally {
    if (casinoConn) await casinoConn.end().catch(() => {});
  }
}