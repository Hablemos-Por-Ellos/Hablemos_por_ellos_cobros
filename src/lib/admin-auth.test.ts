import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerAuthSupabaseClient: vi.fn(),
  getServiceSupabaseClient: vi.fn(),
}));
vi.mock("@/lib/supabase-server", () => ({ getServiceSupabaseClient: mocks.getServiceSupabaseClient }));

vi.mock("@/lib/supabase-auth-server", () => ({
  getServerAuthSupabaseClient: mocks.getServerAuthSupabaseClient,
  isServerAuthEnvironmentAllowed: vi.fn().mockResolvedValue(true),
}));

import { getAdminContext, getAdminBootstrapContext, isSameOriginRequest, verifyRecentTotp } from "@/lib/admin-auth";

describe("exact source/target origin validation", () => {
  afterEach(() => vi.unstubAllEnvs());
  const request = (origin?: string, headers: Record<string, string> = {}, url = "http://localhost:3001/api/admin/bootstrap") =>
    new Request(url, { headers: { ...headers, ...(origin === undefined ? {} : { origin }) } });

  it("accepts the actual loopback Host even when Next uses localhost internally", () => {
    vi.stubEnv("VERCEL_ENV", "development");
    expect(isSameOriginRequest(request("http://127.0.0.1:3001", { host: "127.0.0.1:3001" }))).toBe(true);
    expect(isSameOriginRequest(request("http://localhost:3001", { host: "127.0.0.1:3001" }))).toBe(false);
  });
  it("rejects missing Host metadata instead of trusting an internal URL", () => {
    expect(isSameOriginRequest(request("http://localhost:3001"))).toBe(false);
    expect(isSameOriginRequest(request("http://127.0.0.1:3001"))).toBe(false);
    expect(isSameOriginRequest(request("http://localhost:3001", { "x-forwarded-host": "foreign.example.test" }))).toBe(false);
  });
  it.each([undefined, "null", "https://foreign.example.test", "http://127.0.0.1:3002", "https://127.0.0.1:3001",
    "http://127.0.0.1:3001/path", "http://user@127.0.0.1:3001", "http://127.0.0.1:3001?query=value"])("rejects missing, malformed or foreign Origin %s", (origin) => {
    expect(isSameOriginRequest(request(origin, { host: "127.0.0.1:3001" }))).toBe(false);
  });
  it.each(["", "foreign.example.test", "127.0.0.1:3001/path", "user@127.0.0.1:3001", "127.0.0.1:3001,other", "127.0.0.1:invalid", "127.0.0.1:3001#fragment"])("rejects inconsistent or malformed Host %s", (host) => {
    expect(isSameOriginRequest(request("http://127.0.0.1:3001", { host }))).toBe(false);
  });
  it("rejects ambiguous forwarded host instead of trusting it", () => {
    expect(isSameOriginRequest(request("http://127.0.0.1:3001", {
      host: "127.0.0.1:3001", "x-forwarded-host": "foreign.example.test",
    }))).toBe(false);
  });
  it("accepts HTTPS proxy metadata only in the Production profile", () => {
    const proxied = request("https://app.example.test", {
      host: "app.example.test", "x-forwarded-host": "app.example.test", "x-forwarded-proto": "https",
    });
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isSameOriginRequest(proxied)).toBe(true);
    vi.stubEnv("VERCEL_ENV", "development");
    expect(isSameOriginRequest(proxied)).toBe(false);
  });
  it.each(["https,http", "invalid", "http"])("does not accept inconsistent proxy protocol %s for HTTPS", (protocol) => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isSameOriginRequest(request("https://app.example.test", {
      host: "app.example.test", "x-forwarded-proto": protocol,
    }))).toBe(false);
  });
  it("never downgrades a production source origin to HTTP", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isSameOriginRequest(request("http://app.example.test", {
      host: "app.example.test", "x-forwarded-proto": "http",
    }, "https://app.example.test/api/admin/bootstrap"))).toBe(false);
  });
  it("keeps the explicit local HTTP transport independent of a reconstructed HTTPS URL", () => {
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("HPE_LOCAL_INTEGRATION", "true");
    expect(isSameOriginRequest(request("https://127.0.0.1:3001", {
      host: "127.0.0.1:3001", "x-forwarded-proto": "https",
    }, "https://localhost:3001/api/admin/bootstrap"))).toBe(false);
    expect(isSameOriginRequest(request("http://127.0.0.1:3001", {
      host: "127.0.0.1:3001", "x-forwarded-proto": "http",
    }))).toBe(true);
    expect(isSameOriginRequest(request("http://foreign.example.test", { host: "foreign.example.test" }))).toBe(false);
  });
});

function authClient({
  user = { id: "10000000-0000-0000-0000-000000000001", email: "admin@example.test" },
  aal = "aal2",
  admin = { role: "admin", active: true, sessions_valid_after: "1970-01-01T00:00:00Z" },
  issuedAt = Math.floor(Date.now() / 1000) - 60,
  challengeError = null as { message: string } | null,
} = {}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      getClaims: vi.fn().mockResolvedValue({ data: { claims: { sub: user.id, aal, iat: issuedAt, exp: Math.floor(Date.now() / 1000) + 600 } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
          data: { currentLevel: aal },
          error: null,
        }),
        listFactors: vi.fn().mockResolvedValue({
          data: { totp: [{ id: "factor-1", status: "verified" }] },
          error: null,
        }),
        challengeAndVerify: vi.fn().mockResolvedValue({ data: null, error: challengeError }),
      },
    },
    from: vi.fn(() => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: vi.fn().mockResolvedValue({ data: admin, error: null }),
      };
      return query;
    }),
    rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
  };
}

describe("admin authentication boundary", () => {
  beforeEach(() => {
    vi.stubEnv("APP_OPERATION_MODE", "active");
    vi.stubEnv("ADMIN_DEMO_MODE", "false");
    mocks.getServiceSupabaseClient.mockReturnValue(authClient());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("rejects a valid user session that has not completed MFA", async () => {
    vi.stubEnv("ADMIN_DEMO_MODE", "false");
    mocks.getServerAuthSupabaseClient.mockResolvedValue(authClient({ aal: "aal1" }));

    await expect(getAdminContext()).resolves.toBeNull();
  });

  it("rejects an authenticated user that is not active in the allowlist", async () => {
    vi.stubEnv("ADMIN_DEMO_MODE", "false");
    mocks.getServerAuthSupabaseClient.mockResolvedValue(authClient({
      admin: { role: "admin", active: false, sessions_valid_after: "1970-01-01T00:00:00Z" },
    }));

    await expect(getAdminContext()).resolves.toBeNull();
  });

  it("accepts only an active allowlisted user with aal2", async () => {
    vi.stubEnv("ADMIN_DEMO_MODE", "false");
    mocks.getServerAuthSupabaseClient.mockResolvedValue(authClient());

    await expect(getAdminContext()).resolves.toEqual(expect.objectContaining({
      userId: "10000000-0000-0000-0000-000000000001",
      email: "admin@example.test",
      role: "admin",
      demo: false,
    }));
  });

  it("requires a verified TOTP challenge for each sensitive mutation", async () => {
    vi.stubEnv("ADMIN_DEMO_MODE", "false");
    mocks.getServerAuthSupabaseClient.mockResolvedValue(authClient({
      challengeError: { message: "invalid code" },
    }));

    await expect(verifyRecentTotp("123456")).resolves.toBe(false);
    await expect(verifyRecentTotp("12345x")).resolves.toBe(false);
  });

  it.each(["viewer", "", "owner"])("rejects unexpected role %s at the panel and bootstrap", async (role) => {
    const client = authClient({ admin: { role, active: true, sessions_valid_after: "1970-01-01T00:00:00Z" } });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getServerAuthSupabaseClient.mockResolvedValue(client);
    expect(await getAdminContext()).toBeNull();
    expect(await getAdminBootstrapContext()).toBeNull();
  });

  it.each([-1, 0])("rejects JWTs issued before or exactly at the revocation boundary (%s)", async (offset) => {
    const cutoff = Math.floor(Date.now() / 1000) - 100;
    mocks.getServerAuthSupabaseClient.mockResolvedValue(authClient({
      issuedAt: cutoff + offset,
      admin: { role: "admin", active: true, sessions_valid_after: new Date(cutoff * 1000).toISOString() },
    }));
    expect(await getAdminContext()).toBeNull();
  });

  it("allows onboarding at AAL1 but not the panel", async () => {
    mocks.getServerAuthSupabaseClient.mockResolvedValue(authClient({ aal: "aal1" }));
    expect(await getAdminBootstrapContext()).not.toBeNull();
    expect(await getAdminContext()).toBeNull();
  });

  it("does not connect demo or treat demo as fresh TOTP", async () => {
    vi.stubEnv("APP_OPERATION_MODE", "demo");
    vi.stubEnv("ADMIN_DEMO_MODE", "true");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await getAdminContext())?.demo).toBe(true);
    expect(await verifyRecentTotp("123456")).toBe(false);
    expect(mocks.getServerAuthSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.getServiceSupabaseClient).not.toHaveBeenCalled();
  });

  it("requires the schema readiness ledger before querying identities", async () => {
    mocks.getServiceSupabaseClient.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: false, error: null }) });
    expect(await getAdminContext()).toBeNull();
    expect(mocks.getServerAuthSupabaseClient).not.toHaveBeenCalled();
  });
});
