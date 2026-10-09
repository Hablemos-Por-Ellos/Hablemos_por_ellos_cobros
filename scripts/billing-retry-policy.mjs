export const VERIFIED_INSUFFICIENT_FUNDS_MESSAGE = "Intente mas tarde - Fondos Insuficientes";
export const MAX_CYCLE_ATTEMPTS = 2;
export const SEND_AUTHORIZATION_MAX_AGE_MS = 15_000;

const COLOMBIA_OFFSET_MS = 5 * 60 * 60 * 1000;
const STATUSES = new Set(["approved", "pending", "declined", "error", "voided"]);
const ENVIRONMENTS = new Set(["prod", "sandbox"]);

function providerEnvironment(value) {
  return value === "production" ? "prod" : value;
}

function fromProviderGet(value) {
  return (value?.verificationSource ?? value?.verifiedVia ?? value?.verification_source) === "provider_get";
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

// Provider finalization must explicitly be UTC; no browser date or receipt time fallback.
function parseUtcTimestamp(value) {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|\+00:00)$/.exec(value);
  if (!parts) return null;
  const parsed = new Date(value);
  if (!validDate(parsed) || parsed.getUTCFullYear() < 1970
    || parsed.getUTCFullYear() !== Number(parts[1]) || parsed.getUTCMonth() + 1 !== Number(parts[2])
    || parsed.getUTCDate() !== Number(parts[3]) || parsed.getUTCHours() !== Number(parts[4])
    || parsed.getUTCMinutes() !== Number(parts[5]) || parsed.getUTCSeconds() !== Number(parts[6])) return null;
  return parsed;
}

export function parseVerifiedFinalizedAt(value, now = new Date()) {
  const parsed = parseUtcTimestamp(value);
  return validDate(now) && parsed && parsed <= now ? parsed : null;
}

export function getRetryWindow(finalizedAt, now = new Date()) {
  const finalized = parseVerifiedFinalizedAt(finalizedAt, now);
  if (!finalized) return null;
  const colombia = new Date(finalized.getTime() - COLOMBIA_OFFSET_MS);
  const year = colombia.getUTCFullYear();
  const month = colombia.getUTCMonth();
  const nextDay = colombia.getUTCDate() + 1;
  return Object.freeze({
    start: new Date(Date.UTC(year, month, nextDay, 12)).toISOString(),
    end: new Date(Date.UTC(year, month, nextDay + 1, 5)).toISOString(),
  });
}

export function verifiedSnapshotMatches({ transaction, expected, environment, allowMissingSource = false }) {
  return Boolean(transaction && expected && ENVIRONMENTS.has(environment)
    && fromProviderGet(transaction) && providerEnvironment(transaction.environment) === environment
    && typeof transaction.id === "string" && transaction.id.length > 0
    && (expected.transactionId == null || transaction.id === expected.transactionId)
    && (expected.environment == null || expected.environment === environment)
    && typeof expected.reference === "string" && expected.reference.length > 0
    && transaction.reference === expected.reference
    && Number.isSafeInteger(expected.amount) && expected.amount >= 1500 && expected.amount <= 21_474_836
    && Number.isSafeInteger(transaction.amountInCents) && transaction.amountInCents === expected.amount * 100
    && expected.currency === "COP" && transaction.currency === "COP"
    && ((typeof expected.paymentSourceId === "string" && expected.paymentSourceId.length > 0
      && transaction.paymentSourceId === expected.paymentSourceId)
      || (allowMissingSource === true && expected.paymentSourceId == null))
    && STATUSES.has(transaction.status));
}

export function verifiedCardSourceMatches({ source, paymentSourceId, environment, now = new Date() }) {
  const verifiedAt = parseVerifiedFinalizedAt(source?.verifiedAt ?? source?.verified_at, now);
  return Boolean(source && ENVIRONMENTS.has(environment)
    && fromProviderGet(source) && providerEnvironment(source.environment) === environment
    && typeof paymentSourceId === "string" && paymentSourceId.length > 0
    && source.id === paymentSourceId && source.type === "CARD" && source.status === "AVAILABLE"
    && verifiedAt && now.getTime() - verifiedAt.getTime() <= 60_000);
}

export function classifyAutomaticRetry({ frequency, attemptNumber, retryAuthorized = false,
  authorizationRevoked = false, transaction, expected, environment, source, now = new Date() } = {}) {
  const decision = (action, reason, extra = {}) => Object.freeze({ action, reason, ...extra });
  if (frequency !== "monthly") return decision("manual_review", "ONE_TIME_NO_AUTOMATIC_RETRY");
  if (!validDate(now) || !verifiedSnapshotMatches({ transaction, expected, environment })) {
    return decision("manual_review", "UNVERIFIED_TRANSACTION_SNAPSHOT");
  }
  if (transaction.status === "pending") return decision("reconcile", "PROVIDER_PENDING");
  if (transaction.status === "approved") return decision("complete", "PROVIDER_APPROVED");
  if (attemptNumber !== 1) return decision("manual_review", "ATTEMPT_BUDGET_EXHAUSTED");
  if (retryAuthorized !== true || authorizationRevoked !== false) {
    return decision("manual_review", "RETRY_AUTHORIZATION_MISSING_OR_REVOKED");
  }
  if (transaction.status !== "declined" || typeof transaction.statusMessage !== "string"
    || transaction.statusMessage.normalize("NFKC").trim() !== VERIFIED_INSUFFICIENT_FUNDS_MESSAGE) {
    return decision("manual_review", "DECLINE_REASON_NOT_RETRYABLE");
  }
  if (transaction.paymentMethodType !== "CARD"
    || !verifiedCardSourceMatches({ source, paymentSourceId: expected.paymentSourceId, environment, now })) {
    return decision("manual_review", "CARD_SOURCE_NOT_VERIFIED_AVAILABLE");
  }
  const window = getRetryWindow(transaction.finalizedAt, now);
  if (!window) return decision("manual_review", "FINALIZED_AT_NOT_VERIFIED");
  if (now.getTime() >= Date.parse(window.end)) return decision("manual_review", "RETRY_WINDOW_EXPIRED");
  return decision(now.getTime() < Date.parse(window.start) ? "retry_wait" : "retry_ready",
    "VERIFIED_INSUFFICIENT_FUNDS", { retryWindowStart: window.start, retryWindowEnd: window.end,
      effectiveAt: new Date(transaction.finalizedAt).toISOString() });
}

export function canStartAuthorizedSend({ sendAuthorizedAt, windowEnd, now = new Date() } = {}) {
  const authorization = parseVerifiedFinalizedAt(sendAuthorizedAt, now);
  const end = parseUtcTimestamp(windowEnd);
  return Boolean(authorization && validDate(end) && now < end
    && now.getTime() - authorization.getTime() < SEND_AUTHORIZATION_MAX_AGE_MS);
}
