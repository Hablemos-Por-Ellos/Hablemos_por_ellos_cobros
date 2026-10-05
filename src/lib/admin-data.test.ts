import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ context: vi.fn(), demo: vi.fn(), ready: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/admin-auth", () => ({ getAdminContext: mocks.context, isAdminDemoMode: mocks.demo, isAdminSchemaReady: mocks.ready }));
vi.mock("@/lib/supabase-auth-server", () => ({ getServerAuthSupabaseClient: mocks.client }));
import { loadAdminData } from "./admin-data";

function readClient(rows: Record<string, unknown[]>) {
  const forbiddenWrite = () => { throw new Error("Unexpected write in admin read-only fixture"); };
  const mutations = {
    insert: vi.fn(forbiddenWrite), update: vi.fn(forbiddenWrite),
    upsert: vi.fn(forbiddenWrite), delete: vi.fn(forbiddenWrite), rpc: vi.fn(forbiddenWrite),
  };
  const from = vi.fn((table: string) => {
    if (!(table in rows)) throw new Error(`Unexpected table ${table}`);
    const result = Promise.resolve({ data: rows[table], error: null });
    const query = {
      select: vi.fn<(columns: string) => unknown>(), order: vi.fn(),
      eq: vi.fn(), is: vi.fn(), lt: vi.fn(), in: vi.fn(), limit: vi.fn(),
      ...mutations, then: result.then.bind(result),
    };
    for (const method of ["select", "order", "eq", "is", "lt", "in", "limit"] as const) {
      query[method].mockReturnValue(query);
    }
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
    ]);
    for (const { value: query } of client.from.mock.results) {
      expect(query.select).toHaveBeenCalledTimes(1);
    }
    for (const method of ["insert", "update", "upsert", "delete", "rpc"] as const) {
      expect(client[method]).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
