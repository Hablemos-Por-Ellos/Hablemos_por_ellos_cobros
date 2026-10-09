// Historical v0.3.0 contract retained for comparison tests, NOT an HTTP route.
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { subscriptionPayloadSchema } from "@/lib/schemas";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import {
  createWompiPaymentSource,
  createWompiTransaction,
  createWompiIntegritySignature,
  getWompiAcceptance,
  getWompiTransaction,
} from "@/lib/wompi-server";
import { getNextMonthlyPaymentDate, isPreferredPaymentDay } from "@/lib/payment-dates";
import { WOMPI_ENV } from "@/lib/wompi";
import { financialOperationsEnabled } from "@/lib/operation-mode";
import { getVerifiedWompiEffectiveDate } from "@/lib/wompi-webhook";
import { paymentSchemaReady } from "@/lib/payment-schema";
import {
  createCheckoutToken,
  createDonationReference,
  hashCheckoutToken,
  requestKeyHash,
} from "@/lib/checkout-security";

type SupabaseClient = NonNullable<ReturnType<typeof getServiceSupabaseClient>>;
type PaymentMethod = "card" | "nequi";
const RETRYABLE_PAYMENT_FAILURES = new Set(["declined", "error", "voided"]);

function safeDonationError(error: unknown) {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  if (message.includes("CHECKOUT_TOKEN_PEPPER")) return "La seguridad del checkout no esta configurada.";
  if (message.includes("RATE_LIMIT")) return "Demasiados intentos. Espera unos minutos antes de continuar.";
  if (message.includes("WOMPI_MISMATCH")) return "La transaccion recibida no coincide con esta donacion.";
  if (message.includes("CHECKOUT_EXPIRED")) return "La sesion de pago vencio. Regresa al primer paso e intenta de nuevo.";
  if (message.includes("CHECKOUT_RESTART_REQUIRED") || message.includes("CHECKOUT_STATE_INVALID")) {
    return "Este intento ya termino y no puede reutilizarse. Regresa al primer paso e intenta de nuevo.";
  }
  if (message.includes("DONOR_PAYMENT_IN_PROGRESS")) {
    return "Ya existe un cobro de este donante en conciliacion. Espera su resultado antes de intentar otro.";
  }
  if (message.includes("CHECKOUT_INVALID")) return "La sesion de pago no es valida.";
  return "No pudimos completar la donacion. Intenta nuevamente.";
}

function safeDonationErrorCode(error: unknown, stage: string, transactionDispatchStarted: boolean) {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  if (message.includes("RATE_LIMIT")) return "rate_limited";
  if (message.includes("WOMPI_MISMATCH")) return "checkout_restart_required";
  if (message.includes("DONOR_PAYMENT_IN_PROGRESS") || (stage === "confirm" && transactionDispatchStarted)) {
    return "reconciliation_required";
  }
  if (
    message.includes("CHECKOUT_EXPIRED")
    || message.includes("CHECKOUT_RESTART_REQUIRED")
    || message.includes("CHECKOUT_STATE_INVALID")
    || stage === "confirm"
  ) {
    return "checkout_restart_required";
  }
  return "donation_failed";
}

function logDonationError(stage: string, reference: string | null, error: unknown) {
  console.error("donations_api_error", {
    stage,
    reference,
    wompiEnv: WOMPI_ENV,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorCode: error instanceof Error ? error.message.split(":")[0].slice(0, 80) : "UNKNOWN",
  });
}

async function enforceRateLimit(supabase: SupabaseClient, request: Request, scope: string, limit: number) {
  const { data, error } = await supabase.rpc("consume_api_rate_limit", {
    p_scope: scope,
    p_key_hash: requestKeyHash(request),
    p_limit: limit,
    p_window_seconds: 600,
  });
  if (error || data !== true) throw new Error("RATE_LIMIT_EXCEEDED");
}

async function findOrCreateDonor(supabase: SupabaseClient, donor: any) {
  const normalizedEmail = String(donor.email).trim().toLowerCase();
  const { data: existing, error: lookupError } = await supabase
    .from("donors")
    .select("id, email")
    .eq("email_normalized", normalizedEmail)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing?.id) return existing;

  const { data, error } = await supabase
    .from("donors")
    .insert({
      email: normalizedEmail,
      first_name: donor.firstName,
      last_name: donor.lastName,
      phone: donor.phone,
      document_type: donor.documentType,
      document_number: donor.documentNumber,
      city: donor.city,
      wants_updates: donor.wantsUpdates,
    })
    .select("id, email")
    .single();
  if (error?.code === "23505") {
    const { data: concurrent, error: concurrentError } = await supabase
      .from("donors")
      .select("id, email")
      .eq("email_normalized", normalizedEmail)
      .single();
    if (concurrentError || !concurrent) throw concurrentError ?? error;
    return concurrent;
  }
  if (error) throw error;
  return data;
}

async function loadIntent(supabase: SupabaseClient, token: string, reference: string) {
  const { data, error } = await supabase
    .from("checkout_intents")
    .select("id, donor_id, reference, amount, currency, is_recurring, preferred_payment_day, payment_method_type, environment, state, expires_at")
    .eq("secret_hash", hashCheckoutToken(token))
    .eq("reference", reference)
    .maybeSingle();
  if (error || !data) throw new Error("CHECKOUT_INVALID");
  if (data.environment !== WOMPI_ENV) throw new Error("CHECKOUT_INVALID_ENV");
  return data;
}

async function loadPaymentAttempt(supabase: SupabaseClient, checkoutIntentId: string) {
  const { data, error } = await supabase
    .from("payment_attempts")
    .select("id, subscription_id, state, wompi_transaction_id")
    .eq("checkout_intent_id", checkoutIntentId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function responseForExistingAttempt(
  supabase: SupabaseClient,
  attempt: any,
  intent: any,
  paymentMethod: PaymentMethod
) {
  if (!attempt) return null;
  if (attempt.wompi_transaction_id) {
    const verified = await getWompiTransaction(attempt.wompi_transaction_id);
    verifyTransaction(verified, intent, attempt.wompi_transaction_id);
    const pendingSubscription = intent.is_recurring
      ? await ensurePendingSubscription(supabase, intent, paymentMethod)
      : null;
    const expectedPaymentSourceId = intent.is_recurring
      ? pendingSubscription?.wompi_payment_source_id ?? null
      : verified.paymentSourceId ?? null;
    if (
      intent.is_recurring
      && (!expectedPaymentSourceId || verified.paymentSourceId !== expectedPaymentSourceId)
    ) {
      throw new Error("WOMPI_MISMATCH");
    }
    return finalizeVerifiedTransaction(supabase, {
      attemptId: attempt.id,
      intent,
      paymentMethod,
      transaction: verified,
      paymentSourceId: expectedPaymentSourceId,
    });
  }
  if (["dispatching", "pending", "unknown"].includes(attempt.state)) {
    return NextResponse.json(
      { status: "payment_pending", message: "El cobro se esta conciliando; no se enviara otro intento." },
      { status: 202 }
    );
  }
  return null;
}

async function ensurePendingSubscription(supabase: SupabaseClient, intent: any, paymentMethod: PaymentMethod) {
  const { data: existing, error: lookupError } = await supabase
    .from("subscriptions")
    .select("id, status, billing_version, wompi_payment_source_id")
    .eq("reference", intent.reference)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing?.id) {
    if (existing.status === "cancelled") throw new Error("SUBSCRIPTION_CANCELLED");
    return existing;
  }

  const payload = {
    donor_id: intent.donor_id,
    amount: intent.amount,
    currency: "COP",
    frequency: intent.is_recurring ? "monthly" : "one_time",
    status: "pending",
    payment_method_type: paymentMethod,
    preferred_payment_day: intent.is_recurring && isPreferredPaymentDay(intent.preferred_payment_day)
      ? intent.preferred_payment_day
      : null,
    reference: intent.reference,
    next_payment_date: null,
    processed_transaction_ids: [],
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("subscriptions")
    .insert(payload)
    .select("id, status, billing_version, wompi_payment_source_id")
    .single();
  if (!error) return data;
  if (error.code !== "23505") throw error;

  const { data: concurrent, error: concurrentError } = await supabase
    .from("subscriptions")
    .select("id, status, billing_version, wompi_payment_source_id")
    .eq("reference", intent.reference)
    .single();
  if (concurrentError || !concurrent) throw concurrentError ?? error;
  if (concurrent.status === "cancelled") throw new Error("SUBSCRIPTION_CANCELLED");
  return concurrent;
}

async function finalizeVerifiedTransaction(supabase: SupabaseClient, params: {
  attemptId: string;
  intent: any;
  paymentMethod: PaymentMethod;
  transaction: Awaited<ReturnType<typeof getWompiTransaction>>;
  paymentSourceId: string | null;
}) {
  verifyTransaction(params.transaction, params.intent);
  const transactionStatus = params.transaction.status.toLowerCase();
  const verifiedMethodType = params.transaction.paymentMethodType?.toUpperCase();
  const verifiedPaymentMethod: PaymentMethod = verifiedMethodType === "NEQUI"
    ? "nequi"
    : verifiedMethodType === "CARD"
      ? "card"
      : params.paymentMethod;
  if (params.intent.is_recurring && verifiedPaymentMethod !== "card") throw new Error("WOMPI_MISMATCH");
  if (
    params.intent.is_recurring &&
    (!params.paymentSourceId || params.transaction.paymentSourceId !== params.paymentSourceId)
  ) {
    throw new Error("WOMPI_MISMATCH");
  }
  if (!["approved", "pending", "declined", "error", "voided"].includes(transactionStatus)) {
    throw new Error("WOMPI_UNSUPPORTED_STATUS");
  }
  const effectiveAt = getVerifiedWompiEffectiveDate({ id: params.transaction.id, finalized_at: params.transaction.finalizedAt });
  const candidateNextPayment = effectiveAt ? getNextMonthlyPaymentDate(
    effectiveAt,
    isPreferredPaymentDay(params.intent.preferred_payment_day) ? params.intent.preferred_payment_day : null
  ) : null;
  const eventKey = crypto
    .createHash("sha256")
    .update(`direct|${params.transaction.id}|${transactionStatus}`)
    .digest("hex");
  const { data, error } = await supabase.rpc("apply_verified_wompi_event", {
    p_event_key: eventKey,
    p_transaction_id: params.transaction.id,
    p_event_type: "transaction.verified",
    p_reference: params.intent.reference,
    p_payment_source_id: params.paymentSourceId,
    p_amount: params.intent.amount,
    p_currency: params.intent.currency,
    p_status: transactionStatus,
    p_effective_at: effectiveAt?.toISOString() ?? null,
    p_candidate_next_payment: candidateNextPayment?.toISOString() ?? null,
    p_raw: {
      event: "transaction.verified",
      transaction: {
        id: params.transaction.id,
        status: transactionStatus,
        reference: params.intent.reference,
        amount_in_cents: params.intent.amount * 100,
        currency: params.intent.currency,
        payment_method_type: verifiedPaymentMethod,
        finalized_at: params.transaction.finalizedAt ?? null,
      },
      received_at: new Date().toISOString(),
    },
  });
  if (error || !["processed", "duplicate", "review"].includes(String(data?.result)) || !data?.subscriptionId) {
    throw error ?? new Error("ATOMIC_PAYMENT_FINALIZATION_FAILED");
  }

  const approvedAndApplied = transactionStatus === "approved" && effectiveAt
    && data.result !== "review" && data.processingState !== "needs_review";
  const responsePayload = {
    status: approvedAndApplied
      ? "subscription_created"
      : transactionStatus === "pending" || transactionStatus === "approved"
        ? "payment_pending"
        : "payment_failed",
    subscriptionId: data.subscriptionId,
    transactionId: params.transaction.id,
    ...(transactionStatus === "declined"
      ? { message: "El pago fue rechazado por Wompi. Regresa al primer paso e intenta nuevamente." }
      : transactionStatus === "voided"
        ? { message: "El pago fue anulado por Wompi. Regresa al primer paso e intenta nuevamente." }
        : transactionStatus === "error"
          ? { message: "Wompi no pudo completar el pago. Regresa al primer paso e intenta nuevamente." }
          : {}),
  };

  return NextResponse.json(responsePayload, {
    status: approvedAndApplied ? 200 : ["pending", "approved"].includes(transactionStatus) ? 202 : 402,
  });
}

function verifyTransaction(
  transaction: Awaited<ReturnType<typeof getWompiTransaction>>,
  intent: any,
  expectedTransactionId?: string
) {
  if (
    (expectedTransactionId && transaction.id !== expectedTransactionId) ||
    transaction.reference !== intent.reference ||
    transaction.amountInCents !== intent.amount * 100 ||
    transaction.currency !== intent.currency
  ) {
    throw new Error("WOMPI_MISMATCH");
  }
}

export async function POST(request: Request) {
  if (!financialOperationsEnabled()) {
    return NextResponse.json({ message: "Las donaciones estan temporalmente en mantenimiento." }, { status: 503 });
  }
  const parsed = subscriptionPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "Informacion invalida" }, { status: 400 });

  const supabase = getServiceSupabaseClient();
  if (!supabase) return NextResponse.json({ message: "Servicio de datos no configurado." }, { status: 503 });
  if (!(await paymentSchemaReady(supabase))) return NextResponse.json({ message: "Servicio de pagos en preparacion." }, { status: 503 });
  const { stage, donor, amount, paymentMethod, wompi, checkoutToken } = parsed.data;
  let activeAttemptId: string | null = null;
  let activeIntentId: string | null = null;
  let transactionDispatchStarted = false;
  let intentProcessingClaimed = false;
  let attemptClaimedByRequest = false;
  let activeTransactionId: string | null = null;
  let activeProviderStatus: string | null = null;

  try {
    if (stage === "draft") {
      await enforceRateLimit(supabase, request, "donation_draft", 30);
      const donorRecord = await findOrCreateDonor(supabase, donor);
      const token = createCheckoutToken();
      const reference = createDonationReference();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const isRecurring = donor.isRecurring ?? true;
      const acceptance = await getWompiAcceptance();

      const { error } = await supabase.from("checkout_intents").insert({
        donor_id: donorRecord.id,
        reference,
        secret_hash: hashCheckoutToken(token),
        amount,
        currency: "COP",
        is_recurring: isRecurring,
        preferred_payment_day: isRecurring ? donor.preferredPaymentDay : null,
        environment: WOMPI_ENV,
        state: "draft",
        expires_at: expiresAt,
      });
      if (error) throw error;

      return NextResponse.json({
        status: "draft_saved",
        checkout: {
          token,
          reference,
          signature: createWompiIntegritySignature(reference, amount * 100, "COP"),
          amountInCents: amount * 100,
          currency: "COP",
          expiresAt,
          acceptancePermalink: acceptance.acceptancePermalink,
          personalDataAuthPermalink: acceptance.personalDataAuthPermalink,
        },
      });
    }

    if (!checkoutToken || !wompi?.reference) throw new Error("CHECKOUT_INVALID");
    const intent = await loadIntent(supabase, checkoutToken, wompi.reference);
    activeIntentId = intent.id;
    if (intent.amount !== amount || intent.is_recurring !== (donor.isRecurring ?? true)) throw new Error("CHECKOUT_INVALID");
    const intentExpired = new Date(intent.expires_at).getTime() <= Date.now();

    if (stage === "checkout") {
      await enforceRateLimit(supabase, request, "donation_checkout", 20);
      if (intentExpired) throw new Error("CHECKOUT_EXPIRED");
      if (!paymentMethod || !["draft", "checkout"].includes(intent.state)) throw new Error("CHECKOUT_STATE_INVALID");
      const pendingSubscription = await ensurePendingSubscription(supabase, intent, paymentMethod);

      if (!intent.is_recurring) {
        if (intent.state !== "draft") throw new Error("CHECKOUT_RESTART_REQUIRED");
        let reservedAttempt = await loadPaymentAttempt(supabase, intent.id);
        if (!reservedAttempt) {
          const { data, error: reserveError } = await supabase
            .from("payment_attempts")
            .insert({
              checkout_intent_id: intent.id,
              donor_id: intent.donor_id,
              subscription_id: pendingSubscription.id,
              subscription_version: pendingSubscription.billing_version ?? 0,
              reference: intent.reference,
              amount: intent.amount,
              currency: intent.currency,
              state: "prepared",
            })
            .select("id, subscription_id, state, wompi_transaction_id")
            .single();
          if (!reserveError) {
            reservedAttempt = data;
          } else if (reserveError.code === "23505") {
            reservedAttempt = await loadPaymentAttempt(supabase, intent.id);
            if (!reservedAttempt) throw reserveError;
          } else {
            throw reserveError;
          }
        }
        if (reservedAttempt.state !== "prepared" || reservedAttempt.wompi_transaction_id) {
          throw new Error("CHECKOUT_RESTART_REQUIRED");
        }
      }

      const intentUpdate = supabase
        .from("checkout_intents")
        .update({ state: "checkout", payment_method_type: paymentMethod, updated_at: new Date().toISOString() })
        .eq("id", intent.id);
      const intentClaim = intent.is_recurring
        ? intentUpdate.in("state", ["draft", "checkout"])
        : intentUpdate.eq("state", "draft");
      const { data: updatedIntent, error } = await intentClaim
        .select("id")
        .maybeSingle();
      if (error || !updatedIntent) throw error ?? new Error("CHECKOUT_STATE_INVALID");
      return NextResponse.json({ status: "checkout_started", reference: intent.reference });
    }

    await enforceRateLimit(supabase, request, "donation_confirm", 10);
    if (!paymentMethod) throw new Error("CHECKOUT_INVALID");
    if (intent.payment_method_type && intent.payment_method_type !== paymentMethod) {
      throw new Error("CHECKOUT_INVALID");
    }

    const existingAttempt = await loadPaymentAttempt(supabase, intent.id);
    const externalTransactionKnown = !intent.is_recurring && Boolean(wompi.transactionId);
    const clientRecoveryKnown = Boolean(existingAttempt?.id && wompi.transactionId);
    if (externalTransactionKnown) transactionDispatchStarted = true;
    if (
      intentExpired
      && !existingAttempt?.wompi_transaction_id
      && !externalTransactionKnown
      && !clientRecoveryKnown
    ) {
      throw new Error("CHECKOUT_EXPIRED");
    }

    const { data: donorRecord, error: donorError } = await supabase.from("donors").select("email").eq("id", intent.donor_id).single();
    if (donorError || !donorRecord?.email) throw new Error("CHECKOUT_INVALID");

    if (existingAttempt?.id) {
      activeAttemptId = existingAttempt.id;
      transactionDispatchStarted = transactionDispatchStarted || Boolean(existingAttempt.wompi_transaction_id);
      activeTransactionId = existingAttempt.wompi_transaction_id ?? null;
    }
    if (
      !intent.is_recurring
      && existingAttempt?.id
      && existingAttempt.wompi_transaction_id
      && wompi.transactionId
      && existingAttempt.wompi_transaction_id !== wompi.transactionId
    ) {
      transactionDispatchStarted = true;
      // The browser already knows the retry ID. Until Wompi verifies it, do not
      // let an older stored ID replace that recovery handle in an error response.
      activeTransactionId = null;
      const previousTransaction = await getWompiTransaction(existingAttempt.wompi_transaction_id);
      verifyTransaction(previousTransaction, intent, existingAttempt.wompi_transaction_id);
      if (!RETRYABLE_PAYMENT_FAILURES.has(previousTransaction.status.toLowerCase())) {
        return finalizeVerifiedTransaction(supabase, {
          attemptId: existingAttempt.id,
          intent,
          paymentMethod,
          transaction: previousTransaction,
          paymentSourceId: previousTransaction.paymentSourceId ?? null,
        });
      }

      await finalizeVerifiedTransaction(supabase, {
        attemptId: existingAttempt.id,
        intent,
        paymentMethod,
        transaction: previousTransaction,
        paymentSourceId: previousTransaction.paymentSourceId ?? null,
      });
      const retryTransaction = await getWompiTransaction(wompi.transactionId);
      verifyTransaction(retryTransaction, intent, wompi.transactionId);
      activeTransactionId = retryTransaction.id;
      activeProviderStatus = retryTransaction.status.toLowerCase();
      return finalizeVerifiedTransaction(supabase, {
        attemptId: existingAttempt.id,
        intent,
        paymentMethod,
        transaction: retryTransaction,
        paymentSourceId: retryTransaction.paymentSourceId ?? null,
      });
    }
    if (
      existingAttempt?.id
      && !existingAttempt.wompi_transaction_id
      && wompi.transactionId
      && ["dispatching", "pending", "unknown"].includes(existingAttempt.state)
    ) {
      transactionDispatchStarted = true;
      const pendingSubscription = await ensurePendingSubscription(supabase, intent, paymentMethod);
      const verified = await getWompiTransaction(wompi.transactionId);
      verifyTransaction(verified, intent, wompi.transactionId);
      const recoveredPaymentSourceId = intent.is_recurring
        ? pendingSubscription.wompi_payment_source_id ?? null
        : verified.paymentSourceId ?? null;
      if (
        intent.is_recurring
        && (!recoveredPaymentSourceId || verified.paymentSourceId !== recoveredPaymentSourceId)
      ) {
        throw new Error("WOMPI_MISMATCH");
      }
      activeTransactionId = wompi.transactionId;
      activeProviderStatus = verified.status.toLowerCase();
      return finalizeVerifiedTransaction(supabase, {
        attemptId: existingAttempt.id,
        intent,
        paymentMethod,
        transaction: verified,
        paymentSourceId: recoveredPaymentSourceId,
      });
    }
    const existingResponse = await responseForExistingAttempt(supabase, existingAttempt, intent, paymentMethod);
    if (existingResponse) return existingResponse;
    if (existingAttempt && existingAttempt.state !== "prepared") throw new Error("CHECKOUT_RESTART_REQUIRED");
    if (!existingAttempt && intent.state !== "checkout" && !(externalTransactionKnown && intent.state === "expired")) {
      throw new Error("CHECKOUT_STATE_INVALID");
    }
    const pendingSubscription = await ensurePendingSubscription(supabase, intent, paymentMethod);

    const intentClaimBase = supabase
      .from("checkout_intents")
      .update({ state: "processing", updated_at: new Date().toISOString() })
      .eq("id", intent.id);
    const intentClaim = externalTransactionKnown
      ? intentClaimBase.in("state", ["checkout", "expired"])
      : intentClaimBase.eq("state", "checkout").gt("expires_at", new Date().toISOString());
    const { data: claimedIntent, error: intentClaimError } = await intentClaim.select("id").maybeSingle();
    if (intentClaimError || !claimedIntent) {
      throw intentClaimError ?? new Error(intentExpired ? "CHECKOUT_EXPIRED" : "CHECKOUT_STATE_INVALID");
    }
    intentProcessingClaimed = true;

    let attempt = existingAttempt;
    if (!attempt) {
      const { data, error } = await supabase
        .from("payment_attempts")
        .insert({
          checkout_intent_id: intent.id,
          donor_id: intent.donor_id,
          subscription_id: pendingSubscription.id,
          subscription_version: pendingSubscription.billing_version ?? 0,
          reference: intent.reference,
          amount: intent.amount,
          currency: intent.currency,
          state: "prepared",
        })
        .select("id, subscription_id, state, wompi_transaction_id")
        .single();
      if (!error) {
        attempt = data;
      } else if (error.code === "23505") {
        attempt = await loadPaymentAttempt(supabase, intent.id);
        if (!attempt) throw error;
        activeAttemptId = attempt.id;
        transactionDispatchStarted = Boolean(attempt.wompi_transaction_id);
        const concurrentResponse = await responseForExistingAttempt(supabase, attempt, intent, paymentMethod);
        if (concurrentResponse) return concurrentResponse;
        if (attempt.state !== "prepared") throw new Error("CHECKOUT_RESTART_REQUIRED");
      } else {
        throw error;
      }
    }
    activeAttemptId = attempt.id;

    const { data: claimedAttempt, error: claimError } = await supabase
      .from("payment_attempts")
      .update({
        state: "dispatching",
        // The widget's one-time transaction was already sent outside this route.
        ...(externalTransactionKnown ? { dispatched_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", attempt.id)
      .eq("state", "prepared")
      .is("wompi_transaction_id", null)
      .is("dispatched_at", null)
      .select("id")
      .maybeSingle();
    if (claimError?.code === "23505") throw new Error("DONOR_PAYMENT_IN_PROGRESS");
    if (claimError) throw claimError;
    if (!claimedAttempt) {
      return NextResponse.json(
        { status: "payment_pending", message: "El cobro ya esta siendo procesado; no se enviara otro intento." },
        { status: 202 }
      );
    }
    attemptClaimedByRequest = true;
    let paymentSourceId: string | null = null;
    let transaction;

    if (intent.is_recurring) {
      if (paymentMethod !== "card" || !wompi.cardToken) throw new Error("CARD_TOKEN_REQUIRED");
      const sourceAcceptance = await getWompiAcceptance();
      const source = await createWompiPaymentSource({
        token: wompi.cardToken,
        type: "CARD",
        customerEmail: donorRecord.email,
        acceptanceToken: sourceAcceptance.acceptanceToken,
        acceptPersonalAuth: sourceAcceptance.acceptPersonalAuth,
      });
      if (source.type.toUpperCase() !== "CARD" || source.status.toUpperCase() !== "AVAILABLE") {
        throw new Error("PAYMENT_SOURCE_UNAVAILABLE");
      }
      paymentSourceId = source.id;
      const { data: savedSource, error: sourceSaveError } = await supabase
        .from("subscriptions")
        .update({ wompi_payment_source_id: source.id, wompi_masked_details: source.maskedDetails, updated_at: new Date().toISOString() })
        .eq("id", pendingSubscription.id)
        .neq("status", "cancelled")
        .select("id")
        .maybeSingle();
      if (sourceSaveError || !savedSource) throw sourceSaveError ?? new Error("PAYMENT_SOURCE_SAVE_FAILED");
      const transactionAcceptance = await getWompiAcceptance();
      // dispatching reserves donor exclusion; only this durable marker precedes a financial POST.
      const { data: markedDispatch, error: dispatchSaveError } = await supabase
        .from("payment_attempts")
        .update({ dispatched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", attempt.id)
        .eq("state", "dispatching")
        .is("wompi_transaction_id", null)
        .is("dispatched_at", null)
        .select("id")
        .maybeSingle();
      if (dispatchSaveError || !markedDispatch) throw dispatchSaveError ?? new Error("PAYMENT_DISPATCH_SAVE_FAILED");
      transactionDispatchStarted = true;
      const createdTransaction = await createWompiTransaction({
        reference: intent.reference,
        amountInCents: intent.amount * 100,
        currency: intent.currency,
        customerEmail: donorRecord.email,
        paymentSourceId,
        acceptanceToken: transactionAcceptance.acceptanceToken,
        acceptPersonalAuth: transactionAcceptance.acceptPersonalAuth,
        recurrent: true,
      });
      activeTransactionId = createdTransaction.id;
      activeProviderStatus = createdTransaction.status.toLowerCase();
      const { data: savedTransaction, error: transactionSaveError } = await supabase
        .from("payment_attempts")
        .update({
          state: "pending",
          wompi_transaction_id: createdTransaction.id,
          provider_status: activeProviderStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", attempt.id)
        .eq("state", "dispatching")
        .select("id")
        .maybeSingle();
      if (transactionSaveError) throw transactionSaveError;
      if (!savedTransaction) {
        const concurrentAttempt = await loadPaymentAttempt(supabase, intent.id);
        const concurrentResponse = await responseForExistingAttempt(supabase, concurrentAttempt, intent, paymentMethod);
        if (concurrentResponse) return concurrentResponse;
        throw new Error("CHECKOUT_RESTART_REQUIRED");
      }
      transaction = await getWompiTransaction(createdTransaction.id);
    } else {
      if (!wompi.transactionId) throw new Error("TRANSACTION_REQUIRED");
      transactionDispatchStarted = true;
      transaction = await getWompiTransaction(wompi.transactionId);
      verifyTransaction(transaction, intent, wompi.transactionId);
      activeTransactionId = wompi.transactionId;
      activeProviderStatus = transaction.status.toLowerCase();
      const { data: savedTransaction, error: transactionSaveError } = await supabase
        .from("payment_attempts")
        .update({
          state: "pending",
          wompi_transaction_id: wompi.transactionId,
          provider_status: activeProviderStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", attempt.id)
        .eq("state", "dispatching")
        .select("id")
        .maybeSingle();
      if (transactionSaveError) throw transactionSaveError;
      if (!savedTransaction) {
        const concurrentAttempt = await loadPaymentAttempt(supabase, intent.id);
        const concurrentResponse = await responseForExistingAttempt(supabase, concurrentAttempt, intent, paymentMethod);
        if (concurrentResponse) return concurrentResponse;
        throw new Error("CHECKOUT_RESTART_REQUIRED");
      }
      paymentSourceId = transaction.paymentSourceId ?? null;
    }

    return finalizeVerifiedTransaction(supabase, {
      attemptId: attempt.id,
      intent,
      paymentMethod,
      transaction,
      paymentSourceId,
    });
  } catch (error) {
    if (activeAttemptId && attemptClaimedByRequest) {
      const state = transactionDispatchStarted ? "unknown" : "failed";
      const failureUpdate = supabase.from("payment_attempts").update({
        state,
        // A failed marker write may have committed, but no POST was invoked yet.
        ...(!transactionDispatchStarted ? { dispatched_at: null } : {}),
        ...(activeTransactionId ? { wompi_transaction_id: activeTransactionId } : {}),
        ...(activeProviderStatus ? { provider_status: activeProviderStatus } : {}),
        error_code: error instanceof Error ? error.message.split(":")[0].slice(0, 80) : "UNKNOWN",
        updated_at: new Date().toISOString(),
      }).eq("id", activeAttemptId).in("state", ["prepared", "dispatching", "pending"]);
      await (transactionDispatchStarted ? failureUpdate
        : failureUpdate.eq("state", "dispatching").is("wompi_transaction_id", null));
    }
    if (activeIntentId && intentProcessingClaimed) {
      await supabase.from("checkout_intents").update({
        state: transactionDispatchStarted ? "processing" : "failed",
        updated_at: new Date().toISOString(),
      }).eq("id", activeIntentId).eq("state", "processing");
    }
    logDonationError(stage, wompi?.reference ?? null, error);
    const publicCode = safeDonationErrorCode(error, stage, transactionDispatchStarted);
    return NextResponse.json(
      {
        message: publicCode === "reconciliation_required"
          ? "El pago fue enviado a Wompi y estamos conciliando su resultado. No inicies otro cobro."
          : safeDonationError(error),
        code: publicCode,
        ...(publicCode === "reconciliation_required" && activeTransactionId
          ? { transactionId: activeTransactionId }
          : {}),
      },
      { status: error instanceof Error && error.message.includes("RATE_LIMIT") ? 429 : 400 }
    );
  }
}
