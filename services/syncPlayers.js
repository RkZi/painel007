import { v4 as uuidv4 } from "uuid";
import { logInfo, logError } from "../utils/logger.js";
import mysql from "mysql2/promise";

/**
 * Sincroniza jogadores do cassino para players_sync
 */
export async function syncPlayers(casino, panelConn) {
  logInfo(`[${casino.name}] [syncPlayers] Iniciando sincronização de jogadores...`);

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
    logInfo(`[${casino.name}] [syncPlayers] Conectado ao DB do cassino.`);

    // Buscar todos os usuários do cassino
    const [users] = await casinoConn.execute(`
      SELECT id, name, email, inviter, inviter_code
      FROM users
      WHERE role_id = 3 AND (is_demo_agent = 0 OR is_demo_agent IS NULL)
    `);
    logInfo(`[${casino.name}] [syncPlayers] Total de usuários encontrados: ${users.length}`);

    for (const user of users) {
      try {
        let influencerId = null;

        // Resolver influencer pelo inviter -> inviter_code
        if (user.inviter) {
          const [inviterRows] = await casinoConn.execute(
            "SELECT inviter_code FROM users WHERE id = ?",
            [user.inviter]
          );
          if (inviterRows.length > 0) {
            const inviterCode = inviterRows[0].inviter_code;
            const [influencerRows] = await panelConn.execute(
              "SELECT id FROM influencers WHERE code = ? AND casino_id = ?",
              [inviterCode, casino.id]
            );
            if (influencerRows.length > 0) {
              influencerId = influencerRows[0].id;
              logInfo(`[${casino.name}] [syncPlayers] Influencer resolvido para user ${user.id}: ${influencerId}`);
            }
          }
        }

        // Verificar se já existe player no painel
        const [existing] = await panelConn.execute(
          `SELECT id FROM players_sync WHERE casino_id = ? AND casino_user_id = ?`,
          [casino.id, user.id]
        );

        if (existing.length === 0) {
          const playerId = uuidv4();
          await panelConn.execute(
            `INSERT INTO players_sync 
              (id, name, email, inviter_code, influencer_id, casino_id, casino_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              playerId,
              user.name,
              user.email,
              user.inviter_code,
              influencerId,
              casino.id,
              user.id,
            ]
          );
          logInfo(`[${casino.name}] [syncPlayers] Novo player inserido: ${user.name} (${user.id})`);
        } else {
          logInfo(`[${casino.name}] [syncPlayers] Player já existe no painel: ${user.id}`);
        }
      } catch (innerErr) {
        logError(`[${casino.name}] [syncPlayers] Erro processando user ${user.id}`, innerErr);
      }
    }
  } catch (err) {
    logError(`[${casino.name}] [syncPlayers] Erro geral`, err);
  } finally {
    if (casinoConn) await casinoConn.end().catch(() => {});
  }
}