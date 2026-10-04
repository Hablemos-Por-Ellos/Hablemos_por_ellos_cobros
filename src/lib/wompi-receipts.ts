import crypto from "node:crypto";
import type { WompiEventPayload, WompiTransaction } from "@/lib/wompi-webhook";

export function makeWompiReceipt(payload: WompiEventPayload, checksum: string, body: string, receivedAt: Date) {
  const tx = payload.data?.transaction as WompiTransaction | undefined;
  return {
    receipt_version: 1,
    event: typeof payload.event === "string" ? payload.event.slice(0, 100) : null,
    environment: payload.environment ?? null,
    event_timestamp: payload.timestamp ?? null,
    transaction: tx ? {
      id: typeof tx.id === "string" ? tx.id.slice(0, 255) : null,
      status: tx.status ?? null,
      reference: tx.reference ?? null,
      amount_in_cents: tx.amount_in_cents ?? tx.amountInCents ?? null,
      currency: tx.currency ?? null,
      finalized_at: tx.finalized_at ?? tx.finalizedAt ?? null,
    } : null,
    checksum,
    body_sha256: crypto.createHash("sha256").update(body).digest("hex"),
    received_at: receivedAt.toISOString(),
  };
}
