import { describe, expect, it } from "vitest";
import { resolveWompiEnvironment } from "./wompi";

describe("resolveWompiEnvironment", () => {
  it("accepts the explicit production and sandbox aliases", () => {
    expect(resolveWompiEnvironment("prod", "production")).toBe("prod");
    expect(resolveWompiEnvironment("production", "production")).toBe("prod");
    expect(resolveWompiEnvironment("sandbox", "production")).toBe("sandbox");
    expect(resolveWompiEnvironment("test", "production")).toBe("sandbox");
  });

  it("defaults to sandbox only outside production", () => {
    expect(resolveWompiEnvironment(undefined, "test")).toBe("sandbox");
    expect(resolveWompiEnvironment(undefined, "development")).toBe("sandbox");
  });

  it("fails closed when the production environment is missing or invalid", () => {
    expect(() => resolveWompiEnvironment(undefined, "production")).toThrow("NEXT_PUBLIC_WOMPI_ENV_NOT_CONFIGURED");
    expect(() => resolveWompiEnvironment("typo", "production")).toThrow("NEXT_PUBLIC_WOMPI_ENV_NOT_CONFIGURED");
  });
});
