import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { isWompiPaymentSourceAvailable, type WompiTransactionResult } from "@/lib/wompi-server";
import { WOMPI_ENV } from "@/lib/wompi";

type Client = NonNullable<ReturnType<typeof getServiceSupabaseClient>>;

export async function billingRetrySchemaReady(client: Client) {
  const { data, error } = await client.rpc("billing_retry_schema_ready");
  return !error && data === true;
}

// Only server GET results enter this envelope. Webhook/browser claims are not evidence.
export function verifiedBillingTransaction(transaction: WompiTransactionResult) {
  return {
    id: transaction.id,
    status: transaction.status.toLowerCase(),
    reference: transaction.reference,
    amount_in_cents: transaction.amountInCents,
    currency: transaction.currency,
    payment_source_id: transaction.paymentSourceId ?? null,
    payment_method_type: transaction.paymentMethodType ?? null,
    finalized_at: transaction.finalizedAt ?? null,
    status_message: transaction.statusMessage ?? null,
    environment: WOMPI_ENV,
    verification_source: "provider_get",
  };
}

export async function applyBillingResult(client: Client, attemptId: string, transaction: WompiTransactionResult) {
  const { data, error } = await client.rpc("billing_v2_apply_result", {
    p_attempt_id: attemptId, p_transaction: { ...verifiedBillingTransaction(transaction),
      payment_source_verification: await retrySourceProof(transaction) },
  });
  if (error || !["processed", "duplicate", "review"].includes(data?.result)) {
    throw new Error("BILLING_RESULT_NOT_APPLIED");
  }
  return data;
}

export async function retrySourceProof(transaction: WompiTransactionResult) {
  if (transaction.status !== "declined" || transaction.paymentMethodType !== "CARD" || !transaction.paymentSourceId
    || transaction.statusMessage?.normalize("NFKC").trim() !== "Intente mas tarde - Fondos Insuficientes") return null;
  try {
    if (!(await isWompiPaymentSourceAvailable(transaction.paymentSourceId))) return null;
    return { id: transaction.paymentSourceId, type: "CARD", status: "AVAILABLE", environment: WOMPI_ENV,
      verification_source: "provider_get", verified_at: new Date().toISOString() };
  } catch { return null; }
}

export function canStartAuthorizedSend(claim: { canDispatch?: boolean; sendAuthorizedAt?: string; windowEnd?: string | null }, now = Date.now()) {
  const authorizedAt = Date.parse(claim.sendAuthorizedAt ?? "");
  const end = claim.windowEnd == null ? Infinity : Date.parse(claim.windowEnd);
  return claim.canDispatch === true && Number.isFinite(authorizedAt)
    && now >= authorizedAt && now - authorizedAt < 15_000 && now < end;
}
