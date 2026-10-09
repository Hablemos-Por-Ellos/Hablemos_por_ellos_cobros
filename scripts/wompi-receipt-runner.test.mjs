// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { reconcileWompiReceipts } from "./wompi-receipt-runner.mjs";

describe("durable receipt recovery", () => {
  it("preserves unknown approval time instead of inventing one", async () => {
    const receipt = { id: "receipt", raw: { receipt_version: 1, event_timestamp: null,
      transaction: { id: "tx", status: "APPROVED", reference: "REF", amount_in_cents: 150000, currency: "COP" } } };
    const query = { select: () => query, in: () => query, order: () => query, range: async () => ({ data: [receipt], error: null }) };
    const rpc = vi.fn(async () => ({ data: { result: "review" }, error: null }));
    const stats = await reconcileWompiReceipts({ supabase: { from: () => query, rpc },
      getTransaction: async () => ({ id: "tx", status: "approved", reference: "REF", amountInCents: 150000, currency: "COP" }) });
    expect(stats.review).toBe(1);
    expect(rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({ p_effective_at: null, p_candidate_next_payment: null }));
  });
  it.each([true, false])("only scopes a linked, schedule-protected historical review: %s", async (linked) => {
    const transaction = { id: "tx", reference: "REF", amountInCents: 150000, currency: "COP", status: "declined",
      paymentSourceId: "src", paymentMethodType: "CARD", statusMessage: "Intente mas tarde - Fondos Insuficientes",
      finalizedAt: "2026-10-08T18:00:00Z", environment: "sandbox", verificationSource: "provider_get" };
    const receipt = { id: "receipt", raw: { receipt_version: 1, transaction: { id: "tx", reference: "REF", amount_in_cents: 150000, currency: "COP" } } };
    const query = { select: () => query, in: () => query, order: () => query, range: async () => ({ data: [receipt], error: null }) };
    const rpc = vi.fn(async () => ({ data: { result: "review", reason: "LEGACY_RESULT_SCHEDULE_PROTECTED",
      historicalOnly: true, scheduleProtected: true, subscriptionId: linked ? "00000000-0000-4000-a000-000000000001" : null,
      transactionId: "tx" }, error: null }));
    const source = { id: "src", type: "CARD", status: "AVAILABLE", environment: "sandbox", verificationSource: "provider_get", verifiedAt: "2026-10-08T18:00:01Z" };
    const getPaymentSource = vi.fn().mockResolvedValue(source);
    const stats = await reconcileWompiReceipts({ supabase: { from: () => query, rpc }, getTransaction: async () => transaction, getPaymentSource });
    expect(stats).toMatchObject({ review: 1, scopedReview: linked ? 1 : 0 });
    expect(getPaymentSource).toHaveBeenCalledExactlyOnceWith({ paymentSourceId: "src" });
    expect(rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({ p_raw: expect.objectContaining({
      verification_source: "provider_get", environment: "sandbox", payment_source_verification: expect.objectContaining({ id: "src", verification_source: "provider_get" }),
      transaction: expect.objectContaining({ payment_source_id: "src", status_message: transaction.statusMessage, payment_method_type: "CARD" }),
    }) }));
  });
});
