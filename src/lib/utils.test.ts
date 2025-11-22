import { describe, expect, it } from "vitest";
import { formatCurrencyCOP } from "./utils";

describe("formatCurrencyCOP", () => {
  it("formats numbers as COP", () => {
    expect(formatCurrencyCOP(20000)).toBe("$\u00a020.000");
  });
});
