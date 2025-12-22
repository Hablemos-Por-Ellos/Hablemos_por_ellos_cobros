import crypto from "crypto";
import { NextResponse } from "next/server";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { getWompiEventsSecret } from "@/lib/wompi";

type WompiTransaction = {
  id: string;
  status?: string;
  amount_in_cents?: number;
  amountInCents?: number;
  currency?: string;
  reference?: string;
  payment_method_type?: string;
  paymentMethodType?: string;
  payment_method?: { type?: string; extra?: Record<string, unknown> };
  paymentMethod?: { type?: string; extra?: Record<string, unknown> };
};

function parseSignatureHeader(header: string | null) {
  if (!header) return { timestamp: null, signature: null };
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2) ?? null;
  const signature = parts.find((p) => p.startsWith("v1="))?.slice(3) ?? null;
  return { timestamp, signature };
}

function safeCompare(a: string, b: string | null) {
  if (!b) return false;
  const aBuf = new Uint8Array(Buffer.from(a));
  const bBuf = new Uint8Array(Buffer.from(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function addOneMonthKeepingDay(base: Date) {
  const targetDay = base.getDate();
  const candidate = new Date(base);
  candidate.setMonth(candidate.getMonth() + 1, 1);
  const daysInTargetMonth = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
  candidate.setDate(Math.min(targetDay, daysInTargetMonth));
  return candidate;
}

export async function POST(request: Request) {
  const rawBody = await request.text().catch(() => "");
  if (!rawBody) {
    return NextResponse.json({ message: "Solicitud inv?lida" }, { status: 400 });
  }

  const wompiSecret = getWompiEventsSecret();
  if (!wompiSecret) {
    return NextResponse.json({ message: "Configura WOMPI_EVENTS_SECRET para validar webhooks" }, { status: 500 });
  }

  const signatureHeader =
    request.headers.get("x-event-signature") ??
    request.headers.get("x-message-signature") ??
    request.headers.get("x-signature");

  const { timestamp, signature } = parseSignatureHeader(signatureHeader);
  if (!timestamp || !signature) {
    return NextResponse.json({ message: "Falta firma del webhook" }, { status: 400 });
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const computed = crypto.createHmac("sha256", wompiSecret).update(signedPayload).digest("hex");

  if (!safeCompare(computed, signature)) {
    return NextResponse.json({ message: "Firma inv?lida" }, { status: 401 });
  }

  // Validar antigüedad del timestamp (prevenir replay attacks)
  const eventTime = parseInt(timestamp) * 1000;
  const now = Date.now();
  const FIVE_MINUTES = 5 * 60 * 1000;
  if (Math.abs(now - eventTime) > FIVE_MINUTES) {
    return NextResponse.json({ message: "Evento expirado" }, { status: 400 });
  }

  //const payload = JSON.parse(rawBody) as { event?: string; data?: { transaction?: WompiTransaction } };
  //Old handler had no try-catch, adding it to avoid 500 on invalid JSON
  let payload;
  try {
    payload = JSON.parse(rawBody) as { event?: string; data?: { transaction?: WompiTransaction } };
  } catch {
    return NextResponse.json({ message: "JSON invalido" }, { status: 400 });
  }
    
  const transaction = payload?.data?.transaction;

  const supabase = getServiceSupabaseClient();
  const allowDemo = (process.env.ALLOW_DEMO_MODE === "true") || (process.env.NODE_ENV !== "production");
  if (!supabase) {
    if (allowDemo) {
      return NextResponse.json(
        { message: "Webhook recibido en modo demostración (sin SUPABASE_SERVICE_ROLE_KEY)" },
        { status: 200 }
      );
    }
    return NextResponse.json(
      { message: "Configuración inválida en producción: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 }
    );
  }

  // Sanitize event: store only non-sensitive fields (no cardholder, no customer data)
  const sanitizedEvent = {
    transaction_id: transaction?.id ?? null,
    event_type: payload?.event ?? null,
    event: payload?.event ?? null,
    transaction: transaction ? {
      id: transaction.id,
      status: transaction.status,
      reference: transaction.reference,
      amount_in_cents: transaction.amount_in_cents ?? transaction.amountInCents,
      currency: transaction.currency,
      payment_method_type: transaction.payment_method_type ?? transaction.paymentMethodType,
    } : null,
    timestamp: new Date().toISOString(),
  };

  // Intenta insertar; si hay conflicto de índice único, continúa
  const { error: logError } = await supabase!.from("webhook_events").insert({ raw: sanitizedEvent });
  if (logError && logError.code !== "23505") {
    // 23505 = unique constraint violation (evento duplicado, ignorar)
    return NextResponse.json(
      { message: "No se pudo registrar el evento", details: logError?.message ?? "unknown" },
      { status: 500 }
    );
  }
  if (logError?.code === "23505") {
    console.log(`Evento duplicado para transaction ${transaction?.id}, ignorando...`);
  }

  if (!transaction?.id) {
    return NextResponse.json({ message: "Evento guardado sin transacci?n" }, { status: 200 });
  }

  const tx = transaction as WompiTransaction;

  const status = (tx.status ?? "").toLowerCase();
  const wompiTransactionId = tx.id;
  const amountInCents = tx.amount_in_cents ?? tx.amountInCents ?? null;
  const currency = tx.currency ?? "COP";
  const reference = tx.reference ?? null;
  const paymentSourceId =
    (tx.payment_method ?? tx.paymentMethod)?.extra?.payment_source_id ??
    (tx.payment_method ?? tx.paymentMethod)?.extra?.token ??
    null;

  // Try to find related subscription
  let subscriptionId: string | null = null;
  if (paymentSourceId) {
    const { data: subBySource } = await supabase!
      .from("subscriptions")
      .select("id")
      .eq("wompi_payment_source_id", paymentSourceId)
      .maybeSingle();
    subscriptionId = subBySource?.id ?? null;
  }
  if (!subscriptionId && reference) {
    const { data: subByRef } = await supabase!
      .from("subscriptions")
      .select("id")
      .eq("reference", reference)
      .maybeSingle();
    subscriptionId = subByRef?.id ?? null;
  }

  const amountCop =
    typeof amountInCents === "number" ? Math.round((amountInCents as number) / 100) : null;

  // Upsert payment linked to the transaction
  const { data: existingPayment, error: paymentLookupError } = await supabase!
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

  const paymentPayload: Record<string, unknown> = {
    subscription_id: subscriptionId,
    amount: amountCop,
    currency,
    status,
    wompi_transaction_id: wompiTransactionId,
  };

  let paymentError = null;
  const existingPaymentId = existingPayment?.id ?? null;
  if (existingPaymentId) {
    const { error } = await supabase!.from("payments").update(paymentPayload).eq("id", existingPaymentId);
    paymentError = error;
  } else {
    const { error } = await supabase!.from("payments").insert(paymentPayload);
    paymentError = error;
  }

  if (paymentError) {
    return NextResponse.json(
      { message: "No se pudo guardar el pago", details: paymentError?.message ?? "unknown" },
      { status: 500 }
    );
  }

  // Update subscription status according to transaction outcome
  if (subscriptionId) {
    let subscriptionStatus: string | null = null;
    if (status === "approved") {
      subscriptionStatus = "active";
    } else if (status === "declined") {
      subscriptionStatus = "past_due";
    } else if (status === "pending") {
      subscriptionStatus = "pending";
    }

    if (subscriptionStatus) {
      const updates: Record<string, unknown> = { status: subscriptionStatus };

      if (subscriptionStatus === "active") {
        const { data: subscription, error: fetchSubError } = await supabase!
          .from("subscriptions")
          .select("next_payment_date, processed_transaction_ids")
          .eq("id", subscriptionId)
          .maybeSingle();

        const processedIds = subscription?.processed_transaction_ids || [];
        // Solo actualizar next_payment_date si este transaction aún no fue procesado (idempotencia)
        if (!processedIds.includes(wompiTransactionId)) {
          const nextDate = subscription?.next_payment_date;
          if (!fetchSubError) {
            const baseDate = nextDate ? new Date(nextDate as unknown as string) : new Date();
            updates.next_payment_date = addOneMonthKeepingDay(baseDate).toISOString();
            // Agregar este transaction_id a la lista de procesados
            updates.processed_transaction_ids = [...processedIds, wompiTransactionId];
          }
        }
      }

      const { error } = await supabase!.from("subscriptions").update(updates).eq("id", subscriptionId);
      if (error) {
        return NextResponse.json(
          { message: "No se pudo actualizar la suscripción", details: error?.message ?? "unknown" },
          { status: 500 }
        );
      }
    }
  }

  return NextResponse.json(
    { message: "Evento procesado", transactionId: wompiTransactionId, status },
    { status: 200 }
  );
}
