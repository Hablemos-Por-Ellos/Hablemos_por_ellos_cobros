import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getServiceSupabaseClient: mocks.client }));
import { GET } from "./route";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "fixture-cron-secret"); });
afterEach(() => vi.unstubAllEnvs());
describe("keepalive is read-only under billing v2", () => {
  it("rejects missing authorization before touching the database", async () => {
    expect((await GET(new Request("http://127.0.0.1:3000/api/cron/keepalive"))).status).toBe(401);
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("keeps activity without cleanup, old RPCs or any financial writes", async () => {
    const limit = vi.fn().mockResolvedValue({ error: null });
    const select = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ select });
    const rpc = vi.fn(() => { throw new Error("No RPC allowed"); });
    mocks.client.mockReturnValue({ from, rpc });
    expect((await GET(new Request("http://127.0.0.1:3000/api/cron/keepalive", { headers: { authorization: "Bearer fixture-cron-secret" } }))).status).toBe(200);
    expect(from).toHaveBeenCalledExactlyOnceWith("subscriptions"); expect(select).toHaveBeenCalledExactlyOnceWith("id");
    expect(limit).toHaveBeenCalledExactlyOnceWith(1); expect(rpc).not.toHaveBeenCalled();
  });
});
