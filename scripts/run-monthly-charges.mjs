import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { runMonthlyCharges } from "./monthly-charge-runner.mjs";
import { reconcileWompiReceipts } from "./wompi-receipt-runner.mjs";
import { assertBillingJobRuntime, getBillingWompiEnvironment,
  parseBillingJobMode, logBillingJobError } from "./billing-job-mode.mjs";

const WOMPI_READ_TIMEOUT_MS = 10_000;
const WOMPI_WRITE_TIMEOUT_MS = 20_000;

function required(name, env) {
  const value = env[name];
  if (!value) throw new Error("BILLING_JOB_CONFIGURATION_INVALID");
  return value;
}

function pickEnv(env, ...names) {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return "";
}

function wompiBaseUrl(env) {
  return env === "prod" ? "https://production.wompi.co/v1" : "https://sandbox.wompi.co/v1";
}

async function getAcceptanceToken({ baseUrl, publicKey, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/merchants/info`, {
    headers: { "x-merchant-public-key": publicKey },
    signal: AbortSignal.timeout(WOMPI_READ_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => ({}));

  const acceptanceToken = json?.data?.presigned_acceptance?.acceptance_token ?? null;
  const acceptPersonalAuth = json?.data?.presigned_personal_data_auth?.acceptance_token ?? null;

  if (!response.ok || !acceptanceToken || !acceptPersonalAuth) {
    throw new Error("PRE_DISPATCH_FAILURE");
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
  fetchImpl,
  onSending,
}) {
  const options = {
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
    signal: AbortSignal.timeout(WOMPI_WRITE_TIMEOUT_MS),
  };
  onSending?.();
  const response = await fetchImpl(`${baseUrl}/transactions`, options);

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("POST_DISPATCH_UNKNOWN");
  }

  const id = json?.data?.id ?? null;
  const status = String(json?.data?.status ?? "pending").toLowerCase();
  if (!id) {
    throw new Error("POST_DISPATCH_UNKNOWN");
  }

  return { id, status };
}

async function getWompiTransaction({ baseUrl, privateKey, transactionId, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { Authorization: `Bearer ${privateKey}` },
    signal: AbortSignal.timeout(WOMPI_READ_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => ({}));
  const data = json?.data;
  if (!response.ok || !data?.id) {
    throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
  }
  return {
    id: String(data.id),
    status: String(data.status ?? "pending").toLowerCase(),
    reference: data.reference,
    amountInCents: data.amount_in_cents,
    currency: data.currency,
    paymentSourceId: data.payment_source_id == null ? null : String(data.payment_source_id),
    finalizedAt: typeof data.finalized_at === "string" ? data.finalized_at : null,
    createdAt: typeof data.created_at === "string" ? data.created_at : null,
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
  };
}

export async function main({ argv = process.argv.slice(2), env = process.env,
  clientFactory = createClient, fetchImpl = globalThis.fetch, logger = console,
  runner = runMonthlyCharges, reconcileReceipts = reconcileWompiReceipts, now = new Date() } = {}) {
  const mode = parseBillingJobMode(argv);
  assertBillingJobRuntime(mode, env);
  const url = required("SUPABASE_URL", env);
  const key = required("SUPABASE_SERVICE_ROLE_KEY", env);
  let getTransaction;
  let createTransaction;
  if (mode !== "inventory") {
    const wompiEnv = getBillingWompiEnvironment(env);
    const baseUrl = wompiBaseUrl(wompiEnv);
    const privateKey = wompiEnv === "prod"
      ? pickEnv(env, "WOMPI_PRIVATE_KEY_PROD", "WOMPI_PRIVATE_KEY")
      : pickEnv(env, "WOMPI_PRIVATE_KEY_SANDBOX", "WOMPI_PRIVATE_KEY");
    if (!privateKey.startsWith(wompiEnv === "prod" ? "prv_prod_" : "prv_test_")) {
      throw new Error("BILLING_JOB_CONFIGURATION_INVALID");
    }
    getTransaction = ({ transactionId }) => {
      assertBillingJobRuntime("reconcile", env);
      return getWompiTransaction({ baseUrl, privateKey, transactionId, fetchImpl });
    };
    if (mode === "charge") {
      const publicKey = wompiEnv === "prod"
        ? pickEnv(env, "NEXT_PUBLIC_WOMPI_PUBLIC_KEY_PROD", "NEXT_PUBLIC_WOMPI_PUBLIC_KEY")
        : pickEnv(env, "NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX", "NEXT_PUBLIC_WOMPI_PUBLIC_KEY");
      const integritySecret = wompiEnv === "prod"
        ? pickEnv(env, "WOMPI_INTEGRITY_SECRET_PROD", "WOMPI_INTEGRITY_SECRET")
        : pickEnv(env, "WOMPI_INTEGRITY_SECRET_SANDBOX", "WOMPI_INTEGRITY_SECRET");
      if (!publicKey.startsWith(wompiEnv === "prod" ? "pub_prod_" : "pub_test_")
        || !integritySecret.startsWith(wompiEnv === "prod" ? "prod_integrity_" : "test_integrity_")) {
        throw new Error("BILLING_JOB_CONFIGURATION_INVALID");
      }
      createTransaction = async (params) => {
        assertBillingJobRuntime(mode, env);
        let acceptance;
        try {
          acceptance = await getAcceptanceToken({ baseUrl, publicKey, fetchImpl });
        } catch {
          const error = new Error("PRE_DISPATCH_FAILURE");
          error.safeToRetry = true;
          throw error;
        }
        assertBillingJobRuntime(mode, env);
        const created = await createWompiTransaction({
          ...params, ...acceptance, baseUrl, privateKey, integritySecret, fetchImpl,
        });
        try {
          await params.onDispatched?.({ id: String(created.id), status: created.status });
          const verified = await getTransaction({ transactionId: created.id });
          if (verified.id !== String(created.id) || verified.reference !== params.reference
            || Number(verified.amountInCents) !== params.amountInCents || verified.currency !== params.currency
            || String(verified.paymentSourceId ?? "") !== String(params.paymentSourceId)) {
            throw new Error("POST_DISPATCH_UNKNOWN");
          }
          return verified;
        } catch {
          const error = new Error("POST_DISPATCH_UNKNOWN");
          error.transactionId = String(created.id);
          throw error;
        }
      };
    }
  }
  // Every mode, URL and production guard has passed before the client can be created.
  const supabase = clientFactory(url, key, { auth: { persistSession: false } });
  let receipts = { received: 0, processed: 0, review: 0, failed: 0 };
  if (mode !== "inventory") {
    try {
      const { data, error } = await supabase.rpc("payment_admin_schema_ready");
      if (error || data !== true) throw new Error("BILLING_JOB_SCHEMA_NOT_READY");
    } catch { throw new Error("BILLING_JOB_SCHEMA_NOT_READY"); }
    // Node jobs recheck app/network policy after awaits, not only at startup.
    assertBillingJobRuntime("reconcile", env);
    try {
      const result = await reconcileReceipts({ supabase, getTransaction, logger });
      const fields = Object.keys(receipts);
      if (!result || !fields.every((field) => Number.isSafeInteger(result[field]) && result[field] >= 0)
        || result.received !== result.processed + result.review + result.failed) {
        throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
      }
      receipts = Object.fromEntries(fields.map((field) => [field, result[field]]));
    } catch {
      receipts.failed = 1;
      logger.error("Monthly billing receipts failed code=BILLING_JOB_OPERATIONAL_FAILURE");
    }
  }
  const chargesBlockedByReceipts = receipts.failed > 0 || receipts.review > 0;
  const runnerMode = mode === "charge" && chargesBlockedByReceipts ? "reconcile" : mode;
  assertBillingJobRuntime(runnerMode, env);
  const runnerStats = await runner({ mode: runnerMode, env, now, supabase, getTransaction,
    createTransaction: runnerMode === "charge" ? createTransaction : undefined, logger });
  const stats = { ...runnerStats, mode, runnerMode, receipts, chargesBlockedByReceipts,
    blocked: (Number.isFinite(runnerStats.blocked) ? runnerStats.blocked : 0) + receipts.failed + receipts.review };
  const summary = { mode, runnerMode, receipts, chargesBlockedByReceipts };
  for (const field of ["due", "outstanding", "payments", "charged", "skippedPending", "reconciled",
    "blocked", "noIds", "schemaUnknown", "failed", "duplicateCheckFailures", "auditFailures"]) {
    summary[field] = Number.isFinite(stats[field]) ? stats[field] : 0;
  }
  if (mode === "inventory") {
    summary.inventoryStatus = summary.failed > 0 || summary.duplicateCheckFailures > 0 || summary.auditFailures > 0
      ? "operational_failure" : summary.schemaUnknown > 0 ? "legacy_incomplete" : "read_only_observation";
  }
  logger.log("Monthly billing complete " + JSON.stringify(summary));
  if (chargesBlockedByReceipts || summary.failed > 0 || summary.duplicateCheckFailures > 0 || summary.auditFailures > 0) {
    throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
  }
  return stats;
}

const isDirectExecution = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main().catch((error) => {
    logBillingJobError(console, error);
    process.exitCode = 1;
  });
}
