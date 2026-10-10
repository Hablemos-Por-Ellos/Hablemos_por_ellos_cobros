import { NextResponse } from "next/server";
import { subscriptionPayloadSchema } from "@/lib/schemas";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { financialOperationsEnabled } from "@/lib/operation-mode";
import { applyBillingResult, billingRetrySchemaReady, canStartAuthorizedSend, verifiedBillingTransaction } from "@/lib/billing-v2";
import { createCheckoutToken, createDonationReference, hashCheckoutToken, requestKeyHash } from "@/lib/checkout-security";
import { createWompiIntegritySignature, createWompiPaymentSource, createWompiTransaction,
  getWompiAcceptance, getWompiTransaction, isWompiPaymentSourceAvailable } from "@/lib/wompi-server";
import { WOMPI_ENV } from "@/lib/wompi";
import { getVerifiedWompiEffectiveDate } from "@/lib/wompi-webhook";

type Client = NonNullable<ReturnType<typeof getServiceSupabaseClient>>;

async function rpc(client: Client, name: string, input: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, input);
  if (error || !data) throw new Error("BILLING_OPERATION_FAILED");
  return data;
}

async function donorId(client: Client, donor: { email: string; firstName: string; lastName: string; phone: string; documentType: string; documentNumber: string; city: string; wantsUpdates: boolean }) {
  const email = donor.email.trim().toLowerCase();
  const lookup = () => client.from("donors").select("id").eq("email_normalized", email).maybeSingle();
  const existing = await lookup();
  if (existing.error) throw new Error("DONOR_QUERY_FAILED");
  if (existing.data?.id) return existing.data.id;
  const saved = await client.from("donors").insert({ email, first_name: donor.firstName, last_name: donor.lastName,
    phone: donor.phone, document_type: donor.documentType, document_number: donor.documentNumber,
    city: donor.city, wants_updates: donor.wantsUpdates }).select("id").single();
  if (saved.error?.code === "23505") {
    const concurrent = await lookup();
    if (!concurrent.error && concurrent.data?.id) return concurrent.data.id;
  }
  if (saved.error || !saved.data?.id) throw new Error("DONOR_SAVE_FAILED");
  return saved.data.id;
}

export async function POST(request: Request) {
  if (!financialOperationsEnabled()) return NextResponse.json({ message: "Las donaciones estan temporalmente en mantenimiento." }, { status: 503 });
  const input = subscriptionPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ message: "Informacion invalida" }, { status: 400 });
  const client = getServiceSupabaseClient();
  if (!client || !(await billingRetrySchemaReady(client))) return NextResponse.json({ message: "Servicio de pagos en preparacion." }, { status: 503 });
  const { stage, donor, amount, paymentMethod, checkoutToken, wompi } = input.data;
  let dispatchedAttempt: string | null = null;
  let transactionId: string | null = null;
  let needsReconciliation = stage === "confirm";
  const reconciliationResponse = () => NextResponse.json({ status: "payment_pending", code: "reconciliation_required",
    message: "El intento esta en conciliacion. No inicies otro cobro.", ...(transactionId ? { transactionId } : {}) }, { status: 202 });
  try {
    const { data: allowed, error: rateError } = await client.rpc("consume_api_rate_limit", {
      p_scope: `donation_${stage}`, p_key_hash: requestKeyHash(request), p_limit: stage === "draft" ? 30 : 10, p_window_seconds: 600,
    });
    if (rateError || allowed !== true) return NextResponse.json({ message: "Demasiados intentos. Espera unos minutos." }, { status: 429 });
    needsReconciliation = false;
    if (stage === "draft") {
      const id = await donorId(client, donor);
      const reference = createDonationReference();
      const token = createCheckoutToken();
      const acceptedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const acceptance = await getWompiAcceptance();
      const { error } = await client.from("checkout_intents").insert({ donor_id: id, reference,
        secret_hash: hashCheckoutToken(token), amount, currency: "COP", is_recurring: donor.isRecurring,
        preferred_payment_day: donor.isRecurring ? donor.preferredPaymentDay : null,
        environment: WOMPI_ENV, state: "draft", expires_at: expiresAt,
        retry_authorization: donor.isRecurring && donor.retryAuthorizationConfirmed === true
          ? { version: "0.4.0", recurring: true, retryAllowed: true, acceptedAt } : null });
      if (error) throw new Error("CHECKOUT_SAVE_FAILED");
      return NextResponse.json({ status: "draft_saved", checkout: { token, reference, expiresAt,
        amountInCents: amount * 100, currency: "COP", signature: createWompiIntegritySignature(reference, amount * 100, "COP"),
        acceptancePermalink: acceptance.acceptancePermalink, personalDataAuthPermalink: acceptance.personalDataAuthPermalink } });
    }
    if (!checkoutToken || !wompi?.reference || !paymentMethod) throw new Error("CHECKOUT_INVALID");
    // A failed lookup cannot establish that this checkout has never sent a payment.
    needsReconciliation = stage === "confirm";
    const { data: intent, error: intentError } = await client.from("checkout_intents")
      .select("id,donor_id,reference,amount,currency,is_recurring,environment,state,expires_at,payment_method_type")
      .eq("secret_hash", hashCheckoutToken(checkoutToken)).eq("reference", wompi.reference).maybeSingle();
    if (intentError) throw new Error("CHECKOUT_QUERY_FAILED");
    needsReconciliation = false;
    if (!intent || intent.environment !== WOMPI_ENV || intent.amount !== amount
      || intent.is_recurring !== donor.isRecurring || intent.currency !== "COP"
      || (intent.payment_method_type && intent.payment_method_type !== paymentMethod)) throw new Error("CHECKOUT_INVALID");
    if (stage === "checkout") {
      const subscription = await rpc(client, "billing_v2_prepare_subscription", { p_checkout_id: intent.id, p_payment_method: paymentMethod });
      if (Date.parse(intent.expires_at) <= Date.now()) throw new Error("CHECKOUT_EXPIRED");
      if (!intent.is_recurring) await rpc(client, "billing_v2_reserve_initial", { p_checkout_id: intent.id, p_subscription_id: subscription.id });
      return NextResponse.json({ status: "checkout_started", reference: intent.reference });
    }
    needsReconciliation = true;
    const { data: existing, error: attemptError } = await client.from("payment_attempts")
      .select("id,subscription_id,state,wompi_transaction_id,attempt_number").eq("checkout_intent_id", intent.id).maybeSingle();
    if (attemptError) throw new Error("ATTEMPT_QUERY_FAILED");
    needsReconciliation = Boolean(wompi.transactionId);
    if (existing?.wompi_transaction_id) {
      needsReconciliation = true;
      transactionId = existing.wompi_transaction_id;
    }
    if (existing && ["dispatching", "unknown", "pending"].includes(existing.state)) needsReconciliation = true;
    const respond = async (attemptId: string, id: string, attemptNumber: number | null,
      preparedSubscription?: { id: string; wompi_payment_source_id: string | null }) => {
      needsReconciliation = true;
      const tx = await getWompiTransaction(id);
      const mismatchResponse = () => {
        if (dispatchedAttempt) throw new Error("WOMPI_MISMATCH");
        return NextResponse.json({ code: "transaction_mismatch", message: "No pudimos vincular la transaccion a este checkout." }, { status: 400 });
      };
      if (tx.id !== id || tx.reference !== intent.reference || tx.amountInCents !== intent.amount * 100 || tx.currency !== intent.currency) return mismatchResponse();
      let subscription = preparedSubscription;
      if (!subscription) {
        if (!existing?.subscription_id) throw new Error("CHECKOUT_SUBSCRIPTION_MISMATCH");
        const { data: stored, error } = await client.from("subscriptions")
          .select("id,donor_id,reference,currency,frequency,wompi_payment_source_id")
          .eq("id", existing.subscription_id).maybeSingle();
        if (error || !stored || stored.id !== existing.subscription_id || stored.reference !== intent.reference || stored.donor_id !== intent.donor_id
          || stored.currency !== intent.currency
          || stored.frequency !== (intent.is_recurring ? "monthly" : "one_time")) throw new Error("CHECKOUT_SUBSCRIPTION_MISMATCH");
        subscription = { id: stored.id, wompi_payment_source_id: stored.wompi_payment_source_id };
      }
      if (intent.is_recurring && (!subscription.wompi_payment_source_id || tx.paymentSourceId !== subscription.wompi_payment_source_id)) return mismatchResponse();
      if (attemptNumber !== null && attemptNumber !== 1 && attemptNumber !== 2) throw new Error("ATTEMPT_PROTOCOL_INVALID");
      // Explicit NULL is the existing DB legacy protocol, never an inferred v2 ordinal.
      const result = attemptNumber === null ? await rpc(client, "apply_verified_wompi_event", {
        p_event_key: `checkout-reconciliation:${attemptId}:${tx.id}:${tx.status}:${tx.finalizedAt ?? ""}`,
        p_transaction_id: tx.id, p_event_type: "transaction.reconciled", p_reference: tx.reference,
        p_payment_source_id: tx.paymentSourceId ?? null, p_amount: tx.amountInCents! / 100,
        p_currency: tx.currency, p_status: tx.status.toLowerCase(),
        p_effective_at: getVerifiedWompiEffectiveDate({ id: tx.id, finalizedAt: tx.finalizedAt ?? undefined })?.toISOString() ?? null,
        p_candidate_next_payment: null,
        p_raw: { environment: WOMPI_ENV, verification_source: "provider_get", source: "server_reconciliation",
          transaction: verifiedBillingTransaction(tx) },
      }) : await applyBillingResult(client, attemptId, tx);
      if (!["processed", "duplicate", "review"].includes(result.result)) throw new Error("BILLING_RESULT_NOT_APPLIED");
      if (result.result === "review" || result.scheduleProtected === true || result.historicalOnly === true) return reconciliationResponse();
      const approved = tx.status === "approved" && result.result !== "review";
      const retryQueued = result.retryQueued === true;
      return NextResponse.json({ status: approved ? "subscription_created" : retryQueued || ["approved", "pending"].includes(tx.status) ? "payment_pending" : "payment_failed",
        subscriptionId: result.subscriptionId ?? subscription.id, transactionId: id,
        ...(retryQueued ? { message: "Fondos insuficientes. Se programo el unico intento adicional autorizado; no inicies otro pago." }
          : !approved && tx.status !== "pending" ? { message: "No se aprobo el pago. No se enviara otro cobro desde este checkout." } : {}) },
      { status: approved ? 200 : retryQueued || ["approved", "pending"].includes(tx.status) ? 202 : 402 });
    };
    if (existing?.wompi_transaction_id) return await respond(existing.id, existing.wompi_transaction_id, existing.attempt_number);
    if (wompi.transactionId) {
      if (!existing?.id) return reconciliationResponse();
      // Browser/widget claims allow verified recovery only, never a second send.
      return await respond(existing.id, wompi.transactionId, existing.attempt_number);
    }
    if (needsReconciliation) return reconciliationResponse();
    if (!intent.is_recurring) {
      throw new Error("TRANSACTION_REQUIRED");
    }
    if (paymentMethod !== "card" || Date.parse(intent.expires_at) <= Date.now()) throw new Error("CHECKOUT_EXPIRED");
    if (!["draft", "checkout"].includes(intent.state) || (existing && existing.state !== "prepared")) throw new Error("CHECKOUT_STATE_INVALID");
    const subscription = await rpc(client, "billing_v2_prepare_subscription", { p_checkout_id: intent.id, p_payment_method: paymentMethod });
    let sourceId = subscription.wompi_payment_source_id;
    if (!sourceId) {
      if (!wompi.cardToken) throw new Error("CARD_TOKEN_REQUIRED");
      const { data: storedDonor, error: donorError } = await client.from("donors")
        .select("email").eq("id", intent.donor_id).maybeSingle();
      if (donorError || !storedDonor?.email) throw new Error("DONOR_QUERY_FAILED");
      const acceptance = await getWompiAcceptance();
      const source = await createWompiPaymentSource({ token: wompi.cardToken, type: "CARD", customerEmail: storedDonor.email,
        acceptanceToken: acceptance.acceptanceToken, acceptPersonalAuth: acceptance.acceptPersonalAuth });
      sourceId = source.id;
      if (source.type !== "CARD" || source.status !== "AVAILABLE" || !(await isWompiPaymentSourceAvailable(sourceId))) throw new Error("SOURCE_UNAVAILABLE");
      await rpc(client, "billing_v2_bind_source", { p_checkout_id: intent.id, p_subscription_id: subscription.id,
        p_payment_source_id: sourceId, p_source_verified: true });
      subscription.wompi_payment_source_id = sourceId;
    } else if (!(await isWompiPaymentSourceAvailable(sourceId))) throw new Error("SOURCE_UNAVAILABLE");
    const reservation = await rpc(client, "billing_v2_reserve_initial", { p_checkout_id: intent.id, p_subscription_id: subscription.id });
    const attemptId = reservation.attempt?.id;
    if (reservation.dispatchSnapshot?.attemptId !== attemptId) throw new Error("RESERVATION_INVALID");
    if (!attemptId) throw new Error("RESERVATION_INVALID");
    const acceptance = await getWompiAcceptance();
    if (!financialOperationsEnabled()) throw new Error("FINANCIAL_OPERATIONS_DISABLED");
    // Fresh source GET is completed before the durable send barrier.
    if (!(await isWompiPaymentSourceAvailable(sourceId))) throw new Error("SOURCE_UNAVAILABLE");
    // The RPC itself can commit before its response is lost. Treat that as uncertain.
    dispatchedAttempt = attemptId;
    const claim = await rpc(client, "billing_v2_authorize_send", { p_attempt_id: attemptId,
      p_source_verification: { id: sourceId, type: "CARD", status: "AVAILABLE", environment: WOMPI_ENV,
        verification_source: "provider_get", verified_at: new Date().toISOString() } });
    if (claim.canDispatch !== true) return NextResponse.json({ status: "payment_pending", message: "El intento no admite otro envio; espera su conciliacion." }, { status: 202 });
    // After the durable barrier, even an interrupted request is potentially sent.
    if (claim.reference !== intent.reference || claim.amount !== intent.amount || claim.currency !== intent.currency
      || claim.paymentSourceId !== sourceId || !claim.customerEmail || !canStartAuthorizedSend(claim)) throw new Error("SEND_GRANT_INVALID");
    if (!financialOperationsEnabled()) throw new Error("FINANCIAL_OPERATIONS_DISABLED");
    const tx = await createWompiTransaction({ reference: claim.reference, amountInCents: claim.amount * 100,
      currency: claim.currency, customerEmail: claim.customerEmail, paymentSourceId: claim.paymentSourceId,
      acceptanceToken: acceptance.acceptanceToken, acceptPersonalAuth: acceptance.acceptPersonalAuth, recurrent: true,
      onSending: () => {
        if (!financialOperationsEnabled() || !canStartAuthorizedSend(claim)) throw new Error("SEND_GRANT_EXPIRED");
      } });
    transactionId = tx.id;
    await rpc(client, "billing_v2_record_dispatch", { p_attempt_id: attemptId, p_transaction_id: tx.id, p_status: tx.status });
    return await respond(attemptId, tx.id, 1, subscription);
  } catch {
    if (dispatchedAttempt) {
      try {
        if (transactionId) await rpc(client, "billing_v2_record_dispatch", { p_attempt_id: dispatchedAttempt, p_transaction_id: transactionId, p_status: "pending" });
        else await rpc(client, "billing_v2_mark_uncertain", { p_attempt_id: dispatchedAttempt });
      } catch { console.error("donations_api_error code=UNCERTAIN_RESULT_PERSISTENCE_FAILED"); }
    }
    if (needsReconciliation || dispatchedAttempt) return reconciliationResponse();
    console.error("donations_api_error code=CHECKOUT_OPERATION_FAILED");
    return NextResponse.json({ code: "checkout_restart_required", message: "No pudimos completar este checkout. Regresa al primer paso o contacta a la fundacion." }, { status: 400 });
  }
}
