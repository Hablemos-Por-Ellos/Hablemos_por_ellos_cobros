import { NextResponse } from "next/server";
import { subscriptionPayloadSchema } from "@/lib/schemas";
import { getServiceSupabaseClient } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);

  const parsed = subscriptionPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ message: "Información inválida", issues: parsed.error.issues }, { status: 400 });
  }

  const { stage, donor, amount, paymentMethod, wompi } = parsed.data;
  const isRecurring = donor.isRecurring ?? true;
  const supabase = getServiceSupabaseClient();

  if (!supabase) {
    return NextResponse.json(
      {
        message: "Modo demostración: configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY para guardar en base de datos.",
        status: stage === "draft" ? "draft_saved" : "subscription_created",
      },
      { status: 200 }
    );
  }

  const donorPayload = {
    email: donor.email,
    first_name: donor.firstName,
    last_name: donor.lastName,
    phone: donor.phone,
    document_type: donor.documentType,
    document_number: donor.documentNumber,
    city: donor.city,
    wants_updates: donor.wantsUpdates,
  };

  const { data: donorRecord, error: donorError } = await supabase
    .from("donors")
    .upsert(donorPayload, { onConflict: "email" })
    .select()
    .single();

  if (donorError) {
    return NextResponse.json({ message: donorError.message }, { status: 500 });
  }

  if (stage === "draft") {
    return NextResponse.json({ status: "draft_saved", donorId: donorRecord.id, isRecurring });
  }

  const reference =
    wompi?.reference ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const { data: subscription, error: subscriptionError } = await supabase
    .from("subscriptions")
    .insert({
      donor_id: donorRecord.id,
      amount,
      currency: "COP",
      frequency: isRecurring ? "monthly" : "one_time",
      status: "active",
      payment_method_type: paymentMethod,
      wompi_payment_source_id: wompi?.paymentSourceId ?? wompi?.token ?? null,
      wompi_masked_details: wompi?.maskedDetails ?? null,
      reference,
    })
    .select()
    .single();

  if (subscriptionError) {
    return NextResponse.json({ message: subscriptionError.message }, { status: 500 });
  }

  // Crear registro inicial en payments cuando se confirma la donación
  const wompiTransactionId = wompi?.token ?? wompi?.paymentSourceId ?? null;
  if (wompiTransactionId) {
    const { error: paymentError } = await supabase.from("payments").insert({
      subscription_id: subscription.id,
      amount,
      currency: "COP",
      status: "approved", // El widget solo llama onAuthorized si el pago fue aprobado
      wompi_transaction_id: wompiTransactionId,
    });

    if (paymentError) {
      // Log pero no bloquear - la suscripción ya se creó
      console.error("Error creando payment:", paymentError.message);
    }
  }

  return NextResponse.json({ status: "subscription_created", subscriptionId: subscription.id });
}
