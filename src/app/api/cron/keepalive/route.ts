import { NextResponse } from "next/server";
import { getServiceSupabaseClient } from "@/lib/supabase-server";

function isAuthorized(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
  return token === expected;
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
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
