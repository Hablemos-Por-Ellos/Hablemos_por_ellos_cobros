import { beforeEach, describe, expect, it, vi } from "vitest";
const create = vi.hoisted(() => vi.fn(() => ({ auth: {} })));
vi.mock("@supabase/ssr", () => ({ createBrowserClient: create }));
import { getBrowserSupabaseClient, isSafeBrowserAuthUrl } from "./supabase-auth-browser";

describe("browser Auth environment boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_OPERATION_MODE", "cutover");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "local-fixture-anon");
  });
  it("never constructs a client in public demo, even after a cached real client", () => {
    getBrowserSupabaseClient();
    create.mockClear();
    vi.stubEnv("NEXT_PUBLIC_APP_OPERATION_MODE", "demo");
    expect(() => getBrowserSupabaseClient()).toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("uses HTTP-compatible cookie options only for local fixtures", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fixture-browser-cookie-policy");
    getBrowserSupabaseClient();
    expect(create).toHaveBeenCalledWith("http://127.0.0.1:54321", "fixture-browser-cookie-policy", {
      cookieOptions: { path: "/", sameSite: "lax", secure: false },
    });
  });
  it.each(["preview", "development", ""])("denies cloud in %s", (environment) => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", environment);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    expect(() => getBrowserSupabaseClient()).toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("denies a cloud Auth host on localhost even with the production flag", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    expect(isSafeBrowserAuthUrl("https://fixture.supabase.co")).toBe(false);
  });
  it("rejects embedded credentials and non-HTTP schemes", () => {
    expect(isSafeBrowserAuthUrl("http://user:fixture@127.0.0.1:54321")).toBe(false);
    expect(isSafeBrowserAuthUrl("file:///fixture")).toBe(false);
  });
});
