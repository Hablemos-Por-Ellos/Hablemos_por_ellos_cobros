import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), service: vi.fn(), bootstrap: vi.fn(), ready: vi.fn() }));
vi.mock("@/lib/supabase-auth-server", () => ({ getServerAuthSupabaseClient: mocks.auth }));
vi.mock("@/lib/supabase-server", () => ({ getServiceSupabaseClient: mocks.service }));
vi.mock("@/lib/admin-auth", () => ({ getAdminBootstrapContext: mocks.bootstrap, isAdminSchemaReady: mocks.ready }));
import { activateAdminInvitation, getAdminActivationContext } from "./admin-auth-invitation";

const userId = "10000000-0000-0000-0000-000000000001";
const sessionId = "10000000-0000-0000-0000-000000000002";
const tokenHash = "a".repeat(64);
const invite = (overrides = {}) => ({ user_id: userId, recipient_email: "fixture@example.test",
  issued_at: new Date(Date.now() - 60000).toISOString(), expires_at: new Date(Date.now() + 3500000).toISOString(), consumed_at: null, ...overrides });
function service(data: unknown) {
  const query = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: vi.fn().mockResolvedValue({ data, error: null }) };
  return { from: vi.fn(() => query), rpc: vi.fn().mockResolvedValue({ data: true, error: null }) };
}

describe("private one-hour, one-use invitation", () => {
  let auth: { auth: { verifyOtp: ReturnType<typeof vi.fn>; signOut: ReturnType<typeof vi.fn> } };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ready.mockResolvedValue(true);
    auth = { auth: { verifyOtp: vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null }), signOut: vi.fn().mockResolvedValue({ error: null }) } };
    mocks.auth.mockResolvedValue(auth);
    mocks.service.mockReturnValue(service(invite()));
    mocks.bootstrap.mockResolvedValue({ user: { id: userId, email: "fixture@example.test" }, claims: { aal: "aal1", session_id: sessionId } });
  });
  it.each([56, 64])("verifies a %i-character invite hash and atomically binds its own session", async (length) => {
    const suppliedHash = "a".repeat(length);
    const client = service(invite());
    mocks.service.mockReturnValue(client);
    expect(await activateAdminInvitation(suppliedHash)).toBe(true);
    expect(auth.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: suppliedHash, type: "invite" });
    expect(client.rpc).toHaveBeenCalledWith("admin_consume_invitation", { p_token_hash_digest: expect.stringMatching(/^[a-f0-9]{64}$/), p_user_id: userId, p_session_id: sessionId });
  });
  it.each(["", "a".repeat(55), "a".repeat(57), "a".repeat(63), "a".repeat(65), "z".repeat(56)])("rejects malformed invitation hashes before calling Auth", async (value) => {
    expect(await activateAdminInvitation(value)).toBe(false);
    expect(auth.auth.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
  });
  it.each(["expired", "reused", "too-long"])("rejects %s before verifying OTP", async (kind) => {
    mocks.service.mockReturnValue(service(invite(kind === "expired" ? { expires_at: new Date(Date.now() - 1).toISOString() }
      : kind === "reused" ? { consumed_at: new Date().toISOString() } : { expires_at: new Date(Date.now() + 7200000).toISOString() })));
    expect(await activateAdminInvitation(tokenHash)).toBe(false);
    expect(auth.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("rejects an expired or reused Auth OTP", async () => {
    auth.auth.verifyOtp.mockResolvedValue({ data: { user: null }, error: { message: "fixture OTP expired" } });
    expect(await activateAdminInvitation(tokenHash)).toBe(false);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });
  it("rejects absent/invalid role from the shared bootstrap boundary and removes the new local session", async () => {
    mocks.bootstrap.mockResolvedValue(null);
    expect(await activateAdminInvitation(tokenHash)).toBe(false);
    expect(auth.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("does not allow a different UUID to claim the invitation", async () => {
    mocks.bootstrap.mockResolvedValue({ user: { id: sessionId, email: "fixture@example.test" }, claims: { aal: "aal1", session_id: sessionId } });
    expect(await activateAdminInvitation(tokenHash)).toBe(false);
  });
  it("fails closed on an atomic consumption race", async () => {
    const client = service(invite());
    client.rpc.mockResolvedValue({ data: false, error: null });
    mocks.service.mockReturnValue(client);
    expect(await activateAdminInvitation(tokenHash)).toBe(false);
    expect(auth.auth.signOut).toHaveBeenCalled();
  });
  it("permits password setup only in the consumed invitation's AAL1 session", async () => {
    mocks.service.mockReturnValue(service(invite({ consumed_at: new Date().toISOString() })));
    expect(await getAdminActivationContext()).not.toBeNull();
    mocks.bootstrap.mockResolvedValue({ user: { id: userId }, claims: { aal: "aal2", session_id: sessionId } });
    expect(await getAdminActivationContext()).toBeNull();
  });
});
