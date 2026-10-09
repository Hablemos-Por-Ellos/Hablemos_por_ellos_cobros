import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ context: vi.fn(), demo: vi.fn(), ready: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/admin-auth", () => ({ getAdminContext: mocks.context, isAdminDemoMode: mocks.demo, isAdminSchemaReady: mocks.ready }));
vi.mock("@/lib/supabase-auth-server", () => ({ getServerAuthSupabaseClient: mocks.client }));
import { loadAdminData } from "./admin-data";

type Row = Record<string, unknown>;
function readClient(rows: Record<string, unknown[]>, pageError?: { table: string; start: number }) {
  const forbiddenWrite = () => { throw new Error("Unexpected write in admin read-only fixture"); };
  const mutations = {
    insert: vi.fn(forbiddenWrite), update: vi.fn(forbiddenWrite),
    upsert: vi.fn(forbiddenWrite), delete: vi.fn(forbiddenWrite), rpc: vi.fn(forbiddenWrite),
  };
  const from = vi.fn((table: string) => {
    if (!(table in rows)) throw new Error(`Unexpected table ${table}`);
    const predicates: ((row: Row) => boolean)[] = [];
    let bounds: [number, number] | null = null;
    const result = () => bounds && pageError?.table === table && pageError.start === bounds[0]
      ? { data: null, error: { message: "fixture page unavailable" } }
      : { data: (rows[table] as Row[]).filter((row) => predicates.every((predicate) => predicate(row)))
        .slice(bounds?.[0] ?? 0, bounds ? bounds[1] + 1 : undefined), error: null };
    const query = {
      select: vi.fn<(columns: string) => unknown>(), order: vi.fn(),
      eq: vi.fn(), is: vi.fn(), lt: vi.fn(), in: vi.fn(), limit: vi.fn(), range: vi.fn(),
      ...mutations, then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    };
    for (const method of ["select", "order", "limit"] as const) {
      query[method].mockReturnValue(query);
    }
    query.eq.mockImplementation((key: string, value: unknown) => { predicates.push((row) => row[key] === value); return query; });
    query.is.mockImplementation((key: string, value: unknown) => { predicates.push((row) => row[key] === value); return query; });
    query.lt.mockImplementation((key: string, value: string) => { predicates.push((row) => typeof row[key] === "string" && String(row[key]) < value); return query; });
    query.in.mockImplementation((key: string, values: unknown[]) => { predicates.push((row) => values.includes(row[key])); return query; });
    query.range.mockImplementation((start: number, end: number) => { bounds = [start, end]; return query; });
    return query;
  });
  return { from, ...mutations };
}

function mixedRows(): Record<string, unknown[]> {
  return {
    donors: [
      { id: "donor-fixture", first_name: "Fixture", last_name: "Only", email: "recipient@example.test", phone: "573000000000", city: "Bogota", created_at: "2026-10-01T00:00:00Z", document_type: "fixture-document-type", document_number: "fixture-document-number" },
      { id: "donor-unique", first_name: "Unique", last_name: "Fixture", email: "unique@example.test", phone: "573001234567", city: "Medellin", created_at: "2026-10-02T00:00:00Z" },
    ],
    subscriptions: [
      { id: "sub-fixture", donor_id: "donor-fixture", amount: "1500", frequency: "monthly", status: "pending", payment_method_type: "card", preferred_payment_day: 6, billing_version: 3, wompi_payment_source_id: "fixture-private-source", wompi_masked_details: "fixture-private-mask" },
      { id: "sub-unique-card", donor_id: "donor-unique", amount: "9000", frequency: "one_time", status: "active", payment_method_type: "card", preferred_payment_day: null, billing_version: 0 },
      { id: "sub-unique-nequi", donor_id: "donor-fixture", amount: 25000, frequency: "one_time", status: "cancelled", payment_method_type: "nequi", preferred_payment_day: 16, billing_version: 1 },
    ],
    payments: [
      { id: "payment-unique-card", subscription_id: "sub-unique-card", amount: "9000", status: "approved", approved_at: "2026-10-02T12:00:00Z", created_at: "2026-10-02T11:00:00Z" },
      { id: "payment-fixture", subscription_id: "sub-fixture", amount: "1500", status: "approved", approved_at: null, created_at: "2026-10-01T00:00:00Z" },
      { id: "payment-unique-nequi", subscription_id: "sub-unique-nequi", amount: 25000, status: "approved", approved_at: null, created_at: "2026-10-03T00:00:00Z" },
    ],
    payment_attempts: [],
    admin_audit_logs: [],
    billing_cycles: [],
  };
}

describe("admin read-only projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.demo.mockReturnValue(false);
    mocks.ready.mockResolvedValue(true);
    mocks.context.mockResolvedValue({ demo: false });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call in admin read-only fixture"); }));
  });
  afterEach(() => vi.unstubAllGlobals());
  it("rejects AAL1/revoked reads before querying business tables", async () => {
    mocks.context.mockResolvedValue(null);
    await expect(loadAdminData()).rejects.toThrow();
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("does not use a database client for demo fixtures", async () => {
    mocks.demo.mockReturnValue(true);
    expect((await loadAdminData()).donors.length).toBeGreaterThan(0);
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("never reveals detail contacts, documents, or sources, and treats unknown approval dates as review", async () => {
    const client = readClient(mixedRows());
    mocks.client.mockResolvedValue(client);
    const data = await loadAdminData("donor-fixture");
    expect(data.donors).toEqual([
      expect.objectContaining({ id: "donor-fixture", contactMasked: true, email: "re*******@example.test", phone: "********0000" }),
      expect.objectContaining({ id: "donor-unique", contactMasked: true, email: "un****@example.test", phone: "********4567" }),
    ]);
    expect(data.payments.find((payment) => payment.id === "payment-fixture")?.status).toBe("review");
    expect(data.payments.find((payment) => payment.id === "payment-unique-nequi")?.status).toBe("review");
    const selections = client.from.mock.results.flatMap(({ value }) => value.select.mock.calls.map(([columns]: [string]) => columns));
    expect(selections.join(" ")).not.toMatch(/source|masked_details|document|\*/i);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/source|masked_details|document/i);
    for (const rawValue of ["recipient@example.test", "unique@example.test", "573000000000", "573001234567", "fixture-private-source", "fixture-private-mask", "fixture-document-type", "fixture-document-number"]) {
      expect(serialized).not.toContain(rawValue);
    }
  });
  it("selects both contribution frequencies with in, never the monthly-only eq filter", async () => {
    const client = readClient(mixedRows());
    mocks.client.mockResolvedValue(client);

    await loadAdminData();

    const subscriptionQueries = client.from.mock.calls.flatMap(([table], index) => table === "subscriptions" ? [client.from.mock.results[index].value] : []);
    expect(subscriptionQueries).toHaveLength(1);
    expect(subscriptionQueries[0].in).toHaveBeenCalledExactlyOnceWith("frequency", ["monthly", "one_time"]);
    expect(subscriptionQueries[0].eq).not.toHaveBeenCalledWith("frequency", "monthly");
    expect(subscriptionQueries[0].eq).not.toHaveBeenCalled();
    expect(subscriptionQueries[0].select).toHaveBeenCalledWith(expect.stringContaining("frequency"));
  });
  it.each([undefined, "donor-fixture"])("preserves mixed frequencies, donor/payment associations and payment methods for detail %s", async (donorId) => {
    const client = readClient(mixedRows());
    mocks.client.mockResolvedValue(client);

    const data = await loadAdminData(donorId);

    expect(data.subscriptions).toEqual([
      expect.objectContaining({ id: "sub-fixture", donorId: "donor-fixture", frequency: "monthly", amount: 1500, status: "pending", paymentMethod: "Tarjeta tokenizada", preferredPaymentDay: 6, billingVersion: 3 }),
      expect.objectContaining({ id: "sub-unique-card", donorId: "donor-unique", frequency: "one_time", amount: 9000, status: "active", paymentMethod: "Tarjeta", preferredPaymentDay: null, billingVersion: 0 }),
      expect.objectContaining({ id: "sub-unique-nequi", donorId: "donor-fixture", frequency: "one_time", amount: 25000, status: "cancelled", paymentMethod: "Nequi", preferredPaymentDay: null, billingVersion: 1 }),
    ]);
    expect(data.payments).toEqual([
      expect.objectContaining({ id: "payment-unique-card", subscriptionId: "sub-unique-card", amount: 9000, status: "approved", createdAt: "2026-10-02T12:00:00Z" }),
      expect.objectContaining({ id: "payment-fixture", subscriptionId: "sub-fixture", amount: 1500, status: "review" }),
      expect.objectContaining({ id: "payment-unique-nequi", subscriptionId: "sub-unique-nequi", amount: 25000, status: "review" }),
    ]);
    expect(data.payments.map((payment) => {
      const subscription = data.subscriptions.find((item) => item.id === payment.subscriptionId);
      return [payment.id, subscription?.frequency, subscription?.donorId];
    })).toEqual([
      ["payment-unique-card", "one_time", "donor-unique"],
      ["payment-fixture", "monthly", "donor-fixture"],
      ["payment-unique-nequi", "one_time", "donor-fixture"],
    ]);
    if (donorId) {
      const auditQuery = client.from.mock.results[client.from.mock.calls.findIndex(([table]) => table === "admin_audit_logs")].value;
      expect(auditQuery.in).toHaveBeenCalledExactlyOnceWith("subscription_id", ["sub-fixture", "sub-unique-nequi"]);
    }
  });
  it.each([null, 1, 6, 16, 28])("keeps one-time payment day null even when the stored day is %s", async (preferredPaymentDay) => {
    const rows = mixedRows();
    rows.subscriptions = [{ id: "sub-unique", donor_id: "donor-fixture", amount: 1500, frequency: "one_time", status: "active", preferred_payment_day: preferredPaymentDay }];
    mocks.client.mockResolvedValue(readClient(rows));

    const data = await loadAdminData();

    expect(data.subscriptions).toHaveLength(1);
    expect(data.subscriptions[0].frequency).toBe("one_time");
    expect(data.subscriptions[0].preferredPaymentDay).toBeNull();
  });
  it("uses only SELECT queries on the existing administrative tables, without writes or network", async () => {
    const client = readClient(mixedRows());
    mocks.client.mockResolvedValue(client);

    await loadAdminData();

    expect(client.from.mock.calls.map(([table]) => table)).toEqual([
      "donors", "subscriptions", "payments", "payment_attempts", "payment_attempts", "admin_audit_logs",
      "billing_cycles", "payment_attempts",
    ]);
    for (const { value: query } of client.from.mock.results) {
      expect(query.select).toHaveBeenCalledTimes(1);
      expect(query.range).toHaveBeenCalledWith(0, 99);
      expect(query.order).toHaveBeenCalledWith("id", { ascending: true });
      expect(query.limit).not.toHaveBeenCalled();
    }
    for (const method of ["insert", "update", "upsert", "delete", "rpc"] as const) {
      expect(client[method]).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 0, 2, 15, 31, "unknown"])("never invents day 16 for a monthly stored day %s", async (preferredPaymentDay) => {
    const rows = mixedRows();
    rows.subscriptions = [{ id: "sub-fixture", donor_id: "donor-fixture", amount: 1500,
      frequency: "monthly", status: "active", preferred_payment_day: preferredPaymentDay }];
    mocks.client.mockResolvedValue(readClient(rows));
    expect((await loadAdminData()).subscriptions[0].preferredPaymentDay).toBeNull();
  });

  it("projects only safe retry labels and subscription holds, never raw evidence or source identifiers", async () => {
    const rows = mixedRows();
    (rows.subscriptions[0] as Row).billing_hold_reason = "manual_review";
    rows.billing_cycles = [{ id: "cycle-fixture", subscription_id: "sub-fixture", billing_period: "202610", state: "retry_wait",
      retry_window_start: "2026-10-09T12:00:00Z", hold_reason: "insufficient_funds", authorization_snapshot: "fixture-private-mandate",
      payment_source_id: "fixture-private-source", verified_status_message: "fixture-private-status-message" }];
    rows.payment_attempts = [
      { id: "attempt-original", subscription_id: "sub-fixture", cycle_id: "cycle-fixture", attempt_number: 1,
        amount: 1500, state: "declined", created_at: "2026-10-08T18:00:00Z", verified_finalized_at: "2026-10-08T18:01:00Z",
        verified_reason: "insufficient_funds", verified_status_message: "fixture-private-status-message", verified_evidence: "fixture-private-evidence" },
      { id: "attempt-additional", subscription_id: "sub-fixture", cycle_id: "cycle-fixture", attempt_number: 2,
        amount: 1500, state: "prepared", created_at: "2026-10-08T18:01:00Z", verified_reason: "security_unknown" },
      { id: "attempt-legacy", subscription_id: "sub-fixture", cycle_id: null, attempt_number: null, state: "approved" },
    ];
    const client = readClient(rows);
    mocks.client.mockResolvedValue(client);
    const data = await loadAdminData();
    expect(data.subscriptions[0]).toMatchObject({ billingHoldReason: "manual_review", retryAt: "2026-10-09T12:00:00Z" });
    expect(data.billingAttempts).toEqual([
      expect.objectContaining({ id: "attempt-original", attemptNumber: 1, reasonLabel: "Fondos insuficientes verificados" }),
      expect.objectContaining({ id: "attempt-additional", attemptNumber: 2, reasonLabel: "Resultado por revisar" }),
    ]);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/source|authorization_snapshot|verified_evidence|verified_status_message/i);
    expect(serialized).not.toContain("fixture-private");
    const selections = client.from.mock.results.flatMap(({ value }) => value.select.mock.calls.map(([columns]: [string]) => columns)).join(" ");
    expect(selections).not.toMatch(/payment_source|authorization_snapshot|verified_evidence|verified_status_message|document|\*/i);
  });

  it("reads every administrative page beyond both 100 and 1000 rows without truncating summaries or history", async () => {
    const rows = mixedRows();
    const count = 1105;
    const key = (index: number) => String(index).padStart(5, "0");
    rows.donors = Array.from({ length: count }, (_, index) => ({ id: `donor-${key(index)}`, first_name: "Fixture", last_name: key(index), email: "fake@example.test", created_at: "2026-10-01T12:00:00Z" }));
    rows.subscriptions = Array.from({ length: count }, (_, index) => ({ id: `sub-${key(index)}`, donor_id: `donor-${key(index)}`, amount: 1500,
      frequency: "monthly", status: index === count - 1 ? "pending" : "active", preferred_payment_day: null }));
    rows.payments = Array.from({ length: count }, (_, index) => ({ id: `pay-${key(index)}`, subscription_id: `sub-${key(index)}`, amount: 1500,
      status: index === count - 1 ? "pending" : "declined", created_at: "2026-10-01T12:00:00Z" }));
    rows.billing_cycles = Array.from({ length: count }, (_, index) => ({ id: `cycle-${key(index)}`, subscription_id: `sub-${key(index)}`, state: "retry_wait",
      billing_period: "202610", retry_window_start: "2026-10-09T12:00:00Z" }));
    rows.payment_attempts = Array.from({ length: count }, (_, index) => ({ id: `attempt-${key(index)}`, subscription_id: `sub-${key(index)}`,
      donor_id: `donor-${key(index)}`, cycle_id: `cycle-${key(index)}`, attempt_number: 2, state: "unknown", amount: 1500,
      wompi_transaction_id: null, created_at: "2026-10-01T12:00:00Z" }));
    rows.admin_audit_logs = Array.from({ length: count }, (_, index) => ({ id: `audit-${key(index)}`, subscription_id: `sub-${key(index)}`,
      action: "cancel_retry", reason: "Fixture review requested", created_at: "2026-10-01T12:00:00Z" }));
    const client = readClient(rows);
    mocks.client.mockResolvedValue(client);
    const data = await loadAdminData();
    for (const field of ["donors", "subscriptions", "payments", "billingCycles", "billingAttempts", "recoveryAttempts", "auditEvents"] as const) {
      expect(data[field]).toHaveLength(count);
    }
    expect(data.subscriptions.at(-1)).toMatchObject({ id: "sub-01104", status: "pending" });
    expect(data.payments.at(-1)).toMatchObject({ id: "pay-01104", status: "pending" });
    expect(data.auditEvents.at(-1)).toMatchObject({ action: "retry_cancelled" });
    for (const table of Object.keys(rows)) {
      const queries = client.from.mock.calls.flatMap(([name], index) => name === table ? [client.from.mock.results[index].value] : []);
      expect(queries.some((query) => query.range.mock.calls.some(([start]: [number, number]) => start === 100))).toBe(true);
      expect(queries.some((query) => query.range.mock.calls.some(([start, end]: [number, number]) => start === 1100 && end === 1199))).toBe(true);
      expect(queries.every((query) => query.limit.mock.calls.length === 0)).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unavailable later page rather than returning an incomplete donor list", async () => {
    const rows = mixedRows();
    rows.donors = Array.from({ length: 101 }, (_, index) => ({ id: `donor-${index}` }));
    mocks.client.mockResolvedValue(readClient(rows, { table: "donors", start: 100 }));
    await expect(loadAdminData()).rejects.toThrow("No se pudo cargar");
  });

  it("rejects duplicate IDs spanning pages instead of counting a row twice", async () => {
    const rows = mixedRows();
    rows.donors = [...Array.from({ length: 100 }, (_, index) => ({ id: `donor-${index}` })), { id: "donor-0" }];
    mocks.client.mockResolvedValue(readClient(rows));
    await expect(loadAdminData()).rejects.toThrow("No se pudo cargar");
  });

  it.each([
    [true, "sí"], [false, "no"], [undefined, "desconocido"], [null, "desconocido"], ["true", "desconocido"],
  ])("projects recorded reactivation consent %s without inventing historical consent", async (consent, label) => {
    const rows = mixedRows();
    rows.admin_audit_logs = [{ id: "audit-reactivation", subscription_id: "sub-fixture", action: "reactivate",
      reason: "Fixture authorization instruction", before_value: { status: "cancelled" },
      after_value: { status: "active", ...(consent === undefined ? {} : { donor_authorization_confirmed: consent }),
        payment_source_id: "fixture-private-source", billing_authorization: "fixture-private-mandate" },
      created_at: "2026-10-08T12:00:00Z" }];
    mocks.client.mockResolvedValue(readClient(rows));
    const data = await loadAdminData();
    expect(data.auditEvents[0]).toMatchObject({ action: "subscription_reactivated" });
    expect(data.auditEvents[0].detail).toContain(`Autorización del donante confirmada: ${label}.`);
    expect(JSON.stringify(data)).not.toContain("fixture-private");
  });

  it.each([
    [{ providerStatus: "approved" }, "approved"],
    [{ provider_status: "pending" }, "pending"],
    [{ providerStatus: "declined", provider_status: "pending" }, "declined"],
    [{}, "sin estado"],
  ])("projects v2 and legacy provider status from safe audit fields: %j", async (after, label) => {
    const rows = mixedRows();
    rows.admin_audit_logs = [{ id: "audit-recovery", subscription_id: "sub-fixture", action: "payment_recovery",
      reason: "Fixture verified transaction", after_value: { ...after, payment_source_id: "fixture-private-source",
        verified_evidence: "fixture-private-evidence" }, created_at: "2026-10-08T12:00:00Z" }];
    mocks.client.mockResolvedValue(readClient(rows));
    const data = await loadAdminData();
    expect(data.auditEvents[0]).toMatchObject({ action: "payment_recovered" });
    expect(data.auditEvents[0].detail).toContain(`Intento conciliado con Wompi: ${label}.`);
    expect(JSON.stringify(data)).not.toContain("fixture-private");
  });
});
