import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminDemoState } from "@/lib/admin-demo-data";
import { AdminConsole } from "./admin-console";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("administrative demo identification", () => {
  it("keeps the fictitious-data subtitle visible independently of responsive badges", () => {
    render(<AdminConsole initialView="donors" initialData={createAdminDemoState()} demo />);
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

describe("administrative table scroll containment", () => {
  it.each(["donors", "subscriptions"] as const)("keeps hidden column labels inside the %s scroller", (view) => {
    render(<AdminConsole initialView={view} initialData={createAdminDemoState()} demo adminEmail="fixture@example.test" />);
    const scroller = screen.getByRole("table").parentElement;
    expect(scroller).toHaveClass("overflow-x-auto", "relative");
    expect(scroller?.querySelector(".sr-only")).not.toBeNull();
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
