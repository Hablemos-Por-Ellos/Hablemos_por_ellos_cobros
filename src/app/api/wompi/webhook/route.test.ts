import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/wompi", () => ({
  getWompiEventsSecret: () => "prod_events_test",
}));

const insertCalls: Array<{ table: string; payload: unknown }> = [];
const updateCalls: Array<{ table: string; payload: Record<string, unknown> }> = [];
let subscriptionRecord: Record<string, unknown>;
let paymentRecord: Record<string, unknown> | null;

vi.mock("@/lib/supabase-server", () => ({
  getServiceSupabaseClient: () => ({
    from: (table: string) => {
      const state: {
        payload?: Record<string, unknown>;
        filters: Record<string, unknown>;
      } = { filters: {} };

      const builder = {
        insert: (payload: unknown) => {
          state.payload = payload as Record<string, unknown>;
          if (table === "payments") paymentRecord = payload as Record<string, unknown>;
          insertCalls.push({ table, payload });
          return builder;
        },
        update: (payload: Record<string, unknown>) => {
          state.payload = payload;
          updateCalls.push({ table, payload });
          if (table === "subscriptions") subscriptionRecord = { ...subscriptionRecord, ...payload };
          if (table === "payments") paymentRecord = { ...(paymentRecord ?? {}), ...payload };
          return builder;
        },
        select: () => builder,
        eq: (key: string, value: unknown) => {
          state.filters[key] = value;
          return builder;
        },
        maybeSingle: async () => {
          if (table === "subscriptions") return { data: subscriptionRecord, error: null };
          if (table === "payments") return { data: paymentRecord, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (value: { error: null }) => void) => {
          resolve({ error: null });
        },
      };

      return builder;
    },
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
    updateCalls.length = 0;
    subscriptionRecord = {
      id: "sub-1",
      reference: "HPE-TEST",
      next_payment_date: null,
      processed_transaction_ids: [],
      wompi_payment_source_id: "src-1",
    };
    paymentRecord = null;
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

  it("schedules the next payment when an approved webhook activates an already processed transaction", async () => {
    subscriptionRecord = {
      id: "sub-1",
      reference: "HPE-TEST",
      next_payment_date: null,
      processed_transaction_ids: ["tx-1"],
      wompi_payment_source_id: "src-1",
    };
    paymentRecord = { id: "pay-1" };

    const payload = {
      event: "transaction.updated",
      data: {
        transaction: {
          id: "tx-1",
          status: "APPROVED",
          reference: "HPE-TEST",
          amount_in_cents: 150000,
          currency: "COP",
          payment_source_id: "src-1",
        },
      },
      signature: {
        properties: ["transaction.id", "transaction.status", "transaction.reference"],
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

    const subscriptionUpdate = updateCalls.find((call) => call.table === "subscriptions")?.payload;

    expect(response.status).toBe(200);
    expect(subscriptionUpdate).toMatchObject({
      status: "active",
      wompi_payment_source_id: "src-1",
      processed_transaction_ids: ["tx-1"],
    });
    expect(subscriptionUpdate?.next_payment_date).toEqual(expect.any(String));
  });
});
