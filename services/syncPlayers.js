import { v4 as uuidv4 } from "uuid";
import { logInfo, logError } from "../utils/logger.js";
import mysql from "mysql2/promise";

/**
 * Sincroniza jogadores do cassino para players_sync
 * - Resolve corretamente quem é o influencer via inviter -> inviter_code
 */
export async function syncPlayers(casino, deposits, panelConn) {
  try {
    // abre conexão direta com o banco do cassino
    const casinoConn = await mysql.createConnection({
      host: casino.db_host,
      port: casino.db_port || 3306,
      user: casino.db_user,
      password: casino.db_password,
      database: casino.db_name,
      connectTimeout: 60000,
    });

    for (const dep of deposits) {
      let influencerId = null;

      // 1) Buscar o usuário que fez o depósito
      const [userRows] = await casinoConn.execute(
        "SELECT id, name, email, inviter, inviter_code FROM users WHERE id = ?",
        [dep.casino_user_id]
      );
      if (userRows.length === 0) continue;
      const user = userRows[0];

      // 2) Se tiver um inviter, pegar o inviter_code do convidador
      if (user.inviter) {
        const [inviterRows] = await casinoConn.execute(
          "SELECT inviter_code FROM users WHERE id = ?",
          [user.inviter]
        );
        if (inviterRows.length > 0) {
          const inviterCode = inviterRows[0].inviter_code;

          // 3) No painel, procurar influencer com esse code
          const [influencerRows] = await panelConn.execute(
            "SELECT id FROM influencers WHERE code = ? AND casino_id = ?",
            [inviterCode, casino.id]
          );
          if (influencerRows.length > 0) {
            influencerId = influencerRows[0].id;
          }
        }
      }

      // 4) Verificar se já existe o player no painel
      const [existing] = await panelConn.execute(
        `SELECT id, total_deposits, total_amount 
         FROM players_sync 
         WHERE casino_id = ? AND casino_user_id = ?`,
        [casino.id, user.id]
      );

      if (existing.length === 0) {
        // inserir novo player
        const playerId = uuidv4();
        await panelConn.execute(
          `INSERT INTO players_sync 
           (id, name, email, inviter_code, influencer_id, total_deposits, total_amount, first_deposit_at, casino_id, casino_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            playerId,
            user.name,
            user.email,
            user.inviter_code,
            influencerId,
            1,
            dep.amount,
            dep.created_at,
            casino.id,
            user.id,
          ]
        );
        logInfo(`[${casino.name}] Novo player sincronizado: ${user.name}`);
      } else {
        // atualizar player existente
        const player = existing[0];
        await panelConn.execute(
          `UPDATE players_sync 
           SET total_deposits = total_deposits + 1,
               total_amount = total_amount + ?,
               updated_at = NOW()
           WHERE id = ?`,
          [dep.amount, player.id]
        );
      }
    }

    await casinoConn.end();
  } catch (err) {
    logError(`[${casino.name}] Erro no syncPlayers`, err);
  }
}