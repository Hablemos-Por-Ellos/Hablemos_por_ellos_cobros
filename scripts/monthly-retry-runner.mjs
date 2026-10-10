import { assertBillingJobRuntime, getBillingWompiEnvironment } from "./billing-job-mode.mjs";
import { canStartAuthorizedSend, classifyAutomaticRetry, verifiedCardSourceMatches,
  verifiedSnapshotMatches, parseVerifiedFinalizedAt, VERIFIED_INSUFFICIENT_FUNDS_MESSAGE } from "./billing-retry-policy.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const UNRESOLVED = new Set(["dispatching", "pending", "unknown"]);
const PREFERRED_DAYS = new Set([1, 6, 16, 28]);

function operationalFailure() {
  return new Error("BILLING_JOB_OPERATIONAL_FAILURE");
}

async function rpc(supabase, name, args) {
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error || data == null) throw operationalFailure();
    return data;
  } catch { throw operationalFailure(); }
}

// Read every page before mutation: reconciliation can remove rows from an offset-filtered result.
async function readPages(queryFactory) {
  const rows = [];
  const ids = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await queryFactory().order("id", { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error || !Array.isArray(data) || data.length > PAGE_SIZE) throw operationalFailure();
    for (const row of data) {
      if (!row || typeof row.id !== "string" || ids.has(row.id)) throw operationalFailure();
      ids.add(row.id);
      rows.push(row);
    }
    if (data.length < PAGE_SIZE) return rows;
  }
  throw operationalFailure();
}

function attemptCycleId(attempt) {
  return attempt.cycle_id ?? attempt.billing_cycle_id ?? null;
}

function financialSnapshot(value) {
  return typeof value?.reference === "string" && value.reference.length > 0
    && Number.isSafeInteger(value.amount) && value.amount >= 1500 && value.amount <= 21_474_836
    && value.currency === "COP" && typeof value.paymentSourceId === "string" && value.paymentSourceId.length > 0;
}

function dispatchSnapshot(value) {
  return financialSnapshot(value) && typeof value.attemptId === "string" && value.attemptId.length > 0
    && typeof value.cycleId === "string" && value.cycleId.length > 0
    && typeof value.subscriptionId === "string" && value.subscriptionId.length > 0
    && value.frequency === "monthly" && [1, 2].includes(value.attemptNumber)
    && Number.isSafeInteger(value.billingVersion) && value.billingVersion >= 0
    && PREFERRED_DAYS.has(value.preferredPaymentDay)
    && typeof value.customerEmail === "string" && value.customerEmail.length > 0;
}

function immutableMatches(left, right) {
  return ["attemptId", "cycleId", "subscriptionId", "frequency", "attemptNumber", "reference", "amount",
    "currency", "paymentSourceId", "customerEmail", "preferredPaymentDay", "billingVersion", "retryEnabled"]
    .every((field) => left[field] === right[field]);
}

function unpackReservation(value) {
  if (!value?.dispatchSnapshot) return value;
  const snapshot = value.dispatchSnapshot;
  if (value.attempt?.id !== snapshot.attemptId || value.attempt?.reference !== snapshot.reference
    || value.attempt?.attempt_number !== snapshot.attemptNumber || value.attempt?.cycle_id !== snapshot.cycleId) {
    return { result: "invalid" };
  }
  return { ...snapshot, result: value.result };
}

function sourcePayload(source) {
  return { id: source.id, type: source.type, status: source.status,
    environment: source.environment === "production" ? "prod" : source.environment,
    verification_source: source.verificationSource ?? source.verifiedVia ?? source.verification_source,
    verified_at: source.verifiedAt ?? source.verified_at ?? null };
}

function storedSnapshot(attempt, cycle) {
  const snapshot = attempt.dispatch_snapshot ?? cycle?.snapshot ?? {};
  return {
    transactionId: attempt.wompi_transaction_id ?? null,
    reference: attempt.reference,
    amount: snapshot.amount ?? attempt.amount,
    currency: snapshot.currency ?? attempt.currency,
    paymentSourceId: snapshot.paymentSourceId ?? cycle?.payment_source_id ?? null,
    environment: snapshot.environment ?? cycle?.environment ?? null,
  };
}

function resultPayload(transaction, retry, source, now) {
  return {
    id: transaction.id, reference: transaction.reference, amount_in_cents: transaction.amountInCents,
    currency: transaction.currency, payment_source_id: transaction.paymentSourceId,
    payment_method_type: transaction.paymentMethodType ?? null, status: transaction.status,
    status_message: transaction.statusMessage ?? null,
    finalized_at: parseVerifiedFinalizedAt(transaction.finalizedAt, now)?.toISOString() ?? null,
    environment: transaction.environment === "production" ? "prod" : transaction.environment,
    verification_source: transaction.verificationSource ?? transaction.verifiedVia ?? transaction.verification_source,
    retry_classification: retry,
    payment_source_verification: source ? sourcePayload(source) : null,
  };
}

function needsReconciliation(attempt, cycle) {
  if (UNRESOLVED.has(attempt.state)) return true;
  if (!attempt.wompi_transaction_id) return false;
  return !attempt.verified_finalized_at || (cycle?.state === "retry_wait" && attempt.attempt_number === 1);
}

function calendarRequiresReview(subscription) {
  return !PREFERRED_DAYS.has(subscription.preferred_payment_day)
    || typeof subscription.next_payment_date !== "string"
    || !Number.isFinite(Date.parse(subscription.next_payment_date));
}

export async function runMonthlyRetryCharges({ mode, supabase, env = process.env, logger = console,
  getTransaction, getPaymentSource, prepareTransaction, clock = () => new Date() } = {}) {
  assertBillingJobRuntime(mode, env);
  const stats = { mode, due: 0, outstanding: 0, payments: 0, cycles: 0, retryQueued: 0, retriesDue: 0,
    originalsReserved: 0, retriesReserved: 0, sent: 0, approved: 0, charged: 0,
    reconciled: 0, repaired: 0, skippedPending: 0, blocked: 0, noIds: 0, schemaUnknown: 0, failed: 0,
    calendarReviewRequired: 0, legacyCalendars: 0 };
  const log = (action) => logger.log(`Monthly billing v040 action=${action}`);
  const fail = (action) => { stats.failed += 1; stats.blocked += 1; log(action); };
  const check = (operation = mode) => assertBillingJobRuntime(operation, env);
  const currentTime = () => {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw operationalFailure();
    return value;
  };
  const now = currentTime();
  let ready;
  try { ready = await rpc(supabase, "billing_retry_schema_ready"); }
  catch { throw new Error("BILLING_JOB_SCHEMA_NOT_READY"); }
  if (ready !== true) throw new Error("BILLING_JOB_SCHEMA_NOT_READY");
  check();

  let cycles;
  let attempts;
  let subscriptions;
  let payments;
  try {
    cycles = await readPages(() => supabase.from("billing_cycles").select("*"));
    attempts = await readPages(() => supabase.from("payment_attempts").select("*"));
    subscriptions = await readPages(() => supabase.from("subscriptions")
      .select("id,donor_id,reference,frequency,status,billing_version,next_payment_date,preferred_payment_day"));
    payments = await readPages(() => supabase.from("payments")
      .select("id,subscription_id,payment_attempt_id,wompi_transaction_id,reference,amount,currency,status,approved_at,provider_effective_at,billing_review_required"));
  } catch {
    fail("inventory_read_failed");
    return stats;
  }
  const cycleById = new Map(cycles.map((row) => [row.id, row]));
  const subscriptionById = new Map(subscriptions.map((row) => [row.id, row]));
  const activeMonthly = subscriptions.filter((row) => row.status === "active" && row.frequency === "monthly");
  stats.calendarReviewRequired = activeMonthly.filter(calendarRequiresReview).length;
  stats.legacyCalendars = activeMonthly.filter((row) => row.preferred_payment_day == null).length;
  const due = subscriptions.filter((row) => row.status === "active" && row.frequency === "monthly"
    && typeof row.next_payment_date === "string" && Number.isFinite(Date.parse(row.next_payment_date))
    && Date.parse(row.next_payment_date) <= now.getTime());
  const queued = cycles.filter((row) => row.state === "retry_wait");
  const outstanding = attempts.filter((row) => needsReconciliation(row, cycleById.get(attemptCycleId(row))));
  const unresolvedPayments = payments.filter((row) => row.status === "pending" || row.billing_review_required === true
    || (row.status === "approved" && !Number.isFinite(Date.parse(row.approved_at ?? row.provider_effective_at))));
  stats.cycles = cycles.length;
  stats.due = due.length;
  stats.retryQueued = queued.length;
  stats.retriesDue = queued.filter((row) => Date.parse(row.retry_window_start) <= now.getTime()
    && now.getTime() < Date.parse(row.retry_window_end)).length;
  stats.outstanding = outstanding.length;
  stats.payments = unresolvedPayments.length;
  if (mode === "inventory") {
    stats.noIds = outstanding.filter((row) => !row.wompi_transaction_id).length
      + unresolvedPayments.filter((row) => !row.wompi_transaction_id).length;
    stats.blocked = stats.noIds + stats.calendarReviewRequired;
    if (stats.calendarReviewRequired > 0) log("calendar_review_required");
    log("read_only_inventory");
    return stats;
  }
  const environment = getBillingWompiEnvironment(env);
  if (typeof getTransaction !== "function") throw operationalFailure();

  const apply = async (attempt, cycle, transaction) => {
    const expected = storedSnapshot(attempt, cycle);
    const legacy = attempt.cycle_id == null && attempt.attempt_number == null;
    const subscription = subscriptionById.get(attempt.subscription_id);
    if (legacy) {
      // Legacy attempts have no mandate/cycle. Record real GET results only; never infer retry consent.
      if (!verifiedSnapshotMatches({ transaction, expected, environment, allowMissingSource: true })) throw operationalFailure();
      const payload = resultPayload(transaction, { action: "manual_review", reason: "LEGACY_ORIGINAL_ONLY" }, null, currentTime());
      check("reconcile");
      const result = await rpc(supabase, "apply_verified_wompi_event", {
        p_event_key: ["billing-v040-legacy", transaction.id, transaction.status, payload.finalized_at ?? "unknown"].join(":"),
        p_transaction_id: transaction.id, p_event_type: "transaction.reconciled", p_reference: expected.reference,
        p_payment_source_id: transaction.paymentSourceId, p_amount: expected.amount, p_currency: expected.currency,
        p_status: transaction.status, p_effective_at: payload.finalized_at, p_candidate_next_payment: null,
        p_raw: { source: "monthly_job_v040_legacy", verification_source: "provider_get", environment,
          transaction: payload },
      });
      if (!["processed", "duplicate", "review"].includes(result?.result)) throw operationalFailure();
      if (result.result === "review") stats.blocked += 1;
      if (transaction.status === "pending") stats.skippedPending += 1;
      if (transaction.status === "approved" && attempt.state !== "approved" && result.result !== "duplicate") stats.approved += 1;
      return result;
    }
    if (!verifiedSnapshotMatches({ transaction, expected, environment,
      allowMissingSource: subscription?.frequency === "one_time" && attempt.attempt_number === 1 && !cycle })) throw operationalFailure();
    let source = null;
    if (cycle?.retry_enabled === true && attempt.attempt_number === 1 && transaction.status === "declined"
      && typeof transaction.statusMessage === "string"
      && transaction.statusMessage.normalize("NFKC").trim() === VERIFIED_INSUFFICIENT_FUNDS_MESSAGE
      && subscription?.frequency === "monthly" && typeof getPaymentSource === "function") {
      try {
        check("reconcile");
        source = await getPaymentSource({ paymentSourceId: expected.paymentSourceId });
        check("reconcile");
      } catch { fail("retry_source_verification_failed"); }
    }
    const retry = classifyAutomaticRetry({ frequency: subscription?.frequency,
      attemptNumber: attempt.attempt_number, retryAuthorized: cycle?.retry_enabled === true,
      authorizationRevoked: cycle?.authorization_revoked_at != null,
      transaction, expected, environment, source, now: currentTime() });
    check("reconcile");
    const result = await rpc(supabase, "billing_v2_apply_result", {
      p_attempt_id: attempt.id, p_transaction: resultPayload(transaction, retry, source, currentTime()),
    });
    if (!["processed", "duplicate", "review"].includes(result?.result)) throw operationalFailure();
    if (result.result === "review") { stats.blocked += 1; log("verified_result_needs_review"); }
    if (transaction.status === "pending") stats.skippedPending += 1;
    // Count newly persisted approvals, not repeated GETs of already-applied approvals.
    if (transaction.status === "approved" && attempt.state !== "approved" && result.result !== "duplicate") stats.approved += 1;
    return result;
  };

  const reconciledIds = new Set();
  for (const attempt of outstanding) {
    if (!attempt.wompi_transaction_id) {
      stats.noIds += 1;
      stats.blocked += 1;
      log("unresolved_without_transaction_id");
      continue;
    }
    try {
      check("reconcile");
      const transaction = await getTransaction({ transactionId: attempt.wompi_transaction_id });
      check("reconcile");
      await apply(attempt, cycleById.get(attemptCycleId(attempt)), transaction);
      reconciledIds.add(attempt.wompi_transaction_id);
      stats.reconciled += 1;
      log("transaction_reconciled");
    } catch { fail("transaction_reconciliation_failed"); }
  }
  const attemptsById = new Map(attempts.map((row) => [row.id, row]));
  for (const payment of unresolvedPayments) {
    if (reconciledIds.has(payment.wompi_transaction_id)) continue;
    if (!payment.wompi_transaction_id) {
      stats.noIds += 1;
      stats.blocked += 1;
      log("payment_without_transaction_id");
      continue;
    }
    try {
      check("reconcile");
      const transaction = await getTransaction({ transactionId: payment.wompi_transaction_id });
      check("reconcile");
      const linkedAttempt = attemptsById.get(payment.payment_attempt_id);
      if (linkedAttempt) {
        await apply(linkedAttempt, cycleById.get(attemptCycleId(linkedAttempt)), transaction);
        reconciledIds.add(payment.wompi_transaction_id);
        stats.reconciled += 1;
        log("linked_payment_reconciled");
        continue;
      }
      let reference = payment.reference;
      if (!reference) {
        const subscription = subscriptionById.get(payment.subscription_id);
        const base = subscription?.reference;
        const suffix = typeof transaction?.reference === "string" && typeof base === "string"
          ? transaction.reference.slice(base.length + 1) : "";
        if (!base || (transaction.reference !== base && (subscription.frequency !== "monthly"
          || !transaction.reference.startsWith(base + "-") || !/^\d{4}(?:0[1-9]|1[0-2])$/.test(suffix)))) throw operationalFailure();
        reference = transaction.reference;
      }
      await apply({ ...payment, state: payment.status, reference, cycle_id: null, attempt_number: null }, null, transaction);
      reconciledIds.add(payment.wompi_transaction_id);
      stats.reconciled += 1;
      log("historical_payment_reconciled");
    } catch { fail("historical_payment_reconciliation_failed"); }
  }
  // Neither housekeeping operation reserves an attempt. The database validates its own clock and version.
  for (const cycle of queued) {
    if (!Number.isFinite(Date.parse(cycle.retry_window_end)) || currentTime().getTime() < Date.parse(cycle.retry_window_end)) continue;
    try {
      check("reconcile");
      const expired = await rpc(supabase, "billing_v2_expire_retry", { p_cycle_id: cycle.id });
      if (!["expired", "unchanged", "protected"].includes(expired?.result)) throw operationalFailure();
      if (expired.result === "expired") { stats.blocked += 1; log("retry_window_expired"); }
    } catch { fail("retry_expiration_failed"); }
  }
  const repaired = new Set();
  for (const subscription of due) {
    try {
      if (!Number.isSafeInteger(subscription.billing_version) || subscription.billing_version < 0) throw operationalFailure();
      check("reconcile");
      const result = await rpc(supabase, "billing_v2_repair_schedule", {
        p_subscription_id: subscription.id, p_expected_version: subscription.billing_version,
      });
      if (!["repaired", "changed", "unchanged", "blocked", "protected", "review"].includes(result?.result)) throw operationalFailure();
      if (result.result !== "unchanged") repaired.add(subscription.id);
      if (["repaired", "changed"].includes(result.result)) { stats.reconciled += 1; stats.repaired += 1; log("schedule_repaired"); }
      if (["blocked", "protected", "review"].includes(result.result)) stats.blocked += 1;
    } catch { fail("schedule_repair_failed"); repaired.add(subscription.id); }
  }
  if (mode !== "charge" || stats.failed > 0) return stats;
  if (typeof getPaymentSource !== "function" || typeof prepareTransaction !== "function") throw operationalFailure();

  const markUncertain = async (attemptId) => {
    try {
      check("reconcile");
      const result = await rpc(supabase, "billing_v2_mark_uncertain", { p_attempt_id: attemptId });
      if (!["reconcile", "unknown", "unchanged", "protected"].includes(result?.result)) throw operationalFailure();
    } catch { fail("uncertain_state_persistence_failed"); }
  };

  const dispatch = async (reservation) => {
    reservation = unpackReservation(reservation);
    if (["blocked", "review", "closed", "not_due", "legacy_requires_reconciliation"].includes(reservation?.result)) {
      stats.blocked += 1;
      log("reservation_blocked");
      return;
    }
    if (!["reserved", "existing"].includes(reservation?.result) || !dispatchSnapshot(reservation)
      || (reservation.environment != null && reservation.environment !== environment)) {
      fail("reservation_snapshot_invalid");
      return;
    }
    const snapshot = Object.freeze({ ...reservation });
    let authorized = false;
    let barrierRequested = false;
    let sendStarted = false;
    let persisted = false;
    let transactionId = null;
    try {
      check();
      const source = await getPaymentSource({ paymentSourceId: snapshot.paymentSourceId });
      check();
      if (!verifiedCardSourceMatches({ source, paymentSourceId: snapshot.paymentSourceId, environment, now: currentTime() })) {
        throw operationalFailure();
      }
      const prepared = await prepareTransaction({ reference: snapshot.reference, amountInCents: snapshot.amount * 100,
        currency: snapshot.currency, paymentSourceId: snapshot.paymentSourceId, customerEmail: snapshot.customerEmail });
      check();
      if (typeof prepared?.send !== "function") throw operationalFailure();
      // GETs and serialization finish before this durable barrier. Nothing after it is assumed unsent.
      barrierRequested = true;
      const authorization = await rpc(supabase, "billing_v2_authorize_send", {
        p_attempt_id: snapshot.attemptId, p_source_verification: sourcePayload(source),
      });
      authorized = authorization?.canDispatch === true;
      if (!authorized) {
        if (authorization?.canDispatch !== false) throw operationalFailure();
        barrierRequested = false;
        stats.blocked += 1;
        log("send_authorization_denied");
        return;
      }
      const startGuard = () => {
        check();
        if (!dispatchSnapshot(authorization) || !immutableMatches(snapshot, authorization)
          || !canStartAuthorizedSend({ sendAuthorizedAt: authorization.sendAuthorizedAt,
            windowEnd: authorization.windowEnd, now: currentTime() })) throw operationalFailure();
      };
      startGuard();
      const onDispatched = async ({ id, status }) => {
        if (typeof id !== "string" || !id || transactionId || !sendStarted) throw operationalFailure();
        transactionId = id;
        check("reconcile");
        const recorded = await rpc(supabase, "billing_v2_record_dispatch", {
          p_attempt_id: snapshot.attemptId, p_transaction_id: id, p_status: status,
        });
        if (!["recorded", "existing", "duplicate"].includes(recorded?.result)) throw operationalFailure();
        persisted = true;
      };
      const created = await prepared.send({ onSending: () => {
        if (sendStarted) throw operationalFailure();
        startGuard();
        sendStarted = true;
        stats.sent += 1;
        stats.charged = stats.sent;
      }, onDispatched });
      if (!sendStarted) throw operationalFailure();
      if (!persisted) await onDispatched({ id: created?.id, status: created?.status });
      check("reconcile");
      const verified = await getTransaction({ transactionId });
      check("reconcile");
      const attempt = { id: snapshot.attemptId, subscription_id: snapshot.subscriptionId,
        cycle_id: snapshot.cycleId, attempt_number: snapshot.attemptNumber, wompi_transaction_id: transactionId, reference: snapshot.reference,
        amount: snapshot.amount, currency: snapshot.currency, dispatch_snapshot: snapshot };
      const cycle = { ...cycleById.get(snapshot.cycleId) };
      if (typeof snapshot.retryEnabled === "boolean") cycle.retry_enabled = snapshot.retryEnabled;
      await apply(attempt, cycle, verified);
      log("transaction_sent_and_verified");
    } catch {
      if (barrierRequested) await markUncertain(snapshot.attemptId);
      fail(barrierRequested ? "authorized_send_uncertain" : "prepared_send_not_started");
    }
  };

  // Re-read after results: an original declined during reconciliation can schedule today's retry.
  let retryCycles;
  try { retryCycles = await readPages(() => supabase.from("billing_cycles").select("*").eq("state", "retry_wait")); }
  catch { fail("retry_queue_read_failed"); return stats; }
  for (const cycle of retryCycles) cycleById.set(cycle.id, cycle);
  for (const cycle of retryCycles) {
    if (stats.failed > 0) break;
    try {
      check();
      const reservation = await rpc(supabase, "billing_v2_reserve_retry", { p_cycle_id: cycle.id });
      if (["reserved", "existing"].includes(reservation?.result)) stats.retriesReserved += 1;
      await dispatch(reservation);
    } catch { fail("retry_reservation_failed"); }
  }
  for (const subscription of due) {
    if (stats.failed > 0) break;
    if (repaired.has(subscription.id)) continue;
    if (!Number.isSafeInteger(subscription.billing_version) || subscription.billing_version < 0) {
      fail("subscription_version_invalid");
      continue;
    }
    try {
      check();
      const reservation = await rpc(supabase, "billing_v2_reserve_original", {
        p_subscription_id: subscription.id, p_expected_version: subscription.billing_version,
      });
      if (["reserved", "existing"].includes(reservation?.result)) stats.originalsReserved += 1;
      await dispatch(reservation);
    } catch { fail("original_reservation_failed"); }
  }
  return stats;
}
