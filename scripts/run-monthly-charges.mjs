import { createClient } from "@supabase/supabase-js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return "";
}

function getWompiEnv() {
  const env = (process.env.WOMPI_ENV || process.env.NEXT_PUBLIC_WOMPI_ENV || "").toLowerCase();
  if (env === "prod" || env === "production") return "prod";
  if (env === "sandbox" || env === "test") return "sandbox";

  if (process.env.WOMPI_PRIVATE_KEY_PROD) return "prod";
  if (process.env.WOMPI_PRIVATE_KEY_SANDBOX) return "sandbox";

  return "prod";
}

function wompiBaseUrl(env) {
  return env === "prod" ? "https://production.wompi.co/v1" : "https://sandbox.wompi.co/v1";
}

function monthStartUtcIso(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
  return start.toISOString();
}

function wompiErrorHint(json) {
  const err = json?.error ?? null;
  if (!err || typeof err !== "object") return "";

  const type = typeof err.type === "string" ? err.type : "";
  const reason = typeof err.reason === "string" ? err.reason : "";
  const messages = Array.isArray(err.messages) ? err.messages.filter((m) => typeof m === "string") : [];

  const hintParts = [type, reason, messages.join("|")].filter(Boolean);
  return hintParts.length ? ` hint=${hintParts.join(":")}` : "";
}

async function getAcceptanceToken({ baseUrl, publicKey }) {
  const url = `${baseUrl}/merchants/${encodeURIComponent(publicKey)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));

  const token = json?.data?.presigned_acceptance?.acceptance_token ?? null;

  if (!res.ok || !token) {
    throw new Error(`Could not get acceptance_token from Wompi. status=${res.status}${wompiErrorHint(json)}`);
  }

  return token;
}

async function createTransaction({
  baseUrl,
  privateKey,
  acceptanceToken,
  reference,
  amountInCents,
  currency,
  customerEmail,
  paymentSourceId,
}) {
  const url = `${baseUrl}/transactions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${privateKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      acceptance_token: acceptanceToken,
      amount_in_cents: amountInCents,
      currency,
      customer_email: customerEmail,
      payment_source_id: paymentSourceId,
      reference,
    }),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`Wompi transaction failed. status=${res.status}${wompiErrorHint(json)}`);
  }

  const id = json?.data?.id ?? null;
  const status = String(json?.data?.status ?? "pending").toLowerCase();

  if (!id) {
    throw new Error(`Wompi response missing data.id. status=${status}${wompiErrorHint(json)}`);
  }

  return { id, status };
}

function yyyyMM(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

async function main() {
  const now = new Date();
  const env = getWompiEnv();

  const SUPABASE_URL = required("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");

  const wompiPrivateKey =
    env === "prod"
      ? pickEnv("WOMPI_PRIVATE_KEY_PROD", "WOMPI_PRIVATE_KEY")
      : pickEnv("WOMPI_PRIVATE_KEY_SANDBOX", "WOMPI_PRIVATE_KEY");

  const wompiPublicKey =
    env === "prod"
      ? pickEnv("NEXT_PUBLIC_WOMPI_PUBLIC_KEY_PROD", "NEXT_PUBLIC_WOMPI_PUBLIC_KEY")
      : pickEnv("NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX", "NEXT_PUBLIC_WOMPI_PUBLIC_KEY");

  if (!wompiPrivateKey) throw new Error("Missing Wompi private key env (WOMPI_PRIVATE_KEY_* or WOMPI_PRIVATE_KEY).");
  if (!wompiPublicKey) throw new Error("Missing Wompi public key env (NEXT_PUBLIC_WOMPI_PUBLIC_KEY_* or NEXT_PUBLIC_WOMPI_PUBLIC_KEY).");

  const baseUrl = wompiBaseUrl(env);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const nowIso = now.toISOString();

  const { data: dueSubs, error } = await supabase
    .from("subscriptions")
    .select("id, amount, currency, next_payment_date, wompi_payment_source_id, reference, donor:donor_id(email)")
    .eq("status", "active")
    .eq("frequency", "monthly")
    .not("wompi_payment_source_id", "is", null)
    .not("next_payment_date", "is", null)
    .lte("next_payment_date", nowIso);

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  if (!dueSubs?.length) {
    console.log("No subscriptions due for charge.");
    return;
  }

  const acceptanceToken = await getAcceptanceToken({ baseUrl, publicKey: wompiPublicKey });
  const monthStartIso = monthStartUtcIso(now);

  console.log(`Found ${dueSubs.length} subscription(s) due. Processing...`);

  for (const sub of dueSubs) {
    const subscriptionId = sub.id;
    const amount = Number(sub.amount);
    const currency = sub.currency || "COP";
    const paymentSourceId = sub.wompi_payment_source_id;
    const customerEmail = sub?.donor?.email || "";

    const reference = sub.reference ? `${sub.reference}-${yyyyMM(now)}` : `SUB-${subscriptionId}-${yyyyMM(now)}`;

    if (!paymentSourceId) {
      console.log(`Skip subscription=${subscriptionId} (missing wompi_payment_source_id)`);
      continue;
    }

    // Avoid duplicate charges in same month if workflow is re-run
    const { data: existingThisMonth, error: existingErr } = await supabase
      .from("payments")
      .select("id, status")
      .eq("subscription_id", subscriptionId)
      .gte("created_at", monthStartIso)
      .in("status", ["approved", "pending"])
      .limit(1);

    if (existingErr) {
      console.log(`WARN subscription=${subscriptionId} could not check existing payments: ${existingErr.message}`);
    } else if (existingThisMonth?.length) {
      console.log(`Skip subscription=${subscriptionId} (already has payment this month)`);
      continue;
    }

    try {
      const { id: txId, status } = await createTransaction({
        baseUrl,
        privateKey: wompiPrivateKey,
        acceptanceToken,
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
        console.log(`WARN subscription=${subscriptionId} tx=${txId} payment insert failed: ${payErr.message}`);
      }

      // Log to audit_logs
      await supabase.from("audit_logs").insert({
        action: "monthly_charge_created",
        subscription_id: subscriptionId,
        details: { reference, txId, status },
      });

      console.log(`OK subscription=${subscriptionId} tx=${txId} status=${status}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      // Log failure to audit_logs
      await supabase.from("audit_logs").insert({
        action: "monthly_charge_failed",
        subscription_id: subscriptionId,
        details: { reference, error: msg },
      });

      console.log(`FAIL subscription=${subscriptionId} error=${msg}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
