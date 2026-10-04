import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// Local validation harness for v0.3.0, not a release or a production entry point.
// Parent supplies an already running REAL API/Supabase and runtime-only stdin JSON:
// { publicKey, privateKey, integritySecret, eventsSecret,
//   server: { wompiEnvironment: "sandbox", supabaseUrl: "http://127.0.0.1:54321" },
//   card: { sandboxFixture: true, number, cvc, exp_month, exp_year, card_holder } }
// No env/files, Auth, SQL, cleanup or recurring jobs are accessed here. The parent
// must use the SAME Sandbox keys on the server, isolate the fixture database and
// disable scheduled charges. No endpoint currently attests server configuration.
// A signed LOCAL webhook replay is not evidence of Wompi delivering a callback.
// Same IDs/duplicate responses are not evidence of database row counts or dates.
// Parent pins/installs jose as a dev dependency; missing jose stops before HTTP.
// Only the public APPROVED Sandbox fixture is accepted from stdin, never a real
// PAN. Future expiry and a three-digit fixture CVC are supplied by the parent.
// https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/
// GET /tokens/keys/tokenization returns data.publicKey in the official JS example:
// an RSA SPKI PEM, called publicKeyPEM here, NOT the pub_test_ merchant credential.
// data.publicKeyPEM is also accepted as an explicit descriptor spelling; if both
// fields exist their normalized PEMs must agree. No URLs/JWKs are followed.
// https://docs.wompi.co/docs/colombia/metodos-de-pago/
// POST /tokens/cards is ONLY { payload: compactJwe }. Legal consent is an
// independent harness gate, not the old plaintext card/accepted_legal envelope.

export const FIXTURE_AMOUNT_COP = 1500;
export const WOMPI_SANDBOX_BASE = "https://sandbox.wompi.co/v1";
const MAX_STDIN_BYTES = 16384;
const REQUEST_TIMEOUT_MS = 20000;
const CHECKSUM_PROPERTIES = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];
const JWE_HEADER = Object.freeze({ alg: "RSA-OAEP-256", enc: "A256GCM" });

function emptyReport() {
  return {
    assertions: { passed: [], failed: [] },
    counts: { localRequests: 0, sandboxRequests: 0, tokenizationKeyGets: 0, jweEncryptions: 0, tokenizationPosts: 0, confirmPosts: 0, webhookPosts: 0, statusGets: 0 },
  };
}

export class HarnessFailure extends Error {
  constructor(assertion, report = emptyReport()) {
    super(assertion);
    this.name = "HarnessFailure";
    this.report = structuredClone(report);
    this.report.assertions.failed.push(assertion);
  }
}

function requireCondition(condition, assertion, report) {
  if (!condition) throw new HarnessFailure(assertion, report);
}

export function validateLocalUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HarnessFailure("localhost_url_required"); }
  requireCondition(
    typeof value === "string" && /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/?$/.test(value)
      && ["http:", "https:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
      && !value.includes("\\") && !value.includes("%"),
    "localhost_url_required"
  );
  return url.origin;
}

function validateOptions(options) {
  requireCondition(options?.runSandbox === "yes", "sandbox_execution_consent_required");
  requireCondition(options?.acceptedLegal === "yes", "independent_legal_consent_required");
  requireCondition(options?.serverSandbox === "yes", "parent_server_sandbox_confirmation_required");
  const localUrl = validateLocalUrl(options.localUrl);
  const pollAttempts = options.pollAttempts ?? 20;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  requireCondition(Number.isInteger(pollAttempts) && pollAttempts >= 1 && pollAttempts <= 30, "bounded_poll_attempts_required");
  requireCondition(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 100 && pollIntervalMs <= 5000, "bounded_poll_interval_required");
  return { localUrl, pollAttempts, pollIntervalMs };
}

export function parseCli(argv) {
  const supported = new Set(["run-sandbox", "accepted-legal", "server-sandbox", "local-url", "poll-attempts", "poll-interval-ms"]);
  const args = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    requireCondition(match && supported.has(match[1]) && !Object.hasOwn(args, match[1]), "unsupported_or_duplicate_argument");
    args[match[1]] = match[2];
  }
  const options = {
    runSandbox: args["run-sandbox"], acceptedLegal: args["accepted-legal"],
    serverSandbox: args["server-sandbox"], localUrl: args["local-url"],
    ...(args["poll-attempts"] !== undefined ? { pollAttempts: Number(args["poll-attempts"]) } : {}),
    ...(args["poll-interval-ms"] !== undefined ? { pollIntervalMs: Number(args["poll-interval-ms"]) } : {}),
  };
  validateOptions(options);
  return options;
}

export function validateRuntimeInput(input, now = Date.now()) {
  requireCondition(input && typeof input === "object" && !Array.isArray(input), "runtime_input_required");
  const supported = new Set(["publicKey", "privateKey", "integritySecret", "eventsSecret", "server", "card", "amount", "email"]);
  requireCondition(Object.keys(input).every((key) => supported.has(key)), "unsupported_runtime_field");
  for (const [key, prefix] of [
    ["publicKey", "pub_test_"], ["privateKey", "prv_test_"],
    ["integritySecret", "test_integrity_"], ["eventsSecret", "test_events_"],
  ]) {
    requireCondition(typeof input[key] === "string" && new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(input[key]), "sandbox_key_prefixes_required");
  }
  requireCondition(input.server?.wompiEnvironment === "sandbox", "sandbox_server_environment_required");
  validateLocalUrl(input.server?.supabaseUrl);
  requireCondition(input.amount === undefined || input.amount === FIXTURE_AMOUNT_COP, "fixture_amount_must_be_1500_cop");
  requireCondition(input.email === undefined || isFixtureEmail(input.email), "example_test_email_required");
  const card = input.card;
  requireCondition(card?.sandboxFixture === true, "parent_sandbox_card_fixture_confirmation_required");
  const cardFields = new Set(["sandboxFixture", "number", "cvc", "exp_month", "exp_year", "card_holder"]);
  requireCondition(Object.keys(card).every((key) => cardFields.has(key)), "unsupported_runtime_card_field");
  requireCondition(typeof card.number === "string" && /^(?:4242){4}$/.test(card.number), "only_documented_approved_sandbox_card_allowed");
  requireCondition(
    typeof card.cvc === "string" && /^\d{3}$/.test(card.cvc)
      && typeof card.exp_month === "string" && /^(0[1-9]|1[0-2])$/.test(card.exp_month)
      && typeof card.exp_year === "string" && /^\d{2}$/.test(card.exp_year)
      && typeof card.card_holder === "string" && card.card_holder.trim().length >= 5 && card.card_holder.length <= 100,
    "runtime_card_fields_invalid"
  );
  requireCondition(Number.isFinite(now) && Date.UTC(2000 + Number(card.exp_year), Number(card.exp_month), 1) > now,
    "sandbox_fixture_expiry_must_be_future");
  return input;
}

export async function loadJoseModule(load = () => import("jose"), report) {
  try {
    const jose = await load();
    requireCondition(typeof jose?.importSPKI === "function" && typeof jose?.EncryptJWT === "function", "jose_encryption_api_required", report);
    return jose;
  } catch (error) {
    if (error instanceof HarnessFailure) throw error;
    throw new HarnessFailure("jose_dependency_required_before_network", report);
  }
}

export function validateTokenizationKeyDescriptor(body, report) {
  const data = body?.data;
  const normalize = (value) => {
    if (typeof value !== "string" || value.length > MAX_STDIN_BYTES) return null;
    // Sandbox also returns PEM as a single line separated by spaces.
    const match = /^-----BEGIN PUBLIC KEY-----[ \t\n]*([A-Za-z0-9+/= \t\n]+)-----END PUBLIC KEY-----$/.exec(
      value.replace(/\\n/g, "\n").replace(/\r/g, "").trim()
    );
    if (!match) return null;
    const encoded = match[1].replace(/[ \t\n]/g, "");
    if (!encoded || Buffer.from(encoded, "base64").toString("base64") !== encoded) return null;
    const lines = encoded.match(/.{1,64}/g).join("\n");
    return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
  };
  const explicitPem = normalize(data?.publicKeyPEM);
  const documentedPem = normalize(data?.publicKey);
  requireCondition((data?.publicKeyPEM === undefined || explicitPem !== null)
    && (data?.publicKey === undefined || documentedPem !== null)
    && (data?.publicKeyPEM === undefined || data?.publicKey === undefined || explicitPem === documentedPem),
  "tokenization_key_descriptor_ambiguous", report);
  const publicKeyPEM = explicitPem ?? documentedPem;
  requireCondition(typeof publicKeyPEM === "string" && publicKeyPEM.length <= MAX_STDIN_BYTES
    && /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n ]+\n-----END PUBLIC KEY-----$/.test(publicKeyPEM),
  "tokenization_public_key_spki_pem_required", report);
  requireCondition((data?.alg === undefined || data.alg === JWE_HEADER.alg)
    && (data?.enc === undefined || data.enc === JWE_HEADER.enc), "tokenization_key_algorithms_not_allowed", report);
  let key;
  try {
    key = createPublicKey({ key: publicKeyPEM, format: "pem", type: "spki" });
    const receivedDer = Buffer.from(publicKeyPEM.split("\n").slice(1, -1).join(""), "base64");
    if (!key.export({ type: "spki", format: "der" }).equals(receivedDer)) throw new Error("SPKI_TRAILING_CONTENT");
  } catch {
    throw new HarnessFailure("tokenization_public_key_spki_invalid", report);
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  requireCondition(key.asymmetricKeyType === "rsa" && Number.isInteger(modulusLength)
    && modulusLength >= 2048 && modulusLength <= 8192, "tokenization_public_key_rsa_strength_required", report);
  return { publicKeyPEM, ...JWE_HEADER, modulusLength };
}

function validateCompactJwe(payload, descriptor, report) {
  try {
    requireCondition(typeof payload === "string" && payload.length <= MAX_STDIN_BYTES, "encrypted_compact_jwe_required", report);
    const segments = payload.split(".");
    requireCondition(segments.length === 5 && segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment)
      && Buffer.from(segment, "base64url").toString("base64url") === segment), "encrypted_compact_jwe_required", report);
    const protectedHeader = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8"));
    requireCondition(protectedHeader?.alg === JWE_HEADER.alg && protectedHeader.enc === JWE_HEADER.enc
      && Object.keys(protectedHeader).length === 2, "encrypted_jwe_algorithms_required", report);
    requireCondition(Buffer.from(segments[1], "base64url").length === descriptor.modulusLength / 8
      && Buffer.from(segments[2], "base64url").length === 12
      && Buffer.from(segments[3], "base64url").length > 0
      && Buffer.from(segments[4], "base64url").length === 16, "encrypted_compact_jwe_required", report);
  } catch (error) {
    if (error instanceof HarnessFailure) throw error;
    throw new HarnessFailure("encrypted_compact_jwe_required", report);
  }
}

async function encryptRuntimeCard(card, descriptor, jose, report) {
  // Mirror the official EncryptJWT example with exactly the documented card fields.
  const claims = {
    number: card.number, cvc: card.cvc, exp_month: card.exp_month,
    exp_year: card.exp_year, card_holder: card.card_holder,
  };
  try {
    const key = await jose.importSPKI(descriptor.publicKeyPEM, JWE_HEADER.alg);
    requireCondition(key?.type === "public", "jose_public_encryption_key_required", report);
    const payload = await new jose.EncryptJWT(claims).setProtectedHeader({ ...JWE_HEADER }).encrypt(key);
    validateCompactJwe(payload, descriptor, report);
    report.counts.jweEncryptions += 1;
    return payload;
  } catch (error) {
    if (error instanceof HarnessFailure) throw error;
    throw new HarnessFailure("jwe_encryption_failed_no_plaintext_fallback", report);
  } finally {
    for (const key of Object.keys(claims)) delete claims[key];
  }
}

function isFixtureEmail(email) {
  return typeof email === "string" && email.length <= 254
    && /^[a-z0-9._+-]+@(?:[a-z0-9-]+\.)*example\.test$/.test(email);
}

export function buildDonor(email) {
  requireCondition(isFixtureEmail(email), "example_test_email_required");
  return {
    firstName: "Sandbox", lastName: "Integration", email, phone: "3000000000",
    documentType: "CC", documentNumber: "0000000000", city: "Sandbox",
    wantsUpdates: false, isRecurring: true, preferredPaymentDay: 16,
  };
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function signWebhookReplay(transaction, eventsSecret, timestamp) {
  requireCondition(typeof eventsSecret === "string" && /^test_events_[A-Za-z0-9_-]+$/.test(eventsSecret), "sandbox_events_secret_required");
  requireCondition(Number.isSafeInteger(timestamp) && timestamp > 0, "webhook_timestamp_invalid");
  requireCondition(safeIdentifier(transaction?.id) && transaction.status === "APPROVED"
    && typeof transaction.reference === "string" && /^HPE-[A-Za-z0-9-]{4,96}$/.test(transaction.reference)
    && transaction.amount_in_cents === FIXTURE_AMOUNT_COP * 100 && transaction.currency === "COP"
    && typeof transaction.finalized_at === "string" && Number.isFinite(Date.parse(transaction.finalized_at)),
  "verified_transaction_required_for_webhook");
  // Only verified non-sensitive transaction fields enter the replay/receipt.
  const tx = {
    id: transaction.id, status: transaction.status, amount_in_cents: transaction.amount_in_cents,
    currency: transaction.currency, reference: transaction.reference, finalized_at: transaction.finalized_at,
  };
  const checksum = createHash("sha256")
    .update(`${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${eventsSecret}`).digest("hex");
  return {
    event: "transaction.updated", environment: "test", data: { transaction: tx }, timestamp,
    signature: { properties: [...CHECKSUM_PROPERTIES], checksum },
  };
}

export async function runSandboxE2E(options, runtimeInput, dependencies = {}) {
  const report = emptyReport();
  const { localUrl, pollAttempts, pollIntervalMs } = validateOptions(options);
  const now = dependencies.now ?? Date.now;
  const input = structuredClone(validateRuntimeInput(runtimeInput, now()));
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const donor = buildDonor(input.email ?? `wompi-e2e-${randomUUID()}@donors.example.test`);
  const pass = (name, condition) => {
    requireCondition(condition, name, report);
    report.assertions.passed.push(name);
  };
  pass("guardrails_checked_before_network", true);

  async function request(target, method, path, body, headers = {}) {
    const isLocal = target === "local";
    const allowed = isLocal
      ? method === "POST" && ["/api/donations", "/api/wompi/webhook"].includes(path)
      : (method === "GET" && (["/merchants/info", "/tokens/keys/tokenization"].includes(path)
          || /^\/(transactions|payment_sources)\/[A-Za-z0-9_-]{1,128}$/.test(path)))
        || (method === "POST" && path === "/tokens/cards");
    requireCondition(allowed, "request_endpoint_not_allowed", report);
    const url = `${isLocal ? localUrl : WOMPI_SANDBOX_BASE}${path}`;
    report.counts[isLocal ? "localRequests" : "sandboxRequests"] += 1;
    if (path === "/tokens/keys/tokenization") report.counts.tokenizationKeyGets += 1;
    if (path === "/tokens/cards") report.counts.tokenizationPosts += 1;
    if (path === "/api/donations" && body.stage === "confirm") report.counts.confirmPosts += 1;
    if (path === "/api/wompi/webhook") report.counts.webhookPosts += 1;
    if (path.startsWith("/transactions/")) report.counts.statusGets += 1;
    try {
      const response = await fetchImpl(url, {
        method, redirect: "error", credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      requireCondition(!response.redirected && (!response.url || response.url === url), "response_redirect_not_allowed", report);
      const json = await response.json();
      requireCondition(json && typeof json === "object" && !Array.isArray(json), "json_response_required", report);
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof HarnessFailure) throw error;
      // Never propagate provider bodies, URLs, headers, card data or stack traces.
      throw new HarnessFailure(isLocal ? "local_request_failed_no_write_retry" : "sandbox_request_failed_no_write_retry", report);
    }
  }

  try {
    const jose = await loadJoseModule(dependencies.loadJose, report);
    const merchant = await request("sandbox", "GET", "/merchants/info", null, { "x-merchant-public-key": input.publicKey });
    pass("sandbox_merchant_acceptance_available", merchant.status === 200
      && typeof merchant.json.data?.presigned_acceptance?.acceptance_token === "string"
      && merchant.json.data.presigned_acceptance.acceptance_token.length > 0
      && typeof merchant.json.data?.presigned_personal_data_auth?.acceptance_token === "string"
      && merchant.json.data.presigned_personal_data_auth.acceptance_token.length > 0);

    const keyResponse = await request("sandbox", "GET", "/tokens/keys/tokenization", null, { Authorization: `Bearer ${input.publicKey}` });
    requireCondition(keyResponse.status === 200, "sandbox_tokenization_key_get_required", report);
    const descriptor = validateTokenizationKeyDescriptor(keyResponse.json, report);
    pass("sandbox_tokenization_key_descriptor_validated", true);
    let encryptedPayload = await encryptRuntimeCard(input.card, descriptor, jose, report);
    delete input.card;
    pass("encrypted_jwe_prepared_before_local_writes", true);

    const draft = await request("local", "POST", "/api/donations", { stage: "draft", donor, amount: FIXTURE_AMOUNT_COP });
    const checkout = draft.json.checkout;
    pass("real_draft_contract", draft.status === 200 && draft.json.status === "draft_saved"
      && typeof checkout?.token === "string" && checkout.token.length >= 32 && checkout.token.length <= 256
      && typeof checkout.reference === "string" && /^HPE-[A-Za-z0-9-]{4,96}$/.test(checkout.reference)
      && checkout.amountInCents === FIXTURE_AMOUNT_COP * 100 && checkout.currency === "COP"
      && Number.isFinite(Date.parse(checkout.expiresAt)) && Date.parse(checkout.expiresAt) > now());
    const expectedIntegrity = createHash("sha256")
      .update(`${checkout.reference}${FIXTURE_AMOUNT_COP * 100}COP${input.integritySecret}`).digest("hex");
    pass("server_sandbox_integrity_matches", checkout.signature === expectedIntegrity);
    pass("legal_documents_available", typeof checkout.acceptancePermalink === "string" && checkout.acceptancePermalink.length > 0
      && typeof checkout.personalDataAuthPermalink === "string" && checkout.personalDataAuthPermalink.length > 0);

    const base = { donor, amount: FIXTURE_AMOUNT_COP, checkoutToken: checkout.token, paymentMethod: "card" };
    const started = await request("local", "POST", "/api/donations", {
      ...base, stage: "checkout", wompi: { reference: checkout.reference },
    });
    pass("real_checkout_contract", started.status === 200 && started.json.status === "checkout_started" && started.json.reference === checkout.reference);

    const tokenized = await request("sandbox", "POST", "/tokens/cards", { payload: encryptedPayload }, { Authorization: `Bearer ${input.publicKey}` });
    encryptedPayload = null;
    pass("sandbox_card_tokenized", tokenized.status === 201 && tokenized.json.status === "CREATED"
      && typeof tokenized.json.data?.id === "string" && /^tok_test_[A-Za-z0-9_-]+$/.test(tokenized.json.data.id));

    const confirmed = await request("local", "POST", "/api/donations", {
      ...base, stage: "confirm", wompi: { reference: checkout.reference, cardToken: tokenized.json.data.id },
    });
    delete tokenized.json.data.id;
    const isKnownRecovery = confirmed.status === 400 && confirmed.json.code === "reconciliation_required";
    pass("real_confirm_known_transaction", (([200, 202].includes(confirmed.status)
      && ["subscription_created", "payment_pending"].includes(confirmed.json.status)) || isKnownRecovery)
      && safeIdentifier(confirmed.json.transactionId));
    const transactionId = confirmed.json.transactionId;

    let transaction;
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const state = await request("sandbox", "GET", `/transactions/${transactionId}`, null, { Authorization: `Bearer ${input.privateKey}` });
      const tx = state.json.data;
      requireCondition(state.status === 200 && tx?.id === transactionId && tx.reference === checkout.reference
        && tx.amount_in_cents === FIXTURE_AMOUNT_COP * 100 && tx.currency === "COP"
        && tx.customer_email === donor.email && (tx.payment_method_type ?? tx.payment_method?.type) === "CARD",
      "sandbox_transaction_contract_mismatch", report);
      requireCondition(["APPROVED", "PENDING", "DECLINED", "ERROR", "VOIDED"].includes(tx.status), "sandbox_transaction_status_unknown", report);
      if (tx.status === "APPROVED") { transaction = tx; break; }
      requireCondition(tx.status === "PENDING", "sandbox_transaction_not_approved", report);
      if (attempt + 1 < pollAttempts) await sleep(pollIntervalMs);
    }
    pass("sandbox_transaction_approved", Boolean(transaction));
    pass("provider_finalization_timestamp_available", typeof transaction.finalized_at === "string" && Number.isFinite(Date.parse(transaction.finalized_at)));
    const sourceId = transaction.payment_source_id == null ? "" : String(transaction.payment_source_id);
    pass("sandbox_transaction_has_payment_source", safeIdentifier(sourceId));
    const source = await request("sandbox", "GET", `/payment_sources/${sourceId}`, null, { Authorization: `Bearer ${input.privateKey}` });
    pass("sandbox_source_available", source.status === 200 && String(source.json.data?.id) === sourceId
      && source.json.data.type === "CARD" && source.json.data.status === "AVAILABLE");

    const replay = signWebhookReplay(transaction, input.eventsSecret, Math.floor(now() / 1000));
    const checksum = replay.signature.checksum;
    const invalidChecksum = `${checksum[0] === "0" ? "1" : "0"}${checksum.slice(1)}`;
    const invalid = await request("local", "POST", "/api/wompi/webhook", replay, { "x-event-checksum": invalidChecksum });
    pass("invalid_webhook_signature_rejected", invalid.status === 401);
    const applied = await request("local", "POST", "/api/wompi/webhook", replay, { "x-event-checksum": checksum });
    pass("signed_local_webhook_replay_reconciled", applied.status === 200 && applied.json.transactionId === transactionId
      && ["processed", "duplicate"].includes(applied.json.result));
    const duplicate = await request("local", "POST", "/api/wompi/webhook", replay, { "x-event-checksum": checksum });
    pass("identical_webhook_replay_duplicate", duplicate.status === 200 && duplicate.json.transactionId === transactionId && duplicate.json.result === "duplicate");

    // No token on retries: the server must reuse its attempt, not create a source/charge.
    const retryBody = { ...base, stage: "confirm", wompi: { reference: checkout.reference, transactionId } };
    const reconciled = await request("local", "POST", "/api/donations", retryBody);
    pass("confirm_after_reconciliation_approved", reconciled.status === 200 && reconciled.json.status === "subscription_created"
      && reconciled.json.transactionId === transactionId && safeIdentifier(reconciled.json.subscriptionId));
    if (confirmed.json.subscriptionId) {
      pass("initial_subscription_identity_preserved", confirmed.json.subscriptionId === reconciled.json.subscriptionId);
    }
    const retried = await request("local", "POST", "/api/donations", retryBody);
    pass("idempotent_confirm_same_transaction_and_subscription", retried.status === 200 && retried.json.status === "subscription_created"
      && retried.json.transactionId === transactionId && retried.json.subscriptionId === reconciled.json.subscriptionId);
    return structuredClone(report);
  } catch (error) {
    if (error instanceof HarnessFailure) throw error;
    throw new HarnessFailure("harness_failed_without_sensitive_diagnostics", report);
  } finally {
    // Best-effort reference release, not a promise of secure JavaScript RAM erasure.
    for (const key of Object.keys(input)) delete input[key];
  }
}

export async function readRuntimeInput(stream) {
  requireCondition(!stream.isTTY, "runtime_input_must_use_private_stdin");
  let bytes = 0;
  const chunks = [];
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      bytes += buffer.length;
      requireCondition(bytes <= MAX_STDIN_BYTES, "runtime_input_too_large");
    }
    const buffer = Buffer.concat(chunks);
    try { return JSON.parse(buffer.toString("utf8")); } finally { buffer.fill(0); }
  } catch (error) {
    if (error instanceof HarnessFailure) throw error;
    throw new HarnessFailure("runtime_input_invalid_or_unavailable");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function main(argv = process.argv.slice(2), stream = process.stdin, write = (value) => process.stdout.write(value), dependencies = {}) {
  let report;
  let runtime;
  let exitCode = 0;
  try {
    const options = parseCli(argv);
    runtime = await readRuntimeInput(stream);
    report = await runSandboxE2E(options, runtime, dependencies);
  } catch (error) {
    exitCode = 1;
    report = error instanceof HarnessFailure ? error.report : new HarnessFailure("harness_failed_without_sensitive_diagnostics").report;
  } finally {
    if (runtime && typeof runtime === "object") for (const key of Object.keys(runtime)) delete runtime[key];
  }
  write(`${JSON.stringify(report)}\n`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
