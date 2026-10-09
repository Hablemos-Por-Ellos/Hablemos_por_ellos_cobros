// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canStartAuthorizedSend, classifyAutomaticRetry, getRetryWindow,
  parseVerifiedFinalizedAt, verifiedSnapshotMatches, VERIFIED_INSUFFICIENT_FUNDS_MESSAGE } from "./billing-retry-policy.mjs";

const expected = { transactionId: "tx-fixture", reference: "fixture-original", amount: 30000,
  currency: "COP", paymentSourceId: "source-fixture" };
const transaction = { id: "tx-fixture", reference: "fixture-original", amountInCents: 3000000,
  currency: "COP", paymentSourceId: "source-fixture", paymentMethodType: "CARD", status: "declined",
  statusMessage: VERIFIED_INSUFFICIENT_FUNDS_MESSAGE, finalizedAt: "2026-10-08T13:00:00.000Z",
  environment: "sandbox", verificationSource: "provider_get" };
const source = { id: "source-fixture", type: "CARD", status: "AVAILABLE", environment: "sandbox",
  verificationSource: "provider_get", verifiedAt: "2026-10-09T12:00:00Z" };
const classify = (changes = {}) => classifyAutomaticRetry({ frequency: "monthly", attemptNumber: 1,
  retryAuthorized: true, transaction, expected,
  source: { ...source, verifiedAt: (changes.now ?? new Date("2026-10-09T12:00:00Z")).toISOString() }, environment: "sandbox",
  now: new Date("2026-10-09T12:00:00Z"), ...changes });

describe("verified retry policy", () => {
  it("permits exactly the additional attempt, after the original verified funds decline", () => {
    expect(classify()).toEqual({ action: "retry_ready", reason: "VERIFIED_INSUFFICIENT_FUNDS",
      retryWindowStart: "2026-10-09T12:00:00.000Z", retryWindowEnd: "2026-10-10T05:00:00.000Z",
      effectiveAt: "2026-10-08T13:00:00.000Z" });
  });
  it.each([" " + VERIFIED_INSUFFICIENT_FUNDS_MESSAGE + "\n",
    VERIFIED_INSUFFICIENT_FUNDS_MESSAGE.replace("Intente", "Ｉｎｔｅｎｔｅ")])("only normalizes NFKC and outer whitespace %s", (statusMessage) => {
    expect(classify({ transaction: { ...transaction, statusMessage } }).action).toBe("retry_ready");
  });
  it.each(["Fondos Insuficientes", "intente mas tarde - Fondos Insuficientes", "Intente más tarde - Fondos Insuficientes",
    "Intente mas tarde - Fondos Insuficientes.", "Banco: " + VERIFIED_INSUFFICIENT_FUNDS_MESSAGE,
    VERIFIED_INSUFFICIENT_FUNDS_MESSAGE + " por seguridad", "Intente  mas tarde - Fondos Insuficientes", null])(
    "does not infer insufficient funds from partial or different messages %s", (statusMessage) => {
      expect(classify({ transaction: { ...transaction, statusMessage } }).reason).toBe("DECLINE_REASON_NOT_RETRYABLE");
    });
  it.each(["error", "voided"])("does not retry %s", (status) => {
    expect(classify({ transaction: { ...transaction, status } }).action).toBe("manual_review");
  });
  it("pending always reconciles, not sends", () => {
    expect(classify({ transaction: { ...transaction, status: "pending" } })).toMatchObject({ action: "reconcile" });
  });
  it.each([2, 3, null, undefined, "1", 0])("never grants another decline retry for ordinal %s", (attemptNumber) => {
    expect(classify({ attemptNumber }).reason).toBe("ATTEMPT_BUDGET_EXHAUSTED");
  });
  it("excludes unique contributions and legacy authorization assumptions", () => {
    expect(classify({ frequency: "one_time" }).reason).toBe("ONE_TIME_NO_AUTOMATIC_RETRY");
    expect(classify({ retryAuthorized: false }).reason).toBe("RETRY_AUTHORIZATION_MISSING_OR_REVOKED");
    expect(classify({ authorizationRevoked: true }).reason).toBe("RETRY_AUTHORIZATION_MISSING_OR_REVOKED");
    expect(classify({ retryAuthorized: "true" }).action).toBe("manual_review");
  });
  it.each([{ environment: "prod" }, { reference: "someone-else" }, { amountInCents: 3000001 },
    { amountInCents: "3000000" }, { currency: "USD" }, { paymentSourceId: "other-source" },
    { id: "other-transaction" }, { verificationSource: "browser" }, { status: "unknown" }])(
    "rejects changed/unverified transaction snapshots %j", (changes) => {
      expect(classify({ transaction: { ...transaction, ...changes } }).reason).toBe("UNVERIFIED_TRANSACTION_SNAPSHOT");
    });
  it.each([{ type: "NEQUI" }, { status: "UNAVAILABLE" }, { id: "other-source" },
    { environment: "prod" }, { verificationSource: "browser" }])("requires a fresh matching CARD GET %j", (changes) => {
      expect(classify({ source: { ...source, ...changes } }).reason).toBe("CARD_SOURCE_NOT_VERIFIED_AVAILABLE");
    });
  it("requires CARD also on the verified transaction", () => {
    expect(classify({ transaction: { ...transaction, paymentMethodType: "NEQUI" } }).action).toBe("manual_review");
  });
  it("checks inclusive 7am and exclusive midnight, with no next-day catchup", () => {
    expect(classify({ now: new Date("2026-10-09T11:59:59.999Z") }).action).toBe("retry_wait");
    expect(classify({ now: new Date("2026-10-09T12:00:00.000Z") }).action).toBe("retry_ready");
    expect(classify({ now: new Date("2026-10-10T04:59:59.999Z") }).action).toBe("retry_ready");
    expect(classify({ now: new Date("2026-10-10T05:00:00.000Z") }).reason).toBe("RETRY_WINDOW_EXPIRED");
    expect(classify({ now: new Date("2026-10-11T12:00:00.000Z") }).action).toBe("manual_review");
  });
  it.each([null, "2026-10-08", "2026-10-08T13:00:00", "2026-02-30T13:00:00Z",
    "2026-10-08T08:00:00-05:00", "2026-10-10T13:00:00Z", "not-a-date"])("does not invent a finalization date %s", (finalizedAt) => {
      expect(classify({ transaction: { ...transaction, finalizedAt } }).reason).toBe("FINALIZED_AT_NOT_VERIFIED");
    });
  it("validates UTC calendar dates without JavaScript overflow or fallback", () => {
    expect(parseVerifiedFinalizedAt("2026-02-30T13:00:00Z", new Date("2026-10-09"))).toBeNull();
    expect(parseVerifiedFinalizedAt("2026-10-08T13:00:00+00:00", new Date("2026-10-09"))?.toISOString())
      .toBe("2026-10-08T13:00:00.000Z");
    expect(verifiedSnapshotMatches({ transaction, expected: { ...expected, amount: 21_474_837 }, environment: "sandbox" })).toBe(false);
  });
  it.each([
    ["2026-07-01T02:40:00Z", "2026-07-01T12:00:00.000Z", "2026-07-02T05:00:00.000Z"],
    ["2026-12-31T23:30:00Z", "2027-01-01T12:00:00.000Z", "2027-01-02T05:00:00.000Z"],
    ["2026-11-01T04:59:59Z", "2026-11-01T12:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    ["2028-02-29T15:00:00Z", "2028-03-01T12:00:00.000Z", "2028-03-02T05:00:00.000Z"],
  ])("uses the Colombia approval date across month/year/leap boundaries %s", (at, start, end) => {
    expect(getRetryWindow(at, new Date("2029-01-01T00:00:00Z"))).toEqual({ start, end });
  });
});

describe("durable authorization send boundary", () => {
  const authorized = { sendAuthorizedAt: "2026-10-09T12:00:00.000Z", windowEnd: "2026-10-10T05:00:00.000Z" };
  it("only starts within fifteen seconds and before the end of window", () => {
    expect(canStartAuthorizedSend({ ...authorized, now: new Date("2026-10-09T12:00:14.999Z") })).toBe(true);
    expect(canStartAuthorizedSend({ ...authorized, now: new Date("2026-10-09T12:00:15Z") })).toBe(false);
    expect(canStartAuthorizedSend({ ...authorized, now: new Date("2026-10-09T12:00:15.001Z") })).toBe(false);
    expect(canStartAuthorizedSend({ ...authorized, now: new Date("2026-10-09T11:59:59Z") })).toBe(false);
    expect(canStartAuthorizedSend({ sendAuthorizedAt: "2026-10-10T04:59:59Z", windowEnd: authorized.windowEnd,
      now: new Date(authorized.windowEnd) })).toBe(false);
  });
  it("fails closed for missing or ambiguous timestamps", () => {
    expect(canStartAuthorizedSend({ now: new Date() })).toBe(false);
    expect(canStartAuthorizedSend({ ...authorized, sendAuthorizedAt: "2026-10-09T12:00:00", now: new Date("2026-10-09T12:00:01Z") })).toBe(false);
  });
});
