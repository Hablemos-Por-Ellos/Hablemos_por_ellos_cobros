import { NextResponse } from "next/server";
import { subscriptionPayloadSchema } from "@/lib/schemas";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { createWompiPaymentSource, createWompiTransaction, getWompiAcceptance } from "@/lib/wompi-server";

type SupabaseClient = NonNullable<ReturnType<typeof getServiceSupabaseClient>>;

function addOneMonthKeepingDay(base: Date) {
  const targetDay = base.getDate();
  const candidate = new Date(base);
  candidate.setMonth(candidate.getMonth() + 1, 1);
  const daysInTargetMonth = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
  candidate.setDate(Math.min(targetDay, daysInTargetMonth));
  return candidate;
}

function fallbackReference() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function statusFromWompi(status: string) {
  if (status === "approved") return "active";
  if (status === "pending") return "pending";
  return "past_due";
}

async function findSubscriptionByReference(supabase: SupabaseClient, reference: string) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("id, processed_transaction_ids")
    .eq("reference", reference)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function saveSubscription(params: {
  supabase: SupabaseClient;
  donorId: string;
  amount: number;
  isRecurring: boolean;
  paymentMethod?: "card" | "nequi";
  reference: string;
  status: string;
  paymentSourceId?: string | null;
  maskedDetails?: string | null;
  transactionId?: string | null;
}) {
  const existing = await findSubscriptionByReference(params.supabase, params.reference);
  const processedIds = Array.isArray(existing?.processed_transaction_ids) ? existing.processed_transaction_ids : [];
  const nextProcessedIds =
    params.transactionId && !processedIds.includes(params.transactionId)
      ? [...processedIds, params.transactionId]
      : processedIds;

  const payload: Record<string, unknown> = {
    donor_id: params.donorId,
    amount: params.amount,
    currency: "COP",
    frequency: params.isRecurring ? "monthly" : "one_time",
    status: params.status,
    payment_method_type: params.paymentMethod,
    wompi_payment_source_id: params.paymentSourceId ?? null,
    wompi_masked_details: params.maskedDetails ?? null,
    reference: params.reference,
    next_payment_date:
      params.isRecurring && params.status === "active" ? addOneMonthKeepingDay(new Date()).toISOString() : null,
    processed_transaction_ids: nextProcessedIds,
  };

  if (existing?.id) {
    const { data, error } = await params.supabase
      .from("subscriptions")
      .update(payload)
      .eq("id", existing.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  const { data, error } = await params.supabase.from("subscriptions").insert(payload).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function savePendingCheckout(params: {
  supabase: SupabaseClient;
  donorId: string;
  amount: number;
  isRecurring: boolean;
  paymentMethod?: "card" | "nequi";
  reference: string;
}) {
  return saveSubscription({
    ...params,
    status: "pending",
    paymentSourceId: null,
    maskedDetails: null,
    transactionId: null,
  });
}

async function savePayment(params: {
  supabase: SupabaseClient;
  subscriptionId: string;
  amount: number;
  currency: string;
  status: string;
  transactionId: string;
}) {
  const { data: existing, error: lookupError } = await params.supabase
    .from("payments")
    .select("id")
    .eq("wompi_transaction_id", params.transactionId)
    .maybeSingle();

  if (lookupError) throw new Error(lookupError.message);

  const payload = {
    subscription_id: params.subscriptionId,
    amount: params.amount,
    currency: params.currency,
    status: params.status,
    wompi_transaction_id: params.transactionId,
  };

  if (existing?.id) {
    const { error } = await params.supabase.from("payments").update(payload).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await params.supabase.from("payments").insert(payload);
  if (error) throw new Error(error.message);
}

export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);

  const parsed = subscriptionPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ message: "Informacion invalida", issues: parsed.error.issues }, { status: 400 });
  }

  const { stage, donor, amount, paymentMethod, wompi } = parsed.data;
  const isRecurring = donor.isRecurring ?? true;
  const supabase = getServiceSupabaseClient();
  const allowDemo = process.env.ALLOW_DEMO_MODE === "true" || process.env.NODE_ENV !== "production";

  if (!supabase) {
    if (allowDemo) {
      return NextResponse.json(
        {
          message: "Modo demostracion activo: configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY para persistir datos.",
          status:
            stage === "draft" ? "draft_saved" : stage === "checkout" ? "checkout_started" : "subscription_created",
        },
        { status: 200 }
      );
    }
    return NextResponse.json(
      { message: "Configuracion invalida en produccion: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 }
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

  const reference = wompi?.reference ?? fallbackReference();

  if (stage === "checkout") {
    if (!wompi?.reference) {
      return NextResponse.json({ message: "Falta referencia para iniciar checkout." }, { status: 400 });
    }

    try {
      const subscription = await savePendingCheckout({
        supabase,
        donorId: donorRecord.id,
        amount,
        isRecurring,
        paymentMethod,
        reference,
      });

      return NextResponse.json({ status: "checkout_started", subscriptionId: subscription.id, reference });
    } catch (error) {
      return NextResponse.json({ message: error instanceof Error ? error.message : "No se pudo iniciar checkout." }, { status: 500 });
    }
  }

  try {
    let paymentSourceId = wompi?.paymentSourceId ?? null;
    let transactionId = wompi?.transactionId ?? wompi?.token ?? null;
    let transactionStatus = transactionId ? "approved" : "pending";
    let maskedDetails = wompi?.maskedDetails ?? null;

    if (isRecurring) {
      if (!paymentSourceId) {
        if (!wompi?.cardToken || paymentMethod !== "card") {
          return NextResponse.json(
            { message: "Falta una fuente de pago tokenizada para activar el cobro mensual." },
            { status: 400 }
          );
        }

        const acceptance =
          wompi.acceptanceToken && wompi.acceptPersonalAuth
            ? {
                acceptanceToken: wompi.acceptanceToken,
                acceptPersonalAuth: wompi.acceptPersonalAuth,
              }
            : await getWompiAcceptance();

        const paymentSource = await createWompiPaymentSource({
          token: wompi.cardToken,
          type: wompi.paymentSourceType ?? "CARD",
          customerEmail: donor.email,
          acceptanceToken: acceptance.acceptanceToken,
          acceptPersonalAuth: acceptance.acceptPersonalAuth,
        });

        if (paymentSource.status.toUpperCase() !== "AVAILABLE") {
          return NextResponse.json(
            { message: "La fuente de pago no quedo disponible para cobro mensual." },
            { status: 400 }
          );
        }

        paymentSourceId = paymentSource.id;
        maskedDetails = wompi.maskedDetails ?? paymentSource.maskedDetails;

        const transaction = await createWompiTransaction({
          reference,
          amountInCents: Math.max(150000, Math.round(amount * 100)),
          currency: "COP",
          customerEmail: donor.email,
          paymentSourceId,
          acceptanceToken: acceptance.acceptanceToken,
          acceptPersonalAuth: acceptance.acceptPersonalAuth,
          recurrent: true,
        });

        transactionId = transaction.id;
        transactionStatus = transaction.status;
      }

      if (!paymentSourceId) {
        return NextResponse.json(
          { message: "Falta payment_source_id para cobro mensual." },
          { status: 400 }
        );
      }
    }

    const subscriptionStatus = isRecurring ? statusFromWompi(transactionStatus) : "active";
    const subscription = await saveSubscription({
      supabase,
      donorId: donorRecord.id,
      amount,
      isRecurring,
      paymentMethod,
      reference,
      status: subscriptionStatus,
      paymentSourceId,
      maskedDetails,
      transactionId,
    });

    if (transactionId) {
      await savePayment({
        supabase,
        subscriptionId: subscription.id,
        amount,
        currency: "COP",
        status: transactionStatus,
        transactionId,
      });
    }

    return NextResponse.json({
      status: subscriptionStatus === "active" ? "subscription_created" : "payment_pending",
      subscriptionId: subscription.id,
      transactionId,
      paymentSourceId,
    });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "No se pudo guardar la suscripcion." },
      { status: 500 }
    );
  }
}
