import { beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-auth-invitation", () => ({ getAdminActivationContext: context }));
import { POST } from "./route";
const request = (body: unknown, origin = "http://127.0.0.1:3000") => new Request("http://127.0.0.1:3000/api/admin/activation/password", {
  method: "POST", headers: { Origin: origin, Host: "127.0.0.1:3000", "Content-Type": "application/json" }, body: JSON.stringify(body),
});
describe("invite-only own password setup", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects expired/reused/non-invitation sessions", async () => {
    context.mockResolvedValue(null);
    expect((await POST(request({ password: "fixture-password-only" }))).status).toBe(403);
  });
  it("rejects cross-origin requests before reading the identity", async () => {
    expect((await POST(request({}, "https://evil.example"))).status).toBe(403);
    expect(context).not.toHaveBeenCalled();
  });
  it("updates only the authenticated user's password, never an operator-assigned identity or role", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    context.mockResolvedValue({ supabase: { auth: { updateUser } } });
    expect((await POST(request({ password: "fixture-password-only", userId: "someone-else" }))).status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
    expect((await POST(request({ password: "fixture-password-only" }))).status).toBe(200);
    expect(updateUser).toHaveBeenCalledWith({ password: "fixture-password-only" });
  });
});
