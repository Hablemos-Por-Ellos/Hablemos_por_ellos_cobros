// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => ({ privateKey: vi.fn(), publicKey: vi.fn(), environment: "sandbox" as "sandbox" | "prod" }));
vi.mock("@/lib/wompi", () => ({
  get WOMPI_ENV() { return keys.environment; },
  getWompiApiBaseUrl: () => keys.environment === "prod" ? "https://production.wompi.co/v1" : "https://sandbox.wompi.co/v1",
  getWompiPrivateKey: keys.privateKey,
  getWompiPublicKey: keys.publicKey,
  getWompiIntegritySecret: () => "test_integrity_fixture_only",
}));
import { isWompiPaymentSourceAvailable } from "./wompi-server";

describe("server-only card source verification", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    keys.environment = "sandbox";
    keys.privateKey.mockReturnValue("prv_test_fixture_only");
    keys.publicKey.mockReturnValue("pub_test_fixture_only");
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the private credential and verifies the exact available card", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: 123, type: "CARD", status: "AVAILABLE" } })));
    expect(await isWompiPaymentSourceAvailable("123")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://sandbox.wompi.co/v1/payment_sources/123", expect.objectContaining({
      headers: { Authorization: "Bearer prv_test_fixture_only" }, cache: "no-store", signal: expect.any(AbortSignal),
    }));
    expect(keys.publicKey).not.toHaveBeenCalled();
  });

  it.each([
    { id: 456, type: "CARD", status: "AVAILABLE" },
    { id: 123, type: "NEQUI", status: "AVAILABLE" },
    { id: 123, type: "CARD", status: "PENDING" },
    { id: 123, type: "CARD", status: "VOIDED" },
  ])("rejects an unrelated, non-card or unavailable source: %j", async (data) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data })));
    expect(await isWompiPaymentSourceAvailable("123")).toBe(false);
  });

  it("fails closed on an unauthorized provider response", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { type: "INVALID_ACCESS_TOKEN" } }), { status: 401 }));
    await expect(isWompiPaymentSourceAvailable("123")).rejects.toThrow("No se pudo verificar la fuente de pago");
  });

  it("uses the production private credential only on the production endpoint", async () => {
    keys.environment = "prod";
    keys.privateKey.mockReturnValue("prv_prod_fixture_only");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: 123, type: "CARD", status: "AVAILABLE" } })));
    expect(await isWompiPaymentSourceAvailable("123")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://production.wompi.co/v1/payment_sources/123", expect.objectContaining({
      headers: { Authorization: "Bearer prv_prod_fixture_only" },
    }));
    expect(keys.publicKey).not.toHaveBeenCalled();
  });

  it("does not convert a timeout into permission to reactivate", async () => {
    fetchMock.mockRejectedValue(new DOMException("fixture timeout", "TimeoutError"));
    await expect(isWompiPaymentSourceAvailable("123")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed JSON", async () => {
    fetchMock.mockResolvedValue(new Response("not-json"));
    await expect(isWompiPaymentSourceAvailable("123")).rejects.toThrow("No se pudo verificar la fuente de pago");
  });

  it.each(["", "prv_prod_fixture_only"])("rejects absent or wrong-environment credentials before HTTP", async (key) => {
    keys.privateKey.mockReturnValue(key);
    await expect(isWompiPaymentSourceAvailable("123")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
