import dotenv from "dotenv";
dotenv.config();

import express from "express";
import mysql from "mysql2/promise";
import { syncPlayers } from "./services/syncPlayers.js";
import { syncDeposits } from "./services/syncDeposits.js";
import { syncCommissions } from "./services/syncComns.js";
import { getActiveCasinos } from "./services/casinos.js";
import { logInfo, logError } from "./utils/logger.js";

const app = express();
app.use(express.json());

/**
 * Conecta ao banco do painel (global.sql)
 */
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

/**
 * Orquestra a sincronização
 */
async function runSync() {
  const panelConn = await connectPanelDB();
  try {
    const casinos = await getActiveCasinos(panelConn);

    for (const casino of casinos) {
      logInfo(`[${casino.name}] Iniciando sync...`);
      let retries = 3;

      while (retries > 0) {
        let casinoConn;
        try {
          // conectar no banco do cassino
          casinoConn = await mysql.createConnection({
            host: casino.db_host,
            port: casino.db_port || 3306,
            user: casino.db_user,
            password: casino.db_password,
            database: casino.db_name,
            connectTimeout: 60000,
          });

          // buscar depósitos recentes + usuários
          const [deposits] = await casinoConn.execute(`
            SELECT d.id AS casino_deposit_id,
                   d.user_id AS casino_user_id,
                   d.amount,
                   d.currency,
                   d.created_at,
                   u.name AS username,
                   u.email,
                   u.inviter,
                   u.inviter_code
            FROM deposits d
            JOIN users u ON d.user_id = u.id
            WHERE d.created_at > NOW() - INTERVAL 30 SECOND
          `);

          // rodar sync
          await syncPlayers(casino, deposits, panelConn);
          await syncDeposits(casino, deposits, panelConn);
          await syncCommissions(casino, panelConn);

          logInfo(`[${casino.name}] Sync concluída com sucesso.`);
          await casinoConn.end();
          break;
        } catch (err) {
          logError(`[${casino.name}] Erro na sync`, err);
          retries--;
          if (retries === 0) throw err;
          await new Promise(r => setTimeout(r, 5000));
        } finally {
          if (casinoConn) await casinoConn.end().catch(() => {});
        }
      }
    }
  } catch (err) {
    logError("Falha no runSync", err);
  } finally {
    await panelConn.end();
  }
}

// rotas
app.get("/api/sync", async (req, res) => {
  await runSync();
  res.json({ success: true });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// job agendado
setInterval(runSync, 10000);

app.listen(process.env.PORT || 3000, () => {
  logInfo(`Backend sync rodando na porta ${process.env.PORT || 3000}`);
});