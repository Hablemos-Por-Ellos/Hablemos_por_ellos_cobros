import { describe, expect, it, vi } from "vitest";
import {
  getColombiaBillingMonthRange,
  getNextMonthlyPaymentDate,
  runMonthlyCharges,
} from "./monthly-charge-runner.mjs";

function dueSubscription(overrides = {}) {
  return {
    id: "sub-1",
    amount: 50000,
    currency: "COP",
    next_payment_date: "2026-06-16T12:00:00.000Z",
    wompi_payment_source_id: "source-1",
    reference: "HPE-TEST",
    preferred_payment_day: 16,
    donor: { email: "donante@example.com" },
    ...overrides,
  };
}

function createSupabase({ dueSubs = [dueSubscription()], payments = [], paymentsError = null, updateError = null } = {}) {
  const updates = [];
  const inserts = [];
  const audits = [];

  const subscriptions = {
    select: () => subscriptions,
    eq: () => subscriptions,
    not: () => subscriptions,
    lte: async () => ({ data: dueSubs, error: null }),
    update: (payload) => {
      updates.push(payload);
      return { eq: async () => ({ error: updateError }) };
    },
  };

  const paymentQuery = {
    select: () => paymentQuery,
    eq: () => paymentQuery,
    gte: () => paymentQuery,
    lt: () => paymentQuery,
    in: () => paymentQuery,
    order: async () => ({ data: payments, error: paymentsError }),
    insert: async (payload) => {
      inserts.push(payload);
      return { error: null };
    },
  };

  const auditLogs = {
    insert: async (payload) => {
      audits.push(payload);
      return { error: null };
    },
  };

  return {
    supabase: {
      from: (table) => {
        if (table === "subscriptions") return subscriptions;
        if (table === "payments") return paymentQuery;
        if (table === "audit_logs") return auditLogs;
        throw new Error(`Unexpected table ${table}`);
      },
    },
    updates,
    inserts,
    audits,
  };
}

const silentLogger = { log: vi.fn() };

describe("monthly charge billing calendar", () => {
  it("treats 2026-07-01 02:40 UTC as the June billing period in Colombia", () => {
    expect(getColombiaBillingMonthRange(new Date("2026-07-01T02:40:00.000Z"))).toEqual({
      periodKey: "202606",
      startIso: "2026-06-01T05:00:00.000Z",
      endIso: "2026-07-01T05:00:00.000Z",
    });
  });

  it("uses Colombia calendar boundaries when the year changes", () => {
    expect(getColombiaBillingMonthRange(new Date("2027-01-01T04:59:59.000Z"))).toMatchObject({
      periodKey: "202612",
      endIso: "2027-01-01T05:00:00.000Z",
    });
  });

  it("keeps preferred dates at 7 a.m. Colombia in UTC", () => {
    expect(getNextMonthlyPaymentDate(new Date("2026-08-01T13:35:44.000Z"), 16).toISOString()).toBe(
      "2026-09-16T12:00:00.000Z"
    );
  });

  it("charges with a Colombia billing-period reference after the UTC boundary", async () => {
    const { supabase, inserts } = createSupabase();
    const createTransaction = vi.fn().mockResolvedValue({ id: "tx-1", status: "pending" });

    const stats = await runMonthlyCharges({
      now: new Date("2026-07-01T02:40:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "HPE-TEST-202606", amountInCents: 5000000 })
    );
    expect(inserts).toEqual([expect.objectContaining({ wompi_transaction_id: "tx-1", status: "pending" })]);
    expect(stats.charged).toBe(1);
  });

  it("does not re-charge while Wompi payment is pending", async () => {
    const { supabase } = createSupabase({ payments: [{ id: "pay-1", status: "pending", created_at: "2026-08-01T13:35:44.000Z" }] });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(stats.skippedPending).toBe(1);
  });

  it("repairs an overdue next payment date after an approved payment in the same Colombia month", async () => {
    const { supabase, updates, audits } = createSupabase({
      dueSubs: [dueSubscription({ next_payment_date: "2026-08-16T12:00:00.000Z" })],
      payments: [
        {
          id: "pay-1",
          status: "approved",
          created_at: "2026-08-01T13:35:44.000Z",
          wompi_transaction_id: "tx-approved",
        },
      ],
    });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(updates).toEqual([{ next_payment_date: "2026-09-16T12:00:00.000Z" }]);
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_schedule_reconciled" })]);
    expect(stats.reconciled).toBe(1);
  });

  it("fails closed when the duplicate-payment check cannot be completed", async () => {
    const { supabase, audits } = createSupabase({ paymentsError: { message: "database unavailable" } });
    const createTransaction = vi.fn();

    const stats = await runMonthlyCharges({
      now: new Date("2026-08-18T13:00:00.000Z"),
      supabase,
      createTransaction,
      logger: silentLogger,
    });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ action: "monthly_charge_duplicate_check_failed" })]);
    expect(stats.duplicateCheckFailures).toBe(1);
  });
});
