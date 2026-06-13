export const PREFERRED_PAYMENT_DAYS = [1, 6, 16, 28] as const;

export type PreferredPaymentDay = (typeof PREFERRED_PAYMENT_DAYS)[number];

const COLOMBIA_UTC_OFFSET_HOURS = 5;
const COLOMBIA_CHARGE_HOUR_UTC = 12;

export function isPreferredPaymentDay(value: unknown): value is PreferredPaymentDay {
  return typeof value === "number" && PREFERRED_PAYMENT_DAYS.includes(value as PreferredPaymentDay);
}

export function addOneMonthKeepingDay(base: Date) {
  const targetDay = base.getDate();
  const candidate = new Date(base);
  candidate.setMonth(candidate.getMonth() + 1, 1);
  const daysInTargetMonth = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
  candidate.setDate(Math.min(targetDay, daysInTargetMonth));
  return candidate;
}

export function getNextMonthlyPaymentDate(base: Date, preferredPaymentDay?: number | null) {
  if (!isPreferredPaymentDay(preferredPaymentDay)) {
    return addOneMonthKeepingDay(base);
  }

  // Colombia is UTC-5 without daylight saving time. 7:00 a.m. Colombia is 12:00 UTC.
  const colombiaDate = new Date(base.getTime() - COLOMBIA_UTC_OFFSET_HOURS * 60 * 60 * 1000);

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
