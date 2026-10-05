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
    ...overrides,
  };
}

function serviceClient({ sourceId = "source-1", status = "active", frequency = "monthly" }: { sourceId?: string | null; status?: string; frequency?: "monthly" | "one_time" } = {}) {
  const readSourceId = vi.fn(() => sourceId);
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === "consume_api_rate_limit") return { data: true, error: null };
    if (name === "admin_update_subscription") {
      return {
        data: {
          id: subscriptionId,
          amount: 30000,
          status: "active",
          preferred_payment_day: 16,
          next_payment_date: "2026-10-16T12:00:00.000Z",
          billing_version: 4,
        },
        error: null,
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return {
    rpc,
    readSourceId,
    from: vi.fn(() => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: vi.fn().mockResolvedValue({
          data: { get wompi_payment_source_id() { return readSourceId(); }, status, frequency },
          error: null,
        }),
      };
      return query;
    }),
  };
}

describe("PATCH /api/admin/subscriptions/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  afterEach(() => vi.useRealTimers());

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
    expect(client.rpc).not.toHaveBeenCalledWith("admin_update_subscription", expect.anything());
  });

  it("applies a valid amount change through the audited atomic RPC", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);

    const response = await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscription).toEqual(expect.objectContaining({ amount: 30000, billing_version: 4 }));
    expect(client.rpc).toHaveBeenCalledWith("admin_update_subscription", expect.objectContaining({
      p_subscription_id: subscriptionId,
      p_expected_version: 3,
      p_actor_user_id: adminId,
      p_amount: 30000,
      p_actor_aal: "aal2",
      p_actor_session_issued_at: "2026-10-01T00:00:00Z",
      p_totp_verified_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    }));
    const call = client.rpc.mock.calls.find(([name]) => name === "admin_update_subscription")!;
    expect(Object.keys(call[1]).sort()).toEqual([
      "p_subscription_id", "p_expected_version", "p_action", "p_reason", "p_request_id", "p_actor_user_id",
      "p_amount", "p_preferred_payment_day", "p_next_payment_date", "p_donor_authorization_confirmed",
      "p_actor_aal", "p_actor_session_issued_at", "p_totp_verified_at",
    ].sort());
  });

  describe.each([null, "source-1"])("one_time contribution with fixture source %s", (sourceId) => {
    it.each(["amount", "schedule", "cancel", "reactivate"])("rejects %s before reading a source or calling Wompi or the mutation RPC", async (action) => {
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
        expect(client.from).toHaveBeenCalledExactlyOnceWith("subscriptions");
        expect(client.readSourceId).not.toHaveBeenCalled();
        expect(mocks.isWompiPaymentSourceAvailable).not.toHaveBeenCalled();
        expect(client.rpc).not.toHaveBeenCalledWith("admin_update_subscription", expect.anything());
        expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["consume_api_rate_limit"]);
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
    expect(client.rpc).toHaveBeenCalledWith("admin_update_subscription", expect.objectContaining({
      p_action: "reactivate", p_next_payment_date: "2026-11-16T12:00:00Z", p_donor_authorization_confirmed: true,
    }));
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["consume_api_rate_limit", "admin_update_subscription"]);
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
    expect(client.rpc).not.toHaveBeenCalledWith("admin_update_subscription", expect.anything());
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
    expect(client.rpc).not.toHaveBeenCalledWith("admin_update_subscription", expect.anything());
  });

  it("exposes a version conflict without a fake confirmation", async () => {
    const client = serviceClient();
    client.rpc.mockImplementation(async (name) => name === "consume_api_rate_limit"
      ? { data: true, error: null } as never
      : { data: null, error: { message: "SUBSCRIPTION_VERSION_CONFLICT" } } as never);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("subscription");
  });

  it.each([1500, 21474836])("accepts allowed integer amount %s for the next charge", async (amount) => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await PATCH(request(validMutation({ amount })), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("admin_update_subscription", expect.objectContaining({ p_amount: amount }));
  });

  it.each([1, 6, 16, 28])("accepts future month/year on billing day %s", async (preferredPaymentDay) => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const nextPaymentDate = `2040-01-${String(preferredPaymentDay).padStart(2, "0")}T12:00:00Z`;
    expect((await PATCH(request(validMutation({ action: "schedule", preferredPaymentDay, nextPaymentDate })), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("admin_update_subscription", expect.objectContaining({ p_next_payment_date: nextPaymentDate, p_preferred_payment_day: preferredPaymentDay }));
  });

  it("rejects a revoked session on the final recheck before the atomic mutation", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getAdminContext.mockResolvedValueOnce({ userId: adminId, demo: false, role: "admin" }).mockResolvedValueOnce(null);
    expect((await PATCH(request(validMutation()), { params: Promise.resolve({ id: subscriptionId }) })).status).toBe(403);
    expect(client.rpc).not.toHaveBeenCalledWith("admin_update_subscription", expect.anything());
  });
  it.each(["amount", "schedule", "cancel", "reactivate"])("preserves the existing in-flight conflict for %s without a fake success", async (action) => {
    const client = serviceClient({ status: action === "reactivate" ? "cancelled" : "active" });
    client.rpc.mockImplementation(async (name) => name === "consume_api_rate_limit"
      ? { data: true, error: null } as never
      : { data: null, error: { message: "PAYMENT_IN_PROGRESS" } } as never);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await PATCH(request(validMutation({ action, preferredPaymentDay: 16,
      nextPaymentDate: "2040-01-16T12:00:00Z", donorAuthorizationConfirmed: true })), { params: Promise.resolve({ id: subscriptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("subscription");
  });
});
