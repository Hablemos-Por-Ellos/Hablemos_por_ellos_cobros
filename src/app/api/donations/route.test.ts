import { beforeEach, describe, expect, it, vi } from "vitest";

type BuilderState = {
  table: string;
  op: "insert" | "update" | "upsert" | "select" | null;
  payload: any;
  filters: Record<string, unknown>;
};

const mutations: BuilderState[] = [];
let subscriptionRecord: any;

function createBuilder(table: string) {
  const state: BuilderState = { table, op: null, payload: null, filters: {} };
  const builder = {
    upsert(payload: any) {
      state.op = "upsert";
      state.payload = payload;
      mutations.push({ ...state });
      return builder;
    },
    insert(payload: any) {
      state.op = "insert";
      state.payload = payload;
      mutations.push({ ...state });
      return builder;
    },
    update(payload: any) {
      state.op = "update";
      state.payload = payload;
      mutations.push({ ...state });
      return builder;
    },
    select() {
      state.op = state.op ?? "select";
      return builder;
    },
    eq(key: string, value: unknown) {
      state.filters[key] = value;
      return builder;
    },
    async maybeSingle() {
      if (table === "subscriptions") return { data: subscriptionRecord, error: null };
      if (table === "payments") return { data: null, error: null };
      return { data: null, error: null };
    },
    async single() {
      if (table === "donors") return { data: { id: "donor-1" }, error: null };
      if (table === "subscriptions") {
        subscriptionRecord = { ...subscriptionRecord, ...state.payload };
        return { data: subscriptionRecord, error: null };
      }
      return { data: null, error: null };
    },
    then(resolve: (value: any) => void) {
      resolve({ error: null });
    },
  };

  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  getServiceSupabaseClient: () => ({
    from: (table: string) => createBuilder(table),
  }),
}));

vi.mock("@/lib/wompi-server", () => ({
  createWompiPaymentSource: vi.fn(),
  createWompiTransaction: vi.fn(),
  getWompiAcceptance: vi.fn(),
}));

import { POST } from "./route";

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
};

describe("POST /api/donations", () => {
  beforeEach(() => {
    mutations.length = 0;
    subscriptionRecord = { id: "sub-1", reference: "HPE-TEST", processed_transaction_ids: [] };
  });

  it("updates a pending subscription by reference on confirm instead of inserting a duplicate", async () => {
    const response = await POST(
      new Request("https://example.test/api/donations", {
        method: "POST",
        body: JSON.stringify({
          stage: "confirm",
          donor,
          amount: 10000,
          paymentMethod: "card",
          wompi: {
            reference: "HPE-TEST",
            paymentSourceId: "src-1",
            transactionId: "tx-1",
            maskedDetails: "VISA **** 4242",
          },
        }),
      })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("subscription_created");
    expect(mutations.some((m) => m.table === "subscriptions" && m.op === "update")).toBe(true);
    expect(mutations.some((m) => m.table === "subscriptions" && m.op === "insert")).toBe(false);
    expect(mutations.some((m) => m.table === "payments" && m.op === "insert")).toBe(true);
  });
});
