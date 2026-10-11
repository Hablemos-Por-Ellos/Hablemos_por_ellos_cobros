import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminDemoState } from "@/lib/admin-demo-data";
import { AdminConsole } from "./admin-console";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("administrative demo identification", () => {
  it("keeps the fictitious-data subtitle visible independently of responsive badges", () => {
    render(<AdminConsole initialView="donors" initialData={createAdminDemoState()} demo adminEmail="local@example.test" />);
    const subtitle = within(screen.getByRole("banner")).getByText("Datos ficticios · Vista local");
    expect(subtitle).toBeVisible();
    expect(subtitle.closest(".hidden")).toBeNull();
  });

  it("does not show the demo subtitle in the real administrative console", () => {
    render(<AdminConsole initialView="donors" initialData={createAdminDemoState()} demo={false} adminEmail="fixture@example.test" />);
    const header = within(screen.getByRole("banner"));
    expect(header.getByText("Panel de revisión operativa")).toBeVisible();
    expect(header.queryByText("Datos ficticios · Vista local")).not.toBeInTheDocument();
  });
});

describe("compact administrative registry", () => {
  it.each(["donors", "subscriptions"] as const)("uses a fixed %s desktop table and a separate mobile list", (view) => {
    render(<AdminConsole initialView={view} initialData={createAdminDemoState()} demo adminEmail="fixture@example.test" />);
    const scroller = screen.getByRole("table").parentElement;
    expect(scroller).toHaveClass("hidden", "relative", "lg:block");
    expect(scroller).not.toHaveClass("overflow-x-auto");
    expect(screen.getByRole("table")).toHaveClass("table-fixed", "w-full");
    expect(scroller?.querySelector(".sr-only")).not.toBeNull();
    expect(screen.getAllByTestId("mobile-subscription-row").length).toBeGreaterThan(0);
  });
});

describe("partial logout privacy", () => {
  it.each([
    { cookiesCleared: true, jwtRevocationConfirmed: false },
    { cookiesCleared: false, jwtRevocationConfirmed: true },
  ])("removes the private tables after a locally blocked session (%j)", async (flags) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({
      ok: false, authSignOutConfirmed: false, ...flags, message: "Fixture partial logout: administrative review required.",
    }) }));
    render(<AdminConsole initialView="subscriptions" initialData={createAdminDemoState()} demo={false} adminEmail="fixture@example.test" />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Cerrar sesi[oó]n/ })[0]);
    expect(await screen.findByRole("heading", { name: "Panel bloqueado" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("administrative review required");
    expect(screen.getByRole("link", { name: "Volver al ingreso" })).toHaveAttribute("href", "/admin/login");
  });
});

describe("reconciliation using the existing MFA session", () => {
  it("requires a reason and confirmation but never requests or submits another TOTP", async () => {
    const data = createAdminDemoState();
    data.recoveryAttempts[0] = { ...data.recoveryAttempts[0], id: "a4200000-0000-4000-8000-000000000004" };
    const attempt = data.recoveryAttempts[0];
    const donor = data.donors.find((item) => item.id === attempt.donorId)!;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ recovery: {
      attemptId: attempt.id, transactionId: "fixture-transaction-042", result: "recovered",
      providerStatus: "pending", state: "pending", needsReview: false,
    } }) });
    vi.stubGlobal("fetch",fetchMock);
    render(<AdminConsole initialView="dashboard" initialData={data} demo={false} readOnly={false} adminEmail="fixture@example.test" />);
    fireEvent.click(screen.getByRole("button",{name:`Conciliar transacción de ${donor.fullName}`}));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByLabelText(/Google Authenticator/)).not.toBeInTheDocument();
    expect(dialog.getByRole("button",{name:"Verificar y conciliar"})).toBeDisabled();
    fireEvent.change(dialog.getByLabelText("ID de transacción en Wompi"),{target:{value:"fixture-transaction-042"}});
    fireEvent.change(dialog.getByLabelText("Motivo"),{target:{value:"Verified fictional transaction"}});
    expect(dialog.getByRole("button",{name:"Verificar y conciliar"})).toBeEnabled();
    fireEvent.click(dialog.getByRole("button",{name:"Verificar y conciliar"}));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({action:"reconcile",transactionId:"fixture-transaction-042",reason:"Verified fictional transaction"});
    expect(payload).not.toHaveProperty("totpCode");
    expect(await screen.findByText("Resultado confirmado: pending.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
