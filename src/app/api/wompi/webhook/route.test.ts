import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/wompi", () => ({
  getWompiEventsSecret: () => "prod_events_test",
}));

const insertCalls: Array<{ table: string; payload: unknown }> = [];

vi.mock("@/lib/supabase-server", () => ({
  getServiceSupabaseClient: () => ({
    from: (table: string) => ({
      insert: async (payload: unknown) => {
        insertCalls.push({ table, payload });
        return { error: null };
      },
    }),
  }),
}));

import {
  computeWompiEventChecksum,
  extractPaymentSourceId,
  isValidWompiEventChecksum,
} from "@/lib/wompi-webhook";
import { POST } from "./route";

describe("Wompi webhook helpers", () => {
  it("validates Wompi Colombia checksum format", () => {
    const payload = {
      data: {
        transaction: {
          id: "1234-1610641025-49201",
          status: "APPROVED",
          amount_in_cents: 4490000,
        },
      },
      signature: {
        properties: ["transaction.id", "transaction.status", "transaction.amount_in_cents"],
        checksum: "",
      },
      timestamp: 1530291411,
    };
    const checksum = computeWompiEventChecksum(payload, "prod_events_test");

    expect(checksum).toBeTruthy();
    expect(isValidWompiEventChecksum(payload, checksum, "prod_events_test")).toBe(true);
    expect(isValidWompiEventChecksum(payload, "bad-checksum", "prod_events_test")).toBe(false);
  });

  it("extracts payment_source_id from root and nested transaction shapes", () => {
    expect(extractPaymentSourceId({ id: "tx", payment_source_id: 1234 })).toBe("1234");
    expect(
      extractPaymentSourceId({
        id: "tx",
        payment_method: { extra: { payment_source_id: "src_nested" } },
      })
    ).toBe("src_nested");
  });
});

describe("POST /api/wompi/webhook", () => {
  beforeEach(() => {
    insertCalls.length = 0;
  });

  it("stores a valid signed event before returning 200", async () => {
    const payload = {
      event: "test.event",
      data: { probe: "ok" },
      signature: {
        properties: ["probe"],
        checksum: "",
      },
      timestamp: 1530291411,
    };
    payload.signature.checksum = computeWompiEventChecksum(payload, "prod_events_test") ?? "";

    const response = await POST(
      new Request("https://example.test/api/wompi/webhook", {
        method: "POST",
        headers: { "x-event-checksum": payload.signature.checksum },
        body: JSON.stringify(payload),
      })
    );

    expect(response.status).toBe(200);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ table: "webhook_events" });
  });
});
