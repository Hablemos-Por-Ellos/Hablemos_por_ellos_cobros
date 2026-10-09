import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getServiceSupabaseClient } from "@/lib/supabase-server";

function isAuthorized(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = Buffer.from(auth.slice("Bearer ".length));
  const expectedToken = Buffer.from(expected);
  return token.length === expectedToken.length && crypto.timingSafeEqual(token, expectedToken);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServiceSupabaseClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, message: "Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." },
      { status: 500 }
    );
  }

  // Query liviana para generar actividad: lee 1 fila de una tabla existente
  const { error } = await supabase.from("subscriptions").select("id").limit(1);

  if (error) {
    return NextResponse.json({ ok: false, message: "No se pudo verificar la base de datos." }, { status: 500 });
  }

  // Activity checks never delete history or call a revoked v1 financial writer.
  return NextResponse.json({ ok: true }, { status: 200 });
}
