import { NextResponse } from "next/server";
import { z } from "zod";
import { isSameOriginRequest } from "@/lib/admin-auth";
import { getAdminActivationContext } from "@/lib/admin-auth-invitation";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ ok: false }, { status: 403 });
  const admin = await getAdminActivationContext();
  if (!admin) return NextResponse.json({ ok: false, message: "Invitacion vencida, usada o no autorizada." }, { status: 403 });
  const input = z.object({ password: z.string().min(12).max(128) }).strict().safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ ok: false, message: "La contrasena debe tener entre 12 y 128 caracteres." }, { status: 400 });
  const { error } = await admin.supabase.auth.updateUser({ password: input.data.password });
  return NextResponse.json({ ok: !error }, { status: error ? 502 : 200, headers: { "Cache-Control": "no-store" } });
}
