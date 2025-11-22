import { NextResponse } from "next/server";
import { getServiceSupabaseClient } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  if (!payload) {
    return NextResponse.json({ message: "Solicitud inválida" }, { status: 400 });
  }

  const supabase = getServiceSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ message: "Webhook recibido en modo demostración" }, { status: 200 });
  }

  await supabase.from("webhook_events").insert({ raw: payload });

  // TODO: actualizar tabla payments/subscriptions según evento real de Wompi.

  return NextResponse.json({ message: "Evento registrado" }, { status: 200 });
}
