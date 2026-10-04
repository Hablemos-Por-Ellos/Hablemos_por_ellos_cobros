import { redirect } from "next/navigation";
import { getServerAuthSupabaseClient, isServerAuthEnvironmentAllowed } from "@/lib/supabase-auth-server";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { getAppOperationMode, isAdminDemoModeAllowed } from "@/lib/operation-mode";
import { z } from "zod";

export type AdminRole = "admin" | "super_admin";

export type AdminContext = {
  userId: string;
  email: string;
  role: AdminRole;
} & ({ demo: true } | { demo: false; aal: "aal2"; sessionIssuedAt: string });

export function isAdminDemoMode() {
  return isAdminDemoModeAllowed() && process.env.ADMIN_DEMO_MODE === "true";
}

export async function isAdminSchemaReady() {
  if (getAppOperationMode() === "demo") return false;
  try {
    if (!(await isServerAuthEnvironmentAllowed())) return false;
    const service = getServiceSupabaseClient();
    if (!service) return false;
    const { data, error } = await service.rpc("payment_admin_schema_ready");
    return !error && data === true;
  } catch { return false; }
}

export async function getVerifiedAdminIdentity() {
  const supabase = await getServerAuthSupabaseClient();
  if (!supabase) return null;
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user || !z.string().uuid().safeParse(userData.user.id).success) return null;
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || claims.sub !== userData.user.id
    || !Number.isInteger(claims.iat) || !Number.isFinite(claims.exp)
    || Number(claims.iat) * 1000 > Date.now()
    || Number(claims.exp) * 1000 <= Date.now()
    || !["aal1", "aal2"].includes(String(claims.aal))) return null;
  return { supabase, user: userData.user, claims };
}

export function isActiveAdminRecord(admin: unknown, issuedAt: number) {
  const record = z.object({
    role: z.enum(["admin", "super_admin"]), active: z.literal(true),
    sessions_valid_after: z.string().datetime({ offset: true }),
  }).safeParse(admin);
  return record.success && issuedAt * 1000 > Date.parse(record.data.sessions_valid_after)
    ? record.data : null;
}

// AAL1 permits onboarding and revoking one's own sessions, never business mutations.
export async function getAdminBootstrapContext() {
  if (!(await isAdminSchemaReady())) return null;
  const identity = await getVerifiedAdminIdentity();
  if (!identity) return null;
  const service = getServiceSupabaseClient();
  if (!service) return null;
  const { data, error } = await service.from("admin_users")
    .select("role, active, sessions_valid_after").eq("user_id", identity.user.id).maybeSingle();
  const admin = !error && isActiveAdminRecord(data, Number(identity.claims.iat));
  return admin ? { ...identity, role: admin.role } : null;
}

export async function getAdminContext(): Promise<AdminContext | null> {
  if (isAdminDemoMode()) {
    return { userId: "local-demo-admin", email: "admin@example.test", role: "super_admin", demo: true };
  }
  if (!(await isAdminSchemaReady())) return null;

  const identity = await getVerifiedAdminIdentity();
  if (!identity || identity.claims.aal !== "aal2") return null;
  const { supabase, user, claims } = identity;

  const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError || aal?.currentLevel !== "aal2") return null;

  const { data: admin, error: adminError } = await supabase
    .from("admin_users")
    .select("role, active, sessions_valid_after")
    .eq("user_id", user.id)
    .maybeSingle();

  const activeAdmin = !adminError && isActiveAdminRecord(admin, Number(claims.iat));
  if (!activeAdmin) return null;

  return {
    userId: user.id,
    email: user.email ?? "",
    role: activeAdmin.role,
    demo: false,
    aal: "aal2",
    sessionIssuedAt: new Date(Number(claims.iat) * 1000).toISOString(),
  };
}

export async function requireAdminPage() {
  const context = await getAdminContext();
  if (!context) redirect("/admin/login");
  return context;
}

export async function verifyRecentTotp(code: string) {
  if (isAdminDemoMode()) return false;
  if (!/^\d{6}$/.test(code)) return false;
  if (!(await getAdminContext())) return false;

  const supabase = await getServerAuthSupabaseClient();
  if (!supabase) return false;

  const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError || !factors) return false;
  const factor = factors.totp.find((item) => item.status === "verified");
  if (!factor) return false;

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  return !error && !!(await getAdminContext());
}

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const source = new URL(origin);
    const target = new URL(request.url);
    if (!["http:", "https:"].includes(source.protocol) || !["http:", "https:"].includes(target.protocol)
      || source.origin !== origin) return false;
    const host = request.headers.get("host");
    if (!host || /[\s\\/?#@,]/.test(host)) return false;
    const forwardedHost = request.headers.get("x-forwarded-host");
    if (forwardedHost !== null && forwardedHost.toLowerCase() !== host.toLowerCase()) return false;
    const forwardedProtocol = request.headers.get("x-forwarded-proto");
    if (forwardedProtocol !== null && !["http", "https"].includes(forwardedProtocol)) return false;
    const production = process.env.VERCEL_ENV === "production";
    if (production && (source.protocol !== "https:" || forwardedProtocol !== null && forwardedProtocol !== "https")) return false;
    const localLab = !production && process.env.HPE_LOCAL_INTEGRATION === "true";
    if (localLab && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${host}`).hostname)) return false;
    // Host identifies the browser target; Next can use an internal hostname.
    const protocol = production ? "https:" : localLab ? "http:" : target.protocol;
    if (!production && forwardedProtocol !== null && `${forwardedProtocol}:` !== protocol) return false;
    return source.origin === new URL(`${protocol}//${host}`).origin;
  } catch {
    return false;
  }
}
