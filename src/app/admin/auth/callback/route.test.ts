import { beforeEach, describe, expect, it, vi } from "vitest";
const activate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-auth-invitation", () => ({ activateAdminInvitation: activate }));
import { GET, dynamic } from "./route";

describe("private invite callback", () => {
  beforeEach(() => vi.clearAllMocks());
  it("is explicitly request-only rather than a cached GET response", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  it("rejects signup/recovery callbacks without consuming a token", async () => {
    const response = await GET(new Request("http://127.0.0.1:3000/admin/auth/callback?type=signup&token_hash=fixture"));
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/admin/activar?error=invalid");
    expect(activate).not.toHaveBeenCalled();
  });
  it("uses a fixed internal redirect and removes the token from the target URL", async () => {
    activate.mockResolvedValue(true);
    const response = await GET(new Request("http://127.0.0.1:3000/admin/auth/callback?type=invite&token_hash=fixture&next=https://evil.example"));
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/admin/activar");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
