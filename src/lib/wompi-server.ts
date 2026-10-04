import crypto from "crypto";
import {
  getWompiApiBaseUrl,
  getWompiIntegritySecret,
  getWompiPrivateKey,
  getWompiPublicKey,
  WOMPI_ENV,
} from "@/lib/wompi";

type WompiJson = Record<string, any>;
type SafeWompiValue = string | number | boolean | null | SafeWompiValue[] | { [key: string]: SafeWompiValue };

const WOMPI_READ_TIMEOUT_MS = 10_000;
const WOMPI_WRITE_TIMEOUT_MS = 20_000;

export type WompiAcceptance = {
  acceptanceToken: string;
  acceptPersonalAuth: string;
  acceptancePermalink: string | null;
  personalDataAuthPermalink: string | null;
};

export type WompiPaymentSource = {
  id: string;
  type: string;
  status: string;
  maskedDetails: string;
};

export type WompiTransactionResult = {
  id: string;
  status: string;
  reference?: string;
  amountInCents?: number;
  currency?: string;
  paymentSourceId?: string | null;
  paymentMethodType?: string | null;
  finalizedAt?: string | null;
};

function redactWompiText(value: string) {
  return value
    .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email_redacted]")
    .replace(/\b(?:pub|prv)_(?:prod|test)_[A-Za-z0-9_-]+\b/g, "[wompi_key_redacted]")
    .replace(/\b(?:prod|test)_integrity_[A-Za-z0-9_-]+\b/g, "[integrity_secret_redacted]")
    .replace(/\btok_(?:prod|test)_[A-Za-z0-9_-]+\b/g, "[card_token_redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt_redacted]")
    .slice(0, 500);
}

function safeWompiValue(value: unknown, depth = 0): SafeWompiValue | undefined {
  if (value == null) return null;
  if (typeof value === "string") return redactWompiText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[nested_redacted]";

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => safeWompiValue(item, depth + 1) ?? null);
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, SafeWompiValue>>((acc, [key, item]) => {
      const safeValue = safeWompiValue(item, depth + 1);
      if (safeValue !== undefined) acc[key] = safeValue;
      return acc;
    }, {});
  }

  return redactWompiText(String(value));
}

function safeWompiJson(value: unknown) {
  const safeValue = safeWompiValue(value);
  if (safeValue == null) return "";

  try {
    return JSON.stringify(safeValue).slice(0, 1200);
  } catch {
    return "";
  }
}

function wompiErrorHint(json: WompiJson, status?: number) {
  const err = json?.error ?? json;
  const detail = safeWompiJson(err?.messages ?? err?.errors ?? err?.details ?? err?.data);
  const traceId = typeof json?.meta?.trace_id === "string" ? json.meta.trace_id : "";
  const parts = [
    typeof status === "number" ? `HTTP_${status}` : "",
    typeof err?.type === "string" ? err.type : "",
    typeof err?.reason === "string" ? err.reason : "",
    typeof err?.message === "string" ? err.message : "",
    Array.isArray(err?.messages) ? err.messages.filter((m: unknown) => typeof m === "string").join("|") : "",
    detail ? `details=${detail}` : "",
    traceId ? `trace_id=${traceId}` : "",
  ].filter(Boolean);

  return parts.length ? ` ${parts.join(": ")}` : "";
}

function requireWompiPrivateKey() {
  const key = getWompiPrivateKey();
  if (!key) {
    const suffix = WOMPI_ENV === "prod" ? "PROD" : "SANDBOX";
    throw new Error(`Configura WOMPI_PRIVATE_KEY_${suffix} en el servidor.`);
  }
  const expectedPrefix = WOMPI_ENV === "prod" ? "prv_prod_" : "prv_test_";
  if (!key.startsWith(expectedPrefix)) throw new Error("WOMPI_PRIVATE_KEY_ENV_MISMATCH");
  return key;
}

function requireWompiPublicKey() {
  const key = getWompiPublicKey();
  if (!key) {
    const suffix = WOMPI_ENV === "prod" ? "PROD" : "SANDBOX";
    throw new Error(`Configura NEXT_PUBLIC_WOMPI_PUBLIC_KEY_${suffix}.`);
  }
  const expectedPrefix = WOMPI_ENV === "prod" ? "pub_prod_" : "pub_test_";
  if (!key.startsWith(expectedPrefix)) throw new Error("WOMPI_PUBLIC_KEY_ENV_MISMATCH");
  return key;
}

function requireWompiIntegritySecret() {
  const secret = getWompiIntegritySecret();
  if (!secret) {
    const suffix = WOMPI_ENV === "prod" ? "PROD" : "SANDBOX";
    throw new Error(`Configura WOMPI_INTEGRITY_SECRET_${suffix} en el servidor.`);
  }
  const expectedPrefix = WOMPI_ENV === "prod" ? "prod_integrity_" : "test_integrity_";
  if (!secret.startsWith(expectedPrefix)) throw new Error("WOMPI_INTEGRITY_SECRET_ENV_MISMATCH");
  return secret;
}

export function createWompiIntegritySignature(reference: string, amountInCents: number, currency: string) {
  const integritySecret = requireWompiIntegritySecret();
  return crypto.createHash("sha256").update(`${reference}${amountInCents}${currency}${integritySecret}`).digest("hex");
}

export async function getWompiAcceptance(): Promise<WompiAcceptance> {
  const publicKey = requireWompiPublicKey();
  const response = await fetch(`${getWompiApiBaseUrl()}/merchants/info`, {
    headers: { "x-merchant-public-key": publicKey },
    cache: "no-store",
    signal: AbortSignal.timeout(WOMPI_READ_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as WompiJson;

  const acceptance = json?.data?.presigned_acceptance;
  const personal = json?.data?.presigned_personal_data_auth;
  const acceptanceToken = acceptance?.acceptance_token;
  const acceptPersonalAuth = personal?.acceptance_token;

  if (!response.ok || !acceptanceToken || !acceptPersonalAuth) {
    throw new Error(`No se pudieron obtener los tokens de aceptacion de Wompi.${wompiErrorHint(json, response.status)}`);
  }

  return {
    acceptanceToken,
    acceptPersonalAuth,
    acceptancePermalink: acceptance?.permalink ?? null,
    personalDataAuthPermalink: personal?.permalink ?? null,
  };
}

export async function createWompiPaymentSource(params: {
  token: string;
  type: string;
  customerEmail: string;
  acceptanceToken: string;
  acceptPersonalAuth: string;
}): Promise<WompiPaymentSource> {
  const response = await fetch(`${getWompiApiBaseUrl()}/payment_sources`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireWompiPrivateKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: params.type,
      token: params.token,
      customer_email: params.customerEmail,
      acceptance_token: params.acceptanceToken,
      accept_personal_auth: params.acceptPersonalAuth,
    }),
    signal: AbortSignal.timeout(WOMPI_WRITE_TIMEOUT_MS),
  });

  const json = (await response.json().catch(() => ({}))) as WompiJson;
  const data = json?.data;
  const id = data?.id;

  if (!response.ok || id == null) {
    throw new Error(`No se pudo crear la fuente de pago en Wompi.${wompiErrorHint(json, response.status)}`);
  }

  const type = String(data?.type ?? params.type);
  const publicData = data?.public_data ?? {};
  const lastFour = publicData?.last_four ?? publicData?.lastFour ?? publicData?.card_last_four ?? null;
  const brand = publicData?.brand ?? type;

  return {
    id: String(id),
    type,
    status: String(data?.status ?? "AVAILABLE"),
    maskedDetails: lastFour ? `${brand} **** ${lastFour}` : type === "CARD" ? "Tarjeta tokenizada" : type,
  };
}

export async function createWompiTransaction(params: {
  reference: string;
  amountInCents: number;
  currency: string;
  customerEmail: string;
  paymentSourceId: string;
  acceptanceToken: string;
  acceptPersonalAuth: string;
  recurrent?: boolean;
}): Promise<WompiTransactionResult> {
  const response = await fetch(`${getWompiApiBaseUrl()}/transactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireWompiPrivateKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      acceptance_token: params.acceptanceToken,
      accept_personal_auth: params.acceptPersonalAuth,
      amount_in_cents: params.amountInCents,
      currency: params.currency,
      signature: createWompiIntegritySignature(params.reference, params.amountInCents, params.currency),
      customer_email: params.customerEmail,
      payment_source_id: params.paymentSourceId,
      reference: params.reference,
      recurrent: params.recurrent ?? true,
      payment_method: {
        installments: 1,
      },
    }),
    signal: AbortSignal.timeout(WOMPI_WRITE_TIMEOUT_MS),
  });

  const json = (await response.json().catch(() => ({}))) as WompiJson;
  const data = json?.data;
  const id = data?.id;

  if (!response.ok || !id) {
    throw new Error(`No se pudo crear la transaccion en Wompi.${wompiErrorHint(json, response.status)}`);
  }

  return {
    id: String(id),
    status: String(data?.status ?? "PENDING").toLowerCase(),
    reference: typeof data?.reference === "string" ? data.reference : params.reference,
    amountInCents: typeof data?.amount_in_cents === "number" ? data.amount_in_cents : params.amountInCents,
    currency: typeof data?.currency === "string" ? data.currency : params.currency,
    paymentSourceId: data?.payment_source_id == null ? params.paymentSourceId : String(data.payment_source_id),
    paymentMethodType: typeof data?.payment_method_type === "string"
      ? data.payment_method_type
      : typeof data?.payment_method?.type === "string"
        ? data.payment_method.type
        : null,
    finalizedAt: typeof data?.finalized_at === "string" ? data.finalized_at : null,
  };
}

export async function getWompiTransaction(transactionId: string): Promise<WompiTransactionResult> {
  const response = await fetch(`${getWompiApiBaseUrl()}/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { Authorization: `Bearer ${requireWompiPrivateKey()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(WOMPI_READ_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as WompiJson;
  const data = json?.data;
  if (!response.ok || !data?.id) {
    throw new Error(`No se pudo verificar la transaccion en Wompi.${wompiErrorHint(json, response.status)}`);
  }

  return {
    id: String(data.id),
    status: String(data.status ?? "PENDING").toLowerCase(),
    reference: typeof data.reference === "string" ? data.reference : undefined,
    amountInCents: typeof data.amount_in_cents === "number" ? data.amount_in_cents : undefined,
    currency: typeof data.currency === "string" ? data.currency : undefined,
    paymentSourceId: data.payment_source_id == null ? null : String(data.payment_source_id),
    paymentMethodType: typeof data.payment_method_type === "string"
      ? data.payment_method_type
      : typeof data.payment_method?.type === "string"
        ? data.payment_method.type
        : null,
    finalizedAt: typeof data.finalized_at === "string" ? data.finalized_at : null,
  };
}

export async function isWompiPaymentSourceAvailable(paymentSourceId: string) {
  const response = await fetch(`${getWompiApiBaseUrl()}/payment_sources/${encodeURIComponent(paymentSourceId)}`, {
    headers: { Authorization: `Bearer ${requireWompiPrivateKey()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(WOMPI_READ_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as WompiJson;
  if (!response.ok || !json?.data?.id) {
    throw new Error(`No se pudo verificar la fuente de pago en Wompi.${wompiErrorHint(json, response.status)}`);
  }
  return String(json.data.id) === paymentSourceId
    && String(json.data.type ?? "").toUpperCase() === "CARD"
    && String(json.data.status ?? "").toUpperCase() === "AVAILABLE";
}
