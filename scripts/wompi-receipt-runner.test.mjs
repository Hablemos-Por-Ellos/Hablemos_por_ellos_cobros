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
});
