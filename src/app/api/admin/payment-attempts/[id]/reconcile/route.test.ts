import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminContext: vi.fn(),
  isAdminDemoMode: vi.fn(),
  isAdminSchemaReady: vi.fn(),
  isSameOriginRequest: vi.fn(),
  verifyRecentTotp: vi.fn(),
  getServiceSupabaseClient: vi.fn(),
  getWompiTransaction: vi.fn(),
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

function serviceClient(attemptState = "unknown", existingTransactionId: string | null = null, confirmation = {
  result: "recovered", attemptId, transactionId: "tx-admin-recovery", providerStatus: "approved", state: "approved",
}, history: { payments?: Record<string, unknown>[] | null; error?: { message: string }; attemptAmount?: number } = {}) {
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === "consume_api_rate_limit") return { data: true, error: null };
    if (name === "admin_reconcile_payment_attempt") {
      return {
        data: confirmation,
        error: null,
      };
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
      select: () => query,
      eq: () => query,
      maybeSingle: vi.fn().mockResolvedValue(table === "payment_attempts"
        ? {
            data: {
              id: attemptId,
              subscription_id: subscriptionId,
              reference: "HPE-ADMIN-RECOVERY-202609",
              amount: history.attemptAmount ?? 24000,
              currency: "COP",
              state: attemptState,
              wompi_transaction_id: existingTransactionId,
            },
            error: null,
          }
        : {
            data: {
              id: subscriptionId,
              frequency: "monthly",
              wompi_payment_source_id: "source-admin-recovery",
              preferred_payment_day: 6,
            },
            error: null,
          }),
    };
    return query;
  });
  return { rpc, from, paymentQuery };
}

describe("POST /api/admin/payment-attempts/[id]/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_OPERATION_MODE", "active");
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "true");
    mocks.isAdminSchemaReady.mockResolvedValue(true);
    mocks.isSameOriginRequest.mockReturnValue(true);
    mocks.isAdminDemoMode.mockReturnValue(false);
    mocks.getAdminContext.mockResolvedValue({ userId: adminId, email: "admin@example.test", role: "admin", demo: false, aal: "aal2", sessionIssuedAt: "2026-10-01T00:00:00Z" });
    mocks.verifyRecentTotp.mockResolvedValue(true);
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
    expect(client.rpc).not.toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.anything());
  });

  it("verifies Wompi and applies the recovery through the audited atomic RPC", async () => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);

    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.recovery).toEqual(expect.objectContaining({ state: "approved", transactionId: "tx-admin-recovery" }));
    expect(mocks.getWompiTransaction).toHaveBeenCalledWith("tx-admin-recovery");
    expect(client.rpc).toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.objectContaining({
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
    }));
    const call = client.rpc.mock.calls.find(([name]) => name === "admin_reconcile_payment_attempt")!;
    expect(Object.keys(call[1]).sort()).toEqual([
      "p_attempt_id", "p_actor_user_id", "p_reason", "p_request_id", "p_transaction_id", "p_reference",
      "p_payment_source_id", "p_amount", "p_currency", "p_status", "p_effective_at", "p_candidate_next_payment",
      "p_raw", "p_expected_version", "p_actor_aal", "p_actor_session_issued_at", "p_totp_verified_at",
    ].sort());
  });
  it("uses a linked historical 10000 payment instead of the attempt's 20000 for verification and RPC", async () => {
    const client = serviceClient("approved", "tx-admin-recovery", undefined, { attemptAmount: 20000, payments: [historicalPayment()] });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved", reference: "HPE-ADMIN-RECOVERY-202609",
      amountInCents: 1000000, currency: "COP", paymentSourceId: "source-admin-recovery", finalizedAt: "2026-09-20T17:00:00.000Z" });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.objectContaining({ p_amount: 10000, p_currency: "COP",
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
    expect(client.rpc).not.toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.anything());
  });
  it("rejects multiple historical payments even if one matches both IDs", async () => {
    const client = serviceClient("unknown", "tx-admin-recovery", undefined, { payments: [historicalPayment(),
      historicalPayment({ id: "40000000-0000-0000-0000-000000000099", wompi_transaction_id: "tx-other-fixture", amount: 24000 })] });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(409);
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.anything());
  });
  it.each(["query error", "missing response"])("fails closed on historical %s, not using the attempt amount", async (failure) => {
    const client = serviceClient("unknown", "tx-admin-recovery", undefined, failure === "query error"
      ? { error: { message: "fixture unavailable" } } : { payments: null });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(503);
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.anything());
  });
  it.each([{ amountInCents: 2000000, currency: "COP" }, { amountInCents: 1000000, currency: "USD" }])("does not trust provider amounts/currency over a linked historical payment: %j", async (provider) => {
    const client = serviceClient("approved", "tx-admin-recovery", undefined, { attemptAmount: 20000, payments: [historicalPayment()] });
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved", reference: "HPE-ADMIN-RECOVERY-202609",
      ...provider, paymentSourceId: "source-admin-recovery", finalizedAt: "2026-09-20T17:00:00.000Z" });
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(409);
    expect(client.rpc).not.toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.anything());
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
    expect(client.rpc).toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.objectContaining({ p_amount: 24000, p_currency: "COP" }));
  });
  it("propagates SQL's historical revalidation conflict without claiming reconciliation", async () => {
    const client = serviceClient("approved", "tx-admin-recovery", undefined, { attemptAmount: 20000, payments: [historicalPayment()] });
    client.rpc.mockImplementation(async (name) => ({ data: name === "consume_api_rate_limit" ? true : null,
      error: name === "consume_api_rate_limit" ? null : { message: "PAYMENT_RECOVERY_MISMATCH" } }) as never);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved", reference: "HPE-ADMIN-RECOVERY-202609",
      amountInCents: 1000000, currency: "COP", paymentSourceId: "source-admin-recovery", finalizedAt: "2026-09-20T17:00:00.000Z" });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("recovery");
    expect(client.rpc).toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.objectContaining({ p_amount: 10000, p_currency: "COP" }));
  });
  it.each(["CSRF", "rate limit", "TOTP"])("retains the %s guard before historical lookup", async (guard) => {
    const client = serviceClient();
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    if (guard === "CSRF") mocks.isSameOriginRequest.mockReturnValue(false);
    if (guard === "rate limit") client.rpc.mockResolvedValue({ data: false, error: null });
    if (guard === "TOTP") mocks.verifyRecentTotp.mockResolvedValue(false);
    expect((await POST(request(), { params: Promise.resolve({ id: attemptId }) })).status).toBe(guard === "rate limit" ? 429 : 403);
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.getWompiTransaction).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.anything());
  });
  it.each(["unknown", "pending"])("sends a fresh verified approved result for a %s attempt with the same existing ID", async (state) => {
    const client = serviceClient(state, "tx-admin-recovery");
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(mocks.getWompiTransaction).toHaveBeenCalledWith("tx-admin-recovery");
    expect(client.rpc).toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.objectContaining({ p_status: "approved", p_transaction_id: "tx-admin-recovery", p_effective_at: "2026-09-20T17:00:00.000Z" }));
    expect(await response.json()).toMatchObject({ recovery: { result: "recovered", state: "approved" } });
  });
  it("returns only the RPC-confirmed pending duplicate, not the fresh GET's approval", async () => {
    const confirmation = { result: "duplicate", attemptId, transactionId: "tx-admin-recovery", providerStatus: "pending", state: "pending" };
    const client = serviceClient("pending", "tx-admin-recovery", confirmation);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovery: confirmation });
    expect(client.rpc).toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.objectContaining({ p_status: "approved" }));
  });
  it("does not fabricate approved for a verified pending transaction and pending RPC result", async () => {
    const confirmation = { result: "duplicate", attemptId, transactionId: "tx-admin-recovery", providerStatus: "pending", state: "pending" };
    const client = serviceClient("pending", "tx-admin-recovery", confirmation);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "pending", reference: "HPE-ADMIN-RECOVERY-202609", amountInCents: 2400000, currency: "COP", paymentSourceId: "source-admin-recovery", finalizedAt: null });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovery: confirmation });
    expect(client.rpc).toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.objectContaining({ p_status: "pending", p_effective_at: null, p_candidate_next_payment: null }));
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
    const client = serviceClient();
    client.rpc.mockImplementation(async (name) => name === "consume_api_rate_limit"
      ? { data: true, error: null } as never
      : { data: { result: "review", attemptId, transactionId: "tx-admin-recovery", providerStatus: "approved", state: "approved" }, error: null } as never);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    mocks.getWompiTransaction.mockResolvedValue({ id: "tx-admin-recovery", status: "approved", reference: "HPE-ADMIN-RECOVERY-202609", amountInCents: 2400000, currency: "COP", paymentSourceId: "source-admin-recovery", finalizedAt: null });
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("needsReview", true);
    expect(client.rpc).toHaveBeenCalledWith("admin_reconcile_payment_attempt", expect.objectContaining({ p_effective_at: null, p_candidate_next_payment: null, p_expected_version: 3, p_actor_aal: "aal2" }));
  });

  it.each(["recovered", "duplicate", "review"])("accepts the canonical recovery result %s", async (result) => {
    const client = serviceClient();
    client.rpc.mockImplementation(async (name) => name === "consume_api_rate_limit"
      ? { data: true, error: null } as never
      : { data: { result, attemptId, transactionId: "tx-admin-recovery", providerStatus: "approved", state: "approved" }, error: null } as never);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovery: { result }, needsReview: result === "review" });
  });

  it("rejects processingState needs_review when incorrectly returned as result", async () => {
    const client = serviceClient();
    client.rpc.mockImplementation(async (name) => name === "consume_api_rate_limit"
      ? { data: true, error: null } as never
      : { data: { result: "needs_review", attemptId, transactionId: "tx-admin-recovery", providerStatus: "approved", state: "approved" }, error: null } as never);
    mocks.getServiceSupabaseClient.mockReturnValue(client);
    const response = await POST(request(), { params: Promise.resolve({ id: attemptId }) });
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("recovery");
  });
});
