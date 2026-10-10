import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), acceptance: vi.fn(), source: vi.fn(), sourceAvailable: vi.fn(),
  create: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getServiceSupabaseClient: mocks.client }));
vi.mock("@/lib/wompi-server", () => ({ getWompiAcceptance: mocks.acceptance, createWompiPaymentSource: mocks.source,
  isWompiPaymentSourceAvailable: mocks.sourceAvailable, createWompiTransaction: mocks.create, getWompiTransaction: mocks.get,
  createWompiIntegritySignature: () => "fixture-integrity-signature" }));
import { POST } from "./route";

const now = "2026-10-08T18:00:00.000Z";
const donor = { firstName: "Fictitious", lastName: "Donor", email: "browser-claim@example.test", phone: "3000000000",
  documentType: "CC", documentNumber: "00000", city: "Bogota", wantsUpdates: false, isRecurring: true, preferredPaymentDay: 16 };
const transaction = { id: "tx-extra-fixture", reference: "HPE-EXTRA-FIXTURE", amountInCents: 3000000,
  currency: "COP", paymentSourceId: "source-extra-fixture", paymentMethodType: "CARD", status: "approved", finalizedAt: now };
const body = () => ({ stage: "confirm", donor, amount: 30000, paymentMethod: "card", checkoutToken: "x".repeat(48),
  wompi: { reference: "HPE-EXTRA-FIXTURE", cardToken: "tok_test_extra_fixture" } });
const request = (value: unknown = body()) => new Request("http://127.0.0.1:3000/api/donations", { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
let intent: Record<string, unknown>;
let existingAttempt: { id: string; subscription_id: string; state: string; wompi_transaction_id: string | null; attempt_number: number | null } | null;
let subscription: Record<string, unknown>;
let sourceId: string | null;
let writes: { table: string; value: Record<string, unknown> }[];
let selections: { table: string; columns: string }[];
let subscriptionError: { code: string } | null;
let queryFailures: Record<string, "error" | "throw">;
let rpc: Mock<(...args: any[]) => Promise<any>>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("APP_OPERATION_MODE", "active");
  vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "true");
  vi.stubEnv("CHECKOUT_TOKEN_PEPPER", "fixture-private-pepper-at-least-32-chars");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call in local donation fixture"); }));
  intent = { id: "checkout-extra-fixture", donor_id: "donor-extra-fixture", reference: "HPE-EXTRA-FIXTURE",
    amount: 30000, currency: "COP", is_recurring: true, environment: "sandbox", state: "checkout", expires_at: "2026-10-08T18:30:00Z" };
  sourceId = "source-extra-fixture";
  existingAttempt = null;
  subscriptionError = null;
  queryFailures = {};
  subscription = { id: "sub-extra-fixture", donor_id: intent.donor_id, reference: intent.reference,
    amount: intent.amount, currency: intent.currency, frequency: "monthly", wompi_payment_source_id: sourceId };
  writes = [];
  selections = [];
  const from = (table: string) => {
    const query = { select: (columns: string) => { selections.push({ table, columns }); return query; }, eq: () => query,
      insert: (value: Record<string, unknown>) => { writes.push({ table, value }); return Promise.resolve({ error: null }); },
      maybeSingle: async () => {
        if (queryFailures[table] === "throw") throw new Error("Fixture database read failed");
        if (queryFailures[table] === "error") return { data: null, error: { code: "fixture-read-error" } };
        return { data: table === "checkout_intents" ? intent
        : table === "donors" ? { id: "donor-extra-fixture", email: "stored-donor@example.test" }
        : table === "payment_attempts" ? existingAttempt : table === "subscriptions" ? subscription : null,
        error: table === "subscriptions" ? subscriptionError : null };
      } };
    return query;
  };
  rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    if (["billing_retry_schema_ready", "consume_api_rate_limit"].includes(name)) return { data: true, error: null };
    if (name === "billing_v2_prepare_subscription") return { data: { id: "sub-extra-fixture", wompi_payment_source_id: sourceId }, error: null };
    if (name === "billing_v2_reserve_initial") return { data: { result: "reserved", attempt: { id: "attempt-extra-fixture", attempt_number: 1 },
      dispatchSnapshot: { attemptId: "attempt-extra-fixture" } }, error: null };
    if (name === "billing_v2_authorize_send") return { data: { canDispatch: true, reference: "HPE-EXTRA-FIXTURE",
      amount: 30000, currency: "COP", paymentSourceId: "source-extra-fixture", customerEmail: "stored-donor@example.test",
      sendAuthorizedAt: now, windowEnd: null }, error: null };
    if (name === "billing_v2_apply_result") {
      if (existingAttempt && ![1, 2].includes(existingAttempt.attempt_number!)) return { data: null, error: { code: "LEGACY_ATTEMPT_REQUIRES_LEGACY_RESULT" } };
      return { data: { result: "processed", subscriptionId: "sub-extra-fixture" }, error: null };
    }
    if (name === "apply_verified_wompi_event") {
      if (existingAttempt?.attempt_number !== null) throw new Error("Legacy fixture requires an explicit NULL ordinal");
      return { data: { result: "review", historicalOnly: true, scheduleProtected: true }, error: null };
    }
    if (["billing_v2_bind_source", "billing_v2_record_dispatch", "billing_v2_mark_uncertain"].includes(name)) return { data: { result: "recorded" }, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  mocks.client.mockReturnValue({ from, rpc });
  mocks.acceptance.mockResolvedValue({ acceptanceToken: "fixture-acceptance", acceptPersonalAuth: "fixture-personal-acceptance",
    acceptancePermalink: "https://example.test/terms", personalDataAuthPermalink: "https://example.test/privacy" });
  mocks.source.mockResolvedValue({ id: "source-extra-fixture", type: "CARD", status: "AVAILABLE" });
  mocks.sourceAvailable.mockResolvedValue(true);
  mocks.create.mockResolvedValue(transaction);
  mocks.get.mockResolvedValue(transaction);
});

const priorAttempt = (attemptNumber: number | null, state = "pending", transactionId: string | null = transaction.id) => ({
  id: "attempt-extra-fixture", subscription_id: "sub-extra-fixture", state,
  wompi_transaction_id: transactionId, attempt_number: attemptNumber,
});
const claimedBody = (oneTime = false) => ({ ...body(), donor: { ...donor, isRecurring: !oneTime },
  wompi: { reference: transaction.reference, transactionId: transaction.id } });
const financialWrites = () => [...writes, ...rpc.mock.calls
  .filter(([name]) => !["billing_retry_schema_ready", "consume_api_rate_limit"].includes(name))
  .map(([name, value]) => ({ rpc: name, value }))];
const expectNoSend = () => {
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.source).not.toHaveBeenCalled();
  expect(mocks.sourceAvailable).not.toHaveBeenCalled();
  for (const name of ["billing_v2_prepare_subscription", "billing_v2_bind_source", "billing_v2_reserve_initial",
    "billing_v2_authorize_send", "billing_v2_record_dispatch", "billing_v2_mark_uncertain"]) {
    expect(rpc).not.toHaveBeenCalledWith(name, expect.anything());
  }
  expect(writes).toEqual([]);
  expect(rpc.mock.calls.filter(([name]) => name === "consume_api_rate_limit")).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("v2 donation lifecycle safety regressions with local fixtures", () => {
  it.each([true, false])("keeps reconciliation when the rate-limit request rejects, browserClaim=%s", async (browserClaim) => {
    existingAttempt = priorAttempt(1);
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => {
      if (name === "consume_api_rate_limit") throw new Error("Fixture rate-limit transport failed");
      return original(name, args);
    });
    const response = await POST(request(browserClaim ? claimedBody() : body()));
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
    expect(result).not.toHaveProperty("transactionId");
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["billing_retry_schema_ready", "consume_api_rate_limit"]);
    expect(mocks.get).not.toHaveBeenCalled();
    expectNoSend();
  });

  it.each(["checkout_intents", "payment_attempts"].flatMap((table) =>
    ["error", "throw"].flatMap((failure) => [true, false].map((browserClaim) => ({ table, failure, browserClaim })))))(
    "preserves a possibly submitted checkout on database read failure %j", async ({ table, failure, browserClaim }) => {
      existingAttempt = priorAttempt(1);
      queryFailures[table] = failure as "error" | "throw";
      const response = await POST(request(browserClaim ? claimedBody() : body()));
      expect(response.status).toBe(202);
      const result = await response.json();
      expect(result).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
      expect(result).not.toHaveProperty("transactionId");
      expect(result.code).not.toBe("checkout_restart_required");
      expect(mocks.get).not.toHaveBeenCalled();
      expectNoSend();
    },
  );

  it.each(["draft", "checkout", "confirm"].flatMap((stage) => ["denied", "error"].map((outcome) => ({ stage, outcome }))))(
    "blocks all provider calls and financial writes when the initial limiter returns %j", async ({ stage, outcome }) => {
      existingAttempt = priorAttempt(1);
      mocks.get.mockRejectedValue(new Error("A rate-limited request must not reach provider GET"));
      const original = rpc.getMockImplementation()!;
      rpc.mockImplementation(async (name, args) => name === "consume_api_rate_limit"
        ? { data: false, error: outcome === "error" ? { code: "fixture-rate-error" } : null } : original(name, args));
      const response = await POST(request({ ...body(), stage }));
      expect(response.status).toBe(429);
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.acceptance).not.toHaveBeenCalled();
      expect(selections).toEqual([]);
      expect(financialWrites()).toEqual([]);
      expect(rpc.mock.calls.map(([name]) => name)).toEqual(["billing_retry_schema_ready", "consume_api_rate_limit"]);
      expect(rpc).toHaveBeenCalledWith("consume_api_rate_limit", expect.objectContaining({
        p_scope: `donation_${stage}`, p_limit: stage === "draft" ? 30 : 10, p_window_seconds: 600,
      }));
      expectNoSend();
    });

  it.each(["draft", "checkout", "confirm"])("consumes the persistent counter exactly once at the start of a successful %s request", async (stage) => {
    if (stage === "confirm") existingAttempt = priorAttempt(1);
    const response = await POST(request({ ...body(), stage }));
    expect(response.status).toBe(200);
    expect(rpc.mock.calls.slice(0, 2).map(([name]) => name)).toEqual(["billing_retry_schema_ready", "consume_api_rate_limit"]);
    expect(rpc.mock.calls.filter(([name]) => name === "consume_api_rate_limit")).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["stored_v2", "stored_legacy", "browser", "widget"])("retains the checkout on repeated %s GET failures with one counter consumption per request", async (mode) => {
    existingAttempt = priorAttempt(mode === "stored_legacy" ? null : 1, "pending",
      mode === "browser" || mode === "widget" ? null : transaction.id);
    if (mode === "widget") {
      intent.is_recurring = false;
      subscription.frequency = "one_time";
    }
    const originalIntent = { ...intent };
    const originalAttempt = { ...existingAttempt };
    mocks.get.mockRejectedValue(new Error("fixture repeated GET failure"));
    for (let index = 0; index < 3; index++) {
      const countersBefore = rpc.mock.calls.filter(([name]) => name === "consume_api_rate_limit").length;
      const response = await POST(request(mode === "browser" || mode === "widget" ? claimedBody(mode === "widget") : body()));
      expect(response.status).toBe(202);
      const result = await response.json();
      expect(result).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
      if (originalAttempt.wompi_transaction_id) expect(result.transactionId).toBe(transaction.id);
      else expect(result).not.toHaveProperty("transactionId");
      expect(rpc.mock.calls.filter(([name]) => name === "consume_api_rate_limit")).toHaveLength(countersBefore + 1);
      expect(financialWrites()).toEqual([]);
      expect(intent).toEqual(originalIntent);
      expect(existingAttempt).toEqual(originalAttempt);
    }
    expect(mocks.get).toHaveBeenCalledTimes(3);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.sourceAvailable).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops subsequent provider GETs when repeated GET failures exhaust the persistent limiter", async () => {
    existingAttempt = priorAttempt(1);
    mocks.get.mockRejectedValue(new Error("fixture limited repeated GET failure"));
    const original = rpc.getMockImplementation()!;
    let consumed = 0;
    rpc.mockImplementation(async (name, args) => name === "consume_api_rate_limit"
      ? { data: ++consumed <= 2, error: null } : original(name, args));
    for (let index = 0; index < 3; index++) {
      const response = await POST(request());
      expect(response.status).toBe(index < 2 ? 202 : 429);
      if (index < 2) expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
      expect(rpc.mock.calls.filter(([name]) => name === "consume_api_rate_limit")).toHaveLength(index + 1);
    }
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(financialWrites()).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([1, null])("applies the immutable checkout amount for ordinal %s even after an admin changes the next contribution", async (attemptNumber) => {
    existingAttempt = priorAttempt(attemptNumber);
    subscription.amount = 50000;
    const response = await POST(request());
    expect(response.status).toBe(attemptNumber === null ? 202 : 200);
    if (attemptNumber === null) {
      expect(rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({ p_amount: 30000 }));
    } else {
      expect(rpc).toHaveBeenCalledWith("billing_v2_apply_result", expect.objectContaining({
        p_transaction: expect.objectContaining({ amount_in_cents: 3000000 }),
      }));
    }
    expect(subscription.amount).toBe(50000);
    expect(intent.amount).toBe(30000);
    expectNoSend();
  });

  it.each([1, null])("rejects provider evidence using the next contribution instead of the immutable checkout for ordinal %s", async (attemptNumber) => {
    existingAttempt = priorAttempt(attemptNumber);
    subscription.amount = 50000;
    mocks.get.mockResolvedValue({ ...transaction, amountInCents: 5000000 });
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "transaction_mismatch" });
    expect(financialWrites()).toEqual([]);
    expectNoSend();
  });

  it.each([
    { finalizedAt: now, expected: now },
    { finalizedAt: null, expected: null },
    { finalizedAt: "invalid-fixture-date", expected: null },
  ])("uses only the verified finalization date for nullable legacy provider metadata: %j", async ({ finalizedAt, expected }) => {
    existingAttempt = priorAttempt(null);
    mocks.get.mockResolvedValue({ ...transaction, finalizedAt, paymentMethodType: null });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_effective_at: expected, p_candidate_next_payment: null,
    }));
    expectNoSend();
  });

  it.each([1, null])("keeps a stored transaction pending after GET failure for attempt_number=%s without uncertainty writes", async (attemptNumber) => {
    existingAttempt = priorAttempt(attemptNumber);
    mocks.get.mockRejectedValue(new Error("fixture prior GET failed"));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required", transactionId: transaction.id });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(transaction.id);
    expectNoSend();
    expect(financialWrites()).toEqual([]);
  });

  it("rejects a mismatched provider source on a stored transaction with complete subscription identity", async () => {
    existingAttempt = priorAttempt(1);
    mocks.get.mockResolvedValue({ ...transaction, paymentSourceId: "foreign-stored-source-fixture" });
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "transaction_mismatch" });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(transaction.id);
    expect(financialWrites()).toEqual([]);
    expectNoSend();
  });

  it("reconfirms a known v2 transaction after checkout expiry with complete persisted identity", async () => {
    existingAttempt = priorAttempt(1);
    intent.expires_at = "2026-10-08T17:00:00Z";
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "subscription_created", transactionId: transaction.id });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(transaction.id);
    expect(rpc).toHaveBeenCalledWith("billing_v2_apply_result", expect.objectContaining({ p_attempt_id: existingAttempt.id }));
    expectNoSend();
  });

  it.each([1, null])("keeps a stored transaction pending after apply failure for attempt_number=%s", async (attemptNumber) => {
    existingAttempt = priorAttempt(attemptNumber);
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => ["billing_v2_apply_result", "apply_verified_wompi_event"].includes(name)
      ? { data: null, error: { code: "fixture-apply-failed" } } : original(name, args));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required", transactionId: transaction.id });
    expectNoSend();
  });

  it.each(["dispatching", "unknown", "pending", "prepared"])("recovers a browser transaction on an existing %s attempt without another POST", async (state) => {
    existingAttempt = priorAttempt(1, state, null);
    const response = await POST(request(claimedBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "subscription_created", transactionId: transaction.id });
    expect(rpc).toHaveBeenCalledWith("billing_v2_apply_result", expect.objectContaining({ p_attempt_id: existingAttempt.id }));
    expectNoSend();
  });

  it.each(["get", "apply"])("keeps claimed browser recovery pending on %s failure without echoing the claim", async (failure) => {
    existingAttempt = priorAttempt(1, "unknown", null);
    if (failure === "get") mocks.get.mockRejectedValue(new Error("fixture browser GET failed"));
    else {
      const original = rpc.getMockImplementation()!;
      rpc.mockImplementation(async (name, args) => name === "billing_v2_apply_result"
        ? { data: null, error: null } : original(name, args));
    }
    const response = await POST(request(claimedBody()));
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
    expect(result).not.toHaveProperty("transactionId");
    expectNoSend();
  });

  it.each(["get", "apply", "success"])("recovers a browser legacy transaction with %s outcome without adopting send ownership", async (outcome) => {
    existingAttempt = priorAttempt(null, "unknown", null);
    if (outcome === "get") mocks.get.mockRejectedValue(new Error("fixture legacy recovery GET failed"));
    if (outcome === "apply") {
      const original = rpc.getMockImplementation()!;
      rpc.mockImplementation(async (name, args) => name === "apply_verified_wompi_event"
        ? { data: null, error: null } : original(name, args));
    }
    const response = await POST(request(claimedBody()));
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
    expect(result).not.toHaveProperty("transactionId");
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_apply_result", expect.anything());
    expectNoSend();
  });

  it.each(["get", "apply", "success"])("confirms an already charged one-time widget with %s outcome and no second POST", async (outcome) => {
    intent.is_recurring = false;
    subscription.frequency = "one_time";
    existingAttempt = priorAttempt(1, "prepared", null);
    if (outcome === "get") mocks.get.mockRejectedValue(new Error("fixture widget GET failed"));
    if (outcome === "apply") {
      const original = rpc.getMockImplementation()!;
      rpc.mockImplementation(async (name, args) => name === "billing_v2_apply_result"
        ? { data: null, error: { code: "fixture-widget-apply-failed" } } : original(name, args));
    }
    const response = await POST(request(claimedBody(true)));
    expect(response.status).toBe(outcome === "success" ? 200 : 202);
    const result = await response.json();
    expect(result.status).toBe(outcome === "success" ? "subscription_created" : "payment_pending");
    if (outcome !== "success") {
      expect(result.code).toBe("reconciliation_required");
      expect(result).not.toHaveProperty("transactionId");
    }
    expectNoSend();
  });

  it.each([
    { result: "review", scheduleProtected: true, historicalOnly: true },
    { result: "duplicate", scheduleProtected: true, historicalOnly: true },
    { result: "processed", scheduleProtected: true },
    { result: "processed", historicalOnly: true },
  ])("routes explicit legacy NULL ordinals through the verified historical bridge: %j", async (applied) => {
    existingAttempt = priorAttempt(null);
    intent.expires_at = "2026-10-08T17:59:59Z";
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => name === "apply_verified_wompi_event"
      ? { data: applied, error: null } : original(name, args));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
    expect(selections).toContainEqual({ table: "payment_attempts", columns: expect.stringContaining("attempt_number") });
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_apply_result", expect.anything());
    expect(rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_transaction_id: transaction.id, p_reference: transaction.reference, p_amount: 30000, p_currency: "COP",
      p_payment_source_id: transaction.paymentSourceId, p_status: "approved", p_effective_at: now,
      p_candidate_next_payment: null, p_raw: expect.objectContaining({ verification_source: "provider_get", environment: "sandbox",
        transaction: expect.objectContaining({ id: transaction.id, reference: transaction.reference, amount_in_cents: 3000000 }) }),
    }));
    expectNoSend();
  });

  it.each([1, null].flatMap((attemptNumber) => ["id", "reference", "amountInCents", "currency", "paymentSourceId"]
    .map((field) => ({ attemptNumber, field }))))("rejects foreign browser evidence %j with zero financial mutations", async ({ attemptNumber, field }) => {
    existingAttempt = priorAttempt(attemptNumber, "unknown", null);
    mocks.get.mockResolvedValue({ ...transaction, [field]: field === "amountInCents" ? 100000 : "foreign-fixture" });
    const response = await POST(request(claimedBody()));
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result).not.toHaveProperty("transactionId");
    expect(result.code).not.toBe("checkout_restart_required");
    expect(financialWrites()).toEqual([]);
    expectNoSend();
  });

  it.each(["id", "reference", "amountInCents", "currency"])("rejects an unrelated widget transaction with mismatched %s and zero financial writes", async (field) => {
    intent.is_recurring = false;
    subscription.frequency = "one_time";
    existingAttempt = priorAttempt(1, "prepared", null);
    mocks.get.mockResolvedValue({ ...transaction, [field]: field === "amountInCents" ? 100000 : "foreign-widget-fixture" });
    const response = await POST(request(claimedBody(true)));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "transaction_mismatch" }));
    expect(financialWrites()).toEqual([]);
    expectNoSend();
  });

  it("retains a stored ID instead of echoing an unverified competing browser claim", async () => {
    existingAttempt = priorAttempt(1);
    mocks.get.mockRejectedValue(new Error("fixture stored GET failed"));
    const payload = claimedBody();
    payload.wompi.transactionId = "foreign-unverified-claim";
    const response = await POST(request(payload));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ transactionId: transaction.id, code: "reconciliation_required" });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(transaction.id);
    expectNoSend();
  });

  it("preserves prior-send knowledge when the read-only subscription lookup fails", async () => {
    existingAttempt = priorAttempt(1);
    subscriptionError = { code: "fixture-subscription-read-failed" };
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required", transactionId: transaction.id });
    expect(financialWrites()).toEqual([]);
    expectNoSend();
  });

  it.each(["id", "donor_id", "reference", "currency", "frequency"])("does not apply evidence to a conflicting stored subscription %s", async (field) => {
    existingAttempt = priorAttempt(1);
    subscription[field] = "conflicting-subscription-fixture";
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
    expect(financialWrites()).toEqual([]);
    expectNoSend();
  });

  it.each(["get", "apply"])("still persists uncertainty for this request's own dispatched transaction on %s failure", async (failure) => {
    if (failure === "get") mocks.get.mockRejectedValue(new Error("fixture own dispatch GET failed"));
    else {
      const original = rpc.getMockImplementation()!;
      rpc.mockImplementation(async (name, args) => name === "billing_v2_apply_result"
        ? { data: null, error: { code: "fixture-own-apply-failed" } } : original(name, args));
    }
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required", transactionId: transaction.id });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.filter(([name]) => name === "billing_v2_record_dispatch")).toEqual([
      ["billing_v2_record_dispatch", { p_attempt_id: "attempt-extra-fixture", p_transaction_id: transaction.id, p_status: "approved" }],
      ["billing_v2_record_dispatch", { p_attempt_id: "attempt-extra-fixture", p_transaction_id: transaction.id, p_status: "pending" }],
    ]);
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_mark_uncertain", expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never treats a missing attempt ordinal as implicit legacy data", async () => {
    existingAttempt = priorAttempt(1);
    Reflect.deleteProperty(existingAttempt, "attempt_number");
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
    expect(rpc).not.toHaveBeenCalledWith("apply_verified_wompi_event", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_apply_result", expect.anything());
    expectNoSend();
  });

  it("does not send again when a claimed transaction has no recoverable attempt", async () => {
    const response = await POST(request(claimedBody()));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
    expectNoSend();
  });

  it.each(["dispatching", "unknown", "pending"])("keeps an existing %s attempt without a transaction in reconciliation", async (state) => {
    existingAttempt = priorAttempt(1, state, null);
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "payment_pending", code: "reconciliation_required" });
    expect(mocks.get).not.toHaveBeenCalled();
    expectNoSend();
  });

  it("tokenizes for the stored donor email rather than the browser email claim", async () => {
    sourceId = null;
    expect((await POST(request())).status).toBe(200);
    expect(mocks.source).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ customerEmail: "stored-donor@example.test" }));
    expect(mocks.source).not.toHaveBeenCalledWith(expect.objectContaining({ customerEmail: donor.email }));
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ customerEmail: "stored-donor@example.test" }));
    expect(rpc).toHaveBeenCalledWith("billing_v2_bind_source", expect.objectContaining({ p_source_verified: true }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an expired new checkout before tokenization, source GET, reservation or financial POST", async () => {
    intent.expires_at = "2026-10-08T17:59:59Z";
    sourceId = null;
    expect((await POST(request())).status).toBe(400);
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.sourceAvailable).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_reserve_initial", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_authorize_send", expect.anything());
  });

  it("rechecks source availability after reservation and fails before the send barrier when the GET fails", async () => {
    mocks.sourceAvailable.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("fixture source GET failed"));
    expect((await POST(request())).status).toBe(400);
    expect(rpc).toHaveBeenCalledWith("billing_v2_reserve_initial", expect.anything());
    expect(mocks.sourceAvailable).toHaveBeenCalledTimes(2);
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_authorize_send", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_mark_uncertain", expect.anything());
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([{ type: "BANK_ACCOUNT", status: "AVAILABLE" }, { type: "CARD", status: "UNAVAILABLE" }])(
    "does not bind or dispatch a newly tokenized non-valid CARD source %j", async (provider) => {
      sourceId = null;
      mocks.source.mockResolvedValue({ id: "source-extra-fixture", ...provider });
      expect((await POST(request())).status).toBe(400);
      expect(rpc).not.toHaveBeenCalledWith("billing_v2_bind_source", expect.anything());
      expect(rpc).not.toHaveBeenCalledWith("billing_v2_authorize_send", expect.anything());
      expect(mocks.create).not.toHaveBeenCalled();
    });

  it("never stores a retry authorization for a one-time draft even when the browser checks retry consent", async () => {
    const response = await POST(request({ stage: "draft", donor: { ...donor, isRecurring: false, retryAuthorizationConfirmed: true }, amount: 30000 }));
    expect(response.status).toBe(200);
    expect(writes.find(({ table }) => table === "checkout_intents")?.value).toMatchObject({
      is_recurring: false, preferred_payment_day: null, retry_authorization: null,
    });
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_reserve_initial", expect.anything());
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a browser recurrence change against the stored one-time intent before source or charge operations", async () => {
    intent.is_recurring = false;
    expect((await POST(request())).status).toBe(400);
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_prepare_subscription", expect.anything());
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.sourceAvailable).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not start a financial POST at the exact end of the granted window", async () => {
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => name === "billing_v2_authorize_send"
      ? { data: { canDispatch: true, reference: "HPE-EXTRA-FIXTURE", amount: 30000, currency: "COP",
        paymentSourceId: "source-extra-fixture", customerEmail: "stored-donor@example.test", sendAuthorizedAt: now, windowEnd: now }, error: null }
      : original(name, args));
    expect((await POST(request())).status).toBe(202);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("billing_v2_mark_uncertain", { p_attempt_id: "attempt-extra-fixture" });
  });
});
