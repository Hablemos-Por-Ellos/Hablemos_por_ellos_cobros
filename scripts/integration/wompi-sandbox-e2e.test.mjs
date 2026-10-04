// @vitest-environment node
import { Readable } from "node:stream";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscriptionPayloadSchema } from "../../src/lib/schemas";
import { computeWompiEventChecksum, isValidWompiEventChecksum } from "../../src/lib/wompi-webhook";
import {
  buildDonor, FIXTURE_AMOUNT_COP, HarnessFailure, loadJoseModule, main, parseCli, readRuntimeInput,
  runSandboxE2E, signWebhookReplay, validateLocalUrl, validateRuntimeInput, validateTokenizationKeyDescriptor, WOMPI_SANDBOX_BASE,
} from "./wompi-sandbox-e2e.mjs";

// All values are unit-test sentinels. This suite never contacts Wompi or a server.
const NOW = Date.parse("2026-10-03T12:00:00Z");
const OPTIONS = { runSandbox: "yes", acceptedLegal: "yes", serverSandbox: "yes", localUrl: "http://localhost:3001", pollAttempts: 2, pollIntervalMs: 100 };
const ARGS = ["--run-sandbox=yes", "--accepted-legal=yes", "--server-sandbox=yes", "--local-url=http://localhost:3001"];
const REFERENCE = "HPE-UNIT-REFERENCE";
const CHECKOUT_CAPABILITY = "unit-checkout-capability".repeat(2);
const TOKEN_SENTINEL = "tok_test_unit_sentinel";
const SOURCE_SENTINEL = "unit_source_sentinel";
const TX_ID = "unit-transaction";
const SUB_ID = "unit-subscription";
// Ephemeral non-payment crypto fixture; no PEM/private key is stored in this file.
const PUBLIC_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });

function compactJwe(header = { alg: "RSA-OAEP-256", enc: "A256GCM" }) {
  // Structurally valid descriptor MOCK, not encrypted/live Sandbox evidence.
  return [
    Buffer.from(JSON.stringify(header)), Buffer.alloc(256, 7), Buffer.alloc(12, 8),
    Buffer.alloc(32, 9), Buffer.alloc(16, 10),
  ].map((value) => value.toString("base64url")).join(".");
}

function joseMock() {
  const claims = [];
  const headers = [];
  const publicKey = { type: "public" };
  const importSPKI = vi.fn(async () => publicKey);
  const encrypt = vi.fn(async () => compactJwe());
  const EncryptJWT = vi.fn(function (payload) {
    claims.push(structuredClone(payload));
    this.setProtectedHeader = (header) => { headers.push(structuredClone(header)); return this; };
    this.encrypt = encrypt;
  });
  return { importSPKI, EncryptJWT, encrypt, claims, headers, publicKey };
}

function runtime() {
  return {
    publicKey: "pub_test_unit_sentinel", privateKey: "prv_test_fixture_only_not_a_real_key",
    integritySecret: "test_integrity_unit_sentinel", eventsSecret: "test_events_unit_sentinel",
    server: { wompiEnvironment: "sandbox", supabaseUrl: "http://127.0.0.1:54321" },
    email: "wompi-unit@donors.example.test",
    // Only the PUBLIC approved fixture documented by Wompi; never a real PAN.
    card: { sandboxFixture: true, number: "4242".repeat(4), cvc: "0".repeat(3), exp_month: "12", exp_year: "30", card_holder: "SANDBOX UNIT" },
  };
}

function transaction(overrides = {}) {
  return {
    id: TX_ID, status: "APPROVED", reference: REFERENCE, amount_in_cents: 150000, currency: "COP",
    customer_email: runtime().email, payment_method_type: "CARD", payment_source_id: SOURCE_SENTINEL,
    finalized_at: "2026-10-03T11:59:58Z", ...overrides,
  };
}

function response(status, json, properties = {}) {
  return { status, redirected: false, json: async () => structuredClone(json), ...properties };
}

function transport(modify = () => undefined) {
  let confirmCount = 0;
  let webhookCount = 0;
  const calls = [];
  const jose = joseMock();
  const fetchImpl = vi.fn(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { url, init, body };
    calls.push(call);
    const replacement = modify(call, { confirmCount, webhookCount });
    if (replacement !== undefined) return replacement;
    if (url === `${WOMPI_SANDBOX_BASE}/merchants/info`) return response(200, { data: {
      presigned_acceptance: { acceptance_token: "unit-acceptance" },
      presigned_personal_data_auth: { acceptance_token: "unit-personal-auth" },
    } });
    if (url === `${WOMPI_SANDBOX_BASE}/tokens/keys/tokenization`) return response(200, { data: { publicKey: PUBLIC_KEY_PEM } });
    if (url.endsWith("/api/donations")) {
      // Every stage is parsed against the project's ACTUAL API schema.
      if (!subscriptionPayloadSchema.safeParse(body).success) throw new Error("unit schema failure");
      if (body.stage === "draft") return response(200, { status: "draft_saved", checkout: {
        token: CHECKOUT_CAPABILITY, reference: REFERENCE, amountInCents: 150000, currency: "COP",
        signature: createHash("sha256").update(`${REFERENCE}150000COP${runtime().integritySecret}`).digest("hex"),
        expiresAt: new Date(NOW + 60000).toISOString(),
        acceptancePermalink: "https://sandbox.wompi.co/terms", personalDataAuthPermalink: "https://sandbox.wompi.co/privacy",
      } });
      if (body.stage === "checkout") return response(200, { status: "checkout_started", reference: REFERENCE });
      confirmCount += 1;
      return response(confirmCount === 1 ? 202 : 200, {
        status: confirmCount === 1 ? "payment_pending" : "subscription_created", transactionId: TX_ID, subscriptionId: SUB_ID,
      });
    }
    if (url === `${WOMPI_SANDBOX_BASE}/tokens/cards`) return response(201, { status: "CREATED", data: { id: TOKEN_SENTINEL } });
    if (url === `${WOMPI_SANDBOX_BASE}/transactions/${TX_ID}`) return response(200, { data: transaction() });
    if (url === `${WOMPI_SANDBOX_BASE}/payment_sources/${SOURCE_SENTINEL}`) return response(200, { data: { id: SOURCE_SENTINEL, type: "CARD", status: "AVAILABLE" } });
    if (url.endsWith("/api/wompi/webhook")) {
      if (!isValidWompiEventChecksum(body, init.headers["x-event-checksum"], runtime().eventsSecret)) return response(401, { message: "unit-invalid" });
      webhookCount += 1;
      return response(200, { transactionId: TX_ID, result: webhookCount === 1 ? "processed" : "duplicate" });
    }
    throw new Error("unexpected unit endpoint");
  });
  return { fetchImpl, calls, sleep: vi.fn(async () => {}), now: () => NOW, loadJose: vi.fn(async () => jose), jose };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("offline guardrails, no network before all consent/configuration checks", () => {
  it.each([undefined, "no", true, "YES", "yes "])("requires explicit execution consent: %s", async (runSandbox) => {
    const fetchImpl = vi.fn();
    await expect(runSandboxE2E({ ...OPTIONS, runSandbox }, runtime(), { fetchImpl })).rejects.toThrow("sandbox_execution_consent_required");
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it.each([undefined, "no", true])("requires legal acceptance independently: %s", async (acceptedLegal) => {
    const fetchImpl = vi.fn();
    await expect(runSandboxE2E({ ...OPTIONS, acceptedLegal }, runtime(), { fetchImpl })).rejects.toThrow("independent_legal_consent_required");
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it("requires parent server attestation", async () => {
    const fetchImpl = vi.fn();
    await expect(runSandboxE2E({ ...OPTIONS, serverSandbox: undefined }, runtime(), { fetchImpl })).rejects.toThrow("parent_server_sandbox_confirmation_required");
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it.each([
    "https://production.wompi.co", "https://sandbox.wompi.co", "http://localhost.evil.test:3000",
    "http://192.168.1.2:3000", "http://0.0.0.0:3000", "http://127.1:3000", "http://2130706433:3000",
    "ftp://localhost", "http://user:pass@localhost", "http://localhost/api", "http://localhost/?key=secret",
    "http://localhost/#secret", "http://%6cocalhost", "http:\\localhost", "not-a-url",
  ])("rejects nonliteral/nonlocal origin: %s", async (localUrl) => {
    const fetchImpl = vi.fn();
    await expect(runSandboxE2E({ ...OPTIONS, localUrl }, runtime(), { fetchImpl })).rejects.toBeInstanceOf(HarnessFailure);
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "https://localhost:3443"])("accepts loopback origin: %s", (url) => {
    expect(validateLocalUrl(url)).toBe(new URL(url).origin);
  });

  it.each([
    ["publicKey", "pub_prod_unit"], ["privateKey", "prv_prod_unit"], ["eventsSecret", "prod_events_unit"],
    ["integritySecret", "prod_integrity_unit"], ["eventsSecret", "test_wrong_unit"], ["publicKey", "pub_test_"],
    ["privateKey", "prv_test_fixture_only_not_a_real_key\n"],
  ])("rejects wrong %s prefix", async (key, value) => {
    const fetchImpl = vi.fn();
    await expect(runSandboxE2E(OPTIONS, { ...runtime(), [key]: value }, { fetchImpl })).rejects.toThrow("sandbox_key_prefixes_required");
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it.each([0, 1499, 1501, 100000, "1500"])("fixes amount at 1500 COP: %s", async (amount) => {
    const fetchImpl = vi.fn();
    await expect(runSandboxE2E(OPTIONS, { ...runtime(), amount }, { fetchImpl })).rejects.toThrow("fixture_amount_must_be_1500_cop");
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it.each(["person@example.com", "person@example.test.evil.test", "person@real.test", "person@EXAMPLE.TEST"])("rejects nonfixture email: %s", (email) => {
    expect(() => buildDonor(email)).toThrow("example_test_email_required");
  });

  it("validates Supabase and environment declarations before fetching", async () => {
    for (const server of [
      { wompiEnvironment: "prod", supabaseUrl: "http://localhost:54321" },
      { wompiEnvironment: "sandbox", supabaseUrl: "https://unit.supabase.co" },
    ]) {
      const fetchImpl = vi.fn();
      await expect(runSandboxE2E(OPTIONS, { ...runtime(), server }, { fetchImpl })).rejects.toBeInstanceOf(HarnessFailure);
      expect(fetchImpl.mock.calls.length).toBe(0);
    }
  });

  it("requires a supplied Sandbox card, never generates a PAN/credential", () => {
    expect(() => validateRuntimeInput({ ...runtime(), card: { ...runtime().card, sandboxFixture: false } })).toThrow("parent_sandbox_card_fixture_confirmation_required");
    expect(() => validateRuntimeInput({ ...runtime(), card: { ...runtime().card, exp_month: "13" } })).toThrow("runtime_card_fields_invalid");
    expect(() => validateRuntimeInput({ ...runtime(), supabaseServiceKey: "not-allowed" })).toThrow("unsupported_runtime_field");
  });

  it.each(["0".repeat(16), "4111".repeat(4), "4242".repeat(3), "4242 ".repeat(4).trim()])("rejects every non-approved card, case %#", async (number) => {
    const deps = transport();
    const input = runtime();
    input.card.number = number;
    await expect(runSandboxE2E(OPTIONS, input, deps)).rejects.toThrow("only_documented_approved_sandbox_card_allowed");
    expect(deps.fetchImpl.mock.calls.length).toBe(0);
    expect(deps.loadJose.mock.calls.length).toBe(0);
  });

  it("requires future fixture expiry and the documented three-digit CVC", async () => {
    for (const card of [
      { ...runtime().card, exp_year: "20" },
      { ...runtime().card, cvc: "0".repeat(4) },
    ]) {
      const deps = transport();
      await expect(runSandboxE2E(OPTIONS, { ...runtime(), card }, deps)).rejects.toBeInstanceOf(HarnessFailure);
      expect(deps.fetchImpl.mock.calls.length).toBe(0);
    }
  });

  it("rejects extra runtime card fields before loading jose or making requests", async () => {
    const deps = transport();
    const input = runtime();
    input.card.unrequestedData = "fixture-only-placeholder";
    await expect(runSandboxE2E(OPTIONS, input, deps)).rejects.toThrow("unsupported_runtime_card_field");
    expect(deps.fetchImpl.mock.calls.length).toBe(0);
    expect(deps.loadJose.mock.calls.length).toBe(0);
  });

  it("CLI disallows endpoint overrides, secret arguments, duplicates and unbounded polling", () => {
    expect(parseCli(ARGS).runSandbox).toBe("yes");
    for (const arg of ["--wompi-url=https://production.wompi.co", "--private-key=unit", "--run-sandbox=yes", "--poll-attempts=31", "--poll-interval-ms=0"]) {
      expect(() => parseCli([...ARGS, arg])).toThrow(HarnessFailure);
    }
    expect(() => parseCli(ARGS.filter((arg) => !arg.startsWith("--accepted-legal=")))).toThrow("independent_legal_consent_required");
  });
});

describe("mock transport against real donation/checksum contracts, NOT live E2E evidence", () => {
  it("runs recurring draft/checkout/confirm, tokenization, state/source GET, signed replay and idempotent confirm", async () => {
    const deps = transport();
    const input = runtime();
    const result = await runSandboxE2E(OPTIONS, input, deps);
    expect(result.assertions.failed).toHaveLength(0);
    expect(result.assertions.passed).toContain("idempotent_confirm_same_transaction_and_subscription");
    expect(result.counts).toEqual({ localRequests: 8, sandboxRequests: 5, tokenizationKeyGets: 1, jweEncryptions: 1, tokenizationPosts: 1, confirmPosts: 3, webhookPosts: 3, statusGets: 1 });
    const local = deps.calls.filter((call) => call.url.endsWith("/api/donations"));
    expect(local.map((call) => call.body.stage)).toEqual(["draft", "checkout", "confirm", "confirm", "confirm"]);
    expect(local.every((call) => subscriptionPayloadSchema.safeParse(call.body).success)).toBe(true);
    expect(local.every((call) => call.body.amount === FIXTURE_AMOUNT_COP && call.body.donor.isRecurring === true)).toBe(true);
    expect(local[2].body.wompi.cardToken === TOKEN_SENTINEL).toBe(true);
    expect(local.slice(3).every((call) => !Object.hasOwn(call.body.wompi, "cardToken") && call.body.wompi.transactionId === TX_ID)).toBe(true);
    expect(deps.calls.every((call) => call.init.redirect === "error" && call.init.credentials === "omit" && call.init.signal instanceof AbortSignal)).toBe(true);
    expect(deps.calls.some((call) => call.init.method === "POST" && /\/transactions|\/payment_sources/.test(call.url))).toBe(false);
    expect(input.card.sandboxFixture).toBe(true);
    const printed = JSON.stringify(result);
    for (const value of [CHECKOUT_CAPABILITY, TOKEN_SENTINEL, SOURCE_SENTINEL, TX_ID, SUB_ID, ...Object.values(input).filter((value) => typeof value === "string")]) {
      expect(printed.includes(value)).toBe(false);
    }
  });

  it("sends only a JWE payload; legal consent is an independent guard, not plaintext card fields", async () => {
    const deps = transport();
    await runSandboxE2E(OPTIONS, runtime(), deps);
    const token = deps.calls.find((call) => call.url.endsWith("/tokens/cards"));
    expect(Object.keys(token.body)).toEqual(["payload"]);
    expect(token.body.payload === compactJwe()).toBe(true);
    expect(deps.jose.headers).toEqual([{ alg: "RSA-OAEP-256", enc: "A256GCM" }]);
    expect(deps.jose.importSPKI.mock.calls.length).toBe(1);
    expect(deps.jose.importSPKI.mock.calls[0][0] === PUBLIC_KEY_PEM.trim()).toBe(true);
    expect(deps.jose.importSPKI.mock.calls[0][1]).toBe("RSA-OAEP-256");
    expect(deps.jose.encrypt.mock.calls[0][0] === deps.jose.publicKey).toBe(true);
    expect(Object.keys(deps.jose.claims[0]).sort()).toEqual(["card_holder", "cvc", "exp_month", "exp_year", "number"]);
    const claims = deps.jose.claims[0];
    expect(["number", "cvc", "exp_month", "exp_year", "card_holder"].every((key) => claims[key] === runtime().card[key])).toBe(true);
    expect(token.init.body.includes(runtime().card.number)).toBe(false);
    expect(token.init.headers.Authorization === `Bearer ${runtime().publicKey}`).toBe(true);
    expect(deps.calls[0].init.headers["x-merchant-public-key"] === runtime().publicKey).toBe(true);
    const keyGet = deps.calls.find((call) => call.url.endsWith("/tokens/keys/tokenization"));
    expect(keyGet.url).toBe(`${WOMPI_SANDBOX_BASE}/tokens/keys/tokenization`);
    expect(keyGet.init.method).toBe("GET");
    expect(keyGet.init.headers.Authorization === `Bearer ${runtime().publicKey}`).toBe(true);
    expect(keyGet.init.redirect).toBe("error");
    expect(deps.calls.indexOf(keyGet) < deps.calls.findIndex((call) => call.body?.stage === "draft")).toBe(true);
    expect(deps.calls.find((call) => call.url.includes("/transactions/")).init.headers.Authorization === `Bearer ${runtime().privateKey}`).toBe(true);
    expect(deps.calls.find((call) => call.url.includes("/payment_sources/")).init.headers.Authorization === `Bearer ${runtime().privateKey}`).toBe(true);
  });

  it("matches the real checksum verifier and replays the exact same payload/header", async () => {
    const deps = transport();
    await runSandboxE2E(OPTIONS, runtime(), deps);
    const webhooks = deps.calls.filter((call) => call.url.endsWith("/api/wompi/webhook"));
    const replay = webhooks[1].body;
    expect(replay.environment).toBe("test");
    expect(computeWompiEventChecksum(replay, runtime().eventsSecret) === replay.signature.checksum).toBe(true);
    expect(webhooks[1].init.body === webhooks[2].init.body).toBe(true);
    expect(webhooks[1].init.headers["x-event-checksum"] === webhooks[2].init.headers["x-event-checksum"]).toBe(true);
    expect(isValidWompiEventChecksum(replay, webhooks[0].init.headers["x-event-checksum"], runtime().eventsSecret)).toBe(false);
    expect(Object.keys(replay.data.transaction).sort()).toEqual(["amount_in_cents", "currency", "finalized_at", "id", "reference", "status"]);
  });

  it("polls pending GETs only and handles a known transaction recovery", async () => {
    let gets = 0;
    const deps = transport((call, state) => {
      if (call.url.endsWith("/api/donations") && call.body.stage === "confirm" && state.confirmCount === 0) {
        // Keep transport's confirm counter accurate for later calls.
        if (!gets) return response(400, { code: "reconciliation_required", transactionId: TX_ID });
        return response(200, { status: "subscription_created", transactionId: TX_ID, subscriptionId: SUB_ID });
      }
      if (call.url.includes("/transactions/")) {
        gets += 1;
        return response(200, { data: transaction({ status: gets === 1 ? "PENDING" : "APPROVED" }) });
      }
    });
    const result = await runSandboxE2E(OPTIONS, runtime(), deps);
    expect(result.counts.statusGets).toBe(2);
    expect(result.counts.tokenizationPosts).toBe(1);
    expect(deps.sleep).toHaveBeenCalledExactlyOnceWith(100);
  });

  it.each([
    ["reference", "HPE-WRONG-REFERENCE"], ["amount_in_cents", 150001], ["currency", "USD"],
    ["id", "other-transaction"], ["customer_email", "other@donors.example.test"], ["payment_method_type", "NEQUI"],
  ])("fails closed on GET transaction %s mismatch", async (key, value) => {
    const deps = transport((call) => call.url.includes("/transactions/") ? response(200, { data: transaction({ [key]: value }) }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("sandbox_transaction_contract_mismatch");
    expect(deps.calls.some((call) => call.url.endsWith("/api/wompi/webhook"))).toBe(false);
  });

  it.each(["DECLINED", "ERROR", "VOIDED", "UNRECOGNIZED"])("does not report success on provider status %s", async (status) => {
    const deps = transport((call) => call.url.includes("/transactions/") ? response(200, { data: transaction({ status }) }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toBeInstanceOf(HarnessFailure);
    expect(deps.calls.filter((call) => call.body?.stage === "confirm")).toHaveLength(1);
  });

  it("pending timeout is failure, never fabricated approval or extra charge", async () => {
    const deps = transport((call) => call.url.includes("/transactions/") ? response(200, { data: transaction({ status: "PENDING" }) }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("sandbox_transaction_approved");
    expect(deps.calls.filter((call) => call.body?.stage === "confirm")).toHaveLength(1);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it("never guesses the approval date or signs an unverified transaction", async () => {
    const deps = transport((call) => call.url.includes("/transactions/") ? response(200, { data: transaction({ finalized_at: null }) }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("provider_finalization_timestamp_available");
    expect(() => signWebhookReplay(transaction({ status: "PENDING" }), runtime().eventsSecret, Math.floor(NOW / 1000))).toThrow("verified_transaction_required_for_webhook");
  });

  it.each(["queued", "review"])("does not equate webhook %s with applied reconciliation", async (result) => {
    const deps = transport((call) => call.url.endsWith("/api/wompi/webhook") && isValidWompiEventChecksum(call.body, call.init.headers["x-event-checksum"], runtime().eventsSecret)
      ? response(200, { transactionId: TX_ID, result }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("signed_local_webhook_replay_reconciled");
  });

  it("fails when duplicate webhook is applied again", async () => {
    const deps = transport((call) => call.url.endsWith("/api/wompi/webhook") && isValidWompiEventChecksum(call.body, call.init.headers["x-event-checksum"], runtime().eventsSecret)
      ? response(200, { transactionId: TX_ID, result: "processed" }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("identical_webhook_replay_duplicate");
  });

  it("rejects changed transaction or subscription on confirm retry", async () => {
    const deps = transport((call, state) => call.body?.stage === "confirm" && state.confirmCount === 2
      ? response(200, { status: "subscription_created", transactionId: "other-transaction", subscriptionId: "other-subscription" }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("idempotent_confirm_same_transaction_and_subscription");
  });

  it("rejects a production token, redirects and server signatures from another secret", async () => {
    for (const modify of [
      (call) => call.url.endsWith("/tokens/cards") ? response(201, { status: "CREATED", data: { id: "tok_prod_unit" } }) : undefined,
      () => response(200, {}, { redirected: true, url: "https://production.wompi.co/v1" }),
      (call) => call.body?.stage === "draft" ? response(200, { status: "draft_saved", checkout: {
        token: CHECKOUT_CAPABILITY, reference: REFERENCE, amountInCents: 150000, currency: "COP",
        expiresAt: new Date(NOW + 60000).toISOString(), signature: "unit-wrong-signature",
      } }) : undefined,
    ]) {
      const deps = transport(modify);
      await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toBeInstanceOf(HarnessFailure);
      expect(deps.calls.filter((call) => call.body?.stage === "confirm")).toHaveLength(0);
    }
  });

  it("never retries a dispatched confirm with no known transaction id", async () => {
    const deps = transport((call) => call.body?.stage === "confirm" ? response(400, { code: "reconciliation_required" }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("real_confirm_known_transaction");
    expect(deps.calls.filter((call) => call.body?.stage === "confirm")).toHaveLength(1);
  });

  it.each([
    { id: "other-source", type: "CARD", status: "AVAILABLE" },
    { id: SOURCE_SENTINEL, type: "NEQUI", status: "AVAILABLE" },
    { id: SOURCE_SENTINEL, type: "CARD", status: "UNAVAILABLE" },
  ])("requires a verified available card source, case %#", async (data) => {
    const deps = transport((call) => call.url.includes("/payment_sources/") ? response(200, { data }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("sandbox_source_available");
    expect(deps.calls.filter((call) => call.url.endsWith("/api/wompi/webhook")).length).toBe(0);
  });

  it("stops after an unauthorized source read without repeating the confirmed charge", async () => {
    const deps = transport(call => call.url.includes("/payment_sources/")
      ? response(401, { error: { type: "INVALID_ACCESS_TOKEN" } }) : undefined);
    const failure = await runSandboxE2E(OPTIONS, runtime(), deps).catch(error => error);
    expect(failure).toBeInstanceOf(HarnessFailure);
    expect(failure.report.assertions.failed).toEqual(["sandbox_source_available"]);
    expect(failure.report.assertions.passed).toContain("sandbox_transaction_approved");
    expect(failure.report.counts.confirmPosts).toBe(1);
    expect(failure.report.counts.webhookPosts).toBe(0);
    expect(deps.calls.filter(call => call.body?.stage === "confirm")).toHaveLength(1);
  });

  it("does not retry a timed-out confirm and never prints its exception", async () => {
    const sensitive = `private-sentinel ${TOKEN_SENTINEL} ${runtime().privateKey}`;
    const deps = transport((call) => {
      if (call.body?.stage === "confirm") throw new Error(sensitive);
    });
    const failure = await runSandboxE2E(OPTIONS, runtime(), deps).catch((error) => error);
    expect(failure instanceof HarnessFailure).toBe(true);
    expect(failure.report.assertions.failed).toEqual(["local_request_failed_no_write_retry"]);
    expect(failure.report.counts.confirmPosts).toBe(1);
    expect(failure.report.counts.tokenizationPosts).toBe(1);
    expect(JSON.stringify(failure.report).includes(sensitive)).toBe(false);
    expect(deps.calls.filter((call) => call.url.endsWith("/api/wompi/webhook")).length).toBe(0);
  });

  it("stops on missing independent personal authorization before any local write", async () => {
    const deps = transport((call) => call.url.endsWith("/merchants/info") ? response(200, {
      data: { presigned_acceptance: { acceptance_token: "unit-acceptance" } },
    }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("sandbox_merchant_acceptance_available");
    expect(deps.calls.length).toBe(1);
  });

  it("does not expose a rejected token API body that echoes card data", async () => {
    const deps = transport((call) => call.url.endsWith("/tokens/cards") ? response(422, {
      error: { messages: { number: runtime().card.number, cvc: runtime().card.cvc } },
    }) : undefined);
    const failure = await runSandboxE2E(OPTIONS, runtime(), deps).catch((error) => error);
    expect(failure.report.assertions.failed).toEqual(["sandbox_card_tokenized"]);
    expect(failure.report.counts.confirmPosts).toBe(0);
    expect(JSON.stringify(failure.report).includes(runtime().card.number)).toBe(false);
    expect(JSON.stringify(failure.report).includes("cvc")).toBe(false);
  });
});

describe("JWE key descriptor guards and fail-closed encryption, all offline mocks", () => {
  it.each(["junk", "second-key", "private-material"])("rejects trailing DER: %s", (suffix) => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const der = pair.publicKey.export({ type: "spki", format: "der" });
    const extra = suffix === "junk" ? Buffer.from("junk") : suffix === "second-key"
      ? der : pair.privateKey.export({ type: "pkcs8", format: "der" });
    const publicKey = `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([der, extra]).toString("base64")}\n-----END PUBLIC KEY-----`;
    expect(() => validateTokenizationKeyDescriptor({ data: { publicKey } })).toThrow("tokenization_public_key_spki_invalid");
  });

  it("accepts an SPKI RSA publicKeyPEM, including the official data.publicKey spelling", () => {
    for (const data of [
      { publicKey: PUBLIC_KEY_PEM },
      { publicKeyPEM: PUBLIC_KEY_PEM },
      { publicKey: PUBLIC_KEY_PEM, publicKeyPEM: PUBLIC_KEY_PEM.replace(/\n/g, "\\n") },
      { publicKey: PUBLIC_KEY_PEM.trim().replace(/\n/g, " ") },
      { publicKey: PUBLIC_KEY_PEM.trim().replace(/\n/g, "\t") },
      { publicKey: PUBLIC_KEY_PEM.replace(/\n/g, "\r\n") },
      { publicKey: PUBLIC_KEY_PEM, publicKeyPEM: PUBLIC_KEY_PEM.trim().replace(/\n/g, " ") },
    ]) {
      const descriptor = validateTokenizationKeyDescriptor({ data });
      expect(descriptor.publicKeyPEM === PUBLIC_KEY_PEM.trim()).toBe(true);
      expect(descriptor.modulusLength).toBe(2048);
      expect(descriptor.alg).toBe("RSA-OAEP-256");
      expect(descriptor.enc).toBe("A256GCM");
    }
  });

  it.each([
    {}, { data: {} }, { data: { publicKey: null } }, { data: { publicKey: { kty: "RSA" } } },
    { data: { publicKey: "https://production.wompi.co/key" } },
    { data: { publicKey: "https://sandbox.wompi.co/key" } },
    { data: { publicKey: "pub_test_fixture_only_not_an_encryption_key" } },
    { data: { publicKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" } },
    { data: { publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----" } },
    { data: { publicKey: PUBLIC_KEY_PEM.trim() + "\nextra" } },
    { data: { publicKey: "extra\n" + PUBLIC_KEY_PEM } },
    { data: { publicKey: PUBLIC_KEY_PEM.replace("MI", "M_") } },
    { data: { publicKey: PUBLIC_KEY_PEM + PUBLIC_KEY_PEM } },
    { data: { publicKey: PUBLIC_KEY_PEM, alg: "RSA-OAEP" } },
    { data: { publicKey: PUBLIC_KEY_PEM, enc: "A128GCM" } },
    { data: { publicKey: PUBLIC_KEY_PEM, publicKeyPEM: "different-pem" } },
    { data: { publicKey: "", publicKeyPEM: PUBLIC_KEY_PEM } },
  ])("rejects unsupported/ambiguous key descriptor before any write, case %#", async (body) => {
    const deps = transport((call) => call.url.endsWith("/tokens/keys/tokenization") ? response(200, body) : undefined);
    const failure = await runSandboxE2E(OPTIONS, runtime(), deps).catch((error) => error);
    expect(failure instanceof HarnessFailure).toBe(true);
    expect(failure.report.counts.localRequests).toBe(0);
    expect(failure.report.counts.tokenizationPosts).toBe(0);
    expect(deps.jose.importSPKI.mock.calls.length).toBe(0);
    expect(deps.calls.length).toBe(2);
  });

  it("rejects weak RSA and non-RSA public keys", () => {
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" });
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" });
    for (const publicKey of [weak, ec]) {
      expect(() => validateTokenizationKeyDescriptor({ data: { publicKey } })).toThrow("tokenization_public_key_rsa_strength_required");
    }
  });

  it.each([302, 401, 404, 500])("does not fall back to plaintext after key GET HTTP %s", async (status) => {
    const deps = transport((call) => call.url.endsWith("/tokens/keys/tokenization") ? response(status, {}) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("sandbox_tokenization_key_get_required");
    expect(deps.calls.filter((call) => call.init.method === "POST").length).toBe(0);
  });

  it("does not follow a tokenization key redirect, even to another Wompi origin", async () => {
    const deps = transport((call) => call.url.endsWith("/tokens/keys/tokenization")
      ? response(200, { data: { publicKey: PUBLIC_KEY_PEM } }, { redirected: true, url: "https://production.wompi.co/v1/tokens/keys/tokenization" }) : undefined);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("response_redirect_not_allowed");
    expect(deps.calls.filter((call) => call.init.method === "POST").length).toBe(0);
  });

  it("stops before HTTP if jose is missing, without printing module diagnostics", async () => {
    const deps = transport();
    deps.loadJose = async () => { throw new Error(`private-import-sentinel ${runtime().privateKey}`); };
    const failure = await runSandboxE2E(OPTIONS, runtime(), deps).catch((error) => error);
    expect(failure.report.assertions.failed).toEqual(["jose_dependency_required_before_network"]);
    expect(deps.fetchImpl.mock.calls.length).toBe(0);
    expect(JSON.stringify(failure.report).includes("private-import-sentinel")).toBe(false);
    await expect(loadJoseModule(async () => ({}))).rejects.toThrow("jose_encryption_api_required");
  });

  it.each(["import", "encrypt"])("never retries or sends plaintext when jose %s fails", async (stage) => {
    const deps = transport();
    const fail = async () => { throw new Error(`private-encryption-sentinel ${runtime().card.number}`); };
    if (stage === "import") deps.jose.importSPKI.mockImplementation(fail);
    else deps.jose.encrypt.mockImplementation(fail);
    const failure = await runSandboxE2E(OPTIONS, runtime(), deps).catch((error) => error);
    expect(failure.report.assertions.failed).toEqual(["jwe_encryption_failed_no_plaintext_fallback"]);
    expect(failure.report.counts.localRequests).toBe(0);
    expect(failure.report.counts.tokenizationPosts).toBe(0);
    expect(failure.report.counts.jweEncryptions).toBe(0);
    expect(deps.jose.importSPKI.mock.calls.length).toBe(1);
    expect(JSON.stringify(failure.report).includes("private-encryption-sentinel")).toBe(false);
  });

  it("rejects an imported private/secret key", async () => {
    const deps = transport();
    deps.jose.importSPKI.mockResolvedValue({ type: "private" });
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("jose_public_encryption_key_required");
    expect(deps.jose.encrypt.mock.calls.length).toBe(0);
    expect(deps.calls.filter((call) => call.init.method === "POST").length).toBe(0);
  });

  it.each([
    "not-encrypted", "a.b.c.d.e", JSON.stringify({ number: "4242".repeat(4) }),
    compactJwe({ alg: "RSA-OAEP", enc: "A256GCM" }),
    compactJwe({ alg: "RSA-OAEP-256", enc: "A128GCM" }),
    compactJwe({ alg: "RSA-OAEP-256", enc: "A256GCM", jku: "https://example.test/key" }),
  ])("rejects plaintext/malformed/downgraded encryption output, case %#", async (payload) => {
    const deps = transport();
    deps.jose.encrypt.mockResolvedValue(payload);
    await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toBeInstanceOf(HarnessFailure);
    expect(deps.calls.filter((call) => call.init.method === "POST").length).toBe(0);
  });

  it("rejects wrong JWE encrypted-key, IV and authentication-tag dimensions", async () => {
    for (const [index, bytes] of [[1, 32], [2, 8], [4, 8]]) {
      const parts = compactJwe().split(".");
      parts[index] = Buffer.alloc(bytes, 7).toString("base64url");
      const deps = transport();
      deps.jose.encrypt.mockResolvedValue(parts.join("."));
      await expect(runSandboxE2E(OPTIONS, runtime(), deps)).rejects.toThrow("encrypted_compact_jwe_required");
      expect(deps.calls.filter((call) => call.init.method === "POST").length).toBe(0);
    }
  });
});

describe("private stdin and sanitized assertions/counts-only CLI", () => {
  it("does not consume input or fetch without both explicit consents", async () => {
    const stream = { [Symbol.asyncIterator]: vi.fn(() => { throw new Error("must not consume"); }) };
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const write = vi.fn();
    expect(await main(["--run-sandbox=yes"], stream, write)).toBe(1);
    expect(stream[Symbol.asyncIterator]).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(Object.keys(JSON.parse(write.mock.calls[0][0]))).toEqual(["assertions", "counts"]);
  });

  it("rejects invalid/oversized/interactive stdin without including contents", async () => {
    await expect(readRuntimeInput(Readable.from(["private-sentinel-not-json"]))).rejects.toThrow("runtime_input_invalid_or_unavailable");
    await expect(readRuntimeInput(Readable.from(["x".repeat(16385)]))).rejects.toThrow("runtime_input_too_large");
    await expect(readRuntimeInput({ isTTY: true })).rejects.toThrow("runtime_input_must_use_private_stdin");
  });

  it("contains no provider body, sensitive exception, keys or stack in failed CLI output", async () => {
    const input = runtime();
    const fetchImpl = vi.fn(async () => { throw new Error(`private-sentinel ${input.privateKey} ${input.card.number}`); });
    vi.stubGlobal("fetch", fetchImpl);
    const output = [];
    expect(await main(ARGS, Readable.from([JSON.stringify(input)]), (value) => output.push(value), { loadJose: async () => joseMock() })).toBe(1);
    const printed = output.join("");
    const result = JSON.parse(printed);
    expect(Object.keys(result)).toEqual(["assertions", "counts"]);
    expect(result.assertions.failed).toEqual(["sandbox_request_failed_no_write_retry"]);
    for (const value of [input.privateKey, input.card.number, "private-sentinel", "stack", "Authorization"]) expect(printed.includes(value)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("successful CLI emits only assertions/counts, no logs or sensitive values", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const deps = transport();
    vi.stubGlobal("fetch", deps.fetchImpl);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const output = [];
    expect(await main(ARGS, Readable.from([JSON.stringify(runtime())]), (value) => output.push(value), deps)).toBe(0);
    expect(output.length).toBe(1);
    const printed = output[0];
    expect(Object.keys(JSON.parse(printed))).toEqual(["assertions", "counts"]);
    for (const value of [runtime().publicKey, runtime().privateKey, runtime().card.number, CHECKOUT_CAPABILITY, TOKEN_SENTINEL, SOURCE_SENTINEL, TX_ID, SUB_ID, PUBLIC_KEY_PEM, compactJwe()]) {
      expect(printed.includes(value)).toBe(false);
    }
    expect(log.mock.calls.length).toBe(0);
    expect(error.mock.calls.length).toBe(0);
  });
});
