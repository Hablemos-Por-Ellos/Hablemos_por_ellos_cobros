import { createAdminDemoState, getDemoNextPaymentDate, maskEmail, maskPhone } from "@/lib/admin-demo-data";

describe("admin demo data", () => {
  it("creates independent local demo states", () => {
    const first = createAdminDemoState();
    const second = createAdminDemoState();

    first.subscriptions[0].status = "cancelled";

    expect(second.subscriptions[0].status).toBe("active");
  });

  it("moves a selected charge day to the next eligible Colombia billing date", () => {
    expect(getDemoNextPaymentDate(1)).toBe("2026-09-01T12:00:00.000Z");
    expect(getDemoNextPaymentDate(16)).toBe("2026-09-16T12:00:00.000Z");
    expect(getDemoNextPaymentDate(28)).toBe("2026-09-28T12:00:00.000Z");
  });

  it("masks contact details in lists", () => {
    expect(maskEmail("ana@example.test")).toBe("an***@example.test");
    expect(maskPhone("+57 300 410 2881")).toBe("+57 *** *** 2881");
  });
});
