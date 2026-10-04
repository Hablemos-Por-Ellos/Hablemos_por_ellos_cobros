import { NextResponse } from "next/server";
import { z } from "zod";
import { hashCheckoutToken } from "@/lib/checkout-security";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { createWompiIntegritySignature } from "@/lib/wompi-server";
import { WOMPI_ENV } from "@/lib/wompi";
import { financialOperationsEnabled } from "@/lib/operation-mode";
import { paymentSchemaReady } from "@/lib/payment-schema";

const requestSchema = z.object({
  checkoutToken: z.string().min(32).max(256),
  reference: z.string().min(8).max(100),
});

export async function POST(request: Request) {
  if (!financialOperationsEnabled()) return NextResponse.json({ message: "Pagos temporalmente en mantenimiento." }, { status: 503 });
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "Solicitud invalida." }, { status: 400 });

  const supabase = getServiceSupabaseClient();
  if (!supabase) return NextResponse.json({ message: "Servicio de datos no configurado." }, { status: 503 });
  if (!(await paymentSchemaReady(supabase))) return NextResponse.json({ message: "Servicio de pagos en preparacion." }, { status: 503 });

  try {
    const { data, error } = await supabase
      .from("checkout_intents")
      .select("reference, amount, currency, environment, expires_at")
      .eq("reference", parsed.data.reference)
      .eq("secret_hash", hashCheckoutToken(parsed.data.checkoutToken))
      .maybeSingle();

    if (error || !data || data.environment !== WOMPI_ENV || new Date(data.expires_at).getTime() <= Date.now()) {
      return NextResponse.json({ message: "La sesion de pago no es valida." }, { status: 403 });
    }

    return NextResponse.json({
      reference: data.reference,
      amountInCents: data.amount * 100,
      currency: data.currency,
      signature: createWompiIntegritySignature(data.reference, data.amount * 100, data.currency),
    });
  } catch {
    return NextResponse.json({ message: "No fue posible preparar la firma." }, { status: 500 });
  }
}
