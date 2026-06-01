import { describe, expect, it } from "vitest";
import { recurringMissingPaymentSourceMessage } from "./payment-step";

describe("recurringMissingPaymentSourceMessage", () => {
  it("does not blame Nequi when a card payment misses payment_source_id", () => {
    expect(recurringMissingPaymentSourceMessage("CARD")).not.toContain("Nequi");
    expect(recurringMissingPaymentSourceMessage("CARD")).toContain("fuente tokenizada");
  });

  it("keeps the Nequi-specific copy only for Nequi", () => {
    expect(recurringMissingPaymentSourceMessage("NEQUI")).toContain("Nequi");
  });
});
