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
let sourceId: string | null;
let writes: { table: string; value: Record<string, unknown> }[];
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
  writes = [];
  const from = (table: string) => {
    const query = { select: () => query, eq: () => query,
      insert: (value: Record<string, unknown>) => { writes.push({ table, value }); return Promise.resolve({ error: null }); },
      maybeSingle: async () => ({ data: table === "checkout_intents" ? intent
        : table === "donors" ? { id: "donor-extra-fixture", email: "stored-donor@example.test" } : null, error: null }) };
    return query;
  };
  rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    if (["billing_retry_schema_ready", "consume_api_rate_limit"].includes(name)) return { data: true, error: null };
    if (name === "billing_v2_prepare_subscription") return { data: { id: "sub-extra-fixture", wompi_payment_source_id: sourceId }, error: null };
    if (name === "billing_v2_reserve_initial") return { data: { result: "reserved", attempt: { id: "attempt-extra-fixture" },
      dispatchSnapshot: { attemptId: "attempt-extra-fixture" } }, error: null };
    if (name === "billing_v2_authorize_send") return { data: { canDispatch: true, reference: "HPE-EXTRA-FIXTURE",
      amount: 30000, currency: "COP", paymentSourceId: "source-extra-fixture", customerEmail: "stored-donor@example.test",
      sendAuthorizedAt: now, windowEnd: null }, error: null };
    if (name === "billing_v2_apply_result") return { data: { result: "processed", subscriptionId: "sub-extra-fixture" }, error: null };
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("v2 donation lifecycle safety regressions with local fixtures", () => {
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
