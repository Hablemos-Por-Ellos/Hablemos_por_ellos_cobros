import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminContext: vi.fn(),
  isAdminDemoMode: vi.fn(),
  isAdminSchemaReady: vi.fn(),
  isSameOriginRequest: vi.fn(),
  verifyRecentTotp: vi.fn(),
  getServiceSupabaseClient: vi.fn(),
  isWompiPaymentSourceAvailable: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminContext: mocks.getAdminContext,
  isAdminDemoMode: mocks.isAdminDemoMode,
  isAdminSchemaReady: mocks.isAdminSchemaReady,
  isSameOriginRequest: mocks.isSameOriginRequest,
  verifyRecentTotp: mocks.verifyRecentTotp,
}));
vi.mock("@/lib/supabase-server", () => ({
  getServiceSupabaseClient: mocks.getServiceSupabaseClient,
}));
vi.mock("@/lib/wompi-server", () => ({
  isWompiPaymentSourceAvailable: mocks.isWompiPaymentSourceAvailable,
}));

import { PATCH } from "./route";

const subscriptionId = "20000000-0000-0000-0000-000000000001";
const adminId = "10000000-0000-0000-0000-000000000001";
const cycleId = "60000000-0000-0000-0000-000000000001";

function request(body: Record<string, unknown>) {
  return new Request(`https://app.example/api/admin/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: "https://app.example" },
    body: JSON.stringify(body),
  });
}

function validMutation(overrides: Record<string, unknown> = {}) {
  return {
    action: "amount",
    reason: "Solicitud confirmada por el donante",
    totpCode: "123456",
    expectedVersion: 3,
    requestId: "30000000-0000-0000-0000-000000000001",
    amount: 30000,
    ...(overrides.action === "cancel_retry" ? { expectedCycleId: cycleId } : {}),
    ...overrides,
  };
}

function serviceClient({ sourceId = "source-1", status = "active", frequency = "monthly", inProgress = false,
  openCycle = false, paidMonth = false }: { sourceId?: string | null; status?: string;
  frequency?: "monthly" | "one_time"; inProgress?: boolean; openCycle?: boolean; paidMonth?: boolean } = {}) {
  const state = { sourceId, status, frequency, inProgress, openCycle, paidMonth, cycleId, version: 3, amount: 30000 };
  const committed = new Map<string, { fingerprint: string; response: Record<string, unknown> }>();
  const readSourceId = vi.fn(() => state.sourceId);
  const failure = (message: string) => ({ data: null, error: { message } });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (["billing_retry_schema_ready", "consume_api_rate_limit"].includes(name)) return { data: true, error: null };
    if (name !== "billing_v2_admin_update_subscription") throw new Error(`Unexpected RPC ${name}`);
    const fingerprint = JSON.stringify([args.p_subscription_id, args.p_expected_version, args.p_action,
      args.p_reason, args.p_amount, args.p_preferred_payment_day, args.p_next_payment_date,
      args.p_donor_authorization_confirmed, args.p_expected_cycle_id]);
    const key = `${args.p_actor_user_id}:${args.p_request_id}`;
    const previous = committed.get(key);
    if (previous) return previous.fingerprint === fingerprint
      ? { data: previous.response, error: null } : failure("ADMIN_REQUEST_ID_CONFLICT");
    // These state checks model the SQL boundary, after its durable replay lookup.
    if (state.frequency !== "monthly") return failure("ONE_TIME_READ_ONLY");
    if (args.p_expected_version !== state.version) return failure("SUBSCRIPTION_VERSION_CONFLICT");
    if (["amount", "schedule", "reactivate"].includes(String(args.p_action)) && (state.openCycle || state.inProgress)) {
      return failure("BILLING_CYCLE_IN_PROGRESS");
    }
    if (args.p_action === "cancel_retry" && state.inProgress) return failure("PAYMENT_IN_PROGRESS");
    if (args.p_action === "amount" && state.status !== "active") return failure("INVALID_AMOUNT_CHANGE");
    if (["schedule", "reactivate"].includes(String(args.p_action))) {
      if (Date.parse(String(args.p_next_payment_date)) <= Date.now()) return failure("INVALID_SCHEDULE_CHANGE");
      if (state.paidMonth) return failure("BILLING_MONTH_ALREADY_PAID");
      if (args.p_action === "schedule" && state.status !== "active") return failure("INVALID_SCHEDULE_CHANGE");
    }
    if (args.p_action === "reactivate") {
      if (!["cancelled", "past_due"].includes(state.status)) return failure("INVALID_REACTIVATION_STATE");
      if (args.p_donor_authorization_confirmed !== true || !args.p_source_verification) return failure("REACTIVATION_AUTHORIZATION_REQUIRED");
      const proof = args.p_source_verification as Record<string, unknown>;
      if (proof.id !== state.sourceId || proof.status !== "AVAILABLE" || proof.type !== "CARD"
        || proof.environment !== "sandbox" || proof.verification_source !== "provider_get"
        || Date.parse(String(proof.verified_at)) !== Date.now()) return failure("REACTIVATION_AUTHORIZATION_REQUIRED");
      state.status = "active";
    }
    if (args.p_action === "cancel_retry") {
      if (!state.openCycle || args.p_expected_cycle_id !== state.cycleId) return failure("BILLING_CYCLE_CONFLICT");
      state.openCycle = false;
      state.status = "past_due";
    }
    if (args.p_action === "cancel") state.status = "cancelled";
    if (args.p_action === "amount") state.amount = Number(args.p_amount);
    state.version++;
    const response = { id: subscriptionId, amount: state.amount, status: state.status,
      preferred_payment_day: args.p_preferred_payment_day ?? 16,
      next_payment_date: ["cancel", "cancel_retry"].includes(String(args.p_action)) ? null
        : args.p_next_payment_date ?? "2026-10-16T12:00:00.000Z", billing_version: state.version };
    committed.set(key, { fingerprint, response });
    return { data: response, error: null };
  });
  return {
    rpc,
    state,
    committed,
    readSourceId,
    from: vi.fn(() => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: vi.fn().mockResolvedValue({
          data: { get wompi_payment_source_id() { return readSourceId(); }, status: state.status, frequency: state.frequency },
          error: null,
        }),
      };
      return query;
    }),
  };
}

describe("PATCH /api/admin/subscriptions/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    vi.stubEnv("APP_OPERATION_MODE", "active");
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "true");
    mocks.isAdminSchemaReady.mockResolvedValue(true);
    mocks.isSameOriginRequest.mockReturnValue(true);
    mocks.isAdminDemoMode.mockReturnValue(false);
    mocks.getAdminContext.mockResolvedValue({
      userId: adminId,
      email: "admin@example.test",
      role: "admin",
      demo: false,
      aal: "aal2", sessionIssuedAt: "2026-10-01T00:00:00Z",
    });
    mocks.verifyRecentTotp.mockResolvedValue(true);
    mocks.isWompiPaymentSourceAvailable.mockResolvedValue(true);
    mocks.getServiceSupabaseClient.mockReturnValue(serviceClient());
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("rejects cross-origin requests before checking the session", async () => {
    mocks.isSameOriginRequest.mockReturnValue(false);

    const response = await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) });

    expect(response.status).toBe(403);
    expect(mocks.getAdminContext).not.toHaveBeenCalled();
  });

  it("rejects a request without an authorized aal2 admin context", async () => {
    mocks.getAdminContext.mockResolvedValue(null);

    const response = await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) });

    expect(response.status).toBe(401);
  });

  it("does not mutate when the fresh TOTP challenge fails", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.verifyRecentTotp.mockResolvedValue(false);

    const response = await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) });

    expect(response.status).toBe(403);
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.anything());
  });

  it("applies a valid amount change through the audited atomic RPC", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);

    const response = await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscription).toEqual(expect.objectContaining({ amount: 30000, billing_version: 4 }));
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.objectContaining({
      p_subscription_id: subscriptionId,
      p_expected_version: 3,
      p_actor_user_id: adminId,
      p_amount: 30000,
      p_actor_aal: "aal2",
      p_actor_session_issued_at: "2026-10-01T00:00:00Z",
      p_totp_verified_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    }));
    const call = client.rpc.mock.calls.find(([name]) => name === "billing_v2_admin_update_subscription")!;
    expect(Object.keys(call[1]).sort()).toEqual([
      "p_subscription_id", "p_expected_version", "p_action", "p_reason", "p_request_id", "p_actor_user_id",
      "p_amount", "p_preferred_payment_day", "p_next_payment_date", "p_donor_authorization_confirmed",
      "p_actor_aal", "p_actor_session_issued_at", "p_totp_verified_at", "p_expected_cycle_id",
    ].sort());
  });

  describe.each([null, "source-1"])("one_time contribution with fixture source %s", (sourceId) => {
    it.each(["amount", "schedule", "cancel", "cancel_retry", "reactivate"])("rejects %s at SQL before reading a source or calling Wompi", async (action) => {
      const client = serviceClient({ sourceId, frequency: "one_time", status: action === "reactivate" ? "cancelled" : "active" });
      client.readSourceId.mockImplementation(() => { throw new Error("One-time contributions must not access a reusable source"); });
      mocks.getServiceSupabaseClient.mockReturnValue(client);
      vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call in one-time fixture"); }));

      try {
        const response = await PATCH(request(validMutation({
          action,
          amount: action === "amount" ? 30000 : undefined,
          preferredPaymentDay: 16,
          nextPaymentDate: "2040-01-16T12:00:00Z",
          donorAuthorizationConfirmed: true,
        })), { params: Promise.resolve({ id: subscriptionId }) });

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ message: "Esta suscripcion no admite cambios administrativos." });
        expect(client.from).not.toHaveBeenCalled();
        expect(client.readSourceId).not.toHaveBeenCalled();
        expect(mocks.isWompiPaymentSourceAvailable).not.toHaveBeenCalled();
        expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.objectContaining({ p_action: action }));
        expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["billing_retry_schema_ready", "consume_api_rate_limit", "billing_v2_admin_update_subscription"]);
        expect(client.state.version).toBe(3);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it("requires donor authorization and an available tokenized source before reactivation", async () => {
    mocks.getServiceSupabaseClient.mockReturnValue(serviceClient({ status: "cancelled" }));
    const withoutAuthorization = await PATCH(request(validMutation({
      action: "reactivate",
      amount: undefined,
      preferredPaymentDay: 16,
      nextPaymentDate: "2026-10-16T12:00:00.000Z",
      donorAuthorizationConfirmed: false,
    })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(withoutAuthorization.status).toBe(400);

    mocks.isWompiPaymentSourceAvailable.mockResolvedValue(false);
    const unavailableSource = await PATCH(request(validMutation({
      action: "reactivate",
      amount: undefined,
      preferredPaymentDay: 16,
      nextPaymentDate: "2026-10-16T12:00:00.000Z",
      donorAuthorizationConfirmed: true,
    })), { params: Promise.resolve({ id: subscriptionId }) });

    expect(unavailableSource.status).toBe(409);
  });

  it("reactivates only after source verification through the audited RPC, without creating a charge", async () => {
    const client = serviceClient({ status: "cancelled" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation({
      action: "reactivate", amount: undefined, preferredPaymentDay: 16,
      nextPaymentDate: "2026-11-16T12:00:00Z", donorAuthorizationConfirmed: true,
    })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(200);
    expect(mocks.isWompiPaymentSourceAvailable).toHaveBeenCalledWith("source-1");
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.objectContaining({
      p_action: "reactivate", p_next_payment_date: "2026-11-16T12:00:00Z", p_donor_authorization_confirmed: true,
    }));
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["billing_retry_schema_ready", "consume_api_rate_limit", "billing_v2_admin_update_subscription", "billing_v2_admin_update_subscription"]);
    const mutationCalls = client.rpc.mock.calls.filter(([name]) => name === "billing_v2_admin_update_subscription");
    expect(mutationCalls[0][1]).not.toHaveProperty("p_source_verification");
    expect(mutationCalls[1][1]).toMatchObject({ p_source_verification: { id: "source-1", type: "CARD", status: "AVAILABLE",
      environment: "sandbox", verification_source: "provider_get", verified_at: "2026-10-03T12:00:00.000Z" } });
    expect(client.rpc.mock.invocationCallOrder[client.rpc.mock.calls.findIndex(([name]) => name === "billing_v2_admin_update_subscription")])
      .toBeLessThan(mocks.isWompiPaymentSourceAvailable.mock.invocationCallOrder[0]);
  });

  it("returns a service error without mutation when provider verification fails", async () => {
    const client = serviceClient({ status: "cancelled" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.isWompiPaymentSourceAvailable.mockRejectedValue(new Error("fixture provider unavailable"));
    const response = await PATCH(request(validMutation({
      action: "reactivate", amount: undefined, preferredPaymentDay: 16,
      nextPaymentDate: "2026-11-16T12:00:00Z", donorAuthorizationConfirmed: true,
    })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(503);
    expect(client.rpc.mock.calls.filter(([name]) => name === "billing_v2_admin_update_subscription")).toHaveLength(1);
    expect(client.state.version).toBe(3);
  });

  it.each(["cutover", "demo"])("rejects %s before all auth/data/provider calls", async (mode) => {
    vi.stubEnv("APP_OPERATION_MODE", mode);
    const response = await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(503);
    expect(mocks.getAdminContext).not.toHaveBeenCalled();
    expect(mocks.getServiceSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.isAdminSchemaReady).not.toHaveBeenCalled();
  });

  it("rejects active mode without the financial switch", async () => {
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "false");
    expect((await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(503);
    expect(mocks.getAdminContext).not.toHaveBeenCalled();
  });

  it.each([1499, 21474837, 1500.5, undefined])("rejects invalid or missing amount %s", async (amount) => {
    const response = await PATCH(request(validMutation({ amount })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(400);
    expect(mocks.getServiceSupabaseClient).not.toHaveBeenCalled();
  });

  it.each(["2020-01-16T12:00:00Z", "2040-01-17T12:00:00Z", "2040-01-16T13:00:00Z"])("rejects invalid schedule %s", async (nextPaymentDate) => {
    const response = await PATCH(request(validMutation({ action: "schedule", preferredPaymentDay: 16, nextPaymentDate })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(400);
  });

  it("never forces pending into active", async () => {
    const client = serviceClient({ status: "pending" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation({ action: "reactivate", donorAuthorizationConfirmed: true, preferredPaymentDay: 16, nextPaymentDate: "2040-01-16T12:00:00Z" })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(mocks.isWompiPaymentSourceAvailable).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.objectContaining({ p_action: "reactivate" }));
    expect(client.state.status).toBe("pending");
    expect(client.state.version).toBe(3);
  });

  it("exposes a version conflict without a fake confirmation", async () => {
    const client = serviceClient();
    client.state.version = 4;
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("subscription");
  });

  it("replays a committed reactivation after state, calendar, version and source changes without another provider GET", async () => {
    const client = serviceClient({ status: "cancelled" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const mutation = validMutation({ action: "reactivate", amount: undefined, preferredPaymentDay: 16,
      nextPaymentDate: "2026-11-16T12:00:00Z", donorAuthorizationConfirmed: true });
    const first = await PATCH(request(mutation), { params: Promise.resolve({ id: subscriptionId }) });
    expect(first.status).toBe(200);
    const confirmed = await first.json();
    client.state.status = "cancelled";
    client.state.version = 9;
    client.state.sourceId = null;
    client.state.openCycle = true;
    client.state.paidMonth = true;
    vi.setSystemTime(new Date("2026-12-03T12:00:00Z"));
    mocks.isWompiPaymentSourceAvailable.mockClear().mockResolvedValue(false);
    client.from.mockClear();
    client.rpc.mockClear();
    mocks.verifyRecentTotp.mockClear();
    const replay = await PATCH(request({ ...mutation, totpCode: "654321" }), { params: Promise.resolve({ id: subscriptionId }) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(confirmed);
    expect(mocks.verifyRecentTotp).toHaveBeenCalledWith("654321");
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.isWompiPaymentSourceAvailable).not.toHaveBeenCalled();
    expect(client.rpc.mock.calls.filter(([name]) => name === "billing_v2_admin_update_subscription")).toHaveLength(1);
    expect(client.committed.size).toBe(1);
    expect(client.state.version).toBe(9);
    expect(client.state.status).toBe("cancelled");
  });

  it("returns conflict for a reused requestId with different semantic content before state/source checks", async () => {
    const client = serviceClient({ status: "cancelled" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const mutation = validMutation({ action: "reactivate", amount: undefined, preferredPaymentDay: 16,
      nextPaymentDate: "2026-11-16T12:00:00Z", donorAuthorizationConfirmed: true });
    expect((await PATCH(request(mutation), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(200);
    client.state.status = "pending";
    client.state.sourceId = null;
    mocks.isWompiPaymentSourceAvailable.mockClear();
    client.from.mockClear();
    const response = await PATCH(request({ ...mutation, reason: "Another confirmed donor instruction" }), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ message: "Este identificador ya se uso para un cambio diferente." });
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.isWompiPaymentSourceAvailable).not.toHaveBeenCalled();
    expect(client.state.version).toBe(4);
    expect(client.committed.size).toBe(1);
  });

  it("does not return a cached mutation when the new TOTP challenge fails", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(200);
    client.rpc.mockClear();
    mocks.verifyRecentTotp.mockResolvedValue(false);
    const replay = await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) });
    expect(replay.status).toBe(403);
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.anything());
    expect(client.state.version).toBe(4);
  });

  it("cancels only a cancelable retry reservation with an atomic past_due/null-date result and durable replay", async () => {
    const client = serviceClient({ status: "past_due", openCycle: true });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const mutation = validMutation({ action: "cancel_retry", amount: undefined });
    const first = await PATCH(request(mutation), { params: Promise.resolve({ id: subscriptionId }) });
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result.subscription).toMatchObject({ status: "past_due", next_payment_date: null, billing_version: 4 });
    expect(client.state.openCycle).toBe(false);
    const replay = await PATCH(request(mutation), { params: Promise.resolve({ id: subscriptionId }) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(client.committed.size).toBe(1);
    expect(client.state.version).toBe(4);
    expect(mocks.isWompiPaymentSourceAvailable).not.toHaveBeenCalled();
  });

  it("does not cancel a retry after its durable send barrier", async () => {
    const client = serviceClient({ openCycle: true, inProgress: true, status: "past_due" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation({ action: "cancel_retry", amount: undefined })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("subscription");
    expect(client.state.openCycle).toBe(true);
    expect(client.state.version).toBe(3);
  });

  it.each([undefined, null, "not-a-uuid"])("rejects missing or invalid cancel_retry cycle %s before mutation", async (expectedCycleId) => {
    const client = serviceClient({ openCycle: true, status: "past_due" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation({ action: "cancel_retry", amount: undefined, expectedCycleId })),
      { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(mocks.verifyRecentTotp).not.toHaveBeenCalled();
    expect(client.state.openCycle).toBe(true);
    expect(client.state.version).toBe(3);
  });

  it("rejects a different cancel_retry cycle with a 409 from the atomic RPC", async () => {
    const client = serviceClient({ openCycle: true, status: "past_due" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation({ action: "cancel_retry", amount: undefined,
      expectedCycleId: "60000000-0000-0000-0000-000000000002" })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("subscription");
    expect(client.state.openCycle).toBe(true);
    expect(client.state.version).toBe(3);
    expect(client.committed.size).toBe(0);
  });

  it("conflicts on the same cancel_retry requestId with different cycle semantics before state checks", async () => {
    const client = serviceClient({ openCycle: true, status: "past_due" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const mutation = validMutation({ action: "cancel_retry", amount: undefined });
    expect((await PATCH(request(mutation), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(200);
    const response = await PATCH(request({ ...mutation, expectedCycleId: "60000000-0000-0000-0000-000000000002" }),
      { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ message: "Este identificador ya se uso para un cambio diferente." });
    expect(client.committed.size).toBe(1);
    expect(client.state.version).toBe(4);
  });

  it.each(["amount", "schedule", "reactivate"])("blocks %s while a retry cycle is reserved before any provider GET", async (action) => {
    const client = serviceClient({ openCycle: true, status: action === "reactivate" ? "past_due" : "active" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation({ action, preferredPaymentDay: 16,
      nextPaymentDate: "2040-01-16T12:00:00Z", donorAuthorizationConfirmed: true })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("subscription");
    expect(client.state.version).toBe(3);
    expect(mocks.isWompiPaymentSourceAvailable).not.toHaveBeenCalled();
  });

  it("rejects a new reactivation for a month already paid without refreshing its source", async () => {
    const client = serviceClient({ status: "cancelled", paidMonth: true });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation({ action: "reactivate", amount: undefined, preferredPaymentDay: 16,
      nextPaymentDate: "2040-01-16T12:00:00Z", donorAuthorizationConfirmed: true })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(mocks.isWompiPaymentSourceAvailable).not.toHaveBeenCalled();
    expect(client.state.version).toBe(3);
  });

  it.each([false, "error"])("fails closed when retry schema readiness is %s without a legacy fallback", async (readiness) => {
    const client = serviceClient();
    const original = client.rpc.getMockImplementation()!;
    client.rpc.mockImplementation(async (name, args) => name === "billing_retry_schema_ready"
      ? { data: readiness === "error" ? null : false, error: readiness === "error" ? { message: "fixture unavailable" } : null } as never
      : original(name, args));
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(503);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("billing_retry_schema_ready");
    expect(mocks.verifyRecentTotp).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it.each([1500, 21474836])("accepts allowed integer amount %s for the next charge", async (amount) => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await PATCH(request(validMutation({ amount })), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.objectContaining({ p_amount: amount }));
  });

  it.each([1, 6, 16, 28])("accepts future month/year on billing day %s", async (preferredPaymentDay) => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const nextPaymentDate = `2040-01-${String(preferredPaymentDay).padStart(2, "0")}T12:00:00Z`;
    expect((await PATCH(request(validMutation({ action: "schedule", preferredPaymentDay, nextPaymentDate })), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.objectContaining({ p_next_payment_date: nextPaymentDate, p_preferred_payment_day: preferredPaymentDay }));
  });

  it("rejects a revoked session on the final recheck before the atomic mutation", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getAdminContext.mockResolvedValueOnce({ userId: adminId, demo: false, role: "admin" }).mockResolvedValueOnce(null);
    expect((await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(403);
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.anything());
  });
  it.each(["amount", "schedule", "cancel", "reactivate"])("preserves the existing in-flight conflict for %s without a fake success", async (action) => {
    const client = serviceClient({ status: action === "reactivate" ? "cancelled" : "active" });
    const original = client.rpc.getMockImplementation()!;
    client.rpc.mockImplementation(async (name, args) => name === "billing_v2_admin_update_subscription"
      ? { data: null, error: { message: "PAYMENT_IN_PROGRESS" } } as never : original(name, args));
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation({ action, preferredPaymentDay: 16,
      nextPaymentDate: "2040-01-16T12:00:00Z", donorAuthorizationConfirmed: true })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("subscription");
  });
});
