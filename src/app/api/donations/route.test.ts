import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: Record<string, any> = {};
const mutations: Array<{ table: string; operation: string; payload: any }> = [];

function builder(table: string) {
  let operation = "select";
  let payload: any = null;
  let forcedError: { message: string; code?: string } | null = null;
  let forcedNoMatch = false;
  const updateFilters: Array<(row: any) => boolean> = [];
  const stateKey = table === "checkout_intents"
    ? "intent"
    : table === "payment_attempts"
      ? "attempt"
      : table === "subscriptions"
        ? "subscription"
        : table === "donors"
          ? "donor"
          : table === "payments"
            ? "payment"
            : null;
  const commitUpdate = () => {
    if (operation !== "update" || !stateKey || forcedError || forcedNoMatch) return false;
    const current = state[stateKey];
    if (!current || !updateFilters.every((matches) => matches(current))) return false;
    state[stateKey] = { ...current, ...payload };
    return true;
  };
  const api: any = {
    select: () => api,
    eq(column: string, value: unknown) {
      if (operation === "update") updateFilters.push((row) => row?.[column] === value);
      return api;
    },
    neq(column: string, value: unknown) {
      if (operation === "update") updateFilters.push((row) => row?.[column] !== value);
      return api;
    },
    is(column: string, value: unknown) {
      if (operation === "update") updateFilters.push((row) => (row?.[column] ?? null) === value);
      return api;
    },
    in(column: string, values: unknown[]) {
      if (operation === "update") updateFilters.push((row) => values.includes(row?.[column]));
      return api;
    },
    gt(column: string, value: any) {
      if (operation === "update") updateFilters.push((row) => row?.[column] > value);
      return api;
    },
    insert(value: any) {
      operation = "insert";
      payload = value;
      mutations.push({ table, operation, payload: value });
      if (table === "checkout_intents") state.intent = { id: "intent-1", ...value };
      if (table === "payment_attempts") state.attempt = { id: "attempt-1", ...value };
      if (table === "subscriptions") state.subscription = { id: "sub-1", billing_version: 0, ...value };
      if (table === "payments") state.payment = { id: "pay-1", ...value };
      return api;
    },
    update(value: any) {
      operation = "update";
      payload = value;
      mutations.push({ table, operation, payload: value });
      if (
        table === "payment_attempts"
        && value.state === "pending"
        && value.wompi_transaction_id
        && state.failTransactionSaveOnce
      ) {
        state.failTransactionSaveOnce = false;
        forcedError = { message: "database unavailable" };
      }
      if (table === "subscriptions" && value.wompi_payment_source_id) {
        if (state.failSourceSaveOnce) {
          state.failSourceSaveOnce = false;
          forcedError = { message: "source save unavailable" };
        }
        forcedNoMatch = Boolean(state.sourceSaveNoMatch);
      }
      if (table === "payment_attempts" && value.dispatched_at && !value.state) {
        if (state.failPreDispatchSaveOnce || state.preDispatchCommitThenError) {
          if (state.preDispatchCommitThenError) state.attempt = { ...state.attempt, ...value };
          state.failPreDispatchSaveOnce = false;
          forcedError = { message: "dispatch save unavailable" };
        }
        forcedNoMatch = Boolean(state.preDispatchNoMatch);
      }
      if (table === "payment_attempts" && value.state === "dispatching" && state.donorHasUnresolvedAttempt) {
        forcedError = { code: "23505", message: "donor already reserved" };
      }
      return api;
    },
    async maybeSingle() {
      if (operation === "update") {
        const updated = commitUpdate();
        return {
          data: updated ? { id: state[stateKey!]?.id } : null,
          error: forcedError,
        };
      }
      if (table === "donors") return { data: state.donor ?? null, error: null };
      if (table === "checkout_intents") return { data: state.intent ?? null, error: null };
      if (table === "payment_attempts") {
        return { data: state.attempt ?? null, error: null };
      }
      if (table === "subscriptions") return { data: state.subscription ?? null, error: null };
      if (table === "payments") return { data: state.payment ?? null, error: null };
      return { data: null, error: null };
    },
    async single() {
      if (table === "donors") return { data: state.donor ?? { id: "donor-1", email: "ana@example.com" }, error: null };
      if (table === "payment_attempts") return { data: state.attempt, error: null };
      if (table === "subscriptions") return { data: state.subscription, error: null };
      return { data: null, error: null };
    },
    then(resolve: (value: any) => void) {
      const updated = operation === "update" ? commitUpdate() : true;
      resolve({ data: forcedError || !updated ? null : payload, error: forcedError });
    },
  };
  return api;
}

async function rpc(name: string, payload: any) {
  if (name === "payment_admin_schema_ready") return { data: !state.schemaUnavailable, error: null };
  mutations.push({ table: "rpc", operation: name, payload });
  if (name === "consume_api_rate_limit") return { data: true, error: null };
  if (name !== "apply_verified_wompi_event") return { data: null, error: null };

  const transactionId = payload.p_transaction_id;
  const current = state.subscription ?? { id: "sub-1", status: "pending", processed_transaction_ids: [] };
  const processed = Array.isArray(current.processed_transaction_ids) ? current.processed_transaction_ids : [];
  const alreadyApplied = (state.appliedTransactions ?? []).includes(transactionId) || processed.includes(transactionId);
  if (!alreadyApplied) state.appliedTransactions = [...(state.appliedTransactions ?? []), transactionId];
  const candidate = payload.p_candidate_next_payment as string;
  const nextPaymentDate = payload.p_status === "approved" && !alreadyApplied
    ? !current.next_payment_date || new Date(candidate) > new Date(current.next_payment_date)
      ? candidate
      : current.next_payment_date
    : current.next_payment_date ?? null;
  const status = current.status === "cancelled"
    ? "cancelled"
    : payload.p_status === "approved" && payload.p_effective_at
      ? "active"
      : payload.p_status === "approved" ? current.status
      : payload.p_status === "pending"
        ? current.status === "active" ? "active" : "pending"
        : "past_due";
  state.subscription = {
    ...current,
    status,
    next_payment_date: nextPaymentDate,
    processed_transaction_ids: payload.p_status === "approved" && payload.p_effective_at && !alreadyApplied
      ? [...processed, transactionId]
      : processed,
  };
  state.payment = {
    id: state.payment?.id ?? "pay-1",
    subscription_id: state.subscription.id,
    status: payload.p_status,
    wompi_transaction_id: transactionId,
    approved_at: payload.p_status === "approved" ? payload.p_effective_at : null,
  };
  state.attempt = {
    ...state.attempt,
    state: payload.p_status === "approved" ? "approved" : payload.p_status === "pending" ? "pending" : payload.p_status === "declined" ? "declined" : "failed",
    wompi_transaction_id: transactionId,
    provider_status: payload.p_status,
  };
  state.intent = { ...state.intent, state: "completed" };
  return {
    data: {
      result: state.forceReview ? "review" : alreadyApplied ? "duplicate" : payload.p_status === "approved" && !payload.p_effective_at ? "review" : "processed",
      subscriptionId: state.subscription.id,
      transactionId,
    },
    error: null,
  };
}

vi.mock("@/lib/supabase-server", () => ({
  getServiceSupabaseClient: () => ({
    rpc,
    from: (table: string) => builder(table),
  }),
}));

vi.mock("@/lib/wompi-server", () => ({
  createWompiIntegritySignature: vi.fn(() => "server-signature"),
  createWompiPaymentSource: vi.fn(),
  createWompiTransaction: vi.fn(),
  getWompiAcceptance: vi.fn(),
  getWompiTransaction: vi.fn(),
}));

import { POST } from "./route";
import { createWompiPaymentSource, createWompiTransaction, getWompiAcceptance, getWompiTransaction } from "@/lib/wompi-server";

const donor = {
  firstName: "Ana",
  lastName: "Perez",
  email: "ana@example.com",
  phone: "3001234567",
  documentType: "CC",
  documentNumber: "123456",
  city: "Bogota",
  wantsUpdates: true,
  isRecurring: true,
  preferredPaymentDay: 16,
};

function request(body: unknown) {
  return new Request("https://example.test/api/donations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/donations hardened checkout", () => {
  beforeEach(() => {
    Object.keys(state).forEach((key) => delete state[key]);
    mutations.length = 0;
    vi.stubEnv("APP_OPERATION_MODE", "active");
    vi.stubEnv("FINANCIAL_OPERATIONS_ENABLED", "true");
    state.donor = { id: "donor-1", email: donor.email };
    process.env.CHECKOUT_TOKEN_PEPPER = "test-pepper-with-at-least-thirty-two-characters";
    vi.mocked(getWompiAcceptance).mockReset();
    vi.mocked(createWompiPaymentSource).mockReset();
    vi.mocked(createWompiTransaction).mockReset();
    vi.mocked(getWompiTransaction).mockReset();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("NETWORK_FORBIDDEN_IN_UNIT_TEST"); }));
  });

  afterEach(() => vi.unstubAllGlobals());

  function recurringConfirmation(cardToken: string | undefined = "tok_test_card") {
    state.intent = {
      id: "intent-1", donor_id: "donor-1", reference: "HPE-PRE-DISPATCH",
      amount: 10000, currency: "COP", is_recurring: true, preferred_payment_day: 16,
      environment: "sandbox", state: "checkout", expires_at: "2099-01-01T00:00:00.000Z",
    };
    vi.mocked(getWompiAcceptance).mockResolvedValue({
      acceptanceToken: "fresh-token", acceptPersonalAuth: "fresh-personal",
      acceptancePermalink: null, personalDataAuthPermalink: null,
    });
    vi.mocked(createWompiPaymentSource).mockResolvedValue({
      id: "src-server", type: "CARD", status: "AVAILABLE", maskedDetails: "VISA **** 4242",
    });
    vi.mocked(createWompiTransaction).mockResolvedValue({
      id: "tx-server", status: "pending", reference: state.intent.reference,
      amountInCents: 1000000, currency: "COP", paymentSourceId: "src-server",
    });
    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-server", status: "approved", reference: state.intent.reference,
      amountInCents: 1000000, currency: "COP", paymentSourceId: "src-server",
      finalizedAt: "2026-08-18T13:05:00.000Z",
    });
    return {
      stage: "confirm", donor, amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests", paymentMethod: "card",
      wompi: { reference: state.intent.reference, ...(cardToken ? { cardToken } : {}) },
    };
  }

  it.each([
    "MissingCardToken", "sourceAcceptance", "sourceCreation", "unavailableSource",
    "transactionAcceptance", "sourceSave", "sourceSaveNoMatch", "preDispatchSave",
    "preDispatchNoMatch", "preDispatchCommitThenError",
  ])("requires checkout restart without an uncertain charge after %s", async (failure) => {
    const body = recurringConfirmation(failure === "MissingCardToken" ? "" : "tok_test_card");
    if (failure === "sourceAcceptance") vi.mocked(getWompiAcceptance).mockRejectedValueOnce(new Error("ACCEPTANCE_FAILED"));
    if (failure === "sourceCreation") vi.mocked(createWompiPaymentSource).mockRejectedValueOnce(new Error("SOURCE_FAILED"));
    if (failure === "unavailableSource") vi.mocked(createWompiPaymentSource).mockResolvedValueOnce({
      id: "src-unavailable", type: "CARD", status: "ERROR", maskedDetails: null,
    });
    if (failure === "transactionAcceptance") {
      vi.mocked(getWompiAcceptance).mockResolvedValueOnce({
        acceptanceToken: "fresh-token", acceptPersonalAuth: "fresh-personal",
        acceptancePermalink: null, personalDataAuthPermalink: null,
      }).mockRejectedValueOnce(new Error("ACCEPTANCE_FAILED"));
    }
    if (failure === "sourceSave") state.failSourceSaveOnce = true;
    if (failure === "sourceSaveNoMatch") state.sourceSaveNoMatch = true;
    if (failure === "preDispatchSave") state.failPreDispatchSaveOnce = true;
    if (failure === "preDispatchNoMatch") state.preDispatchNoMatch = true;
    if (failure === "preDispatchCommitThenError") state.preDispatchCommitThenError = true;

    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "checkout_restart_required" });
    expect(createWompiTransaction).not.toHaveBeenCalled();
    expect(getWompiTransaction).not.toHaveBeenCalled();
    expect(state.attempt.state).toBe("failed");
    expect(state.attempt.dispatched_at ?? null).toBeNull();
    expect(state.attempt.wompi_transaction_id ?? null).toBeNull();
    expect(state.intent.state).toBe("failed");

    const replay = await POST(request(body));
    expect((await replay.json()).code).toBe("checkout_restart_required");
    expect(createWompiTransaction).not.toHaveBeenCalled();
  });

  it("reserves donor exclusion before source preparation but marks dispatch only immediately before POST", async () => {
    const body = recurringConfirmation();
    vi.mocked(createWompiPaymentSource).mockImplementationOnce(async () => {
      expect(state.attempt.state).toBe("dispatching");
      expect(state.attempt.dispatched_at ?? null).toBeNull();
      expect(createWompiTransaction).not.toHaveBeenCalled();
      return { id: "src-server", type: "CARD", status: "AVAILABLE", maskedDetails: null };
    });
    vi.mocked(createWompiTransaction).mockImplementationOnce(async () => {
      expect(state.attempt.state).toBe("dispatching");
      expect(Number.isNaN(Date.parse(state.attempt.dispatched_at))).toBe(false);
      expect(state.subscription.wompi_payment_source_id).toBe("src-server");
      expect(getWompiAcceptance).toHaveBeenCalledTimes(2);
      return { id: "tx-server", status: "pending", reference: body.wompi.reference,
        amountInCents: 1000000, currency: "COP", paymentSourceId: "src-server" };
    });
    expect((await POST(request(body))).status).toBe(200);
    expect(createWompiTransaction).toHaveBeenCalledOnce();
  });

  it("keeps a POST timeout unknown with a dispatch marker and never auto-charges its replay", async () => {
    const body = recurringConfirmation();
    vi.mocked(createWompiTransaction).mockRejectedValueOnce(new Error("POST_TIMEOUT"));
    const response = await POST(request(body));
    const json = await response.json();
    expect(json).toMatchObject({ code: "reconciliation_required" });
    expect(json).not.toHaveProperty("transactionId");
    expect(state.attempt.state).toBe("unknown");
    expect(Number.isNaN(Date.parse(state.attempt.dispatched_at))).toBe(false);
    expect(state.attempt.wompi_transaction_id ?? null).toBeNull();
    expect(state.intent.state).toBe("processing");
    expect((await POST(request(body))).status).toBe(202);
    expect(createWompiTransaction).toHaveBeenCalledOnce();
    expect(createWompiPaymentSource).toHaveBeenCalledOnce();
  });

  it("does not clear a concurrently persisted pending ID when the pre-POST claim no longer matches", async () => {
    const body = recurringConfirmation();
    vi.mocked(createWompiPaymentSource).mockImplementationOnce(async () => {
      state.attempt = { ...state.attempt, state: "pending", wompi_transaction_id: "tx-concurrent",
        dispatched_at: "2026-08-18T13:00:00.000Z" };
      return { id: "src-server", type: "CARD", status: "AVAILABLE", maskedDetails: null };
    });
    await POST(request(body));
    expect(createWompiTransaction).not.toHaveBeenCalled();
    expect(state.attempt).toMatchObject({ state: "pending", wompi_transaction_id: "tx-concurrent",
      dispatched_at: "2026-08-18T13:00:00.000Z" });
  });

  it("keeps donor exclusion while another recurring confirmation is preparing its source", async () => {
    const body = recurringConfirmation();
    let releaseSource!: () => void;
    const preparation = new Promise<void>((resolve) => { releaseSource = resolve; });
    vi.mocked(createWompiPaymentSource).mockImplementationOnce(async () => {
      await preparation;
      return { id: "src-server", type: "CARD", status: "AVAILABLE", maskedDetails: null };
    });
    const first = POST(request(body));
    await vi.waitFor(() => expect(createWompiPaymentSource).toHaveBeenCalledOnce());
    expect(state.attempt.state).toBe("dispatching");
    expect(state.attempt.dispatched_at ?? null).toBeNull();
    const second = await POST(request(body));
    expect(second.status).toBe(202);
    expect(state.attempt.state).toBe("dispatching");
    releaseSource();
    expect((await first).status).toBe(200);
    expect(createWompiTransaction).toHaveBeenCalledOnce();
    expect(createWompiPaymentSource).toHaveBeenCalledOnce();
  });

  it("does not prepare or send a charge when another attempt already excludes the donor", async () => {
    const body = recurringConfirmation();
    state.donorHasUnresolvedAttempt = true;
    const response = await POST(request(body));
    expect((await response.json()).code).toBe("reconciliation_required");
    expect(createWompiPaymentSource).not.toHaveBeenCalled();
    expect(createWompiTransaction).not.toHaveBeenCalled();
    expect(state.attempt.state).toBe("prepared");
  });

  it("keeps a one-time widget transaction uncertain when its verification GET times out", async () => {
    const body = recurringConfirmation();
    state.intent.is_recurring = false;
    state.intent.preferred_payment_day = null;
    vi.mocked(getWompiTransaction).mockRejectedValueOnce(new Error("GET_TIMEOUT"));
    const response = await POST(request({ ...body, donor: { ...donor, isRecurring: false },
      wompi: { reference: body.wompi.reference, transactionId: "tx-widget-sent" } }));
    expect((await response.json()).code).toBe("reconciliation_required");
    expect(state.attempt.state).toBe("unknown");
    expect(Number.isNaN(Date.parse(state.attempt.dispatched_at))).toBe(false);
    expect(state.attempt.wompi_transaction_id ?? null).toBeNull();
    expect(state.intent.state).toBe("processing");
    expect(createWompiPaymentSource).not.toHaveBeenCalled();
    expect(createWompiTransaction).not.toHaveBeenCalled();
  });

  it("blocks all writes and provider calls during cutover", async () => {
    vi.stubEnv("APP_OPERATION_MODE", "cutover");
    const response = await POST(request({ stage: "draft", donor, amount: 10000 }));
    expect(response.status).toBe(503);
    expect(mutations).toHaveLength(0);
    expect(getWompiAcceptance).not.toHaveBeenCalled();
  });

  it("does not write into an unmigrated database", async () => {
    state.schemaUnavailable = true;
    const response = await POST(request({ stage: "draft", donor, amount: 10000 }));
    expect(response.status).toBe(503);
    expect(mutations).toHaveLength(0);
  });

  it("creates the reference and signature on the server", async () => {
    vi.mocked(getWompiAcceptance).mockResolvedValue({
      acceptanceToken: "server-only-token",
      acceptPersonalAuth: "server-only-personal-token",
      acceptancePermalink: "https://wompi.test/terms",
      personalDataAuthPermalink: "https://wompi.test/privacy",
    });

    const response = await POST(request({ stage: "draft", donor, amount: 10000, paymentMethod: "card" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checkout.reference).toMatch(/^HPE-/);
    expect(json.checkout.signature).toBe("server-signature");
    expect(json.checkout).not.toHaveProperty("acceptanceToken");
    expect(mutations.find((item) => item.table === "checkout_intents")?.payload.amount).toBe(10000);
  });

  it("normalizes donor email before creating the record", async () => {
    delete state.donor;
    vi.mocked(getWompiAcceptance).mockResolvedValue({
      acceptanceToken: "server-only-token",
      acceptPersonalAuth: "server-only-personal-token",
      acceptancePermalink: "https://wompi.test/terms",
      personalDataAuthPermalink: "https://wompi.test/privacy",
    });

    const response = await POST(request({
      stage: "draft",
      donor: { ...donor, email: "Ana.Perez@Example.COM" },
      amount: 10000,
      paymentMethod: "card",
    }));

    expect(response.status).toBe(200);
    expect(mutations.find((item) => item.table === "donors")?.payload.email).toBe("ana.perez@example.com");
  });

  it("rejects confirmation without the server checkout capability", async () => {
    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      paymentMethod: "card",
      wompi: { reference: "HPE-FAKE", paymentSourceId: "src-fake", transactionId: "tx-fake" },
    }));

    expect(response.status).toBe(400);
    expect(createWompiPaymentSource).not.toHaveBeenCalled();
    expect(createWompiTransaction).not.toHaveBeenCalled();
  });

  it("reserves a one-time attempt before Wompi opens and rejects reopening the same checkout", async () => {
    const oneTimeDonor = { ...donor, isRecurring: false };
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-ONE-TIME-RESERVED",
      amount: 10000,
      currency: "COP",
      is_recurring: false,
      preferred_payment_day: null,
      environment: "sandbox",
      state: "draft",
      expires_at: "2099-01-01T00:00:00.000Z",
    };

    const checkoutBody = {
      stage: "checkout",
      donor: oneTimeDonor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-ONE-TIME-RESERVED" },
    };
    const firstCheckout = await POST(request(checkoutBody));
    const repeatedCheckout = await POST(request(checkoutBody));

    expect(firstCheckout.status).toBe(200);
    expect(repeatedCheckout.status).toBe(400);
    expect(mutations.filter(
      (item) => item.table === "payment_attempts" && item.operation === "insert"
    )).toHaveLength(1);
    expect(state.attempt).toEqual(expect.objectContaining({
      checkout_intent_id: "intent-1",
      subscription_id: "sub-1",
      state: "prepared",
      reference: "HPE-ONE-TIME-RESERVED",
    }));

    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-one-time-reserved",
      status: "approved",
      reference: "HPE-ONE-TIME-RESERVED",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: null,
      finalizedAt: "2026-09-20T15:00:00.000Z",
    });
    const confirmation = await POST(request({
      stage: "confirm",
      donor: oneTimeDonor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: {
        reference: "HPE-ONE-TIME-RESERVED",
        transactionId: "tx-one-time-reserved",
      },
    }));

    expect(confirmation.status).toBe(200);
    expect(createWompiPaymentSource).not.toHaveBeenCalled();
    expect(createWompiTransaction).not.toHaveBeenCalled();
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "approved",
      wompi_transaction_id: "tx-one-time-reserved",
    }));
  });

  it("ignores client source and transaction identifiers for a recurring card", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-SERVER",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "checkout",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    vi.mocked(getWompiAcceptance).mockResolvedValue({
      acceptanceToken: "fresh-token",
      acceptPersonalAuth: "fresh-personal",
      acceptancePermalink: null,
      personalDataAuthPermalink: null,
    });
    vi.mocked(createWompiPaymentSource).mockResolvedValue({ id: "src-server", type: "CARD", status: "AVAILABLE", maskedDetails: "VISA **** 4242" });
    vi.mocked(createWompiTransaction).mockResolvedValue({ id: "tx-server", status: "approved", reference: "HPE-SERVER", amountInCents: 1000000, currency: "COP", paymentSourceId: "src-server" });
    vi.mocked(getWompiTransaction).mockResolvedValue({ id: "tx-server", status: "approved", reference: "HPE-SERVER", amountInCents: 1000000, currency: "COP", paymentSourceId: "src-server", finalizedAt: "2026-08-01T13:35:44.000Z" });

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: {
        reference: "HPE-SERVER",
        cardToken: "tok_test_card",
        paymentSourceId: "src-client-fake",
        transactionId: "tx-client-fake",
      },
    }));

    expect(response.status).toBe(200);
    expect(createWompiPaymentSource).toHaveBeenCalledWith(expect.objectContaining({ token: "tok_test_card" }));
    expect(createWompiTransaction).toHaveBeenCalledWith(expect.objectContaining({ paymentSourceId: "src-server", reference: "HPE-SERVER" }));
    expect(mutations.find((item) => item.operation === "apply_verified_wompi_event")?.payload.p_transaction_id).toBe("tx-server");
    state.forceReview = true;
    const reviewed = await POST(request({
      stage: "confirm", donor, amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card", wompi: { reference: "HPE-SERVER", transactionId: "tx-server" },
    }));
    expect(reviewed.status).toBe(202);
    expect((await reviewed.json()).status).toBe("payment_pending");
  });

  it("reports a verified declined charge as final instead of leaving it pending", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-DECLINED",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "checkout",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    vi.mocked(getWompiAcceptance).mockResolvedValue({
      acceptanceToken: "fresh-token",
      acceptPersonalAuth: "fresh-personal",
      acceptancePermalink: null,
      personalDataAuthPermalink: null,
    });
    vi.mocked(createWompiPaymentSource).mockResolvedValue({
      id: "src-server",
      type: "CARD",
      status: "AVAILABLE",
      maskedDetails: "VISA **** 4242",
    });
    vi.mocked(createWompiTransaction).mockResolvedValue({
      id: "tx-declined",
      status: "pending",
      reference: "HPE-DECLINED",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: "src-server",
    });
    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-declined",
      status: "declined",
      reference: "HPE-DECLINED",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: "src-server",
      finalizedAt: "2026-08-18T13:05:00.000Z",
    });

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-DECLINED", cardToken: "tok_test_card" },
    }));
    const body = await response.json();

    expect(response.status).toBe(402);
    expect(body).toEqual(expect.objectContaining({ status: "payment_failed" }));
    expect(body.message).toMatch(/rechazado/i);
    expect(state.subscription.status).toBe("past_due");
    expect(mutations.find((item) => item.operation === "apply_verified_wompi_event")?.payload.p_status).toBe("declined");
  });

  it("rejects a terminal checkout that has no payment attempt", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-TERMINAL",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "completed",
      expires_at: "2099-01-01T00:00:00.000Z",
    };

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-TERMINAL", cardToken: "tok_test_card" },
    }));

    expect(response.status).toBe(400);
    expect(createWompiPaymentSource).not.toHaveBeenCalled();
    expect(createWompiTransaction).not.toHaveBeenCalled();
  });

  it("rejects a confirmation that changes the reserved payment method", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-METHOD",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      payment_method_type: "card",
      environment: "sandbox",
      state: "checkout",
      expires_at: "2099-01-01T00:00:00.000Z",
    };

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "nequi",
      wompi: { reference: "HPE-METHOD", transactionId: "tx-client-fake" },
    }));

    expect(response.status).toBe(400);
    expect(createWompiPaymentSource).not.toHaveBeenCalled();
    expect(createWompiTransaction).not.toHaveBeenCalled();
  });

  it("does not dispatch another charge while an attempt is already in progress", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-IN-PROGRESS",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "processing",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = { id: "attempt-1", subscription_id: "sub-1", state: "dispatching", wompi_transaction_id: null };

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-IN-PROGRESS", cardToken: "tok_test_card" },
    }));

    expect(response.status).toBe(202);
    expect(createWompiPaymentSource).not.toHaveBeenCalled();
    expect(createWompiTransaction).not.toHaveBeenCalled();
  });

  it("finishes local persistence when Wompi already has the transaction", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-RECOVER",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "processing",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = { id: "attempt-1", subscription_id: "sub-1", state: "pending", wompi_transaction_id: "tx-existing" };
    state.subscription = {
      id: "sub-1",
      status: "pending",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: "src-existing",
      wompi_masked_details: "VISA **** 4242",
    };
    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-existing",
      status: "approved",
      reference: "HPE-RECOVER",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: "src-existing",
      finalizedAt: "2026-08-01T13:35:44.000Z",
    });

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-RECOVER", cardToken: "tok_test_card" },
    }));

    expect(response.status).toBe(200);
    expect(createWompiTransaction).not.toHaveBeenCalled();
    expect(mutations.find((item) => item.operation === "apply_verified_wompi_event")?.payload.p_transaction_id).toBe("tx-existing");
    expect(state.subscription.status).toBe("active");
  });

  it("returns the Wompi transaction id when its first local persistence fails", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-PERSISTENCE-RECOVERY",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "checkout",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.failTransactionSaveOnce = true;
    vi.mocked(getWompiAcceptance).mockResolvedValue({
      acceptanceToken: "fresh-token",
      acceptPersonalAuth: "fresh-personal",
      acceptancePermalink: null,
      personalDataAuthPermalink: null,
    });
    vi.mocked(createWompiPaymentSource).mockResolvedValue({
      id: "src-persistence-recovery",
      type: "CARD",
      status: "AVAILABLE",
      maskedDetails: "VISA **** 4242",
    });
    vi.mocked(createWompiTransaction).mockResolvedValue({
      id: "tx-persistence-recovery",
      status: "pending",
      reference: "HPE-PERSISTENCE-RECOVERY",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: "src-persistence-recovery",
    });

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-PERSISTENCE-RECOVERY", cardToken: "tok_test_card" },
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual(expect.objectContaining({
      code: "reconciliation_required",
      transactionId: "tx-persistence-recovery",
    }));
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "unknown",
      wompi_transaction_id: "tx-persistence-recovery",
      provider_status: "pending",
    }));
    expect(getWompiTransaction).not.toHaveBeenCalled();
  });

  it("recovers a recurring transaction supplied by the same checkout after a local save failure", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-CLIENT-RECOVERY",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "processing",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = {
      id: "attempt-1",
      subscription_id: "sub-1",
      state: "unknown",
      wompi_transaction_id: null,
    };
    state.subscription = {
      id: "sub-1",
      status: "pending",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: "src-client-recovery",
      wompi_masked_details: "VISA **** 4242",
    };
    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-client-recovery",
      status: "approved",
      reference: "HPE-CLIENT-RECOVERY",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: "src-client-recovery",
      finalizedAt: "2026-09-20T14:00:00.000Z",
    });

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: {
        reference: "HPE-CLIENT-RECOVERY",
        cardToken: "tok_test_card",
        transactionId: "tx-client-recovery",
      },
    }));

    expect(response.status).toBe(200);
    expect(createWompiPaymentSource).not.toHaveBeenCalled();
    expect(createWompiTransaction).not.toHaveBeenCalled();
    expect(getWompiTransaction).toHaveBeenCalledWith("tx-client-recovery");
    expect(mutations.find((item) => item.operation === "apply_verified_wompi_event")?.payload.p_transaction_id).toBe(
      "tx-client-recovery"
    );
    expect(state.subscription.status).toBe("active");
  });

  it("never persists or accepts a recovery transaction from a different tokenized source", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-WRONG-SOURCE",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "processing",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = {
      id: "attempt-1",
      subscription_id: "sub-1",
      state: "dispatching",
      wompi_transaction_id: null,
    };
    state.subscription = {
      id: "sub-1",
      status: "pending",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: "src-expected",
      wompi_masked_details: "VISA **** 4242",
    };
    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-wrong-source",
      status: "approved",
      reference: "HPE-WRONG-SOURCE",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: "src-different",
      finalizedAt: "2026-09-20T14:00:00.000Z",
    });

    const recoveryRequest = () => request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: {
        reference: "HPE-WRONG-SOURCE",
        cardToken: "tok_test_card",
        transactionId: "tx-wrong-source",
      },
    });

    const first = await POST(recoveryRequest());
    const second = await POST(recoveryRequest());

    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "dispatching",
      wompi_transaction_id: null,
    }));
    expect(createWompiPaymentSource).not.toHaveBeenCalled();
    expect(createWompiTransaction).not.toHaveBeenCalled();
    expect(mutations.some((item) => item.operation === "apply_verified_wompi_event")).toBe(false);
  });

  it("rejects a previously stored transaction id when its tokenized source does not match", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-STORED-WRONG-SOURCE",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "processing",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = {
      id: "attempt-1",
      subscription_id: "sub-1",
      state: "pending",
      wompi_transaction_id: "tx-stored-wrong-source",
    };
    state.subscription = {
      id: "sub-1",
      status: "pending",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: "src-expected",
      wompi_masked_details: "VISA **** 4242",
    };
    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-stored-wrong-source",
      status: "approved",
      reference: "HPE-STORED-WRONG-SOURCE",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: "src-different",
    });

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-STORED-WRONG-SOURCE", cardToken: "tok_test_card" },
    }));

    expect(response.status).toBe(400);
    expect(mutations.some((item) => item.operation === "apply_verified_wompi_event")).toBe(false);
    expect(state.subscription.status).toBe("pending");
  });

  it("does not let a losing concurrent confirmation mutate the claimed one-time attempt", async () => {
    const oneTimeDonor = { ...donor, isRecurring: false };
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-CONCURRENT-ONE-TIME",
      amount: 10000,
      currency: "COP",
      is_recurring: false,
      preferred_payment_day: null,
      payment_method_type: "card",
      environment: "sandbox",
      state: "checkout",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = {
      id: "attempt-1",
      checkout_intent_id: "intent-1",
      subscription_id: "sub-1",
      state: "prepared",
      wompi_transaction_id: null,
    };
    state.subscription = {
      id: "sub-1",
      status: "pending",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: null,
    };

    let releaseTransaction!: (value: Awaited<ReturnType<typeof getWompiTransaction>>) => void;
    const transactionPromise = new Promise<Awaited<ReturnType<typeof getWompiTransaction>>>((resolve) => {
      releaseTransaction = resolve;
    });
    vi.mocked(getWompiTransaction).mockReturnValue(transactionPromise);
    const confirmationBody = {
      stage: "confirm",
      donor: oneTimeDonor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: {
        reference: "HPE-CONCURRENT-ONE-TIME",
        transactionId: "tx-concurrent-one-time",
      },
    };

    const firstRequest = POST(request(confirmationBody));
    const secondRequest = POST(request(confirmationBody));
    await vi.waitFor(() => expect(getWompiTransaction).toHaveBeenCalledTimes(1));
    expect(state.attempt.state).toBe("dispatching");

    releaseTransaction({
      id: "tx-concurrent-one-time",
      status: "approved",
      reference: "HPE-CONCURRENT-ONE-TIME",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: null,
      finalizedAt: "2026-09-20T15:00:00.000Z",
    });
    const responses = await Promise.all([firstRequest, secondRequest]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "approved",
      wompi_transaction_id: "tx-concurrent-one-time",
    }));
    expect(mutations.filter((item) => item.operation === "apply_verified_wompi_event")).toHaveLength(1);
  });

  it("does not persist an invalid one-time transaction id and later accepts the correct one", async () => {
    const oneTimeDonor = { ...donor, isRecurring: false };
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-ONE-TIME-VERIFY-FIRST",
      amount: 10000,
      currency: "COP",
      is_recurring: false,
      preferred_payment_day: null,
      payment_method_type: "card",
      environment: "sandbox",
      state: "checkout",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = {
      id: "attempt-1",
      checkout_intent_id: "intent-1",
      subscription_id: "sub-1",
      state: "prepared",
      wompi_transaction_id: null,
    };
    state.subscription = {
      id: "sub-1",
      status: "pending",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: null,
    };
    vi.mocked(getWompiTransaction)
      .mockResolvedValueOnce({
        id: "tx-invalid",
        status: "approved",
        reference: "HPE-DIFFERENT",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
      })
      .mockResolvedValueOnce({
        id: "tx-correct",
        status: "approved",
        reference: "HPE-ONE-TIME-VERIFY-FIRST",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
        finalizedAt: "2026-09-20T15:00:00.000Z",
      });

    const invalidResponse = await POST(request({
      stage: "confirm",
      donor: oneTimeDonor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-ONE-TIME-VERIFY-FIRST", transactionId: "tx-invalid" },
    }));
    const invalidBody = await invalidResponse.json();

    expect(invalidResponse.status).toBe(400);
    expect(invalidBody).not.toHaveProperty("transactionId");
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "unknown",
      wompi_transaction_id: null,
    }));

    const correctResponse = await POST(request({
      stage: "confirm",
      donor: oneTimeDonor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-ONE-TIME-VERIFY-FIRST", transactionId: "tx-correct" },
    }));

    expect(correctResponse.status).toBe(200);
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "approved",
      wompi_transaction_id: "tx-correct",
    }));
    expect(mutations.filter((item) => item.operation === "apply_verified_wompi_event")).toHaveLength(1);
  });

  it("does not downgrade an attempt when the webhook approves before the API saves the transaction", async () => {
    const oneTimeDonor = { ...donor, isRecurring: false };
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-WEBHOOK-WINS",
      amount: 10000,
      currency: "COP",
      is_recurring: false,
      preferred_payment_day: null,
      payment_method_type: "card",
      environment: "sandbox",
      state: "checkout",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = {
      id: "attempt-1",
      checkout_intent_id: "intent-1",
      subscription_id: "sub-1",
      state: "prepared",
      wompi_transaction_id: null,
    };
    state.subscription = {
      id: "sub-1",
      status: "pending",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: null,
    };
    const approvedTransaction = {
      id: "tx-webhook-wins",
      status: "approved",
      reference: "HPE-WEBHOOK-WINS",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: null,
      finalizedAt: "2026-09-20T15:00:00.000Z",
    };
    vi.mocked(getWompiTransaction)
      .mockImplementationOnce(async () => {
        state.attempt = {
          ...state.attempt,
          state: "approved",
          wompi_transaction_id: "tx-webhook-wins",
          provider_status: "approved",
        };
        state.subscription = { ...state.subscription, status: "active" };
        state.intent = { ...state.intent, state: "completed" };
        return approvedTransaction;
      })
      .mockResolvedValueOnce(approvedTransaction);

    const response = await POST(request({
      stage: "confirm",
      donor: oneTimeDonor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-WEBHOOK-WINS", transactionId: "tx-webhook-wins" },
    }));

    expect(response.status).toBe(200);
    expect(getWompiTransaction).toHaveBeenCalledTimes(2);
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "approved",
      wompi_transaction_id: "tx-webhook-wins",
    }));
    expect(state.subscription.status).toBe("active");
  });

  it("accepts a verified one-time retry only after the previous transaction was declined", async () => {
    const oneTimeDonor = { ...donor, isRecurring: false };
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-WIDGET-RETRY",
      amount: 10000,
      currency: "COP",
      is_recurring: false,
      preferred_payment_day: null,
      payment_method_type: "card",
      environment: "sandbox",
      state: "completed",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = {
      id: "attempt-1",
      checkout_intent_id: "intent-1",
      subscription_id: "sub-1",
      state: "declined",
      wompi_transaction_id: "tx-first-declined",
    };
    state.subscription = {
      id: "sub-1",
      status: "past_due",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: null,
    };
    vi.mocked(getWompiTransaction)
      .mockResolvedValueOnce({
        id: "tx-first-declined",
        status: "declined",
        reference: "HPE-WIDGET-RETRY",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
        finalizedAt: "2026-09-20T15:00:00.000Z",
      })
      .mockResolvedValueOnce({
        id: "tx-retry-approved",
        status: "approved",
        reference: "HPE-WIDGET-RETRY",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
        finalizedAt: "2026-09-20T15:01:00.000Z",
      });

    const response = await POST(request({
      stage: "confirm",
      donor: oneTimeDonor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-WIDGET-RETRY", transactionId: "tx-retry-approved" },
    }));

    expect(response.status).toBe(200);
    expect(getWompiTransaction).toHaveBeenNthCalledWith(1, "tx-first-declined");
    expect(getWompiTransaction).toHaveBeenNthCalledWith(2, "tx-retry-approved");
    expect(mutations.filter((item) => item.operation === "apply_verified_wompi_event").map(
      (item) => item.payload.p_transaction_id
    )).toEqual(["tx-first-declined", "tx-retry-approved"]);
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "approved",
      wompi_transaction_id: "tx-retry-approved",
    }));
    expect(state.subscription.status).toBe("active");
  });

  it("does not replace a browser retry id with the previous id when Wompi times out", async () => {
    const oneTimeDonor = { ...donor, isRecurring: false };
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-WIDGET-RETRY-TIMEOUT",
      amount: 10000,
      currency: "COP",
      is_recurring: false,
      preferred_payment_day: null,
      payment_method_type: "card",
      environment: "sandbox",
      state: "completed",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = {
      id: "attempt-1",
      checkout_intent_id: "intent-1",
      subscription_id: "sub-1",
      state: "declined",
      wompi_transaction_id: "tx-first-declined-timeout",
    };
    state.subscription = {
      id: "sub-1",
      status: "past_due",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: null,
    };
    vi.mocked(getWompiTransaction)
      .mockResolvedValueOnce({
        id: "tx-first-declined-timeout",
        status: "declined",
        reference: "HPE-WIDGET-RETRY-TIMEOUT",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: null,
        finalizedAt: "2026-09-20T15:00:00.000Z",
      })
      .mockRejectedValueOnce(new Error("WOMPI_TIMEOUT"));

    const response = await POST(request({
      stage: "confirm",
      donor: oneTimeDonor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-WIDGET-RETRY-TIMEOUT", transactionId: "tx-retry-timeout" },
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual(expect.objectContaining({ code: "reconciliation_required" }));
    expect(body).not.toHaveProperty("transactionId");
    expect(getWompiTransaction).toHaveBeenNthCalledWith(1, "tx-first-declined-timeout");
    expect(getWompiTransaction).toHaveBeenNthCalledWith(2, "tx-retry-timeout");
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "declined",
      wompi_transaction_id: "tx-first-declined-timeout",
    }));
  });

  it("ignores a new one-time transaction id while the previous transaction is pending", async () => {
    const oneTimeDonor = { ...donor, isRecurring: false };
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-WIDGET-PENDING",
      amount: 10000,
      currency: "COP",
      is_recurring: false,
      preferred_payment_day: null,
      payment_method_type: "card",
      environment: "sandbox",
      state: "processing",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    state.attempt = {
      id: "attempt-1",
      checkout_intent_id: "intent-1",
      subscription_id: "sub-1",
      state: "pending",
      wompi_transaction_id: "tx-first-pending",
    };
    state.subscription = {
      id: "sub-1",
      status: "pending",
      billing_version: 0,
      processed_transaction_ids: [],
      wompi_payment_source_id: null,
    };
    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-first-pending",
      status: "pending",
      reference: "HPE-WIDGET-PENDING",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: null,
    });

    const response = await POST(request({
      stage: "confirm",
      donor: oneTimeDonor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-WIDGET-PENDING", transactionId: "tx-untrusted-retry" },
    }));

    expect(response.status).toBe(202);
    expect(getWompiTransaction).toHaveBeenCalledTimes(1);
    expect(getWompiTransaction).toHaveBeenCalledWith("tx-first-pending");
    expect(state.attempt).toEqual(expect.objectContaining({
      state: "pending",
      wompi_transaction_id: "tx-first-pending",
    }));
    expect(mutations.filter((item) => item.operation === "apply_verified_wompi_event")).toHaveLength(1);
  });

  it("reconciles an expired checkout with a known transaction without overwriting a newer schedule", async () => {
    state.intent = {
      id: "intent-1",
      donor_id: "donor-1",
      reference: "HPE-EXPIRED-RECOVER",
      amount: 10000,
      currency: "COP",
      is_recurring: true,
      preferred_payment_day: 16,
      environment: "sandbox",
      state: "processing",
      expires_at: "2020-01-01T00:00:00.000Z",
    };
    state.attempt = { id: "attempt-1", subscription_id: "sub-1", state: "pending", wompi_transaction_id: "tx-known" };
    state.subscription = {
      id: "sub-1",
      amount: 20000,
      frequency: "monthly",
      status: "active",
      preferred_payment_day: 28,
      next_payment_date: "2099-12-28T12:00:00.000Z",
      billing_version: 3,
      processed_transaction_ids: [],
      wompi_payment_source_id: "src-existing",
      wompi_masked_details: "VISA **** 4242",
    };
    vi.mocked(getWompiTransaction).mockResolvedValue({
      id: "tx-known",
      status: "approved",
      reference: "HPE-EXPIRED-RECOVER",
      amountInCents: 1000000,
      currency: "COP",
      paymentSourceId: "src-existing",
      finalizedAt: "2026-08-18T13:05:00.000Z",
    });

    const response = await POST(request({
      stage: "confirm",
      donor,
      amount: 10000,
      checkoutToken: "checkout-token-that-is-long-enough-for-tests",
      paymentMethod: "card",
      wompi: { reference: "HPE-EXPIRED-RECOVER", cardToken: "tok_test_card" },
    }));

    expect(response.status).toBe(200);
    expect(createWompiTransaction).not.toHaveBeenCalled();
    expect(state.subscription).toEqual(expect.objectContaining({
      amount: 20000,
      preferred_payment_day: 28,
      next_payment_date: "2099-12-28T12:00:00.000Z",
      status: "active",
    }));
    expect(mutations.find((item) => item.operation === "apply_verified_wompi_event")?.payload.p_effective_at).toBe(
      "2026-08-18T13:05:00.000Z"
    );
  });

  it("does not move the schedule when the same approved transaction is confirmed again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-20T15:00:00.000Z"));

    try {
      state.intent = {
        id: "intent-1",
        donor_id: "donor-1",
        reference: "HPE-REPLAY",
        amount: 10000,
        currency: "COP",
        is_recurring: true,
        preferred_payment_day: 16,
        environment: "sandbox",
        state: "completed",
        expires_at: "2026-08-01T00:00:00.000Z",
      };
      state.attempt = { id: "attempt-1", subscription_id: "sub-1", state: "approved", wompi_transaction_id: "tx-replayed" };
      state.subscription = {
        id: "sub-1",
        amount: 10000,
        frequency: "monthly",
        status: "active",
        preferred_payment_day: 16,
        next_payment_date: "2026-11-16T12:00:00.000Z",
        billing_version: 4,
        processed_transaction_ids: ["tx-replayed"],
        wompi_payment_source_id: "src-existing",
        wompi_masked_details: "VISA **** 4242",
      };
      vi.mocked(getWompiTransaction).mockResolvedValue({
        id: "tx-replayed",
        status: "approved",
        reference: "HPE-REPLAY",
        amountInCents: 1000000,
        currency: "COP",
        paymentSourceId: "src-existing",
        finalizedAt: null,
      });

      const response = await POST(request({
        stage: "confirm",
        donor,
        amount: 10000,
        checkoutToken: "checkout-token-that-is-long-enough-for-tests",
        paymentMethod: "card",
        wompi: { reference: "HPE-REPLAY", cardToken: "tok_test_card" },
      }));

      expect(response.status).toBe(202);
      expect(createWompiTransaction).not.toHaveBeenCalled();
      expect(state.subscription.next_payment_date).toBe("2026-11-16T12:00:00.000Z");
      expect(state.subscription.processed_transaction_ids).toEqual(["tx-replayed"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
