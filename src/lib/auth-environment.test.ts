import { describe, expect, it } from "vitest";
import { authCookieOptions, isAuthEnvironmentAllowed } from "./auth-environment";

const local = {
  operationMode: "cutover", deploymentEnvironment: "preview",
  supabaseUrl: "http://127.0.0.1:54321", serviceUrl: "http://127.0.0.1:54321",
  anonKey: "fixture-anon", serviceKey: "local-test-service-key",
};
const production = {
  ...local, deploymentEnvironment: "production",
  supabaseUrl: "https://fixture.supabase.co/", serviceUrl: "https://fixture.supabase.co",
};
const remoteHeaders = new Headers({ host: "app.example.test" });

describe("standard Auth cookie transport", () => {
  it("requires HTTPS for production cookies", () => {
    expect(authCookieOptions("production")).toEqual({ path: "/", sameSite: "lax", secure: true });
  });
  it.each([undefined, "preview", "development"])("retains HTTP support for the local lab (%s)", (environment) => {
    expect(authCookieOptions(environment)).toEqual({ path: "/", sameSite: "lax", secure: false });
  });
});

describe("pure Auth environment contract (Node/Edge compatible)", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("allows only local %s fixtures outside production", (host) => {
    const environment = { ...local, supabaseUrl: `http://${host}:54321`, serviceUrl: `http://${host}:54321/` };
    expect(isAuthEnvironmentAllowed(environment)).toBe(true);
    expect(isAuthEnvironmentAllowed({ ...environment, deploymentEnvironment: "production" }, remoteHeaders)).toBe(false);
  });
  it("allows matching HTTPS cloud origins only with production and remote request metadata", () => {
    expect(isAuthEnvironmentAllowed(production, remoteHeaders)).toBe(true);
    expect(isAuthEnvironmentAllowed(production)).toBe(false);
    expect(isAuthEnvironmentAllowed(production, new Headers({ host: "app.example.test", "x-forwarded-host": "proxy.example.test:443" }))).toBe(true);
  });
  it.each(["preview", "development", ""])("denies cloud outside production (%s)", (deploymentEnvironment) => {
    expect(isAuthEnvironmentAllowed({ ...production, deploymentEnvironment }, remoteHeaders)).toBe(false);
  });
  it("denies demo for both local and cloud", () => {
    for (const environment of [local, production]) {
      expect(isAuthEnvironmentAllowed({ ...environment, operationMode: "demo" }, remoteHeaders)).toBe(false);
    }
  });
  it.each(["supabaseUrl", "serviceUrl", "anonKey", "serviceKey"] as const)("requires %s before any Auth call", (key) => {
    for (const value of [undefined, "", " "]) {
      expect(isAuthEnvironmentAllowed({ ...local, [key]: value }, remoteHeaders)).toBe(false);
      expect(isAuthEnvironmentAllowed({ ...production, [key]: value }, remoteHeaders)).toBe(false);
    }
  });
  it.each(["http://127.0.0.1:54322", "http://localhost:54321", "https://other-fixture.supabase.co"])("denies mismatching origin %s", (serviceUrl) => {
    expect(isAuthEnvironmentAllowed({ ...local, serviceUrl }, remoteHeaders)).toBe(false);
    expect(isAuthEnvironmentAllowed({ ...production, serviceUrl }, remoteHeaders)).toBe(false);
  });
  it.each([
    "http://fixture.supabase.co", "https://user:fixture@fixture.supabase.co",
    "https://fixture.supabase.co/path", "https://fixture.supabase.co/path/..",
    "https://fixture.supabase.co?query=value", "https://fixture.supabase.co?",
    "https://fixture.supabase.co#fragment", "https://fixture.supabase.co#",
    " https://fixture.supabase.co", "https://fixture.supabase.co\\",
    "file:///fixture", "not-a-url",
  ])("rejects unsafe project URL %s for either configuration", (url) => {
    expect(isAuthEnvironmentAllowed({ ...production, supabaseUrl: url }, remoteHeaders)).toBe(false);
    expect(isAuthEnvironmentAllowed({ ...production, serviceUrl: url }, remoteHeaders)).toBe(false);
  });
  it.each([
    "localhost:3000", "localhost.:3000", "admin.localhost:3000", "127.0.0.1:3000",
    "127.0.0.2:3000", "127.1:3000", "[::1]:3000", "[::ffff:127.0.0.1]:3000",
    "0.0.0.0:3000", "[::]:3000", "", "[::1", "app.example.test:invalid",
    "https://app.example.test", "app.example.test/path", "app.example.test?query=value",
    "app.example.test#fragment", "user@app.example.test", "app.example.test, localhost:3000",
    "app.example.test\\localhost", "app.example.test:99999",
  ])("denies local/malformed host or forwarded host %s even in production", (host) => {
    expect(isAuthEnvironmentAllowed(production, new Headers({ host }))).toBe(false);
    expect(isAuthEnvironmentAllowed(production, new Headers({ host: "app.example.test", "x-forwarded-host": host }))).toBe(false);
  });
  it("requires Host even when the forwarded host is remote", () => {
    expect(isAuthEnvironmentAllowed(production, new Headers({ "x-forwarded-host": "app.example.test" }))).toBe(false);
  });
});
