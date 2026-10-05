import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertBillingJobOperations, assertBillingJobRuntime, parseBillingJobMode,
  logBillingJobError } from "./billing-job-mode.mjs";

const local = { APP_OPERATION_MODE: "active", FINANCIAL_OPERATIONS_ENABLED: "true",
  SUPABASE_URL: "http://127.0.0.1:54321", WOMPI_ENV: "sandbox" };

describe("billing job modes", () => {
  it("restricts the production keepalive job to main", () => {
    const workflow = readFileSync(".github/workflows/keepalive.yml", "utf8")
      .replaceAll("\r\n", "\n");
    expect(workflow).toContain("  ping:\n    if: github.ref == 'refs/heads/main'\n    environment: Production");
  });

  it("uses only the exclusive 0.3.0 Supabase secret for monthly charges", () => {
    const workflow = readFileSync(".github/workflows/monthly-charges.yml", "utf8")
      .replaceAll("\r\n", "\n");
    expect(workflow).toContain("          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY_V030 }}\n");
    expect(workflow.match(/^\s*SUPABASE_SERVICE_ROLE_KEY:/gm)).toHaveLength(1);
    expect(workflow).not.toMatch(/\bsecrets\.SUPABASE_SERVICE_ROLE_KEY\b/);
  });

  it.each(["inventory", "reconcile", "charge"])("requires explicit CLI mode %s", (mode) => {
    expect(parseBillingJobMode([`--mode=${mode}`])).toBe(mode);
    expect(assertBillingJobRuntime(mode, local)).toBe(mode);
  });

  it.each([[], ["--mode=unknown"], ["--mode="], ["--mode", "charge"],
    ["--mode=charge", "--mode=inventory"], ["--mode=charge", "extra"]])("rejects ambiguous CLI %j", (args) => {
    expect(() => parseBillingJobMode(args)).toThrow("BILLING_JOB_MODE_REQUIRED");
  });

  it.each([{}, { APP_OPERATION_MODE: "cutover", FINANCIAL_OPERATIONS_ENABLED: "true" },
    { APP_OPERATION_MODE: "active", FINANCIAL_OPERATIONS_ENABLED: "TRUE" },
    { APP_OPERATION_MODE: "active" }])("fails closed for inactive finances %j", (env) => {
    expect(() => assertBillingJobOperations("charge", env)).toThrow("FINANCIAL_OPERATIONS_DISABLED");
  });

  it.each(["inventory", "reconcile", "charge"])("demo never connects in %s", (mode) => {
    expect(() => assertBillingJobRuntime(mode, { ...local, APP_OPERATION_MODE: "demo" }))
      .toThrow("BILLING_JOB_DEMO_DISABLED");
  });

  it.each([undefined, "preview", "development"])("forbids cloud outside production %s", (VERCEL_ENV) => {
    expect(() => assertBillingJobRuntime("inventory", { ...local, VERCEL_ENV,
      SUPABASE_URL: "https://fixture.supabase.co" })).toThrow("BILLING_JOB_SUPABASE_URL_UNSAFE");
  });

  it("requires an explicit production environment in scheduled CI", () => {
    const env = { ...local, CI: "true", WOMPI_ENV: "prod", SUPABASE_URL: "https://fixture.supabase.co" };
    expect(() => assertBillingJobRuntime("charge", env)).toThrow();
    expect(assertBillingJobRuntime("charge", { ...env, VERCEL_ENV: "production" })).toBe("charge");
    expect(() => assertBillingJobRuntime("charge", { ...local, CI: "true", WOMPI_ENV: "prod" }))
      .toThrow("BILLING_JOB_PRODUCTION_NOT_ALLOWED");
  });

  it.each([undefined, "refs/heads/dev", "refs/tags/v0.3.0", "refs/pull/1/merge", "refs/heads/main-extra"])
    ("GitHub Actions rejects charge outside the exact main ref %s", (GITHUB_REF) => {
      const env = { ...local, GITHUB_ACTIONS: "true", GITHUB_REF };
      expect(() => assertBillingJobRuntime("charge", env)).toThrow("BILLING_JOB_PRODUCTION_NOT_ALLOWED");
      expect(assertBillingJobRuntime("inventory", env)).toBe("inventory");
      expect(assertBillingJobRuntime("reconcile", env)).toBe("reconcile");
    });

  it("allows GitHub main and does not infer GitHub restrictions for generic Node jobs", () => {
    expect(assertBillingJobRuntime("charge", { ...local, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" })).toBe("charge");
    expect(assertBillingJobRuntime("charge", { ...local, CI: "true", GITHUB_ACTIONS: "false", GITHUB_REF: "refs/heads/dev" })).toBe("charge");
  });

  it.each(["file:///fixture", "https://user:password@fixture.supabase.co", "http://fixture.supabase.co",
    "http://127.0.0.1:54321?secret=fixture", "not-a-url"])("rejects unsafe URL %s", (SUPABASE_URL) => {
    expect(() => assertBillingJobRuntime("inventory", { ...local, SUPABASE_URL })).toThrow();
  });

  it("logs only allowlisted codes, even for unknown secrets and arbitrary thrown values", () => {
    const logger = { error: vi.fn() };
    for (const error of [new Error("opaque-acceptance-fixture"), { code: "fixture-secret" }, "private-fixture"]) {
      logBillingJobError(logger, error);
    }
    expect(logger.error.mock.calls.flat()).toEqual(Array(3).fill(
      "Monthly billing failed code=BILLING_JOB_OPERATIONAL_FAILURE"));
  });
});
