import crypto from "crypto";
import { NextResponse } from "next/server";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { getWompiEventsSecret, WOMPI_ENV } from "@/lib/wompi";
import { getNextMonthlyPaymentDate } from "@/lib/payment-dates";
import { getAppOperationMode } from "@/lib/operation-mode";
import { paymentSchemaReady } from "@/lib/payment-schema";
import { applyBillingResult, billingRetrySchemaReady } from "@/lib/billing-v2";
import { makeWompiReceipt } from "@/lib/wompi-receipts";
import { getWompiTransaction, type WompiTransactionResult } from "@/lib/wompi-server";
import {
  getVerifiedWompiEffectiveDate,
  isValidWompiEventChecksum,
  type WompiEventPayload,
  type WompiTransaction,
} from "@/lib/wompi-webhook";

function eventKey(payload: WompiEventPayload, transactionId: string, checksum: string) {
  const status = String((payload.data?.transaction as WompiTransaction | undefined)?.status ?? "").toLowerCase();
  return crypto
    .createHash("sha256")
    .update(`${payload.event ?? "unknown"}|${transactionId}|${status}|${payload.timestamp ?? ""}|${checksum}`)
    .digest("hex");
}

const RETRYABLE_PAYMENT_FAILURES = new Set(["declined", "error", "voided"]);

function assertCompleteVerifiedTransaction(transaction: WompiTransactionResult, expectedId: string) {
  if (
    transaction.id !== expectedId
    || !transaction.reference
    || !Number.isInteger(transaction.amountInCents)
    || !transaction.amountInCents
    || transaction.amountInCents % 100 !== 0
    || !transaction.currency
  ) {
    throw new Error("WOMPI_TRANSACTION_INCOMPLETE");
  }
}

function reconciliationEventKey(transaction: WompiTransactionResult) {
  return crypto
    .createHash("sha256")
    .update(`server-reconciliation|${transaction.id}|${transaction.status}|${transaction.finalizedAt ?? ""}`)
    .digest("hex");
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 131072) return NextResponse.json({ message: "Evento demasiado grande" }, { status: 413 });
  const rawBody = await request.text().catch(() => "");
  if (!rawBody) return NextResponse.json({ message: "Solicitud invalida" }, { status: 400 });
  if (Buffer.byteLength(rawBody) > 131072) return NextResponse.json({ message: "Evento demasiado grande" }, { status: 413 });

  let payload: WompiEventPayload;
  try {
    payload = JSON.parse(rawBody) as WompiEventPayload;
  } catch {
    return NextResponse.json({ message: "JSON invalido" }, { status: 400 });
  }

  const secret = getWompiEventsSecret();
  const expectedSecretPrefix = WOMPI_ENV === "prod" ? "prod_events_" : "test_events_";
  if (!secret || !secret.startsWith(expectedSecretPrefix)) {
    return NextResponse.json({ message: "Webhook no configurado" }, { status: 503 });
  }
  const receivedChecksum = request.headers.get("x-event-checksum") ?? payload.signature?.checksum ?? "";
  if (!isValidWompiEventChecksum(payload, receivedChecksum, secret)) {
    return NextResponse.json({ message: "Firma invalida" }, { status: 401 });
  }
  if (payload.environment !== (WOMPI_ENV === "prod" ? "prod" : "test")) {
    return NextResponse.json({ message: "Ambiente invalido" }, { status: 401 });
  }

  const eventTransaction = payload.data?.transaction as WompiTransaction | undefined;
  const supabase = getServiceSupabaseClient();
  if (!supabase) return NextResponse.json({ message: "Servicio de datos no configurado" }, { status: 503 });

  const receiptId = crypto.randomUUID();
  const receipt = makeWompiReceipt(payload, receivedChecksum, rawBody, new Date());
  const { error: receiptError } = await supabase.from("webhook_events").insert({
    id: receiptId,
    transaction_id: null,
    event_type: null,
    raw: receipt,
  });
  if (receiptError) return NextResponse.json({ message: "No se pudo conservar el evento" }, { status: 503 });
  if (!eventTransaction?.id || getAppOperationMode() !== "active" || !(await paymentSchemaReady(supabase))) {
    return NextResponse.json({ message: "Evento conservado para conciliacion", result: "queued" });
  }

  try {
    const verified = await getWompiTransaction(eventTransaction.id);
    try {
      assertCompleteVerifiedTransaction(verified, eventTransaction.id);
    } catch {
      return NextResponse.json({ message: "Transaccion incompleta en Wompi" }, { status: 502 });
    }

    if (await billingRetrySchemaReady(supabase)) {
      const { data: attempt, error: lookupError } = await supabase.from("payment_attempts")
        .select("id,cycle_id,attempt_number").eq("reference", verified.reference).maybeSingle();
      if (lookupError) return NextResponse.json({ message: "No se pudo conciliar el intento" }, { status: 503 });
      if (attempt && [1, 2].includes(attempt.attempt_number)) {
        const result = await applyBillingResult(supabase, attempt.id, verified);
        const { error: receiptMarkError } = await supabase.rpc("mark_wompi_receipt", {
          p_raw: { receipt_id: receiptId }, p_result: result.result, p_error: null,
        });
        if (receiptMarkError) return NextResponse.json({ message: "Evento aplicado; recibo pendiente de conciliar" }, { status: 503 });
        return NextResponse.json({ message: "Evento procesado", result: result.result });
      }
    }

    const applyVerifiedTransaction = async (
      transaction: WompiTransactionResult,
      effectiveAt: Date | null,
      key: string,
      type: string,
      raw: Record<string, unknown>
    ) => {
      const amount = transaction.amountInCents! / 100;
      const fallbackNextPayment = effectiveAt ? getNextMonthlyPaymentDate(effectiveAt, null) : null;
      const { data, error } = await supabase.rpc("apply_verified_wompi_event", {
        p_event_key: key,
        p_transaction_id: transaction.id,
        p_event_type: type,
        p_reference: transaction.reference!,
        p_payment_source_id: transaction.paymentSourceId ?? null,
        p_amount: amount,
        p_currency: transaction.currency!,
        p_status: transaction.status.toLowerCase(),
        p_effective_at: effectiveAt?.toISOString() ?? null,
        p_candidate_next_payment: fallbackNextPayment?.toISOString() ?? null,
        p_raw: { ...raw, ...(transaction.id === eventTransaction.id ? { receipt_id: receiptId } : {}) },
      });
      const result = String(data?.result ?? "");
      return { ok: !error && ["processed", "duplicate", "review"].includes(result), result, error };
    };

    const { data: currentAttempt, error: currentAttemptError } = await supabase
      .from("payment_attempts")
      .select("id, wompi_transaction_id, state")
      .eq("reference", verified.reference)
      .maybeSingle();
    if (currentAttemptError) {
      console.error("wompi_webhook_attempt_lookup_failed", { transactionId: verified.id, code: currentAttemptError.code ?? "QUERY_FAILED" });
      return NextResponse.json({ message: "No se pudo conciliar el intento" }, { status: 500 });
    }

    if (currentAttempt?.wompi_transaction_id && currentAttempt.wompi_transaction_id !== verified.id) {
      const previous = await getWompiTransaction(currentAttempt.wompi_transaction_id);
      assertCompleteVerifiedTransaction(previous, currentAttempt.wompi_transaction_id);
      const previousStatus = previous.status.toLowerCase();
      const incomingStatus = verified.status.toLowerCase();
      if (
        previous.reference !== verified.reference
        || previous.amountInCents !== verified.amountInCents
        || previous.currency !== verified.currency
      ) {
        console.error("wompi_webhook_retry_blocked", {
          transactionId: verified.id,
          currentTransactionId: previous.id,
          currentStatus: previous.status,
        });
        return NextResponse.json({ message: "El intento anterior aun no permite aplicar el reintento" }, { status: 500 });
      }

      const previousEffectiveAt = getVerifiedWompiEffectiveDate(
        { id: previous.id, status: previous.status, finalized_at: previous.finalizedAt ?? undefined },
        undefined
      );
      const previousSanitized = {
        event: "transaction.reconciled",
        transaction: {
          id: previous.id,
          status: previous.status,
          reference: previous.reference,
          amount_in_cents: previous.amountInCents,
          currency: previous.currency,
          finalized_at: previous.finalizedAt ?? null,
        },
        source: "server_reconciliation",
        received_at: new Date().toISOString(),
      };
      const previousApply = await applyVerifiedTransaction(
        previous,
        previousEffectiveAt,
        reconciliationEventKey(previous),
        "transaction.reconciled",
        previousSanitized
      );
      if (!previousApply.ok) {
        console.error("wompi_webhook_previous_apply_failed", {
          transactionId: previous.id,
          code: previousApply.error?.code ?? "RPC_FAILED",
        });
        return NextResponse.json({ message: "No se pudo conciliar el intento anterior" }, { status: 500 });
      }
      if (
        !RETRYABLE_PAYMENT_FAILURES.has(previousStatus)
        && !RETRYABLE_PAYMENT_FAILURES.has(incomingStatus)
      ) {
        console.error("wompi_webhook_retry_blocked", {
          transactionId: verified.id,
          currentTransactionId: previous.id,
          currentStatus: previous.status,
        });
        return NextResponse.json({ message: "El intento anterior aun no permite aplicar el reintento" }, { status: 500 });
      }
    }

    const effectiveAt = getVerifiedWompiEffectiveDate(
      { id: verified.id, finalized_at: verified.finalizedAt },
      String(eventTransaction.status ?? "").toLowerCase() === verified.status.toLowerCase() ? payload.timestamp : undefined
    );
    const sanitized = {
      event: payload.event ?? null,
      timestamp: payload.timestamp ?? null,
      transaction: {
        id: verified.id,
        status: verified.status,
        reference: verified.reference,
        amount_in_cents: verified.amountInCents,
        currency: verified.currency,
        finalized_at: verified.finalizedAt ?? null,
      },
      received_at: new Date().toISOString(),
    };

    const applied = await applyVerifiedTransaction(
      verified,
      effectiveAt,
      eventKey(payload, verified.id, receivedChecksum),
      payload.event ?? "unknown",
      sanitized
    );
    if (!applied.ok) {
      console.error("wompi_webhook_apply_failed", { transactionId: verified.id, code: applied.error?.code ?? "RPC_FAILED" });
      return NextResponse.json({ message: "No se pudo aplicar el evento" }, { status: 500 });
    }

    return NextResponse.json({ message: "Evento procesado", transactionId: verified.id, result: applied.result });
  } catch (error) {
    console.error("wompi_webhook_verification_failed", {
      transactionId: eventTransaction.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ message: "No se pudo verificar la transaccion" }, { status: 502 });
  }
}
