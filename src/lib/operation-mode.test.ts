import { afterEach, describe, expect, it, vi } from "vitest";
import { financialOperationsEnabled, getAppOperationMode, isSafeSupabaseUrl } from "./operation-mode";

afterEach(() => vi.unstubAllEnvs());
describe("financial operation barriers", () => {
  it("fails closed with an omitted or unknown mode", () => {
    vi.stubEnv("APP_OPERATION_MODE", "unknown");
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "true");
    expect(getAppOperationMode()).toBe("cutover");
    expect(financialOperationsEnabled()).toBe(false);
  });
  it("requires both gates to open", () => {
    vi.stubEnv("APP_OPERATION_MODE", "active");
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "false");
    expect(financialOperationsEnabled()).toBe(false);
  });
  it("cannot reach a cloud database from local or preview execution", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(isSafeSupabaseUrl("https://fictional.supabase.co")).toBe(false);
    expect(isSafeSupabaseUrl("http://127.0.0.1:54321")).toBe(true);
  });
  it("rejects API URLs containing credentials or extra paths", () => {
    expect(isSafeSupabaseUrl("http://user:secret@127.0.0.1:54321")).toBe(false);
    expect(isSafeSupabaseUrl("http://127.0.0.1:54321/another-project?key=fake")).toBe(false);
  });
});
