import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminContext: vi.fn(),
  isAdminDemoMode: vi.fn(),
  isAdminSchemaReady: vi.fn(),
  isSameOriginRequest: vi.fn(),
  verifyRecentTotp: vi.fn(),
  getServiceSupabaseClient: vi.fn(),
  getWompiTransaction: vi.fn(),
  isWompiPaymentSourceAvailable: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminContext: mocks.getAdminContext,
  isAdminDemoMode: mocks.isAdminDemoMode,
  isAdminSchemaReady: mocks.isAdminSchemaReady,
  isSameOriginRequest: mocks.isSameOriginRequest,
  verifyRecentTotp: mocks.verifyRecentTotp,
}));
vi.mock("@/lib/supabase-server", () => ({
  getServiceSupabaseClient: mocks.getServiceSupabaseClient,
}));
vi.mock("@/lib/wompi-server", () => ({
  getWompiTransaction: mocks.getWompiTransaction,
  isWompiPaymentSourceAvailable: mocks.isWompiPaymentSourceAvailable,
}));

import { POST } from "./route";

const attemptId = "50000000-0000-0000-0000-000000000010";
const adminId = "10000000-0000-0000-0000-000000000001";
const subscriptionId = "20000000-0000-0000-0000-000000000011";

function historicalPayment(overrides: Record<string, unknown> = {}) {
  return { id: "40000000-0000-0000-0000-000000000010", payment_attempt_id: attemptId,
    subscription_id: subscriptionId, wompi_transaction_id: "tx-admin-recovery",
    reference: "HPE-ADMIN-RECOVERY-202609", amount: 10000, currency: "COP", ...overrides };
}

function request(overrides: Record<string, unknown> = {}) {
  return new Request(`https://app.example/api/admin/payment-attempts/${attemptId}/reconcile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example" },
    body: JSON.stringify({
      action: "reconcile",
      transactionId: "tx-admin-recovery",
      reason: "ID localizado y confirmado en Wompi",
      totpCode: "123456",
      requestId: "30000000-0000-0000-0000-000000000010",
      expectedVersion: 3,
      ...overrides,
    }),
  });
}

function serviceClient(attemptState = "unknown", existingTransactionId: string | null = null, confirmation: Record<string, unknown> = {
  result: "recovered", attemptId, transactionId: "tx-admin-recovery", providerStatus: "approved", state: "approved",
}, history: { payments?: Record<string, unknown>[] | null; error?: { message: string }; attemptAmount?: number;
  attemptNumber?: number | null; snapshot?: Record<string, unknown> | null } = {}) {
  const state = { attemptState, transactionId: existingTransactionId, version: 3,
    sourceId: "source-admin-recovery" as string | null, preferredDay: 6 };
  const attemptNumber = history.attemptNumber === undefined ? 1 : history.attemptNumber;
  const snapshot = history.snapshot === undefined ? { paymentSourceId: "source-admin-recovery", preferredPaymentDay: 6 } : history.snapshot;
  const committed = new Map<string, { fingerprint: string; response: Record<string, unknown> }>();
  const fingerprint = (args: Record<string, unknown>) => JSON.stringify([args.p_attempt_id, "payment_recovery",
    String(args.p_reason).trim(), args.p_transaction_id, args.p_expected_version]);
  const failure = (message: string) => ({ data: null, error: { message } });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (["consume_api_rate_limit", "billing_retry_schema_ready"].includes(name)) return { data: true, error: null };
    if (!["billing_v2_admin_recovery_replay", "billing_v2_admin_reconcile_payment_attempt"].includes(name)) {
      throw new Error(`Unexpected RPC ${name}`);
    }
    if (args.p_actor_user_id !== adminId || args.p_actor_aal !== "aal2" || !args.p_actor_session_issued_at || !args.p_totp_verified_at) {
      return failure("ADMIN_NOT_AUTHORIZED");
    }
    const key = `${args.p_actor_user_id}:${args.p_request_id}`;
    const previous = committed.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint(args)) return failure("ADMIN_REQUEST_ID_CONFLICT");
      return { data: name === "billing_v2_admin_recovery_replay"
        ? { result: "replay", response: previous.response } : previous.response, error: null };
    }
    if (name === "billing_v2_admin_recovery_replay") return { data: { result: "new" }, error: null };
    if (name === "billing_v2_admin_reconcile_payment_attempt") {
      if (args.p_expected_version !== state.version) return failure("SUBSCRIPTION_VERSION_CONFLICT");
      const linkedPayment = attemptNumber === null && history.payments?.length === 1 ? history.payments[0] : null;
      if (linkedPayment && (linkedPayment.payment_attempt_id !== attemptId || linkedPayment.subscription_id !== subscriptionId
        || linkedPayment.wompi_transaction_id !== args.p_transaction_id
        || (linkedPayment.reference !== null && linkedPayment.reference !== args.p_reference)
        || (linkedPayment.amount !== (history.attemptAmount ?? 24000) && linkedPayment.reference !== args.p_reference))) {
        return failure("PAYMENT_RECOVERY_INVALID_INPUT");
      }
      const amount = linkedPayment?.amount ?? history.attemptAmount ?? 24000;
      const currency = linkedPayment?.currency ?? "COP";
      if (args.p_amount !== amount || args.p_currency !== currency) return failure("PAYMENT_RECOVERY_INVALID_INPUT");
      const response: Record<string, unknown> = { needsReview: confirmation.result === "review", ...confirmation };
      committed.set(key, { fingerprint: fingerprint(args), response });
      state.attemptState = String(response.state);
      state.transactionId = String(response.transactionId);
      return { data: response, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const paymentQuery = {
    select: vi.fn(() => paymentQuery),
    or: vi.fn(() => paymentQuery),
    limit: vi.fn().mockResolvedValue({ data: history.payments === undefined ? [] : history.payments, error: history.error ?? null }),
  };
  const from = vi.fn((table: string) => {
    if (table === "payments") return paymentQuery;
    if (!["payment_attempts", "subscriptions"].includes(table)) throw new Error(`Unexpected table ${table}`);
    const query = {
      select: vi.fn(() => query),
      eq: () => query,
      maybeSingle: vi.fn(async () => table === "payment_attempts"
        ? {
            data: {
              id: attemptId,
              subscription_id: subscriptionId,
              reference: "HPE-ADMIN-RECOVERY-202609",
              amount: history.attemptAmount ?? 24000,
              currency: "COP",
              state: state.attemptState,
              wompi_transaction_id: state.transactionId,
              attempt_number: attemptNumber,
              dispatch_snapshot: snapshot,
            },
            error: null,
          }
        : {
            data: {
              id: subscriptionId,
              frequency: "monthly",
              wompi_payment_source_id: state.sourceId,
              preferred_payment_day: state.preferredDay,
            },
            error: null,
          }),
    };
    return query;
  });
  return { rpc, from, paymentQuery, state, committed };
}

describe("POST /api/admin/payment-attempts/[id]/reconcile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("APP_OPERATION_MODE", "active");
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "true");
    mocks.isAdminSchemaReady.mockResolvedValue(true);
    mocks.isSameOriginRequest.mockReturnValue(true);
    mocks.isAdminDemoMode.mockReturnValue(false);
    mocks.getAdminContext.mockResolvedValue({ userId: adminId, email: "admin@example.test", role: "admin", demo: false, aal: "aal2", sessionIssuedAt: "2026-10-01T00:00:00Z" });
    mocks.verifyRecentTotp.mockResolvedValue(true);
    mocks.isWompiPaymentSourceAvailable.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call in fixture"); }));
    mocks.getServiceSupabaseClient.mockReturnValue(serviceClient());
    mocks.getWompiTransaction.mockResolvedValue({
      id: "tx-admin-recovery",
      status: "approved",
      reference: "HPE-ADMIN-RECOVERY-202609",
      amountInCents: 2400000,
      currency: "COP",
      paymentSourceId: "source-admin-recovery",
      finalizedAt: "2026-09-20T17:00:00.000Z",
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("requires an authorized aal2 admin", async () => {
    mocks.getAdminContext.mockResolvedValue(null);

    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });

    expect(response.status).toBe(401);
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
  });

  it("rejects a transaction whose verified Wompi data does not match", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({
      id: "tx-admin-recovery",
      status: "approved",
      reference: "HPE-OTHER",
      amountInCents: 2400000,
      currency: "COP",
      paymentSourceId: "source-admin-recovery",
    });

    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });

    expect(response.status).toBe(409);
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });

  it("verifies Wompi and applies the recovery through the audited atomic RPC", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);

    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.recovery).toEqual(expect.objectContaining({ state: "approved", transactionId: "tx-admin-recovery" }));
    expect(mocks.getWompiTransaction).toHaveBeenCalledWith("tx-admin-recovery");
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({
      p_attempt_id: attemptId,
      p_actor_user_id: adminId,
      p_transaction_id: "tx-admin-recovery",
      p_reference: "HPE-ADMIN-RECOVERY-202609",
      p_amount: 24000,
      p_payment_source_id: "source-admin-recovery",
      p_expected_version: 3,
      p_actor_aal: "aal2",
      p_actor_session_issued_at: "2026-10-01T00:00:00Z",
      p_totp_verified_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      p_raw: expect.objectContaining({ verification_source: "provider_get", environment: "sandbox",
        id: "tx-admin-recovery", reference: "HPE-ADMIN-RECOVERY-202609", amount_in_cents: 2400000,
        currency: "COP", payment_source_id: "source-admin-recovery", status: "approved",
        finalized_at: "2026-09-20T17:00:00.000Z", status_message: null }),
    }));
    const call = client.rpc.mock.calls.find(([name]) => name === "billing_v2_admin_reconcile_payment_attempt")!;
    expect(Object.keys(call[1]).sort()).toEqual([
      "p_attempt_id", "p_actor_user_id", "p_reason", "p_request_id", "p_transaction_id", "p_reference",
      "p_payment_source_id", "p_amount", "p_currency", "p_status", "p_effective_at", "p_candidate_next_payment",
      "p_raw", "p_expected_version", "p_actor_aal", "p_actor_session_issued_at", "p_totp_verified_at",
    ].sort());
    expect(client.rpc).not.toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.anything());
  });
  it("uses a linked historical 10000 payment instead of the attempt's 20000 for verification and RPC", async () => {
    const client = serviceClient("approved", "tx-admin-recovery", { result: "review", attemptId,
      transactionId: "tx-admin-recovery", providerStatus: "approved", state: "approved", needsReview: true },
    { attemptNumber: null, attemptAmount: 20000, payments: [historicalPayment()] });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved", reference: "HPE-ADMIN-RECOVERY-202609",
      amountInCents: 1000000, currency: "COP", paymentSourceId: "source-admin-recovery", finalizedAt: "2026-09-20T17:00:00.000Z" });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovery: { result: "review", needsReview: true }, needsReview: true });
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({ p_amount: 10000, p_currency: "COP",
      p_attempt_id: attemptId, p_transaction_id: "tx-admin-recovery", p_expected_version: 3, p_actor_aal: "aal2" }));
    expect(mocks.verifyRecentTotp).toHaveBeenCalledWith("123456");
    expect(client.paymentQuery.or).toHaveBeenCalledWith(`wompi_transaction_id.eq.tx-admin-recovery,payment_attempt_id.eq.${attemptId}`);
    expect(client.paymentQuery.limit).toHaveBeenCalledWith(2);
    expect(client.rpc).toHaveBeenCalledWith("consume_api_rate_limit", expect.objectContaining({ p_scope: "admin_payment_recovery" }));
  });
  it.each([
    ["another attempt", { payment_attempt_id: "50000000-0000-0000-0000-000000000099" }],
    ["unbound attempt", { payment_attempt_id: null }],
    ["another subscription", { subscription_id: "20000000-0000-0000-0000-000000000099" }],
    ["unbound subscription", { subscription_id: null }],
    ["another transaction", { wompi_transaction_id: "tx-other-fixture" }],
    ["unbound transaction", { wompi_transaction_id: null }],
    ["another reference", { reference: "HPE-OTHER-FIXTURE" }],
    ["missing payment identity", { id: null }],
    ["another currency", { currency: "USD" }],
    ["unknown currency", { currency: null }],
    ["unknown amount", { amount: null }],
    ["boolean amount", { amount: true }],
    ["fractional amount", { amount: 10000.5 }],
    ["too small amount", { amount: 0 }],
    ["too large amount", { amount: 21474837 }],
    ["unparseable amount", { amount: "10000-fixture" }],
  ])("rejects historical %s without fallback to the attempt or a provider call", async (_label, overrides) => {
    const client = serviceClient("unknown", "tx-admin-recovery", undefined, { payments: [historicalPayment(overrides as Record<string, unknown>)] });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(409);
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });
  it("rejects multiple historical payments even if one matches both IDs", async () => {
    const client = serviceClient("unknown", "tx-admin-recovery", undefined, { payments: [historicalPayment(),
      historicalPayment({ id: "40000000-0000-0000-0000-000000000099", wompi_transaction_id: "tx-other-fixture", amount: 24000 })] });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(409);
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });
  it.each(["query error", "missing response"])("fails closed on historical %s, not using the attempt amount", async (failure) => {
    const client = serviceClient("unknown", "tx-admin-recovery", undefined, failure === "query error"
      ? { error: { message: "fixture unavailable" } } : { payments: null });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(503);
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });
  it.each([{ amountInCents: 2000000, currency: "COP" }, { amountInCents: 1000000, currency: "USD" }])("does not trust provider amounts/currency over a linked historical payment: %j", async (provider) => {
    const client = serviceClient("approved", "tx-admin-recovery", undefined, { attemptNumber: null, attemptAmount: 20000, payments: [historicalPayment()] });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved", reference: "HPE-ADMIN-RECOVERY-202609",
      ...provider, paymentSourceId: "source-admin-recovery", finalizedAt: "2026-09-20T17:00:00.000Z" });
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(409);
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });
  it("rejects UI-supplied money instead of allowing it to override server history", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request({ amount: 10000, currency: "COP" }), { params: Promise.resolve({ id: attemptId }) })).status).toBe(400);
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
  });
  it("uses the attempt's expected amount only when neither historical DB link exists", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(200);
    expect(client.from).toHaveBeenCalledWith("payments");
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({ p_amount: 24000, p_currency: "COP" }));
  });
  it("propagates SQL's historical revalidation conflict without claiming reconciliation", async () => {
    const client = serviceClient("approved", "tx-admin-recovery", undefined, { attemptNumber: null, attemptAmount: 20000, payments: [historicalPayment()] });
    const original = client.rpc.getMockImplementation()!;
    client.rpc.mockImplementation(async (name, args) => name === "billing_v2_admin_reconcile_payment_attempt"
      ? { data: null, error: { message: "PAYMENT_RECOVERY_MISMATCH" } } as never : original(name, args));
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved", reference: "HPE-ADMIN-RECOVERY-202609",
      amountInCents: 1000000, currency: "COP", paymentSourceId: "source-admin-recovery", finalizedAt: "2026-09-20T17:00:00.000Z" });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("recovery");
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({ p_amount: 10000, p_currency: "COP" }));
  });
  it.each(["CSRF", "rate limit", "TOTP"])("retains the %s guard before historical lookup", async (guard) => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    if (guard === "CSRF") mocks.isSameOriginRequest.mockReturnValue(false);
    if (guard === "rate limit") {
      const original = client.rpc.getMockImplementation()!;
      client.rpc.mockImplementation(async (name, args) => name === "consume_api_rate_limit"
        ? { data: false, error: null } as never : original(name, args));
    }
    if (guard === "TOTP") mocks.verifyRecentTotp.mockResolvedValue(false);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(guard === "rate limit" ? 429 : 403);
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });
  it.each(["unknown", "pending"])("sends a fresh verified approved result for a %s attempt with the same existing ID", async (state) => {
    const client = serviceClient(state, "tx-admin-recovery");
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(mocks.getWompiTransaction).toHaveBeenCalledWith("tx-admin-recovery");
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({ p_status: "approved", p_transaction_id: "tx-admin-recovery", p_effective_at: "2026-09-20T17:00:00.000Z" }));
    expect(await response.json()).toMatchObject({ recovery: { result: "recovered", state: "approved" } });
  });
  it("returns only the RPC-confirmed pending duplicate, not the fresh GET's approval", async () => {
    const confirmation = { result: "duplicate", attemptId, transactionId: "tx-admin-recovery", providerStatus: "pending", state: "pending", needsReview: false };
    const client = serviceClient("pending", "tx-admin-recovery", confirmation);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovery: confirmation });
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({ p_status: "approved" }));
  });
  it("does not fabricate approved for a verified pending transaction and pending RPC result", async () => {
    const confirmation = { result: "duplicate", attemptId, transactionId: "tx-admin-recovery", providerStatus: "pending", state: "pending", needsReview: false };
    const client = serviceClient("pending", "tx-admin-recovery", confirmation);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "pending", reference: "HPE-ADMIN-RECOVERY-202609", amountInCents: 2400000, currency: "COP", paymentSourceId: "source-admin-recovery", finalizedAt: null });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovery: confirmation });
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({ p_status: "pending", p_effective_at: null, p_candidate_next_payment: null }));
  });

  it("does not close an unidentified attempt on a checkbox attestation", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);

    const response = await POST(request({ action: "close", transactionId: undefined, noTransactionConfirmed: true }), {
      params: Promise.resolve({ id: attemptId }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).not.toHaveProperty("closure");
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("rejects closing an attempt without the explicit no-transaction attestation", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);

    const response = await POST(request({ action: "close", transactionId: undefined }), {
      params: Promise.resolve({ id: attemptId }),
    });

    expect(response.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalledWith("admin_close_unidentified_payment_attempt", expect.anything());
  });

  it("blocks disabled financial operations before any calls", async () => {
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "false");
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(503);
    expect(mocks.getAdminContext).not.toHaveBeenCalled();
    expect(mocks.getServiceSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
  });

  it("sends unknown approval dates to SQL review instead of inventing a timestamp", async () => {
    const client = serviceClient("unknown", null, { result: "review", attemptId,
      transactionId: "tx-admin-recovery", providerStatus: "approved", state: "approved", needsReview: true });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved", reference: "HPE-ADMIN-RECOVERY-202609", amountInCents: 2400000, currency: "COP", paymentSourceId: "source-admin-recovery", finalizedAt: null });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("needsReview", true);
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({ p_effective_at: null, p_candidate_next_payment: null, p_expected_version: 3, p_actor_aal: "aal2" }));
  });

  it.each(["recovered", "duplicate", "review"])("accepts the canonical recovery result %s", async (result) => {
    const client = serviceClient("unknown", null, { result, attemptId, transactionId: "tx-admin-recovery",
      providerStatus: "approved", state: "approved", needsReview: result === "review" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovery: { result }, needsReview: result === "review" });
  });

  it("rejects processingState needs_review when incorrectly returned as result", async () => {
    const client = serviceClient("unknown", null, { result: "needs_review", attemptId,
      transactionId: "tx-admin-recovery", providerStatus: "approved", state: "approved", needsReview: true });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("recovery");
  });

  it("passes the exact provider-verified decline message to v2 rather than treating every DECLINED as insufficient funds", async () => {
    const client = serviceClient("unknown", null, { result: "recovered", attemptId,
      transactionId: "tx-admin-recovery", providerStatus: "declined", state: "declined" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "declined",
      reference: "HPE-ADMIN-RECOVERY-202609", amountInCents: 2400000, currency: "COP",
      paymentSourceId: "source-admin-recovery", paymentMethodType: "CARD", finalizedAt: "2026-09-20T17:00:00Z",
      statusMessage: "Intente mas tarde - Fondos Insuficientes" });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({
      p_status: "declined", p_raw: expect.objectContaining({ verification_source: "provider_get", environment: "sandbox",
        status_message: "Intente mas tarde - Fondos Insuficientes", payment_method_type: "CARD",
        transaction: expect.objectContaining({ payment_source_id: "source-admin-recovery", verification_source: "provider_get",
          environment: "sandbox", status_message: "Intente mas tarde - Fondos Insuficientes", payment_method_type: "CARD" }) }),
    }));
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_authorize_send", expect.anything());
  });

  it.each([false, "error"])("blocks reconciliation without retry schema readiness %s and never calls legacy recovery", async (ready) => {
    const client = serviceClient();
    const original = client.rpc.getMockImplementation()!;
    client.rpc.mockImplementation(async (name, args) => name === "billing_retry_schema_ready"
      ? { data: ready === "error" ? null : false, error: ready === "error" ? { message: "fixture unavailable" } : null } as never
      : original(name, args));
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(503);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("billing_retry_schema_ready");
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.verifyRecentTotp).not.toHaveBeenCalled();
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
  });

  it("rejects a mismatched recurring source before invoking v2 result application", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved",
      reference: "HPE-ADMIN-RECOVERY-202609", amountInCents: 2400000, currency: "COP",
      paymentSourceId: "another-source", finalizedAt: "2026-09-20T17:00:00Z" });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(409);
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });
  it("returns a conflict rather than a server error for changed request content", async () => {
    const client = serviceClient();
    const base = client.rpc.getMockImplementation()!;
    client.rpc.mockImplementation(async (name, args) => name === "billing_v2_admin_reconcile_payment_attempt"
      ? { data: null, error: { message: "ADMIN_REQUEST_ID_CONFLICT" } } as never : base(name, args));
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(409);
  });

  it("rejects revocation after provider verification without applying the result", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getAdminContext.mockResolvedValueOnce({ userId: adminId, demo: false, aal: "aal2", sessionIssuedAt: "2026-10-01T00:00:00Z" })
      .mockResolvedValueOnce({ userId: adminId, demo: false, aal: "aal2", sessionIssuedAt: "2026-10-01T00:00:00Z" })
      .mockResolvedValueOnce(null);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(403);
    expect(mocks.getWompiTransaction).toHaveBeenCalledTimes(1);
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });

  it("passes only requested semantics and fresh server auth to replay before any SELECT or GET", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(200);
    const replayCall = client.rpc.mock.calls.find(([name]) => name === "billing_v2_admin_recovery_replay")!;
    expect(Object.keys(replayCall[1]).sort()).toEqual([
      "p_attempt_id", "p_actor_user_id", "p_reason", "p_request_id", "p_transaction_id", "p_expected_version",
      "p_actor_aal", "p_actor_session_issued_at", "p_totp_verified_at",
    ].sort());
    expect(replayCall[1]).toMatchObject({ p_attempt_id: attemptId, p_actor_user_id: adminId,
      p_expected_version: 3, p_actor_aal: "aal2", p_actor_session_issued_at: "2026-10-01T00:00:00Z" });
    const replayIndex = client.rpc.mock.calls.findIndex(([name]) => name === "billing_v2_admin_recovery_replay");
    expect(client.rpc.mock.invocationCallOrder[replayIndex]).toBeGreaterThan(mocks.verifyRecentTotp.mock.invocationCallOrder[0]);
    expect(client.rpc.mock.invocationCallOrder[replayIndex]).toBeLessThan(client.from.mock.invocationCallOrder[0]);
    expect(client.rpc.mock.invocationCallOrder[replayIndex]).toBeLessThan(mocks.getWompiTransaction.mock.invocationCallOrder[0]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "changed"])("replays the committed pending response with provider %s and changed state/source/version, without SELECT or GET", async (provider) => {
    const confirmation = { result: "recovered", attemptId, transactionId: "tx-admin-recovery",
      providerStatus: "pending", state: "pending", needsReview: false };
    const client = serviceClient("unknown", null, confirmation);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "pending", reference: "HPE-ADMIN-RECOVERY-202609",
      amountInCents: 2400000, currency: "COP", paymentSourceId: "source-admin-recovery", finalizedAt: null });
    const first = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(first.status).toBe(200);
    const body = await first.json();
    client.state.attemptState = "cancelled";
    client.state.transactionId = "another-transaction";
    client.state.version = 9;
    client.state.sourceId = null;
    client.state.preferredDay = 28;
    client.rpc.mockClear();
    client.from.mockClear().mockImplementation(() => { throw new Error("Replay must not SELECT"); });
    mocks.getWompiTransaction.mockClear();
    if (provider === "unavailable") mocks.getWompiTransaction.mockRejectedValue(new Error("Fixture provider unavailable"));
    else mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved", finalizedAt: null,
      reference: "another-reference", amountInCents: 1, currency: "USD", paymentSourceId: "another-source" });
    mocks.isWompiPaymentSourceAvailable.mockClear().mockRejectedValue(new Error("Replay must not GET source"));
    mocks.verifyRecentTotp.mockClear();
    const replay = await POST(request({ totpCode: "654321" }), { params: Promise.resolve({ id: attemptId }) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    expect(body).toEqual({ recovery: confirmation, needsReview: false });
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(mocks.isWompiPaymentSourceAvailable).not.toHaveBeenCalled();
    expect(mocks.verifyRecentTotp).toHaveBeenCalledWith("654321");
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "billing_retry_schema_ready", "consume_api_rate_limit", "billing_v2_admin_recovery_replay",
    ]);
    expect(client.committed.size).toBe(1);
    expect(client.state.version).toBe(9);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ reason: "Different requested instruction" }, { transactionId: "another-transaction" }, { expectedVersion: 4 }])(
    "conflicts on changed replay semantics %j before any SELECT or provider call", async (override) => {
      const client = serviceClient();
      mocks.getServiceSupabaseClient.mockReturnValue(client);
      expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(200);
      client.from.mockClear();
      mocks.getWompiTransaction.mockClear();
      client.rpc.mockClear();
      const response = await POST(request(override), { params: Promise.resolve({ id: attemptId }) });
      expect(response.status).toBe(409);
      expect(client.from).not.toHaveBeenCalled();
      expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
      expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
      expect(client.committed.size).toBe(1);
    }
  );

  it.each(["TOTP", "revocation", "rate limit"])("does not bypass %s to retrieve a committed replay", async (guard) => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(200);
    client.rpc.mockClear();
    client.from.mockClear();
    mocks.getWompiTransaction.mockClear();
    if (guard === "TOTP") mocks.verifyRecentTotp.mockResolvedValue(false);
    if (guard === "revocation") mocks.getAdminContext.mockResolvedValueOnce({ userId: adminId, demo: false,
      aal: "aal2", sessionIssuedAt: "2026-10-01T00:00:00Z" }).mockResolvedValueOnce(null);
    if (guard === "rate limit") {
      const base = client.rpc.getMockImplementation()!;
      client.rpc.mockImplementation(async (name, args) => name === "consume_api_rate_limit"
        ? { data: false, error: null } as never : base(name, args));
    }
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(guard === "rate limit" ? 429 : 403);
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_recovery_replay", expect.anything());
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["missing helper", { data: null, error: { message: "PGRST202 missing replay helper" } }, 503],
    ["unauthorized", { data: null, error: { message: "ADMIN_NOT_AUTHORIZED" } }, 403],
    ["invalid response", { data: { result: "unexpected" }, error: null }, 500],
    ["missing review flag", { data: { result: "replay", response: { result: "recovered", attemptId,
      transactionId: "tx-admin-recovery", providerStatus: "pending", state: "pending" } }, error: null }, 500],
    ["wrong attempt", { data: { result: "replay", response: { result: "recovered",
      attemptId: "50000000-0000-0000-0000-000000000099", transactionId: "tx-admin-recovery",
      providerStatus: "pending", state: "pending", needsReview: false } }, error: null }, 500],
  ])("fails closed on replay %s without fallback, SELECT or provider", async (_label, reply, status) => {
    const client = serviceClient();
    const base = client.rpc.getMockImplementation()!;
    client.rpc.mockImplementation(async (name, args) => name === "billing_v2_admin_recovery_replay" ? reply as never : base(name, args));
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty("recovery");
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
    expect(client.rpc).not.toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.anything());
  });

  it("verifies a new v2 result against its frozen source and day despite current subscription changes", async () => {
    const client = serviceClient();
    client.state.sourceId = null;
    client.state.preferredDay = 28;
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.objectContaining({
      p_payment_source_id: "source-admin-recovery", p_candidate_next_payment: "2026-10-06T12:00:00.000Z",
    }));
    expect(JSON.stringify(await response.json())).not.toContain("source-admin-recovery");
  });

  it.each([null, {}])("rejects a missing v2 frozen source %j without falling back to current source", async (snapshot) => {
    const client = serviceClient("unknown", null, undefined, { snapshot });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(409);
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });

  it("never replaces a v2 frozen amount with a differing linked historical amount", async () => {
    const client = serviceClient("approved", "tx-admin-recovery", undefined,
      { attemptNumber: 1, attemptAmount: 20000, payments: [historicalPayment()] });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(409);
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });

  it("rejects the legacy differing-amount exception when the linked ledger has no exact reference", async () => {
    const client = serviceClient("approved", "tx-admin-recovery", undefined,
      { attemptNumber: null, attemptAmount: 20000, payments: [historicalPayment({ reference: null })] });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(409);
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("billing_v2_admin_reconcile_payment_attempt", expect.anything());
  });

  it("preserves SQL needsReview even for duplicate results and strips private result fields", async () => {
    const client = serviceClient("pending", "tx-admin-recovery", { result: "duplicate", attemptId,
      transactionId: "tx-admin-recovery", providerStatus: "pending", state: "pending", needsReview: true,
      payment_source_id: "fixture-private-source", customerEmail: "fixture-private@example.test" });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ recovery: { result: "duplicate", providerStatus: "pending", needsReview: true }, needsReview: true });
    expect(JSON.stringify(body)).not.toContain("fixture-private");
  });
});
