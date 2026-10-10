export const BILLING_JOB_MODES = Object.freeze(["inventory", "reconcile", "charge"]);

export function requireBillingJobMode(mode) {
  if (!BILLING_JOB_MODES.includes(mode)) throw new Error("BILLING_JOB_MODE_REQUIRED");
  return mode;
}

export function parseBillingJobMode(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || typeof argv[0] !== "string" || !argv[0].startsWith("--mode=")) {
    throw new Error("BILLING_JOB_MODE_REQUIRED");
  }
  return requireBillingJobMode(argv[0].slice("--mode=".length));
}

// Generic Node 20 jobs mirror operation-mode.ts without a TypeScript runtime.
// Connected phases recheck this policy independently of workflow conditions.
export function assertBillingJobOperations(mode, env = process.env) {
  requireBillingJobMode(mode);
  if (env.APP_OPERATION_MODE === "demo") throw new Error("BILLING_JOB_DEMO_DISABLED");
  if (mode === "charge" && (env.APP_OPERATION_MODE !== "active"
    || env.FINANCIAL_OPERATIONS_ENABLED !== "true")) {
    throw new Error("FINANCIAL_OPERATIONS_DISABLED");
  }
}

export function getBillingWompiEnvironment(env = process.env) {
  const value = (env.WOMPI_ENV || env.NEXT_PUBLIC_WOMPI_ENV || "").toLowerCase();
  if (["prod", "production"].includes(value)) return "prod";
  if (["sandbox", "test"].includes(value)) return "sandbox";
  throw new Error("BILLING_JOB_WOMPI_ENV_INVALID");
}

export function assertBillingJobRuntime(mode, env = process.env) {
  assertBillingJobOperations(mode, env);
  if (mode === "charge" && env.GITHUB_ACTIONS === "true" && env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("BILLING_JOB_PRODUCTION_NOT_ALLOWED");
  }
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { throw new Error("BILLING_JOB_SUPABASE_URL_UNSAFE"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || !["http:", "https:"].includes(url.protocol)
    || (local ? env.VERCEL_ENV === "production"
      : url.protocol !== "https:" || env.VERCEL_ENV !== "production")) {
    throw new Error("BILLING_JOB_SUPABASE_URL_UNSAFE");
  }
  if (mode !== "inventory" && getBillingWompiEnvironment(env) === "prod"
    && (env.VERCEL_ENV !== "production" || local)) {
    throw new Error("BILLING_JOB_PRODUCTION_NOT_ALLOWED");
  }
  return mode;
}

const SAFE_ERROR_CODES = new Set([
  "BILLING_JOB_MODE_REQUIRED", "BILLING_JOB_DEMO_DISABLED", "FINANCIAL_OPERATIONS_DISABLED",
  "BILLING_JOB_SUPABASE_URL_UNSAFE", "BILLING_JOB_PRODUCTION_NOT_ALLOWED",
  "BILLING_JOB_WOMPI_ENV_INVALID", "BILLING_JOB_CONFIGURATION_INVALID",
  "BILLING_JOB_SCHEMA_NOT_READY",
  "BILLING_JOB_CALENDAR_REVIEW_REQUIRED",
  "BILLING_JOB_OPERATIONAL_FAILURE", "UNSUPPORTED_WOMPI_STATUS", "PRE_DISPATCH_FAILURE",
  "POST_DISPATCH_UNKNOWN", "MISSING_TRANSACTION_ID", "INVALID_CLAIM_RESPONSE",
]);

export function billingJobErrorCode(error) {
  const code = error?.code ?? error?.message;
  return SAFE_ERROR_CODES.has(code) ? code : "BILLING_JOB_OPERATIONAL_FAILURE";
}

export function logBillingJobError(logger, error) {
  logger.error(`Monthly billing failed code=${billingJobErrorCode(error)}`);
}
