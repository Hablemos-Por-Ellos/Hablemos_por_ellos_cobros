import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getColombiaBillingMonthRange,
  getNextMonthlyPaymentDate,
  runMonthlyCharges,
} from "./monthly-charge-runner.mjs";

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("NETWORK_FORBIDDEN_IN_UNIT_TEST"); })));
afterEach(() => vi.unstubAllGlobals());

function dueSubscription(overrides = {}) {
  return {
    id: "sub-1",
    amount: 50000,
    currency: "COP",
    next_payment_date: "2026-06-16T12:00:00.000Z",
    wompi_payment_source_id: "source-1",
    reference: "HPE-TEST",
    preferred_payment_day: 16,
    billing_version: 0,
    status: "active",
    frequency: "monthly",
    created_at: "2026-01-01T00:00:00.000Z",
    donor: { id: "donor-1", email: "donante@example.com" },
    ...overrides,
  };
}

function wompiTransaction(overrides = {}) {
  return {
    id: "tx-1",
    status: "pending",
    reference: "HPE-TEST-202608",
    amountInCents: 5000000,
    currency: "COP",
    paymentSourceId: "source-1",
    createdAt: "2026-08-18T13:00:00.000Z",
    finalizedAt: null,
    ...overrides,
  };
}

function createSupabase({
  dueSubs = [dueSubscription()],
  subscriptionRows = dueSubs,
  payments = [],
  paymentsError = null,
  paymentReviewFilterError = null,
  updateError = null,
  attemptUpdateError = null,
  paymentAttempts: attemptRows = [],
  claimData,
  applyError = null,
  applyData,
  outstandingAttemptsError = null,
  schemaReady = true,
  schemaError = null,
  paymentErrors = {},
  attemptLookupError = null,
  subscriptionLookupError = null,
  beforePaymentFilter,
} = {}) {
  const updates = [];
  const inserts = [];
  const paymentUpdates = [];
  const audits = [];
  const subscriptionReads = [];
  const paymentFilters = [];
  const storedPayments = payments.map((payment) => ({ subscription_id: "sub-1",
    amount: 50000, currency: "COP", reference: "HPE-TEST-202608", ...payment }));
  const attempts = attemptRows.map((attempt) => ({ ...attempt }));

  const subscriptions = {
    select: (columns) => {
      let selected = [...subscriptionRows];
      const filters = [];
      const query = {
        eq(column, value) {
          filters.push(["eq", column, value]);
          selected = selected.filter((row) => row[column] === value);
          return query;
        },
        not(column, operator, value) {
          selected = selected.filter((row) => operator !== "is" || (row[column] ?? null) !== value);
          return query;
        },
        lte(column, value) {
          selected = selected.filter((row) => new Date(row[column]) <= new Date(value));
          return query;
        },
        order: () => query,
        range: async (from, to) => {
          subscriptionReads.push({ columns, filters, terminal: "range" });
          return { data: selected.slice(from, to + 1), error: null };
        },
        maybeSingle: async () => {
          subscriptionReads.push({ columns, filters, terminal: "maybeSingle" });
          return { data: selected[0] ? { id: selected[0].id, reference: selected[0].reference } : null,
            error: subscriptionLookupError };
        },
      };
      return query;
    },
    update: (payload) => {
      updates.push(payload);
      const chain = {
        eq: () => chain,
        select: () => chain,
        maybeSingle: async () => ({ data: updateError ? null : { id: dueSubs[0]?.id ?? "sub-1" }, error: updateError }),
        then: (resolve) => resolve({ error: updateError }),
      };
      return chain;
    },
  };

  const paymentQuery = {
    select: () => {
      let selected = [...storedPayments];
      let subscriptionId = null;
      let usesReviewFilter = false;
      const query = {
        eq(column, value) {
          if (column === "subscription_id") subscriptionId = value;
          selected = selected.filter((row) => row[column] === value); return query;
        },
        in(column, values) {
          paymentFilters.push({ subscriptionId, column, values });
          selected = selected.filter((row) => values.includes(row[column])); return query;
        },
        or(filter) {
          if (filter !== "status.in.(approved,pending),billing_review_required.eq.true") {
            throw new Error("Unexpected payment filter");
          }
          beforePaymentFilter?.({ subscriptionId, storedPayments });
          usesReviewFilter = true;
          paymentFilters.push({ subscriptionId, filter });
          selected = selected.filter((row) => ["approved", "pending"].includes(row.status)
            || row.billing_review_required === true);
          return query;
        },
        order: () => query,
        range: async (from, to) => ({ data: selected.slice(from, to + 1),
          error: (usesReviewFilter ? paymentReviewFilterError : null) ?? paymentsError ?? paymentErrors[subscriptionId] ?? null }),
      };
      return query;
    },
    eq: () => paymentQuery,
    gte: () => paymentQuery,
    lt: () => paymentQuery,
    in: () => paymentQuery,
    order: async () => ({ data: storedPayments, error: paymentsError }),
    insert: async (payload) => {
      inserts.push(payload);
      storedPayments.push({ id: `payment-${storedPayments.length + 1}`, ...payload });
      return { error: null };
    },
    update: (payload) => {
      paymentUpdates.push(payload);
      return { eq: async () => ({ error: null }) };
    },
  };

  const auditLogs = {
    insert: async (payload) => {
      audits.push(payload);
      return { error: null };
    },
  };

  const paymentAttempts = {
    select: () => {
      let selected = [...attempts];
      let isOutstandingQuery = false;
      let limit = null;
      const query = {
        eq(column, value) {
          selected = selected.filter((row) => row[column] === value);
          return query;
        },
        in(column, values) {
          if (column === "state" && values.includes("unknown")) isOutstandingQuery = true;
          selected = selected.filter((row) => values.includes(row[column]));
          return query;
        },
        not(column, operator, value) {
          if (operator === "is" && value === null) {
            selected = selected.filter((row) => row[column] != null);
          }
          return query;
        },
        limit(value) {
          limit = value;
          return query;
        },
        order() { return query; },
        async range(from, to) {
          if (isOutstandingQuery && outstandingAttemptsError) {
            return { data: null, error: outstandingAttemptsError };
          }
          const rows = (limit == null ? selected : selected.slice(0, limit)).slice(from, to + 1);
          return {
            data: rows.map((row) => ({
              ...row,
              subscription: row.subscription ?? dueSubs.find((sub) => sub.id === row.subscription_id) ?? null,
            })),
            error: null,
          };
        },
        async maybeSingle() {
          return { data: selected[0] ?? null, error: attemptLookupError };
        },
      };
      return query;
    },
    insert(payload) {
      const attempt = { id: "attempt-1", ...payload };
      attempts.push(attempt);
      return {
        select: () => ({ single: async () => ({ data: attempt, error: null }) }),
      };
    },
    update(payload) {
      let selected = [...attempts];
      const chain = {
        eq(column, value) { selected = selected.filter((row) => row[column] === value); return chain; },
        is(column, value) { selected = selected.filter((row) => (row[column] ?? null) === value); return chain; },
        in(column, values) { selected = selected.filter((row) => values.includes(row[column])); return chain; },
        select: () => chain,
        maybeSingle: async () => ({ data: { id: attempts[0]?.id ?? "attempt-1" }, error: null }),
        then: (resolve) => {
          if (!attemptUpdateError) selected.forEach((row) => Object.assign(row, payload));
          return resolve({ error: attemptUpdateError });
        },
      };
      return chain;
    },
  };

  return {
    supabase: {
      rpc: vi.fn(async (name, args) => {
        if (name === "payment_admin_schema_ready") return { data: schemaReady, error: schemaError };
        if (name === "apply_verified_wompi_event") {
          const verified = args.p_raw?.transaction;
          if (!verified || verified.id !== args.p_transaction_id || verified.reference !== args.p_reference
            || verified.amount_in_cents !== args.p_amount * 100 || verified.currency !== args.p_currency
            || verified.status !== args.p_status) {
            return { data: null, error: { message: "Fixture verified transaction descriptor mismatch" } };
          }
          if (applyError) return { data: null, error: applyError };
          if (applyData !== undefined) return { data: applyData, error: null };
          const attempt = attempts.find(
            (item) => item.wompi_transaction_id === args.p_transaction_id || item.reference === args.p_reference
          );
          const knownPayment = storedPayments.find(
            (item) => item.wompi_transaction_id === args.p_transaction_id
          );
          const legacyRecovery = knownPayment && !attempt
            && knownPayment.payment_attempt_id == null
            && args.p_raw.legacy_reconciliation?.payment_id === knownPayment.id;
          const subscription = subscriptionRows.find(
            (item) => item.id === attempt?.subscription_id
              || item.id === knownPayment?.subscription_id
              || args.p_reference === item.reference
              || args.p_reference.startsWith(`${item.reference}-`)
          );
          if (!subscription) {
            return { data: { result: "review", processingState: "needs_review",
              transactionId: args.p_transaction_id, reason: "SUBSCRIPTION_NOT_FOUND" }, error: null };
          }

          const paymentPayload = {
            subscription_id: subscription.id,
            payment_attempt_id: attempt?.id ?? null,
            amount: args.p_amount,
            currency: args.p_currency,
            status: args.p_status,
            wompi_transaction_id: args.p_transaction_id,
            reference: args.p_reference,
            approved_at: args.p_status === "approved" ? args.p_effective_at : null,
            provider_effective_at: args.p_effective_at,
            billing_review_required: args.p_status === "approved" && !args.p_effective_at,
          };
          if (knownPayment) {
            Object.assign(knownPayment, paymentPayload);
            paymentUpdates.push(paymentPayload);
          } else {
            const payment = { id: `payment-${storedPayments.length + 1}`, ...paymentPayload };
            storedPayments.push(payment);
            inserts.push(paymentPayload);
          }

          if (attempt) {
            Object.assign(attempt, {
              subscription_id: subscription.id,
              wompi_transaction_id: args.p_transaction_id,
              provider_status: args.p_status,
              completed_at: args.p_status === "pending" ? null : args.p_effective_at,
              state: args.p_status === "approved"
                ? "approved"
                : args.p_status === "pending"
                  ? "pending"
                  : args.p_status === "declined"
                    ? "declined"
                    : "failed",
            });
          }

          if (!legacyRecovery && subscription.status !== "cancelled"
            && (!attempt || attempt.subscription_version == null || attempt.subscription_version === subscription.billing_version)) {
            if (args.p_status === "approved" && args.p_effective_at) {
              subscription.status = "active";
              if (
                args.p_candidate_next_payment && (!subscription.next_payment_date
                || new Date(args.p_candidate_next_payment) > new Date(subscription.next_payment_date)
              )) {
                subscription.next_payment_date = args.p_candidate_next_payment;
                updates.push({ next_payment_date: args.p_candidate_next_payment });
              }
            } else if (["declined", "error", "voided"].includes(args.p_status)) {
              subscription.status = "past_due";
              updates.push({ status: "past_due" });
            }
          }

          return {
            data: {
              result: args.p_status === "approved" && !args.p_effective_at ? "review" : "processed",
              processingState: args.p_status === "approved" && !args.p_effective_at ? "needs_review" : "processed",
              transactionId: args.p_transaction_id,
              subscriptionId: subscription.id,
            },
            error: null,
          };
        }
        if (name === "advance_subscription_schedule") {
          const subscription = dueSubs.find((item) => item.id === args.p_subscription_id);
          if (!subscription || subscription.billing_version !== args.p_expected_version) {
            return { data: { result: "protected" }, error: null };
          }
          const candidate = new Date(args.p_candidate);
          const current = subscription.next_payment_date ? new Date(subscription.next_payment_date) : null;
          if (!current || candidate > current) {
            subscription.next_payment_date = candidate.toISOString();
            updates.push({ next_payment_date: candidate.toISOString() });
            return { data: { result: "changed", nextPaymentDate: candidate.toISOString() }, error: null };
          }
          return { data: { result: "unchanged", nextPaymentDate: subscription.next_payment_date }, error: null };
        }
        if (name === "mark_subscription_past_due") {
          const subscription = dueSubs.find((item) => item.id === args.p_subscription_id);
          if (
            !subscription
            || subscription.billing_version !== args.p_expected_version
            || subscription.status !== "active"
          ) {
            return { data: { result: "protected" }, error: null };
          }
          subscription.status = "past_due";
          updates.push({ status: "past_due" });
          return { data: { result: "changed", status: "past_due" }, error: null };
        }
        if (name !== "claim_monthly_payment_attempt") throw new Error(`Unexpected RPC ${name}`);
        const attempt = attempts.find((item) => item.id === args.p_attempt_id);
        const subscription = dueSubs.find((item) => item.id === attempt?.subscription_id);
        if (claimData !== undefined) {
          if (attempt && claimData?.result === "claimed") attempt.state = "dispatching";
          return { data: claimData, error: null };
        }
        if (!attempt || !subscription || !["prepared", "failed"].includes(attempt.state) || attempt.wompi_transaction_id) {
          return { data: { result: "not_claimed", reason: "ATTEMPT_NOT_CLAIMABLE" }, error: null };
        }
        if (attempts.some((other) => other.id !== attempt.id && other.donor_id === subscription.donor.id
          && ["dispatching", "pending", "unknown"].includes(other.state))) {
          return { data: { result: "not_claimed", reason: "DONOR_HAS_UNRESOLVED_ATTEMPT" }, error: null };
        }
        Object.assign(attempt, {
          state: "dispatching",
          amount: subscription.amount,
          currency: subscription.currency,
          subscription_version: subscription.billing_version,
        });
        return {
          data: {
            result: "claimed",
            attemptId: attempt.id,
            subscriptionId: subscription.id,
            reference: attempt.reference,
            amount: subscription.amount,
            currency: subscription.currency,
            customerEmail: subscription.donor.email,
            paymentSourceId: subscription.wompi_payment_source_id,
            preferredPaymentDay: subscription.preferred_payment_day,
            nextPaymentDate: subscription.next_payment_date,
            billingVersion: subscription.billing_version,
          },
          error: null,
        };
      }),
      from: (table) => {
        if (table === "subscriptions") return subscriptions;
        if (table === "payments") return paymentQuery;
        if (table === "audit_logs") return auditLogs;
        if (table === "payment_attempts") return paymentAttempts;
        throw new Error(`Unexpected table ${table}`);
      },
    },
    updates,
    inserts,
    paymentUpdates,
    audits,
    attempts,
    storedPayments,
    subscriptionReads,
    paymentFilters,
  };
}

const silentLogger = { log: vi.fn() };

describe("reconciled terminal failed attempts", () => {
  const now = new Date("2026-08-18T13:00:00.000Z");
  function historicalAttempt(overrides = {}) {
    return {
      id: "historical-attempt", subscription_id: "sub-1", donor_id: "donor-1",
      state: "failed", billing_period: "202607", subscription_version: 1,
      reference: "HPE-TEST-202607", amount: 10000, currency: "COP",
      wompi_transaction_id: "tx-historical", dispatched_at: "2026-07-16T12:00:00.000Z",
      provider_status: "error", completed_at: "2026-07-16T12:05:00.000Z",
      ...overrides,
    };
  }

  it.each(["error", "voided"].flatMap((status) => ["202608", "202609", "202610"].map(
    (period) => [status, period]
  )))("a reconciled %s in an older version does not block reactivation in %s", async (status, period) => {
    const fixture = createSupabase({ dueSubs: [dueSubscription({ billing_version: 2 })],
      paymentAttempts: [historicalAttempt({ provider_status: status })] });
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-new-version", reference: `HPE-TEST-${period}`,
    }));
    const getTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge",
      now: new Date(`${period.slice(0, 4)}-${period.slice(4)}-18T13:00:00.000Z`),
      supabase: fixture.supabase, createTransaction, getTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ outstanding: 0, failed: 0, blocked: 0, charged: 1 });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(createTransaction).toHaveBeenCalledOnce();
    expect(fixture.attempts[0]).toMatchObject({ state: "failed", subscription_version: 1 });
    expect(fixture.attempts[1]).toMatchObject({ subscription_version: 2, billing_period: period });
  });

  it.each([
    { completed_at: null }, { completed_at: "" }, { completed_at: "invalid" },
    { completed_at: "2026-07-16T12:05:00" }, { completed_at: "2026-99-16T12:05:00Z" },
    { provider_status: null }, { provider_status: "pending" }, { provider_status: "approved" },
    { provider_status: "declined" }, { state: "unknown" }, { state: "pending" }, { state: "dispatching" },
    { wompi_transaction_id: null }, { wompi_transaction_id: "" }, { wompi_transaction_id: " " },
    { wompi_transaction_id: 123 }, { completed_at: 1784203500000 },
  ])("keeps incomplete or unresolved terminal evidence blocked: %j", async (overrides) => {
    const fixture = createSupabase({ dueSubs: [dueSubscription({ billing_version: 2 })],
      paymentAttempts: [historicalAttempt(overrides)] });
    const createTransaction = vi.fn();
    const getTransaction = vi.fn().mockRejectedValue(new Error("PROVIDER_LOOKUP_FAILED"));
    const stats = await runMonthlyCharges({ mode: "charge", now,
      supabase: fixture.supabase, createTransaction, getTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ outstanding: 1, failed: 1, blocked: 1, charged: 0 });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(fixture.attempts).toHaveLength(1);
    if (Object.hasOwn(overrides, "wompi_transaction_id") && !overrides.wompi_transaction_id) {
      expect(getTransaction).not.toHaveBeenCalled();
      expect(fixture.attempts[0].state).toBe(overrides.wompi_transaction_id === null ? "unknown" : "failed");
    } else expect(getTransaction).toHaveBeenCalledOnce();
  });

  it.each(["error", "voided"])("reconciles a failed ID without completed_at as %s and waits until the next run to charge", async (status) => {
    const fixture = createSupabase({ dueSubs: [dueSubscription({ billing_version: 2 })],
      paymentAttempts: [historicalAttempt({ provider_status: status, completed_at: null })] });
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-historical", reference: "HPE-TEST-202607", amountInCents: 1000000,
      status, finalizedAt: "2026-07-16T12:05:00.000Z",
    }));
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction());
    const params = { mode: "charge", now, supabase: fixture.supabase,
      createTransaction, getTransaction, logger: silentLogger };
    const first = await runMonthlyCharges(params);
    expect(first).toMatchObject({ outstanding: 1, reconciled: 1, charged: 0 });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(fixture.attempts[0]).toMatchObject({ state: "failed", provider_status: status,
      completed_at: "2026-07-16T12:05:00.000Z" });
    expect(fixture.updates).toHaveLength(0);
    const second = await runMonthlyCharges(params);
    expect(second).toMatchObject({ outstanding: 0, failed: 0, charged: 1 });
    expect(getTransaction).toHaveBeenCalledOnce();
    expect(createTransaction).toHaveBeenCalledOnce();
  });

  it.each(["error", "voided"])("a verified %s without a final date remains reviewable on subsequent runs", async (status) => {
    const fixture = createSupabase({ dueSubs: [dueSubscription({ billing_version: 2 })],
      paymentAttempts: [historicalAttempt({ provider_status: status, completed_at: null })] });
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-historical", reference: "HPE-TEST-202607", amountInCents: 1000000,
      status, finalizedAt: null,
    }));
    const createTransaction = vi.fn();
    const params = { mode: "charge", now, supabase: fixture.supabase,
      createTransaction, getTransaction, logger: silentLogger };
    for (let run = 0; run < 2; run += 1) {
      expect(await runMonthlyCharges(params)).toMatchObject({ outstanding: 1, charged: 0 });
      expect(fixture.attempts[0].completed_at).toBeNull();
    }
    expect(getTransaction).toHaveBeenCalledTimes(2);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it.each(["declined", "error", "voided"])("never retries an already dispatched %s in the same month", async (status) => {
    const fixture = createSupabase({ dueSubs: [dueSubscription({ billing_version: 2 })],
      paymentAttempts: [historicalAttempt({ billing_period: "202608", reference: "HPE-TEST-202608",
        state: status === "declined" ? "declined" : "failed", provider_status: status })] });
    const createTransaction = vi.fn();
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-historical", amountInCents: 1000000, status, finalizedAt: "2026-08-16T12:05:00.000Z",
    }));
    const stats = await runMonthlyCharges({ mode: "charge", now,
      supabase: fixture.supabase, createTransaction, getTransaction, logger: silentLogger });
    expect(stats.charged).toBe(0);
    expect(createTransaction).not.toHaveBeenCalled();
    expect(fixture.supabase.rpc.mock.calls.some(([name]) => name === "claim_monthly_payment_attempt")).toBe(false);
    expect(fixture.attempts).toHaveLength(1);
  });

  it("a reconciled terminal does not remove another attempt's pending barrier", async () => {
    const fixture = createSupabase({ dueSubs: [dueSubscription({ billing_version: 2 })],
      paymentAttempts: [historicalAttempt(), historicalAttempt({ id: "other-pending",
        state: "pending", billing_period: "202606", reference: "HPE-TEST-202606",
        wompi_transaction_id: "tx-pending", completed_at: null })] });
    const createTransaction = vi.fn();
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-pending", reference: "HPE-TEST-202606", amountInCents: 1000000,
    }));
    const stats = await runMonthlyCharges({ mode: "charge", now,
      supabase: fixture.supabase, createTransaction, getTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ outstanding: 1, skippedPending: 1, blocked: 1, charged: 0 });
    expect(getTransaction).toHaveBeenCalledExactlyOnceWith({ transactionId: "tx-pending" });
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("still enforces donor exclusion for an unresolved attempt on a different subscription", async () => {
    const fixture = createSupabase({ dueSubs: [dueSubscription({ billing_version: 2 })],
      paymentAttempts: [historicalAttempt(), historicalAttempt({ id: "other-sub-pending",
        subscription_id: "sub-other", state: "dispatching", wompi_transaction_id: null,
        dispatched_at: null, completed_at: null })] });
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now,
      supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(stats.charged).toBe(0);
    expect(createTransaction).not.toHaveBeenCalled();
    expect(fixture.audits).toContainEqual(expect.objectContaining({ action: "monthly_charge_claim_blocked" }));
  });

  it("does not turn an unsent failed checkout without an ID into an uncertain monthly charge", async () => {
    const fixture = createSupabase({ dueSubs: [dueSubscription({ billing_version: 2 })],
      paymentAttempts: [historicalAttempt({ wompi_transaction_id: null, dispatched_at: null,
        provider_status: null, completed_at: null, billing_period: null })] });
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction());
    const stats = await runMonthlyCharges({ mode: "charge", now,
      supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ outstanding: 0, noIds: 0, failed: 0, charged: 1 });
    expect(fixture.attempts[0].state).toBe("failed");
    expect(createTransaction).toHaveBeenCalledOnce();
  });
});

describe("historical payments without reference", () => {
  const now = new Date("2026-08-18T13:00:00.000Z");
  function legacyFixture({ subscription = {}, payment = {}, ...options } = {}) {
    const sub = dueSubscription({ id: "legacy-sub", reference: "LEGACY-BASE", amount: 99000,
      status: "past_due", billing_version: 7, preferred_payment_day: 28,
      next_payment_date: "2026-12-28T12:00:00.000Z", ...subscription });
    const record = { id: "legacy-pay", subscription_id: sub.id, payment_attempt_id: null,
      status: "approved", amount: 10000, currency: "COP", reference: null,
      wompi_transaction_id: "legacy-tx", created_at: "2026-06-01T12:00:00.000Z",
      approved_at: null, provider_effective_at: null, billing_review_required: true, ...payment };
    return { sub, ...createSupabase({ dueSubs: [], subscriptionRows: [sub], payments: [record], ...options }) };
  }
  function legacyTransaction(overrides = {}) {
    return wompiTransaction({ id: "legacy-tx", status: "approved", amountInCents: 1000000,
      currency: "COP", reference: "LEGACY-BASE-202607", paymentSourceId: "legacy-original-source",
      finalizedAt: "2026-07-16T12:05:00.000Z", ...overrides });
  }

  it.each(["2026-07-16T12:05:00.000Z", null])("sends the exact verified nested descriptor with final date %j", async (finalizedAt) => {
    const fixture = legacyFixture();
    const transaction = legacyTransaction({ finalizedAt });
    const getTransaction = vi.fn().mockResolvedValue(transaction);
    const createTransaction = vi.fn();
    const logger = { log: vi.fn() };
    await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger });
    const application = fixture.supabase.rpc.mock.calls.find(([name]) => name === "apply_verified_wompi_event")[1];
    expect(application.p_raw).toEqual({ source: "monthly_job", transaction: {
      id: transaction.id, reference: transaction.reference, amount_in_cents: transaction.amountInCents,
      currency: transaction.currency, status: transaction.status, finalized_at: transaction.finalizedAt,
    }, legacy_reconciliation: { payment_id: "legacy-pay", subscription_id: "legacy-sub",
      subscription_reference: "LEGACY-BASE", verified_transaction_id: "legacy-tx", verification_source: "provider_get" } });
    expect(application).toMatchObject({ p_reference: transaction.reference, p_amount: 10000,
      p_currency: transaction.currency, p_effective_at: finalizedAt, p_candidate_next_payment: null });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(transaction.paymentSourceId);
  });

  it.each(["active", "past_due", "cancelled"])("recovers the stored 10000 COP payment for a non-due %s subscription", async (status) => {
    const fixture = legacyFixture({ subscription: { status, currency: "USD" },
      payment: { subscription: { reference: "UI-REF", amount: 99000 }, client_reference: "UI-REF" } });
    const original = { ...fixture.sub };
    const getTransaction = vi.fn().mockResolvedValue(legacyTransaction());
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger: silentLogger });
    expect(getTransaction).toHaveBeenCalledExactlyOnceWith({ transactionId: "legacy-tx" });
    expect(fixture.subscriptionReads.filter((read) => read.terminal === "maybeSingle")).toEqual([
      { columns: "id, reference", filters: [["eq", "id", "legacy-sub"]], terminal: "maybeSingle" },
    ]);
    expect(fixture.supabase.rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_transaction_id: "legacy-tx", p_reference: "LEGACY-BASE-202607", p_amount: 10000, p_currency: "COP",
      p_payment_source_id: "legacy-original-source", p_effective_at: "2026-07-16T12:05:00.000Z",
      p_candidate_next_payment: null, p_raw: expect.objectContaining({ legacy_reconciliation: {
        payment_id: "legacy-pay", subscription_id: "legacy-sub", subscription_reference: "LEGACY-BASE",
        verified_transaction_id: "legacy-tx", verification_source: "provider_get",
      } }),
    }));
    expect(fixture.storedPayments[0]).toMatchObject({ amount: 10000, currency: "COP", status: "approved",
      reference: "LEGACY-BASE-202607", approved_at: "2026-07-16T12:05:00.000Z", billing_review_required: false });
    expect(fixture.sub).toEqual(original);
    expect(fixture.updates).toHaveLength(0);
    expect(fixture.inserts).toHaveLength(0);
    expect(fixture.attempts).toHaveLength(0);
    expect(createTransaction).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ due: 0, reconciled: 1, failed: 0, charged: 0 });
    expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual([
      "payment_admin_schema_ready", "apply_verified_wompi_event",
    ]);
  });

  it.each(["LEGACY-BASE", "LEGACY-BASE-202601", "LEGACY-BASE-202612"])("accepts the exact stored reference family %s", async (reference) => {
    const fixture = legacyFixture();
    const getTransaction = vi.fn().mockResolvedValue(legacyTransaction({ reference }));
    const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger: silentLogger });
    expect(stats.reconciled).toBe(1);
    expect(fixture.supabase.rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({ p_reference: reference }));
  });

  it("matches literal DB references without treating punctuation as a regular expression", async () => {
    const fixture = legacyFixture({ subscription: { reference: "DB.[BASE]+" } });
    const getTransaction = vi.fn().mockResolvedValue(legacyTransaction({ reference: "DB.[BASE]+-202607" }));
    const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger: silentLogger });
    expect(stats.reconciled).toBe(1);
  });

  it.each(["UI-REF-202607", "LEGACY-BASE-202600", "LEGACY-BASE-202613", "LEGACY-BASE-20261",
    "LEGACY-BASE-202607-extra", "LEGACY-BASE202607", "LEGACY-BASE-202607\n", "", null])
    ("rejects a provider reference outside the server DB family %j", async (reference) => {
      const fixture = legacyFixture({ payment: { subscription: { reference: "UI-REF" } } });
      const getTransaction = vi.fn().mockResolvedValue(legacyTransaction({ reference }));
      const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger: silentLogger });
      expect(getTransaction).toHaveBeenCalledOnce();
      expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
      expect(fixture.storedPayments[0]).toMatchObject({ reference: null, billing_review_required: true });
      expect(stats).toMatchObject({ failed: 1, blocked: 1, charged: 0, reconciled: 0 });
    });

  it.each([{ id: "another-tx" }, { amountInCents: 9900000 }, { currency: "USD" }, { status: "mystery" }])
    ("rejects provider mismatches against the stored transaction and historical money %j", async (overrides) => {
      const fixture = legacyFixture();
      const getTransaction = vi.fn().mockResolvedValue(legacyTransaction(overrides));
      const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger: silentLogger });
      expect(getTransaction).toHaveBeenCalledOnce();
      expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
      expect(fixture.storedPayments[0]).toMatchObject({ reference: null, billing_review_required: true });
      expect(stats).toMatchObject({ failed: 1, blocked: 1, reconciled: 0 });
    });

  it.each([null, ""])("missing DB base %j does not recover or dispatch", async (reference) => {
    const fixture = legacyFixture({ subscription: { reference } });
    const getTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger: silentLogger });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
    expect(stats.failed).toBe(1);
  });

  it("missing subscription or failed DB lookup remains blocked without using embedded/UI reference", async () => {
    for (const options of [{ subscriptionRows: [] }, { subscriptionLookupError: { message: "fixture DB error" } }]) {
      const fixture = legacyFixture({ payment: { subscription: { reference: "UI-REF" } }, ...options });
      const getTransaction = vi.fn();
      const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger: silentLogger });
      expect(getTransaction).not.toHaveBeenCalled();
      expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
      expect(stats).toMatchObject({ failed: 1, blocked: 1 });
      expect(fixture.storedPayments[0].billing_review_required).toBe(true);
    }
  });

  it("without GET support or a stored TXID, recovery never clears review", async () => {
    for (const options of [{}, { payment: { wompi_transaction_id: null } }]) {
      const fixture = legacyFixture(options);
      const createTransaction = vi.fn();
      const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
      expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
      expect(fixture.storedPayments[0]).toMatchObject({ reference: null, billing_review_required: true });
      expect(stats).toMatchObject({ failed: 1, blocked: 1 });
      expect(createTransaction).not.toHaveBeenCalled();
    }
  });

  it("GET failures keep the legacy guard intact and sanitize arbitrary error strings", async () => {
    const fixture = legacyFixture();
    const logger = { log: vi.fn() };
    const getTransaction = vi.fn().mockRejectedValue(new Error("opaque-provider-fixture-secret"));
    const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger });
    expect(stats).toMatchObject({ failed: 1, blocked: 1 });
    expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
    expect(fixture.storedPayments[0].billing_review_required).toBe(true);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain("opaque-provider-fixture-secret");
  });

  it("inventory only SELECTs and never invokes GET, RPC or mutations for the historical payment", async () => {
    const fixture = legacyFixture();
    const getTransaction = vi.fn();
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger: silentLogger });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
    expect(fixture.supabase.rpc).not.toHaveBeenCalled();
    expect(fixture.subscriptionReads.filter((read) => read.terminal === "maybeSingle")).toHaveLength(0);
    expect(fixture.updates).toHaveLength(0);
    expect(fixture.paymentUpdates).toHaveLength(0);
    expect(fixture.audits).toHaveLength(0);
    expect(fixture.storedPayments[0]).toMatchObject({ reference: null, billing_review_required: true });
    expect(stats).toMatchObject({ payments: 1, blocked: 1, charged: 0 });
  });

  it("retains review for an unknown final date, then supplies fresh proof without changing subscription state or schedule", async () => {
    const fixture = legacyFixture();
    const original = { ...fixture.sub };
    const getTransaction = vi.fn().mockResolvedValueOnce(legacyTransaction({ finalizedAt: null }))
      .mockResolvedValueOnce(legacyTransaction());
    const first = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger: silentLogger });
    expect(first).toMatchObject({ failed: 1, blocked: 1, reconciled: 0 });
    expect(fixture.storedPayments[0]).toMatchObject({ reference: "LEGACY-BASE-202607", approved_at: null, billing_review_required: true });
    const second = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger: silentLogger });
    expect(second).toMatchObject({ failed: 0, reconciled: 1, charged: 0 });
    const applications = fixture.supabase.rpc.mock.calls.filter(([name]) => name === "apply_verified_wompi_event");
    expect(applications).toHaveLength(2);
    expect(applications[0][1]).toMatchObject({ p_effective_at: null, p_candidate_next_payment: null });
    expect(applications[1][1]).toMatchObject({ p_reference: "LEGACY-BASE-202607", p_amount: 10000,
      p_effective_at: "2026-07-16T12:05:00.000Z", p_candidate_next_payment: null,
      p_raw: { legacy_reconciliation: { verification_source: "provider_get", payment_id: "legacy-pay" } } });
    expect(fixture.storedPayments[0].billing_review_required).toBe(false);
    expect(fixture.sub).toEqual(original);
    expect(fixture.updates).toHaveLength(0);
  });

  it("does not dispatch a newly due charge in the same run as historical recovery", async () => {
    const fixture = legacyFixture({ subscription: { status: "active", next_payment_date: "2026-08-16T12:00:00.000Z" } });
    const original = { ...fixture.sub };
    const getTransaction = vi.fn().mockResolvedValue(legacyTransaction());
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ due: 1, reconciled: 1, charged: 0, failed: 0 });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(fixture.attempts).toHaveLength(0);
    expect(fixture.sub).toEqual(original);
    expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual([
      "payment_admin_schema_ready", "apply_verified_wompi_event",
    ]);
  });

  it("a retry cannot replace the now-stored reference with a different valid family member", async () => {
    const fixture = legacyFixture({ payment: { reference: "LEGACY-BASE-202607" } });
    const getTransaction = vi.fn().mockResolvedValue(legacyTransaction({ reference: "LEGACY-BASE-202608" }));
    const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, getTransaction, logger: silentLogger });
    expect(getTransaction).toHaveBeenCalledOnce();
    expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
    expect(fixture.storedPayments[0]).toMatchObject({ reference: "LEGACY-BASE-202607", billing_review_required: true });
    expect(stats).toMatchObject({ failed: 1, blocked: 1, reconciled: 0 });
  });

  describe("terminal payments requiring review", () => {
    function terminalFixture(status = "declined", options = {}) {
      return legacyFixture({ ...options, subscription: { status: "active",
        next_payment_date: "2026-08-16T12:00:00.000Z", wompi_payment_source_id: "current-new-source",
        ...options.subscription }, payment: { status, reference: "LEGACY-BASE-202607",
        payment_source_id: "historical-old-source", ...options.payment } });
    }
    function terminalTransaction(status = "declined", overrides = {}) {
      return legacyTransaction({ status, finalizedAt: null, paymentSourceId: "historical-old-source",
        updatedAt: "2026-08-18T13:00:00.000Z", ...overrides });
    }

    it.each(["declined", "error", "voided"])("verified %s without a date clears SQL review without charging or moving the schedule", async (status) => {
      const fixture = terminalFixture(status);
      const original = { ...fixture.sub };
      const getTransaction = vi.fn().mockResolvedValue(terminalTransaction(status));
      const createTransaction = vi.fn();
      const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
        getTransaction, createTransaction, logger: silentLogger });
      expect(stats).toMatchObject({ due: 1, payments: 1, reconciled: 1, failed: 0, blocked: 0, charged: 0 });
      expect(getTransaction).toHaveBeenCalledExactlyOnceWith({ transactionId: "legacy-tx" });
      expect(fixture.supabase.rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
        p_status: status, p_reference: "LEGACY-BASE-202607", p_amount: 10000, p_currency: "COP",
        p_payment_source_id: "historical-old-source", p_effective_at: null, p_candidate_next_payment: null,
        p_raw: expect.objectContaining({ legacy_reconciliation: expect.objectContaining({ payment_id: "legacy-pay" }) }),
      }));
      expect(fixture.storedPayments[0]).toMatchObject({ status, approved_at: null,
        provider_effective_at: null, billing_review_required: false, payment_source_id: "historical-old-source" });
      expect(fixture.sub).toEqual(original);
      expect(fixture.updates).toHaveLength(0);
      expect(fixture.attempts).toHaveLength(0);
      expect(createTransaction).not.toHaveBeenCalled();
      expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual([
        "payment_admin_schema_ready", "apply_verified_wompi_event",
      ]);
    });

    it.each(["declined", "error", "voided"])("rescans unresolved %s on the next run and stops GET after SQL clears review", async (status) => {
      const fixture = terminalFixture(status);
      const original = { ...fixture.sub };
      const apply = fixture.supabase.rpc;
      let retainReview = true;
      fixture.supabase.rpc = vi.fn(async (name, args) => {
        if (name === "apply_verified_wompi_event" && retainReview) {
          return { data: { result: "review", processingState: "needs_review", subscriptionId: "legacy-sub" }, error: null };
        }
        return apply(name, args);
      });
      const getTransaction = vi.fn().mockResolvedValue(terminalTransaction(status));
      const createTransaction = vi.fn();
      const first = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase,
        getTransaction, createTransaction, logger: silentLogger });
      expect(first).toMatchObject({ payments: 1, failed: 1, blocked: 1, reconciled: 0, charged: 0 });
      expect(fixture.storedPayments[0].billing_review_required).toBe(true);
      retainReview = false;
      const second = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase,
        getTransaction, createTransaction, logger: silentLogger });
      expect(second).toMatchObject({ payments: 1, failed: 0, blocked: 0, reconciled: 1, charged: 0 });
      expect(fixture.storedPayments[0]).toMatchObject({ status, billing_review_required: false,
        approved_at: null, provider_effective_at: null });
      const third = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase,
        getTransaction, createTransaction, logger: silentLogger });
      expect(third).toMatchObject({ payments: 0, failed: 0, blocked: 0, reconciled: 0, charged: 0 });
      expect(getTransaction).toHaveBeenCalledTimes(2);
      expect(fixture.supabase.rpc.mock.calls.filter(([name]) => name === "apply_verified_wompi_event")).toHaveLength(2);
      expect(fixture.sub).toEqual(original);
      expect(createTransaction).not.toHaveBeenCalled();
    });

    it.each([{ reference: "LEGACY-BASE-202608" }, { amountInCents: 9900000 }, { id: "another-tx" },
      { currency: "USD" }, { paymentSourceId: "current-new-source" }, { status: "unsupported" }])
      ("terminal recovery retains review for provider mismatches %j", async (overrides) => {
        const fixture = terminalFixture();
        const getTransaction = vi.fn().mockResolvedValue(terminalTransaction("declined", overrides));
        const createTransaction = vi.fn();
        const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
          getTransaction, createTransaction, logger: silentLogger });
        expect(stats).toMatchObject({ payments: 1, failed: 1, blocked: 1, charged: 0, reconciled: 0 });
        expect(fixture.storedPayments[0].billing_review_required).toBe(true);
        expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
        expect(createTransaction).not.toHaveBeenCalled();
      });

    it("a terminal GET error remains blocked and is still eligible for the next scan", async () => {
      const fixture = terminalFixture();
      const getTransaction = vi.fn().mockRejectedValue(new Error("opaque-terminal-fixture-error"));
      for (let run = 0; run < 2; run += 1) {
        const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase,
          getTransaction, logger: silentLogger });
        expect(stats).toMatchObject({ payments: 1, failed: 1, blocked: 1 });
      }
      expect(getTransaction).toHaveBeenCalledTimes(2);
      expect(fixture.storedPayments[0].billing_review_required).toBe(true);
      expect(fixture.supabase.rpc.mock.calls.some(([name]) => name === "apply_verified_wompi_event")).toBe(false);
    });

    it("an atomic application error never clears terminal review or dispatches a charge", async () => {
      const fixture = terminalFixture("error", { applyError: { message: "fixture atomic error" } });
      const getTransaction = vi.fn().mockResolvedValue(terminalTransaction("error"));
      const createTransaction = vi.fn();
      const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
        getTransaction, createTransaction, logger: silentLogger });
      expect(stats).toMatchObject({ failed: 1, blocked: 1, charged: 0 });
      expect(fixture.storedPayments[0].billing_review_required).toBe(true);
      expect(createTransaction).not.toHaveBeenCalled();
    });

    it("a terminal reviewed payment without a TXID stays blocked", async () => {
      const fixture = terminalFixture("voided", { payment: { wompi_transaction_id: null } });
      const getTransaction = vi.fn();
      const createTransaction = vi.fn();
      const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
        getTransaction, createTransaction, logger: silentLogger });
      expect(stats).toMatchObject({ payments: 1, noIds: 1, failed: 1, blocked: 1, charged: 0 });
      expect(fixture.storedPayments[0].billing_review_required).toBe(true);
      expect(getTransaction).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
    });

    it("inventory pages through terminal reviews plus approved/pending using SELECT only", async () => {
      const payments = Array.from({ length: 205 }, (_, i) => ({ id: `terminal-${i}`, subscription_id: "sub-1",
        status: ["declined", "error", "voided"][i % 3], billing_review_required: true,
        reference: "HPE-TEST-202607", amount: 10000, currency: "COP", wompi_transaction_id: `terminal-tx-${i}` }));
      payments.push({ id: "approved", status: "approved", approved_at: "2026-07-16T12:00:00.000Z" },
        { id: "pending", status: "pending" }, { id: "terminal-cleared", status: "declined", billing_review_required: false });
      const fixture = createSupabase({ dueSubs: [], payments });
      const ranges = [];
      const fromTable = fixture.supabase.from;
      fixture.supabase.from = (table) => {
        const builder = fromTable(table);
        if (table !== "payments") return builder;
        return { ...builder, select: (...args) => {
          const query = builder.select(...args);
          const range = query.range;
          query.range = (from, to) => { ranges.push([from, to]); return range(from, to); };
          return query;
        } };
      };
      const getTransaction = vi.fn();
      const createTransaction = vi.fn();
      const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase,
        getTransaction, createTransaction, logger: silentLogger });
      expect(stats).toMatchObject({ payments: 207, blocked: 206, charged: 0 });
      expect(ranges).toEqual([[0, 99], [100, 199], [200, 299]]);
      expect(fixture.paymentFilters.every(({ filter }) => filter === "status.in.(approved,pending),billing_review_required.eq.true")).toBe(true);
      expect(fixture.storedPayments.slice(0, 205).every((payment) => payment.billing_review_required)).toBe(true);
      expect(getTransaction).not.toHaveBeenCalled();
      expect(createTransaction).not.toHaveBeenCalled();
      expect(fixture.supabase.rpc).not.toHaveBeenCalled();
      expect(fixture.updates).toHaveLength(0);
      expect(fixture.paymentUpdates).toHaveLength(0);
      expect(fixture.audits).toHaveLength(0);
    });

    it("the per-subscription safety read catches a terminal review flagged after the global scan", async () => {
      const fixture = terminalFixture("declined", { payment: { billing_review_required: false },
        beforePaymentFilter: ({ subscriptionId, storedPayments }) => {
          if (subscriptionId === "legacy-sub") storedPayments[0].billing_review_required = true;
        } });
      const getTransaction = vi.fn();
      const createTransaction = vi.fn();
      const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
        getTransaction, createTransaction, logger: silentLogger });
      expect(stats).toMatchObject({ payments: 0, due: 1, failed: 1, blocked: 1, charged: 0 });
      expect(fixture.paymentFilters).toEqual([
        { subscriptionId: null, filter: "status.in.(approved,pending),billing_review_required.eq.true" },
        { subscriptionId: "legacy-sub", filter: "status.in.(approved,pending),billing_review_required.eq.true" },
      ]);
      expect(createTransaction).not.toHaveBeenCalled();
      expect(getTransaction).not.toHaveBeenCalled();
      expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
    });

    it("a new charge cannot use the historical-source allowance without an existing verified payment", async () => {
      const fixture = createSupabase({ dueSubs: [dueSubscription({ wompi_payment_source_id: "current-new-source" })] });
      const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({ paymentSourceId: "historical-old-source" }));
      const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
      expect(stats).toMatchObject({ failed: 1, blocked: 1, charged: 0 });
      expect(fixture.attempts[0]).toMatchObject({ state: "unknown", wompi_transaction_id: "tx-1" });
      expect(fixture.supabase.rpc.mock.calls.some(([name]) => name === "apply_verified_wompi_event")).toBe(false);
    });
  });
});

describe("billing job safety modes and reconciliation", () => {
  const now = new Date("2026-08-18T13:00:00.000Z");

  it("requires a mode before touching Supabase", async () => {
    const supabase = { rpc: vi.fn(), from: vi.fn() };
    await expect(runMonthlyCharges({ supabase })).rejects.toThrow("BILLING_JOB_MODE_REQUIRED");
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each([false, null, "true", {}])("requires boolean schema readiness before mutating %j", async (schemaReady) => {
    const { supabase, attempts, audits } = createSupabase({ schemaReady });
    const from = vi.spyOn(supabase, "from");
    await expect(runMonthlyCharges({ mode: "reconcile", now, supabase, logger: silentLogger }))
      .rejects.toThrow("BILLING_JOB_SCHEMA_NOT_READY");
    expect(from).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("fails closed when the schema RPC does not exist", async () => {
    const { supabase } = createSupabase({ schemaError: { message: "function unavailable" } });
    await expect(runMonthlyCharges({ mode: "charge", now, supabase, logger: silentLogger }))
      .rejects.toThrow("BILLING_JOB_SCHEMA_NOT_READY");
  });

  it("schema RPC transport errors are converted to a fixed safe code", async () => {
    const supabase = { rpc: vi.fn().mockRejectedValue(new Error("opaque-fixture-secret")), from: vi.fn() };
    await expect(runMonthlyCharges({ mode: "reconcile", now, supabase }))
      .rejects.toThrow("BILLING_JOB_SCHEMA_NOT_READY");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("inventory allows a legacy database without the new attempts table and never requires readiness RPC", async () => {
    const fixture = createSupabase({ outstandingAttemptsError: { code: "42P01", message: "fixture missing table" }, schemaReady: false });
    const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase, logger: silentLogger });
    expect(stats).toMatchObject({ due: 1, schemaUnknown: 1, blocked: 1, failed: 0 });
    expect(fixture.supabase.rpc).not.toHaveBeenCalled();
    expect(fixture.audits).toHaveLength(0);
  });

  it.each([
    { code: "42703", message: "column payments.billing_review_required does not exist" },
    { code: "PGRST204", message: "Could not find the 'billing_review_required' column of 'payments' in the schema cache" },
  ])("inventory falls back only for a missing payment review column ($code)", async (paymentReviewFilterError) => {
    const fixture = createSupabase({ outstandingAttemptsError: { code: "PGRST205" }, paymentReviewFilterError,
      payments: [{ id: "legacy-approved", status: "approved", wompi_transaction_id: "tx-approved" },
        { id: "legacy-pending", status: "pending", wompi_transaction_id: "tx-pending" },
        { id: "legacy-declined", status: "declined", wompi_transaction_id: "tx-declined" }] });
    const getTransaction = vi.fn();
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ payments: 2, schemaUnknown: 2, blocked: 4, failed: 0,
      duplicateCheckFailures: 0, charged: 0 });
    expect(fixture.paymentFilters).toEqual([
      { subscriptionId: null, filter: "status.in.(approved,pending),billing_review_required.eq.true" },
      { subscriptionId: null, column: "status", values: ["approved", "pending"] },
    ]);
    expect(getTransaction).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
    expect(fixture.supabase.rpc).not.toHaveBeenCalled();
    for (const rows of [fixture.updates, fixture.inserts, fixture.paymentUpdates, fixture.audits, fixture.attempts]) {
      expect(rows).toHaveLength(0);
    }
  });

  it("inventory keeps an empty legacy payments table explicitly incomplete", async () => {
    const fixture = createSupabase({ paymentReviewFilterError: {
      code: "42703", message: "column payments.billing_review_required does not exist" } });
    const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase, logger: silentLogger });
    expect(stats).toMatchObject({ payments: 0, schemaUnknown: 1, blocked: 1, failed: 0, charged: 0 });
    expect(fixture.supabase.rpc).not.toHaveBeenCalled();
    expect(fixture.audits).toHaveLength(0);
  });

  it.each([
    { code: "42703", message: "column payments.created_at does not exist" },
    { code: "PGRST204", message: "Could not find the 'status' column" },
    { code: "42501", message: "permission denied; billing_review_required" },
    { code: "PGRST205", message: "table payments not found" },
    { code: "NETWORK", message: "billing_review_required request timed out" },
  ])("inventory does not hide another schema, permission or network error ($code)", async (paymentReviewFilterError) => {
    const fixture = createSupabase({ paymentReviewFilterError });
    const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase, logger: silentLogger });
    expect(stats).toMatchObject({ payments: 0, schemaUnknown: 0, duplicateCheckFailures: 1, charged: 0 });
    expect(fixture.paymentFilters).toHaveLength(1);
    expect(fixture.supabase.rpc).not.toHaveBeenCalled();
    expect(fixture.audits).toHaveLength(0);
  });

  it.each(["charge", "reconcile"])("%s never uses the legacy payment fallback", async (mode) => {
    const fixture = createSupabase({ paymentReviewFilterError: {
      code: "42703", message: "column payments.billing_review_required does not exist" } });
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode, now, supabase: fixture.supabase,
      createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ payments: 0, duplicateCheckFailures: 1, charged: 0 });
    expect(fixture.paymentFilters.every((row) => row.filter === "status.in.(approved,pending),billing_review_required.eq.true")).toBe(true);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("inventory still reports a failed legacy fallback as an operational failure", async () => {
    const fixture = createSupabase({ paymentReviewFilterError: {
      code: "42703", message: "column payments.billing_review_required does not exist" },
      paymentsError: { code: "42501", message: "permission denied" } });
    const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase, logger: silentLogger });
    expect(stats).toMatchObject({ schemaUnknown: 1, duplicateCheckFailures: 1, charged: 0 });
    expect(fixture.paymentFilters).toHaveLength(2);
    expect(fixture.supabase.rpc).not.toHaveBeenCalled();
    expect(fixture.audits).toHaveLength(0);
  });

  it("inventory paginates all legacy payments without writing or contacting Wompi", async () => {
    const fixture = createSupabase({ paymentReviewFilterError: {
      code: "42703", message: "column payments.billing_review_required does not exist" },
      payments: Array.from({ length: 205 }, (_, index) => ({ id: `legacy-${index}`,
        status: index % 2 ? "pending" : "approved", wompi_transaction_id: `legacy-tx-${index}` })) });
    const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase, logger: silentLogger });
    expect(stats).toMatchObject({ payments: 205, schemaUnknown: 1, blocked: 206, charged: 0,
      duplicateCheckFailures: 0 });
    expect(fixture.supabase.rpc).not.toHaveBeenCalled();
    for (const rows of [fixture.updates, fixture.inserts, fixture.paymentUpdates, fixture.audits, fixture.attempts]) {
      expect(rows).toHaveLength(0);
    }
  });

  it("inventory discards partial legacy pages and reports a later page failure", async () => {
    const fixture = createSupabase({ paymentReviewFilterError: {
      code: "42703", message: "column payments.billing_review_required does not exist" },
      payments: Array.from({ length: 205 }, (_, index) => ({ id: `legacy-${index}`,
        status: "pending", wompi_transaction_id: `legacy-tx-${index}` })) });
    const fromTable = fixture.supabase.from.bind(fixture.supabase);
    fixture.supabase.from = (table) => {
      const builder = fromTable(table);
      if (table !== "payments") return builder;
      return { select: (...args) => {
        const query = builder.select(...args);
        const range = query.range.bind(query);
        query.range = async (from, to) => from >= 100
          ? { data: null, error: { code: "42501", message: "fixture permission failure" } } : range(from, to);
        return query;
      } };
    };
    const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase, logger: silentLogger });
    expect(stats).toMatchObject({ payments: 0, schemaUnknown: 1, duplicateCheckFailures: 1, charged: 0 });
    expect(fixture.supabase.rpc).not.toHaveBeenCalled();
    expect(fixture.audits).toHaveLength(0);
  });

  it("inventory reads all pages with stable created_at/id ordering without RPC, mutations or Wompi", async () => {
    const dueSubs = Array.from({ length: 205 }, (_, index) => dueSubscription({ id: `sub-${index}` }));
    const paymentAttempts = Array.from({ length: 205 }, (_, index) => ({
      id: `attempt-${index}`, subscription_id: `sub-${index}`, state: "unknown", billing_period: "202608",
      wompi_transaction_id: null, created_at: "2026-01-01T00:00:00.000Z",
    }));
    const payments = Array.from({ length: 205 }, (_, index) => ({ id: `pay-${index}`,
      subscription_id: `sub-${index}`, status: "approved", approved_at: "2026-07-16T12:00:00.000Z" }));
    const fixture = createSupabase({ dueSubs, paymentAttempts, payments, schemaReady: false });
    const orders = [];
    const ranges = [];
    const queryMethods = new WeakMap();
    const original = fixture.supabase.from;
    fixture.supabase.from = (table) => {
      const builder = original(table);
      const select = builder.select;
      return { ...builder, select: (...args) => {
        const query = select(...args);
        if (!queryMethods.has(query)) queryMethods.set(query, { order: query.order, range: query.range });
        const { order, range } = queryMethods.get(query);
        query.order = (column, options) => { orders.push([table, column, options]); return order(column, options); };
        query.range = (from, to) => { ranges.push([table, from, to]); return range(from, to); };
        return query;
      } };
    };
    const getTransaction = vi.fn();
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "inventory", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ mode: "inventory", due: 205, outstanding: 205, payments: 205, noIds: 205, blocked: 205 });
    for (const table of ["subscriptions", "payments", "payment_attempts"]) {
      expect(ranges.filter((row) => row[0] === table)).toEqual([
        [table, 0, 99], [table, 100, 199], [table, 200, 299],
      ]);
      expect(orders.filter((row) => row[0] === table).slice(0, 2)).toEqual([
        [table, "created_at", { ascending: true }], [table, "id", { ascending: true }],
      ]);
    }
    expect(fixture.supabase.rpc).not.toHaveBeenCalled();
    expect(fixture.attempts.every((row) => row.error_code == null)).toBe(true);
    expect(fixture.updates).toHaveLength(0);
    expect(fixture.audits).toHaveLength(0);
    expect(getTransaction).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("reconcile visits all 205 attempts even when earlier pages become terminal", async () => {
    const dueSubs = Array.from({ length: 205 }, (_, i) => dueSubscription({ id: `sub-${i}`, reference: `REF-${i}` }));
    const paymentAttempts = dueSubs.map((sub, i) => ({ id: `attempt-${i}`, subscription_id: sub.id,
      state: "pending", reference: `${sub.reference}-202608`, amount: 50000, currency: "COP", wompi_transaction_id: `tx-${i}` }));
    const fixture = createSupabase({ dueSubs, paymentAttempts });
    const getTransaction = vi.fn(async ({ transactionId }) => {
      const i = Number(transactionId.slice(3));
      return wompiTransaction({ id: transactionId, status: "declined", reference: `REF-${i}-202608`,
        finalizedAt: "2026-08-18T13:05:00.000Z" });
    });
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger: silentLogger });
    expect(getTransaction).toHaveBeenCalledTimes(205);
    expect(stats).toMatchObject({ reconciled: 205, failed: 0, charged: 0 });
    expect(fixture.attempts.every((row) => row.state === "declined")).toBe(true);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("reconcile never reserves attempts for due subscriptions", async () => {
    const fixture = createSupabase();
    const createTransaction = vi.fn();
    await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(fixture.attempts).toHaveLength(0);
    expect(fixture.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["payment_admin_schema_ready"]);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("uses a legacy payment's historical amount/currency/reference, not today's subscription", async () => {
    const fixture = createSupabase({ dueSubs: [dueSubscription({ amount: 75000, wompi_payment_source_id: "new-source" })],
      payments: [{ id: "legacy-pay", status: "pending", amount: 15000, reference: "HPE-TEST-202607", wompi_transaction_id: "legacy-tx" }] });
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({ id: "legacy-tx", amountInCents: 1500000,
      reference: "HPE-TEST-202607", paymentSourceId: "old-source", status: "approved", finalizedAt: "2026-07-16T12:05:00.000Z" }));
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, getTransaction,
      createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ reconciled: 1, failed: 0, charged: 0 });
    expect(fixture.supabase.rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_amount: 15000, p_currency: "COP", p_reference: "HPE-TEST-202607", p_payment_source_id: "old-source" }));
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("persists approved with NULL effective/candidate and blocks charging even with created/updated dates", async () => {
    const fixture = createSupabase({ payments: [{ id: "pay-unknown", status: "pending", wompi_transaction_id: "tx-unknown" }] });
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({ id: "tx-unknown", status: "approved",
      createdAt: "2026-07-16T12:00:00.000Z", updatedAt: "2026-08-18T13:00:00.000Z", finalizedAt: null }));
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, getTransaction,
      createTransaction, logger: silentLogger });
    expect(fixture.supabase.rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_effective_at: null, p_candidate_next_payment: null, p_status: "approved" }));
    expect(fixture.storedPayments[0]).toMatchObject({ status: "approved", approved_at: null });
    expect(fixture.updates).toHaveLength(0);
    expect(stats).toMatchObject({ failed: 1, blocked: 1, charged: 0 });
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("approved without a verified month blocks, never falling back to created_at", async () => {
    const fixture = createSupabase({ payments: [{ id: "pay-unknown", status: "approved", created_at: "2026-07-16T12:00:00.000Z" }] });
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(fixture.updates).toHaveLength(0);
    expect(stats).toMatchObject({ noIds: 1, blocked: 1, failed: 1 });
  });

  it.each([
    { result: "review", processingState: "needs_review", subscriptionId: "sub-1" },
    { result: "review", processingState: "needs_review", reason: "EVENT_NEEDS_REVIEW" },
    { result: "duplicate", processingState: "needs_review", subscriptionId: "sub-1" },
    { result: "processed", processingState: "needs_review", subscriptionId: "sub-1" },
  ])("blocks SQL review independently of a known provider date %j", async (applyData) => {
    const fixture = createSupabase({ applyData, payments: [{ id: "pay-review", status: "pending", wompi_transaction_id: "tx-review" }] });
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({ id: "tx-review", status: "approved",
      finalizedAt: "2026-08-18T13:05:00.000Z" }));
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ failed: 1, blocked: 1, reconciled: 0, charged: 0 });
    expect(fixture.audits).toContainEqual(expect.objectContaining({ action: "verified_transaction_needs_review" }));
    expect(fixture.updates).toHaveLength(0);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("accepts a SQL duplicate without requiring processingState", async () => {
    const fixture = createSupabase({ applyData: { result: "duplicate", subscriptionId: "sub-1" },
      payments: [{ id: "pay-duplicate", status: "pending", wompi_transaction_id: "tx-duplicate" }] });
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({ id: "tx-duplicate", status: "approved",
      finalizedAt: "2026-08-18T13:05:00.000Z" }));
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ failed: 0, reconciled: 1, charged: 0 });
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("rejects the obsolete needs_review result rather than masking a SQL contract error", async () => {
    const fixture = createSupabase({ applyData: { result: "needs_review", subscriptionId: "sub-1" },
      payments: [{ id: "pay-old-contract", status: "pending", wompi_transaction_id: "tx-old-contract" }] });
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({ id: "tx-old-contract", status: "approved",
      finalizedAt: "2026-08-18T13:05:00.000Z" }));
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
      getTransaction, createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ failed: 1, reconciled: 0, charged: 0 });
    expect(fixture.audits).toContainEqual(expect.objectContaining({ action: "transaction_reconcile_failed" }));
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("a persisted billing review flag blocks a new month despite a known historical approval date", async () => {
    const fixture = createSupabase({ payments: [{ id: "pay-flagged", status: "approved",
      approved_at: "2026-07-16T12:05:00.000Z", billing_review_required: true }] });
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase,
      createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ blocked: 1, failed: 1, charged: 0 });
    expect(fixture.attempts).toHaveLength(0);
    expect(fixture.updates).toHaveLength(0);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("blocks pending from an earlier month even without a transaction ID", async () => {
    const fixture = createSupabase({ payments: [{ id: "old-pending", status: "pending", created_at: "2026-01-01T00:00:00.000Z" }] });
    const createTransaction = vi.fn();
    await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(fixture.attempts).toHaveLength(0);
  });

  it("persists missing-ID attempts as unknown and reports them even when not due", async () => {
    const fixture = createSupabase({ dueSubs: [], paymentAttempts: [{ id: "unlinked-attempt", subscription_id: "not-due",
      state: "dispatching", billing_period: "202601", wompi_transaction_id: null }] });
    const stats = await runMonthlyCharges({ mode: "reconcile", now, supabase: fixture.supabase, logger: silentLogger });
    expect(fixture.attempts[0]).toMatchObject({ state: "unknown", error_code: "MISSING_TRANSACTION_ID" });
    expect(stats).toMatchObject({ noIds: 1, failed: 1, blocked: 1 });
  });

  it("continues other rows after provider lookup errors without logging unknown secret strings", async () => {
    const fixture = createSupabase({ dueSubs: [dueSubscription(), dueSubscription({ id: "sub-2", reference: "SECOND" })],
      paymentAttempts: [{ id: "attempt-error", subscription_id: "sub-1", state: "pending", wompi_transaction_id: "tx-error",
        reference: "HPE-TEST-202608", amount: 50000, currency: "COP" }] });
    const logger = { log: vi.fn() };
    const getTransaction = vi.fn().mockRejectedValue(new Error("opaque-acceptance-secret-fixture"));
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({ id: "tx-second", reference: "SECOND-202608" }));
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, getTransaction, createTransaction, logger });
    expect(stats).toMatchObject({ failed: 1, charged: 1 });
    expect(createTransaction).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain("opaque-acceptance-secret-fixture");
    expect(JSON.stringify(fixture.audits)).not.toContain("opaque-acceptance-secret-fixture");
  });

  it("a per-subscription SQL lookup error blocks that row while other rows continue", async () => {
    const fixture = createSupabase({ dueSubs: [dueSubscription(), dueSubscription({ id: "sub-2", reference: "SECOND" })],
      paymentErrors: { "sub-1": { message: "opaque-sql-secret-fixture" } } });
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({ id: "tx-second", reference: "SECOND-202608" }));
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ duplicateCheckFailures: 1, charged: 1 });
    expect(createTransaction).toHaveBeenCalledOnce();
  });

  it("atomic attempt lookup errors never reserve or dispatch", async () => {
    const fixture = createSupabase({ attemptLookupError: { message: "fixture-db-error" } });
    const createTransaction = vi.fn();
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(stats.failed).toBe(1);
    expect(fixture.attempts).toHaveLength(0);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("does not turn an after-send error into a retry, even if it claims safeToRetry", async () => {
    const fixture = createSupabase();
    const createTransaction = vi.fn(async ({ onSending }) => {
      onSending();
      throw Object.assign(new Error("opaque-post-fixture-secret"), { safeToRetry: true });
    });
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(stats.failed).toBe(1);
    expect(fixture.attempts[0]).toMatchObject({ state: "unknown" });
    expect(createTransaction).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.attempts)).not.toContain("opaque-post-fixture-secret");
  });

  it("allows an inflight payment to finalize after cancellation without reactivating", async () => {
    const sub = dueSubscription();
    const fixture = createSupabase({ dueSubs: [sub] });
    const createTransaction = vi.fn(async () => {
      sub.status = "cancelled";
      sub.billing_version += 1;
      return wompiTransaction({ status: "approved", finalizedAt: "2026-08-18T13:05:00.000Z" });
    });
    const stats = await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(stats).toMatchObject({ charged: 1, failed: 0 });
    expect(sub.status).toBe("cancelled");
    expect(fixture.updates).toHaveLength(0);
    expect(fixture.storedPayments[0].status).toBe("approved");
  });

  it("preserves an admin future schedule while still finalizing the immutable claim", async () => {
    const sub = dueSubscription();
    const fixture = createSupabase({ dueSubs: [sub] });
    const createTransaction = vi.fn(async () => {
      sub.amount = 99000;
      sub.wompi_payment_source_id = "admin-new-source";
      sub.preferred_payment_day = 28;
      sub.billing_version += 1;
      sub.next_payment_date = "2026-12-28T12:00:00.000Z";
      return wompiTransaction({ status: "approved", finalizedAt: "2026-08-18T13:05:00.000Z" });
    });
    await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(fixture.supabase.rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_amount: 50000, p_payment_source_id: "source-1", p_candidate_next_payment: "2026-09-16T12:00:00.000Z" }));
    expect(sub.next_payment_date).toBe("2026-12-28T12:00:00.000Z");
    expect(fixture.updates).toHaveLength(0);
  });

  it("atomic schedule version protection wins over a stale approved repair", async () => {
    const sub = dueSubscription();
    const fixture = createSupabase({ dueSubs: [sub], payments: [{ id: "known-approved", status: "approved",
      approved_at: "2026-08-16T12:05:00.000Z" }] });
    const rpc = fixture.supabase.rpc;
    fixture.supabase.rpc = vi.fn(async (name, args) => {
      if (name === "advance_subscription_schedule") {
        sub.billing_version += 1;
        sub.next_payment_date = "2026-12-16T12:00:00.000Z";
      }
      return rpc(name, args);
    });
    const createTransaction = vi.fn();
    await runMonthlyCharges({ mode: "charge", now, supabase: fixture.supabase, createTransaction, logger: silentLogger });
    expect(sub.next_payment_date).toBe("2026-12-16T12:00:00.000Z");
    expect(fixture.updates).toHaveLength(0);
    expect(createTransaction).not.toHaveBeenCalled();
  });
});

describe("monthly charge billing calendar", () => {
  it("treats 2026-07-01 02:40 UTC as the June billing period in Colombia", () => {
    expect(getColombiaBillingMonthRange(new Date("2026-07-01T02:40:00.000Z"))).toEqual({
      periodKey: "202606",
      startIso: "2026-06-01T05:00:00.000Z",
      endIso: "2026-07-01T05:00:00.000Z",
    });
  });

  it("uses Colombia calendar boundaries when the year changes", () => {
    expect(getColombiaBillingMonthRange(new Date("2027-01-01T04:59:59.000Z"))).toMatchObject({
      periodKey: "202612",
      endIso: "2027-01-01T05:00:00.000Z",
    });
  });

  it("keeps preferred dates at 7 a.m. Colombia in UTC", () => {
    expect(getNextMonthlyPaymentDate(new Date("2026-08-01T13:35:44.000Z"), 16).toISOString()).toBe(
      "2026-09-16T12:00:00.000Z"
    );
  });

  it("uses the Colombia calendar day for a legacy subscription without a preferred day", () => {
    expect(getNextMonthlyPaymentDate(new Date("2026-08-01T02:00:00.000Z"), null).toISOString()).toBe(
      "2026-08-31T12:00:00.000Z"
    );
  });

  it("charges with a Colombia billing-period reference after the UTC boundary", async () => {
    const { supabase, inserts } = createSupabase();
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      reference: "HPE-TEST-202606",
      createdAt: "2026-07-01T02:40:00.000Z",
    }));

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-07-01T02:40:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "HPE-TEST-202606", amountInCents: 5000000 })
    );
    expect(inserts).toEqual([expect.objectContaining({ wompi_transaction_id: "tx-1", status: "pending" })]);
    expect(stats.charged).toBe(1);
  });

  it("does not re-charge while Wompi payment is pending", async () => {
    const { supabase } = createSupabase({ payments: [{ id: "pay-1", status: "pending", created_at: "2026-08-01T13:35:44.000Z" }] });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(stats.skippedPending).toBe(1);
  });

  it("repairs an overdue next payment date after an approved payment in the same Colombia month", async () => {
    const { supabase, updates, audits } = createSupabase({
      dueSubs: [dueSubscription({ next_payment_date: "2026-08-16T12:00:00.000Z" })],
      payments: [
        {
          id: "pay-1",
          status: "approved",
          created_at: "2026-08-01T13:35:44.000Z",
          approved_at: "2026-08-01T13:35:44.000Z",
          wompi_transaction_id: "tx-approved",
        },
      ],
    });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(updates).toEqual([expect.objectContaining({ next_payment_date: "2026-09-16T12:00:00.000Z" })]);
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_schedule_reconciled" })]);
    expect(stats.reconciled).toBe(1);
  });

  it("charges the current month when the latest approved payment belongs to the previous month", async () => {
    const { supabase, inserts } = createSupabase({
      dueSubs: [dueSubscription({ next_payment_date: "2026-09-16T12:00:00.000Z" })],
      payments: [{
        id: "pay-august",
        status: "approved",
        created_at: "2026-08-16T12:05:00.000Z",
        approved_at: "2026-08-16T12:05:00.000Z",
        reference: "HPE-TEST-202608",
        wompi_transaction_id: "tx-august",
      }],
    });
    const getTransaction = vi.fn();
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-september",
      reference: "HPE-TEST-202609",
      createdAt: "2026-09-18T13:00:00.000Z",
    }));

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-09-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      getTransaction,
      logger: silentLogger,
    });

    expect(getTransaction).not.toHaveBeenCalledWith({ transactionId: "tx-august" });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      reference: "HPE-TEST-202609",
    }));
    expect(inserts).toEqual([expect.objectContaining({
      wompi_transaction_id: "tx-september",
      status: "pending",
    })]);
    expect(stats.charged).toBe(1);
  });

  it("fails closed when the duplicate-payment check cannot be completed", async () => {
    const { supabase, audits } = createSupabase({ paymentsError: { message: "database unavailable" } });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_duplicate_check_failed" })]);
    expect(stats.duplicateCheckFailures).toBe(1);
  });

  it("fails visibly when a due subscription has no tokenized payment source", async () => {
    const { supabase, audits } = createSupabase({
      dueSubs: [dueSubscription({ wompi_payment_source_id: null })],
    });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_missing_payment_source" })]);
    expect(stats.failed).toBe(1);
  });

  it("blocks a new month while an older payment attempt is unresolved", async () => {
    const { supabase, audits } = createSupabase({
      paymentAttempts: [{
        id: "attempt-old",
        subscription_id: "sub-1",
        state: "unknown",
        billing_period: "202607",
        reference: "HPE-TEST-202607",
        amount: 50000,
        currency: "COP",
        wompi_transaction_id: null,
      }],
    });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_blocked_unresolved_attempt" })]);
    expect(stats.failed).toBe(1);
  });

  it("advances the schedule immediately when Wompi returns approved", async () => {
    const { supabase, updates, inserts } = createSupabase();
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-approved-now",
      status: "approved",
      finalizedAt: "2026-08-18T13:05:00.000Z",
    }));

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(inserts).toEqual([expect.objectContaining({
      wompi_transaction_id: "tx-approved-now",
      approved_at: "2026-08-18T13:05:00.000Z",
    })]);
    expect(updates).toEqual([expect.objectContaining({ next_payment_date: "2026-09-16T12:00:00.000Z" })]);
    expect(stats.charged).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it("marks the subscription past due when a new charge is declined", async () => {
    const { supabase, updates } = createSupabase();
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-declined-now",
      status: "declined",
      finalizedAt: "2026-08-18T13:05:00.000Z",
    }));

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(updates).toEqual([expect.objectContaining({ status: "past_due" })]);
    expect(stats.charged).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it("uses the subscription values revalidated by the atomic claim", async () => {
    const current = dueSubscription({ amount: 60000, billing_version: 4 });
    const { supabase } = createSupabase({
      dueSubs: [current],
      paymentAttempts: [{
        id: "attempt-1",
        subscription_id: current.id,
        billing_period: "202608",
        reference: "HPE-TEST-202608",
        amount: 50000,
        currency: "COP",
        subscription_version: 3,
        state: "prepared",
        wompi_transaction_id: null,
      }],
    });
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-current",
      amountInCents: 6000000,
    }));

    await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      reference: "HPE-TEST-202608",
      amountInCents: 6000000,
    }));
  });

  it("blocks Wompi and records an invalid atomic claim as unknown", async () => {
    const { supabase, attempts, audits } = createSupabase({
      claimData: {
        result: "claimed",
        attemptId: "attempt-1",
        subscriptionId: "sub-1",
        reference: "HPE-TEST-202608",
        amount: 50000,
        currency: "COP",
        customerEmail: "",
        paymentSourceId: "source-1",
        preferredPaymentDay: 16,
        nextPaymentDate: "2026-06-16T12:00:00.000Z",
        billingVersion: 0,
      },
    });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(attempts[0]).toEqual(expect.objectContaining({
      state: "unknown",
      error_code: "INVALID_CLAIM_RESPONSE",
    }));
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_invalid_claim_response" })]);
    expect(stats.failed).toBe(1);
  });

  it("fails visibly when another uncertain attempt blocks the donor", async () => {
    const { supabase, audits } = createSupabase({
      claimData: { result: "not_claimed", reason: "DONOR_HAS_UNRESOLVED_ATTEMPT" },
    });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_claim_blocked" })]);
    expect(stats.failed).toBe(1);
    expect(stats.skippedPending).toBe(0);
  });

  it("uses approved_at to repair a payment created before the Colombia month boundary", async () => {
    const { supabase, updates } = createSupabase({
      dueSubs: [dueSubscription({ next_payment_date: "2026-08-16T12:00:00.000Z" })],
      payments: [{
        id: "pay-boundary",
        status: "approved",
        created_at: "2026-08-01T04:55:00.000Z",
        approved_at: "2026-08-01T05:10:00.000Z",
        wompi_transaction_id: "tx-boundary",
      }],
    });
    const createTransaction = vi.fn();

    await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(updates).toEqual([expect.objectContaining({ next_payment_date: "2026-09-16T12:00:00.000Z" })]);
  });

  it("fails visibly when Wompi returns an unsupported status", async () => {
    const { supabase, inserts, attempts, audits } = createSupabase();
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-odd",
      status: "mystery",
    }));

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(inserts).toEqual([]);
    expect(attempts[0]).toEqual(expect.objectContaining({
      state: "unknown",
      wompi_transaction_id: "tx-odd",
      error_code: "UNSUPPORTED_WOMPI_STATUS",
    }));
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_failed" })]);
    expect(stats.failed).toBe(1);
    expect(stats.charged).toBe(0);
  });

  it("fails visibly when Wompi omits the expected tokenized payment source", async () => {
    const { supabase, inserts, attempts, audits } = createSupabase();
    const createTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-missing-source",
      paymentSourceId: null,
    }));

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(inserts).toEqual([]);
    expect(attempts[0]).toEqual(expect.objectContaining({
      state: "unknown",
      wompi_transaction_id: "tx-missing-source",
    }));
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_failed" })]);
    expect(stats.failed).toBe(1);
    expect(stats.charged).toBe(0);
  });

  it("keeps failing visibly when an unresolved current-period attempt has no transaction id", async () => {
    const { supabase, audits } = createSupabase({
      paymentAttempts: [{
        id: "attempt-current",
        subscription_id: "sub-1",
        state: "unknown",
        billing_period: "202608",
        reference: "HPE-TEST-202608",
        amount: 50000,
        currency: "COP",
        wompi_transaction_id: null,
      }],
    });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_unresolved_without_transaction_id" })]);
    expect(stats.failed).toBe(1);
  });

  it("requires manual review for a failed attempt that was already dispatched without a transaction id", async () => {
    const { supabase, audits } = createSupabase({
      paymentAttempts: [{
        id: "attempt-dispatched",
        subscription_id: "sub-1",
        state: "failed",
        billing_period: "202608",
        reference: "HPE-TEST-202608",
        amount: 50000,
        currency: "COP",
        wompi_transaction_id: null,
        dispatched_at: "2026-08-18T12:59:00.000Z",
      }],
    });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_failed_attempt_requires_review" })]);
    expect(stats.failed).toBe(1);
  });

  it("treats a failed attempt reconciliation write as an operational failure", async () => {
    const { supabase } = createSupabase({
      payments: [{
        id: "pay-pending",
        status: "pending",
        created_at: "2026-08-18T12:55:00.000Z",
        reference: "HPE-TEST-202608",
        wompi_transaction_id: "tx-pending",
      }],
      applyError: { message: "atomic reconciliation unavailable" },
    });
    const getTransaction = vi.fn().mockResolvedValue({
      id: "tx-pending",
      status: "approved",
      reference: "HPE-TEST-202608",
      amountInCents: 5000000,
      currency: "COP",
      paymentSourceId: "source-1",
      finalizedAt: "2026-08-18T13:00:00.000Z",
    });

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:05:00.000Z"),
      supabase,
      createTransaction: vi.fn(),
      getTransaction,
      logger: silentLogger,
    });

    expect(stats.failed).toBe(1);
    expect(stats.reconciled).toBe(0);
  });

  it("marks the subscription past due when a pending charge reconciles as declined", async () => {
    const { supabase, updates } = createSupabase({
      payments: [{
        id: "pay-pending-declined",
        status: "pending",
        created_at: "2026-08-18T12:55:00.000Z",
        reference: "HPE-TEST-202608",
        wompi_transaction_id: "tx-pending-declined",
      }],
    });
    const getTransaction = vi.fn().mockResolvedValue({
      id: "tx-pending-declined",
      status: "declined",
      reference: "HPE-TEST-202608",
      amountInCents: 5000000,
      currency: "COP",
      paymentSourceId: "source-1",
      finalizedAt: "2026-08-18T13:00:00.000Z",
    });

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:05:00.000Z"),
      supabase,
      createTransaction: vi.fn(),
      getTransaction,
      logger: silentLogger,
    });

    expect(updates).toEqual([expect.objectContaining({ status: "past_due" })]);
    expect(stats.reconciled).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it("reconciles an outstanding tokenized charge before looking for new charges", async () => {
    const { supabase, attempts, inserts, updates } = createSupabase({
      paymentAttempts: [{
        id: "attempt-pending",
        subscription_id: "sub-1",
        billing_period: "202608",
        reference: "HPE-TEST-202608",
        amount: 50000,
        currency: "COP",
        state: "pending",
        wompi_transaction_id: "tx-outstanding",
      }],
    });
    const getTransaction = vi.fn().mockResolvedValue(wompiTransaction({
      id: "tx-outstanding",
      status: "approved",
      finalizedAt: "2026-08-18T13:00:00.000Z",
    }));
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:05:00.000Z"),
      supabase,
      createTransaction,
      getTransaction,
      logger: silentLogger,
    });

    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(createTransaction).not.toHaveBeenCalled();
    expect(attempts[0]).toEqual(expect.objectContaining({
      state: "approved",
      wompi_transaction_id: "tx-outstanding",
    }));
    expect(inserts).toEqual([expect.objectContaining({
      wompi_transaction_id: "tx-outstanding",
      status: "approved",
    })]);
    expect(updates).toEqual([expect.objectContaining({
      next_payment_date: "2026-09-16T12:00:00.000Z",
    })]);
    expect(stats.reconciled).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it("reports an outstanding-attempt query failure instead of charging blindly", async () => {
    const { supabase } = createSupabase({
      dueSubs: [],
      outstandingAttemptsError: { message: "attempt query unavailable" },
    });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:05:00.000Z"),
      supabase,
      createTransaction,
      getTransaction: vi.fn(),
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(stats.failed).toBe(1);
  });

  it("retains the Wompi transaction id when verification fails after dispatch", async () => {
    const { supabase, attempts, audits } = createSupabase();
    const createTransaction = vi.fn().mockImplementation(async (params) => {
      await params.onDispatched({ id: "tx-uncertain", status: "pending" });
      const error = new Error("Wompi verification timed out");
      error.transactionId = "tx-uncertain";
      throw error;
    });

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(attempts[0]).toEqual(expect.objectContaining({
      state: "unknown",
      wompi_transaction_id: "tx-uncertain",
      provider_status: "pending",
    }));
    expect(audits).toEqual([expect.objectContaining({
      action: "monthly_charge_failed",
      details: expect.objectContaining({ hasTransactionId: true, safeToRetry: false }),
    })]);
    expect(stats.failed).toBe(1);
    expect(stats.charged).toBe(0);
  });

  it("keeps a pre-dispatch failure retryable without treating it as an uncertain charge", async () => {
    const { supabase, attempts, audits } = createSupabase();
    const preDispatchError = Object.assign(new Error("acceptance service unavailable"), {
      safeToRetry: true,
    });
    const createTransaction = vi.fn().mockRejectedValue(preDispatchError);

    const stats = await runMonthlyCharges({
      mode: "charge",
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(attempts[0]).toEqual(expect.objectContaining({
      state: "prepared",
      dispatched_at: null,
      error_code: "PRE_DISPATCH_FAILURE",
    }));
    expect(audits).toEqual([expect.objectContaining({
      action: "monthly_charge_failed",
      details: expect.objectContaining({ safeToRetry: true }),
    })]);
    expect(stats.failed).toBe(1);
  });
});
