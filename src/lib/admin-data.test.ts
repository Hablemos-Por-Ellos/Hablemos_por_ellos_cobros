import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ context: vi.fn(), demo: vi.fn(), ready: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/admin-auth", () => ({ getAdminContext: mocks.context, isAdminDemoMode: mocks.demo, isAdminSchemaReady: mocks.ready }));
vi.mock("@/lib/supabase-auth-server", () => ({ getServerAuthSupabaseClient: mocks.client }));
import { loadAdminData } from "./admin-data";

describe("admin read-only projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.demo.mockReturnValue(false);
    mocks.ready.mockResolvedValue(true);
    mocks.context.mockResolvedValue({ demo: false });
  });
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
    const rows: Record<string, unknown[]> = {
      donors: [{ id: "donor-fixture", first_name: "Fixture", last_name: "Only", email: "recipient@example.test", phone: "573000000000", city: "Bogota", created_at: "2026-10-01T00:00:00Z" }],
      subscriptions: [{ id: "sub-fixture", donor_id: "donor-fixture", amount: 1500, frequency: "monthly", status: "pending", preferred_payment_day: 16, billing_version: 3 }],
      payments: [{ id: "payment-fixture", subscription_id: "sub-fixture", amount: 1500, status: "approved", approved_at: null, created_at: "2026-10-01T00:00:00Z" }],
    };
    const selections: string[] = [];
    const from = vi.fn((table: string) => {
      const result = Promise.resolve({ data: rows[table] ?? [], error: null });
      const query = { select: (columns: string) => { selections.push(columns); return query; }, order: () => query,
        eq: () => query, is: () => query, lt: () => query, in: () => query, limit: () => query, then: result.then.bind(result) };
      return query;
    });
    mocks.client.mockResolvedValue({ from });
    const data = await loadAdminData("donor-fixture");
    expect(data.donors[0].contactMasked).toBe(true);
    expect(data.donors[0].email).not.toBe("recipient@example.test");
    expect(data.donors[0].phone).not.toBe("573000000000");
    expect(data.payments[0].status).toBe("review");
    expect(selections.join(" ")).not.toMatch(/wompi_payment_source_id|wompi_masked_details|document/);
    expect(JSON.stringify(data)).not.toContain("recipient@example.test");
  });
});
