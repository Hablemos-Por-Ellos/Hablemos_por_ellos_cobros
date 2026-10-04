import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAdminDemoState } from "@/lib/admin-demo-data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { DonorDetail } from "./admin-console";

type Action = "amount" | "schedule" | "cancel" | "reactivate";
const buttons = { amount: "Cambiar siguiente cobro", schedule: "Guardar cambios", cancel: "Cancelar suscripción", reactivate: "Revisar reactivación" };

function show(action: Action = "amount", readOnly = false) {
  const data = createAdminDemoState();
  const sub = data.subscriptions.find((item) => item.status === "active")!;
  sub.status = action === "reactivate" ? "cancelled" : "active";
  sub.amount = 24000;
  sub.billingVersion = 3;
  sub.preferredPaymentDay = 16;
  sub.nextPaymentDate = "2040-01-16T12:00:00Z";
  const onMutate = vi.fn<(...args: Parameters<Parameters<typeof DonorDetail>[0]["onMutate"]>) => Promise<void>>().mockResolvedValue(undefined);
  const props = { data, donorId: sub.donorId, subscriptionId: sub.id, demo: false, readOnly, onMutate };
  return { ...render(<DonorDetail {...props} />), props, sub, onMutate };
}

function fillConfirmation(action: Action) {
  const dialog = within(screen.getByRole("dialog"));
  if (action === "amount") fireEvent.change(dialog.getByLabelText(/Nuevo monto mensual/), { target: { value: "31000" } });
  fireEvent.change(dialog.getByLabelText("Motivo"), { target: { value: "Autorizacion fixture del donante" } });
  fireEvent.change(dialog.getByLabelText(/digo actual de Google/), { target: { value: "123456" } });
  if (action === "reactivate") fireEvent.click(dialog.getByRole("checkbox"));
  return dialog;
}

describe("explicit subscription confirmation", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it.each(["amount", "schedule", "cancel", "reactivate"] as const)("opening and leaving %s never calls onMutate", async (action) => {
    const { onMutate } = show(action);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: buttons[action] }));
    const dialog = fillConfirmation(action);
    expect(dialog.getByRole("heading", { name: "Antes" })).toBeVisible();
    expect(dialog.getByRole("heading", { name: "Después" })).toBeVisible();
    expect(dialog.getByText("¿Confirmas este cambio?")).toBeVisible();
    expect(dialog.getByText("Versión revisada: 3")).toBeVisible();
    expect(onMutate).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Volver" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: buttons[action] }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: buttons[action] }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cerrar diálogo" }));
    expect(onMutate).not.toHaveBeenCalled();
  });

  it.each(["amount", "schedule", "cancel", "reactivate"] as const)("only confirmation sends %s once despite double click and Enter", async (action) => {
    const { onMutate, sub } = show(action);
    let finish!: () => void;
    onMutate.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: buttons[action] }));
    const dialog = fillConfirmation(action);
    await user.click(dialog.getByLabelText("Motivo"));
    await user.keyboard("{Enter}");
    expect(onMutate).not.toHaveBeenCalled();
    const confirm = dialog.getByRole("button", { name: "Confirmar cambio" });
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    await user.keyboard("{Enter}{Enter}{Escape}");
    expect(onMutate).toHaveBeenCalledTimes(1);
    expect(onMutate).toHaveBeenCalledWith(sub.id, 3, expect.objectContaining({ action, reason: "Autorizacion fixture del donante", totpCode: "123456" }));
    expect(dialog.getByRole("button", { name: "Volver" })).toBeDisabled();
    expect(screen.getByRole("dialog")).toBeVisible();
    await act(async () => finish());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onMutate).toHaveBeenCalledTimes(1);
  });

  it("shows the old/new amount and keeps the reviewed version on conflict refresh", async () => {
    const { props, sub, rerender } = show();
    fireEvent.click(screen.getByRole("button", { name: buttons.amount }));
    const dialog = fillConfirmation("amount");
    const summary = within(dialog.getByRole("region", { name: "Resumen del cambio" }));
    expect(summary.getByText(/\$\s24\.000/)).toBeVisible();
    expect(summary.getByText(/\$\s31\.000/)).toBeVisible();
    rerender(<DonorDetail {...props} data={{ ...props.data, subscriptions: props.data.subscriptions.map((item) => item.id === sub.id ? { ...item, billingVersion: 4, amount: 32000 } : item) }} />);
    expect(summary.getByText(/\$\s24\.000/)).toBeVisible();
    expect(summary.getByText("Versión revisada: 3")).toBeVisible();
  });

  it("summarizes the schedule and explicitly warns about an in-flight charge on cancel", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Día 28" }));
    fireEvent.click(screen.getByRole("button", { name: buttons.schedule }));
    let dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/Día 16 ·/)).toBeVisible();
    expect(dialog.getByText(/Día 28 ·/)).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "Volver" }));
    fireEvent.click(screen.getByRole("button", { name: buttons.cancel }));
    dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/Cancelada · Sin futuros cobros/)).toBeVisible();
    expect(dialog.getByText(/Un cargo ya enviado a Wompi puede terminar/)).toBeVisible();
  });

  it("requires donor authorization before confirming reactivation", () => {
    show("reactivate");
    fireEvent.click(screen.getByRole("button", { name: buttons.reactivate }));
    const dialog = fillConfirmation("reactivate");
    expect(dialog.getByText(/Activa · Día 16/)).toBeVisible();
    fireEvent.click(dialog.getByRole("checkbox"));
    expect(dialog.getByRole("button", { name: "Confirmar cambio" })).toBeDisabled();
  });

  it("cannot confirm if the panel becomes read-only while the dialog is open", () => {
    const { props, rerender, onMutate } = show();
    fireEvent.click(screen.getByRole("button", { name: buttons.amount }));
    const dialog = fillConfirmation("amount");
    rerender(<DonorDetail {...props} readOnly />);
    expect(dialog.getByRole("button", { name: "Confirmar cambio" })).toBeDisabled();
    fireEvent.click(dialog.getByRole("button", { name: "Confirmar cambio" }));
    expect(onMutate).not.toHaveBeenCalled();
  });
});
