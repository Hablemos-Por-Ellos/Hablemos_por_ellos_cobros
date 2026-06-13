import { describe, expect, it } from "vitest";
import { addOneMonthKeepingDay, getNextMonthlyPaymentDate, isPreferredPaymentDay } from "./payment-dates";

describe("payment date helpers", () => {
  it("recognizes only supported preferred payment days", () => {
    expect(isPreferredPaymentDay(1)).toBe(true);
    expect(isPreferredPaymentDay(6)).toBe(true);
    expect(isPreferredPaymentDay(16)).toBe(true);
    expect(isPreferredPaymentDay(28)).toBe(true);
    expect(isPreferredPaymentDay(15)).toBe(false);
    expect(isPreferredPaymentDay(null)).toBe(false);
  });

  it("schedules preferred payment days for next month at 7am Colombia", () => {
    expect(getNextMonthlyPaymentDate(new Date("2026-06-13T20:00:00.000Z"), 1).toISOString()).toBe(
      "2026-07-01T12:00:00.000Z"
    );
    expect(getNextMonthlyPaymentDate(new Date("2026-06-13T20:00:00.000Z"), 16).toISOString()).toBe(
      "2026-07-16T12:00:00.000Z"
    );
  });

  it("keeps the existing day when no preferred payment day is configured", () => {
    expect(addOneMonthKeepingDay(new Date("2026-01-31T10:30:00.000Z")).toISOString()).toBe(
      "2026-02-28T10:30:00.000Z"
    );
  });
});
