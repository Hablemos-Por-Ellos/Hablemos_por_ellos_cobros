import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), bootstrap: vi.fn(), origin: vi.fn(), service: vi.fn(), clearCookies: vi.fn(), rpc: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/supabase-auth-server", () => ({ getServerAuthSupabaseClient: mocks.auth, clearServerAuthCookies: mocks.clearCookies }));
vi.mock("@/lib/admin-auth", () => ({ getAdminBootstrapContext: mocks.bootstrap, isSameOriginRequest: mocks.origin }));
vi.mock("@/lib/supabase-server", () => ({ getServiceSupabaseClient: mocks.service }));
import { POST } from "./route";

const userId = "10000000-0000-0000-0000-000000000001";
const request = () => new Request("http://127.0.0.1:3000/api/admin/logout", {
  method: "POST", headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
  body: JSON.stringify({ userId: "10000000-0000-0000-0000-000000000999", iat: 0 }),
});

describe("durable self logout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("APP_OPERATION_MODE", "active");
    mocks.origin.mockReturnValue(true);
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.service.mockReturnValue({ rpc: mocks.rpc });
    mocks.signOut.mockResolvedValue({ error: null });
    const supabase = { auth: { signOut: mocks.signOut } };
    mocks.auth.mockResolvedValue(supabase);
    mocks.bootstrap.mockResolvedValue({ user: { id: userId }, claims: { iat: 1790942400, aal: "aal1" }, supabase });
    mocks.clearCookies.mockResolvedValue(true);
  });

  it("revokes verified UUID/iat before Auth signOut, ignoring browser identity", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, jwtRevocationConfirmed: true, authSignOutConfirmed: true, cookiesCleared: true });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_revoke_own_sessions", { p_actor_user_id: userId, p_actor_session_issued_at: "2026-10-02T12:00:00.000Z" });
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.signOut.mock.invocationCallOrder[0]);
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "global" });
    expect(mocks.clearCookies).toHaveBeenCalledTimes(1);
  });

  it.each([false, null, "true"])("does not claim JWT revocation for non-confirming RPC data %s", async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, jwtRevocationConfirmed: false, authSignOutConfirmed: true, cookiesCleared: true, message: expect.stringContaining("un token retenido podria seguir activo") });
  });

  it.each(["returned error", "exception", "unavailable service"])("clears cookies but reports unconfirmed durable revocation on %s", async (failure) => {
    if (failure === "returned error") mocks.rpc.mockResolvedValue({ data: true, error: { message: "fixture failure" } });
    if (failure === "exception") mocks.rpc.mockRejectedValue(new Error("fixture failure"));
    if (failure === "unavailable service") mocks.service.mockReturnValue(null);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, jwtRevocationConfirmed: false, authSignOutConfirmed: true, cookiesCleared: true });
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.clearCookies).toHaveBeenCalledTimes(1);
  });

  it("clears an invalid/revoked session without trying an unverified UUID at the durable RPC", async () => {
    mocks.bootstrap.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, jwtRevocationConfirmed: false, cookiesCleared: true });
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "exception"])("still clears cookies and preserves true durable flag when Auth fails with %s", async (failure) => {
    if (failure === "error") mocks.signOut.mockResolvedValue({ error: { message: "fixture failure" } });
    else mocks.signOut.mockRejectedValue(new Error("fixture failure"));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, jwtRevocationConfirmed: true, authSignOutConfirmed: false, cookiesCleared: true });
  });

  it("reports failed local cookie cleanup separately", async () => {
    mocks.clearCookies.mockResolvedValue(false);
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, jwtRevocationConfirmed: true, authSignOutConfirmed: true, cookiesCleared: false });
  });

  it.each(["demo", "cross-origin"])("makes no client or cookie calls for %s", async (mode) => {
    if (mode === "demo") vi.stubEnv("APP_OPERATION_MODE", "demo");
    else mocks.origin.mockReturnValue(false);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.clearCookies).not.toHaveBeenCalled();
  });
});
