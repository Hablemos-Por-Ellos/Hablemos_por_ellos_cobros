import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), acceptance: vi.fn(), source: vi.fn(), sourceAvailable: vi.fn(), create: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getServiceSupabaseClient: mocks.client }));
vi.mock("@/lib/wompi-server", () => ({ getWompiAcceptance: mocks.acceptance, createWompiPaymentSource: mocks.source,
  isWompiPaymentSourceAvailable: mocks.sourceAvailable, createWompiTransaction: mocks.create, getWompiTransaction: mocks.get,
  createWompiIntegritySignature: () => "fixture-server-signature" }));
import { POST } from "./route";

const now = "2026-10-08T18:00:00.000Z";
const donor = { firstName: "Only", lastName: "Fixture", email: "fixture@example.test", phone: "3000000000",
  documentType: "CC", documentNumber: "00000", city: "Bogota", wantsUpdates: false, isRecurring: true, preferredPaymentDay: 16 };
let rows: Record<string, any>;
let rpc: Mock<(...args: any[]) => Promise<any>>;
let writes: { table: string; value: unknown }[];
const transaction = () => ({ id: "tx-fixture", reference: "HPE-FIXTURE", amountInCents: 3000000, currency: "COP",
  paymentSourceId: "source-fixture", paymentMethodType: "CARD", status: "approved", finalizedAt: now });
const body = () => ({ stage: "confirm", donor, amount: 30000, paymentMethod: "card", checkoutToken: "x".repeat(48),
  wompi: { reference: "HPE-FIXTURE", cardToken: "tok_test_fixture" } });
const request = (value: any = body()) => new Request("http://127.0.0.1:3000/api/donations", { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv("APP_OPERATION_MODE", "active"); vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "true");
  vi.stubEnv("CHECKOUT_TOKEN_PEPPER", "fixture-private-pepper-at-least-32-chars");
  rows = { donors: { id: "donor-fixture" }, checkout_intents: { id: "checkout-fixture", donor_id: "donor-fixture", reference: "HPE-FIXTURE",
    amount: 30000, currency: "COP", is_recurring: true, environment: "sandbox", state: "checkout", expires_at: "2026-10-08T18:30:00Z" }, payment_attempts: null };
  writes = [];
  const from = (table: string) => {
    const query: any = { select: () => query, eq: () => query,
      insert: (value: unknown) => { writes.push({ table, value }); return Promise.resolve({ error: null }); },
      maybeSingle: async () => ({ data: rows[table], error: null }) };
    return query;
  };
  rpc = vi.fn(async (name: string) => {
    if (["billing_retry_schema_ready", "consume_api_rate_limit"].includes(name)) return { data: true, error: null };
    if (name === "billing_v2_prepare_subscription") return { data: { id: "sub-fixture", wompi_payment_source_id: "source-fixture" }, error: null };
    if (name === "billing_v2_reserve_initial") return { data: { result: "reserved", attempt: { id: "attempt-fixture" },
      dispatchSnapshot: { attemptId: "attempt-fixture" } }, error: null };
    if (name === "billing_v2_authorize_send") return { data: { canDispatch: true, reference: "HPE-FIXTURE", amount: 30000, currency: "COP",
      paymentSourceId: "source-fixture", customerEmail: "stored@example.test", sendAuthorizedAt: now, windowEnd: null }, error: null };
    if (name === "billing_v2_apply_result") return { data: { result: "processed", subscriptionId: "sub-fixture" }, error: null };
    return { data: { result: "recorded" }, error: null };
  });
  mocks.client.mockReturnValue({ from, rpc });
  mocks.acceptance.mockResolvedValue({ acceptanceToken: "fixture", acceptPersonalAuth: "fixture", acceptancePermalink: "https://example.test/terms", personalDataAuthPermalink: "https://example.test/privacy" });
  mocks.source.mockResolvedValue({ id: "source-fixture", type: "CARD", status: "AVAILABLE" });
  mocks.sourceAvailable.mockResolvedValue(true); mocks.create.mockResolvedValue(transaction()); mocks.get.mockResolvedValue(transaction());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("v0.4.0 real HTTP checkout contract (fictitious dependencies only)", () => {
  it("blocks maintenance before clients or provider calls", async () => {
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "false");
    expect((await POST(request())).status).toBe(503); expect(mocks.client).not.toHaveBeenCalled();
  });
  it("requires v2 readiness without falling back to a legacy writer", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect((await POST(request())).status).toBe(503); expect(mocks.create).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("billing_retry_schema_ready");
  });
  it.each([true, false, undefined])("persists only explicit recurring retry consent %s", async (retryAuthorizationConfirmed) => {
    const response = await POST(request({ stage: "draft", donor: { ...donor, retryAuthorizationConfirmed }, amount: 30000 }));
    expect(response.status).toBe(200);
    const intent: any = writes.find((row) => row.table === "checkout_intents")?.value;
    expect(intent.retry_authorization).toEqual(retryAuthorizationConfirmed === true
      ? { version: "0.4.0", recurring: true, retryAllowed: true, acceptedAt: now } : null);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("uses server snapshot values and obtains acceptance before the send barrier", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ amountInCents: 3000000, customerEmail: "stored@example.test", reference: "HPE-FIXTURE", recurrent: true }));
    expect(mocks.acceptance.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex(([name]) => name === "billing_v2_authorize_send")]);
    expect(writes.filter(({ table }) => ["subscriptions", "payment_attempts", "payments"].includes(table))).toEqual([]);
  });
  it("requires matching nested reservation and snapshot IDs before authorizing a send", async () => {
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => name === "billing_v2_reserve_initial"
      ? { data: { result: "reserved", attempt: { id: "attempt-fixture" }, dispatchSnapshot: { attemptId: "foreign" } }, error: null }
      : base(name, args));
    expect((await POST(request())).status).toBe(400);
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_authorize_send", expect.anything());
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["reference", "amountInCents", "currency", "paymentSourceId"])("rejects a verified mismatch in %s before application", async (field) => {
    rows.payment_attempts = { id: "attempt-fixture", state: "pending", wompi_transaction_id: "tx-fixture" };
    mocks.get.mockResolvedValue({ ...transaction(), [field]: "wrong" });
    expect((await POST(request())).status).toBe(400);
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_apply_result", expect.anything()); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("ignores a browser supplied source identifier", async () => {
    const input = body(); (input.wompi as any).paymentSourceId = "foreign-source";
    expect((await POST(request(input))).status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ paymentSourceId: "source-fixture" }));
  });
  it("returns a losing barrier without a POST", async () => {
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => name === "billing_v2_authorize_send" ? { data: { canDispatch: false }, error: null } : base(name, args));
    expect((await POST(request())).status).toBe(202); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("marks a stale durable grant uncertain and does not dispatch", async () => {
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => {
      const result = await base(name, args);
      if (name === "billing_v2_authorize_send") result.data.sendAuthorizedAt = "2026-10-08T17:59:44Z";
      return result;
    });
    expect((await POST(request())).status).toBe(202); expect(mocks.create).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("billing_v2_mark_uncertain", { p_attempt_id: "attempt-fixture" });
  });
  it("never resends a POST after a timeout", async () => {
    mocks.create.mockRejectedValue(new Error("timeout"));
    expect((await POST(request())).status).toBe(202);
    rows.payment_attempts = { id: "attempt-fixture", state: "unknown", wompi_transaction_id: null };
    expect((await POST(request())).status).toBe(202); expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("a lost barrier response is uncertain even when this process never invoked a POST", async () => {
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => name === "billing_v2_authorize_send"
      ? { data: null, error: { message: "response lost after possible COMMIT" } } : base(name, args));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect((await response.json()).code).toBe("reconciliation_required");
    expect(rpc).toHaveBeenCalledWith("billing_v2_mark_uncertain", { p_attempt_id: "attempt-fixture" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("repeated known transactions perform GET only, even after checkout expiry", async () => {
    rows.payment_attempts = { id: "attempt-fixture", state: "pending", wompi_transaction_id: "tx-fixture" };
    rows.checkout_intents.expires_at = "2026-10-08T17:00:00Z";
    expect((await POST(request())).status).toBe(200); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it("one-time widget results never create a server financial POST", async () => {
    rows.checkout_intents.is_recurring = false;
    rows.payment_attempts = { id: "attempt-fixture", state: "prepared", wompi_transaction_id: null };
    const input = { ...body(), donor: { ...donor, isRecurring: false }, wompi: { reference: "HPE-FIXTURE", transactionId: "tx-fixture" } };
    expect((await POST(request(input))).status).toBe(200); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("an authorized retry queue does not return a failure inviting another checkout", async () => {
    mocks.get.mockResolvedValue({ ...transaction(), status: "declined", statusMessage: "Intente mas tarde - Fondos Insuficientes" });
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => name === "billing_v2_apply_result" ? { data: { result: "processed", retryQueued: true }, error: null } : base(name, args));
    const response = await POST(request()); expect(response.status).toBe(202); expect((await response.json()).status).toBe("payment_pending");
  });
  it("acceptance failure occurs before the durable grant", async () => {
    mocks.acceptance.mockRejectedValue(new Error("unavailable")); expect((await POST(request())).status).toBe(400);
    expect(rpc).not.toHaveBeenCalledWith("billing_v2_authorize_send", expect.anything()); expect(mocks.create).not.toHaveBeenCalled();
  });
});
