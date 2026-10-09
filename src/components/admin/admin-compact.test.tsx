import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminDemoState, DEMO_STORAGE_KEY, type AdminDemoState } from "@/lib/admin-demo-data";
import { AdminConsole, DonorDetail } from "./admin-console";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const network = vi.fn(() => { throw new Error("Network forbidden in compact admin fixtures."); });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal("fetch", network);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(network).not.toHaveBeenCalled(); });

function show(view: "dashboard" | "subscriptions" | "donors" = "subscriptions", data = createAdminDemoState()) {
  return render(<AdminConsole initialView={view} initialData={data} demo={false} readOnly adminEmail="compact@example.test" />);
}

function reviewCount(label: string) {
  const metrics = screen.getByLabelText("Resumen de seguimiento");
  const section = within(metrics).getByText(label, { exact: true }).closest("section")!;
  return within(section).getByText(/^\d+$/).textContent;
}

describe("independent administrative queues", () => {
  it("separates an unactivated subscription from a pending payment and a scheduled retry", () => {
    const data = createAdminDemoState();
    show("dashboard", data);
    expect(reviewCount("Suscripciones pendientes")).toBe("1");
    expect(reviewCount("Pagos pendientes")).toBe("1");
    expect(reviewCount("Reintentos")).toBe("1");
    expect(reviewCount("Por revisar")).toBe("3");
    const review = screen.getByRole("heading", { name: "Por revisar", level: 2 }).closest("section")!;
    const links = within(review).getAllByRole("link");
    expect(links).toHaveLength(Number(reviewCount("Por revisar")));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/admin/donantes/donor-elena?subscription=sub-elena",
      "/admin/donantes/donor-julian?subscription=sub-julian",
      "/admin/donantes/donor-security?subscription=sub-security",
    ]);
    const scheduled = screen.getByRole("heading", { name: "Reintentos programados" }).closest("section")!;
    expect(within(scheduled).getAllByRole("link")).toHaveLength(1);
    expect(within(scheduled).getByText("Lucia Rivas Demo")).toBeInTheDocument();
    const unactivated = screen.getByRole("heading", { name: "Suscripciones pendientes", level: 2 }).closest("section")!;
    expect(within(unactivated).getAllByRole("link")).toHaveLength(Number(reviewCount("Suscripciones pendientes")));
    expect(within(unactivated).getByText("Tomas Vega Demo")).toBeInTheDocument();
    expect(within(unactivated).queryByText("Julian Gomez")).not.toBeInTheDocument();
  });

  it.each([
    ["retry", ["sub-retry"]],
    ["reconcile", ["sub-julian"]],
    ["review", ["sub-elena", "sub-security"]],
    ["subscription_pending", ["sub-pending"]],
  ] as const)("filters the %s queue without overlapping the other categories", (queue, ids) => {
    show();
    fireEvent.change(screen.getByRole("combobox", { name: "Filtrar seguimiento" }), { target: { value: queue } });
    expect(screen.queryAllByTestId("mobile-subscription-row").map((row) => row.getAttribute("href")?.split("subscription=")[1])).toEqual(ids);
    fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
    expect(screen.getAllByTestId("mobile-subscription-row")).toHaveLength(createAdminDemoState().subscriptions.length);
  });

  it("does not count a malformed one-time retry projection as a recurring retry", () => {
    const data = createAdminDemoState();
    const single = data.subscriptions.find((item) => item.id === "sub-unico")!;
    single.retryAt = "2099-01-01T12:00:00Z";
    single.billingHoldReason = "retry_scheduled";
    show("subscriptions", data);
    expect(reviewCount("Reintentos")).toBe("1");
    fireEvent.change(screen.getByRole("combobox", { name: "Tipo de aporte" }), { target: { value: "one_time" } });
    const row = screen.getByTestId("mobile-subscription-row");
    expect(row).toHaveTextContent("No aplica");
    expect(row).not.toHaveTextContent("2099");
    expect(row).not.toHaveTextContent("Reintento programado");
  });
});

describe("compact registry selection and responsive branches", () => {
  it("keeps the mobile essentials in a bounded two-level grid, not a table scroller", () => {
    show();
    const row = screen.getAllByTestId("mobile-subscription-row").find((item) => item.getAttribute("href")?.includes("sub-alba"))!;
    expect(row).toHaveClass("min-w-0", "grid", "grid-cols-[minmax(0,1fr),auto]");
    expect(row).toHaveTextContent("Alba Restrepo");
    expect(row).toHaveTextContent(/50\.000/);
    expect(row).toHaveTextContent("Activa");
    expect(row).toHaveTextContent("16 sep 2026");
    expect(row.closest(".overflow-x-auto")).toBeNull();
    expect(row.closest("table")).toBeNull();
    // Real viewport/pixel assertions are performed by the main browser QA.
  });

  it("opens a read-only lateral timeline, switches histories and closes selection", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Abrir resumen de Lucia Rivas Demo" }));
    const peek = within(screen.getByRole("complementary", { name: "Detalle seleccionado" }));
    expect(peek.getByText("lu***@example.test")).toBeInTheDocument();
    expect(peek.queryByText("lucia.rivas@example.test")).not.toBeInTheDocument();
    expect(peek.getByRole("tab", { name: "Intentos" })).toHaveAttribute("aria-selected", "true");
    expect(peek.getByText("Fondos insuficientes verificados")).toBeInTheDocument();
    fireEvent.keyDown(peek.getByRole("tab", { name: "Intentos" }), { key: "ArrowRight" });
    expect(peek.getByRole("tab", { name: "Actividad" })).toHaveFocus();
    expect(peek.getByRole("tab", { name: "Actividad" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(peek.getByRole("tab", { name: "Pagos" }));
    expect(peek.getByText("demo-retry-original")).toBeInTheDocument();
    fireEvent.click(peek.getByRole("tab", { name: "Actividad" }));
    expect(peek.getByText("Sin cambios administrativos registrados.")).toBeInTheDocument();
    expect(peek.getByRole("link", { name: "Abrir detalle" })).toHaveAttribute("href", "/admin/donantes/donor-retry?subscription=sub-retry");
    expect(peek.queryByRole("button", { name: /Guardar|Cobrar|Reactivar|Cancelar reintento/ })).not.toBeInTheDocument();
    fireEvent.click(peek.getByRole("button", { name: "Cerrar resumen" }));
    expect(screen.queryByRole("complementary", { name: "Detalle seleccionado" })).not.toBeInTheDocument();
  });

  it("clears the selected projection when filters no longer include its subscription", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Abrir resumen de Lucia Rivas Demo" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Tipo de aporte" }), { target: { value: "one_time" } });
    expect(screen.queryByRole("complementary", { name: "Detalle seleccionado" })).not.toBeInTheDocument();
  });
});

describe("safe retry confirmation", () => {
  function showDetail(id = "sub-retry", readOnly = false) {
    const data = createAdminDemoState();
    const subscription = data.subscriptions.find((item) => item.id === id)!;
    const onMutate = vi.fn<Parameters<typeof DonorDetail>[0]["onMutate"]>().mockResolvedValue(undefined);
    const props = { data, donorId: subscription.donorId, subscriptionId: id, demo: false, readOnly, onMutate };
    return { ...render(<DonorDetail {...props} />), props, onMutate };
  }

  it("freezes amount/date/reactivation during a queued additional", () => {
    const { onMutate } = showDetail();
    expect(screen.getByRole("button", { name: "Cambiar siguiente cobro" })).toBeDisabled();
    expect(screen.getByLabelText("Mes del próximo cobro")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revisar reactivación" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar reintento" })).toBeEnabled();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("only cancels the prepared additional after reason, TOTP and explicit confirmation with the original reviewed cycle", async () => {
    const { props, rerender, onMutate } = showDetail();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar reintento" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Confirmar cambio" })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText("Motivo"), { target: { value: "Solicitud ficticia del donante" } });
    fireEvent.change(dialog.getByLabelText("Código actual de Google Authenticator"), { target: { value: "123456" } });
    expect(onMutate).not.toHaveBeenCalled();
    expect(dialog.getByRole("heading", { name: "Antes" })).toBeInTheDocument();
    expect(dialog.getByRole("heading", { name: "Después" })).toBeInTheDocument();
    rerender(<DonorDetail {...props} data={{ ...props.data, billingCycles: props.data.billingCycles?.map((cycle) => cycle.id === "cycle-retry" ? { ...cycle, id: "cycle-new" } : cycle) }} />);
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Confirmar cambio" })));
    expect(onMutate).toHaveBeenCalledWith("sub-retry", 0, expect.objectContaining({ action: "cancel_retry", expectedCycleId: "cycle-retry", reason: "Solicitud ficticia del donante", totpCode: "123456" }));
  });

  it.each(["sub-julian", "sub-pending", "sub-elena", "sub-security", "sub-unico"])("does not offer another automatic or manual retry for %s", (id) => {
    const { onMutate } = showDetail(id);
    expect(screen.queryByRole("button", { name: "Cancelar reintento" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cobrar ahora|Reintentar ahora/ })).not.toBeInTheDocument();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("blocks retry cancellation in read-only mode", () => {
    showDetail("sub-retry", true);
    expect(screen.queryByRole("button", { name: "Cancelar reintento" })).not.toBeInTheDocument();
  });

  it("keeps an active projected pending attempt frozen even when its detailed history is unavailable", () => {
    const { props, rerender } = showDetail("sub-alba");
    rerender(<DonorDetail {...props} data={{ ...props.data, billingAttempts: undefined, billingCycles: undefined, subscriptions: props.data.subscriptions.map((item) => item.id === "sub-alba" ? { ...item, attemptState: "pending" as const } : item) }} />);
    expect(screen.getByRole("button", { name: "Cambiar siguiente cobro" })).toBeDisabled();
    expect(screen.getByLabelText("Mes del próximo cobro")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar reintento" })).not.toBeInTheDocument();
  });

  it("does not cancel a scheduled projection without an identifiable cycle", () => {
    const { props, rerender } = showDetail();
    rerender(<DonorDetail {...props} data={{ ...props.data, billingCycles: undefined }} />);
    expect(screen.queryByRole("button", { name: "Cancelar reintento" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cambiar siguiente cobro" })).toBeDisabled();
  });

  it("cancels only local future work and preserves original payments/attempt history", async () => {
    const original = createAdminDemoState();
    render(<AdminConsole initialView="donors" initialData={original} donorId="donor-retry" subscriptionId="sub-retry" demo adminEmail="local@example.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar reintento" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Motivo"), { target: { value: "Cambio ficticio de autorización" } });
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Confirmar cambio" })));
    const persisted = JSON.parse(window.localStorage.getItem(DEMO_STORAGE_KEY)!) as AdminDemoState;
    expect(persisted.payments).toEqual(original.payments);
    expect(persisted.billingAttempts).toEqual(original.billingAttempts);
    expect(persisted.subscriptions.find((item) => item.id === "sub-retry")).toMatchObject({ status: "past_due", nextPaymentDate: null, retryAt: null, billingHoldReason: "admin_retry_cancelled", billingVersion: 1 });
    expect(persisted.billingCycles?.find((item) => item.id === "cycle-retry")).toMatchObject({ state: "manual_review", retryAt: null });
    expect(persisted.auditEvents[0].action).toBe("retry_cancelled");
  });
});
