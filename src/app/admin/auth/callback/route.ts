import { NextResponse } from "next/server";
import { activateAdminInvitation } from "@/lib/admin-auth-invitation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  let activated = false;
  if (url.searchParams.get("type") === "invite") {
    try { activated = await activateAdminInvitation(url.searchParams.get("token_hash") ?? ""); } catch { /* Fail closed. */ }
  }
  const response = NextResponse.redirect(new URL(activated ? "/admin/activar" : "/admin/activar?error=invalid", url.origin));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
