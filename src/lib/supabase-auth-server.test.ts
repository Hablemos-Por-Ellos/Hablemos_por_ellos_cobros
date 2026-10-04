import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: null });
  return { create: vi.fn(() => ({ auth: { getUser } })), getUser, cookies: vi.fn(), headers: vi.fn(), service: vi.fn() };
});
vi.mock("@supabase/ssr", async (importOriginal) => ({ ...await importOriginal<typeof import("@supabase/ssr")>(), createServerClient: mocks.create }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("@/lib/supabase-server", () => ({ getServiceSupabaseClient: mocks.service }));
import { clearServerAuthCookies, getServerAuthSupabaseClient } from "./supabase-auth-server";
import { isAdminSchemaReady } from "./admin-auth";
import { NextRequest } from "next/server";
import { middleware } from "../../middleware";

describe("SSR Auth URL boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_OPERATION_MODE", "cutover");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fixture-anon");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-test-service-key");
    mocks.cookies.mockResolvedValue({ getAll: () => [], set: vi.fn() });
    mocks.headers.mockResolvedValue(new Headers({ host: "localhost:3000" }));
  });
  it("allows a fixture-only local client in cutover", async () => {
    expect(await getServerAuthSupabaseClient()).not.toBeNull();
    expect(mocks.create).toHaveBeenCalledWith("http://127.0.0.1:54321", "fixture-anon", expect.anything());
  });
  it("uses the same production cookie policy in SSR", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co");
    mocks.headers.mockResolvedValue(new Headers({ host: "app.example.test" }));
    await getServerAuthSupabaseClient();
    expect(mocks.create).toHaveBeenCalledWith("https://fixture.supabase.co", "fixture-anon",
      expect.objectContaining({ cookieOptions: { path: "/", sameSite: "lax", secure: true } }));
  });
  it("prevents caching even when Auth is disabled", async () => {
    vi.stubEnv("APP_OPERATION_MODE", "demo");
    const response = await middleware(new NextRequest("http://localhost:3000/admin/login"));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("preserves SDK cache headers and all cookie writes during a refresh", async () => {
    mocks.getUser.mockImplementationOnce(async () => {
      type Options = { cookies: { setAll: (values: { name: string; value: string; options: { path: string } }[], headers: Record<string, string>) => void } };
      const options = (mocks.create.mock.calls.at(-1) as unknown as [string, string, Options])[2];
      options.cookies.setAll([{ name: "fixture-a", value: "first", options: { path: "/" } }], {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
        Expires: "0", Pragma: "no-cache", "X-Fixture-Refresh": "retained",
      });
      options.cookies.setAll([{ name: "fixture-b", value: "second", options: { path: "/" } }], {});
      return { data: { user: null }, error: null };
    });
    const response = await middleware(new NextRequest("http://localhost:3000/admin"));
    expect(response.cookies.get("fixture-a")?.value).toBe("first");
    expect(response.cookies.get("fixture-b")?.value).toBe("second");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-fixture-refresh")).toBe("retained");
    expect(response.headers.get("x-middleware-request-cookie")).toContain("fixture-b=second");
  });
  it("does not even read cookies in demo", async () => {
    vi.stubEnv("APP_OPERATION_MODE", "demo");
    expect(await getServerAuthSupabaseClient()).toBeNull();
    expect(mocks.cookies).not.toHaveBeenCalled();
  });
  it("denies remote Auth from localhost even when VERCEL_ENV says production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co");
    expect(await getServerAuthSupabaseClient()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["preview", "development", ""])("rejects a remote URL in %s", async (environment) => {
    vi.stubEnv("VERCEL_ENV", environment);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co");
    expect(await getServerAuthSupabaseClient()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("accepts consistent production metadata without contacting real Auth", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co/");
    vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co");
    mocks.headers.mockResolvedValue(new Headers({ host: "app.example.test" }));
    expect(await getServerAuthSupabaseClient()).not.toBeNull();
    expect(mocks.create).toHaveBeenCalledWith("https://fixture.supabase.co/", "fixture-anon", expect.anything());
  });
  it("allows the ledger query only with consistent safe production metadata", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co/");
    mocks.headers.mockResolvedValue(new Headers({ host: "app.example.test" }));
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    mocks.service.mockReturnValue({ rpc });
    expect(await isAdminSchemaReady()).toBe(true);
    expect(rpc).toHaveBeenCalledWith("payment_admin_schema_ready");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1:54322", "https://other-fixture.supabase.co", ""])("denies inconsistent or missing service URL %s before ledger/client calls", async (serviceUrl) => {
    vi.stubEnv("SUPABASE_URL", serviceUrl);
    expect(await getServerAuthSupabaseClient()).toBeNull();
    expect(await isAdminSchemaReady()).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
  });
  it("denies different cloud projects even with production metadata", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("SUPABASE_URL", "https://other-fixture.supabase.co");
    mocks.headers.mockResolvedValue(new Headers({ host: "app.example.test" }));
    expect(await isAdminSchemaReady()).toBe(false);
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("clears only this project's Auth cookie chunks without creating a client", async () => {
    const set = vi.fn();
    mocks.cookies.mockResolvedValue({ getAll: () => [
      { name: "sb-127-auth-token.0", value: "fixture-cookie" },
      { name: "sb-127-auth-token.1", value: "fixture-cookie" },
      { name: "sb-other-auth-token", value: "fixture-cookie" },
      { name: "preferences", value: "fixture-cookie" },
    ], set });
    expect(await clearServerAuthCookies()).toBe(true);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith("sb-127-auth-token.0", "", expect.objectContaining({ path: "/", maxAge: 0 }));
    expect(set).toHaveBeenCalledWith("sb-127-auth-token.1", "", expect.objectContaining({ path: "/", maxAge: 0 }));
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not claim cookie cleanup when the writer fails", async () => {
    mocks.cookies.mockResolvedValue({ getAll: () => [{ name: "sb-127-auth-token", value: "fixture-cookie" }], set: () => { throw new Error("fixture write failure"); } });
    expect(await clearServerAuthCookies()).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not claim cookie cleanup without a valid project URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(await clearServerAuthCookies()).toBe(false);
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  async function runMiddleware(host: string | null = "localhost:3000", forwardedHost?: string) {
    const requestHeaders = new Headers();
    if (host !== null) requestHeaders.set("host", host);
    if (forwardedHost !== undefined) requestHeaders.set("x-forwarded-host", forwardedHost);
    mocks.headers.mockResolvedValue(requestHeaders);
    const request = new NextRequest("http://localhost:3000/admin", { headers: requestHeaders });
    return middleware(request);
  }

  it.each(["localhost", "127.0.0.1", "[::1]"])("uses the same local %s boundary in middleware and SSR", async (host) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://${host}:54321`);
    vi.stubEnv("SUPABASE_URL", `http://${host}:54321/`);
    const response = await runMiddleware(`${host}:3000`);
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(await getServerAuthSupabaseClient()).not.toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["localhost:3000", undefined], ["127.0.0.1:3000", undefined], ["[::1]:3000", undefined],
    ["app.example.test", "localhost:3000"], ["app.example.test", "127.0.0.1:3000"],
    ["app.example.test", "[::1]:3000"], ["app.example.test", "[::1"],
    ["app.example.test", "app.example.test/path"], ["app.example.test", "app.example.test, localhost:3000"],
    ["app.example.test", ""], ["app.example.test/path", undefined], [null, undefined],
  ])("does not construct or refresh cloud Auth from host=%s forwarded=%s", async (host, forwardedHost) => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co");
    expect((await runMiddleware(host, forwardedHost)).status).toBe(200);
    expect(await getServerAuthSupabaseClient()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
  });

  it.each([
    ["NEXT_PUBLIC_SUPABASE_URL", ""], ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ""],
    ["SUPABASE_URL", ""], ["SUPABASE_SERVICE_ROLE_KEY", ""],
    ["SUPABASE_SERVICE_ROLE_KEY", " "], ["SUPABASE_URL", "http://127.0.0.1:54322"],
    ["SUPABASE_URL", "http://user:fixture@127.0.0.1:54321"],
    ["NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321/path"],
    ["SUPABASE_URL", "http://127.0.0.1:54321?query=value"],
    ["SUPABASE_URL", "http://127.0.0.1:54321#fragment"], ["APP_OPERATION_MODE", "demo"],
  ])("denies %s=%s equally before any SDK client", async (name, value) => {
    vi.stubEnv(name, value);
    await runMiddleware();
    expect(await getServerAuthSupabaseClient()).toBeNull();
    expect(await isAdminSchemaReady()).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
  });

  it("refreshes the mocked user only with matching production cloud metadata", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co/");
    vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co");
    await runMiddleware("app.example.test", "proxy.example.test");
    expect(mocks.create).toHaveBeenCalledWith("https://fixture.supabase.co/", "fixture-anon", expect.anything());
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(await getServerAuthSupabaseClient()).not.toBeNull();
  });

  it.each(["preview", "development", ""])("middleware also denies cloud in %s", async (environment) => {
    vi.stubEnv("VERCEL_ENV", environment);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.co");
    await runMiddleware("app.example.test");
    expect(await getServerAuthSupabaseClient()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("denies different cloud origins in both callers", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("SUPABASE_URL", "https://other-fixture.supabase.co");
    await runMiddleware("app.example.test");
    expect(await getServerAuthSupabaseClient()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});
