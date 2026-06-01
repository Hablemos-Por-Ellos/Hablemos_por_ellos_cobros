import { NextResponse } from "next/server";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { getWompiEventsSecret } from "@/lib/wompi";
import {
  extractPaymentSourceId,
  isValidWompiEventChecksum,
  type WompiEventPayload,
  type WompiTransaction,
} from "@/lib/wompi-webhook";

function addOneMonthKeepingDay(base: Date) {
  const targetDay = base.getDate();
  const candidate = new Date(base);
  candidate.setMonth(candidate.getMonth() + 1, 1);
  const daysInTargetMonth = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
  candidate.setDate(Math.min(targetDay, daysInTargetMonth));
  return candidate;
}

function subscriptionStatusFromTransaction(status: string) {
  if (status === "approved") return "active";
  if (status === "declined" || status === "error" || status === "voided") return "past_due";
  if (status === "pending") return "pending";
  return null;
}

export async function POST(request: Request) {
  const rawBody = await request.text().catch(() => "");
  if (!rawBody) {
    return NextResponse.json({ message: "Solicitud invalida" }, { status: 400 });
  }

  let payload: WompiEventPayload;
  try {
    payload = JSON.parse(rawBody) as WompiEventPayload;
  } catch {
    return NextResponse.json({ message: "JSON invalido" }, { status: 400 });
  }

  const wompiSecret = getWompiEventsSecret();
  if (!wompiSecret) {
    return NextResponse.json({ message: "Configura WOMPI_EVENTS_SECRET para validar webhooks" }, { status: 500 });
  }

  if (!isValidWompiEventChecksum(payload, request.headers.get("x-event-checksum"), wompiSecret)) {
    return NextResponse.json({ message: "Firma invalida" }, { status: 401 });
  }

  const transaction = payload?.data?.transaction as WompiTransaction | undefined;
  const supabase = getServiceSupabaseClient();
  const allowDemo = process.env.ALLOW_DEMO_MODE === "true" || process.env.NODE_ENV !== "production";

  if (!supabase) {
    if (allowDemo) {
      return NextResponse.json({ message: "Webhook recibido en modo demostracion" }, { status: 200 });
    }
    return NextResponse.json(
      { message: "Configuracion invalida en produccion: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 }
    );
  }

  const tx = transaction;
  const paymentSourceId = tx ? extractPaymentSourceId(tx) : null;
  const wompiTransactionId = tx?.id ?? null;
  const amountInCents = tx?.amount_in_cents ?? tx?.amountInCents ?? null;
  const amountCop = typeof amountInCents === "number" ? Math.round(amountInCents / 100) : null;
  const status = (tx?.status ?? "").toLowerCase();
  const reference = tx?.reference ?? null;
  const eventType = payload?.event ?? null;

  const sanitizedEvent = {
    transaction_id: wompiTransactionId,
    event_type: eventType,
    event: eventType,
    environment: (payload as Record<string, unknown>)?.environment ?? null,
    transaction: tx
      ? {
          id: tx.id,
          status: tx.status,
          reference: tx.reference,
          amount_in_cents: amountInCents,
          currency: tx.currency,
          payment_source_id: paymentSourceId,
          payment_method_type: tx.payment_method_type ?? tx.paymentMethodType ?? tx.payment_method?.type ?? tx.paymentMethod?.type,
        }
      : null,
    timestamp: payload.timestamp ?? null,
    received_at: new Date().toISOString(),
  };

  const { error: logError } = await supabase.from("webhook_events").insert({
    transaction_id: wompiTransactionId,
    event_type: eventType,
    raw: sanitizedEvent,
  });

  if (logError && logError.code !== "23505") {
    return NextResponse.json(
      { message: "No se pudo registrar el evento", details: logError?.message ?? "unknown" },
      { status: 500 }
    );
  }

  if (!tx?.id) {
    return NextResponse.json({ message: "Evento guardado sin transaccion" }, { status: 200 });
  }

  let subscriptionId: string | null = null;

  if (paymentSourceId) {
    const { data: subBySource } = await supabase
      .from("subscriptions")
      .select("id")
      .eq("wompi_payment_source_id", paymentSourceId)
      .maybeSingle();
    subscriptionId = subBySource?.id ?? null;
  }

  if (!subscriptionId && reference) {
    const { data: subByRef } = await supabase
      .from("subscriptions")
      .select("id")
      .eq("reference", reference)
      .maybeSingle();
    subscriptionId = subByRef?.id ?? null;
  }

  if (!subscriptionId) {
    return NextResponse.json({ message: "Evento guardado sin suscripcion relacionada" }, { status: 200 });
  }

  const { data: existingPayment, error: paymentLookupError } = await supabase
    .from("payments")
    .select("id")
    .eq("wompi_transaction_id", wompiTransactionId)
    .maybeSingle();

  if (paymentLookupError) {
    return NextResponse.json(
      { message: "Error consultando pagos", details: paymentLookupError?.message ?? "unknown" },
      { status: 500 }
    );
  }

  const paymentPayload = {
    subscription_id: subscriptionId,
    amount: amountCop,
    currency: tx.currency ?? "COP",
    status,
    wompi_transaction_id: wompiTransactionId,
  };

  const paymentMutation = existingPayment?.id
    ? supabase.from("payments").update(paymentPayload).eq("id", existingPayment.id)
    : supabase.from("payments").insert(paymentPayload);

  const { error: paymentError } = await paymentMutation;
  if (paymentError) {
    return NextResponse.json(
      { message: "No se pudo guardar el pago", details: paymentError?.message ?? "unknown" },
      { status: 500 }
    );
  }

  const subscriptionStatus = subscriptionStatusFromTransaction(status);
  if (subscriptionStatus) {
    const updates: Record<string, unknown> = { status: subscriptionStatus };
    if (paymentSourceId) updates.wompi_payment_source_id = paymentSourceId;

    if (subscriptionStatus === "active") {
      const { data: subscription, error: fetchSubError } = await supabase
        .from("subscriptions")
        .select("next_payment_date, processed_transaction_ids")
        .eq("id", subscriptionId)
        .maybeSingle();

      if (!fetchSubError) {
        const processedIds = Array.isArray(subscription?.processed_transaction_ids)
          ? subscription.processed_transaction_ids
          : [];

        const shouldScheduleNextPayment =
          !subscription?.next_payment_date || !processedIds.includes(wompiTransactionId);

        if (shouldScheduleNextPayment) {
          const baseDate =
            subscription?.next_payment_date && !processedIds.includes(wompiTransactionId)
              ? new Date(subscription.next_payment_date as unknown as string)
              : new Date();
          updates.next_payment_date = addOneMonthKeepingDay(baseDate).toISOString();
          updates.processed_transaction_ids = processedIds.includes(wompiTransactionId)
            ? processedIds
            : [...processedIds, wompiTransactionId];
        }
      }
    }

    const { error } = await supabase.from("subscriptions").update(updates).eq("id", subscriptionId);
    if (error) {
      return NextResponse.json(
        { message: "No se pudo actualizar la suscripcion", details: error?.message ?? "unknown" },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ message: "Evento procesado", transactionId: wompiTransactionId, status }, { status: 200 });
}
