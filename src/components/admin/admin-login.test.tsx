import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const { browser, replace, refresh, prepare } = vi.hoisted(() => ({
  browser: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prepare: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));
vi.mock("@/lib/supabase-auth-browser", () => ({ getBrowserSupabaseClient: browser }));
vi.mock("@/lib/admin-mfa-enrollment", () => ({ prepareAdminTotp: prepare }));
import { AdminLogin } from "./admin-login";

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("disconnected Auth UI", () => {
  it("does not construct a browser client or expose sign-in when auth is disabled", () => {
    render(<AdminLogin authEnabled={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("no esta habilitado");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(browser).not.toHaveBeenCalled();
  });
  it("shows expired/used invitation state without password entry", () => {
    render(<AdminLogin activation authEnabled={false} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Invitacion no disponible");
    expect(screen.queryByLabelText("Nueva contrasena")).not.toBeInTheDocument();
    expect(browser).not.toHaveBeenCalled();
  });
});

describe("standard login form (mocked transport, not a browser E2E)", () => {
  let signIn: ReturnType<typeof vi.fn>;
  let signOut: ReturnType<typeof vi.fn>;
  let verify: ReturnType<typeof vi.fn>;
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    signIn = vi.fn().mockResolvedValue({ error: null });
    signOut = vi.fn().mockResolvedValue({ error: null });
    verify = vi.fn().mockResolvedValue({ error: null });
    request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authorized: true }) });
    browser.mockReturnValue({ auth: { signInWithPassword: signIn, signOut,
      mfa: { challengeAndVerify: verify, getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
        data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null,
      }) },
    } });
    prepare.mockResolvedValue({ stage: "verify", factorId: "fixture-factor" });
    vi.stubGlobal("fetch", request);
  });

  async function submitCredentials() {
    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "admin@example.test" } });
    fireEvent.change(screen.getByLabelText("Contrasena"), { target: { value: "fictitious-password-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByLabelText("Codigo de Google Authenticator");
  }

  function submitCode() {
    fireEvent.change(screen.getByLabelText("Codigo de Google Authenticator"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar e ingresar" }));
  }

  it("submits credentials but does not enter the panel at AAL1", async () => {
    render(<AdminLogin authEnabled />);
    await submitCredentials();
    expect(signIn).toHaveBeenCalledExactlyOnceWith({ email: "admin@example.test", password: "fictitious-password-only" });
    expect(request).toHaveBeenCalledWith("/api/admin/bootstrap", { method: "POST" });
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Contrasena")).not.toBeInTheDocument();
  });

  it("rejects invalid credentials without preparing MFA or exposing provider errors", async () => {
    signIn.mockResolvedValue({ error: new Error("private-provider-fixture-message") });
    render(<AdminLogin authEnabled />);
    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "admin@example.test" } });
    fireEvent.change(screen.getByLabelText("Contrasena"), { target: { value: "wrong-fixture-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No fue posible iniciar sesion");
    expect(screen.getByLabelText("Contrasena")).toHaveValue("");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private-provider-fixture-message");
    expect(prepare).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("requires MFA verification and another allowlist check before navigation", async () => {
    render(<AdminLogin authEnabled />);
    await submitCredentials();
    submitCode();
    await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith("/admin"));
    expect(verify).toHaveBeenCalledExactlyOnceWith({ factorId: "fixture-factor", code: "123456" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps a wrong MFA code retryable without navigation", async () => {
    verify.mockResolvedValue({ error: new Error("fixture-mfa-error") });
    render(<AdminLogin authEnabled />);
    await submitCredentials();
    submitCode();
    expect(await screen.findByRole("alert")).toHaveTextContent("El codigo no es valido");
    expect(screen.getByLabelText("Codigo de Google Authenticator")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("clears enrollment after authorization loss even if sign-out fails=%s", async (signOutFails) => {
    prepare.mockResolvedValue({ stage: "enroll", factorId: "fixture-factor", qrCode: "data:image/svg+xml,fixture-only", secret: "fixture-enrollment-secret" });
    render(<AdminLogin authEnabled />);
    await submitCredentials();
    expect(screen.getByAltText("Codigo QR para configurar Google Authenticator")).toBeInTheDocument();
    request.mockResolvedValueOnce({ ok: false, json: async () => ({ authorized: false }) });
    if (signOutFails) signOut.mockRejectedValue(new Error("fixture-signout-failed"));
    submitCode();
    expect(await screen.findByRole("alert")).toHaveTextContent("Esta cuenta no esta autorizada");
    expect(screen.getByLabelText("Correo")).toBeInTheDocument();
    expect(screen.queryByAltText("Codigo QR para configurar Google Authenticator")).not.toBeInTheDocument();
    expect(screen.queryByText("fixture-enrollment-secret")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Codigo de Google Authenticator")).not.toBeInTheDocument();
    expect(signOut).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not misreport successful MFA as an invalid code when bootstrap transport fails", async () => {
    render(<AdminLogin authEnabled />);
    await submitCredentials();
    request.mockRejectedValueOnce(new Error("fixture-transport-failed"));
    submitCode();
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos confirmar tu acceso");
    expect(screen.getByLabelText("Correo")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("retains a completed password step when MFA preparation fails", async () => {
    prepare.mockRejectedValue(new Error("fixture-enrollment-failed"));
    render(<AdminLogin activation authEnabled />);
    fireEvent.change(screen.getByLabelText("Nueva contrasena"), { target: { value: "fictitious-new-password-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Activar acceso" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tu contrasena quedo guardada");
    expect(screen.queryByLabelText("Nueva contrasena")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Contrasena")).toHaveValue("");
    expect(request.mock.calls.filter(([url]) => url === "/api/admin/activation/password")).toHaveLength(1);
    expect(replace).not.toHaveBeenCalled();
  });
});
