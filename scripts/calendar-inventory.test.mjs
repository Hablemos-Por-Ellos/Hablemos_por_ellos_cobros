// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertBillingJobRuntime } from "./billing-job-mode.mjs";
import { runMonthlyRetryCharges } from "./monthly-retry-runner.mjs";

const AT = "2026-10-09T12:00:00.000Z";
const LOCAL_ENV = Object.freeze({ SUPABASE_URL: "http://127.0.0.1:54321" });
const STANDARD_DAYS = [1, 6, 16, 28];
let fetchGuard;

beforeEach(() => {
  fetchGuard = vi.fn(() => { throw new Error("UNEXPECTED_NETWORK_CALL"); });
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

function subscription(id, overrides = {}) {
  return { id, donor_id: "invented-donor-" + id, reference: "invented-reference-" + id,
    frequency: "monthly", status: "active", billing_version: 0,
    preferred_payment_day: 6, next_payment_date: AT, ...overrides };
}

function legacyCalendars() {
  return [
    subscription("invented-legacy-day-2", {
      preferred_payment_day: null, next_payment_date: "2026-10-02T12:00:00.000Z",
    }),
    subscription("invented-legacy-day-10", {
      preferred_payment_day: null, next_payment_date: "2026-10-10T12:00:00.000Z",
    }),
  ];
}

function standardCalendars(count = 9) {
  return Array.from({ length: count }, (_, index) => subscription(
    "invented-standard-" + String(index).padStart(3, "0"), {
      preferred_payment_day: STANDARD_DAYS[index % STANDARD_DAYS.length],
      next_payment_date: "2026-11-06T12:00:00.000Z",
    },
  ));
}

function fixture({ subscriptions = [], attempts = [], payments = [], ready = true } = {}) {
  const rows = Object.fromEntries(Object.entries({ billing_cycles: [],
    payment_attempts: attempts, subscriptions, payments }).map(([table, data]) => [
    table, Object.freeze(data.map((row) => Object.freeze({ ...row }))),
  ]));
  const before = structuredClone(rows);
  const selections = [];
  const ranges = [];
  const mutation = vi.fn(() => { throw new Error("UNEXPECTED_DATABASE_MUTATION"); });
  const supabase = {
    from: vi.fn((table) => {
      if (!Object.hasOwn(rows, table)) throw new Error("UNEXPECTED_TABLE");
      let fields;
      let ordered = false;
      const query = {
        select: vi.fn((columns) => {
          fields = columns === "*" ? null : columns.split(",").map((field) => field.trim());
          selections.push({ table, columns });
          return query;
        }),
        order: vi.fn((column, options) => {
          expect(column).toBe("id");
          expect(options).toEqual({ ascending: true });
          ordered = true;
          return query;
        }),
        range: vi.fn(async (start, end) => {
          expect(query.select).toHaveBeenCalledOnce();
          expect(ordered).toBe(true);
          ranges.push({ table, start, end });
          const data = [...rows[table]].sort((left, right) => left.id.localeCompare(right.id))
            .slice(start, end + 1).map((row) => Object.freeze(fields === null ? { ...row }
              : Object.fromEntries(fields.map((field) => [field, row[field]]))));
          return { data, error: null };
        }),
        insert: mutation, update: mutation, upsert: mutation, delete: mutation,
      };
      return query;
    }),
    rpc: vi.fn(async (name, args) => {
      if (name !== "billing_retry_schema_ready" || args !== undefined) {
        mutation(name, args);
      }
      return { data: ready, error: null };
    }),
  };
  const forbiddenProvider = (name) => vi.fn(() => { throw new Error("UNEXPECTED_PROVIDER_" + name); });
  const getTransaction = forbiddenProvider("GET_TRANSACTION");
  const getPaymentSource = forbiddenProvider("GET_SOURCE");
  const send = forbiddenProvider("SEND");
  const prepareTransaction = vi.fn(() => {
    send();
    throw new Error("UNEXPECTED_PROVIDER_PREPARE");
  });
  const logger = { log: vi.fn(), error: vi.fn() };
  const run = () => runMonthlyRetryCharges({ mode: "inventory", env: LOCAL_ENV, supabase,
    getTransaction, getPaymentSource, prepareTransaction, logger, clock: () => new Date(AT) });
  const assertReadOnly = () => {
    expect(supabase.rpc.mock.calls).toEqual([["billing_retry_schema_ready", undefined]]);
    expect(mutation).not.toHaveBeenCalled();
    for (const fn of [fetchGuard, getTransaction, getPaymentSource, prepareTransaction, send]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(rows).toEqual(before);
  };
  return { run, supabase, logger, selections, ranges, assertReadOnly };
}

async function inventory(options) {
  const f = fixture(options);
  const stats = await f.run();
  f.assertReadOnly();
  expect(stats).toMatchObject({ mode: "inventory", failed: 0, sent: 0, approved: 0,
    charged: 0, reconciled: 0, repaired: 0, originalsReserved: 0, retriesReserved: 0 });
  return { ...f, stats };
}

describe("v041 local read-only calendar inventory", () => {
  it("accepts only an injected loopback URL, without financial variables", async () => {
    expect(Object.keys(LOCAL_ENV)).toEqual(["SUPABASE_URL"]);
    expect(assertBillingJobRuntime("inventory", LOCAL_ENV)).toBe("inventory");
    expect(() => assertBillingJobRuntime("charge", LOCAL_ENV)).toThrow("FINANCIAL_OPERATIONS_DISABLED");
    const { stats } = await inventory();
    expect(stats).toMatchObject({ due: 0, legacyCalendars: 0, calendarReviewRequired: 0, blocked: 0 });
  });

  it("reports both legacy calendars even when only day 2 is due and day 10 is future", async () => {
    const { stats, logger } = await inventory({ subscriptions: legacyCalendars() });
    expect(stats).toMatchObject({ due: 1, legacyCalendars: 2, calendarReviewRequired: 2, blocked: 2, noIds: 0 });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("action=calendar_review_required"));
  });

  it("keeps nine selected standard agendas valid across all four supported preferences", async () => {
    const { stats, logger } = await inventory({ subscriptions: standardCalendars() });
    expect(stats).toMatchObject({ due: 0, legacyCalendars: 0, calendarReviewRequired: 0, blocked: 0 });
    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining("action=calendar_review_required"));
  });

  it("excludes past_due/pending monthly and active one-time NULL calendars", async () => {
    const excluded = [
      subscription("invented-past-due", { status: "past_due" }),
      subscription("invented-pending", { status: "pending" }),
      subscription("invented-one-time", { frequency: "one_time" }),
    ].map((row) => ({ ...row, preferred_payment_day: null, next_payment_date: null }));
    const { stats } = await inventory({ subscriptions: [...legacyCalendars(), ...standardCalendars(), ...excluded] });
    expect(stats).toMatchObject({ due: 1, legacyCalendars: 2, calendarReviewRequired: 2, blocked: 2 });
  });

  it("warns for day 15 without classifying it as a NULL legacy preference", async () => {
    const { stats, logger } = await inventory({ subscriptions: [
      subscription("invented-day-15", { preferred_payment_day: 15 }),
    ] });
    expect(stats).toMatchObject({ due: 1, legacyCalendars: 0, calendarReviewRequired: 1, blocked: 1 });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("action=calendar_review_required"));
  });

  it.each([null, undefined, "", "invented-invalid-date", Infinity, "Infinity", "+275761-01-01T00:00:00.000Z"])(
    "warns for missing/invalid/non-finite next date %s with a valid preference", async (next_payment_date) => {
      const { stats, logger } = await inventory({ subscriptions: [
        subscription("invented-invalid-next-date", { next_payment_date }),
      ] });
      expect(stats).toMatchObject({ due: 0, legacyCalendars: 0, calendarReviewRequired: 1, blocked: 1 });
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("action=calendar_review_required"));
    },
  );

  it("counts each calendar once even with both an invalid preference and missing date", async () => {
    const { stats } = await inventory({ subscriptions: [
      subscription("invented-double-invalid", { preferred_payment_day: 15, next_payment_date: null }),
      subscription("invented-legacy-missing-date", { preferred_payment_day: null, next_payment_date: null }),
    ] });
    expect(stats).toMatchObject({ due: 0, legacyCalendars: 1, calendarReviewRequired: 2, blocked: 2 });
  });

  it("adds review calendars to existing inventory blockers without provider lookup", async () => {
    const { stats } = await inventory({ subscriptions: legacyCalendars(),
      attempts: [{ id: "invented-unknown-attempt", state: "unknown", wompi_transaction_id: null },
        { id: "invented-known-attempt", state: "pending", wompi_transaction_id: "invented-transaction" }],
      payments: [{ id: "invented-pending-payment", status: "pending", wompi_transaction_id: null }],
    });
    expect(stats).toMatchObject({ legacyCalendars: 2, calendarReviewRequired: 2, outstanding: 2,
      payments: 1, noIds: 2, blocked: 4 });
  });

  it("selects the preferred field plus existing identifiers/dates and counts all pages", async () => {
    const { stats, selections, ranges } = await inventory({
      subscriptions: [...standardCalendars(100), ...legacyCalendars().map((row) => ({
        ...row, id: "zz-" + row.id,
      }))],
    });
    expect(stats).toMatchObject({ legacyCalendars: 2, calendarReviewRequired: 2, blocked: 2, due: 1 });
    const subscriptionSelections = selections.filter(({ table }) => table === "subscriptions");
    expect(subscriptionSelections).toHaveLength(2);
    for (const { columns } of subscriptionSelections) {
      expect(columns.split(",").map((column) => column.trim()).sort()).toEqual([
        "id", "donor_id", "reference", "frequency", "status", "billing_version",
        "next_payment_date", "preferred_payment_day",
      ].sort());
    }
    expect(ranges.filter(({ table }) => table === "subscriptions")).toEqual([
      { table: "subscriptions", start: 0, end: 99 },
      { table: "subscriptions", start: 100, end: 199 },
    ]);
  });

  it.each([false, "true", null])("requires strictly boolean schema readiness %s once before any read", async (ready) => {
    const f = fixture({ subscriptions: legacyCalendars(), ready });
    await expect(f.run()).rejects.toThrow("BILLING_JOB_SCHEMA_NOT_READY");
    f.assertReadOnly();
    expect(f.supabase.from).not.toHaveBeenCalled();
  });
});
