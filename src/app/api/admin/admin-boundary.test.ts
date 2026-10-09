import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), service: vi.fn(), transaction: vi.fn(), source: vi.fn(), clearCookies: vi.fn() }));
vi.mock("@/lib/supabase-auth-server", () => ({ getServerAuthSupabaseClient: mocks.auth, isServerAuthEnvironmentAllowed: vi.fn().mockResolvedValue(true), clearServerAuthCookies: mocks.clearCookies }));
vi.mock("@/lib/supabase-server", () => ({ getServiceSupabaseClient: mocks.service }));
vi.mock("@/lib/wompi-server", () => ({ getWompiTransaction: mocks.transaction, isWompiPaymentSourceAvailable: mocks.source }));
import { PATCH } from "./subscriptions/[id]/route";
import { POST as reconcile } from "./payment-attempts/[id]/reconcile/route";
import { POST as bootstrap } from "./bootstrap/route";
import { POST as logout } from "./logout/route";
import { getAdminContext } from "@/lib/admin-auth";

const userId = "10000000-0000-0000-0000-000000000001";
const id = "20000000-0000-0000-0000-000000000001";
const issuedAt = Math.floor(new Date("2026-10-02T12:00:00Z").getTime() / 1000);
function fixture({ user = true, aal = "aal2", role = "admin", active = true, cutoff = "1970-01-01T00:00:00Z", expired = false, revoke = true } = {}) {
  const admin = { role, active, sessions_valid_after: cutoff };
  const from = vi.fn((table: string) => {
    const query = { select: () => query, eq: () => query, maybeSingle: vi.fn().mockResolvedValue({ data: table === "admin_users" ? admin
      : { id, status: "active", frequency: "monthly", wompi_payment_source_id: "source-fixture" }, error: null }) };
    return query;
  });
  const rpc = vi.fn(async (name: string) => {
    if (name === "admin_revoke_own_sessions") {
      if (!revoke) return { data: false, error: { message: "fixture RPC unavailable" } };
      admin.sessions_valid_after = new Date().toISOString();
      return { data: true, error: null };
    }
    return { data: name === "billing_v2_admin_update_subscription"
      ? { id, amount: 31000, status: "active", preferred_payment_day: 16, next_payment_date: "2040-01-16T12:00:00Z", billing_version: 4 } : true, error: null };
  });
  const client = { from, rpc, auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user: user ? { id: userId, email: "fixture@example.test" } : null }, error: null }),
    getClaims: vi.fn().mockResolvedValue({ data: { claims: { sub: userId, iat: issuedAt, exp: expired ? issuedAt : issuedAt + 172800, aal } }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    mfa: { getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: { currentLevel: aal }, error: null }),
      listFactors: vi.fn().mockResolvedValue({ data: { totp: [{ id: "fixture-factor", status: "verified" }] }, error: null }),
      challengeAndVerify: vi.fn().mockResolvedValue({ error: null }) },
  } };
  mocks.auth.mockResolvedValue(client);
  mocks.service.mockReturnValue(client);
  return client;
}
function request(path: string, method = "POST") {
  return new Request(`http://127.0.0.1:3000/api/admin/${path}`, { method,
    headers: { Origin: "http://127.0.0.1:3000", Host: "127.0.0.1:3000", "Content-Type": "application/json" },
    body: JSON.stringify({ action: path.startsWith("subscriptions") ? "amount" : "reconcile",
      reason: "Fixture donor authorization", totpCode: "123456", expectedVersion: 3,
      requestId: "30000000-0000-0000-0000-000000000001", amount: 31000, transactionId: "fixture-tx" }),
  });
}

describe("direct APIs use the real authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    vi.stubEnv("APP_OPERATION_MODE", "active");
    vi.stubEnv("ADMIN_DEMO_MODE", "false");
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "true");
    mocks.clearCookies.mockResolvedValue(true);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it.each([
    ["visitor", { user: false }], ["AAL1", { aal: "aal1" }], ["suspended", { active: false }],
    ["invalid role", { role: "viewer" }], ["expired", { expired: true }],
    ["revoked reactivated", { active: true, cutoff: "2026-10-02T13:00:00Z" }],
    ["equal revocation timestamp", { cutoff: "2026-10-02T12:00:00Z" }],
  ] as const)("rejects %s at both sensitive APIs without TOTP/provider/mutation", async (_label, input) => {
    const client = fixture(input);
    const mutation = await PATCH(request(`subscriptions/${id}`, "PATCH"), { params: Promise.resolve({ id }) });
    const recovery = await reconcile(request(`payment-attempts/${id}/reconcile`), { params: Promise.resolve({ id }) });
    expect(mutation.status).toBe(401);
    expect(recovery.status).toBe(401);
    expect(client.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.anything());
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it.each(["admin", "super_admin"])("permits %s AAL2 with a fresh challenge and sends its verified context", async (role) => {
    const client = fixture({ role });
    const response = await PATCH(request(`subscriptions/${id}`, "PATCH"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_update_subscription", expect.objectContaining({ p_actor_aal: "aal2", p_actor_session_issued_at: "2026-10-02T12:00:00.000Z", p_totp_verified_at: "2026-10-03T12:00:00.000Z" }));
    expect(client.rpc).toHaveBeenCalledWith("billing_retry_schema_ready");
    expect(client.rpc).not.toHaveBeenCalledWith("admin_update_subscription", expect.anything());
  });
  it("permits AAL1 onboarding in cutover but never mutations", async () => {
    const client = fixture({ aal: "aal1" });
    vi.stubEnv("APP_OPERATION_MODE", "cutover");
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "false");
    expect((await bootstrap(request("bootstrap"))).status).toBe(200);
    client.rpc.mockClear();
    mocks.auth.mockClear();
    expect((await PATCH(request(`subscriptions/${id}`, "PATCH"), { params: Promise.resolve({ id }) })).status).toBe(503);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("bootstrap rejects a real active user with a non-admin role", async () => {
    fixture({ aal: "aal1", role: "viewer" });
    expect((await bootstrap(request("bootstrap"))).status).toBe(403);
  });
  it.each(["aal1", "aal2"])("allows %s self logout in cutover without TOTP or finance enablement", async (aal) => {
    const client = fixture({ aal });
    vi.stubEnv("APP_OPERATION_MODE", "cutover");
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "false");
    const response = await logout(request("logout"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jwtRevocationConfirmed: true, cookiesCleared: true });
    expect(client.rpc).toHaveBeenCalledWith("admin_revoke_own_sessions", { p_actor_user_id: userId, p_actor_session_issued_at: "2026-10-02T12:00:00.000Z" });
    expect(client.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
  });
  it("rejects the retained unexpired AAL2 JWT after a confirmed durable cutoff, even when the role is active", async () => {
    const client = fixture();
    expect(await getAdminContext()).not.toBeNull();
    expect((await logout(request("logout"))).status).toBe(200);
    // Keep getUser/getClaims unchanged: only the persisted fixture cutoff changed.
    await expect(client.auth.getClaims.mock.results[0].value).resolves.toMatchObject({ data: { claims: { exp: issuedAt + 172800, aal: "aal2" } } });
    expect(await getAdminContext()).toBeNull();
    expect((await PATCH(request(`subscriptions/${id}`, "PATCH"), { params: Promise.resolve({ id }) })).status).toBe(401);
    expect((await reconcile(request(`payment-attempts/${id}/reconcile`), { params: Promise.resolve({ id }) })).status).toBe(401);
    expect(client.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
  });
  it("reports a failed durable RPC honestly while the retained JWT remains valid at the server boundary", async () => {
    const client = fixture({ revoke: false });
    const response = await logout(request("logout"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, jwtRevocationConfirmed: false, authSignOutConfirmed: true, cookiesCleared: true, message: expect.stringContaining("un token retenido podria seguir activo") });
    expect(await getAdminContext()).not.toBeNull();
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
  });
  it.each([{ user: false }, { role: "viewer" }, { active: false }, { cutoff: "2026-10-02T13:00:00Z" }, { expired: true }])("clears invalid session cookies without durable revocation for %j", async (input) => {
    const client = fixture(input);
    const response = await logout(request("logout"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ jwtRevocationConfirmed: false, cookiesCleared: true });
    expect(client.rpc).not.toHaveBeenCalledWith("admin_revoke_own_sessions", expect.anything());
    expect(mocks.clearCookies).toHaveBeenCalledTimes(1);
  });
  it("rejects demo at both endpoints without constructing any clients", async () => {
    vi.stubEnv("APP_OPERATION_MODE", "demo");
    vi.stubEnv("ADMIN_DEMO_MODE", "true");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await PATCH(request(`subscriptions/${id}`, "PATCH"), { params: Promise.resolve({ id }) })).status).toBe(401);
    expect((await reconcile(request(`payment-attempts/${id}/reconcile`), { params: Promise.resolve({ id }) })).status).toBe(401);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });
});
