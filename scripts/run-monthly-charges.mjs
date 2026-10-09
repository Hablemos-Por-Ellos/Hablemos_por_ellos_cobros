import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { runMonthlyCharges } from "./monthly-charge-runner.mjs";
import { runMonthlyRetryCharges } from "./monthly-retry-runner.mjs";
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

function transactionRequest({
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
  return {
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
  };
}

async function sendTransactionRequest({ baseUrl, options, fetchImpl, onSending }) {
  onSending?.();
  const response = await fetchImpl(`${baseUrl}/transactions`, {
    ...options, signal: AbortSignal.timeout(WOMPI_WRITE_TIMEOUT_MS),
  });

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

async function createWompiTransaction(params) {
  return sendTransactionRequest({ ...params, options: transactionRequest(params) });
}

async function getWompiTransaction({ baseUrl, privateKey, transactionId, fetchImpl, environment }) {
  const response = await fetchImpl(`${baseUrl}/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { Authorization: `Bearer ${privateKey}` },
    signal: AbortSignal.timeout(WOMPI_READ_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => ({}));
  const data = json?.data;
  if (!response.ok || !data?.id || String(data.id) !== String(transactionId)) {
    throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
  }
  return {
    id: String(data.id),
    status: String(data.status ?? "pending").toLowerCase(),
    statusMessage: typeof data.status_message === "string" ? data.status_message : null,
    reference: data.reference,
    amountInCents: data.amount_in_cents,
    currency: data.currency,
    paymentSourceId: data.payment_source_id == null ? null : String(data.payment_source_id),
    paymentMethodType: typeof data.payment_method_type === "string" ? data.payment_method_type
      : typeof data.payment_method?.type === "string" ? data.payment_method.type : null,
    finalizedAt: typeof data.finalized_at === "string" ? data.finalized_at : null,
    createdAt: typeof data.created_at === "string" ? data.created_at : null,
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
    environment,
    verificationSource: "provider_get",
  };
}

async function getWompiPaymentSource({ baseUrl, privateKey, paymentSourceId, fetchImpl, environment, clock }) {
  const response = await fetchImpl(`${baseUrl}/payment_sources/${encodeURIComponent(paymentSourceId)}`, {
    headers: { Authorization: `Bearer ${privateKey}` }, signal: AbortSignal.timeout(WOMPI_READ_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => ({}));
  const data = json?.data;
  if (!response.ok || data?.id == null || String(data.id) !== String(paymentSourceId)) {
    throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
  }
  return { id: String(data.id), type: data.type, status: data.status,
    environment, verificationSource: "provider_get", verifiedAt: clock().toISOString() };
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new Error("BILLING_JOB_MODE_REQUIRED");
  const schemas = argv.filter((value) => typeof value === "string" && value.startsWith("--schema="));
  if (schemas.length > 1) throw new Error("BILLING_JOB_CONFIGURATION_INVALID");
  const mode = parseBillingJobMode(argv.filter((value) => !schemas.includes(value)));
  const schema = schemas[0]?.slice("--schema=".length) ?? "v040";
  if (!["v031", "v040"].includes(schema) || (mode !== "inventory" && schema !== "v040")) {
    throw new Error("BILLING_JOB_CONFIGURATION_INVALID");
  }
  return { mode, schema, explicitSchema: schemas.length === 1 };
}

export async function main({ argv = process.argv.slice(2), env = process.env,
  clientFactory = createClient, fetchImpl = globalThis.fetch, logger = console,
  runner, retryRunner = runMonthlyRetryCharges, reconcileReceipts = reconcileWompiReceipts,
  now = new Date(), clock = () => new Date() } = {}) {
  const { mode, schema: requestedSchema, explicitSchema } = parseArguments(argv);
  let schema = requestedSchema;
  let inventoryCompatibility = false;
  assertBillingJobRuntime(mode, env);
  const url = required("SUPABASE_URL", env);
  const key = required("SUPABASE_SERVICE_ROLE_KEY", env);
  let getTransaction;
  let createTransaction;
  let getPaymentSource;
  let prepareTransaction;
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
      return getWompiTransaction({ baseUrl, privateKey, transactionId, fetchImpl, environment: wompiEnv });
    };
    getPaymentSource = ({ paymentSourceId }) => {
      assertBillingJobRuntime("reconcile", env);
      return getWompiPaymentSource({ baseUrl, privateKey, paymentSourceId, fetchImpl,
        environment: wompiEnv, clock });
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
      prepareTransaction = async (params) => {
        assertBillingJobRuntime("charge", env);
        const acceptance = await getAcceptanceToken({ baseUrl, publicKey, fetchImpl });
        assertBillingJobRuntime("charge", env);
        const options = transactionRequest({ ...params, ...acceptance, privateKey, integritySecret });
        let consumed = false;
        return { send: async ({ onSending, onDispatched } = {}) => {
          if (consumed) throw new Error("POST_DISPATCH_UNKNOWN");
          consumed = true;
          assertBillingJobRuntime("charge", env);
          const created = await sendTransactionRequest({ baseUrl, options, fetchImpl, onSending });
          try {
            await onDispatched?.({ id: String(created.id), status: created.status });
            return { id: String(created.id), status: created.status };
          } catch {
            throw new Error("POST_DISPATCH_UNKNOWN");
          }
        } };
      };
    }
  }
  // Every mode, URL and production guard has passed before the client can be created.
  const supabase = clientFactory(url, key, { auth: { persistSession: false } });
  if (mode === "inventory" && schema === "v040") {
    let readiness;
    try { readiness = await supabase.rpc("billing_retry_schema_ready"); }
    catch { throw new Error("BILLING_JOB_SCHEMA_NOT_READY"); }
    const missing = readiness?.data === false || ["PGRST202", "42883", "42P01"].includes(readiness?.error?.code);
    if (!explicitSchema && missing) {
      schema = "v031";
      inventoryCompatibility = true;
    } else if (readiness?.error || readiness?.data !== true) {
      throw new Error("BILLING_JOB_SCHEMA_NOT_READY");
    }
  }
  let receipts = { received: 0, processed: 0, review: 0, failed: 0, scopedReview: 0 };
  if (mode !== "inventory") {
    try {
      const { data, error } = await supabase.rpc("billing_retry_schema_ready");
      if (error || data !== true) throw new Error("BILLING_JOB_SCHEMA_NOT_READY");
    } catch { throw new Error("BILLING_JOB_SCHEMA_NOT_READY"); }
    // Node jobs recheck app/network policy after awaits, not only at startup.
    assertBillingJobRuntime("reconcile", env);
    try {
      const result = await reconcileReceipts({ supabase, getTransaction, getPaymentSource, logger });
      const fields = ["received", "processed", "review", "failed"];
      if (!result || !fields.every((field) => Number.isSafeInteger(result[field]) && result[field] >= 0)
        || result.received !== result.processed + result.review + result.failed
        || (result.scopedReview != null && (!Number.isSafeInteger(result.scopedReview)
          || result.scopedReview < 0 || result.scopedReview > result.review))) {
        throw new Error("BILLING_JOB_OPERATIONAL_FAILURE");
      }
      receipts = { ...Object.fromEntries(fields.map((field) => [field, result[field]])), scopedReview: result.scopedReview ?? 0 };
    } catch {
      receipts.failed = 1;
      logger.error("Monthly billing receipts failed code=BILLING_JOB_OPERATIONAL_FAILURE");
    }
  }
  // Only a verified, subscription-scoped legacy review is isolated; unknown receipts still stop sending.
  const chargesBlockedByReceipts = receipts.failed > 0 || receipts.review > receipts.scopedReview;
  const runnerMode = mode === "charge" && chargesBlockedByReceipts ? "reconcile" : mode;
  assertBillingJobRuntime(runnerMode, env);
  const selectedRunner = runner ?? (schema === "v040" ? retryRunner : runMonthlyCharges);
  const runnerStats = await selectedRunner({ mode: runnerMode, env, now, clock, supabase, getTransaction,
    getPaymentSource, prepareTransaction: runnerMode === "charge" ? prepareTransaction : undefined,
    createTransaction: runnerMode === "charge" ? createTransaction : undefined, logger });
  const stats = { ...runnerStats, mode, schema, runnerMode, receipts, chargesBlockedByReceipts,
    inventoryCompatibility,
    schemaUnknown: (Number.isFinite(runnerStats.schemaUnknown) ? runnerStats.schemaUnknown : 0) + (inventoryCompatibility ? 1 : 0),
    blocked: (Number.isFinite(runnerStats.blocked) ? runnerStats.blocked : 0) + receipts.failed + receipts.review };
  const summary = { mode, schema, runnerMode, receipts, chargesBlockedByReceipts, inventoryCompatibility };
  for (const field of ["due", "outstanding", "payments", "charged", "skippedPending", "reconciled",
    "blocked", "noIds", "schemaUnknown", "failed", "duplicateCheckFailures", "auditFailures", "sent", "approved",
    "cycles", "retryQueued", "retriesDue", "originalsReserved", "retriesReserved", "repaired"]) {
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
