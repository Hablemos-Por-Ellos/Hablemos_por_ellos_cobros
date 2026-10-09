// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runMonthlyRetryCharges } from "./monthly-retry-runner.mjs";
import { VERIFIED_INSUFFICIENT_FUNDS_MESSAGE } from "./billing-retry-policy.mjs";

const env = { APP_OPERATION_MODE: "active", FINANCIAL_OPERATIONS_ENABLED: "true",
  SUPABASE_URL: "http://127.0.0.1:54321", WOMPI_ENV: "sandbox" };
const at = "2026-10-09T12:00:00.000Z";
const subscription = { id: "sub-fixture", donor_id: "donor-fixture", frequency: "monthly", status: "active",
  billing_version: 0, next_payment_date: "2026-10-09T12:00:00Z" };
const reservation = { result: "reserved", attemptId: "attempt-fixture", cycleId: "cycle-fixture",
  subscriptionId: subscription.id, frequency: "monthly", attemptNumber: 1,
  amount: 30000, currency: "COP", reference: "fixture-original", paymentSourceId: "source-fixture",
  customerEmail: "fixture@example.test", preferredPaymentDay: 6, billingVersion: 0, retryEnabled: true };
const cycle = { id: reservation.cycleId, subscription_id: subscription.id, amount: 30000, currency: "COP",
  payment_source_id: "source-fixture", retry_enabled: true, state: "open" };
const attempt = { id: reservation.attemptId, cycle_id: cycle.id, subscription_id: subscription.id,
  attempt_number: 1, state: "pending", reference: reservation.reference, amount: 30000,
  currency: "COP", wompi_transaction_id: "tx-fixture", dispatch_snapshot: reservation };
const transaction = { id: "tx-fixture", status: "approved", reference: reservation.reference, amountInCents: 3000000,
  currency: "COP", paymentSourceId: "source-fixture", paymentMethodType: "CARD",
  finalizedAt: "2026-10-08T14:00:00Z", environment: "sandbox", verificationSource: "provider_get" };
const source = { id: "source-fixture", status: "AVAILABLE", type: "CARD", environment: "sandbox",
  verificationSource: "provider_get", verifiedAt: at };

function fixture({ cycles = [], attempts = [], payments = [], subscriptions = [subscription], rpcOverrides = {},
  queryError = null, transactionOverrides = {}, sourceOverrides = {}, prepareError,
  sendError, clock = () => new Date(at) } = {}) {
  const order = [];
  const rows = { billing_cycles: cycles, payment_attempts: attempts, subscriptions, payments };
  const rangeCalls = [];
  const supabase = { from: vi.fn((table) => {
    const filters = [];
    const query = { select: vi.fn(() => query), order: vi.fn(() => query),
      eq: vi.fn((name, value) => { filters.push([name, value]); return query; }),
      range: vi.fn(async (start, end) => {
        order.push("read:" + table);
        rangeCalls.push({ table, start, end });
        return { data: rows[table].filter((row) => filters.every(([name, value]) => row[name] === value))
          .slice(start, end + 1), error: queryError };
      }) };
    return query;
  }), rpc: vi.fn(async (name, args) => {
    order.push(name);
    if (rpcOverrides[name]) return rpcOverrides[name](args);
    const data = {
      billing_retry_schema_ready: true,
      billing_v2_reserve_original: reservation,
      billing_v2_reserve_retry: { ...reservation, attemptId: "attempt-retry", attemptNumber: 2, reference: "fixture-retry" },
      billing_v2_authorize_send: { ...reservation, canDispatch: true, sendAuthorizedAt: at,
        windowEnd: "2026-10-10T05:00:00Z" },
      billing_v2_record_dispatch: { result: "recorded" },
      billing_v2_apply_result: { result: "processed" },
      billing_v2_mark_uncertain: { result: "unknown" },
      billing_v2_expire_retry: { result: "unchanged" },
      billing_v2_repair_schedule: { result: "unchanged" },
      apply_verified_wompi_event: { result: "review", historicalOnly: true, scheduleProtected: true },
    }[name];
    return { data, error: null };
  }) };
  const getPaymentSource = vi.fn(async () => { order.push("source_get"); return { ...source, ...sourceOverrides }; });
  const getTransaction = vi.fn(async () => { order.push("transaction_get"); return { ...transaction, ...transactionOverrides }; });
  const send = vi.fn(async ({ onSending, onDispatched }) => {
    order.push("post_start");
    onSending();
    if (sendError) throw sendError;
    await onDispatched({ id: transaction.id, status: "pending" });
    return { id: transaction.id, status: "pending" };
  });
  const prepareTransaction = vi.fn(async () => {
    order.push("prepare_acceptance_and_body");
    if (prepareError) throw prepareError;
    return { send };
  });
  const logger = { log: vi.fn(), error: vi.fn() };
  const run = (changes = {}) => runMonthlyRetryCharges({ mode: "charge", env: { ...env }, supabase,
    getTransaction, getPaymentSource, prepareTransaction, clock, logger, ...changes });
  return { run, supabase, getTransaction, getPaymentSource, prepareTransaction, send, logger, order, rangeCalls };
}

describe("v040 monthly runner read-only gates", () => {
  it("a newly reserved SQL cycle supplies retry consent and fresh source proof on its first declined GET", async () => {
    const f = fixture({ cycles: [], transactionOverrides: { status: "declined", statusMessage: VERIFIED_INSUFFICIENT_FUNDS_MESSAGE },
      rpcOverrides: { billing_v2_reserve_original: async () => ({ data: { result: "reserved",
        attempt: { id: reservation.attemptId, reference: reservation.reference, attempt_number: 1, cycle_id: reservation.cycleId },
        dispatchSnapshot: reservation }, error: null }) } });
    const stats = await f.run();
    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(0);
    expect(f.getPaymentSource).toHaveBeenCalledTimes(2);
    expect(f.supabase.rpc).toHaveBeenCalledWith("billing_v2_apply_result", { p_attempt_id: reservation.attemptId,
      p_transaction: expect.objectContaining({ payment_source_verification: expect.objectContaining({ verification_source: "provider_get" }),
        retry_classification: expect.objectContaining({ action: "retry_ready" }) }) });
  });
  it("inventory only reads and never invokes provider functions or mutating RPCs", async () => {
    const f = fixture({ cycles: [cycle], attempts: [attempt] });
    const stats = await f.run({ mode: "inventory", env: { SUPABASE_URL: env.SUPABASE_URL } });
    expect(stats).toMatchObject({ mode: "inventory", cycles: 1, due: 1, outstanding: 1, sent: 0, approved: 0 });
    expect(f.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["billing_retry_schema_ready"]);
    expect(f.getTransaction).not.toHaveBeenCalled();
    expect(f.getPaymentSource).not.toHaveBeenCalled();
    expect(f.prepareTransaction).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([false, "true", null])("requires boolean schema readiness %j", async (data) => {
    const f = fixture({ rpcOverrides: { billing_retry_schema_ready: async () => ({ data, error: null }) } });
    await expect(f.run()).rejects.toThrow("BILLING_JOB_SCHEMA_NOT_READY");
    expect(f.supabase.from).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("never falls back to old financial methods if readiness RPC is missing", async () => {
    const f = fixture({ rpcOverrides: { billing_retry_schema_ready: async () => ({ data: null, error: { code: "PGRST202" } }) } });
    await expect(f.run()).rejects.toThrow("BILLING_JOB_SCHEMA_NOT_READY");
    expect(f.supabase.rpc).toHaveBeenCalledOnce();
  });
  it.each([{ APP_OPERATION_MODE: "cutover" }, { FINANCIAL_OPERATIONS_ENABLED: "false" },
    { APP_OPERATION_MODE: "demo" }, { WOMPI_ENV: "prod" }])("financial flags guard before client use %j", async (changes) => {
    const f = fixture();
    await expect(f.run({ env: { ...env, ...changes } })).rejects.toThrow();
    expect(f.supabase.rpc).not.toHaveBeenCalled();
  });
  it("pagination gathers all records before any reconciliation", async () => {
    const f = fixture({ attempts: Array.from({ length: 103 }, (_, n) => ({ ...attempt, id: "a-" + n })) });
    const stats = await f.run({ mode: "inventory" });
    expect(stats.outstanding).toBe(103);
    expect(f.rangeCalls.filter((call) => call.table === "payment_attempts"))
      .toEqual([{ table: "payment_attempts", start: 0, end: 99 }, { table: "payment_attempts", start: 100, end: 199 }]);
  });
  it("failed/duplicate scans prevent every outbound call", async () => {
    const broken = fixture({ queryError: { message: "opaque-fixture-secret" } });
    expect(await broken.run()).toMatchObject({ failed: 1, sent: 0 });
    expect(broken.send).not.toHaveBeenCalled();
    expect(JSON.stringify(broken.logger.log.mock.calls)).not.toContain("opaque-fixture-secret");
    const duplicate = fixture({ attempts: [attempt, attempt] });
    expect(await duplicate.run()).toMatchObject({ failed: 1 });
    expect(duplicate.getTransaction).not.toHaveBeenCalled();
  });
});

describe("v040 reconciliation", () => {
  it("pending uses GET and records the same attempt, no POST in reconcile", async () => {
    const f = fixture({ cycles: [cycle], attempts: [attempt], transactionOverrides: { status: "pending", finalizedAt: null } });
    const stats = await f.run({ mode: "reconcile", env: { ...env, APP_OPERATION_MODE: "cutover", FINANCIAL_OPERATIONS_ENABLED: "false" } });
    expect(stats).toMatchObject({ reconciled: 1, skippedPending: 1, sent: 0, approved: 0 });
    expect(f.supabase.rpc).toHaveBeenCalledWith("billing_v2_apply_result", {
      p_attempt_id: attempt.id, p_transaction: expect.objectContaining({ status: "pending",
        retry_classification: { action: "reconcile", reason: "PROVIDER_PENDING" } }),
    });
    expect(f.prepareTransaction).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("never POSTs an unknown attempt without ID", async () => {
    const f = fixture({ cycles: [cycle], attempts: [{ ...attempt, state: "unknown", wompi_transaction_id: null }],
      rpcOverrides: { billing_v2_reserve_original: async () => ({ data: { result: "blocked" }, error: null }) } });
    expect(await f.run()).toMatchObject({ noIds: 1, sent: 0, blocked: 2 });
    expect(f.getTransaction).not.toHaveBeenCalled();
    expect(f.prepareTransaction).not.toHaveBeenCalled();
  });
  it("verified funds result retains original evidence and schedule window without altering history", async () => {
    const f = fixture({ cycles: [cycle], attempts: [attempt], transactionOverrides: { status: "declined",
      statusMessage: VERIFIED_INSUFFICIENT_FUNDS_MESSAGE } });
    expect(await f.run({ mode: "reconcile" })).toMatchObject({ reconciled: 1, sent: 0 });
    const args = f.supabase.rpc.mock.calls.find(([name]) => name === "billing_v2_apply_result")[1];
    expect(args.p_transaction).toMatchObject({ verification_source: "provider_get", status: "declined",
      status_message: VERIFIED_INSUFFICIENT_FUNDS_MESSAGE, environment: "sandbox",
      retry_classification: { action: "retry_ready", retryWindowStart: at, retryWindowEnd: "2026-10-10T05:00:00.000Z" },
      payment_source_verification: { type: "CARD", status: "AVAILABLE" } });
    expect(f.getPaymentSource).toHaveBeenCalledOnce();
  });
  it("legacy cycles never acquire automatic retry eligibility from active/source alone", async () => {
    const f = fixture({ cycles: [{ ...cycle, retry_enabled: false }], attempts: [attempt],
      transactionOverrides: { status: "declined", statusMessage: VERIFIED_INSUFFICIENT_FUNDS_MESSAGE } });
    await f.run({ mode: "reconcile" });
    const payload = f.supabase.rpc.mock.calls.find(([name]) => name === "billing_v2_apply_result")[1].p_transaction;
    expect(payload.retry_classification.reason).toBe("RETRY_AUTHORIZATION_MISSING_OR_REVOKED");
    expect(f.getPaymentSource).not.toHaveBeenCalled();
  });
  it.each([{ currency: "USD" }, { paymentSourceId: "not-the-snapshot" }, { verificationSource: "browser" }])(
    "mismatched GET stops new sends %j", async (changes) => {
      const f = fixture({ cycles: [cycle], attempts: [attempt], transactionOverrides: changes });
      expect(await f.run()).toMatchObject({ failed: 1, sent: 0 });
      expect(f.supabase.rpc).not.toHaveBeenCalledWith("billing_v2_apply_result", expect.anything());
      expect(f.prepareTransaction).not.toHaveBeenCalled();
    });
  it("duplicate approvals are not counted a second time", async () => {
    const f = fixture({ cycles: [cycle], attempts: [attempt], rpcOverrides: {
      billing_v2_apply_result: async () => ({ data: { result: "duplicate" }, error: null }),
    } });
    expect(await f.run({ mode: "reconcile" })).toMatchObject({ reconciled: 1, approved: 0, sent: 0 });
  });
});

describe("v040 durable send barrier", () => {
  it("reserves, verifies source/prepares acceptance, authorizes, sends and verifies in order", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ originalsReserved: 1, sent: 1, charged: 1, approved: 1, failed: 0 });
    expect(f.order.filter((entry) => !entry.startsWith("read:"))).toEqual([
      "billing_retry_schema_ready", "billing_v2_reserve_original", "source_get", "prepare_acceptance_and_body",
      "billing_v2_authorize_send", "post_start", "billing_v2_record_dispatch", "transaction_get", "billing_v2_apply_result",
    ].toSpliced(1, 0, "billing_v2_repair_schedule"));
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.supabase.rpc).toHaveBeenCalledWith("billing_v2_reserve_original", {
      p_subscription_id: subscription.id, p_expected_version: 0,
    });
  });
  it.each([{ status: "UNAVAILABLE" }, { type: "NEQUI" }, { id: "other-source" }])(
    "unavailable/mismatched source blocks before durable send authorization %j", async (sourceOverrides) => {
      const f = fixture({ sourceOverrides });
      expect(await f.run()).toMatchObject({ failed: 1, sent: 0 });
      expect(f.supabase.rpc).not.toHaveBeenCalledWith("billing_v2_authorize_send", expect.anything());
      expect(f.supabase.rpc).not.toHaveBeenCalledWith("billing_v2_mark_uncertain", expect.anything());
    });
  it("pre-barrier acceptance failure keeps the reservation, never marks it as potentially sent", async () => {
    const f = fixture({ prepareError: new Error("opaque-fixture-secret") });
    expect(await f.run()).toMatchObject({ failed: 1, sent: 0 });
    expect(f.supabase.rpc).not.toHaveBeenCalledWith("billing_v2_authorize_send", expect.anything());
    expect(f.supabase.rpc).not.toHaveBeenCalledWith("billing_v2_mark_uncertain", expect.anything());
    expect(JSON.stringify(f.logger.log.mock.calls)).not.toContain("opaque-fixture-secret");
  });
  it("cancel-before-barrier loser never starts POST", async () => {
    const f = fixture({ rpcOverrides: { billing_v2_authorize_send: async () => ({ data: { canDispatch: false, result: "blocked" }, error: null }) } });
    expect(await f.run()).toMatchObject({ blocked: 1, sent: 0, failed: 0 });
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([
    async () => { throw new Error("disconnect-after-commit-fixture"); },
    async () => ({ data: null, error: { message: "uncertain-commit-fixture" } }),
    async () => ({ data: { canDispatch: true }, error: null }),
  ])("marks every uncertain barrier response without POST or retry", async (authorize) => {
    const f = fixture({ rpcOverrides: { billing_v2_authorize_send: authorize } });
    expect(await f.run()).toMatchObject({ failed: 1, sent: 0 });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.supabase.rpc).toHaveBeenCalledWith("billing_v2_mark_uncertain", { p_attempt_id: reservation.attemptId });
  });
  it("a barrier snapshot changed after serialization is unknown, never charged from mutable values", async () => {
    const f = fixture({ rpcOverrides: { billing_v2_authorize_send: async () => ({ data: { ...reservation,
      canDispatch: true, amount: 80000, sendAuthorizedAt: at, windowEnd: "2026-10-10T05:00:00Z" }, error: null }) } });
    expect(await f.run()).toMatchObject({ sent: 0, failed: 1 });
    expect(f.prepareTransaction).toHaveBeenCalledWith(expect.objectContaining({ amountInCents: 3000000 }));
    expect(f.send).not.toHaveBeenCalled();
  });
  it("a stale authorization cannot start after fifteen seconds", async () => {
    let reads = 0;
    const f = fixture({ clock: () => new Date(reads++ === 0 ? at : "2026-10-09T12:00:16Z") });
    expect(await f.run()).toMatchObject({ sent: 0, failed: 1 });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("timeout after start records unknown and never retries POST within the execution", async () => {
    const f = fixture({ sendError: new Error("timeout opaque-provider-body") });
    expect(await f.run()).toMatchObject({ sent: 1, approved: 0, failed: 1 });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.getTransaction).not.toHaveBeenCalled();
    expect(f.supabase.rpc).toHaveBeenCalledWith("billing_v2_mark_uncertain", { p_attempt_id: reservation.attemptId });
    expect(JSON.stringify(f.logger.log.mock.calls)).not.toContain("opaque-provider-body");
  });
  it("receipt persistence failure retains uncertainty and prevents all following originals", async () => {
    const f = fixture({ subscriptions: [subscription, { ...subscription, id: "sub-other" }], rpcOverrides: {
      billing_v2_record_dispatch: async () => ({ data: null, error: { code: "fixture" } }),
    } });
    expect(await f.run()).toMatchObject({ sent: 1, approved: 0, failed: 1 });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.supabase.rpc.mock.calls.filter(([name]) => name === "billing_v2_reserve_original")).toHaveLength(1);
  });
  it("retry queue runs before new originals and passes a distinct ordinal/reference", async () => {
    const retryCycle = { ...cycle, state: "retry_wait", retry_window_start: at, retry_window_end: "2026-10-10T05:00:00Z" };
    const retryReservation = { ...reservation, attemptId: "attempt-retry", attemptNumber: 2, reference: "fixture-retry" };
    const f = fixture({ cycles: [retryCycle], subscriptions: [{ ...subscription, status: "past_due", next_payment_date: null }], transactionOverrides: { reference: retryReservation.reference,
      status: "declined", statusMessage: VERIFIED_INSUFFICIENT_FUNDS_MESSAGE }, rpcOverrides: {
      billing_v2_authorize_send: async () => ({ data: { ...retryReservation, canDispatch: true, sendAuthorizedAt: at,
        windowEnd: "2026-10-10T05:00:00Z" }, error: null }),
    } });
    expect(await f.run()).toMatchObject({ retriesReserved: 1, sent: 1, approved: 0 });
    expect(f.supabase.rpc).toHaveBeenCalledWith("billing_v2_reserve_retry", { p_cycle_id: cycle.id });
    expect(f.prepareTransaction).toHaveBeenCalledWith(expect.objectContaining({ reference: "fixture-retry" }));
    const payload = f.supabase.rpc.mock.calls.find(([name]) => name === "billing_v2_apply_result")[1].p_transaction;
    expect(payload.retry_classification.action).toBe("manual_review");
    expect(payload.retry_classification.reason).toBe("ATTEMPT_BUDGET_EXHAUSTED");
  });
  it("one-time due rows never reserve originals or retries", async () => {
    const f = fixture({ subscriptions: [{ ...subscription, frequency: "one_time" }] });
    expect(await f.run()).toMatchObject({ due: 0, sent: 0 });
    expect(f.supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["billing_retry_schema_ready"]);
  });
  it("SQL-shaped reservation envelopes use their immutable dispatchSnapshot, not mutable subscription values", async () => {
    const f = fixture({ rpcOverrides: { billing_v2_reserve_original: async () => ({ data: {
      result: "reserved", attempt: { id: reservation.attemptId, reference: reservation.reference,
        attempt_number: 1, cycle_id: reservation.cycleId }, dispatchSnapshot: reservation,
    }, error: null }) } });
    expect(await f.run()).toMatchObject({ sent: 1, approved: 1 });
    expect(f.prepareTransaction).toHaveBeenCalledWith(expect.objectContaining({ amountInCents: 3000000 }));
    expect(f.supabase.rpc).toHaveBeenCalledWith("billing_v2_authorize_send", {
      p_attempt_id: reservation.attemptId, p_source_verification: { id: source.id, type: "CARD", status: "AVAILABLE",
        environment: "sandbox", verification_source: "provider_get", verified_at: at },
    });
  });
  it("records legacy GET evidence through the result-only bridge, without creating retry authorization", async () => {
    const f = fixture({ attempts: [{ ...attempt, cycle_id: null, attempt_number: null, dispatch_snapshot: null }] });
    expect(await f.run({ mode: "reconcile" })).toMatchObject({ reconciled: 1, sent: 0, blocked: 1 });
    expect(f.supabase.rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_transaction_id: transaction.id, p_candidate_next_payment: null,
      p_raw: expect.objectContaining({ source: "monthly_job_v040_legacy", verification_source: "provider_get" }),
    }));
    expect(f.supabase.rpc).not.toHaveBeenCalledWith("billing_v2_apply_result", expect.anything());
    expect(f.getPaymentSource).not.toHaveBeenCalled();
  });
  it.each(["charge", "reconcile"])("expires a missed retry window in %s without reserving or sending", async (mode) => {
    const expiredCycle = { ...cycle, state: "retry_wait", retry_window_start: "2026-10-07T12:00:00Z",
      retry_window_end: "2026-10-08T05:00:00Z" };
    const f = fixture({ cycles: [expiredCycle], subscriptions: [], rpcOverrides: {
      billing_v2_expire_retry: async () => {
        expiredCycle.state = "manual_review";
        return { data: { result: "expired" }, error: null };
      },
    } });
    expect(await f.run({ mode })).toMatchObject({ sent: 0, blocked: 1 });
    expect(f.supabase.rpc).toHaveBeenCalledWith("billing_v2_expire_retry", { p_cycle_id: cycle.id });
    expect(f.supabase.rpc).not.toHaveBeenCalledWith("billing_v2_reserve_retry", expect.anything());
    expect(f.prepareTransaction).not.toHaveBeenCalled();
  });
  it.each(["charge", "reconcile"])("repairs a confirmed future agenda in %s, without a new charge", async (mode) => {
    const f = fixture({ rpcOverrides: { billing_v2_repair_schedule: async () => ({ data: { result: "changed" }, error: null }) } });
    expect(await f.run({ mode })).toMatchObject({ sent: 0, reconciled: 1 });
    expect(f.supabase.rpc).toHaveBeenCalledWith("billing_v2_repair_schedule", {
      p_subscription_id: subscription.id, p_expected_version: subscription.billing_version,
    });
    expect(f.supabase.rpc).not.toHaveBeenCalledWith("billing_v2_reserve_original", expect.anything());
    expect(f.prepareTransaction).not.toHaveBeenCalled();
  });
  it("an ambiguous/unavailable schedule repair blocks rather than charging blind", async () => {
    const f = fixture({ rpcOverrides: { billing_v2_repair_schedule: async () => ({ data: null, error: { code: "PGRST202" } }) } });
    expect(await f.run()).toMatchObject({ sent: 0, failed: 1 });
    expect(f.prepareTransaction).not.toHaveBeenCalled();
  });
  it("never forwards invalid non-UTC provider dates as usable SQL retry evidence", async () => {
    const f = fixture({ cycles: [cycle], attempts: [attempt], transactionOverrides: { status: "declined",
      statusMessage: VERIFIED_INSUFFICIENT_FUNDS_MESSAGE, finalizedAt: "2026-10-08T14:00:00" } });
    await f.run({ mode: "reconcile" });
    const payload = f.supabase.rpc.mock.calls.find(([name]) => name === "billing_v2_apply_result")[1].p_transaction;
    expect(payload.finalized_at).toBeNull();
    expect(payload.retry_classification.reason).toBe("FINALIZED_AT_NOT_VERIFIED");
  });
  it("one-time widget results without payment_source_id are recorded, never made recurring", async () => {
    const oneTime = { ...subscription, frequency: "one_time", next_payment_date: null };
    const f = fixture({ subscriptions: [oneTime], attempts: [{ ...attempt, cycle_id: null,
      dispatch_snapshot: { ...reservation, frequency: "one_time", paymentSourceId: null } }],
    transactionOverrides: { paymentSourceId: null } });
    expect(await f.run({ mode: "reconcile" })).toMatchObject({ sent: 0, approved: 1, failed: 0 });
    const payload = f.supabase.rpc.mock.calls.find(([name]) => name === "billing_v2_apply_result")[1].p_transaction;
    expect(payload.retry_classification.reason).toBe("ONE_TIME_NO_AUTOMATIC_RETRY");
    expect(f.getPaymentSource).not.toHaveBeenCalled();
  });
  it("unlinked historical pending payments reconcile using stored reference/money, with no automatic retry", async () => {
    const f = fixture({ payments: [{ id: "payment-historical", subscription_id: subscription.id,
      payment_attempt_id: null, reference: reservation.reference, amount: 30000, currency: "COP",
      status: "pending", wompi_transaction_id: transaction.id }] });
    expect(await f.run({ mode: "reconcile" })).toMatchObject({ payments: 1, reconciled: 1, sent: 0, blocked: 1 });
    expect(f.supabase.rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_candidate_next_payment: null, p_amount: 30000, p_reference: reservation.reference,
    }));
    expect(f.getPaymentSource).not.toHaveBeenCalled();
  });
  it("unknown historical references cannot be invented from provider response", async () => {
    const f = fixture({ payments: [{ id: "payment-historical", subscription_id: subscription.id,
      payment_attempt_id: null, reference: null, amount: 30000, currency: "COP",
      status: "pending", wompi_transaction_id: transaction.id }] });
    expect(await f.run()).toMatchObject({ failed: 1, sent: 0 });
    expect(f.supabase.rpc).not.toHaveBeenCalledWith("apply_verified_wompi_event", expect.anything());
  });
  it("a same-month repair cannot open another original even with an expired input date", async () => {
    const f = fixture({ rpcOverrides: { billing_v2_repair_schedule: async () => ({ data: { result: "repaired",
      nextPaymentDate: "2026-11-06T12:00:00Z" }, error: null }) } });
    expect(await f.run()).toMatchObject({ repaired: 1, sent: 0 });
    expect(f.supabase.rpc).not.toHaveBeenCalledWith("billing_v2_reserve_original", expect.anything());
  });
});
