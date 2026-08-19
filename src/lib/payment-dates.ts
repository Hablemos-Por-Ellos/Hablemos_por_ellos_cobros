export const PREFERRED_PAYMENT_DAYS = [1, 6, 16, 28] as const;

export type PreferredPaymentDay = (typeof PREFERRED_PAYMENT_DAYS)[number];

export const BILLING_TIME_ZONE = "America/Bogota";
const COLOMBIA_UTC_OFFSET_HOURS = 5;
const COLOMBIA_CHARGE_HOUR_UTC = 12;

export type BillingMonthRange = {
  periodKey: string;
  start: Date;
  end: Date;
};

export function isPreferredPaymentDay(value: unknown): value is PreferredPaymentDay {
  return typeof value === "number" && PREFERRED_PAYMENT_DAYS.includes(value as PreferredPaymentDay);
}

function getColombiaCalendarDate(date: Date) {
  return new Date(date.getTime() - COLOMBIA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
}

export function getColombiaBillingMonthRange(date: Date): BillingMonthRange {
  const colombiaDate = getColombiaCalendarDate(date);
  const year = colombiaDate.getUTCFullYear();
  const month = colombiaDate.getUTCMonth();

  return {
    periodKey: `${year}${String(month + 1).padStart(2, "0")}`,
    // Colombia is UTC-5 year-round. Midnight in Colombia is 05:00 UTC.
    start: new Date(Date.UTC(year, month, 1, COLOMBIA_UTC_OFFSET_HOURS, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, COLOMBIA_UTC_OFFSET_HOURS, 0, 0, 0)),
  };
}

export function addOneMonthKeepingDay(base: Date) {
  const targetDay = base.getUTCDate();
  const candidate = new Date(base);
  candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
  const daysInTargetMonth = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 0)).getUTCDate();
  candidate.setUTCDate(Math.min(targetDay, daysInTargetMonth));
  return candidate;
}

export function getNextMonthlyPaymentDate(base: Date, preferredPaymentDay?: number | null) {
  if (!isPreferredPaymentDay(preferredPaymentDay)) {
    return addOneMonthKeepingDay(base);
  }

  // Colombia is UTC-5 without daylight saving time. 7:00 a.m. Colombia is 12:00 UTC.
  const colombiaDate = getColombiaCalendarDate(base);

  return new Date(
    Date.UTC(
      colombiaDate.getUTCFullYear(),
      colombiaDate.getUTCMonth() + 1,
      preferredPaymentDay,
      COLOMBIA_CHARGE_HOUR_UTC,
      0,
      0,
      0
    )
  );
}
