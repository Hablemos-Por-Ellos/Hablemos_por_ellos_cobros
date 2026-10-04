import { createAdminDemoState, type DemoSubscriptionStatus } from "@/lib/admin-demo-data";
import type { AdminDataState as AdminDemoState, AdminPaymentStatus } from "@/types/admin";
import { getAdminContext, isAdminDemoMode, isAdminSchemaReady } from "@/lib/admin-auth";
import { getServerAuthSupabaseClient } from "@/lib/supabase-auth-server";

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
          ? `Estado: ${String(before.status ?? "-")} -> ${String(after.status ?? "-")}. Autorización del donante confirmada: ${after.donor_authorization_confirmed === true ? "sí" : "no"}.`
          : action === "payment_recovery"
            ? `Intento conciliado con Wompi: ${String(after.provider_status ?? "sin estado")}.`
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
    supabase.from("donors").select("id, first_name, last_name, email, phone, city, created_at").order("created_at", { ascending: false }),
    supabase
      .from("subscriptions")
      .select("id, donor_id, amount, frequency, status, payment_method_type, preferred_payment_day, next_payment_date, reference, created_at, billing_version")
      .eq("frequency", "monthly")
      .order("created_at", { ascending: false }),
    supabase
      .from("payments")
      .select("id, subscription_id, amount, status, created_at, approved_at, wompi_transaction_id")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("payment_attempts")
      .select("id, donor_id, subscription_id, reference, amount, state, error_code, created_at, updated_at")
      .eq("state", "unknown")
      .is("wompi_transaction_id", null)
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("payment_attempts")
      .select("id, donor_id, subscription_id, reference, amount, state, error_code, created_at, updated_at")
      .eq("state", "dispatching")
      .is("wompi_transaction_id", null)
      .lt("updated_at", staleDispatchCutoff)
      .order("updated_at", { ascending: true })
      .limit(100),
  ]);

  const donorSubscriptionIds = (subscriptionsResult.data ?? [])
    .filter((row) => !revealDonorId || row.donor_id === revealDonorId)
    .map((row) => row.id);
  const auditQuery = supabase
    .from("admin_audit_logs")
    .select("id, actor_user_id, subscription_id, action, reason, before_value, after_value, request_id, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  const auditResult = revealDonorId
    ? donorSubscriptionIds.length > 0
      ? await auditQuery.in("subscription_id", donorSubscriptionIds)
      : { data: [], error: null }
    : await auditQuery;

  const firstError = donorsResult.error ?? subscriptionsResult.error ?? paymentsResult.error ?? unknownAttemptsResult.error ?? staleDispatchingResult.error ?? auditResult.error;
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
      frequency: "monthly" as const,
      status: subscriptionStatus(row.status),
      paymentMethod: row.payment_method_type === "nequi" ? ("Nequi" as const) : ("Tarjeta tokenizada" as const),
      preferredPaymentDay: ([1, 6, 16, 28].includes(Number(row.preferred_payment_day)) ? Number(row.preferred_payment_day) : 16) as 1 | 6 | 16 | 28,
      nextPaymentDate: row.next_payment_date,
      reference: row.reference ?? "",
      createdAt: row.created_at,
      billingVersion: Number(row.billing_version ?? 0),
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
      } as const)[row.action as "amount" | "schedule" | "cancel" | "reactivate" | "payment_recovery" | "payment_recovery_closed"] ?? "schedule_changed",
      detail: auditDetail(row.action, row.reason, row.before_value, row.after_value),
      createdAt: row.created_at,
      actorLabel: row.actor_user_id ? `Admin ${String(row.actor_user_id).slice(0, 8)}` : "Administrador",
      requestLabel: row.request_id ? String(row.request_id).slice(0, 8) : undefined,
    })) as AdminDemoState["auditEvents"],
  };
}
