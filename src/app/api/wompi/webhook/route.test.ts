import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeWompiEventChecksum } from "@/lib/wompi-webhook";

const rpc = vi.fn();
const maybeSingleAttempt = vi.fn();
const receiptInsert = vi.fn();
const from = vi.fn(() => {
  const query = {
    select: () => query,
    insert: receiptInsert,
    eq: () => query,
    maybeSingle: maybeSingleAttempt,
  };
  return query;
});

vi.mock("@/lib/supabase-server", () => ({
  getServiceSupabaseClient: () => ({ rpc, from }),
}));

vi.mock("@/lib/wompi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/wompi")>("@/lib/wompi");
  return { ...actual, WOMPI_ENV: "prod", getWompiEventsSecret: () => "prod_events_test" };
});

vi.mock("@/lib/wompi-server", () => ({
  getWompiTransaction: vi.fn(),
}));
vi.mock("@/lib/payment-schema", () => ({ paymentSchemaReady: vi.fn(async () => true) }));

import { POST } from "./route";
import { getWompiTransaction } from "@/lib/wompi-server";
import { paymentSchemaReady } from "@/lib/payment-schema";

function payload() {
  const value = {
    environment: "prod",
    event: "transaction.updated",
    data: {
      transaction: {
        id: "tx-1",
        status: "APPROVED",
        reference: "HPE-SERVER",
        amount_in_cents: 1000000,
        currency: "COP",
      },
    },
    signature: {
      properties: ["transaction.id", "transaction.status", "transaction.reference"],
      checksum: "",
    },
    timestamp: 1785591344,
  };
  value.signature.checksum = computeWompiEventChecksum(value, "prod_events_test") ?? "";
  return value;
}

describe("POST /api/wompi/webhook", () => {
  beforeEach(() => {
    vi.stubEnv("APP_OPERATION_MODE", "active");
    receiptInsert.mockReset().mockResolvedValue({ error: null });
    vi.mocked(paymentSchemaReady).mockReset().mockResolvedValue(true);
    rpc.mockReset().mockResolvedValue({ data: { result: "processed" }, error: null });
    from.mockClear();
    maybeSingleAttempt.mockReset().mockResolvedValue({ data: null, error: null });
    vi.mocked(getWompiTransaction).mockReset().mockResolvedValue({
      id: "tx-1",
      status: "approved",
      reference: "HPE-SERVER",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: "src-1",
      finalizedAt: "2026-08-01T13:35:44.000Z",
    });
  });

  it("stores a compatible receipt in cutover without applying financial changes", async () => {
    vi.stubEnv("APP_OPERATION_MODE", "cutover");
    const response = await POST(new Request("https://example.test/api/wompi/webhook", { method: "POST", body: JSON.stringify(payload()) }));
    expect(response.status).toBe(200);
    expect(receiptInsert).toHaveBeenCalledWith(expect.objectContaining({ transaction_id: null, event_type: null,
      raw: expect.objectContaining({ receipt_version: 1 }) }));
    expect(getWompiTransaction).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never acknowledges a receipt that was not saved", async () => {
    receiptInsert.mockResolvedValue({ error: { code: "DATABASE_UNAVAILABLE" } });
    const response = await POST(new Request("https://example.test/api/wompi/webhook", { method: "POST", body: JSON.stringify(payload()) }));
    expect(response.status).toBe(503);
    expect(getWompiTransaction).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("queues receipts without calling new-schema RPCs before migration", async () => {
    vi.mocked(paymentSchemaReady).mockResolvedValue(false);
    const response = await POST(new Request("https://example.test/api/wompi/webhook", { method: "POST", body: JSON.stringify(payload()) }));
    expect(response.status).toBe(200);
    expect(getWompiTransaction).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects events from a different environment", async () => {
    const event = { ...payload(), environment: "test" };
    const response = await POST(new Request("https://example.test/api/wompi/webhook", { method: "POST", body: JSON.stringify(event) }));
    expect(response.status).toBe(401);
    expect(receiptInsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid checksum before querying Wompi", async () => {
    const response = await POST(new Request("https://example.test/api/wompi/webhook", {
      method: "POST",
      headers: { "x-event-checksum": "invalid" },
      body: JSON.stringify(payload()),
    }));

    expect(response.status).toBe(401);
    expect(getWompiTransaction).not.toHaveBeenCalled();
  });

  it("verifies the transaction with Wompi and applies it through the atomic RPC", async () => {
    const event = payload();
    const response = await POST(new Request("https://example.test/api/wompi/webhook", {
      method: "POST",
      headers: { "x-event-checksum": event.signature.checksum },
      body: JSON.stringify(event),
    }));

    expect(response.status).toBe(200);
    expect(getWompiTransaction).toHaveBeenCalledWith("tx-1");
    expect(rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_transaction_id: "tx-1",
      p_reference: "HPE-SERVER",
      p_amount: 10000,
      p_status: "approved",
    }));
  });

  it("reconciles a declined current transaction before applying an approved retry", async () => {
    const event = payload();
    event.data.transaction.id = "tx-retry-approved";
    event.data.transaction.status = "APPROVED";
    event.signature.checksum = computeWompiEventChecksum(event, "prod_events_test") ?? "";
    maybeSingleAttempt.mockResolvedValue({
      data: { id: "attempt-1", wompi_transaction_id: "tx-first-pending", state: "pending" },
      error: null,
    });
    vi.mocked(getWompiTransaction)
      .mockResolvedValueOnce({
        id: "tx-retry-approved",
        status: "approved",
        reference: "HPE-SERVER",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
        finalizedAt: "2026-08-01T13:36:44.000Z",
      })
      .mockResolvedValueOnce({
        id: "tx-first-pending",
        status: "declined",
        reference: "HPE-SERVER",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
        finalizedAt: "2026-08-01T13:35:44.000Z",
      });

    const response = await POST(new Request("https://example.test/api/wompi/webhook", {
      method: "POST",
      headers: { "x-event-checksum": event.signature.checksum },
      body: JSON.stringify(event),
    }));

    expect(response.status).toBe(200);
    expect(getWompiTransaction).toHaveBeenNthCalledWith(1, "tx-retry-approved");
    expect(getWompiTransaction).toHaveBeenNthCalledWith(2, "tx-first-pending");
    expect(rpc.mock.calls.map((call) => call[1].p_transaction_id)).toEqual([
      "tx-first-pending",
      "tx-retry-approved",
    ]);
  });

  it("does not replace a current Wompi transaction that is still pending", async () => {
    const event = payload();
    event.data.transaction.id = "tx-retry-approved";
    event.signature.checksum = computeWompiEventChecksum(event, "prod_events_test") ?? "";
    maybeSingleAttempt.mockResolvedValue({
      data: { id: "attempt-1", wompi_transaction_id: "tx-first-pending", state: "pending" },
      error: null,
    });
    vi.mocked(getWompiTransaction)
      .mockResolvedValueOnce({
        id: "tx-retry-approved",
        status: "approved",
        reference: "HPE-SERVER",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
      })
      .mockResolvedValueOnce({
        id: "tx-first-pending",
        status: "pending",
        reference: "HPE-SERVER",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
      });

    const response = await POST(new Request("https://example.test/api/wompi/webhook", {
      method: "POST",
      headers: { "x-event-checksum": event.signature.checksum },
      body: JSON.stringify(event),
    }));

    expect(response.status).toBe(500);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("apply_verified_wompi_event", expect.objectContaining({
      p_transaction_id: "tx-first-pending",
      p_status: "pending",
    }));
  });

  it("stores a late declined transaction as history after the retry was approved", async () => {
    const event = payload();
    event.data.transaction.id = "tx-old-declined";
    event.data.transaction.status = "DECLINED";
    event.signature.checksum = computeWompiEventChecksum(event, "prod_events_test") ?? "";
    maybeSingleAttempt.mockResolvedValue({
      data: { id: "attempt-1", wompi_transaction_id: "tx-retry-approved", state: "approved" },
      error: null,
    });
    vi.mocked(getWompiTransaction)
      .mockResolvedValueOnce({
        id: "tx-old-declined",
        status: "declined",
        reference: "HPE-SERVER",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
        finalizedAt: "2026-08-01T13:35:44.000Z",
      })
      .mockResolvedValueOnce({
        id: "tx-retry-approved",
        status: "approved",
        reference: "HPE-SERVER",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
        finalizedAt: "2026-08-01T13:36:44.000Z",
      });

    const response = await POST(new Request("https://example.test/api/wompi/webhook", {
      method: "POST",
      headers: { "x-event-checksum": event.signature.checksum },
      body: JSON.stringify(event),
    }));

    expect(response.status).toBe(200);
    expect(rpc.mock.calls.map((call) => call[1].p_transaction_id)).toEqual([
      "tx-retry-approved",
      "tx-old-declined",
    ]);
  });

  it("rejects a Wompi amount that is not an exact number of COP pesos", async () => {
    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-1",
      status: "approved",
      reference: "HPE-SERVER",
      amountInCents: 1000001,
      currency: "COP",
      paymentSourceId: "src-1",
      finalizedAt: "2026-08-01T13:35:44.000Z",
    });
    const event = payload();
    const response = await POST(new Request("https://example.test/api/wompi/webhook", {
      method: "POST",
      headers: { "x-event-checksum": event.signature.checksum },
      body: JSON.stringify(event),
    }));

    expect(response.status).toBe(502);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts an already processed replay without applying a second schedule change", async () => {
    rpc.mockResolvedValue({ data: { result: "duplicate" }, error: null });
    const event = payload();
    const response = await POST(new Request("https://example.test/api/wompi/webhook", {
      method: "POST",
      headers: { "x-event-checksum": event.signature.checksum },
      body: JSON.stringify(event),
    }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.result).toBe("duplicate");
  });

  it("rejects a null RPC result so Wompi can retry the event", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const event = payload();
    const response = await POST(new Request("https://example.test/api/wompi/webhook", {
      method: "POST",
      headers: { "x-event-checksum": event.signature.checksum },
      body: JSON.stringify(event),
    }));

    expect(response.status).toBe(500);
  });

  it("rejects an unlinked event so it can be reconciled on a later retry", async () => {
    rpc.mockResolvedValue({ data: { result: "unlinked" }, error: null });
    const event = payload();
    const response = await POST(new Request("https://example.test/api/wompi/webhook", {
      method: "POST",
      headers: { "x-event-checksum": event.signature.checksum },
      body: JSON.stringify(event),
    }));

    expect(response.status).toBe(500);
  });
});
