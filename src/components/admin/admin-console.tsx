"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleX,
  Clock3,
  CreditCard,
  FileClock,
  LayoutDashboard,
  KeyRound,
  Menu,
  LogOut,
  Pencil,
  Power,
  RefreshCcw,
  Search,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import {
  DEMO_STORAGE_KEY,
  createAdminDemoState,
  getDemoNextPaymentDate,
  maskEmail,
  maskPhone,
  type DemoAuditEvent,
  type DemoDonor,
  type DemoSubscription,
  type DemoSubscriptionStatus,
  type DemoAttemptState,
} from "@/lib/admin-demo-data";
import { cn, formatCurrencyCOP } from "@/lib/utils";
import { adminLogoutResultSchema, confirmedRecoverySchema, confirmedSubscriptionSchema, type AdminDataState as AdminDemoState, type AdminPaymentStatus as DemoPaymentStatus } from "@/types/admin";
import { BuildIdentity } from "@/components/build-identity";

type AdminView = "dashboard" | "donors" | "subscriptions" | "payments" | "detail";
type Notice = { type: "success" | "info" | "error"; message: string } | null;
type RecoveryInput = { action: "reconcile"; transactionId: string; reason: string; totpCode: string; expectedVersion: number };

type AdminConsoleProps = {
  initialView: Exclude<AdminView, "detail">;
  donorId?: string;
  subscriptionId?: string;
  initialData: AdminDemoState;
  demo: boolean;
  adminEmail: string;
  readOnly?: boolean;
};

const navigation = [
  { href: "/admin", label: "Resumen", icon: LayoutDashboard, view: "dashboard" },
  { href: "/admin/donantes", label: "Donantes", icon: Users, view: "donors" },
  { href: "/admin/suscripciones", label: "Suscripciones", icon: CalendarClock, view: "subscriptions" },
  { href: "/admin/pagos", label: "Pagos", icon: CreditCard, view: "payments" },
] as const;

const dayOptions = [1, 6, 16, 28] as const;

const subscriptionStatusPriority: Record<DemoSubscriptionStatus, number> = {
  active: 0,
  past_due: 1,
  pending: 2,
  cancelled: 3,
};

function donorSubscriptions(data: AdminDemoState, donorId: string) {
  return data.subscriptions
    .filter((subscription) => subscription.donorId === donorId)
    .sort((left, right) => {
      const statusDifference = subscriptionStatusPriority[left.status] - subscriptionStatusPriority[right.status];
      return statusDifference || right.createdAt.localeCompare(left.createdAt);
    });
}

function primarySubscription(data: AdminDemoState, donorId: string) {
  const subscriptions = donorSubscriptions(data, donorId);
  return subscriptions.find((item) => item.frequency === "monthly") ?? subscriptions[0];
}

function contributionLabel(frequency: DemoSubscription["frequency"]) {
  return frequency === "monthly" ? "Mensual" : "Único";
}

function nextChargeLabel(subscription: DemoSubscription) {
  return subscription.frequency === "monthly" ? formatDate(subscription.nextPaymentDate) : "No aplica";
}

function donorDetailHref(donorId: string, subscriptionId?: string) {
  return subscriptionId
    ? `/admin/donantes/${donorId}?subscription=${encodeURIComponent(subscriptionId)}`
    : `/admin/donantes/${donorId}`;
}

function loadDemoState() {
  if (typeof window === "undefined") return createAdminDemoState();

  try {
    const stored = window.localStorage.getItem(DEMO_STORAGE_KEY);
    if (!stored) return createAdminDemoState();
    const parsed = JSON.parse(stored) as AdminDemoState;
    if (!Array.isArray(parsed.donors) || !Array.isArray(parsed.subscriptions) || !Array.isArray(parsed.payments)) {
      return createAdminDemoState();
    }
    const defaults = createAdminDemoState();
    return {
      ...parsed,
      recoveryAttempts: Array.isArray(parsed.recoveryAttempts) ? parsed.recoveryAttempts : defaults.recoveryAttempts,
      billingCycles: Array.isArray(parsed.billingCycles) ? parsed.billingCycles : defaults.billingCycles,
      billingAttempts: Array.isArray(parsed.billingAttempts) ? parsed.billingAttempts : defaults.billingAttempts,
    };
  } catch {
    return createAdminDemoState();
  }
}

function formatDate(value: string | null, withTime = false) {
  if (!value) return "Sin próximo cobro";
  const colombiaDate = new Date(new Date(value).getTime() - 5 * 60 * 60 * 1000);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const dateLabel = `${String(colombiaDate.getUTCDate()).padStart(2, "0")} ${months[colombiaDate.getUTCMonth()]} ${colombiaDate.getUTCFullYear()}`;

  if (!withTime) return dateLabel;

  return `${dateLabel}, ${String(colombiaDate.getUTCHours()).padStart(2, "0")}:${String(colombiaDate.getUTCMinutes()).padStart(2, "0")}`;
}

function listEmail(donor: DemoDonor) {
  return donor.contactMasked ? donor.email : maskEmail(donor.email);
}

function listPhone(donor: DemoDonor) {
  return donor.contactMasked ? donor.phone : maskPhone(donor.phone);
}

function subscriptionLabel(status: DemoSubscriptionStatus) {
  return {
    active: "Activa",
    cancelled: "Cancelada",
    past_due: "Por revisar",
    pending: "Pendiente",
  }[status];
}

function paymentLabel(status: DemoPaymentStatus) {
  return {
    approved: "Aprobado",
    pending: "Pendiente",
    declined: "Rechazado",
    review: "Por revisar",
  }[status];
}

function StatusBadge({ status, type }: { status: DemoSubscriptionStatus | DemoPaymentStatus; type: "subscription" | "payment" }) {
  return <CompactStatus status={status} type={type} />;
}

function CompactStatus({ status, type }: { status: DemoSubscriptionStatus | DemoPaymentStatus; type: "subscription" | "payment" }) {
  const isApproved = status === "active" || status === "approved";
  const isPending = status === "pending";
  const isReview = status === "past_due" || status === "review";
  const label = type === "subscription" ? subscriptionLabel(status as DemoSubscriptionStatus) : paymentLabel(status as DemoPaymentStatus);

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-700">
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          isApproved && "bg-emerald-500",
          isPending && "bg-amber-500",
          isReview && "bg-orange-500",
          status === "cancelled" && "bg-slate-400",
          status === "declined" && "bg-rose-500"
        )}
      />
      {label}
    </span>
  );
}

function SmallLabel({ children }: { children: ReactNode }) {
  return <span className="text-xs font-medium tracking-normal text-slate-600">{children}</span>;
}

type BillingQueue = "retry" | "reconcile" | "review" | "subscription_pending" | "scheduled";

function billingContext(data: AdminDemoState, subscription: DemoSubscription) {
  const cycles = (data.billingCycles ?? []).filter((cycle) => cycle.subscriptionId === subscription.id);
  const cycle = cycles.find((item) => item.state === "retry_wait" || item.state === "open")
    ?? cycles.find((item) => item.state === "manual_review");
  const retryAt = subscription.frequency === "monthly" ? subscription.retryAt ?? cycle?.retryAt ?? null : null;
  const reason = subscription.billingHoldReason ?? cycle?.holdReason ?? null;
  const attempts = (data.billingAttempts ?? []).filter((attempt) => attempt.subscriptionId === subscription.id);
  const unresolved = data.recoveryAttempts.some((attempt) => attempt.subscriptionId === subscription.id)
    || subscription.attemptState === "unknown" || subscription.attemptState === "dispatching"
    || attempts.some((attempt) => attempt.state === "unknown" || attempt.state === "dispatching");
  const queue: BillingQueue = unresolved ? "reconcile"
    : subscription.frequency === "monthly" && subscription.status !== "cancelled" && retryAt && (cycle?.state === "retry_wait" || reason === "retry_scheduled") ? "retry"
      : subscription.status === "past_due" || cycle?.state === "manual_review" ? "review"
        : subscription.status === "pending" ? "subscription_pending" : "scheduled";
  return { queue, retryAt, reason, cycle, attempts };
}

const queueLabels: Record<BillingQueue, string> = {
  retry: "Reintento programado", reconcile: "Por conciliar", review: "Revisión manual",
  subscription_pending: "Suscripción pendiente", scheduled: "Programada",
};

const holdLabels: Record<string, string> = {
  retry_exhausted: "Original y adicional rechazados. Sin futuros cobros automáticos.",
  retry_scheduled: "Fondos insuficientes verificados. Un adicional programado.",
  result_unknown: "Resultado incierto. Conciliar el mismo intento; no repetir el cobro.",
  security_decline: "Rechazo de seguridad. Sin adicional automático.",
  unknown_decline: "Motivo no verificado. Requiere revisión manual.",
  retry_window_missed: "Ventana de reintento vencida. Requiere revisión manual.",
  admin_retry_cancelled: "Adicional cancelado por administración. Sin futuros cobros automáticos.",
};

function attemptLabel(state: DemoAttemptState) {
  return { prepared: "Reservado", dispatching: "Enviado", pending: "Pendiente", approved: "Aprobado", declined: "Rechazado", unknown: "Resultado incierto", cancelled: "Cancelado", failed: "Error operativo" }[state];
}

function QueueLabel({ queue }: { queue: BillingQueue }) {
  return <span className={cn("text-xs font-medium", queue === "retry" ? "text-amber-800" : queue === "reconcile" || queue === "review" ? "text-rose-800" : "text-slate-600")}>{queueLabels[queue]}</span>;
}

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  if (!notice) return null;

  return (
    <div
      aria-live="polite"
      className={cn(
        "fixed bottom-4 right-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm items-start gap-3 rounded-lg border px-4 py-3 shadow-lg sm:w-auto",
        notice.type === "success"
          ? "border-emerald-200 bg-white text-emerald-900"
          : notice.type === "error"
            ? "border-rose-200 bg-white text-rose-900"
            : "border-blue-200 bg-white text-blue-900"
      )}
    >
      <CheckCircle2 aria-hidden="true" className={cn("mt-0.5 h-5 w-5 shrink-0", notice.type === "success" ? "text-emerald-600" : notice.type === "error" ? "text-rose-600" : "text-foundation-blue")} />
      <p className="min-w-0 flex-1 break-words text-sm font-medium leading-5">{notice.message}</p>
      <button
        type="button"
        aria-label="Cerrar aviso"
        title="Cerrar aviso"
        onClick={onDismiss}
        className="-mr-1 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foundation-blue"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

function AdminShell({ children, activeView, onReset, demo, adminEmail, readOnly }: { children: ReactNode; activeView: AdminView; onReset: () => void; demo: boolean; adminEmail: string; readOnly: boolean }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [logoutBlocked, setLogoutBlocked] = useState(false);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [mobileMenuOpen]);

  const handleLogout = async () => {
    if (logoutLoading) return;
    setLogoutLoading(true);
    setLogoutError(null);
    try {
      const response = await fetch("/api/admin/logout", { method: "POST" });
      const result = adminLogoutResultSchema.safeParse(await response.json().catch(() => null));
      if (result.success && (result.data.cookiesCleared || result.data.jwtRevocationConfirmed)) {
        setLogoutBlocked(true);
      }
      if (!response.ok || !result.success || !result.data.ok || !result.data.jwtRevocationConfirmed
        || !result.data.authSignOutConfirmed || !result.data.cookiesCleared) {
        throw new Error(result.success ? result.data.message : "No se confirmo la revocacion de la sesion. Se requiere revision administrativa.");
      }
      window.location.assign("/admin/login");
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "No se pudo cerrar la sesión.");
      setLogoutLoading(false);
    }
  };

  if (logoutBlocked) return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-100 p-4">
      <section className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-bold">Panel bloqueado</h1>
        <p role="alert" className="mt-3 text-sm leading-6 text-slate-700">
          {logoutError ?? "Estamos cerrando tu sesion."}
        </p>
        <a href="/admin/login" className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-md bg-foundation-blue px-4 text-sm font-bold text-white">
          <LogOut aria-hidden="true" className="h-4 w-4" />Volver al ingreso
        </a>
      </section>
    </main>
  );

  const navItems = navigation.map((item) => {
    const Icon = item.icon;
    const active = item.view === activeView;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setMobileMenuOpen(false)}
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foundation-blue focus-visible:ring-offset-2",
          active ? "bg-teal-50 text-teal-900" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
        )}
      >
        <Icon aria-hidden="true" className="h-4 w-4" />
        <span>{item.label}</span>
      </Link>
    );
  });

  return (
    <div className="min-h-dvh bg-white text-slate-900 selection:bg-teal-100 selection:text-teal-950">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-52 border-r border-slate-200 bg-slate-50 lg:flex lg:flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-5">
          <Image src="/hpe-logo.png" alt="" width={36} height={36} className="shrink-0" />
          <div><p className="text-sm font-bold text-slate-900">Hablemos por Ellos</p>
          <p className="mt-0.5 text-xs text-slate-600">Administración</p></div>
        </div>
        <nav aria-label="Navegación administrativa" className="flex flex-1 flex-col gap-1 p-4">
          {navItems}
        </nav>
        <div className={cn("break-words border-t border-slate-200 p-4 text-xs leading-5", demo ? "text-amber-900" : "text-slate-600")}>
          {demo ? "Datos ficticios · Vista local" : `Sesión MFA: ${adminEmail}`}
        </div>
      </aside>

      <div className="min-w-0 lg:pl-52">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
          <div className="mx-auto flex min-h-16 max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                aria-label="Abrir navegación"
                title="Abrir navegación"
                onClick={() => setMobileMenuOpen(true)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 text-slate-700 lg:hidden"
              >
                <Menu aria-hidden="true" className="h-5 w-5" />
              </button>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900 lg:hidden">Hablemos por Ellos</p>
                <p className="text-xs font-medium text-slate-500">{demo ? "Datos ficticios · Vista local" : "Panel de revisión operativa"}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn("hidden items-center gap-1.5 text-xs font-semibold sm:inline-flex", demo ? "text-amber-800" : "text-emerald-700")}>
                <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
                {demo ? "Vista local" : "MFA activo"}
              </span>
              {demo ? <button
                type="button"
                aria-label="Restablecer datos de demostración"
                title="Restablecer datos de demostración"
                onClick={onReset}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition hover:border-foundation-blue hover:text-foundation-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foundation-blue"
              >
                <RefreshCcw aria-hidden="true" className="h-4 w-4" />
              </button> : <button
                type="button"
                aria-label="Cerrar sesión"
                title="Cerrar sesión"
                onClick={handleLogout}
                disabled={logoutLoading}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition hover:border-foundation-blue hover:text-foundation-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foundation-blue"
              >
                <LogOut aria-hidden="true" className="h-4 w-4" />
              </button>}
            </div>
          </div>
        </header>

        {readOnly && <div className="border-b border-slate-200 bg-white px-4 py-2 text-xs text-slate-600 sm:px-6">
          <span className="font-semibold text-amber-800">Solo lectura: operaciones financieras deshabilitadas.</span>
        </div>}

        {logoutError && (
          <p role="alert" className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-center text-sm font-medium text-rose-800">
            {logoutError}
          </p>
        )}

        {mobileMenuOpen && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navegación administrativa">
            <button type="button" aria-label="Cerrar navegación" className="absolute inset-0 bg-slate-950/45" onClick={() => setMobileMenuOpen(false)} />
            <div className="relative flex h-full w-[min(19rem,84vw)] flex-col bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-5">
                <div>
                  <p className="font-bold text-foundation-blue">Hablemos por Ellos</p>
                  <p className="text-xs font-medium text-slate-500">{demo ? "Administración local" : "Administración segura"}</p>
                </div>
                <button
                  type="button"
                  aria-label="Cerrar navegación"
                  title="Cerrar navegación"
                  onClick={() => setMobileMenuOpen(false)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
                >
                  <X aria-hidden="true" className="h-5 w-5" />
                </button>
              </div>
              <nav aria-label="Navegación administrativa" className="flex flex-1 flex-col gap-1 p-4">
                {navItems}
              </nav>
            </div>
          </div>
        )}

        <main id="admin-main" className="mx-auto min-w-0 w-full max-w-[1600px] px-4 py-5 sm:px-6 lg:px-7">
          {children}
          <footer className="mt-8 border-t border-slate-200 pt-4"><BuildIdentity /></footer>
        </main>
      </div>
    </div>
  );
}

function PageHeading({ title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="break-words text-xl font-semibold tracking-normal text-slate-950">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-5 text-slate-600">{description}</p>
      </div>
      {action}
    </div>
  );
}

function Metric({ label, value, detail, icon: Icon, tone }: { label: string; value: number; detail: string; icon: typeof Users; tone: "blue" | "green" | "amber" | "slate" }) {
  const toneClass = {
    blue: "text-teal-800",
    green: "text-emerald-700",
    amber: "text-amber-800",
    slate: "text-slate-700",
  }[tone];

  return (
    <section className="min-w-0 px-3 py-3">
      <p className="flex items-center gap-1.5 text-xs text-slate-600"><Icon aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", toneClass)} />{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-950">{value}</p>
      <p className="sr-only">{detail}</p>
    </section>
  );
}

function RecoveryQueue({
  data,
  demo,
  readOnly,
  onRecover,
}: {
  data: AdminDemoState;
  demo: boolean;
  readOnly: boolean;
  onRecover: (attemptId: string, input: RecoveryInput) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transactionId, setTransactionId] = useState("");
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const expectedVersionRef = useRef(0);
  const selected = data.recoveryAttempts.find((attempt) => attempt.id === selectedId) ?? null;

  const close = () => {
    if (submitting) return;
    setSelectedId(null);
    setTransactionId("");
    setReason("");
    setTotpCode("");
  };
  const submitReconciliation = async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      await onRecover(selected.id, { action: "reconcile", transactionId: transactionId.trim(), reason: reason.trim(), totpCode,
        expectedVersion: expectedVersionRef.current });
      setSelectedId(null);
      setTransactionId("");
      setReason("");
      setTotpCode("");
    } catch {
      // The parent retains the error notice; the form remains available for retry.
    } finally {
      setSubmitting(false);
    }
  };

  if (data.recoveryAttempts.length === 0) return null;

  return (
    <section className="min-w-0 border-y border-slate-200">
      <div className="flex flex-col gap-2 border-b border-slate-200 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-bold text-slate-950"><AlertTriangle aria-hidden="true" className="h-4 w-4 text-amber-600" /> Intentos por conciliar</h2>
          <p className="mt-1 text-sm text-slate-500">Wompi pudo recibir el cobro, pero la app no obtuvo su identificador. No vuelvas a cobrar.</p>
        </div>
        <span className="text-sm font-bold tabular-nums text-amber-800">{data.recoveryAttempts.length}</span>
      </div>
      <ul className="divide-y divide-slate-100">
        {data.recoveryAttempts.map((attempt) => {
          const donor = data.donors.find((item) => item.id === attempt.donorId);
          return <li key={attempt.id} className="grid min-w-0 grid-cols-[minmax(0,1fr),auto] items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr),auto,auto]">
            <div className="min-w-0"><p className="break-words text-sm font-semibold text-slate-900">{donor?.fullName ?? "Donante"}</p><p className="mt-0.5 break-all text-xs text-slate-600">{attempt.reference}</p><p className="mt-0.5 text-xs text-amber-800">Resultado incierto · {formatDate(attempt.createdAt, true)}</p></div>
            <p className="text-right text-sm font-semibold tabular-nums sm:order-none">{formatCurrencyCOP(attempt.amount)}</p>
            <button type="button" aria-label={`Conciliar transacción de ${donor?.fullName ?? "donante"}`} disabled={readOnly} title="Conciliar transacción" onClick={() => { expectedVersionRef.current = data.subscriptions.find((item) => item.id === attempt.subscriptionId)?.billingVersion ?? 0; setSelectedId(attempt.id); }} className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-amber-300 px-3 text-sm font-semibold text-amber-900 hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 disabled:opacity-50 sm:col-span-1"><KeyRound aria-hidden="true" className="h-4 w-4" />Conciliar</button>
          </li>;
        })}
      </ul>

      {selected && <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <div className="my-auto w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
          <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase text-amber-700">Conciliación segura</p><h3 id="recovery-title" className="mt-1 text-xl font-bold text-slate-950">Vincular resultado de Wompi</h3></div><button type="button" aria-label="Cerrar" onClick={close} className="inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"><X aria-hidden="true" className="h-5 w-5" /></button></div>
          <p className="mt-3 text-sm leading-6 text-slate-600">Busca la referencia <strong>{selected.reference}</strong> en Wompi. Si existe, pega el ID exacto. Conciliar solo consulta una transacción existente y no genera un cobro.</p>
          <label className="mt-5 block text-sm font-semibold text-slate-700">ID de transacción en Wompi<input value={transactionId} onChange={(event) => setTransactionId(event.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 200))} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 font-mono text-sm" placeholder="Ej. 1234567-..." /></label>
          <label className="mt-4 block text-sm font-semibold text-slate-700">Motivo<textarea value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 text-base font-normal" placeholder="Cómo se localizó y verificó la transacción" /></label>
          {!demo && <label className="mt-4 block text-sm font-semibold text-slate-700">Código actual de Google Authenticator<input inputMode="numeric" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 text-center text-lg font-bold tracking-[0.3em]" /></label>}
          <div className="mt-6 grid gap-3 sm:grid-cols-2"><button type="button" disabled={readOnly || submitting || transactionId.trim().length < 3 || reason.trim().length < 5 || (!demo && totpCode.length !== 6)} onClick={submitReconciliation} className="min-h-11 rounded-md bg-foundation-blue px-4 text-sm font-bold text-white disabled:opacity-50">{submitting ? "Verificando..." : "Verificar y conciliar"}</button><button type="button" disabled={submitting} onClick={close} className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-bold text-slate-700">Volver</button></div>
        </div>
      </div>}
    </section>
  );
}

function Dashboard({ data, demo, readOnly, onRecover }: { data: AdminDemoState; demo: boolean; readOnly: boolean; onRecover: (attemptId: string, input: RecoveryInput) => Promise<void> }) {
  const monthly = data.subscriptions.filter((subscription) => subscription.frequency === "monthly");
  const active = monthly.filter((subscription) => subscription.status === "active").length;
  const cancelled = monthly.filter((subscription) => subscription.status === "cancelled").length;
  const pending = data.payments.filter((payment) => payment.status === "pending").length;
  const reviewSubscriptions = monthly.filter((subscription) => ["review", "reconcile"].includes(billingContext(data, subscription).queue));
  const retrySubscriptions = monthly.filter((subscription) => billingContext(data, subscription).queue === "retry");
  const pendingSubscriptions = monthly.filter((subscription) => billingContext(data, subscription).queue === "subscription_pending");
  const review = reviewSubscriptions.length;

  const queueSection = (title: string, subscriptions: DemoSubscription[]) => (
    <section className="min-w-0 border-t border-slate-200 pt-4">
      <h2 aria-label={title} className="mb-2 text-sm font-semibold text-slate-950">{title} <span className="ml-1 font-normal tabular-nums text-slate-600">{subscriptions.length}</span></h2>
      {subscriptions.length === 0 ? <p className="py-3 text-sm text-slate-600">Sin registros en esta cola.</p> : <ul className="divide-y divide-slate-100">
        {subscriptions.map((subscription) => {
          const donor = data.donors.find((item) => item.id === subscription.donorId);
          const context = billingContext(data, subscription);
          return <li key={subscription.id}><Link href={donorDetailHref(subscription.donorId, subscription.id)} className="grid min-w-0 grid-cols-[minmax(0,1fr),auto] gap-x-3 gap-y-1 py-3 text-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700">
            <span className="break-words font-semibold text-slate-900">{donor?.fullName ?? "Donante"}</span>
            <span className="text-right font-semibold tabular-nums">{formatCurrencyCOP(subscription.amount)}</span>
            <QueueLabel queue={context.queue} /><span className="text-right text-xs text-slate-600">{context.retryAt ? formatDate(context.retryAt, true) : nextChargeLabel(subscription)}</span>
          </Link></li>;
        })}
      </ul>}
    </section>
  );

  return (
    <div className="space-y-5">
      <PageHeading
        eyebrow={demo ? "Vista local" : "Administración"}
        title="Centro de operaciones"
        description="Suscripciones, resultados de pago y seguimiento. Calendario Colombia."
      />

      <div aria-label="Resumen de seguimiento" className="grid grid-cols-2 border-y border-slate-200 bg-slate-50/70 sm:grid-cols-3 xl:grid-cols-6">
        <Metric label="Suscripciones activas" value={active} detail="Con cobro mensual programado" icon={Users} tone="green" />
        <Metric label="Canceladas" value={cancelled} detail="Sin próximos cobros" icon={CircleX} tone="slate" />
        <Metric label="Pagos pendientes" value={pending} detail="Esperando estado final" icon={Clock3} tone="amber" />
        <Metric label="Suscripciones pendientes" value={pendingSubscriptions.length} detail="Sin activación confirmada" icon={FileClock} tone="slate" />
        <Metric label="Reintentos" value={retrySubscriptions.length} detail="Adicional programado" icon={RefreshCcw} tone="amber" />
        <Metric label="Por revisar" value={review} detail="Requieren seguimiento" icon={AlertTriangle} tone="blue" />
      </div>

      <RecoveryQueue data={data} demo={demo} readOnly={readOnly} onRecover={onRecover} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr),minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          {queueSection("Reintentos programados", retrySubscriptions)}
          {queueSection("Por revisar", reviewSubscriptions)}
          {queueSection("Suscripciones pendientes", pendingSubscriptions)}
        </div>
        <section className="min-w-0 border-t border-slate-200 pt-4">
          <div className="mb-2">
            <h2 className="font-bold text-slate-950">Actividad reciente</h2>
            <p className="mt-1 text-sm text-slate-500">{demo ? "Historial ficticio del panel local." : "Cambios administrativos registrados."}</p>
          </div>
          <ol className="divide-y divide-slate-100">
            {data.auditEvents.slice(0, 4).map((event) => (
              <li key={event.id} className="py-3">
                <p className="text-sm font-semibold text-slate-800">{event.detail}</p>
                {event.actorLabel && <p className="mt-1 text-xs text-slate-500">{event.actorLabel}{event.requestLabel ? ` · Solicitud ${event.requestLabel}` : ""}</p>}
                <p className="mt-1 text-xs text-slate-500">{formatDate(event.createdAt, true)}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="relative block">
      <span className="sr-only">Buscar</span>
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-base text-slate-900 placeholder:text-slate-600 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/20"
      />
    </label>
  );
}

function AttemptHistory({ data, subscription }: { data: AdminDemoState; subscription: DemoSubscription }) {
  const { attempts, cycle, reason, retryAt, queue } = billingContext(data, subscription);
  const history = [...attempts].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.attemptNumber - left.attemptNumber);
  return <section aria-label="Historial de intentos" className="min-w-0">
    {cycle && <p className="mb-3 text-xs text-slate-600">Período {cycle.billingPeriod.slice(0, 4)}-{cycle.billingPeriod.slice(4)} · <QueueLabel queue={queue} /></p>}
    {reason && <p className="mb-3 text-sm leading-5 text-slate-700">{holdLabels[reason] ?? "Bloqueo financiero. Requiere revisión manual."}</p>}
    {retryAt && subscription.frequency === "monthly" && <p className="mb-3 text-sm font-medium text-amber-800">Adicional: {formatDate(retryAt, true)} Colombia</p>}
    {history.length === 0 ? <p className="py-3 text-sm text-slate-600">Sin intentos documentados en esta vista.</p> : <ol className="divide-y divide-slate-200">
      {history.map((attempt) => <li key={attempt.id} className="py-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><p className="font-semibold">{attempt.attemptNumber === 1 ? "Original" : "Adicional"} <span className="font-normal text-slate-600">· {attempt.attemptNumber}/2</span></p><p className="tabular-nums">{formatCurrencyCOP(attempt.amount)}</p></div>
        <p className={cn("mt-1 text-xs font-medium", attempt.state === "approved" ? "text-emerald-800" : attempt.state === "declined" ? "text-rose-800" : "text-amber-800")}>{attemptLabel(attempt.state)}</p>
        {attempt.reasonLabel && <p className="mt-1 break-words text-xs leading-5 text-slate-600">{attempt.reasonLabel}</p>}
        <p className="mt-1 text-xs text-slate-600">{formatDate(attempt.finalizedAt ?? attempt.createdAt, true)} Colombia</p>
      </li>)}
    </ol>}
  </section>;
}

function SubscriptionPeek({ data, subscription, onClose }: { data: AdminDemoState; subscription: DemoSubscription; onClose: () => void }) {
  const donor = data.donors.find((item) => item.id === subscription.donorId);
  const [tab, setTab] = useState<"payments" | "attempts" | "audit">("attempts");
  const tabs = [["payments", "Pagos"], ["attempts", "Intentos"], ["audit", "Actividad"]] as const;
  const payments = data.payments.filter((payment) => payment.subscriptionId === subscription.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const events = data.auditEvents.filter((event) => event.subscriptionId === subscription.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return <aside aria-label="Detalle seleccionado" className="sticky top-20 hidden min-w-0 self-start border-l border-slate-200 pl-5 xl:block">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-base font-semibold">{donor?.fullName ?? "Donante"}</h2><p className="mt-1 break-all text-xs text-slate-600">{donor ? listEmail(donor) : "Sin contacto"}</p></div><button type="button" aria-label="Cerrar resumen" title="Cerrar resumen" onClick={onClose} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"><X aria-hidden="true" className="h-4 w-4" /></button></div>
    <dl className="my-4 grid grid-cols-2 gap-x-3 gap-y-3 border-y border-slate-200 py-3 text-xs">
      <div><dt className="text-slate-600">Aporte {contributionLabel(subscription.frequency).toLowerCase()}</dt><dd className="mt-1 font-semibold tabular-nums">{formatCurrencyCOP(subscription.amount)}</dd></div>
      <div><dt className="text-slate-600">Estado</dt><dd className="mt-1"><CompactStatus type="subscription" status={subscription.status} /></dd></div>
      <div><dt className="text-slate-600">Próximo cobro</dt><dd className="mt-1">{nextChargeLabel(subscription)}</dd></div>
      <div><dt className="text-slate-600">Método</dt><dd className="mt-1">{subscription.paymentMethod}</dd></div>
    </dl>
    <div role="tablist" aria-label="Historial del aporte" className="mb-3 grid grid-cols-3 border-b border-slate-200">
      {tabs.map(([value, label], index) => <button key={value} type="button" role="tab" id={`peek-${value}`} tabIndex={tab === value ? 0 : -1} aria-controls="peek-history" aria-selected={tab === value} onClick={() => setTab(value)} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        setTab(tabs[next][0]);
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#peek-${tabs[next][0]}`)?.focus();
      }} className={cn("min-h-11 border-b-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700", tab === value ? "border-teal-700 text-teal-900" : "border-transparent text-slate-600 hover:text-slate-950")}>{label}</button>)}
    </div>
    <div id="peek-history" role="tabpanel" aria-labelledby={`peek-${tab}`}>
      {tab === "attempts" && <AttemptHistory data={data} subscription={subscription} />}
      {tab === "payments" && (payments.length === 0 ? <p className="py-3 text-sm text-slate-600">Sin pagos registrados.</p> : <ol className="divide-y divide-slate-200">{payments.map((payment) => <li key={payment.id} className="py-3"><div className="flex flex-wrap justify-between gap-2 text-sm"><p className="font-semibold tabular-nums">{formatCurrencyCOP(payment.amount)}</p><CompactStatus type="payment" status={payment.status} /></div><p className="mt-1 break-all text-xs text-slate-600">{payment.wompiTransactionId}</p><p className="mt-1 text-xs text-slate-600">{formatDate(payment.createdAt, true)}</p></li>)}</ol>)}
      {tab === "audit" && (events.length === 0 ? <p className="py-3 text-sm text-slate-600">Sin cambios administrativos registrados.</p> : <ol className="divide-y divide-slate-200">{events.map((event) => <li key={event.id} className="py-3"><p className="break-words text-sm leading-5">{event.detail}</p><p className="mt-1 text-xs text-slate-600">{event.actorLabel ?? "Sistema"} · {formatDate(event.createdAt, true)}</p></li>)}</ol>)}
    </div>
    <Link href={donorDetailHref(subscription.donorId, subscription.id)} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-teal-700 px-3 text-sm font-semibold text-teal-900 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700">Abrir detalle <ChevronRight aria-hidden="true" className="h-4 w-4" /></Link>
  </aside>;
}

function MobileSubscriptionRow({ data, subscription }: { data: AdminDemoState; subscription: DemoSubscription }) {
  const donor = data.donors.find((item) => item.id === subscription.donorId);
  const { queue, retryAt } = billingContext(data, subscription);
  return <Link data-testid="mobile-subscription-row" href={donorDetailHref(subscription.donorId, subscription.id)} className="grid min-w-0 grid-cols-[minmax(0,1fr),auto] gap-x-3 gap-y-1.5 py-3 text-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700">
    <span className="min-w-0 break-words font-semibold text-slate-900">{donor?.fullName ?? "Donante"}</span>
    <span className="text-right font-semibold tabular-nums">{formatCurrencyCOP(subscription.amount)}</span>
    <span className="min-w-0 text-xs text-slate-600"><CompactStatus type="subscription" status={subscription.status} /> · {contributionLabel(subscription.frequency)}{queue !== "scheduled" && <span className="mt-0.5 block"><QueueLabel queue={queue} /></span>}</span>
    <span className="text-right text-xs text-slate-600">{retryAt ? formatDate(retryAt) : nextChargeLabel(subscription)}<span className="sr-only"> · {subscription.reference}{subscription.frequency === "monthly" && subscription.preferredPaymentDay ? ` · Día ${subscription.preferredPaymentDay}` : ""}</span></span>
  </Link>;
}

function DonorList({ data }: { data: AdminDemoState }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const donors = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data.donors;
    return data.donors.filter((donor) => {
      const references = donorSubscriptions(data, donor.id).map((subscription) => subscription.reference);
      return [donor.fullName, donor.email, donor.phone, ...references].filter(Boolean).some((value) => value?.toLowerCase().includes(needle));
    });
  }, [data, query]);
  const selected = donors.some((donor) => donor.id === selectedId) && selectedId ? primarySubscription(data, selectedId) : undefined;

  return (
    <div className="space-y-5">
      <PageHeading eyebrow="Donantes" title="Personas registradas" description="Búsqueda con correo y teléfono enmascarados por defecto." />
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr),auto] md:items-center">
        <SearchField value={query} onChange={setQuery} placeholder="Buscar por nombre, correo, teléfono o referencia" />
        <p className="text-sm font-medium text-slate-500"><span className="tabular-nums text-slate-900">{donors.length}</span> resultados</p>
      </div>
      <div className={cn("min-w-0", selected && "xl:grid xl:grid-cols-[minmax(0,1fr),19rem] xl:gap-5")}>
      <section className="min-w-0 border-y border-slate-200">
        <div className="relative hidden lg:block">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="w-[26%] px-3 py-2 font-semibold">Donante</th>
                <th className="hidden w-[22%] px-3 py-2 font-semibold 2xl:table-cell">Contacto</th>
                <th className="w-[18%] px-3 py-2 font-semibold">Aporte</th>
                <th className="w-[18%] px-3 py-2 font-semibold">Suscripción</th>
                <th className="px-3 py-2 font-semibold">Próximo cobro</th>
                <th className="w-12 px-1 py-2"><span className="sr-only">Abrir detalle</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {donors.map((donor) => {
                const subscription = primarySubscription(data, donor.id);
                return <DonorRow key={donor.id} donor={donor} subscription={subscription} onSelect={() => setSelectedId(donor.id)} selected={selectedId === donor.id} />;
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-100 lg:hidden">
          {donors.map((donor) => {
            const subscription = primarySubscription(data, donor.id);
            return subscription ? <MobileSubscriptionRow key={donor.id} data={data} subscription={subscription} /> : <Link key={donor.id} href={donorDetailHref(donor.id)} className="block min-h-11 py-3 text-sm font-semibold">{donor.fullName}<span className="mt-1 block text-xs font-normal text-slate-600">Sin aporte registrado</span></Link>;
          })}
        </div>
        {donors.length === 0 && <p className="py-8 text-center text-sm text-slate-600">No hay donantes que coincidan con la búsqueda.</p>}
      </section>
      {selected && <SubscriptionPeek key={selected.id} data={data} subscription={selected} onClose={() => setSelectedId(null)} />}
      </div>
    </div>
  );
}

function DonorRow({ donor, subscription, onSelect, selected }: { donor: DemoDonor; subscription?: DemoSubscription; onSelect: () => void; selected: boolean }) {
  return (
    <tr className={cn("hover:bg-slate-50", selected && "bg-teal-50/60")}>
      <td className="px-3 py-2"><button type="button" aria-label={`Abrir resumen de ${donor.fullName}`} aria-pressed={selected} onClick={onSelect} className="hidden min-h-11 break-words text-left font-semibold text-slate-900 hover:text-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 xl:block">{donor.fullName}<span className="mt-0.5 block text-xs font-normal text-slate-600">{donor.city}</span></button><Link href={donorDetailHref(donor.id, subscription?.id)} className="block min-h-11 break-words py-1 font-semibold text-slate-900 hover:text-teal-900 xl:hidden">{donor.fullName}<span className="mt-0.5 block text-xs font-normal text-slate-600">{donor.city}</span></Link></td>
      <td className="hidden break-all px-3 py-2 text-xs text-slate-600 2xl:table-cell"><p>{listEmail(donor)}</p><p className="mt-1">{listPhone(donor)}</p></td>
      <td className="px-3 py-2 font-semibold tabular-nums">{subscription ? <><p>{formatCurrencyCOP(subscription.amount)}</p><p className="mt-0.5 text-xs font-normal text-slate-600">{contributionLabel(subscription.frequency)}</p></> : "Sin aporte"}</td>
      <td className="px-3 py-2">{subscription ? <CompactStatus type="subscription" status={subscription.status} /> : "Sin suscripción"}</td>
      <td className="px-3 py-2 text-xs text-slate-600">{subscription ? nextChargeLabel(subscription) : "No aplica"}</td>
      <td className="px-1 py-2 text-right"><Link href={donorDetailHref(donor.id, subscription?.id)} className="inline-flex h-11 w-11 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700" aria-label={`Ver detalle de ${donor.fullName}`} title="Ver detalle"><ChevronRight aria-hidden="true" className="h-4 w-4" /></Link></td>
    </tr>
  );
}

function SubscriptionList({ data }: { data: AdminDemoState }) {
  const [status, setStatus] = useState<"all" | DemoSubscriptionStatus>("all");
  const [frequency, setFrequency] = useState<"all" | DemoSubscription["frequency"]>("all");
  const [query, setQuery] = useState("");
  const [queue, setQueue] = useState<"all" | BillingQueue>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const subscriptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.subscriptions.filter((subscription) => {
      const donor = data.donors.find((item) => item.id === subscription.donorId);
      const matchesStatus = status === "all" || subscription.status === status;
      const matchesFrequency = frequency === "all" || subscription.frequency === frequency;
      const matchesQuery = !needle || [donor?.fullName, donor?.email, subscription.reference].filter(Boolean).some((value) => value?.toLowerCase().includes(needle));
      const matchesQueue = queue === "all" || billingContext(data, subscription).queue === queue;
      return matchesStatus && matchesFrequency && matchesQuery && matchesQueue;
    });
  }, [data, query, status, frequency, queue]);
  const selected = subscriptions.find((subscription) => subscription.id === selectedId);
  const filtered = query !== "" || frequency !== "all" || status !== "all" || queue !== "all";
  const monthly = data.subscriptions.filter((subscription) => subscription.frequency === "monthly");

  return (
    <div className="space-y-5">
      <PageHeading eyebrow="Suscripciones" title="Aportes y suscripciones" description="Fechas según el calendario de Colombia." />
      <div aria-label="Resumen de seguimiento" className="grid grid-cols-2 border-y border-slate-200 bg-slate-50/70 sm:grid-cols-4">
        <Metric label="Suscripciones pendientes" value={monthly.filter((item) => billingContext(data, item).queue === "subscription_pending").length} detail="Sin activación confirmada" icon={FileClock} tone="slate" />
        <Metric label="Pagos pendientes" value={data.payments.filter((item) => item.status === "pending").length} detail="Esperando estado final" icon={Clock3} tone="amber" />
        <Metric label="Reintentos" value={monthly.filter((item) => billingContext(data, item).queue === "retry").length} detail="Adicional programado" icon={RefreshCcw} tone="amber" />
        <Metric label="Revisión manual" value={monthly.filter((item) => ["reconcile", "review"].includes(billingContext(data, item).queue)).length} detail="Sin nuevo cargo automático" icon={CircleAlert} tone="blue" />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-[minmax(13rem,1fr),10.5rem,11.5rem,13rem,auto]">
        <div className="sm:col-span-2 md:col-span-3 xl:col-span-1">
        <SearchField value={query} onChange={setQuery} placeholder="Buscar donante o referencia" />
        </div>
        <label className="block"><span className="sr-only">Tipo de aporte</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/20 sm:text-sm"><option value="all">Todos los tipos</option><option value="monthly">Mensual</option><option value="one_time">Único</option></select></label>
        <label className="block"><span className="sr-only">Filtrar estado</span><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/20 sm:text-sm"><option value="all">Todos los estados</option><option value="active">Activas</option><option value="pending">Pendientes</option><option value="past_due">Por revisar</option><option value="cancelled">Canceladas</option></select></label>
        <label className="block"><span className="sr-only">Filtrar seguimiento</span><select value={queue} onChange={(event) => setQueue(event.target.value as typeof queue)} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/20 sm:text-sm"><option value="all">Todo el seguimiento</option><option value="retry">Reintento programado</option><option value="reconcile">Por conciliar</option><option value="review">Revisión manual</option><option value="subscription_pending">Suscripción pendiente</option><option value="scheduled">Programadas</option></select></label>
        {filtered && <button type="button" aria-label="Limpiar filtros" title="Limpiar filtros" onClick={() => { setQuery(""); setFrequency("all"); setStatus("all"); setQueue("all"); setSelectedId(null); }} className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"><X aria-hidden="true" className="h-4 w-4" /></button>}
      </div>
      <p className="text-xs text-slate-600"><span className="font-semibold tabular-nums">{subscriptions.length}</span> registros</p>
      <div className={cn("min-w-0", selected && "xl:grid xl:grid-cols-[minmax(0,1fr),19rem] xl:gap-5")}>
      <section className="min-w-0 border-y border-slate-200">
        <div className="relative hidden lg:block">
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
              <tr>
                <th scope="col" className="w-[30%] px-3 py-2 2xl:w-[26%]">Donante</th>
                <th scope="col" className="w-[16%] px-3 py-2 text-right 2xl:w-[14%]">Aporte</th>
                <th scope="col" className="w-[11%] px-3 py-2 2xl:w-[10%]">Tipo de aporte</th>
                <th scope="col" className="w-[21%] px-3 py-2 2xl:w-[19%]">Estado</th>
                <th scope="col" className="px-3 py-2">Próximo cobro</th>
                <th scope="col" className="hidden w-[12%] px-3 py-2 2xl:table-cell">Último pago</th>
                <th scope="col" className="w-12 px-1 py-2"><span className="sr-only">Ver detalle</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {subscriptions.map((subscription) => {
                const donor = data.donors.find((item) => item.id === subscription.donorId);
                const latestPayment = data.payments.filter((payment) => payment.subscriptionId === subscription.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                const context = billingContext(data, subscription);
                return (
                  <tr key={subscription.id} className={cn("hover:bg-slate-50", selectedId === subscription.id && "bg-teal-50/60")}>
                    <td className="px-3 py-2"><button type="button" aria-label={`Abrir resumen de ${donor?.fullName ?? "donante"}`} aria-pressed={selectedId === subscription.id} onClick={() => setSelectedId(subscription.id)} className="hidden min-h-11 w-full break-words text-left font-semibold text-slate-900 hover:text-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 xl:block">{donor?.fullName}<span className="mt-0.5 block break-all text-[11px] font-normal text-slate-600">{subscription.reference}</span></button><Link href={donorDetailHref(subscription.donorId, subscription.id)} className="block min-h-11 break-words py-1 font-semibold text-slate-900 hover:text-teal-900 xl:hidden">{donor?.fullName}<span className="mt-0.5 block break-all text-[11px] font-normal text-slate-600">{subscription.reference}</span></Link></td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatCurrencyCOP(subscription.amount)}</td>
                    <td className="px-3 py-2 text-xs text-slate-700">{contributionLabel(subscription.frequency)}</td>
                    <td className="px-3 py-2"><CompactStatus type="subscription" status={subscription.status} />{context.queue !== "scheduled" && <p className="mt-0.5"><QueueLabel queue={context.queue} /></p>}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{subscription.frequency === "monthly" ? <>{subscription.preferredPaymentDay && <p>Día {subscription.preferredPaymentDay}</p>}<p className="mt-0.5">{context.retryAt ? formatDate(context.retryAt) : nextChargeLabel(subscription)}</p></> : <span>No aplica</span>}</td>
                    <td className="hidden px-3 py-2 2xl:table-cell">{latestPayment ? <CompactStatus type="payment" status={latestPayment.status} /> : <span className="text-xs text-slate-600">Sin pago</span>}</td>
                    <td className="px-1 py-2 text-right"><Link href={donorDetailHref(subscription.donorId, subscription.id)} className="inline-flex h-11 w-11 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700" aria-label={`Ver detalle de ${donor?.fullName ?? "donante"}`} title="Ver detalle"><ChevronRight aria-hidden="true" className="h-4 w-4" /></Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-200 lg:hidden">{subscriptions.map((subscription) => <MobileSubscriptionRow key={subscription.id} data={data} subscription={subscription} />)}</div>
        {subscriptions.length === 0 && <p className="px-5 py-10 text-center text-sm text-slate-500">No hay suscripciones que coincidan con los filtros.</p>}
      </section>
      {selected && <SubscriptionPeek key={selected.id} data={data} subscription={selected} onClose={() => setSelectedId(null)} />}
      </div>
    </div>
  );
}

function PaymentsList({ data }: { data: AdminDemoState }) {
  const [status, setStatus] = useState<"all" | DemoPaymentStatus>("all");
  const [frequency, setFrequency] = useState<"all" | "unlinked" | DemoSubscription["frequency"]>("all");
  const payments = data.payments.filter((payment) => {
    const subscription = data.subscriptions.find((item) => item.id === payment.subscriptionId);
    const matchesFrequency = frequency === "all" || (frequency === "unlinked" ? !subscription : subscription?.frequency === frequency);
    return matchesFrequency && (status === "all" || payment.status === status);
  });

  return (
    <div className="space-y-5">
      <PageHeading eyebrow="Pagos" title="Historial de transacciones" description="Resultados de pago · Calendario Colombia" />
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr),11rem,12rem] md:items-center">
        <p className="text-sm text-slate-500"><span className="font-semibold tabular-nums text-slate-900">{payments.length}</span> transacciones visibles</p>
        <label className="block"><span className="sr-only">Tipo de aporte</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20"><option value="all">Todos los tipos</option><option value="monthly">Mensual</option><option value="one_time">Único</option><option value="unlinked">Sin vincular</option></select></label>
        <label className="block"><span className="sr-only">Filtrar pagos por estado</span><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20"><option value="all">Todos los pagos</option><option value="approved">Aprobados</option><option value="pending">Pendientes</option><option value="declined">Rechazados</option></select></label>
      </div>
      <section aria-label="Registro de pagos" className="min-w-0 border-y border-slate-200">
        <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr),7rem,7rem,10rem] gap-3 border-b border-slate-200 bg-slate-50 py-2 text-xs font-semibold text-slate-600 md:grid"><span>Donante / transacción</span><span className="text-right">Monto</span><span>Estado</span><span className="text-right">Fecha Colombia</span></div>
        <div className="divide-y divide-slate-100">
          {payments.map((payment) => {
            const subscription = data.subscriptions.find((item) => item.id === payment.subscriptionId);
            const donor = data.donors.find((item) => item.id === subscription?.donorId);
            return (
              <Link key={payment.id} href={donor && subscription ? donorDetailHref(donor.id, subscription.id) : "/admin"} className="relative grid min-w-0 grid-cols-[minmax(0,1fr),auto] gap-x-3 gap-y-1.5 py-3 text-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 md:grid-cols-[minmax(0,1fr),7rem,7rem,10rem] md:items-center">
                <div className="min-w-0"><p className="break-words font-semibold text-slate-900">{donor?.fullName ?? "Sin donante vinculado"}</p><p className="sr-only mt-0.5 break-all text-xs text-slate-600 md:not-sr-only">{payment.wompiTransactionId}</p><p className="mt-0.5 text-xs text-slate-600">{subscription ? contributionLabel(subscription.frequency) : "Sin vincular"}</p></div>
                <p className="text-right font-semibold tabular-nums text-slate-900">{formatCurrencyCOP(payment.amount)}</p>
                <CompactStatus type="payment" status={payment.status} />
                <p className="text-right text-xs text-slate-600">{formatDate(payment.createdAt, true)}</p>
              </Link>
            );
          })}
        </div>
        {payments.length === 0 && <p className="px-5 py-10 text-center text-sm text-slate-500">No hay pagos que coincidan con los filtros.</p>}
      </section>
    </div>
  );
}

type AdminMutation = {
  action: "amount" | "schedule" | "cancel" | "reactivate" | "cancel_retry";
  reason: string;
  totpCode: string;
  amount?: number;
  preferredPaymentDay?: 1 | 6 | 16 | 28;
  nextPaymentDate?: string;
  donorAuthorizationConfirmed?: boolean;
  expectedCycleId?: string;
};

function monthFromDate(value: string | null) {
  const source = value ? new Date(value) : new Date();
  const colombia = new Date(source.getTime() - 5 * 60 * 60 * 1000);
  return `${colombia.getUTCFullYear()}-${String(colombia.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function DonorDetail({ data, donorId, subscriptionId, demo, readOnly, onMutate }: { data: AdminDemoState; donorId: string; subscriptionId?: string; demo: boolean; readOnly: boolean; onMutate: (subscriptionId: string, version: number, mutation: AdminMutation) => Promise<void> }) {
  const router = useRouter();
  const donor = data.donors.find((item) => item.id === donorId);
  const subscriptions = donorSubscriptions(data, donorId);
  const subscription = subscriptionId
    ? subscriptions.find((item) => item.id === subscriptionId)
    : primarySubscription(data, donorId);
  const context = subscription ? billingContext(data, subscription) : null;
  const hasOpenAttempt = context?.queue === "retry" || context?.queue === "reconcile"
    || (subscription?.attemptState !== undefined && subscription.attemptState !== null && ["prepared", "pending", "dispatching", "unknown"].includes(subscription.attemptState))
    || context?.attempts.some((attempt) => ["prepared", "pending", "dispatching", "unknown"].includes(attempt.state)) === true;
  const canCancelRetry = Boolean(subscription?.frequency === "monthly" && !readOnly && context?.cycle?.id && context.queue !== "reconcile"
    && (context?.queue === "retry" || context?.attempts.some((attempt) => attempt.state === "prepared")));
  const [selectedDay, setSelectedDay] = useState<1 | 6 | 16 | 28>(subscription?.preferredPaymentDay ?? 16);
  const [selectedMonth, setSelectedMonth] = useState(monthFromDate(subscription?.nextPaymentDate ?? null));
  const [amount, setAmount] = useState(String(subscription?.amount ?? 1500));
  const [actionOpen, setActionOpen] = useState<AdminMutation["action"] | null>(null);
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [donorAuthorizationConfirmed, setDonorAuthorizationConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const expectedVersionRef = useRef(0);
  const beforeRef = useRef<typeof subscription>(undefined);
  const expectedCycleRef = useRef<string | undefined>(undefined);
  const submittingRef = useRef(false);

  const openAction = useCallback((action: AdminMutation["action"]) => {
    if (readOnly || subscription?.frequency !== "monthly" || submittingRef.current) return;
    if ((action === "amount" || action === "schedule" || action === "reactivate") && hasOpenAttempt) return;
    if (action === "cancel_retry" && !canCancelRetry) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    expectedVersionRef.current = subscription?.billingVersion ?? 0;
    beforeRef.current = subscription ? { ...subscription } : undefined;
    expectedCycleRef.current = context?.cycle?.id;
    setActionOpen(action);
  }, [readOnly, subscription, hasOpenAttempt, canCancelRetry, context?.cycle?.id]);

  const closeAction = useCallback(() => {
    if (submittingRef.current) return;
    setActionOpen(null);
    setDonorAuthorizationConfirmed(false);
    window.setTimeout(() => previousFocusRef.current?.focus(), 0);
  }, []);

  useEffect(() => setSelectedDay(subscription?.preferredPaymentDay ?? 16), [subscription?.id, subscription?.preferredPaymentDay]);
  useEffect(() => setSelectedMonth(monthFromDate(subscription?.nextPaymentDate ?? null)), [subscription?.id, subscription?.nextPaymentDate]);
  useEffect(() => setAmount(String(subscription?.amount ?? 1500)), [subscription?.id, subscription?.amount]);
  useEffect(() => {
    setActionOpen(null);
    setReason("");
    setTotpCode("");
    setDonorAuthorizationConfirmed(false);
  }, [subscription?.id]);
  useEffect(() => {
    if (!actionOpen) return;
    const dialog = dialogRef.current;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]";
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    const focusFrame = window.requestAnimationFrame(() => {
      const initialFocus = dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus]");
      (initialFocus ?? focusable()[0])?.focus();
    });
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAction();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleDialogKeys);
    };
  }, [actionOpen, closeAction]);

  if (!donor || !subscription) {
    return (
      <div className="space-y-6"><Link href="/admin/donantes" className="inline-flex items-center gap-2 text-sm font-semibold text-foundation-blue hover:underline"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Volver a donantes</Link><PageHeading eyebrow="Donantes" title="Donante no encontrado" description="El registro no existe o no está disponible para esta sesión." /></div>
    );
  }

  const payments = data.payments.filter((payment) => payment.subscriptionId === subscription.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const events = data.auditEvents.filter((event) => event.subscriptionId === subscription.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const isMonthly = subscription.frequency === "monthly";
  const canEdit = isMonthly && !readOnly && subscription.status === "active" && !hasOpenAttempt;
  const canCancel = isMonthly && !readOnly && (subscription.status === "active" || subscription.status === "past_due");
  const canReactivate = isMonthly && !readOnly && !hasOpenAttempt && (subscription.status === "cancelled" || subscription.status === "past_due");
  const nextPaymentDate = getDemoNextPaymentDate(selectedDay, selectedMonth);
  const nextPaymentIsFuture = new Date(nextPaymentDate).getTime() > Date.now();
  const parsedAmount = Number(amount);
  const amountIsValid = Number.isInteger(parsedAmount) && parsedAmount >= 1500 && parsedAmount <= 21474836;
  const before = beforeRef.current ?? subscription;
  const beforeSummary = actionOpen === "amount" ? formatCurrencyCOP(before.amount)
    : actionOpen === "schedule" ? `Día ${before.preferredPaymentDay} · ${formatDate(before.nextPaymentDate)}`
      : actionOpen === "cancel_retry" ? `Reintento programado · ${formatDate(before.retryAt ?? context?.retryAt ?? null)}`
      : `${subscriptionLabel(before.status)} · ${before.nextPaymentDate ? formatDate(before.nextPaymentDate) : "Sin próximo cobro"}`;
  const afterSummary = actionOpen === "amount" ? (amountIsValid ? formatCurrencyCOP(parsedAmount) : "Monto no válido")
    : actionOpen === "cancel" ? "Cancelada · Sin futuros cobros programados"
      : actionOpen === "cancel_retry" ? "Revisión manual · Sin adicional ni próximo cobro automático"
      : `${actionOpen === "reactivate" ? "Activa · " : ""}Día ${selectedDay} · ${formatDate(nextPaymentDate)} · 7:00 a. m. Colombia`;

  async function confirmAction() {
    if (
      !actionOpen
      || !isMonthly || readOnly || submittingRef.current
      || reason.trim().length < 5
      || (!demo && !/^\d{6}$/.test(totpCode))
      || ((actionOpen === "schedule" || actionOpen === "reactivate") && !nextPaymentIsFuture)
      || (actionOpen === "reactivate" && !donorAuthorizationConfirmed)
      || (actionOpen === "amount" && !amountIsValid)
      || ((actionOpen === "amount" || actionOpen === "schedule" || actionOpen === "reactivate") && hasOpenAttempt)
      || (actionOpen === "cancel_retry" && !canCancelRetry)
    ) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onMutate(subscription!.id, expectedVersionRef.current, {
        action: actionOpen,
        reason: reason.trim(),
        totpCode,
        amount: actionOpen === "amount" ? parsedAmount : undefined,
        preferredPaymentDay: actionOpen === "schedule" || actionOpen === "reactivate" ? selectedDay : undefined,
        nextPaymentDate: actionOpen === "schedule" || actionOpen === "reactivate" ? nextPaymentDate : undefined,
        donorAuthorizationConfirmed: actionOpen === "reactivate" ? donorAuthorizationConfirmed : undefined,
        expectedCycleId: actionOpen === "cancel_retry" ? expectedCycleRef.current : undefined,
      });
      submittingRef.current = false;
      closeAction();
      setReason("");
      setTotpCode("");
    } catch {
      // onMutate already shows a sanitized error notice and the dialog stays open.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const actionTitle = {
    amount: "Cambiar monto mensual",
    schedule: "Cambiar próximo cobro",
    cancel: "Cancelar suscripción",
    reactivate: "Reactivar suscripción",
    cancel_retry: "Cancelar reintento programado",
  } as const;

  return (
    <div className="min-w-0 space-y-5">
      <Link href="/admin/donantes" className="inline-flex items-center gap-2 text-sm font-semibold text-foundation-blue hover:underline"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Volver a donantes</Link>
      <PageHeading eyebrow="Detalle del donante" title={donor.fullName} description="Los datos personales y los identificadores de pago son de solo lectura." action={<StatusBadge type="subscription" status={subscription.status} />} />
      <p className="text-xs text-slate-500">Version de facturacion: {subscription.billingVersion}</p>

      {subscriptions.length > 1 && (
        <section className="grid gap-3 border-y border-slate-200 py-3 sm:grid-cols-[minmax(0,1fr),auto] sm:items-end">
          <label className="block text-sm font-semibold text-slate-700">
            Aporte seleccionado
            <select
              value={subscription.id}
              onChange={(event) => router.push(donorDetailHref(donorId, event.target.value))}
              className="mt-2 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20"
            >
              {subscriptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {contributionLabel(item.frequency)} · {subscriptionLabel(item.status)} · {item.reference} · {formatCurrencyCOP(item.amount)}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm text-slate-500">{subscriptions.length} registros</p>
        </section>
      )}

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.55fr),minmax(0,0.8fr)]">
        <div className="min-w-0 space-y-5">
          <section className="border-y border-slate-200 py-4">
            <div className="grid grid-cols-2 gap-x-5 gap-y-4 2xl:grid-cols-4">
              <div className="min-w-0"><SmallLabel>{isMonthly ? "Aporte mensual" : "Aporte único"}</SmallLabel><p className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{formatCurrencyCOP(subscription.amount)}</p>{isMonthly && <button type="button" disabled={!canEdit} onClick={() => openAction("amount")} className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 disabled:text-slate-500"><Pencil aria-hidden="true" className="h-3 w-3" /> Cambiar siguiente cobro</button>}</div>
              <div className="min-w-0"><SmallLabel>Tipo de aporte</SmallLabel><p className="mt-1 text-base font-semibold text-slate-950">{contributionLabel(subscription.frequency)}</p>{isMonthly && <p className="mt-1 text-xs text-slate-600">{subscription.preferredPaymentDay ? `Día ${subscription.preferredPaymentDay} · Colombia` : "Sin día confirmado"}</p>}</div>
              <div className="min-w-0"><SmallLabel>Próximo cobro</SmallLabel><p className="mt-1 text-sm font-semibold text-slate-950">{nextChargeLabel(subscription)}</p>{isMonthly && subscription.nextPaymentDate && <p className="mt-1 text-xs text-slate-600">7:00 a. m. Colombia</p>}</div>
              <div className="min-w-0"><SmallLabel>Método</SmallLabel><p className="mt-1 text-sm font-semibold text-slate-950">{subscription.paymentMethod}</p></div>
            </div>
          </section>

          {isMonthly && <section className="border-b border-slate-200 pb-4">
            <div className="pb-3"><h2 className="text-sm font-semibold text-slate-950">Calendario de cobro</h2></div>
            {hasOpenAttempt && <p role="status" className="mb-3 text-sm leading-5 text-amber-900">Hay un intento reservado, programado o por conciliar. Monto y fecha bloqueados.</p>}
            <div>
              <label className="mb-4 block max-w-xs text-sm font-semibold text-slate-700">Mes del próximo cobro<input type="month" value={selectedMonth} min={monthFromDate(null)} onChange={(event) => setSelectedMonth(event.target.value)} disabled={!canEdit && !canReactivate} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 text-base disabled:bg-slate-100" /></label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Día preferido de cobro">
                {dayOptions.map((day) => <button key={day} type="button" aria-pressed={selectedDay === day} onClick={() => setSelectedDay(day)} disabled={!canEdit && !canReactivate} className={cn("min-h-11 rounded-md border px-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foundation-blue", selectedDay === day ? "border-foundation-blue bg-blue-50 text-foundation-blue" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300", !canEdit && !canReactivate && "cursor-not-allowed opacity-50")}>Día {day}</button>)}
              </div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm leading-5 text-slate-600">Nueva fecha: <span className="font-semibold text-slate-900">{formatDate(nextPaymentDate)}</span></p>{canEdit && <button type="button" onClick={() => openAction("schedule")} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-teal-800 px-4 text-sm font-semibold text-white hover:bg-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"><CheckCircle2 aria-hidden="true" className="h-4 w-4" />Guardar cambios</button>}</div>
            </div>
          </section>}

          <section className="border-b border-slate-200 pb-4"><h2 className="mb-3 text-sm font-semibold text-slate-950">Intentos y ciclo</h2><AttemptHistory data={data} subscription={subscription} />
            {canCancelRetry && <button type="button" onClick={() => openAction("cancel_retry")} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-rose-300 px-3 text-sm font-semibold text-rose-800 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-700"><X aria-hidden="true" className="h-4 w-4" />Cancelar reintento</button>}
          </section>
          <section className="border-b border-slate-200 pb-4">
            <div className="pb-2"><h2 className="text-sm font-semibold text-slate-950">Pagos</h2></div>
            <div className="divide-y divide-slate-100">
              {payments.map((payment) => <div key={payment.id} className="grid min-w-0 grid-cols-[minmax(0,1fr),auto] items-start gap-3 py-3"><div className="min-w-0"><p className="text-sm font-semibold tabular-nums text-slate-900">{formatCurrencyCOP(payment.amount)}</p><p className="mt-1 break-all text-xs text-slate-600">{payment.wompiTransactionId}</p><p className="mt-1 text-xs text-slate-600">{formatDate(payment.createdAt, true)}</p></div><CompactStatus type="payment" status={payment.status} /></div>)}
              {payments.length === 0 && <p className="py-3 text-sm text-slate-600">Sin pagos registrados.</p>}
            </div>
          </section>
        </div>

        <div className="min-w-0 space-y-5 xl:border-l xl:border-slate-200 xl:pl-5">
          <section className="border-b border-slate-200 pb-4"><h2 className="text-sm font-semibold text-slate-950">Contacto</h2><dl className="mt-3 space-y-3 text-sm"><div><dt className="text-xs text-slate-600">Correo</dt><dd className="mt-1 break-all font-medium text-slate-900">{listEmail(donor)}</dd></div><div><dt className="text-xs text-slate-600">Teléfono</dt><dd className="mt-1 font-medium text-slate-900">{listPhone(donor)}</dd></div><div><dt className="text-xs text-slate-600">Ciudad</dt><dd className="mt-1 font-medium text-slate-900">{donor.city}</dd></div></dl></section>
          <section className="border-b border-slate-200 pb-4"><h2 className="text-sm font-semibold text-slate-950">Actividad</h2><ol className="divide-y divide-slate-100">{events.map((event) => <li key={event.id} className="py-3"><p className="break-words text-sm leading-5 text-slate-800">{event.detail}</p>{event.actorLabel && <p className="mt-1 text-xs text-slate-600">{event.actorLabel}{event.requestLabel ? ` · Solicitud ${event.requestLabel}` : ""}</p>}<p className="mt-1 text-xs text-slate-600">{formatDate(event.createdAt, true)}</p></li>)}</ol>{events.length === 0 && <p className="py-3 text-sm text-slate-600">Sin cambios administrativos registrados.</p>}</section>
          {canReactivate && <section className="border-b border-slate-200 pb-4"><h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950"><Power aria-hidden="true" className="h-4 w-4 text-emerald-700" />Reactivar suscripción</h2><p className="mt-2 text-sm leading-5 text-slate-600">Nueva autorización del donante y próxima fecha futura. Sin cargo al guardar.</p><button type="button" onClick={() => { setDonorAuthorizationConfirmed(false); openAction("reactivate"); }} className="mt-3 min-h-11 w-full rounded-md bg-teal-800 px-4 text-sm font-semibold text-white hover:bg-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700">Revisar reactivación</button></section>}
          {canCancel && <section className="border-b border-slate-200 pb-4"><h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950"><CircleX aria-hidden="true" className="h-4 w-4 text-rose-700" />Cancelar suscripción</h2><p className="mt-2 text-sm leading-5 text-slate-600">Detiene futuros cobros y conserva el historial. Un cargo ya enviado a Wompi puede terminar; cancelar no revierte un pago.</p><button type="button" onClick={() => openAction("cancel")} className="mt-3 min-h-11 w-full rounded-md border border-rose-300 px-4 text-sm font-semibold text-rose-800 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-700">Cancelar suscripción</button></section>}
        </div>
      </div>

      {actionOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="admin-action-title">
          <div ref={dialogRef} tabIndex={-1} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4"><h2 id="admin-action-title" className="text-lg font-semibold text-slate-950">{actionTitle[actionOpen]}</h2><button type="button" aria-label="Cerrar diálogo" disabled={submitting} onClick={closeAction} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 disabled:opacity-50"><X aria-hidden="true" className="h-5 w-5" /></button></div>
            {actionOpen === "amount" && <label className="mt-5 block text-sm font-semibold text-slate-700">Nuevo monto mensual<input type="number" min={1500} max={21474836} step={1} disabled={submitting} value={amount} onChange={(event) => setAmount(event.target.value)} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 text-base" /><span className="mt-1 block text-xs font-normal text-slate-500">Aplicará al siguiente cobro. No modifica pagos anteriores.</span></label>}
            <section aria-label="Resumen del cambio" className="mt-5 border-y border-slate-200 py-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="min-w-0"><h3 className="font-semibold text-slate-500">Antes</h3><p className="mt-2 break-words text-slate-900">{beforeSummary}</p></div>
                <div className="min-w-0"><h3 className="font-semibold text-slate-500">Después</h3><p className="mt-2 break-words font-semibold text-slate-900">{afterSummary}</p></div>
              </div>
              <p className="mt-3 text-xs text-slate-500">Versión revisada: {expectedVersionRef.current}</p>
            </section>
            {actionOpen === "cancel" && <p className="mt-4 text-sm leading-6 text-rose-800">Se conserva el historial. Un cargo ya enviado a Wompi puede terminar. No se revierte ni se elimina un pago.</p>}
            {actionOpen === "cancel_retry" && <p className="mt-4 text-sm leading-6 text-rose-800">Cancela la reserva o el adicional antes del envío. Los intentos anteriores se conservan. Si Wompi pudo recibirlo, se debe conciliar.</p>}
            {(actionOpen === "schedule" || actionOpen === "reactivate") && <p className={cn("mt-5 rounded-md p-3 text-sm", nextPaymentIsFuture ? "bg-blue-50 text-blue-900" : "bg-rose-50 text-rose-800")}>Próximo cobro: <strong>{formatDate(nextPaymentDate)}</strong>. {nextPaymentIsFuture ? "Guardar no realiza un cobro." : "Elige una fecha futura antes de continuar."}</p>}
            {actionOpen === "reactivate" && <label className="mt-4 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950"><input type="checkbox" disabled={submitting} checked={donorAuthorizationConfirmed} onChange={(event) => setDonorAuthorizationConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-emerald-300 text-emerald-700" /><span>Confirmo que el donante autorizó reactivar los cobros y un único reintento al día siguiente por fondos insuficientes verificados.</span></label>}
            <label className="mt-5 block text-sm font-semibold text-slate-700">Motivo<textarea data-dialog-initial-focus disabled={submitting} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 text-base font-normal" placeholder="Mínimo 5 caracteres para la auditoría" /></label>
            {!demo && <label className="mt-4 block text-sm font-semibold text-slate-700">Código actual de Google Authenticator<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={submitting} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 text-center text-lg font-bold tracking-normal" /></label>}
            <p className="mt-5 text-sm font-semibold text-slate-900">¿Confirmas este cambio?</p>
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button type="button" disabled={submitting} onClick={closeAction} className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 disabled:opacity-50">Volver</button><button type="button" disabled={readOnly || submitting || reason.trim().length < 5 || (!demo && totpCode.length !== 6) || (actionOpen === "amount" && !amountIsValid) || ((actionOpen === "schedule" || actionOpen === "reactivate") && (!nextPaymentIsFuture || hasOpenAttempt)) || (actionOpen === "amount" && hasOpenAttempt) || (actionOpen === "reactivate" && !donorAuthorizationConfirmed) || (actionOpen === "cancel_retry" && !canCancelRetry)} onClick={confirmAction} className="min-h-11 rounded-md bg-teal-800 px-4 text-sm font-semibold text-white hover:bg-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 disabled:opacity-50">{submitting ? "Guardando..." : "Confirmar cambio"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

export function AdminConsole({ initialView, donorId, subscriptionId, initialData, demo, adminEmail, readOnly = !demo }: AdminConsoleProps) {
  const router = useRouter();
  const [data, setData] = useState<AdminDemoState>(initialData);
  const [hydrated, setHydrated] = useState(!demo);
  const [notice, setNotice] = useState<Notice>(null);
  const requests = useRef(new Map<string, string>());
  const activeView: AdminView = donorId ? "detail" : initialView;

  useEffect(() => {
    if (demo) {
      setData(loadDemoState());
      setHydrated(true);
    } else {
      setData(initialData);
    }
  }, [demo, initialData]);
  useEffect(() => { if (demo && hydrated) window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(data)); }, [data, demo, hydrated]);
  useEffect(() => { if (!notice || notice.type === "error") return; const timeout = window.setTimeout(() => setNotice(null), 4000); return () => window.clearTimeout(timeout); }, [notice]);

  const resetDemo = () => { if (!demo) return; window.localStorage.removeItem(DEMO_STORAGE_KEY); setData(createAdminDemoState()); setNotice({ type: "info", message: "Los datos ficticios se restablecieron en este navegador." }); };
  const addAudit = (current: AdminDemoState, event: DemoAuditEvent) => ({ ...current, auditEvents: [event, ...current.auditEvents] });

  const submitConfirmed = async (url: string, method: string, input: Record<string, unknown>) => {
    if (readOnly) throw new Error("Solo lectura.");
    const { totpCode: _code, ...operation } = input;
    const key = JSON.stringify({ url, ...operation });
    const requestId = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, requestId }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) router.refresh();
        throw new Error(typeof result?.message === "string" ? result.message : "No se pudo confirmar el cambio.");
      }
      return { result, key };
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo confirmar el resultado. Reintenta la misma solicitud.";
      setNotice({ type: "error", message });
      throw error;
    }
  };

  const mutateSubscription = async (subscriptionId: string, version: number, mutation: AdminMutation) => {
    if (readOnly) throw new Error("Solo lectura.");
    if (data.subscriptions.find((item) => item.id === subscriptionId)?.frequency !== "monthly") {
      throw new Error("El aporte unico es de solo lectura.");
    }
    if (demo) {
      setData((current) => {
        const target = current.subscriptions.find((item) => item.id === subscriptionId);
        if (!target) return current;
        const updated = current.subscriptions.map((item) => {
          if (item.id !== subscriptionId) return item;
          if (mutation.action === "amount") return { ...item, amount: mutation.amount ?? item.amount, billingVersion: item.billingVersion + 1 };
          if (mutation.action === "schedule") return { ...item, preferredPaymentDay: mutation.preferredPaymentDay ?? item.preferredPaymentDay, nextPaymentDate: mutation.nextPaymentDate ?? item.nextPaymentDate, billingVersion: item.billingVersion + 1 };
          if (mutation.action === "cancel") return { ...item, status: "cancelled" as const, nextPaymentDate: null, retryAt: null, billingHoldReason: null, billingVersion: item.billingVersion + 1 };
          if (mutation.action === "cancel_retry") return { ...item, status: "past_due" as const, nextPaymentDate: null, retryAt: null, billingHoldReason: "admin_retry_cancelled", billingVersion: item.billingVersion + 1 };
          return { ...item, status: "active" as const, preferredPaymentDay: mutation.preferredPaymentDay ?? item.preferredPaymentDay, nextPaymentDate: mutation.nextPaymentDate ?? item.nextPaymentDate, retryAt: null, billingHoldReason: null, billingVersion: item.billingVersion + 1 };
        });
        const actionMap = { amount: "amount_changed", schedule: "schedule_changed", cancel: "subscription_cancelled", reactivate: "subscription_reactivated", cancel_retry: "retry_cancelled" } as const;
        const closesCycle = mutation.action === "cancel" || mutation.action === "cancel_retry" || mutation.action === "reactivate";
        const billingCycles = (current.billingCycles ?? []).map((cycle) => cycle.subscriptionId === subscriptionId && closesCycle && (cycle.state === "open" || cycle.state === "retry_wait")
          ? { ...cycle, state: mutation.action === "cancel" ? "cancelled" as const : "manual_review" as const, retryAt: null, holdReason: mutation.action === "cancel_retry" ? "admin_retry_cancelled" : cycle.holdReason } : cycle);
        if (mutation.action === "reactivate") billingCycles.push({ id: `cycle-local-${subscriptionId}-${target.billingVersion + 1}`, subscriptionId, billingPeriod: (mutation.nextPaymentDate ?? "").slice(0, 7).replace("-", ""), state: "open", retryAt: null, holdReason: null });
        const billingAttempts = (current.billingAttempts ?? []).map((attempt) => attempt.subscriptionId === subscriptionId && closesCycle && attempt.state === "prepared" ? { ...attempt, state: "cancelled" as const } : attempt);
        return addAudit({ ...current, subscriptions: updated, billingCycles, billingAttempts }, { id: `event-local-${Date.now()}`, subscriptionId, action: actionMap[mutation.action], detail: `${mutation.action} aplicado en vista local. Motivo: ${mutation.reason}`, createdAt: new Date().toISOString(), actorLabel: "Administrador local", requestLabel: "demo" });
      });
      setNotice({ type: "success", message: "Cambio aplicado solamente a los datos ficticios locales." });
      return;
    }

    const { result, key } = await submitConfirmed(`/api/admin/subscriptions/${subscriptionId}`, "PATCH", { ...mutation, expectedVersion: version });
    const confirmed = confirmedSubscriptionSchema.safeParse(result);
    if (!confirmed.success || confirmed.data.subscription.id !== subscriptionId || confirmed.data.subscription.billing_version <= version) {
      setNotice({ type: "error", message: "Respuesta sin confirmacion valida. No se actualizaron los datos mostrados." });
      throw new Error("UNCONFIRMED_RESULT");
    }
    requests.current.delete(key);
    const row = confirmed.data.subscription;
    setData((current) => ({ ...current, subscriptions: current.subscriptions.map((item) => item.id === row.id
      ? { ...item, amount: row.amount, status: row.status, billingVersion: row.billing_version,
        preferredPaymentDay: row.preferred_payment_day, nextPaymentDate: row.next_payment_date,
        billingHoldReason: row.billing_hold_reason ?? null,
        retryAt: mutation.action === "cancel" || mutation.action === "cancel_retry" ? null : item.retryAt } : item) }));
    setNotice({ type: row.chargeMayComplete ? "info" : "success", message: row.chargeMayComplete
      ? "Suscripción cancelada. Un cargo ya enviado podría finalizar; no se enviarán nuevos cobros."
      : "Cambio aplicado y registrado en auditoría." });
    router.refresh();
  };

  const recoverPaymentAttempt = async (attemptId: string, input: RecoveryInput) => {
    if (demo) {
      setNotice({ type: "info", message: "Demo desconectada: no se verifico ninguna transaccion ni se aprobo un pago." });
      return;
    }
    const { result, key } = await submitConfirmed(`/api/admin/payment-attempts/${attemptId}/reconcile`, "POST", input);
    const confirmed = confirmedRecoverySchema.safeParse(result);
    if (!confirmed.success || confirmed.data.recovery.attemptId !== attemptId || confirmed.data.recovery.transactionId !== input.transactionId) {
      setNotice({ type: "error", message: "Conciliacion sin confirmacion valida. El intento permanece por revisar." });
      throw new Error("UNCONFIRMED_RESULT");
    }
    requests.current.delete(key);
    const needsReview = confirmed.data.needsReview || confirmed.data.recovery.result === "review";
    setNotice({ type: needsReview ? "info" : "success",
      message: needsReview ? "Transaccion verificada; el resultado requiere revision." : `Resultado confirmado: ${confirmed.data.recovery.providerStatus ?? "por revisar"}.` });
    router.refresh();
  };

  return (
    <AdminShell activeView={activeView} onReset={resetDemo} demo={demo} adminEmail={adminEmail} readOnly={readOnly}>
      {activeView === "dashboard" && <Dashboard data={data} demo={demo} readOnly={readOnly} onRecover={recoverPaymentAttempt} />}
      {activeView === "donors" && <DonorList data={data} />}
      {activeView === "subscriptions" && <SubscriptionList data={data} />}
      {activeView === "payments" && <PaymentsList data={data} />}
      {activeView === "detail" && donorId && <DonorDetail data={data} donorId={donorId} subscriptionId={subscriptionId} demo={demo} readOnly={readOnly} onMutate={mutateSubscription} />}
      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
    </AdminShell>
  );
}
