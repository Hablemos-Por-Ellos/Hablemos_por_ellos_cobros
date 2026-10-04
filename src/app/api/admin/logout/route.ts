import { NextResponse } from "next/server";
import { clearServerAuthCookies, getServerAuthSupabaseClient } from "@/lib/supabase-auth-server";
import { getAdminBootstrapContext, isSameOriginRequest } from "@/lib/admin-auth";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { getAppOperationMode } from "@/lib/operation-mode";

const noRevocation = { ok: false, jwtRevocationConfirmed: false, authSignOutConfirmed: false, cookiesCleared: false };
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ ...noRevocation, message: "Origen no permitido." }, { status: 403, headers });
  if (getAppOperationMode() === "demo") return NextResponse.json({ ...noRevocation, message: "Demo desconectada: no hay una sesion real que revocar." }, { status: 403, headers });

  let admin: Awaited<ReturnType<typeof getAdminBootstrapContext>> = null;
  let jwtRevocationConfirmed = false;
  let failureStatus = 403;
  try {
    admin = await getAdminBootstrapContext();
    if (admin) {
      failureStatus = 503;
      const service = getServiceSupabaseClient();
      if (service) {
        const { data, error } = await service.rpc("admin_revoke_own_sessions", {
          p_actor_user_id: admin.user.id,
          p_actor_session_issued_at: new Date(Number(admin.claims.iat) * 1000).toISOString(),
        });
        jwtRevocationConfirmed = !error && data === true;
      }
    }
  } catch { failureStatus = 503; }

  let authSignOutConfirmed = false;
  try {
    const supabase = admin?.supabase ?? await getServerAuthSupabaseClient();
    if (supabase) {
      const { error } = await supabase.auth.signOut({ scope: "global" });
      authSignOutConfirmed = !error;
    }
  } catch { /* Cookie cleanup is independent of Auth/network failures. */ }
  const cookiesCleared = await clearServerAuthCookies();
  const ok = jwtRevocationConfirmed && authSignOutConfirmed && cookiesCleared;
  let message = "Sesiones revocadas y sesion local cerrada.";
  if (!jwtRevocationConfirmed) {
    message = `${cookiesCleared ? "Cookies locales eliminadas." : "No se confirmo la eliminacion de cookies."} No se confirmo la revocacion de JWT: un token retenido podria seguir activo hasta vencer. Se requiere revision administrativa.`;
  } else if (!authSignOutConfirmed) {
    message = `JWT anteriores revocados. No se confirmo la invalidacion de sesiones de Auth. ${cookiesCleared ? "Cookies locales eliminadas." : "No se confirmo la eliminacion de cookies."}`;
  } else if (!cookiesCleared) {
    message = "JWT anteriores revocados y sesiones de Auth invalidadas; no se confirmo la eliminacion de cookies locales.";
  }
  return NextResponse.json({ ok, jwtRevocationConfirmed, authSignOutConfirmed, cookiesCleared, message }, {
    status: ok ? 200 : jwtRevocationConfirmed ? 502 : failureStatus, headers,
  });
}
