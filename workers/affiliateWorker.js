import express from "express";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import { logInfo, logError } from "../utils/logger.js";

dotenv.config();
const router = express.Router();

/**
 * Conexão com o banco do cassino
 */
async function connectCasinoDB(casino) {
  return await mysql.createConnection({
    host: casino.db_host,
    port: casino.db_port || 3306,
    user: casino.db_user,
    password: casino.db_password,
    database: casino.db_name,
    connectTimeout: 60000,
  });
}

/**
 * Conexão com o banco global
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
 * Rota do Worker: Criação de afiliação em novo cassino
 */
router.post("/worker/affiliate-request", async (req, res) => {
  const { influencer_id, casino } = req.body;

  if (!influencer_id || !casino) {
    return res.status(400).json({
      status: "error",
      message: "Payload inválido. É necessário enviar influencer_id e casino",
    });
  }

  let panelConn, casinoConn;
  try {
    logInfo(`[AFFILIATE] Iniciando processo de afiliação para influencer ${influencer_id} no cassino ${casino.name}`);

    panelConn = await connectPanelDB();

    // 1. Buscar dados do influencer no painel
    const [infRows] = await panelConn.execute(
      "SELECT id, name, email, phone, document, code FROM influencers WHERE id = ?",
      [influencer_id]
    );

    if (!infRows.length) {
      logError("[AFFILIATE] Influencer não encontrado", influencer_id);
      return res.status(404).json({ status: "error", message: "Influencer não encontrado" });
    }

    const influencer = infRows[0];
    logInfo("[AFFILIATE] Influencer encontrado", influencer.email);

    // 2. Conectar ao banco do cassino alvo
    casinoConn = await connectCasinoDB(casino);

    // 2.1 Buscar currency/symbol do cassino (igual ao Helper::getSetting do Laravel)
    const [settings] = await casinoConn.execute("SELECT currency_code, prefix FROM settings LIMIT 1");
    const currency = settings[0].currency_code || "BRL";
    const symbol = settings[0].prefix || "R$";

    // 3. Criar usuário no cassino
    const hashedPassword = await bcrypt.hash("changeme123", 10);
    const [userResult] = await casinoConn.execute(
      `INSERT INTO users 
        (name, email, password, inviter_code, role_id, logged_in, banned, language, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        influencer.name,
        influencer.email,
        hashedPassword,
        influencer.code, // já cria com o código de afiliação existente
        2, // role padrão (2 = afiliado/jogador, depende do sistema)
        0, // logged_in
        0, // banned
        "pt_BR", // idioma padrão
      ]
    );

    const newUserId = userResult.insertId;
    logInfo(`[AFFILIATE] Novo usuário criado no cassino ID: ${newUserId}`);

    // 4. Criar carteira vinculada ao novo usuário
    await casinoConn.execute(
      `INSERT INTO wallets (user_id, currency, symbol, active, created_at, updated_at) 
       VALUES (?, ?, ?, 1, NOW(), NOW())`,
      [newUserId, currency, symbol]
    );

    logInfo("[AFFILIATE] Carteira criada para usuário", newUserId);

    // 5. Responder sucesso
    return res.json({
      status: "success",
      message: "Afiliado criado com sucesso no cassino",
      user_id: newUserId,
      casino: casino.name,
    });
  } catch (err) {
    logError("[AFFILIATE] Erro no processo de afiliação", err);
    return res.status(500).json({
      status: "error",
      message: "Erro interno no processo de afiliação",
    });
  } finally {
    if (panelConn) await panelConn.end();
    if (casinoConn) await casinoConn.end();
  }
});

export default router;