import { assertBillingJobOperations, billingJobErrorCode } from "./billing-job-mode.mjs";

const PREFERRED_PAYMENT_DAYS = [1, 6, 16, 28];
const SUPPORTED_WOMPI_STATUSES = new Set(["approved", "pending", "declined", "error", "voided"]);
const UNRESOLVED_STATES = ["dispatching", "pending", "unknown"];
const PAYMENT_REVIEW_FILTER = "status.in.(approved,pending),billing_review_required.eq.true";
const PAGE_SIZE = 100;

function getColombiaCalendarDate(date) {
  return new Date(date.getTime() - 5 * 60 * 60 * 1000);
}

export function getColombiaBillingMonthRange(date) {
  const colombiaDate = getColombiaCalendarDate(date);
  const year = colombiaDate.getUTCFullYear();
  const month = colombiaDate.getUTCMonth();
  return {
    periodKey: String(year) + String(month + 1).padStart(2, "0"),
    startIso: new Date(Date.UTC(year, month, 1, 5)).toISOString(),
    endIso: new Date(Date.UTC(year, month + 1, 1, 5)).toISOString(),
  };
}

export function getNextMonthlyPaymentDate(base, preferredPaymentDay) {
  const date = getColombiaCalendarDate(base);
  const month = date.getUTCMonth() + 1;
  const day = PREFERRED_PAYMENT_DAYS.includes(preferredPaymentDay)
    ? preferredPaymentDay
    : Math.min(date.getUTCDate(), new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(date.getUTCFullYear(), month, day, 12));
}

function parseDate(value) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function readPages(queryFactory, { legacyPaymentReview = false } = {}) {
  const rows = [];
  // Collect every page before mutating rows so offset pagination cannot skip resolved rows.
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await queryFactory()
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      if (legacyPaymentReview && ["42703", "PGRST204"].includes(error.code)
        && /\bbilling_review_required\b/.test(String(error.message ?? ""))) {
        throw new Error("BILLING_JOB_LEGACY_PAYMENT_REVIEW_UNAVAILABLE");
      }
      throw new Error(["42P01", "PGRST205"].includes(error.code)
        ? "BILLING_JOB_LEGACY_TABLE_UNAVAILABLE" : "BILLING_JOB_OPERATIONAL_FAILURE");
    }
    if (!Array.isArray(data)) throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

function needsReview(attempt) {
  const reconciledTerminalFailure = attempt.state === "failed"
    && ["error", "voided"].includes(attempt.provider_status)
    && typeof attempt.wompi_transaction_id === "string" && attempt.wompi_transaction_id.trim().length > 0
    && parseDate(attempt.completed_at) !== null;
  return UNRESOLVED_STATES.includes(attempt.state)
    || (attempt.state === "failed" && !reconciledTerminalFailure
      && Boolean(attempt.dispatched_at || attempt.wompi_transaction_id));
}

function snapshot(row) {
  const immutable = row.dispatch_snapshot ?? {};
  return {
    expectedReference: immutable.reference ?? row.reference,
    expectedAmount: Number(immutable.amount ?? row.amount),
    expectedCurrency: immutable.currency ?? row.currency,
    expectedPaymentSourceId: immutable.paymentSourceId ?? row.payment_source_id ?? null,
    preferredPaymentDay: immutable.preferredPaymentDay ?? row.preferred_payment_day ?? null,
  };
}

function validFinancialSnapshot(value) {
  return Number.isInteger(value.expectedAmount) && value.expectedAmount >= 1500
    && value.expectedAmount <= 21474836 && value.expectedCurrency === "COP";
}

function validSnapshot(value) {
  return typeof value.expectedReference === "string" && value.expectedReference.length > 0
    && validFinancialSnapshot(value);
}

function matchesReferenceFamily(reference, base) {
  if (typeof reference !== "string" || typeof base !== "string" || !base) return false;
  if (reference === base) return true;
  const period = reference.slice(base.length + 1);
  return reference.startsWith(base + "-") && period.length === 6 && /^\d{4}(?:0[1-9]|1[0-2])$/.test(period);
}

async function applyVerifiedTransaction({ supabase, transaction, expectedTransactionId,
  expectedSubscriptionId, expectedReference, expectedAmount, expectedCurrency,
  expectedPaymentSourceId = null, preferredPaymentDay = null, legacyProof = null }) {
  const transactionId = String(transaction?.id ?? "");
  const status = String(transaction?.status ?? "").toLowerCase();
  if (!transactionId || !SUPPORTED_WOMPI_STATUSES.has(status)) {
    const error = new Error("UNSUPPORTED_WOMPI_STATUS");
    error.code = "UNSUPPORTED_WOMPI_STATUS";
    throw error;
  }
  if (!validSnapshot({ expectedReference, expectedAmount, expectedCurrency })
    || transactionId !== String(expectedTransactionId)
    || transaction.reference !== expectedReference
    || Number(transaction.amountInCents) !== expectedAmount * 100
    || transaction.currency !== expectedCurrency
    || (expectedPaymentSourceId != null
      && String(transaction.paymentSourceId ?? "") !== String(expectedPaymentSourceId))) {
    throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
  }
  const effectiveAt = parseDate(transaction.finalizedAt);
  const candidate = !legacyProof && status === "approved" && effectiveAt
    ? getNextMonthlyPaymentDate(effectiveAt, preferredPaymentDay) : null;
  const { data, error } = await supabase.rpc("apply_verified_wompi_event", {
    p_event_key: ["monthly-job", transactionId, status, effectiveAt?.toISOString() ?? "unknown"].join(":"),
    p_transaction_id: transactionId,
    p_event_type: "transaction.reconciled",
    p_reference: expectedReference,
    p_payment_source_id: transaction.paymentSourceId == null ? null : String(transaction.paymentSourceId),
    p_amount: expectedAmount,
    p_currency: expectedCurrency,
    p_status: status,
    p_effective_at: effectiveAt?.toISOString() ?? null,
    p_candidate_next_payment: candidate?.toISOString() ?? null,
    p_raw: { source: "monthly_job", transaction: {
      id: transactionId, reference: transaction.reference,
      amount_in_cents: Number(transaction.amountInCents), currency: transaction.currency,
      status, finalized_at: transaction.finalizedAt ?? null,
    },
      ...(legacyProof ? { legacy_reconciliation: legacyProof } : {}) },
  });
  const reviewRequired = data?.result === "review" || data?.processingState === "needs_review";
  if (error || !["processed", "duplicate", "review"].includes(data?.result)
    || (expectedSubscriptionId && data.subscriptionId !== expectedSubscriptionId
      && (!reviewRequired || data.subscriptionId != null))) {
    throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
  }
  return { transactionId, status, effectiveAt, reviewRequired,
    blocked: reviewRequired || (status === "approved" && !effectiveAt) };
}

export async function runMonthlyCharges({ mode, now = new Date(), supabase, createTransaction,
  getTransaction, logger = console, env = process.env } = {}) {
  assertBillingJobOperations(mode, env);
  if (mode !== "inventory") {
    try {
      const { data, error } = await supabase.rpc("payment_admin_schema_ready");
      if (error || data !== true) throw new Error("BILLING_JOB_SCHEMA_NOT_READY");
    } catch { throw new Error("BILLING_JOB_SCHEMA_NOT_READY"); }
  }
  const nowIso = now.toISOString();
  const billingMonth = getColombiaBillingMonthRange(now);
  const stats = { mode, due: 0, outstanding: 0, payments: 0, charged: 0, skippedPending: 0,
    reconciled: 0, blocked: 0, noIds: 0, schemaUnknown: 0, failed: 0, duplicateCheckFailures: 0, auditFailures: 0 };
  const blockedSubscriptions = new Set();
  const seen = new Set();
  // Never log provider/database messages, identifiers or arbitrary error strings.
  const log = (action) => logger.log("Monthly billing mode=" + mode + " action=" + action);
  const audit = async (action, subscriptionId, details = {}) => {
    try {
      const { error } = await supabase.from("audit_logs").insert({ action,
        subscription_id: subscriptionId, details: { billingPeriod: billingMonth.periodKey, ...details } });
      if (error) throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
    } catch {
      stats.auditFailures += 1;
      log("audit_failed");
    }
  };
  const fail = async (action, subId, details = {}) => {
    stats.failed += 1;
    stats.blocked += 1;
    if (subId) blockedSubscriptions.add(subId);
    log(action);
    if (mode !== "inventory") await audit(action, subId, details);
  };

  let attempts = [];
  let dueSubs = [];
  let payments = [];
  let scansComplete = true;
  let paymentsComplete = true;
  try {
    attempts = await readPages(() => supabase.from("payment_attempts")
      .select(mode === "inventory" ? "*" : "*, subscription:subscription_id(id,preferred_payment_day)")
      .in("state", [...UNRESOLVED_STATES, "failed"]));
  } catch (error) {
    scansComplete = false;
    if (mode === "inventory" && error.message === "BILLING_JOB_LEGACY_TABLE_UNAVAILABLE") {
      stats.schemaUnknown += 1;
      stats.blocked += 1;
      log("legacy_attempts_unavailable");
    } else {
      stats.failed += 1;
      log("outstanding_attempt_query_failed");
    }
  }
  try {
    dueSubs = await readPages(() => supabase.from("subscriptions")
      .select(mode === "inventory" ? "*"
        : "id, created_at, amount, currency, next_payment_date, wompi_payment_source_id, reference, preferred_payment_day, billing_version, donor:donor_id(id,email)")
      .eq("status", "active").eq("frequency", "monthly")
      .not("next_payment_date", "is", null).lte("next_payment_date", nowIso));
  } catch {
    scansComplete = false;
    stats.failed += 1;
    log("due_query_failed");
  }
  try {
    try {
      payments = await readPages(() => supabase.from("payments").select("*").or(PAYMENT_REVIEW_FILTER),
        { legacyPaymentReview: mode === "inventory" });
    } catch (error) {
      if (mode !== "inventory" || error.message !== "BILLING_JOB_LEGACY_PAYMENT_REVIEW_UNAVAILABLE") throw error;
      // Legacy inspection is incomplete, never permission to reconcile or charge.
      stats.schemaUnknown += 1;
      stats.blocked += 1;
      scansComplete = false;
      log("legacy_payment_review_unavailable");
      payments = await readPages(() => supabase.from("payments").select("*").in("status", ["approved", "pending"]));
    }
  } catch {
    scansComplete = false;
    paymentsComplete = false;
    stats.duplicateCheckFailures += 1;
    log("payment_query_failed");
    if (mode !== "inventory") await audit("monthly_charge_duplicate_check_failed", null);
  }
  stats.due = dueSubs.length;
  stats.outstanding = attempts.filter(needsReview).length;
  stats.payments = payments.length;

  const reconcile = async (row, subscriptionId, preferredPaymentDay, historicalPayment = false) => {
    const id = row.wompi_transaction_id;
    if (seen.has(String(id))) return;
    seen.add(String(id));
    if (typeof getTransaction !== "function") {
      await fail("transaction_lookup_unavailable", subscriptionId);
      return;
    }
    try {
      const historical = snapshot(row);
      const missingReference = historical.expectedReference == null || historical.expectedReference === "";
      const legacyRecovery = historicalPayment && row.payment_attempt_id == null
        && (missingReference || row.billing_review_required === true);
      let storedSubscription = null;
      if (legacyRecovery) {
        if (!validFinancialSnapshot(historical)
          || typeof row.id !== "string" || !row.id
          || typeof subscriptionId !== "string" || !subscriptionId) {
          throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
        }
        // Legacy proof comes from a stored subscription, including cancelled/not-due rows.
        const { data, error } = await supabase.from("subscriptions").select("id, reference")
          .eq("id", subscriptionId).maybeSingle();
        if (error || data?.id !== subscriptionId || typeof data.reference !== "string" || !data.reference) {
          throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
        }
        storedSubscription = data;
      } else if (!validSnapshot(historical)) {
        throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
      }
      const transaction = await getTransaction({ transactionId: id });
      let legacyProof = null;
      if (storedSubscription) {
        if (!matchesReferenceFamily(transaction?.reference, storedSubscription.reference)) {
          throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
        }
        if (missingReference) historical.expectedReference = transaction.reference;
        legacyProof = { payment_id: row.id, subscription_id: storedSubscription.id,
          subscription_reference: storedSubscription.reference, verified_transaction_id: String(id),
          verification_source: "provider_get" };
      }
      const applied = await applyVerifiedTransaction({ supabase, transaction,
        expectedTransactionId: id, expectedSubscriptionId: subscriptionId,
        ...historical, preferredPaymentDay: historical.preferredPaymentDay ?? preferredPaymentDay, legacyProof });
      if (applied.blocked) {
        await fail(applied.reviewRequired ? "verified_transaction_needs_review" : "approved_effective_date_unknown", subscriptionId);
      } else if (applied.status === "pending") {
        stats.skippedPending += 1;
        stats.blocked += 1;
      } else {
        stats.reconciled += 1;
      }
      log("transaction_reconciled");
    } catch {
      await fail("transaction_reconcile_failed", subscriptionId);
    }
  };

  for (const attempt of attempts.filter(needsReview)) {
    const subId = attempt.subscription_id;
    if (subId) blockedSubscriptions.add(subId);
    if (!attempt.wompi_transaction_id) {
      stats.noIds += 1;
      if (mode !== "inventory") {
        try {
          const { error } = await supabase.from("payment_attempts")
            .update({ state: "unknown", error_code: "MISSING_TRANSACTION_ID", updated_at: nowIso })
            .eq("id", attempt.id).eq("state", attempt.state).is("wompi_transaction_id", null);
          if (error) throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
        } catch {
          stats.failed += 1;
          log("missing_id_guard_persist_failed");
        }
      }
      await fail(attempt.state === "failed" ? "monthly_charge_failed_attempt_requires_review"
        : attempt.billing_period !== billingMonth.periodKey ? "monthly_charge_blocked_unresolved_attempt"
          : "monthly_charge_unresolved_without_transaction_id", subId);
    } else if (mode !== "inventory") {
      await reconcile(attempt, subId, attempt.subscription?.preferred_payment_day ?? null);
    } else {
      stats.blocked += 1;
    }
  }

  for (const payment of payments) {
    const approvedUnknown = payment.status === "approved"
      && (!parseDate(payment.approved_at) || payment.billing_review_required === true);
    if (payment.status !== "pending" && !approvedUnknown && payment.billing_review_required !== true) continue;
    if (payment.subscription_id) blockedSubscriptions.add(payment.subscription_id);
    if (!payment.wompi_transaction_id) {
      stats.noIds += 1;
      stats.blocked += 1;
      if (payment.status === "pending") stats.skippedPending += 1;
      else stats.failed += 1;
      log("payment_without_transaction_id");
    } else if (mode !== "inventory") {
      await reconcile(payment, payment.subscription_id,
        dueSubs.find((sub) => sub.id === payment.subscription_id)?.preferred_payment_day ?? null, true);
    } else {
      stats.blocked += 1;
    }
  }
  if (mode === "inventory") return stats;

  for (const sub of dueSubs) {
    if (!paymentsComplete || blockedSubscriptions.has(sub.id)) continue;
    try {
      const paymentRows = await readPages(() => supabase.from("payments").select("*")
        .eq("subscription_id", sub.id).or(PAYMENT_REVIEW_FILTER));
      if (paymentRows.some((payment) => payment.status === "pending"
        || payment.billing_review_required === true
        || (payment.status === "approved" && !parseDate(payment.approved_at)))) {
        await fail("payment_period_unknown_or_pending", sub.id);
        continue;
      }
      const latest = paymentRows.filter((payment) => payment.status === "approved")
        .sort((left, right) => parseDate(right.approved_at) - parseDate(left.approved_at))[0];
      if (latest) {
        const effective = parseDate(latest.approved_at);
        const candidate = getNextMonthlyPaymentDate(effective, sub.preferred_payment_day);
        const current = parseDate(sub.next_payment_date);
        if (!current || candidate > current) {
          if (!Number.isInteger(sub.billing_version) || sub.billing_version < 0) {
            await fail("billing_version_invalid", sub.id);
            continue;
          }
          const { data, error } = await supabase.rpc("advance_subscription_schedule", {
            p_subscription_id: sub.id, p_expected_version: sub.billing_version, p_candidate: candidate.toISOString(),
          });
          if (error || !["changed", "unchanged", "protected"].includes(data?.result)) {
            await fail("schedule_reconcile_failed", sub.id);
          } else if (data.result === "changed") {
            stats.reconciled += 1;
            await audit("monthly_charge_schedule_reconciled", sub.id);
          }
          continue;
        }
        if (getColombiaBillingMonthRange(effective).periodKey >= billingMonth.periodKey) {
          stats.blocked += 1;
          log("approved_current_period");
          continue;
        }
      }
    } catch {
      stats.duplicateCheckFailures += 1;
      blockedSubscriptions.add(sub.id);
      await audit("monthly_charge_duplicate_check_failed", sub.id);
      log("duplicate_check_failed");
      continue;
    }
    if (mode !== "charge" || !scansComplete) continue;
    try {
      const { data: existing, error } = await supabase.from("payment_attempts").select("*")
        .eq("subscription_id", sub.id).eq("billing_period", billingMonth.periodKey).maybeSingle();
      if (error) { await fail("attempt_lookup_failed", sub.id); continue; }
      if (existing && (existing.wompi_transaction_id || existing.dispatched_at
        || !["prepared", "failed"].includes(existing.state))) {
        await fail("attempt_requires_review", sub.id);
        continue;
      }
      if (!sub.wompi_payment_source_id) {
        await fail("monthly_charge_missing_payment_source", sub.id);
        continue;
      }
      if (!Number.isInteger(sub.billing_version) || sub.billing_version < 0
        || typeof createTransaction !== "function") {
        await fail("billing_configuration_invalid", sub.id);
        continue;
      }
      const reference = sub.reference ? sub.reference + "-" + billingMonth.periodKey : "SUB-" + sub.id + "-" + billingMonth.periodKey;
      let attempt = existing;
      if (!attempt) {
        const { data, error } = await supabase.from("payment_attempts").insert({
          donor_id: sub.donor?.id ?? null, subscription_id: sub.id, billing_period: billingMonth.periodKey,
          reference, amount: Number(sub.amount), currency: sub.currency,
          subscription_version: sub.billing_version, state: "prepared",
        }).select("*").single();
        if (error || !data) { await fail("attempt_reserve_failed", sub.id); continue; }
        attempt = data;
      }
      assertBillingJobOperations(mode, env);
      const { data: claim, error: claimError } = await supabase.rpc("claim_monthly_payment_attempt", {
        p_attempt_id: attempt.id, p_now: nowIso,
      });
      if (claimError) { await fail("attempt_claim_failed", sub.id); continue; }
      if (claim?.result !== "claimed") {
        if (["DONOR_HAS_UNRESOLVED_ATTEMPT", "INVALID_BILLING_PERIOD", "SUBSCRIPTION_NOT_FOUND"].includes(claim?.reason)) {
          await fail("monthly_charge_claim_blocked", sub.id);
        } else { stats.skippedPending += 1; stats.blocked += 1; log("attempt_not_claimed"); }
        continue;
      }
      // Both dispatch and finalization use the immutable claim, not the earlier subscription.
      const claimed = Object.freeze({ expectedReference: claim.reference, expectedAmount: Number(claim.amount),
        expectedCurrency: claim.currency, expectedPaymentSourceId: claim.paymentSourceId,
        preferredPaymentDay: claim.preferredPaymentDay, customerEmail: claim.customerEmail });
      if (claim.attemptId !== attempt.id || claim.subscriptionId !== sub.id
        || !Number.isInteger(claim.billingVersion) || claim.billingVersion < 0
        || !validSnapshot(claimed) || claim.reference !== attempt.reference
        || !claimed.customerEmail || !claimed.expectedPaymentSourceId) {
        const { error } = await supabase.from("payment_attempts")
          .update({ state: "unknown", error_code: "INVALID_CLAIM_RESPONSE", updated_at: nowIso })
          .eq("id", attempt.id).eq("state", "dispatching");
        if (error) stats.failed += 1;
        await fail("monthly_charge_invalid_claim_response", sub.id);
        continue;
      }
      let transactionId = null;
      let providerStatus = null;
      let persisted = false;
      let sendStarted = false;
      const persistDispatch = async ({ id, status }) => {
        if (!id) throw new Error("POST_DISPATCH_UNKNOWN");
        transactionId = String(id);
        providerStatus = SUPPORTED_WOMPI_STATUSES.has(String(status).toLowerCase()) ? String(status).toLowerCase() : null;
        const { error } = await supabase.from("payment_attempts").update({
          state: "pending", wompi_transaction_id: transactionId, provider_status: providerStatus,
          error_code: null, updated_at: nowIso,
        }).eq("id", attempt.id).in("state", ["dispatching", "pending"]);
        if (error) throw new Error("POST_DISPATCH_UNKNOWN");
        persisted = true;
      };
      try {
        assertBillingJobOperations(mode, env);
        const transaction = await createTransaction({ reference: claimed.expectedReference,
          amountInCents: claimed.expectedAmount * 100, currency: claimed.expectedCurrency,
          customerEmail: claimed.customerEmail, paymentSourceId: claimed.expectedPaymentSourceId,
          onSending: () => { sendStarted = true; }, onDispatched: persistDispatch });
        if (!persisted) await persistDispatch(transaction);
        const applied = await applyVerifiedTransaction({ supabase, transaction,
          expectedTransactionId: transactionId, expectedSubscriptionId: sub.id, ...claimed });
        stats.charged += 1;
        if (applied.blocked) await fail(applied.reviewRequired
          ? "verified_transaction_needs_review" : "approved_effective_date_unknown", sub.id);
        await audit("monthly_charge_created", sub.id, { status: applied.status });
        log("charge_created");
      } catch (error) {
        transactionId = transactionId || (error?.transactionId ? String(error.transactionId) : null);
        const safeToRetry = !sendStarted && !transactionId && error?.safeToRetry === true;
        const failure = safeToRetry
          ? { state: "prepared", dispatched_at: null, error_code: "PRE_DISPATCH_FAILURE", updated_at: nowIso }
          : { state: "unknown", ...(transactionId ? { wompi_transaction_id: transactionId } : {}),
            ...(providerStatus ? { provider_status: providerStatus } : {}),
            error_code: billingJobErrorCode(error), updated_at: nowIso };
        try {
          const { error } = await supabase.from("payment_attempts").update(failure)
            .eq("id", attempt.id).in("state", ["prepared", "dispatching", "pending"]);
          if (error) throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
        } catch { stats.failed += 1; log("failure_state_persist_failed"); }
        await fail("monthly_charge_failed", sub.id, { safeToRetry, hasTransactionId: Boolean(transactionId) });
      }
    } catch {
      await fail("subscription_processing_failed", sub.id);
    }
  }
  return stats;
}
