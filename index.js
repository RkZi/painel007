import dotenv from "dotenv";
dotenv.config();

import express from "express";
import mysql from "mysql2/promise";
import { syncPlayers } from "./services/syncPlayers.js";
import { syncDeposits } from "./services/syncDeposits.js";
import { syncComns } from "./services/syncComns.js";
import { getActiveCasinos } from "./services/casinos.js";
import { logInfo, logError } from "./utils/logger.js";
import payoutWorker from "./workers/payoutWorker.js";
import paymentWorker from "./workers/paymentWorker.js";
import affiliateWorker from "./workers/affiliateWorker.js";
import auditWorker from "./workers/auditWorker.js";
import "./workers/walletWorker.js";

const app = express();
app.use(express.json());

//Registrar o worker
app.use(payoutWorker);
app.use(paymentWorker);
app.use(affiliateWorker);
app.use(auditWorker);

// Conexão com painel
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

// Orquestrador
async function runSync() {
  logInfo("[GLOBAL] Iniciando ciclo de sincronização...");
  const panelConn = await connectPanelDB();

  try {
    const casinos = await getActiveCasinos(panelConn);
    logInfo(`[GLOBAL] Cassinos ativos: ${casinos.length}`);

    for (const casino of casinos) {
      logInfo(`[${casino.name}] 🚀 Iniciando sync...`);
      try {
        await syncPlayers(casino, panelConn);
        await syncDeposits(casino, panelConn);
        await syncComns(casino, panelConn);
        logInfo(`[${casino.name}] ✅ Sync concluída`);
      } catch (err) {
        logError(`[${casino.name}] ❌ Erro durante sync`, err);
      }
    }
  } catch (err) {
    logError("[GLOBAL] ❌ Erro no runSync", err);
  } finally {
    await panelConn.end();
    logInfo("[GLOBAL] Conexão com painel encerrada");
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

// agendamento: a cada 30s
setInterval(runSync, 30000);

app.listen(process.env.PORT || 3000, () => {
  logInfo(`Backend sync rodando na porta ${process.env.PORT || 3000}`);
});