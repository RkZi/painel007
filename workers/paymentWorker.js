// workers/paymentWorker.js
import express from "express";
import mysql from "mysql2/promise";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { logInfo, logError } from "../utils/logger.js";

dotenv.config();
const router = express.Router();

/** Conexão com o painel (global) */
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
 * Worker de pagamento (acionado quando o admin aprova um payout)
 * Espera body: { payout: { id, affiliate_id, total_amount, pix_key, pix_type, cpf_receiver, ... } }
 */
router.post("/worker/payment-process", async (req, res) => {
  const { payout } = req.body;

  if (!payout?.affiliate_id) {
    return res.status(400).json({
      status: "error",
      message: "Payload inválido: payout/affiliate_id ausente",
    });
  }

  const {
    id: payoutId,
    affiliate_id,
    total_amount,
    pix_key,
    pix_type,
    cpf_receiver,
  } = payout;

  let conn;
  try {
    logInfo("[PAYMENT] ▶️ Iniciando processamento do payout", { payoutId, affiliate_id });

    conn = await connectPanelDB();

    // 1) Buscar dados do affiliate
    logInfo("[PAYMENT] 🔎 Buscando affiliate no banco", { affiliate_id });
    const [infRows] = await conn.execute(
      `SELECT id, name, email, phone, document, hotpayments_customer_id
         FROM affiliates
        WHERE id = ?`,
      [affiliate_id]
    );
    if (!infRows.length) {
      logError("[PAYMENT] ❌ Affiliate não encontrado", { affiliate_id });
      return res.status(404).json({ status: "error", message: "Affiliate não encontrado" });
    }
    const affiliate = infRows[0];

    // 2) Garantir customer na HotPayments
    let customerUuid = affiliate.hotpayments_customer_id;
    if (!customerUuid) {
      logInfo("[PAYMENT] 🧾 Criando customer na HotPayments", {
        affiliate_id,
        email: affiliate.email,
        cpf_receiver,
      });

      const createRes = await fetch(`${process.env.HOTPAYMENTS_API_URL}/v1/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.HOTPAYMENTS_API_KEY}`,
        },
        body: JSON.stringify({
          name: affiliate.name,
          email: affiliate.email,
          phone_number: affiliate.phone,  // precisa ser só números conforme doc
          document: cpf_receiver,          // CPF do recebedor vindo do payout
        }),
      });

      const createData = await createRes.json();
      logInfo("[PAYMENT] 🔁 Resposta HotPayments (create customer)", createData);

      if (!createRes.ok || !createData?.success || !createData?.data?.id) {
        logError("[PAYMENT] ❌ Falha ao criar customer na HotPayments", {
          status: createRes.status,
          createData,
        });
        return res.status(502).json({
          status: "error",
          message: "Falha ao criar customer na HotPayments",
          details: createData,
        });
      }

      // Agora o POST já retorna o UUID (id)
      customerUuid = createData.data.id;

      // Persistir no banco
      await conn.execute(
        `UPDATE affiliates
            SET hotpayments_customer_id = ?
          WHERE id = ?`,
        [customerUuid, affiliate_id]
      );
      logInfo("[PAYMENT] 💾 Customer UUID salvo para affiliate", {
        affiliate_id,
        customerUuid,
      });
    } else {
      logInfo("[PAYMENT] ✅ Affiliate já possui customer HotPayments", { customerUuid });
    }

    // 3) Marcar payout como em processamento (processing)
    logInfo("[PAYMENT] 📝 Atualizando payout para 'processing'", { payoutId });
    await conn.execute(
      `UPDATE payouts
          SET status = 'processing',
              processed_at = NOW(),
              processed_by = 'admin'
        WHERE id = ?`,
      [payoutId]
    );

    // 4) Cashout
    logInfo("[PAYMENT] 💸 Emitindo cashout na HotPayments", {
      payoutId,
      amount: total_amount,
      pix_key,
      customer_id: customerUuid,
    });

    const cashoutRes = await fetch(`${process.env.HOTPAYMENTS_API_URL}/v1/pix/cashout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.HOTPAYMENTS_API_KEY}`,
      },
      body: JSON.stringify({
        amount: Number(total_amount),
        pix_key: pix_key,
        customer_id: customerUuid,
        description: `Payout ${payoutId} para affiliate ${affiliate_id}`,
      }),
    });

    const cashoutData = await cashoutRes.json();
    logInfo("[PAYMENT] 🔁 Resposta HotPayments (cashout)", cashoutData);

    if (!cashoutRes.ok || !cashoutData?.success || !cashoutData?.data?.transaction_id) {
      // marcar como failed
      const rejection = JSON.stringify(cashoutData);
      logError("[PAYMENT] ❌ Cashout falhou", { payoutId, cashoutData });

      await conn.execute(
        `UPDATE payouts
            SET status = 'failed',
                rejection_reason = ?,
                notes = ?
          WHERE id = ?`,
        ["HotPayments cashout failure", rejection, payoutId]
      );

      return res.status(502).json({
        status: "error",
        message: "Falha ao efetuar cashout na HotPayments",
        details: cashoutData,
      });
    }

    // 5) Sucesso — finalizar payout
    const txId = cashoutData.data.transaction_id;
    logInfo("[PAYMENT] ✅ Cashout criado com sucesso", { payoutId, txId });

    await conn.execute(
      `UPDATE payouts
          SET status = 'completed',
              reference = ?,
              notes = ?,
              completed_at = NOW()
        WHERE id = ?`,
      [txId, JSON.stringify(cashoutData), payoutId]
    );

    logInfo("[PAYMENT] 🎉 Payout finalizado como 'completed'", { payoutId });

    return res.json({
      status: "success",
      message: "Pagamento processado com sucesso",
      transaction_id: txId,
    });
  } catch (err) {
    logError("[PAYMENT] 💥 Erro inesperado no processamento do payout", err);
    return res.status(500).json({
      status: "error",
      message: "Erro interno no processamento do pagamento",
    });
  } finally {
    // fecha a conexão
    try {
      if (conn) {
        await conn.end();
        logInfo("[PAYMENT] 🔚 Conexão com painel encerrada");
      }
    } catch (e) {
      logError("[PAYMENT] Erro ao encerrar conexão", e);
    }
  }
});

export default router;