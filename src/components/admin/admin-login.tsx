"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { getBrowserSupabaseClient } from "@/lib/supabase-auth-browser";
import { prepareAdminTotp } from "@/lib/admin-mfa-enrollment";
import { BuildIdentity } from "@/components/build-identity";

type Stage = "credentials" | "password" | "verify" | "enroll";

class AdminAuthorizationError extends Error {}

export function AdminLogin({ activation = false, authEnabled = false, deploymentEnvironment }: { activation?: boolean; authEnabled?: boolean; deploymentEnvironment?: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(activation ? "password" : "credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const getAuthClient = () => getBrowserSupabaseClient(deploymentEnvironment);

  function clearMfaState() {
    setFactorId(null);
    setQrCode(null);
    setSecret(null);
    setCode("");
  }

  async function ensureAllowlisted() {
    const response = await fetch("/api/admin/bootstrap", { method: "POST" });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.authorized !== true) {
      clearMfaState();
      setStage("credentials");
      try { await getAuthClient().auth.signOut(); } catch { /* Server authorization remains mandatory. */ }
      throw new AdminAuthorizationError("Esta cuenta no esta autorizada para administrar la fundacion.");
    }
  }

  async function continueWithMfa() {
    if (!authEnabled) return;
    const supabase = getAuthClient();
    await ensureAllowlisted();

    const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError || !aal) throw new Error("MFA_UNAVAILABLE");
    if (aal?.currentLevel === "aal2") {
      router.replace("/admin");
      router.refresh();
      return;
    }

    const next = await prepareAdminTotp(supabase.auth.mfa);
    setFactorId(next.factorId);
    setQrCode(next.stage === "enroll" ? next.qrCode : null);
    setSecret(next.stage === "enroll" ? next.secret : null);
    setCode("");
    setStage(next.stage);
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    if (!authEnabled || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { error: signInError } = await getAuthClient().auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      await continueWithMfa();
    } catch (failure) {
      setError(failure instanceof AdminAuthorizationError
        ? failure.message : "No fue posible iniciar sesion. Revisa tus credenciales y autorizacion.");
    } finally {
      setPassword("");
      setLoading(false);
    }
  }

  async function verifyMfa(event: React.FormEvent) {
    event.preventDefault();
    if (!authEnabled || loading || !factorId || !/^\d{6}$/.test(code)) return;
    setLoading(true);
    setError(null);
    let verified = false;
    try {
      const { error: verifyError } = await getAuthClient().auth.mfa.challengeAndVerify({ factorId, code });
      if (verifyError) throw verifyError;
      verified = true;
      clearMfaState();
      await ensureAllowlisted();
      router.replace("/admin");
      router.refresh();
    } catch (failure) {
      if (verified) {
        clearMfaState();
        setStage("credentials");
      }
      setError(failure instanceof AdminAuthorizationError
        ? failure.message : verified
          ? "No pudimos confirmar tu acceso. Inicia sesion nuevamente para continuar."
          : "El codigo no es valido o ya vencio. Usa el codigo actual de Google Authenticator.");
    } finally {
      setLoading(false);
    }
  }

  async function setOwnPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!authEnabled || loading) return;
    setLoading(true);
    setError(null);
    let passwordSaved = false;
    try {
      const response = await fetch("/api/admin/activation/password", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
      });
      if (!response.ok) throw new Error("ACTIVATION_FAILED");
      passwordSaved = true;
      setPassword("");
      await continueWithMfa();
    } catch (failure) {
      if (passwordSaved) {
        clearMfaState();
        setStage("credentials");
      }
      setError(failure instanceof AdminAuthorizationError ? failure.message
        : passwordSaved ? "Tu contrasena quedo guardada. No pudimos preparar Google Authenticator; inicia sesion con ella para continuar."
          : "No se pudo activar el acceso. La invitacion puede haber vencido.");
    } finally { setLoading(false); }
  }

  if (!authEnabled) return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-100 p-6">
      <section className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-bold">{activation ? "Invitacion no disponible" : "Acceso no disponible"}</h1>
        <p role="alert" className="mt-3 text-sm text-slate-600">{activation ? "El enlace vencio, ya fue usado o no esta autorizado." : "El entorno administrativo no esta habilitado."}</p>
        <footer className="mt-6 border-t border-slate-200 pt-4"><BuildIdentity /></footer>
      </section>
    </main>
  );

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-100 px-4 py-10">
      <section className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex h-11 w-11 items-center justify-center rounded-md bg-blue-50 text-foundation-blue">
          <ShieldCheck aria-hidden="true" className="h-6 w-6" />
        </div>
        <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-foundation-blue">Acceso restringido</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-950">Panel administrativo</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Solo las cuentas autorizadas pueden ingresar. No existe registro publico.
        </p>

        {stage === "password" ? (
          <form onSubmit={setOwnPassword} className="mt-7 space-y-4">
            <label className="block text-sm font-semibold text-slate-700">Nueva contrasena
              <input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3" />
            </label>
            <button type="submit" disabled={loading} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-foundation-blue px-4 font-bold text-white disabled:opacity-50"><KeyRound className="h-4 w-4" />Activar acceso</button>
          </form>
        ) : stage === "credentials" ? (
          <form onSubmit={signIn} className="mt-7 space-y-4">
            <label className="block text-sm font-semibold text-slate-700">
              Correo
              <input type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 text-base focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20" />
            </label>
            <label className="block text-sm font-semibold text-slate-700">
              Contrasena
              <input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 text-base focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20" />
            </label>
            <button type="submit" disabled={loading} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-foundation-blue px-4 text-sm font-bold text-white disabled:opacity-60">
              {loading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <LogIn aria-hidden="true" className="h-4 w-4" />}
              Continuar
            </button>
          </form>
        ) : (
          <form onSubmit={verifyMfa} className="mt-7 space-y-5">
            {stage === "enroll" && qrCode && (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-center">
                <p className="text-sm font-semibold text-slate-900">Escanea este QR una sola vez con Google Authenticator</p>
                {/* Supabase returns a data URI/SVG generated for this authenticated enrollment. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrCode} alt="Codigo QR para configurar Google Authenticator" className="mx-auto mt-4 h-48 w-48 bg-white p-2" />
                {secret && <p className="mt-3 break-all text-xs text-slate-600">Clave manual: <span className="font-mono">{secret}</span></p>}
              </div>
            )}
            <label className="block text-sm font-semibold text-slate-700">
              Codigo de Google Authenticator
              <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="mt-2 h-12 w-full rounded-md border border-slate-300 px-3 text-center text-xl font-bold tracking-[0.35em] focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20" />
            </label>
            <button type="submit" disabled={loading || code.length !== 6} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-foundation-blue px-4 text-sm font-bold text-white disabled:opacity-60">
              {loading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <KeyRound aria-hidden="true" className="h-4 w-4" />}
              Verificar e ingresar
            </button>
          </form>
        )}

        {error && <p role="alert" className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
        <footer className="mt-6 border-t border-slate-200 pt-4"><BuildIdentity /></footer>
      </section>
    </main>
  );
}
