import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdminDemoState,
  type AdminDemoState,
  type DemoPayment,
  type DemoSubscription,
  type DemoSubscriptionStatus,
} from "@/lib/admin-demo-data";
import { AdminConsole, DonorDetail } from "./admin-console";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const network = vi.fn(() => { throw new Error("Network is forbidden in frequency UI tests."); });
const statuses = ["active", "pending", "cancelled", "past_due"] as const;
const frequencies = ["monthly", "one_time"] as const;
const paymentFrequencies = ["monthly", "one_time", "unlinked"] as const;
const paymentStatuses = ["approved", "pending", "declined"] as const;
const frequencyLabels = { monthly: "Mensual", one_time: "\u00danico" };
const statusLabels = { active: "Activa", pending: "Pendiente", cancelled: "Cancelada", past_due: "Por revisar" };
const paymentLabels = { approved: "Aprobado", pending: "Pendiente", declined: "Rechazado" };
type PaymentFrequency = typeof paymentFrequencies[number];
type MutationHandler = Parameters<typeof DonorDetail>[0]["onMutate"];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", network);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(network).not.toHaveBeenCalled();
});

function detailHref(subscription: DemoSubscription) {
  return `/admin/donantes/${subscription.donorId}?subscription=${encodeURIComponent(subscription.id)}`;
}

function showConsole(initialView: Parameters<typeof AdminConsole>[0]["initialView"], data = createAdminDemoState()) {
  return render(<AdminConsole initialView={initialView} initialData={data} demo={false} readOnly={false} adminEmail="frequency-fixture@example.test" />);
}

function subscriptionFixture() {
  const data = createAdminDemoState();
  const single = data.subscriptions.find((item) => item.frequency === "one_time")!;
  // Even an anomalous stored schedule must never become a one-time charge control.
  single.preferredPaymentDay = 28;
  single.nextPaymentDate = "2099-01-28T12:00:00.000Z";
  data.subscriptions.push(...statuses.filter((status) => status !== "active").map((status) => ({
    ...single,
    id: `fixture-single-${status}`,
    reference: `FIXTURE-SINGLE-${status.toUpperCase()}`,
    status,
  })));
  return data;
}

function paymentFixture() {
  const data = createAdminDemoState();
  const single = data.payments.find((item) => item.subscriptionId === "sub-unico")!;
  data.payments.push(...(["pending", "declined"] as const).map((status) => ({
    ...single,
    id: `fixture-single-payment-${status}`,
    wompiTransactionId: `fixture-single-transaction-${status}`,
    status,
  })));
  data.payments.push(...paymentStatuses.map((status) => ({
    ...single,
    id: `fixture-unlinked-payment-${status}`,
    subscriptionId: "fixture-missing-subscription",
    wompiTransactionId: `fixture-unlinked-transaction-${status}`,
    status,
  })));
  data.payments.push({
    ...single,
    id: "fixture-monthly-payment-pending",
    subscriptionId: "sub-alba",
    wompiTransactionId: "fixture-monthly-transaction-pending",
    status: "pending",
  });
  return data;
}

function selectFrequency(value: DemoSubscription["frequency"] | "all" | "unlinked") {
  fireEvent.change(screen.getByRole("combobox", { name: "Tipo de aporte" }), { target: { value } });
}

function selectSubscriptionStatus(value: DemoSubscriptionStatus | "all") {
  fireEvent.change(screen.getByRole("combobox", { name: "Filtrar estado" }), { target: { value } });
}

function searchSubscriptions(value: string) {
  fireEvent.change(screen.getByPlaceholderText("Buscar por donante, correo o referencia"), { target: { value } });
}

function expectSubscriptions(expected: DemoSubscription[]) {
  const main = within(screen.getByRole("main"));
  const table = main.getByRole("table", { hidden: true });
  const rows = within(table).getAllByRole("row", { hidden: true }).slice(1);
  // jsdom keeps both responsive branches mounted; scope them independently.
  const mobileLinks = main.queryAllByRole("link", { hidden: true }).filter((link) => !table.contains(link));
  expect(rows).toHaveLength(expected.length);
  expect(mobileLinks.map((link) => link.getAttribute("href"))).toEqual(expected.map(detailHref));
  expected.forEach((subscription, index) => {
    const row = within(rows[index]);
    const cells = row.getAllByRole("cell", { hidden: true });
    expect(row.getByText(subscription.reference, { exact: true })).toBeInTheDocument();
    expect(cells[2]).toHaveTextContent(frequencyLabels[subscription.frequency]);
    expect(cells[3]).toHaveTextContent(statusLabels[subscription.status]);
    expect(row.getByRole("link", { name: /^Ver detalle de/, hidden: true })).toHaveAttribute("href", detailHref(subscription));
    const mobile = within(mobileLinks[index]);
    expect(mobile.getByText(`${subscription.reference} \u00b7 ${frequencyLabels[subscription.frequency]}`, { exact: true })).toBeInTheDocument();
    expect(mobile.getByText(statusLabels[subscription.status], { exact: true })).toBeInTheDocument();
    if (subscription.frequency === "one_time") {
      expect(cells[4]).toHaveTextContent("No aplica");
      expect(mobile.getByText("No aplica", { exact: true })).toBeInTheDocument();
      expect(cells[4]).not.toHaveTextContent(/2099|D\u00eda/);
      expect(mobile.queryByText(/^D\u00eda /)).not.toBeInTheDocument();
    } else {
      expect(cells[4]).toHaveTextContent(`D\u00eda ${subscription.preferredPaymentDay}`);
      expect(mobile.getByText(`D\u00eda ${subscription.preferredPaymentDay}`, { exact: true })).toBeInTheDocument();
    }
  });
}

function paymentsOfType(data: AdminDemoState, frequency: PaymentFrequency) {
  return data.payments.filter((payment) => {
    const subscription = data.subscriptions.find((item) => item.id === payment.subscriptionId);
    return frequency === "unlinked" ? !subscription : subscription?.frequency === frequency;
  });
}

function expectPayments(data: AdminDemoState, expected: DemoPayment[]) {
  const main = within(screen.getByRole("main"));
  const links = main.queryAllByRole("link", { hidden: true });
  expect(links).toHaveLength(expected.length);
  expect(main.getByText(/transacciones visibles/)).toHaveTextContent(`${expected.length} transacciones visibles`);
  expected.forEach((payment, index) => {
    const subscription = data.subscriptions.find((item) => item.id === payment.subscriptionId);
    const donor = data.donors.find((item) => item.id === subscription?.donorId);
    const item = within(links[index]);
    expect(item.getByText(payment.wompiTransactionId, { exact: true })).toBeInTheDocument();
    expect(item.getByText(paymentLabels[payment.status], { exact: true })).toBeInTheDocument();
    expect(item.getByText(subscription ? frequencyLabels[subscription.frequency] : "Sin vincular", { exact: true })).toBeInTheDocument();
    expect(item.getByText(donor?.fullName ?? "Sin donante vinculado", { exact: true })).toBeInTheDocument();
    expect(links[index]).toHaveAttribute("href", subscription && donor ? detailHref(subscription) : "/admin");
  });
}

function expectMonthlyMetrics(active: number, cancelled: number, review: number) {
  const main = within(screen.getByRole("main"));
  for (const [label, count, detail] of [
    ["Suscripciones activas", active, "Con cobro mensual programado"],
    ["Canceladas", cancelled, "Sin pr\u00f3ximos cobros"],
    ["Por revisar", review, "Requieren seguimiento"],
  ] as const) {
    const section = main.getByText(detail, { exact: true }).closest("section")!;
    expect(within(section).getByText(label, { exact: true })).toBeInTheDocument();
    expect(within(section).getByText(String(count), { exact: true })).toBeInTheDocument();
  }
}

function reviewLinks() {
  const section = screen.getByRole("heading", { name: "Por revisar", level: 2 }).closest("section")!;
  return within(section).queryAllByRole("link").filter((link) => link.getAttribute("href")?.includes("?subscription="));
}

function expectSingleReadOnly() {
  expect(screen.getByText("\u00danico", { selector: "p", exact: true })).toBeInTheDocument();
  expect(screen.getByText("No aplica", { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Calendario de cobro", hidden: true })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /^(Cancelar|Reactivar) suscripci\u00f3n$/, hidden: true })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "D\u00eda preferido de cobro", hidden: true })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Mes del pr\u00f3ximo cobro")).not.toBeInTheDocument();
  expect(screen.queryByRole("spinbutton", { hidden: true })).not.toBeInTheDocument();
  expect(screen.queryAllByRole("button", { name: /Cambiar siguiente cobro|Guardar cambios|Cancelar suscripci\u00f3n|Revisar reactivaci\u00f3n|^D\u00eda \d+$/, hidden: true })).toHaveLength(0);
  expect(screen.queryByRole("dialog", { hidden: true })).not.toBeInTheDocument();
}

describe("contribution frequency in the real administrative subscription view", () => {
  it("renders both responsive branches with exact contribution links and no one-time schedule", () => {
    const data = subscriptionFixture();
    showConsole("subscriptions", data);
    expectSubscriptions(data.subscriptions);
  });

  it.each(frequencies)("filters %s and restores all contribution types", (frequency) => {
    const data = subscriptionFixture();
    showConsole("subscriptions", data);
    selectFrequency(frequency);
    expectSubscriptions(data.subscriptions.filter((item) => item.frequency === frequency));
    selectFrequency("all");
    expectSubscriptions(data.subscriptions);
  });

  it.each(frequencies.flatMap((frequency) => statuses.map((status) => ({ frequency, status }))))(
    "intersects $frequency with $status and name, email or reference searches",
    ({ frequency, status }) => {
      const data = subscriptionFixture();
      const target = data.subscriptions.find((item) => item.frequency === frequency && item.status === status)!;
      const donor = data.donors.find((item) => item.id === target.donorId)!;
      showConsole("subscriptions", data);
      selectFrequency(frequency);
      selectSubscriptionStatus(status);
      const matchingStatus = data.subscriptions.filter((item) => item.frequency === frequency && item.status === status);
      expectSubscriptions(matchingStatus);
      for (const query of [donor.fullName, donor.email, target.reference]) {
        searchSubscriptions(`  ${query.toUpperCase()}  `);
        expectSubscriptions([target]);
      }
      searchSubscriptions("");
      expectSubscriptions(matchingStatus);
      selectSubscriptionStatus("all");
      expectSubscriptions(data.subscriptions.filter((item) => item.frequency === frequency));
    },
  );

  it.each(frequencies)("shows an empty intersection for %s without leaking the other responsive branch", (frequency) => {
    const data = subscriptionFixture();
    const target = data.subscriptions.find((item) => item.frequency === frequency && item.status === "active")!;
    showConsole("subscriptions", data);
    selectFrequency(frequency);
    searchSubscriptions(target.reference);
    selectSubscriptionStatus("cancelled");
    expectSubscriptions([]);
    expect(screen.getByText("No hay suscripciones que coincidan con los filtros.")).toBeInTheDocument();
    selectSubscriptionStatus("active");
    expectSubscriptions([target]);
    searchSubscriptions("fixture-no-matching-donor");
    expectSubscriptions([]);
    expect(screen.getByText("No hay suscripciones que coincidan con los filtros.")).toBeInTheDocument();
    searchSubscriptions("");
    expectSubscriptions(data.subscriptions.filter((item) => item.frequency === frequency && item.status === "active"));
    expect(screen.queryByText("No hay suscripciones que coincidan con los filtros.")).not.toBeInTheDocument();
  });
});

describe("linked and unlinked payment frequency", () => {
  it.each(paymentFrequencies.flatMap((frequency) => paymentStatuses.map((status) => ({ frequency, status }))))(
    "intersects $frequency payments with $status without misclassifying unlinked payments",
    ({ frequency, status }) => {
      const data = paymentFixture();
      showConsole("payments", data);
      expectPayments(data, data.payments);
      selectFrequency(frequency);
      const matchingType = paymentsOfType(data, frequency);
      expectPayments(data, matchingType);
      fireEvent.change(screen.getByRole("combobox", { name: "Filtrar pagos por estado" }), { target: { value: status } });
      expectPayments(data, matchingType.filter((item) => item.status === status));
      selectFrequency("all");
      expectPayments(data, data.payments.filter((item) => item.status === status));
      fireEvent.change(screen.getByRole("combobox", { name: "Filtrar pagos por estado" }), { target: { value: "all" } });
      expectPayments(data, data.payments);
    },
  );

  it.each(["one_time", "unlinked"] as const)("shows and recovers from an empty %s payment/status intersection", (frequency) => {
    const data = paymentFixture();
    const removed = new Set(paymentsOfType(data, frequency).filter((item) => item.status === "declined").map((item) => item.id));
    data.payments = data.payments.filter((item) => !removed.has(item.id));
    showConsole("payments", data);
    selectFrequency(frequency);
    fireEvent.change(screen.getByRole("combobox", { name: "Filtrar pagos por estado" }), { target: { value: "declined" } });
    expectPayments(data, []);
    expect(screen.getByText("No hay pagos que coincidan con los filtros.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Filtrar pagos por estado" }), { target: { value: "approved" } });
    expectPayments(data, paymentsOfType(data, frequency).filter((item) => item.status === "approved"));
    expect(screen.queryByText("No hay pagos que coincidan con los filtros.")).not.toBeInTheDocument();
  });
});

describe("empty frequency datasets", () => {
  it.each(["subscriptions", "payments"] as const)("keeps the %s filters usable without any records", (view) => {
    const data = createAdminDemoState();
    data.subscriptions = [];
    data.payments = [];
    showConsole(view, data);
    for (const frequency of frequencies) {
      selectFrequency(frequency);
      if (view === "subscriptions") {
        expectSubscriptions([]);
        expect(screen.getByText("No hay suscripciones que coincidan con los filtros.")).toBeInTheDocument();
      } else {
        expectPayments(data, []);
        expect(screen.getByText("No hay pagos que coincidan con los filtros.")).toBeInTheDocument();
      }
    }
  });
});

describe("monthly-only dashboard counters and review queue", () => {
  it.each(statuses)("does not count a one-time %s contribution as a monthly subscription", (status) => {
    const data = createAdminDemoState();
    const single = data.subscriptions.find((item) => item.frequency === "one_time")!;
    single.status = status;
    showConsole("dashboard", data);
    expectMonthlyMetrics(3, 1, 2);
    const expected = data.subscriptions.filter((item) => item.frequency === "monthly" && (item.status === "past_due" || item.status === "pending"));
    expect(reviewLinks().map((link) => link.getAttribute("href"))).toEqual(expected.map(detailHref));
    expect(reviewLinks().map((link) => link.getAttribute("href"))).not.toContain(detailHref(single));
    expect(screen.queryByText("Sofia Demo", { exact: true })).not.toBeInTheDocument();
  });

  it("keeps counters and the review list empty when only one-time contributions exist", () => {
    const data = subscriptionFixture();
    data.subscriptions = data.subscriptions.filter((item) => item.frequency === "one_time");
    data.recoveryAttempts = [];
    data.auditEvents = [];
    data.payments = data.payments.filter((item) => item.subscriptionId === "sub-unico");
    showConsole("dashboard", data);
    expectMonthlyMetrics(0, 0, 0);
    expect(reviewLinks()).toHaveLength(0);
  });
});

describe("one-time donor detail cannot mutate subscriptions", () => {
  it.each(statuses)("hides all mutation controls for one-time %s even when the panel is writable", async (status) => {
    const data = subscriptionFixture();
    const subscription = data.subscriptions.find((item) => item.frequency === "one_time")!;
    subscription.status = status;
    const onMutate = vi.fn<MutationHandler>().mockResolvedValue(undefined);
    render(<DonorDetail data={data} donorId={subscription.donorId} subscriptionId={subscription.id} demo={false} readOnly={false} onMutate={onMutate} />);
    expect(screen.getByRole("heading", { name: "Sofia Demo", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(statusLabels[status], { selector: "span", exact: true })).toBeInTheDocument();
    expectSingleReadOnly();
    expect(screen.getByRole("combobox", { name: "Aporte seleccionado" })).toHaveValue(subscription.id);
    const user = userEvent.setup();
    await user.click(screen.getByText("No aplica", { exact: true }));
    await user.keyboard("{Enter}{Escape}");
    expectSingleReadOnly();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("preserves the monthly option and controls while switching a mixed donor to an explicit one-time contribution", async () => {
    const data = subscriptionFixture();
    const monthly = data.subscriptions.find((item) => item.id === "sub-alba")!;
    const single = data.subscriptions.find((item) => item.id === "sub-unico")!;
    single.donorId = monthly.donorId;
    const onMutate = vi.fn<MutationHandler>().mockResolvedValue(undefined);
    const props = { data, donorId: monthly.donorId, demo: false, readOnly: false, onMutate };
    const { rerender } = render(<DonorDetail {...props} />);
    expect(screen.getByRole("combobox", { name: "Aporte seleccionado" })).toHaveValue(monthly.id);
    expect(screen.getByRole("button", { name: "Cambiar siguiente cobro" })).toBeEnabled();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Aporte seleccionado" }), single.id);
    expect(router.push).toHaveBeenLastCalledWith(detailHref(single));
    rerender(<DonorDetail {...props} subscriptionId={single.id} />);
    expectSingleReadOnly();
    const selector = screen.getByRole("combobox", { name: "Aporte seleccionado" });
    expect(selector).toHaveValue(single.id);
    expect(within(selector).getByRole("option", { name: /^Mensual/ })).toHaveValue(monthly.id);
    expect(onMutate).not.toHaveBeenCalled();
    await user.selectOptions(selector, monthly.id);
    expect(router.push).toHaveBeenLastCalledWith(detailHref(monthly));
    rerender(<DonorDetail {...props} subscriptionId={monthly.id} />);
    expect(screen.getByRole("heading", { name: "Calendario de cobro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cambiar siguiente cobro" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancelar suscripci\u00f3n" })).toBeEnabled();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it.each(statuses)("also keeps the integrated AdminConsole one-time %s detail read-only", (status) => {
    const data = subscriptionFixture();
    const subscription = data.subscriptions.find((item) => item.id === "sub-unico")!;
    subscription.status = status;
    render(<AdminConsole initialView="donors" initialData={data} donorId={subscription.donorId} subscriptionId={subscription.id} demo={false} readOnly={false} adminEmail="frequency-fixture@example.test" />);
    expectSingleReadOnly();
    expect(screen.getByRole("heading", { name: "Sofia Demo", level: 1 })).toBeInTheDocument();
    expect(network).not.toHaveBeenCalled();
  });
});

describe("monthly donor controls remain available", () => {
  it.each(statuses)("preserves monthly calendar and status-dependent controls for %s", (status) => {
    const data = createAdminDemoState();
    const subscription = data.subscriptions.find((item) => item.id === "sub-alba")!;
    subscription.status = status;
    const onMutate = vi.fn<MutationHandler>().mockResolvedValue(undefined);
    render(<DonorDetail data={data} donorId={subscription.donorId} subscriptionId={subscription.id} demo={false} readOnly={false} onMutate={onMutate} />);
    expect(screen.getByText("Mensual", { selector: "p", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Calendario de cobro" })).toBeInTheDocument();
    const amount = screen.getByRole("button", { name: "Cambiar siguiente cobro" });
    const month = screen.getByLabelText("Mes del pr\u00f3ximo cobro");
    const days = within(screen.getByRole("group", { name: "D\u00eda preferido de cobro" })).getAllByRole("button");
    expect(days).toHaveLength(4);
    if (status === "active") {
      expect(amount).toBeEnabled();
      expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeEnabled();
    } else {
      expect(amount).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Guardar cambios" })).not.toBeInTheDocument();
    }
    if (status === "pending") {
      expect(month).toBeDisabled();
      days.forEach((day) => expect(day).toBeDisabled());
    } else {
      expect(month).toBeEnabled();
      days.forEach((day) => expect(day).toBeEnabled());
    }
    const cancel = screen.queryByRole("button", { name: "Cancelar suscripci\u00f3n" });
    const reactivate = screen.queryByRole("button", { name: "Revisar reactivaci\u00f3n" });
    if (status === "active" || status === "past_due") expect(cancel).toBeEnabled();
    else expect(cancel).not.toBeInTheDocument();
    if (status === "cancelled" || status === "past_due") expect(reactivate).toBeEnabled();
    else expect(reactivate).not.toBeInTheDocument();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("still sends an explicitly confirmed monthly amount change to onMutate", async () => {
    const data = createAdminDemoState();
    const subscription = data.subscriptions.find((item) => item.id === "sub-alba")!;
    const onMutate = vi.fn<MutationHandler>().mockResolvedValue(undefined);
    render(<DonorDetail data={data} donorId={subscription.donorId} subscriptionId={subscription.id} demo={false} readOnly={false} onMutate={onMutate} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cambiar siguiente cobro" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/Nuevo monto mensual/), { target: { value: "31000" } });
    fireEvent.change(dialog.getByLabelText("Motivo"), { target: { value: "Autorizacion ficticia para prueba de frecuencia" } });
    fireEvent.change(dialog.getByLabelText("C\u00f3digo actual de Google Authenticator"), { target: { value: "123456" } });
    expect(onMutate).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Confirmar cambio" }));
    expect(onMutate).toHaveBeenCalledTimes(1);
    expect(onMutate).toHaveBeenCalledWith(subscription.id, subscription.billingVersion, expect.objectContaining({ action: "amount", amount: 31000, reason: "Autorizacion ficticia para prueba de frecuencia", totpCode: "123456" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
