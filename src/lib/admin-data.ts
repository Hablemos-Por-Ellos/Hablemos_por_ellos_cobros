import { createAdminDemoState, type DemoSubscriptionStatus } from "@/lib/admin-demo-data";
import type { AdminDataState as AdminDemoState, AdminPaymentStatus } from "@/types/admin";
import { getAdminContext, isAdminDemoMode, isAdminSchemaReady } from "@/lib/admin-auth";
import { getServerAuthSupabaseClient } from "@/lib/supabase-auth-server";

async function readAll(query: () => any) {
  const rows: any[] = [];
  const ids = new Set<string>();
  for (let start = 0; start < 100_000; start += 100) {
    const { data, error } = await query().order("id", { ascending: true }).range(start, start + 99);
    if (error || !Array.isArray(data)) return { data: null, error: error ?? new Error("ADMIN_READ_FAILED") };
    for (const row of data) {
      if (!row?.id || ids.has(row.id)) return { data: null, error: new Error("ADMIN_READ_INCONSISTENT") };
      ids.add(row.id); rows.push(row);
    }
    if (data.length < 100) return { data: rows, error: null };
  }
  return { data: null, error: new Error("ADMIN_READ_LIMIT_EXCEEDED") };
}

function subscriptionStatus(value: unknown): DemoSubscriptionStatus {
  return value === "active" || value === "cancelled" || value === "past_due" || value === "pending"
    ? value
    : "past_due";
}

function paymentStatus(value: unknown, approvedAt: unknown): AdminPaymentStatus {
  if (value === "approved") return typeof approvedAt === "string" && Number.isFinite(Date.parse(approvedAt)) ? "approved" : "review";
  return value === "pending" || value === "declined" ? value : "review";
}

function maskEmail(value: string) {
  const [local = "", domain = ""] = value.split("@");
  if (!domain) return "Correo no disponible";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(3, local.length - 2))}@${domain}`;
}

function maskPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "Telefono no disponible";
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function auditObject(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function auditDetail(action: string, reason: string, beforeValue: unknown, afterValue: unknown) {
  const before = auditObject(beforeValue);
  const after = auditObject(afterValue);
  const change = action === "amount"
    ? `Monto: ${String(before.amount ?? "-")} -> ${String(after.amount ?? "-")}.`
    : action === "schedule"
      ? `Próximo cobro: ${String(before.next_payment_date ?? "-")} -> ${String(after.next_payment_date ?? "-")}.`
      : action === "cancel"
        ? `Estado: ${String(before.status ?? "-")} -> ${String(after.status ?? "-")}.`
      : action === "reactivate"
          ? `Estado: ${String(before.status ?? "-")} -> ${String(after.status ?? "-")}. Autorización del donante confirmada: ${after.donor_authorization_confirmed === true ? "sí" : after.donor_authorization_confirmed === false ? "no" : "desconocido"}.`
          : action === "payment_recovery"
            ? `Intento conciliado con Wompi: ${String(after.providerStatus ?? after.provider_status ?? "sin estado")}.`
            : action === "payment_recovery_closed"
              ? `Intento cerrado sin transacción encontrada. Estado: ${String(before.attempt_state ?? "-")} -> ${String(after.attempt_state ?? "-")}.`
          : `${action.replaceAll("_", " ")}.`;
  return `${change} Motivo: ${reason}`;
}

export async function loadAdminData(revealDonorId?: string): Promise<AdminDemoState> {
  if (isAdminDemoMode()) return createAdminDemoState();
  if (!(await isAdminSchemaReady()) || !(await getAdminContext())) throw new Error("Sesion administrativa no autorizada.");

  const supabase = await getServerAuthSupabaseClient();
  if (!supabase) throw new Error("Supabase Auth no esta configurado para el panel.");

  const staleDispatchCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const [donorsResult, subscriptionsResult, paymentsResult, unknownAttemptsResult, staleDispatchingResult] = await Promise.all([
    readAll(() => supabase.from("donors").select("id, first_name, last_name, email, phone, city, created_at")),
    readAll(() => supabase
      .from("subscriptions")
      .select("id, donor_id, amount, frequency, status, payment_method_type, preferred_payment_day, next_payment_date, reference, created_at, billing_version, billing_hold_reason")
      .in("frequency", ["monthly", "one_time"])
      .order("created_at", { ascending: false })),
    readAll(() => supabase
      .from("payments")
      .select("id, subscription_id, amount, status, created_at, approved_at, wompi_transaction_id")
      .order("created_at", { ascending: false })
      ),
    readAll(() => supabase
      .from("payment_attempts")
      .select("id, donor_id, subscription_id, reference, amount, state, error_code, created_at, updated_at")
      .eq("state", "unknown")
      .is("wompi_transaction_id", null)
      .order("created_at", { ascending: true })
      ),
    readAll(() => supabase
      .from("payment_attempts")
      .select("id, donor_id, subscription_id, reference, amount, state, error_code, created_at, updated_at")
      .eq("state", "dispatching")
      .is("wompi_transaction_id", null)
      .lt("updated_at", staleDispatchCutoff)
      .order("updated_at", { ascending: true })
      ),
  ]);

  const donorSubscriptionIds = (subscriptionsResult.data ?? [])
    .filter((row) => !revealDonorId || row.donor_id === revealDonorId)
    .map((row) => row.id);
  const auditQuery = () => supabase
    .from("admin_audit_logs")
    .select("id, actor_user_id, subscription_id, action, reason, before_value, after_value, request_id, created_at")
    .order("created_at", { ascending: false });
  const auditResult = revealDonorId
    ? donorSubscriptionIds.length > 0
      ? await readAll(() => auditQuery().in("subscription_id", donorSubscriptionIds))
      : { data: [], error: null }
    : await readAll(auditQuery);

  const [cyclesResult, billingAttemptsResult] = await Promise.all([
    readAll(() => supabase.from("billing_cycles").select("id,subscription_id,billing_period,state,retry_window_start,hold_reason").order("created_at", { ascending: false })),
    readAll(() => supabase.from("payment_attempts").select("id,subscription_id,cycle_id,attempt_number,state,amount,created_at,verified_finalized_at,verified_reason").order("created_at", { ascending: false })),
  ]);
  const firstError = donorsResult.error ?? subscriptionsResult.error ?? paymentsResult.error ?? unknownAttemptsResult.error ?? staleDispatchingResult.error ?? auditResult.error ?? cyclesResult.error ?? billingAttemptsResult.error;
  if (firstError) throw new Error("No se pudo cargar la informacion administrativa.");

  return {
    donors: (donorsResult.data ?? []).map((row) => {
      return {
        id: row.id,
        fullName: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Sin nombre",
        email: maskEmail(row.email ?? ""),
        phone: maskPhone(row.phone ?? ""),
        city: row.city ?? "",
        joinedAt: row.created_at,
        contactMasked: true,
      };
    }),
    subscriptions: (subscriptionsResult.data ?? []).map((row) => ({
      id: row.id,
      donorId: row.donor_id,
      amount: Number(row.amount),
      frequency: row.frequency === "one_time" ? "one_time" as const : "monthly" as const,
      status: subscriptionStatus(row.status),
      paymentMethod: row.payment_method_type === "nequi" ? ("Nequi" as const)
        : row.frequency === "one_time" ? ("Tarjeta" as const) : ("Tarjeta tokenizada" as const),
      preferredPaymentDay: row.frequency === "one_time" ? null
        : ([1, 6, 16, 28].includes(Number(row.preferred_payment_day)) ? Number(row.preferred_payment_day) : null) as 1 | 6 | 16 | 28 | null,
      nextPaymentDate: row.next_payment_date,
      reference: row.reference ?? "",
      createdAt: row.created_at,
      billingVersion: Number(row.billing_version ?? 0),
      billingHoldReason: row.billing_hold_reason ?? null,
      retryAt: (cyclesResult.data ?? []).find((cycle) => cycle.subscription_id === row.id && cycle.state === "retry_wait")?.retry_window_start ?? null,
    })),
    payments: (paymentsResult.data ?? []).map((row) => ({
      id: row.id,
      subscriptionId: row.subscription_id,
      amount: Number(row.amount),
      status: paymentStatus(row.status, row.approved_at),
      createdAt: row.approved_at ?? row.created_at,
      wompiTransactionId: row.wompi_transaction_id ?? "Sin identificador",
    })),
    recoveryAttempts: [...(unknownAttemptsResult.data ?? []), ...(staleDispatchingResult.data ?? [])].map((row) => ({
      id: row.id,
      donorId: row.donor_id,
      subscriptionId: row.subscription_id,
      reference: row.reference,
      amount: Number(row.amount),
      state: row.state === "dispatching" ? ("dispatching" as const) : ("unknown" as const),
      createdAt: row.updated_at ?? row.created_at,
      errorCode: row.error_code ?? "RESULTADO_INCIERTO",
    })),
    billingCycles: (cyclesResult.data ?? []).map((row) => ({ id: row.id, subscriptionId: row.subscription_id,
      billingPeriod: row.billing_period, state: row.state, retryAt: row.retry_window_start, holdReason: row.hold_reason })),
    billingAttempts: (billingAttemptsResult.data ?? []).filter((row) => row.cycle_id && [1, 2].includes(row.attempt_number)).map((row) => ({
      id: row.id, subscriptionId: row.subscription_id, cycleId: row.cycle_id, attemptNumber: row.attempt_number,
      state: row.state, amount: Number(row.amount), createdAt: row.created_at, finalizedAt: row.verified_finalized_at,
      reasonLabel: row.verified_reason === "insufficient_funds" ? "Fondos insuficientes verificados"
        : row.verified_reason ? "Resultado por revisar" : null,
    })),
    auditEvents: (auditResult.data ?? []).map((row) => ({
      id: row.id,
      subscriptionId: row.subscription_id,
      action: ({
        amount: "amount_changed",
        schedule: "schedule_changed",
        cancel: "subscription_cancelled",
        reactivate: "subscription_reactivated",
        payment_recovery: "payment_recovered",
        payment_recovery_closed: "payment_recovery_closed",
        cancel_retry: "retry_cancelled",
      } as const)[row.action as "amount" | "schedule" | "cancel" | "reactivate" | "payment_recovery" | "payment_recovery_closed"] ?? "schedule_changed",
      detail: auditDetail(row.action, row.reason, row.before_value, row.after_value),
      createdAt: row.created_at,
      actorLabel: row.actor_user_id ? `Admin ${String(row.actor_user_id).slice(0, 8)}` : "Administrador",
      requestLabel: row.request_id ? String(row.request_id).slice(0, 8) : undefined,
    })) as AdminDemoState["auditEvents"],
  };
}
