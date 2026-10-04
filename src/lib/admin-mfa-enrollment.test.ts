import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, type AuthMFAEnrollTOTPResponse, type AuthMFAListFactorsResponse, type AuthMFAUnenrollResponse, type Factor, type GoTrueMFAApi, type MFAEnrollTOTPParams } from "@supabase/supabase-js";

const ui = vi.hoisted(() => ({ browser: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: ui.replace, refresh: ui.refresh }) }));
vi.mock("@/lib/supabase-auth-browser", () => ({ getBrowserSupabaseClient: ui.browser }));
vi.mock("@/components/build-identity", () => ({ BuildIdentity: () => null }));
import { prepareAdminTotp } from "./admin-mfa-enrollment";
import { AdminLogin } from "../components/admin/admin-login";

const qrCode = "data:image/svg+xml;utf8,mock-only-qr";
const secret = "mock-only-not-a-totp-secret";
const ownName = "Hablemos por Ellos";

function factor(id: string, overrides: Partial<Factor> = {}): Factor {
  return {
    id, factor_type: "totp", status: "unverified", friendly_name: ownName,
    created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z", ...overrides,
  };
}

function listed(all: Factor[]): AuthMFAListFactorsResponse {
  return { data: {
    all,
    totp: all.filter((item): item is Factor<"totp", "verified"> => item.factor_type === "totp" && item.status === "verified"),
    phone: [], webauthn: [], recovery_code: [],
  }, error: null };
}

function enrolled(friendly_name?: string): AuthMFAEnrollTOTPResponse {
  return { data: { id: "new-mock-factor", type: "totp", friendly_name,
    totp: { qr_code: qrCode, secret, uri: "mock-only-uri" } }, error: null };
}

function mfaFixture(all: Factor[] = []) {
  return {
    listFactors: vi.fn<GoTrueMFAApi["listFactors"]>().mockResolvedValue(listed(all)),
    unenroll: vi.fn<GoTrueMFAApi["unenroll"]>().mockImplementation(async ({ factorId }) => ({ data: { id: factorId }, error: null })),
    enroll: vi.fn<(parameters: MFAEnrollTOTPParams) => Promise<AuthMFAEnrollTOTPResponse>>()
      .mockImplementation(async ({ friendlyName }) => enrolled(friendlyName)),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("admin TOTP interrupted-enrollment recovery (SDK-shaped mocks only)", () => {
  it("cleans legacy own unverified TOTP from .all before creating a fresh QR", async () => {
    const mfa = mfaFixture([factor("interrupted")]);
    expect((await mfa.listFactors()).data?.totp).toEqual([]);
    const result = await prepareAdminTotp(mfa);
    expect(mfa.unenroll).toHaveBeenCalledExactlyOnceWith({ factorId: "interrupted" });
    expect(mfa.unenroll.mock.invocationCallOrder[0]).toBeLessThan(mfa.enroll.mock.invocationCallOrder[0]);
    expect(result).toEqual({ stage: "enroll", factorId: "new-mock-factor", qrCode, secret });
    expect(mfa.enroll).toHaveBeenCalledWith({
      factorType: "totp", issuer: "Fundacion Hablemos por Ellos",
      friendlyName: expect.stringMatching(/^Hablemos por Ellos \([0-9a-f-]{36}\)$/),
    });
  });

  it("recovers its uniquely named pending enrollment on another retry", async () => {
    const mfa = mfaFixture();
    await prepareAdminTotp(mfa);
    const firstName = mfa.enroll.mock.calls[0][0].friendlyName!;
    mfa.listFactors.mockResolvedValue(listed([factor("retry-pending", { friendly_name: firstName })]));
    await prepareAdminTotp(mfa);
    expect(mfa.unenroll).toHaveBeenCalledExactlyOnceWith({ factorId: "retry-pending" });
    expect(mfa.enroll.mock.calls[1][0].friendlyName).not.toBe(firstName);
  });

  it.each([ownName, "Personal authenticator"])("retains a verified factor named %s and requires verification", async (friendly_name) => {
    const mfa = mfaFixture([factor("verified", { status: "verified", friendly_name }), factor("own-pending")]);
    expect(await prepareAdminTotp(mfa)).toEqual({ stage: "verify", factorId: "verified" });
    expect(mfa.unenroll).not.toHaveBeenCalled();
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  it("retains all other pending factors, including lookalike names and non-TOTP", async () => {
    const others = [
      factor("personal", { friendly_name: "Personal authenticator" }),
      factor("unnamed", { friendly_name: undefined }),
      factor("lookalike", { friendly_name: "Hablemos por Ellos (backup)" }),
      factor("phone", { factor_type: "phone" }),
      factor("webauthn", { factor_type: "webauthn" }),
      factor("recovery", { factor_type: "recovery_code" }),
    ];
    const mfa = mfaFixture([...others, factor("own-pending")]);
    await prepareAdminTotp(mfa);
    expect(mfa.unenroll).toHaveBeenCalledExactlyOnceWith({ factorId: "own-pending" });
    const foreignOnly = mfaFixture(others);
    await prepareAdminTotp(foreignOnly);
    expect(foreignOnly.unenroll).not.toHaveBeenCalled();
    expect(foreignOnly.enroll).toHaveBeenCalledOnce();
  });

  it("fails closed on factor-list errors without cleanup or enrollment", async () => {
    const mfa = mfaFixture([factor("pending")]);
    mfa.listFactors.mockResolvedValue({ data: null, error: new AuthError("mock list failure") });
    await expect(prepareAdminTotp(mfa)).rejects.toThrow("MFA_FACTORS_UNAVAILABLE");
    expect(mfa.unenroll).not.toHaveBeenCalled();
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  it.each(["error", "missing", "wrong-id"])("fails closed on %s cleanup response without creating a new factor", async (kind) => {
    const mfa = mfaFixture([factor("pending")]);
    const response = kind === "error" ? { data: null, error: new AuthError("mock cleanup failure") }
      : kind === "wrong-id" ? { data: { id: "another-factor" }, error: null } : { data: null, error: null };
    // Deliberately malformed server response, outside the SDK's declared success type.
    mfa.unenroll.mockResolvedValue(response as AuthMFAUnenrollResponse);
    await expect(prepareAdminTotp(mfa)).rejects.toThrow("MFA_CLEANUP_FAILED");
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  it("stops at the first failed cleanup and never enrolls after partial cleanup", async () => {
    const mfa = mfaFixture([factor("first"), factor("second"), factor("third")]);
    mfa.unenroll.mockResolvedValueOnce({ data: { id: "first" }, error: null })
      .mockResolvedValueOnce({ data: null, error: new AuthError("mock cleanup failure") });
    await expect(prepareAdminTotp(mfa)).rejects.toThrow("MFA_CLEANUP_FAILED");
    expect(mfa.unenroll).toHaveBeenCalledTimes(2);
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  it("does not enroll if cleanup throws", async () => {
    const mfa = mfaFixture([factor("pending")]);
    mfa.unenroll.mockRejectedValue(new Error("mock transport failure"));
    await expect(prepareAdminTotp(mfa)).rejects.toThrow();
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  it("rejects incomplete TOTP enrollment instead of returning a verification stage", async () => {
    const mfa = mfaFixture();
    mfa.enroll.mockResolvedValue({ data: { id: "new-mock-factor", type: "totp", totp: { qr_code: "", secret: "", uri: "" } }, error: null });
    await expect(prepareAdminTotp(mfa)).rejects.toThrow("MFA_ENROLLMENT_FAILED");
  });

  it("never logs QR/secret values on success or SDK error", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => {}));
    const mfa = mfaFixture();
    await prepareAdminTotp(mfa);
    mfa.enroll.mockResolvedValue({ data: null, error: new AuthError(`${qrCode} ${secret}`) });
    await expect(prepareAdminTotp(mfa)).rejects.toThrow("MFA_ENROLLMENT_FAILED");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("AdminLogin mock bootstrap and MFA contract", () => {
  let mfa: ReturnType<typeof mfaFixture>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let challengeAndVerify: ReturnType<typeof vi.fn>;
  let signOut: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mfa = mfaFixture();
    challengeAndVerify = vi.fn().mockResolvedValue({ error: null });
    signOut = vi.fn().mockResolvedValue({ error: null });
    ui.browser.mockReturnValue({ auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ error: null }), signOut,
      mfa: { ...mfa, challengeAndVerify, getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
        data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null,
      }) },
    } });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authorized: true }) });
    vi.stubGlobal("fetch", fetchMock);
  });

  function submitMockSignIn() {
    // Submit the handler with an entirely mocked Auth transport; no credential fixture is needed.
    fireEvent.submit(screen.getByRole("button", { name: "Continuar" }).closest("form")!);
  }

  it("restarts interrupted onboarding after bootstrap and recovers again after a remount", async () => {
    mfa.listFactors.mockResolvedValue(listed([factor("legacy-pending")]));
    const first = render(createElement(AdminLogin, { authEnabled: true }));
    submitMockSignIn();
    await screen.findByAltText("Codigo QR para configurar Google Authenticator");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/bootstrap", { method: "POST" });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(mfa.listFactors.mock.invocationCallOrder[0]);
    const firstName = mfa.enroll.mock.calls[0][0].friendlyName!;
    first.unmount();
    mfa.listFactors.mockResolvedValue(listed([factor("reload-pending", { friendly_name: firstName })]));
    render(createElement(AdminLogin, { authEnabled: true }));
    submitMockSignIn();
    await screen.findByAltText("Codigo QR para configurar Google Authenticator");
    expect(mfa.unenroll.mock.calls).toEqual([[{ factorId: "legacy-pending" }], [{ factorId: "reload-pending" }]]);
    expect(mfa.enroll.mock.calls[1][0].friendlyName).not.toBe(firstName);
    expect(ui.replace).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("never lists, deletes or enrolls factors when bootstrap authorization fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ authorized: false }) });
    render(createElement(AdminLogin, { authEnabled: true }));
    submitMockSignIn();
    await screen.findByRole("alert");
    expect(signOut).toHaveBeenCalledOnce();
    expect(mfa.listFactors).not.toHaveBeenCalled();
    expect(mfa.unenroll).not.toHaveBeenCalled();
    expect(mfa.enroll).not.toHaveBeenCalled();
    expect(ui.replace).not.toHaveBeenCalled();
  });

  it("retains verified TOTP and waits for its code without enrolling or granting access", async () => {
    mfa.listFactors.mockResolvedValue(listed([factor("verified", { status: "verified" }), factor("pending")]));
    render(createElement(AdminLogin, { authEnabled: true }));
    submitMockSignIn();
    await screen.findByLabelText("Codigo de Google Authenticator");
    expect(screen.queryByAltText("Codigo QR para configurar Google Authenticator")).not.toBeInTheDocument();
    expect(mfa.unenroll).not.toHaveBeenCalled();
    expect(mfa.enroll).not.toHaveBeenCalled();
    expect(ui.replace).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("keeps cleanup failures closed with a generic UI error and no QR/secret logs", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => {}));
    mfa.listFactors.mockResolvedValue(listed([factor("pending")]));
    mfa.unenroll.mockResolvedValue({ data: null, error: new AuthError(`${qrCode} ${secret}`) });
    render(createElement(AdminLogin, { authEnabled: true }));
    submitMockSignIn();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No fue posible iniciar sesion");
    expect(alert).not.toHaveTextContent(secret);
    expect(alert).not.toHaveTextContent(qrCode);
    expect(mfa.enroll).not.toHaveBeenCalled();
    expect(ui.replace).not.toHaveBeenCalled();
    expect(screen.queryByAltText("Codigo QR para configurar Google Authenticator")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continuar" })).not.toBeDisabled());
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
