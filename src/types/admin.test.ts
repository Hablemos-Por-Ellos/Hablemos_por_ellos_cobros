import { describe, expect, it } from "vitest";
import { confirmedRecoverySchema } from "./admin";

const recovery = {
  attemptId: "50000000-0000-0000-0000-000000000010", transactionId: "fixture-transaction",
  providerStatus: "approved", state: "approved",
};

describe("canonical admin recovery result contract", () => {
  it.each(["recovered", "duplicate", "review"])("accepts result %s", (result) => {
    expect(confirmedRecoverySchema.safeParse({ recovery: { ...recovery, result } }).success).toBe(true);
  });
  it("does not confuse a processing state with the operation result", () => {
    expect(confirmedRecoverySchema.safeParse({ recovery: { ...recovery, result: "needs_review" } }).success).toBe(false);
    expect(confirmedRecoverySchema.safeParse({ recovery: { ...recovery, result: "review", processingState: "needs_review" } }).success).toBe(true);
  });
});
