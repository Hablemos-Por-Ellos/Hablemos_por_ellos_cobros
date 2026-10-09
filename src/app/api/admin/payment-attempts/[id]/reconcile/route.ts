import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext, isAdminDemoMode, isAdminSchemaReady, isSameOriginRequest, verifyRecentTotp } from "@/lib/admin-auth";
import { getNextMonthlyPaymentDate } from "@/lib/payment-dates";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { getWompiTransaction } from "@/lib/wompi-server";
import { assertFinancialOperationsEnabled } from "@/lib/operation-mode";
import { confirmedRecoverySchema } from "@/types/admin";
import { billingRetrySchemaReady, retrySourceProof, verifiedBillingTransaction } from "@/lib/billing-v2";

const recoveryCommon = {
  reason: z.string().trim().min(5).max(500),
  totpCode: z.string().regex(/^\d{6}$/),
  requestId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
};
const recoverySchema = z.object({
    action: z.literal("reconcile"),
    transactionId: z.string().trim().min(3).max(200).regex(/^[A-Za-z0-9_-]+$/),
    ...recoveryCommon,
  }).strict();

const recoveryResultSchema = confirmedRecoverySchema.shape.recovery.required({ needsReview: true });
const recoveryReplaySchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("new") }),
  z.object({ result: z.literal("replay"), response: recoveryResultSchema }),
]);
const expectedMoneySchema = z.object({
  amount: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(1500).max(21474836)),
  currency: z.literal("COP"),
});

const VERIFIED_STATUSES = new Set(["approved", "pending", "declined", "error", "voided"]);

function recoveryRpcError(message: string, unavailable = false) {
  if (message.includes("ADMIN_NOT_AUTHORIZED")) {
    return NextResponse.json({ message: "La sesion administrativa no esta autorizada." }, { status: 403 });
  }
  const conflict = ["RECOVERY_NOT_ALLOWED", "RECOVERY_MISMATCH", "VERSION_CONFLICT", "ADMIN_REQUEST_ID_CONFLICT",
    "PAYMENT_RECOVERY_INVALID_INPUT", "RECOVERY_EVIDENCE_MISMATCH", "WOMPI_RESULT_IDENTITY_MISMATCH"]
    .some((code) => message.includes(code));
  return NextResponse.json(
    { message: conflict ? "El intento cambio o no coincide; recarga antes de continuar." : "No se pudo aplicar la conciliacion." },
    { status: conflict ? 409 : unavailable || message.includes("SCHEMA_REQUIRED") ? 503 : 500 }
  );
}

function confirmedRecoveryResponse(value: unknown, attemptId: string, transactionId: string) {
  const result = recoveryResultSchema.safeParse(value);
  if (!result.success || result.data.attemptId !== attemptId || result.data.transactionId !== transactionId) {
    return NextResponse.json({ message: "La base de datos devolvio una conciliacion invalida." }, { status: 500 });
  }
  return NextResponse.json({ recovery: result.data, needsReview: result.data.needsReview });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origen no permitido." }, { status: 403 });
  }
  if (isAdminDemoMode()) return NextResponse.json({ message: "Demo desconectada." }, { status: 401 });
  try { assertFinancialOperationsEnabled(); } catch {
    return NextResponse.json({ message: "Operaciones financieras deshabilitadas." }, { status: 503 });
  }
  if (!(await isAdminSchemaReady())) return NextResponse.json({ message: "Esquema administrativo no disponible." }, { status: 503 });

  const admin = await getAdminContext();
  if (!admin || admin.demo || isAdminDemoMode()) {
    return NextResponse.json({ message: "Esta operacion requiere una sesion administrativa real." }, { status: 401 });
  }

  const parsed = recoverySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ message: "Datos de conciliacion invalidos." }, { status: 400 });
  }
  const input = parsed.data;
  const { id: attemptId } = await params;
  if (!z.string().uuid().safeParse(attemptId).success) {
    return NextResponse.json({ message: "Intento de pago invalido." }, { status: 400 });
  }

  const serviceClient = getServiceSupabaseClient();
  if (!serviceClient) return NextResponse.json({ message: "Servicio de datos no configurado." }, { status: 503 });
  if (!(await billingRetrySchemaReady(serviceClient))) return NextResponse.json({ message: "Esquema de cobros en preparacion." }, { status: 503 });

  const { data: rateAllowed, error: rateError } = await serviceClient.rpc("consume_api_rate_limit", {
    p_scope: "admin_payment_recovery",
    p_key_hash: crypto.createHash("sha256").update(admin.userId).digest("hex"),
    p_limit: 6,
    p_window_seconds: 600,
  });
  if (rateError) return NextResponse.json({ message: "No fue posible validar el limite de seguridad." }, { status: 503 });
  if (rateAllowed !== true) return NextResponse.json({ message: "Demasiados intentos. Espera unos minutos." }, { status: 429 });
  if (!(await verifyRecentTotp(input.totpCode))) {
    return NextResponse.json({ message: "El codigo de Google Authenticator no es valido." }, { status: 403 });
  }
  const totpVerifiedAt = new Date().toISOString();

  const replayAdmin = await getAdminContext();
  if (!replayAdmin || replayAdmin.demo || replayAdmin.userId !== admin.userId) {
    return NextResponse.json({ message: "La sesion administrativa cambio o fue revocada." }, { status: 403 });
  }
  try { assertFinancialOperationsEnabled(); } catch {
    return NextResponse.json({ message: "Operaciones financieras deshabilitadas." }, { status: 503 });
  }
  // Durable replay depends only on authenticated user input, never current provider/state evidence.
  try {
    const { data, error } = await serviceClient.rpc("billing_v2_admin_recovery_replay", {
      p_attempt_id: attemptId,
      p_actor_user_id: admin.userId,
      p_reason: input.reason,
      p_request_id: input.requestId,
      p_transaction_id: input.transactionId,
      p_expected_version: input.expectedVersion,
      p_actor_aal: replayAdmin.aal,
      p_actor_session_issued_at: replayAdmin.sessionIssuedAt,
      p_totp_verified_at: totpVerifiedAt,
    });
    if (error) return recoveryRpcError(error.message, true);
    const replay = recoveryReplaySchema.safeParse(data);
    if (!replay.success) return NextResponse.json({ message: "La base de datos devolvio un replay invalido." }, { status: 500 });
    if (replay.data.result === "replay") {
      return confirmedRecoveryResponse(replay.data.response, attemptId, input.transactionId);
    }
  } catch {
    return NextResponse.json({ message: "No fue posible verificar el replay administrativo." }, { status: 503 });
  }

  const { data: attempt, error: attemptError } = await serviceClient
    .from("payment_attempts")
    .select("id, subscription_id, reference, amount, currency, state, wompi_transaction_id, attempt_number, dispatch_snapshot")
    .eq("id", attemptId)
    .maybeSingle();
  if (attemptError) return NextResponse.json({ message: "No fue posible consultar el intento." }, { status: 503 });
  if (!attempt) return NextResponse.json({ message: "El intento de pago no existe." }, { status: 404 });
  if (attempt.id !== attemptId) return NextResponse.json({ message: "El intento consultado no coincide." }, { status: 409 });
  const requestedTransactionId = input.transactionId;
  if (
    !["unknown", "dispatching"].includes(String(attempt.state))
    && attempt.wompi_transaction_id !== requestedTransactionId
  ) {
    return NextResponse.json({ message: "Este intento ya no admite conciliacion manual." }, { status: 409 });
  }
  if (attempt.wompi_transaction_id && attempt.wompi_transaction_id !== input.transactionId) {
    return NextResponse.json({ message: "El intento ya tiene otro identificador de Wompi." }, { status: 409 });
  }

  const { data: subscription, error: subscriptionError } = await serviceClient
    .from("subscriptions")
    .select("id, frequency, wompi_payment_source_id, preferred_payment_day")
    .eq("id", attempt.subscription_id)
    .maybeSingle();
  if (subscriptionError || !subscription) {
    return NextResponse.json({ message: "No fue posible consultar la suscripcion del intento." }, { status: 503 });
  }
  if (subscription.id !== attempt.subscription_id) {
    return NextResponse.json({ message: "La suscripcion consultada no coincide con el intento." }, { status: 409 });
  }

  // Check both links so a conflicting historical row cannot disappear behind an AND filter.
  const { data: historicalPayments, error: historicalError } = await serviceClient
    .from("payments")
    .select("id, payment_attempt_id, subscription_id, wompi_transaction_id, reference, amount, currency")
    .or(`wompi_transaction_id.eq.${input.transactionId},payment_attempt_id.eq.${attemptId}`)
    .limit(2);
  if (historicalError || !Array.isArray(historicalPayments)) {
    return NextResponse.json({ message: "No fue posible verificar el pago historico." }, { status: 503 });
  }
  const historicalPayment = historicalPayments[0];
  if (historicalPayments.length > 1 || (historicalPayments.length === 1 && (
    !historicalPayment || !z.string().uuid().safeParse(historicalPayment.id).success
    || historicalPayment.payment_attempt_id !== attemptId
    || historicalPayment.subscription_id !== attempt.subscription_id
    || historicalPayment.wompi_transaction_id !== input.transactionId
    || (historicalPayment.reference !== null && historicalPayment.reference !== attempt.reference)
  ))) {
    return NextResponse.json({ message: "La identidad del pago historico es ambigua o no coincide con el intento." }, { status: 409 });
  }
  const isV2Attempt = attempt.attempt_number !== null && attempt.attempt_number !== undefined;
  const historicalMoney = historicalPayment ? expectedMoneySchema.safeParse(historicalPayment) : null;
  const expectedMoney = expectedMoneySchema.safeParse(isV2Attempt ? attempt : historicalPayment ?? attempt);
  if (!expectedMoney.success || (historicalMoney && (!historicalMoney.success || (isV2Attempt && (
    historicalMoney.data.amount !== expectedMoney.data.amount || historicalMoney.data.currency !== expectedMoney.data.currency
  ))))) {
    return NextResponse.json({ message: "El importe o la moneda esperados no son validos para conciliar." }, { status: 409 });
  }
  if (!isV2Attempt && historicalPayment && expectedMoney.data.amount !== Number(attempt.amount)
    && historicalPayment.reference !== attempt.reference) {
    return NextResponse.json({ message: "La referencia del pago historico no coincide con el intento." }, { status: 409 });
  }
  const frozenSourceId = z.string().min(1).safeParse(attempt.dispatch_snapshot?.paymentSourceId);
  const expectedSourceId = isV2Attempt ? frozenSourceId.success ? frozenSourceId.data : null : subscription.wompi_payment_source_id;
  if (isV2Attempt && subscription.frequency === "monthly" && !expectedSourceId) {
    return NextResponse.json({ message: "La fuente congelada del intento no es valida." }, { status: 409 });
  }

  try {
    const transaction = await getWompiTransaction(input.transactionId);
    const status = transaction.status.toLowerCase();
    if (
      transaction.id !== input.transactionId
      || transaction.reference !== attempt.reference
      || transaction.amountInCents !== expectedMoney.data.amount * 100
      || transaction.currency !== expectedMoney.data.currency
      || !VERIFIED_STATUSES.has(status)
    ) {
      return NextResponse.json({ message: "La transaccion de Wompi no coincide con el intento seleccionado." }, { status: 409 });
    }
    if (
      (subscription.frequency === "monthly" || (isV2Attempt && expectedSourceId !== null))
      && (!expectedSourceId || transaction.paymentSourceId !== expectedSourceId)
    ) {
      return NextResponse.json({ message: "La fuente tokenizada de Wompi no coincide con la suscripcion." }, { status: 409 });
    }

    const finalized = transaction.finalizedAt ? new Date(transaction.finalizedAt) : null;
    const effectiveAt = finalized && Number.isFinite(finalized.getTime()) ? finalized : null;
    const storedDay = isV2Attempt ? attempt.dispatch_snapshot?.preferredPaymentDay : subscription.preferred_payment_day;
    const preferredDay = [1, 6, 16, 28].includes(Number(storedDay))
      ? Number(storedDay)
      : null;
    const candidateNextPayment = effectiveAt ? getNextMonthlyPaymentDate(effectiveAt, preferredDay) : null;
    const sanitized = {
      ...verifiedBillingTransaction(transaction),
      payment_source_verification: await retrySourceProof(transaction),
      source: "admin_recovery",
      transaction: verifiedBillingTransaction(transaction),
      verified_at: new Date().toISOString(),
    };

    const currentAdmin = await getAdminContext();
    if (!currentAdmin || currentAdmin.demo || currentAdmin.userId !== admin.userId) {
      return NextResponse.json({ message: "La sesion administrativa cambio o fue revocada." }, { status: 403 });
    }
    try { assertFinancialOperationsEnabled(); } catch {
      return NextResponse.json({ message: "Operaciones financieras deshabilitadas." }, { status: 503 });
    }
    const { data, error } = await serviceClient.rpc("billing_v2_admin_reconcile_payment_attempt", {
      p_attempt_id: attemptId,
      p_actor_user_id: admin.userId,
      p_actor_aal: currentAdmin.aal,
      p_actor_session_issued_at: currentAdmin.sessionIssuedAt,
      p_totp_verified_at: totpVerifiedAt,
      p_expected_version: input.expectedVersion,
      p_reason: input.reason,
      p_request_id: input.requestId,
      p_transaction_id: transaction.id,
      p_reference: attempt.reference,
      p_payment_source_id: transaction.paymentSourceId ?? null,
      p_amount: expectedMoney.data.amount,
      p_currency: expectedMoney.data.currency,
      p_status: status,
      p_effective_at: effectiveAt?.toISOString() ?? null,
      p_candidate_next_payment: candidateNextPayment?.toISOString() ?? null,
      p_raw: sanitized,
    });
    if (error) return recoveryRpcError(error.message);
    return confirmedRecoveryResponse(data, attemptId, input.transactionId);
  } catch (error) {
    console.error("admin_payment_recovery_verification_failed", {
      attemptId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ message: "No fue posible verificar la transaccion con Wompi." }, { status: 502 });
  }
}
