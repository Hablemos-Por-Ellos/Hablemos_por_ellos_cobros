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
  return key;
}

function requireWompiPublicKey() {
  const key = getWompiPublicKey();
  if (!key) {
    const suffix = WOMPI_ENV === "prod" ? "PROD" : "SANDBOX";
    throw new Error(`Configura NEXT_PUBLIC_WOMPI_PUBLIC_KEY_${suffix}.`);
  }
  return key;
}

function requireWompiIntegritySecret() {
  const secret = getWompiIntegritySecret();
  if (!secret) {
    const suffix = WOMPI_ENV === "prod" ? "PROD" : "SANDBOX";
    throw new Error(`Configura WOMPI_INTEGRITY_SECRET_${suffix} en el servidor.`);
  }
  return secret;
}

export function createWompiIntegritySignature(reference: string, amountInCents: number, currency: string) {
  const integritySecret = requireWompiIntegritySecret();
  return crypto.createHash("sha256").update(`${reference}${amountInCents}${currency}${integritySecret}`).digest("hex");
}

export async function getWompiAcceptance(): Promise<WompiAcceptance> {
  const publicKey = requireWompiPublicKey();
  const response = await fetch(`${getWompiApiBaseUrl()}/merchants/${encodeURIComponent(publicKey)}`, {
    cache: "no-store",
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
  };
}
