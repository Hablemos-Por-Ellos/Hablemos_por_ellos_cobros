const PREFERRED_PAYMENT_DAYS = [1, 6, 16, 28];
const COLOMBIA_UTC_OFFSET_HOURS = 5;
const COLOMBIA_CHARGE_HOUR_UTC = 12;

function isPreferredPaymentDay(value) {
  return typeof value === "number" && PREFERRED_PAYMENT_DAYS.includes(value);
}

function getColombiaCalendarDate(date) {
  return new Date(date.getTime() - COLOMBIA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
}

export function getColombiaBillingMonthRange(date) {
  const colombiaDate = getColombiaCalendarDate(date);
  const year = colombiaDate.getUTCFullYear();
  const month = colombiaDate.getUTCMonth();

  return {
    periodKey: `${year}${String(month + 1).padStart(2, "0")}`,
    startIso: new Date(Date.UTC(year, month, 1, COLOMBIA_UTC_OFFSET_HOURS, 0, 0, 0)).toISOString(),
    endIso: new Date(Date.UTC(year, month + 1, 1, COLOMBIA_UTC_OFFSET_HOURS, 0, 0, 0)).toISOString(),
  };
}

export function getNextMonthlyPaymentDate(base, preferredPaymentDay) {
  if (!isPreferredPaymentDay(preferredPaymentDay)) {
    const candidate = new Date(base);
    const targetDay = candidate.getUTCDate();
    candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
    const daysInTargetMonth = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 0)).getUTCDate();
    candidate.setUTCDate(Math.min(targetDay, daysInTargetMonth));
    return candidate;
  }

  const colombiaDate = getColombiaCalendarDate(base);
  return new Date(
    Date.UTC(
      colombiaDate.getUTCFullYear(),
      colombiaDate.getUTCMonth() + 1,
      preferredPaymentDay,
      COLOMBIA_CHARGE_HOUR_UTC,
      0,
      0,
      0
    )
  );
}

function parseDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function writeAudit(supabase, payload, logger) {
  const { error } = await supabase.from("audit_logs").insert(payload);
  if (error) logger.log(`WARN audit action=${payload.action} failed: ${error.message}`);
}

export async function runMonthlyCharges({ now = new Date(), supabase, createTransaction, logger = console }) {
  const nowIso = now.toISOString();
  const billingMonth = getColombiaBillingMonthRange(now);
  const stats = {
    due: 0,
    charged: 0,
    skippedPending: 0,
    reconciled: 0,
    failed: 0,
    duplicateCheckFailures: 0,
  };

  const { data: dueSubs, error } = await supabase
    .from("subscriptions")
    .select(
      "id, amount, currency, next_payment_date, wompi_payment_source_id, reference, preferred_payment_day, donor:donor_id(email)"
    )
    .eq("status", "active")
    .eq("frequency", "monthly")
    .not("wompi_payment_source_id", "is", null)
    .not("next_payment_date", "is", null)
    .lte("next_payment_date", nowIso);

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  if (!dueSubs?.length) {
    logger.log(`No subscriptions due for charge. billing_period=${billingMonth.periodKey}`);
    return stats;
  }

  stats.due = dueSubs.length;
  logger.log(
    `Found ${dueSubs.length} subscription(s) due. billing_period=${billingMonth.periodKey} window=${billingMonth.startIso}..${billingMonth.endIso}`
  );

  for (const sub of dueSubs) {
    const subscriptionId = sub.id;
    const amount = Number(sub.amount);
    const currency = sub.currency || "COP";
    const paymentSourceId = sub.wompi_payment_source_id;
    const customerEmail = sub?.donor?.email || "";
    const reference = sub.reference ? `${sub.reference}-${billingMonth.periodKey}` : `SUB-${subscriptionId}-${billingMonth.periodKey}`;

    if (!paymentSourceId) {
      logger.log(`Skip subscription=${subscriptionId} action=missing_payment_source billing_period=${billingMonth.periodKey}`);
      continue;
    }

    const { data: existingPayments, error: existingErr } = await supabase
      .from("payments")
      .select("id, status, created_at, wompi_transaction_id")
      .eq("subscription_id", subscriptionId)
      .gte("created_at", billingMonth.startIso)
      .lt("created_at", billingMonth.endIso)
      .in("status", ["approved", "pending"])
      .order("created_at", { ascending: false });

    if (existingErr) {
      stats.duplicateCheckFailures += 1;
      await writeAudit(
        supabase,
        {
          action: "monthly_charge_duplicate_check_failed",
          subscription_id: subscriptionId,
          details: { reference, billingPeriod: billingMonth.periodKey, error: existingErr.message },
        },
        logger
      );
      logger.log(
        `WARN subscription=${subscriptionId} action=skip_duplicate_check_error billing_period=${billingMonth.periodKey} error=${existingErr.message}`
      );
      continue;
    }

    const approvedPayment = existingPayments?.find((payment) => String(payment.status).toLowerCase() === "approved");
    if (approvedPayment) {
      const approvedAt = parseDate(approvedPayment.created_at) ?? now;
      const candidateNextPaymentDate = getNextMonthlyPaymentDate(approvedAt, sub.preferred_payment_day);
      const currentNextPaymentDate = parseDate(sub.next_payment_date);

      if (!currentNextPaymentDate || candidateNextPaymentDate > currentNextPaymentDate) {
        const { error: updateError } = await supabase
          .from("subscriptions")
          .update({ next_payment_date: candidateNextPaymentDate.toISOString() })
          .eq("id", subscriptionId);

        if (updateError) {
          stats.failed += 1;
          await writeAudit(
            supabase,
            {
              action: "monthly_charge_schedule_reconcile_failed",
              subscription_id: subscriptionId,
              details: { reference, billingPeriod: billingMonth.periodKey, error: updateError.message },
            },
            logger
          );
          logger.log(
            `FAIL subscription=${subscriptionId} action=reconcile_schedule billing_period=${billingMonth.periodKey} error=${updateError.message}`
          );
          continue;
        }

        stats.reconciled += 1;
        await writeAudit(
          supabase,
          {
            action: "monthly_charge_schedule_reconciled",
            subscription_id: subscriptionId,
            details: {
              reference,
              billingPeriod: billingMonth.periodKey,
              paymentId: approvedPayment.id,
              paymentTransactionId: approvedPayment.wompi_transaction_id,
              nextPaymentDate: candidateNextPaymentDate.toISOString(),
            },
          },
          logger
        );
        logger.log(
          `OK subscription=${subscriptionId} action=reconciled_approved billing_period=${billingMonth.periodKey} next_payment_date=${candidateNextPaymentDate.toISOString()}`
        );
      } else {
        logger.log(`Skip subscription=${subscriptionId} action=approved_already_scheduled billing_period=${billingMonth.periodKey}`);
      }
      continue;
    }

    if (existingPayments?.length) {
      stats.skippedPending += 1;
      logger.log(`Skip subscription=${subscriptionId} action=pending_payment billing_period=${billingMonth.periodKey}`);
      continue;
    }

    try {
      const { id: txId, status } = await createTransaction({
        reference,
        amountInCents: Math.round(amount * 100),
        currency,
        customerEmail,
        paymentSourceId,
      });

      const { error: payErr } = await supabase.from("payments").insert({
        subscription_id: subscriptionId,
        amount,
        currency,
        status,
        wompi_transaction_id: txId,
      });

      if (payErr) {
        logger.log(`WARN subscription=${subscriptionId} tx=${txId} payment insert failed: ${payErr.message}`);
      }

      await writeAudit(
        supabase,
        {
          action: "monthly_charge_created",
          subscription_id: subscriptionId,
          details: { reference, billingPeriod: billingMonth.periodKey, txId, status },
        },
        logger
      );

      stats.charged += 1;
      logger.log(`OK subscription=${subscriptionId} action=charge_created tx=${txId} status=${status} billing_period=${billingMonth.periodKey}`);
    } catch (error) {
      stats.failed += 1;
      const message = error instanceof Error ? error.message : String(error);

      await writeAudit(
        supabase,
        {
          action: "monthly_charge_failed",
          subscription_id: subscriptionId,
          details: { reference, billingPeriod: billingMonth.periodKey, error: message },
        },
        logger
      );

      logger.log(`FAIL subscription=${subscriptionId} action=charge billing_period=${billingMonth.periodKey} error=${message}`);
    }
  }

  return stats;
}
