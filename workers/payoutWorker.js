import express from "express";
import mysql from "mysql2/promise";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { logInfo, logError } from "../utils/logger.js";

dotenv.config();

const router = express.Router();

/**
 * Conecta ao banco do painel (global)
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
 * Worker de pedido de saque
 */
router.post("/worker/payout-request", async (req, res) => {
  const payload = req.body;

  try {
    logInfo("[PAYOUT] Recebido payload", payload);

    const { influencer, withdrawal } = payload;

    // 1) Conectar no banco global
    const conn = await connectPanelDB();

    // 2) Calcular saldo disponível do influencer (somente comissões com status 'available')
    const [rows] = await conn.execute(
      `SELECT COALESCE(SUM(commission_amount), 0) AS available_balance
       FROM commissions
       WHERE influencer_id = ? AND status = 'available'`,
      [influencer.id]
    );

    const availableBalance = rows[0].available_balance;
    logInfo(`[PAYOUT] Saldo disponível para ${influencer.id}: ${availableBalance}`);

    // 3) Validar saldo
    if (withdrawal.amount > availableBalance) {
      logError("[PAYOUT] Saldo insuficiente para influencer", influencer.id);
      await conn.end();
      return res.status(400).json({
        status: "error",
        message: "Saldo Insuficiente",
      });
    }

    // 4) Inserir em payouts
    const payoutId = uuidv4();
    const now = new Date();

    await conn.execute(
      `INSERT INTO payouts 
       (id, influencer_id, total_amount, method, pix_key, pix_type, cpf_receiver, rejection_reason, processed_at, processed_by, notes, reference, status, created_at, completed_at, casino_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payoutId,
        influencer.id,
        withdrawal.amount,
        "PIX",
        withdrawal.pix_key,
        withdrawal.pix_type,
        withdrawal.cpf_receiver || null,
        null, // rejection_reason
        null, // processed_at
        null, // processed_by
        null, // notes
        null, // reference
        "pending", // status inicial
        now,
        null, // completed_at
        null, // casino_id (opcional)
      ]
    );

    await conn.end();

    logInfo("[PAYOUT] Pedido de saque inserido com sucesso", payoutId);

    // 5) Retornar sucesso
    return res.json({
      status: "success",
      message: "Pedido Realizado com Sucesso!",
      payout_id: payoutId,
    });
  } catch (err) {
    logError("[PAYOUT] Erro ao processar pedido de saque", err);
    return res.status(500).json({
      status: "error",
      message: "Erro interno no processamento do saque",
    });
  }
});

export default router;