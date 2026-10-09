import crypto from "node:crypto";
import { getNextMonthlyPaymentDate } from "./monthly-charge-runner.mjs";

function effectiveDate(transaction, receipt) {
  if (transaction.finalizedAt && !Number.isNaN(Date.parse(transaction.finalizedAt))) return new Date(transaction.finalizedAt);
  if (String(receipt.transaction?.status).toLowerCase() !== transaction.status) return null;
  const timestamp = Number(receipt.event_timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function reconcileWompiReceipts({ supabase, getTransaction, getPaymentSource, logger = console }) {
  const stats = { received: 0, processed: 0, review: 0, failed: 0, scopedReview: 0 };
  const receipts = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await supabase.from("webhook_events")
      .select("id,raw,processing_state")
      .in("processing_state", ["received", "needs_review"])
      .order("created_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + 99);
    if (error) throw new Error("RECEIPT_QUERY_FAILED");
    const page = data ?? [];
    receipts.push(...page.filter((row) => row.raw?.receipt_version === 1));
    if (page.length < 100) break;
  }
  stats.received = receipts.length;
  for (const row of receipts) {
    try {
      const raw = row.raw;
      if (!raw.transaction?.id) { stats.review += 1; continue; }
      const tx = await getTransaction({ transactionId: raw.transaction.id });
      if (tx.id !== raw.transaction.id || !tx.reference || !Number.isInteger(tx.amountInCents)
        || tx.amountInCents < 150000 || tx.amountInCents % 100 || tx.currency !== "COP"
        || !["approved", "pending", "declined", "error", "voided"].includes(tx.status)) {
        throw new Error("RECEIPT_TRANSACTION_INVALID");
      }
      if (raw.transaction.reference !== tx.reference || raw.transaction.amount_in_cents !== tx.amountInCents
        || raw.transaction.currency !== tx.currency) throw new Error("RECEIPT_TRANSACTION_MISMATCH");
      const effectiveAt = effectiveDate(tx, raw);
      let sourceProof = null;
      if (tx.status === "declined" && tx.paymentMethodType === "CARD" && tx.paymentSourceId
        && tx.statusMessage?.normalize("NFKC").trim() === "Intente mas tarde - Fondos Insuficientes"
        && typeof getPaymentSource === "function") {
        try {
          const source = await getPaymentSource({ paymentSourceId: tx.paymentSourceId });
          sourceProof = { id: source.id, type: source.type, status: source.status, environment: source.environment,
            verification_source: source.verificationSource, verified_at: source.verifiedAt };
        } catch { sourceProof = null; }
      }
      const eventKey = crypto.createHash("sha256").update(`receipt-reconciliation|${tx.id}|${tx.status}|${effectiveAt?.toISOString() ?? "unknown"}`).digest("hex");
      const { data, error } = await supabase.rpc("apply_verified_wompi_event", {
        p_event_key: eventKey, p_transaction_id: tx.id, p_event_type: "transaction.reconciled",
        p_reference: tx.reference, p_payment_source_id: tx.paymentSourceId ?? null,
        p_amount: tx.amountInCents / 100, p_currency: tx.currency, p_status: tx.status,
        p_effective_at: effectiveAt?.toISOString() ?? null,
        p_candidate_next_payment: effectiveAt ? getNextMonthlyPaymentDate(effectiveAt, null).toISOString() : null,
        p_raw: { receipt_id: row.id, source: "durable_receipt",
          verification_source: tx.verificationSource ?? null, environment: tx.environment ?? null,
          payment_source_verification: sourceProof,
          transaction: {
          id: tx.id, reference: tx.reference, amount_in_cents: tx.amountInCents, currency: tx.currency,
          status: tx.status, finalized_at: tx.finalizedAt ?? null,
          payment_source_id: tx.paymentSourceId ?? null, payment_method_type: tx.paymentMethodType ?? null,
          status_message: tx.statusMessage ?? null,
        } },
      });
      if (error || !["processed", "duplicate", "review"].includes(data?.result)) throw new Error("RECEIPT_APPLICATION_FAILED");
      if (data.result === "review") {
        stats.review += 1;
        if (data.historicalOnly === true && data.scheduleProtected === true
          && data.reason === "LEGACY_RESULT_SCHEDULE_PROTECTED" && typeof data.subscriptionId === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.subscriptionId)
          && data.transactionId === tx.id) stats.scopedReview += 1;
      }
      else stats.processed += 1;
    } catch {
      stats.failed += 1;
      logger.error("Wompi receipt reconciliation failed code=RECEIPT_RECONCILIATION_FAILED");
    }
  }
  return stats;
}
