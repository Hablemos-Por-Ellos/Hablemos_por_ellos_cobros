import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { runMonthlyCharges } from "./monthly-charge-runner.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function pickEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

function getWompiEnv() {
  const env = (process.env.WOMPI_ENV || process.env.NEXT_PUBLIC_WOMPI_ENV || "").toLowerCase();
  if (env === "prod" || env === "production") return "prod";
  if (env === "sandbox" || env === "test") return "sandbox";

  if (process.env.WOMPI_PRIVATE_KEY_PROD) return "prod";
  if (process.env.WOMPI_PRIVATE_KEY_SANDBOX) return "sandbox";

  return "prod";
}

function wompiBaseUrl(env) {
  return env === "prod" ? "https://production.wompi.co/v1" : "https://sandbox.wompi.co/v1";
}

function wompiErrorHint(json) {
  const error = json?.error ?? null;
  if (!error || typeof error !== "object") return "";

  const type = typeof error.type === "string" ? error.type : "";
  const reason = typeof error.reason === "string" ? error.reason : "";
  const messages = Array.isArray(error.messages) ? error.messages.filter((message) => typeof message === "string") : [];

  const hintParts = [type, reason, messages.join("|")].filter(Boolean);
  return hintParts.length ? ` hint=${hintParts.join(":")}` : "";
}

async function getAcceptanceToken({ baseUrl, publicKey }) {
  const response = await fetch(`${baseUrl}/merchants/${encodeURIComponent(publicKey)}`);
  const json = await response.json().catch(() => ({}));

  const acceptanceToken = json?.data?.presigned_acceptance?.acceptance_token ?? null;
  const acceptPersonalAuth = json?.data?.presigned_personal_data_auth?.acceptance_token ?? null;

  if (!response.ok || !acceptanceToken || !acceptPersonalAuth) {
    throw new Error(`Could not get acceptance tokens from Wompi. status=${response.status}${wompiErrorHint(json)}`);
  }

  return { acceptanceToken, acceptPersonalAuth };
}

function createIntegritySignature({ reference, amountInCents, currency, integritySecret }) {
  return crypto
    .createHash("sha256")
    .update(`${reference}${amountInCents}${currency}${integritySecret}`)
    .digest("hex");
}

async function createWompiTransaction({
  baseUrl,
  privateKey,
  acceptanceToken,
  acceptPersonalAuth,
  integritySecret,
  reference,
  amountInCents,
  currency,
  customerEmail,
  paymentSourceId,
}) {
  const response = await fetch(`${baseUrl}/transactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${privateKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      acceptance_token: acceptanceToken,
      accept_personal_auth: acceptPersonalAuth,
      amount_in_cents: amountInCents,
      currency,
      signature: createIntegritySignature({ reference, amountInCents, currency, integritySecret }),
      customer_email: customerEmail,
      payment_source_id: paymentSourceId,
      reference,
      recurrent: true,
      payment_method: { installments: 1 },
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Wompi transaction failed. status=${response.status}${wompiErrorHint(json)}`);
  }

  const id = json?.data?.id ?? null;
  const status = String(json?.data?.status ?? "pending").toLowerCase();
  if (!id) {
    throw new Error(`Wompi response missing data.id. status=${status}${wompiErrorHint(json)}`);
  }

  return { id, status };
}

async function main() {
  const env = getWompiEnv();
  const SUPABASE_URL = required("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");

  const wompiPrivateKey =
    env === "prod"
      ? pickEnv("WOMPI_PRIVATE_KEY_PROD", "WOMPI_PRIVATE_KEY")
      : pickEnv("WOMPI_PRIVATE_KEY_SANDBOX", "WOMPI_PRIVATE_KEY");
  const wompiPublicKey =
    env === "prod"
      ? pickEnv("NEXT_PUBLIC_WOMPI_PUBLIC_KEY_PROD", "NEXT_PUBLIC_WOMPI_PUBLIC_KEY")
      : pickEnv("NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX", "NEXT_PUBLIC_WOMPI_PUBLIC_KEY");
  const wompiIntegritySecret =
    env === "prod"
      ? pickEnv("WOMPI_INTEGRITY_SECRET_PROD", "WOMPI_INTEGRITY_SECRET")
      : pickEnv("WOMPI_INTEGRITY_SECRET_SANDBOX", "WOMPI_INTEGRITY_SECRET");

  if (!wompiPrivateKey) throw new Error("Missing Wompi private key env (WOMPI_PRIVATE_KEY_* or WOMPI_PRIVATE_KEY).");
  if (!wompiPublicKey) throw new Error("Missing Wompi public key env (NEXT_PUBLIC_WOMPI_PUBLIC_KEY_* or NEXT_PUBLIC_WOMPI_PUBLIC_KEY).");
  if (!wompiIntegritySecret) throw new Error("Missing Wompi integrity secret env (WOMPI_INTEGRITY_SECRET_* or WOMPI_INTEGRITY_SECRET).");

  const baseUrl = wompiBaseUrl(env);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const stats = await runMonthlyCharges({
    supabase,
    createTransaction: async (params) => {
      const { acceptanceToken, acceptPersonalAuth } = await getAcceptanceToken({ baseUrl, publicKey: wompiPublicKey });
      return createWompiTransaction({
        ...params,
        baseUrl,
        privateKey: wompiPrivateKey,
        acceptanceToken,
        acceptPersonalAuth,
        integritySecret: wompiIntegritySecret,
      });
    },
  });

  console.log(`Monthly charges complete ${JSON.stringify(stats)}`);
}

const isDirectExecution = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
