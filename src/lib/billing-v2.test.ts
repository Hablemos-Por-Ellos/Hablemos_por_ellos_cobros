import { describe, expect, it, vi } from "vitest";
import { applyBillingResult, billingRetrySchemaReady, canStartAuthorizedSend, verifiedBillingTransaction } from "./billing-v2";

describe("billing v2 boundary", () => {
  it("requires the new schema marker, not a successful legacy readiness call", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "42883" } });
    expect(await billingRetrySchemaReady({ rpc } as never)).toBe(false);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("billing_retry_schema_ready");
  });
  it("does not accept missing, stale, future or expired send grants", () => {
    const start = Date.parse("2026-10-09T12:00:00Z");
    const grant = { canDispatch: true, sendAuthorizedAt: new Date(start).toISOString(), windowEnd: "2026-10-10T05:00:00Z" };
    expect(canStartAuthorizedSend(grant, start)).toBe(true);
    expect(canStartAuthorizedSend(grant, start + 14999)).toBe(true);
    expect(canStartAuthorizedSend(grant, start + 15000)).toBe(false);
    expect(canStartAuthorizedSend(grant, start - 1)).toBe(false);
    expect(canStartAuthorizedSend({ ...grant, windowEnd: new Date(start).toISOString() }, start)).toBe(false);
    expect(canStartAuthorizedSend({}, start)).toBe(false);
  });
  it("passes only provider GET evidence fields, never arbitrary payload or a card token", () => {
    const result = verifiedBillingTransaction({ id: "fixture", status: "DECLINED", statusMessage: "Intente mas tarde - Fondos Insuficientes", finalizedAt: "2026-10-08T19:00:00Z", cardToken: "forbidden" } as never);
    expect(result.verification_source).toBe("provider_get");
    expect(result.status_message).toBe("Intente mas tarde - Fondos Insuficientes");
    expect(result).not.toHaveProperty("cardToken");
  });
  it("rejects an incomplete atomic result", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(applyBillingResult({ rpc } as never, "fixture", { id: "fixture", status: "pending" })).rejects.toThrow("BILLING_RESULT_NOT_APPLIED");
  });
});
