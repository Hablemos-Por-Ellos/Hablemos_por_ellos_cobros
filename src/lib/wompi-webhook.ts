import crypto from "crypto";

export type WompiTransaction = {
  id: string;
  status?: string;
  amount_in_cents?: number;
  amountInCents?: number;
  currency?: string;
  reference?: string;
  payment_source_id?: string | number | null;
  paymentSourceId?: string | number | null;
  payment_method_type?: string;
  paymentMethodType?: string;
  payment_method?: { type?: string; extra?: Record<string, unknown> };
  paymentMethod?: { type?: string; extra?: Record<string, unknown> };
};

export type WompiEventPayload = {
  event?: string;
  data?: Record<string, unknown>;
  signature?: {
    properties?: string[];
    checksum?: string;
  };
  timestamp?: number | string;
};

function safeCompare(a: string, b: string | null | undefined) {
  if (!b) return false;
  const aBuf = new Uint8Array(Buffer.from(a.toLowerCase()));
  const bBuf = new Uint8Array(Buffer.from(b.toLowerCase()));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function getEventPropertyValue(data: Record<string, unknown> | undefined, path: string) {
  const value = path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);

  if (value === undefined || value === null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function computeWompiEventChecksum(payload: WompiEventPayload, eventsSecret: string) {
  const properties = payload.signature?.properties;
  const timestamp = payload.timestamp;

  if (!Array.isArray(properties) || properties.length === 0 || timestamp === undefined || timestamp === null) {
    return null;
  }

  const values: string[] = [];
  for (const property of properties) {
    const value = getEventPropertyValue(payload.data, property);
    if (value === null) return null;
    values.push(value);
  }

  return crypto.createHash("sha256").update(`${values.join("")}${timestamp}${eventsSecret}`).digest("hex");
}

export function isValidWompiEventChecksum(payload: WompiEventPayload, headerChecksum: string | null, eventsSecret: string) {
  const expected = computeWompiEventChecksum(payload, eventsSecret);
  const received = headerChecksum ?? payload.signature?.checksum ?? null;
  return expected ? safeCompare(expected, received) : false;
}

export function extractPaymentSourceId(tx: WompiTransaction) {
  const value =
    tx.payment_source_id ??
    tx.paymentSourceId ??
    (tx.payment_method ?? tx.paymentMethod)?.extra?.payment_source_id ??
    (tx.payment_method ?? tx.paymentMethod)?.extra?.token ??
    null;

  return value == null ? null : String(value);
}
