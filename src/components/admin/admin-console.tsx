"use client";

import Link from "next/link";
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
  const isApproved = status === "active" || status === "approved";
  const isPending = status === "pending";
  const isReview = status === "past_due" || status === "review";
  const label = type === "subscription" ? subscriptionLabel(status as DemoSubscriptionStatus) : paymentLabel(status as DemoPaymentStatus);
  const Icon = isApproved ? CheckCircle2 : isPending ? Clock3 : isReview ? CircleAlert : CircleX;

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
        isApproved && "border-emerald-200 bg-emerald-50 text-emerald-700",
        isPending && "border-amber-200 bg-amber-50 text-amber-800",
        isReview && "border-orange-200 bg-orange-50 text-orange-800",
        status === "cancelled" && "border-slate-200 bg-slate-100 text-slate-600",
        status === "declined" && "border-rose-200 bg-rose-50 text-rose-700"
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function CompactStatus({ status, type }: { status: DemoSubscriptionStatus | DemoPaymentStatus; type: "subscription" | "payment" }) {
  const isApproved = status === "active" || status === "approved";
  const isPending = status === "pending";
  const isReview = status === "past_due" || status === "review";
  const label = type === "subscription" ? subscriptionLabel(status as DemoSubscriptionStatus) : paymentLabel(status as DemoPaymentStatus);

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium text-slate-700">
      <span
        aria-hidden="true"
        className={cn(
          "h-2 w-2 rounded-full",
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
  return <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</span>;
}

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  if (!notice) return null;

  return (
    <div
      aria-live="polite"
      className={cn(
        "fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-3 rounded-lg border px-4 py-3 shadow-lg",
        notice.type === "success"
          ? "border-emerald-200 bg-white text-emerald-900"
          : notice.type === "error"
            ? "border-rose-200 bg-white text-rose-900"
            : "border-blue-200 bg-white text-blue-900"
      )}
    >
      <CheckCircle2 aria-hidden="true" className={cn("mt-0.5 h-5 w-5 shrink-0", notice.type === "success" ? "text-emerald-600" : notice.type === "error" ? "text-rose-600" : "text-foundation-blue")} />
      <p className="flex-1 text-sm font-medium leading-5">{notice.message}</p>
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
          active ? "bg-foundation-blue text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
        )}
      >
        <Icon aria-hidden="true" className="h-4 w-4" />
        <span>{item.label}</span>
      </Link>
    );
  });

  return (
    <div className="min-h-dvh bg-slate-100 text-slate-900">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <div className="border-b border-slate-200 px-6 py-6">
          <p className="text-sm font-bold text-foundation-blue">Hablemos por Ellos</p>
          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Administración segura</p>
        </div>
        <nav aria-label="Navegación administrativa" className="flex flex-1 flex-col gap-1 p-4">
          {navItems}
        </nav>
        <div className={cn("m-4 rounded-lg border p-3 text-xs leading-5", demo ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-600")}>
          {demo ? "Vista local con datos ficticios. Ninguna acción contacta servicios externos." : `Sesión protegida con MFA: ${adminEmail}`}
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
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
              <span className={cn("hidden items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold sm:inline-flex", demo ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>
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

        <main id="admin-main" className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          {children}
          <footer className="mt-8 border-t border-slate-200 pt-4"><BuildIdentity /></footer>
        </main>
      </div>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-foundation-blue">{eyebrow}</p>
        <h1 className="mt-2 text-2xl font-bold tracking-normal text-slate-950 sm:text-3xl">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{description}</p>
      </div>
      {action}
    </div>
  );
}

function Metric({ label, value, detail, icon: Icon, tone }: { label: string; value: number; detail: string; icon: typeof Users; tone: "blue" | "green" | "amber" | "slate" }) {
  const toneClass = {
    blue: "border-blue-200 bg-blue-50 text-blue-700",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    slate: "border-slate-200 bg-slate-50 text-slate-700",
  }[tone];

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SmallLabel>{label}</SmallLabel>
          <p className="mt-2 text-3xl font-bold tabular-nums text-slate-950">{value}</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>
        </div>
        <span className={cn("inline-flex h-10 w-10 items-center justify-center rounded-md border", toneClass)}>
          <Icon aria-hidden="true" className="h-5 w-5" />
        </span>
      </div>
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
    <section className="rounded-lg border border-amber-200 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-amber-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-bold text-slate-950"><AlertTriangle aria-hidden="true" className="h-4 w-4 text-amber-600" /> Intentos por conciliar</h2>
          <p className="mt-1 text-sm text-slate-500">Wompi pudo recibir el cobro, pero la app no obtuvo su identificador. No vuelvas a cobrar.</p>
        </div>
        <span className="text-sm font-bold tabular-nums text-amber-800">{data.recoveryAttempts.length}</span>
      </div>
      <div className="relative overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-amber-50/60 text-xs uppercase text-slate-500"><tr><th className="px-3 py-3 sm:px-5">Donante</th><th className="hidden px-5 py-3 md:table-cell">Referencia</th><th className="px-3 py-3 sm:px-5">Monto</th><th className="hidden px-5 py-3 lg:table-cell">Desde</th><th className="px-3 py-3 text-right sm:px-5">Acción</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.recoveryAttempts.map((attempt) => {
              const donor = data.donors.find((item) => item.id === attempt.donorId);
              return <tr key={attempt.id}>
                <td className="min-w-0 px-3 py-3 font-semibold text-slate-900 sm:px-5">{donor?.fullName ?? "Donante"}<span className="mt-1 block break-all font-mono text-[10px] font-normal text-slate-500 md:hidden">{attempt.reference}</span><span className="mt-1 block text-xs font-normal text-slate-500">{attempt.state === "dispatching" ? "Envío estancado" : "Resultado incierto"} · {formatDate(attempt.createdAt, true)}</span></td>
                <td className="hidden whitespace-nowrap px-5 py-3 font-mono text-xs text-slate-600 md:table-cell">{attempt.reference}</td>
                <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums sm:px-5">{formatCurrencyCOP(attempt.amount)}</td>
                <td className="hidden whitespace-nowrap px-5 py-3 text-slate-600 lg:table-cell">{formatDate(attempt.createdAt, true)}</td>
                <td className="px-3 py-3 text-right sm:px-5"><button type="button" aria-label="Conciliar transacción" disabled={readOnly} title="Conciliar transacción" onClick={() => { expectedVersionRef.current = data.subscriptions.find((item) => item.id === attempt.subscriptionId)?.billingVersion ?? 0; setSelectedId(attempt.id); }} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-amber-300 px-3 font-bold text-amber-900 hover:bg-amber-50 disabled:opacity-50"><KeyRound aria-hidden="true" className="h-4 w-4" /><span className="hidden sm:inline">Conciliar</span><span className="sr-only sm:hidden">Conciliar</span></button></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

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
  const review = monthly.filter((subscription) => subscription.status === "past_due").length + data.recoveryAttempts.length;
  const reviewSubscriptions = monthly.filter((subscription) => subscription.status === "past_due" || subscription.status === "pending");

  return (
    <div className="space-y-7">
      <PageHeading
        eyebrow={demo ? "Vista local" : "Administración"}
        title="Centro de operaciones"
        description={demo
          ? "Datos simulados para revisar la experiencia del panel. No existe conexión a Supabase ni a Wompi."
          : "Resumen operativo de donantes, suscripciones y pagos recurrentes."}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Suscripciones activas" value={active} detail="Con cobro mensual programado" icon={Users} tone="green" />
        <Metric label="Canceladas" value={cancelled} detail="Sin próximos cobros" icon={CircleX} tone="slate" />
        <Metric label="Pagos pendientes" value={pending} detail="Esperando estado final" icon={Clock3} tone="amber" />
        <Metric label="Por revisar" value={review} detail="Requieren seguimiento" icon={AlertTriangle} tone="blue" />
      </div>

      <RecoveryQueue data={data} demo={demo} readOnly={readOnly} onRecover={onRecover} />

      <div className="grid gap-6 xl:grid-cols-[1.35fr,0.85fr]">
        <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="font-bold text-slate-950">Por revisar</h2>
              <p className="mt-1 text-sm text-slate-500">Pendientes y cobros que necesitan contexto.</p>
            </div>
            <Link href="/admin/suscripciones" className="inline-flex items-center gap-1 text-sm font-semibold text-foundation-blue hover:underline">
              Ver suscripciones <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          </div>
          <div className="divide-y divide-slate-100">
            {reviewSubscriptions.map((subscription) => {
              const donor = data.donors.find((item) => item.id === subscription.donorId);
              return (
                <Link key={subscription.id} href={donorDetailHref(subscription.donorId, subscription.id)} className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{donor?.fullName}</p>
                    <p className="mt-1 text-sm text-slate-500">{formatCurrencyCOP(subscription.amount)} mensual · {formatDate(subscription.nextPaymentDate)}</p>
                  </div>
                  <StatusBadge type="subscription" status={subscription.status} />
                </Link>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="font-bold text-slate-950">Actividad reciente</h2>
            <p className="mt-1 text-sm text-slate-500">{demo ? "Historial ficticio del panel local." : "Cambios administrativos registrados."}</p>
          </div>
          <ol className="divide-y divide-slate-100">
            {data.auditEvents.slice(0, 4).map((event) => (
              <li key={event.id} className="px-5 py-4">
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
        className="h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20"
      />
    </label>
  );
}

function DonorList({ data }: { data: AdminDemoState }) {
  const [query, setQuery] = useState("");
  const donors = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data.donors;
    return data.donors.filter((donor) => {
      const references = donorSubscriptions(data, donor.id).map((subscription) => subscription.reference);
      return [donor.fullName, donor.email, donor.phone, ...references].filter(Boolean).some((value) => value?.toLowerCase().includes(needle));
    });
  }, [data, query]);

  return (
    <div className="space-y-7">
      <PageHeading eyebrow="Donantes" title="Personas registradas" description="Búsqueda con correo y teléfono enmascarados por defecto." />
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr),auto] md:items-center">
        <SearchField value={query} onChange={setQuery} placeholder="Buscar por nombre, correo, teléfono o referencia" />
        <p className="text-sm font-medium text-slate-500"><span className="tabular-nums text-slate-900">{donors.length}</span> resultados</p>
      </div>
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="relative hidden overflow-x-auto xl:block">
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-semibold">Donante</th>
                <th className="px-5 py-3 font-semibold">Contacto</th>
                <th className="px-5 py-3 font-semibold">Aporte</th>
                <th className="px-5 py-3 font-semibold">Suscripción</th>
                <th className="px-5 py-3 font-semibold">Próximo cobro</th>
                <th className="px-5 py-3"><span className="sr-only">Abrir detalle</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {donors.map((donor) => {
                const subscription = primarySubscription(data, donor.id);
                return <DonorRow key={donor.id} donor={donor} subscription={subscription} />;
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-100 xl:hidden">
          {donors.map((donor) => {
            const subscription = primarySubscription(data, donor.id);
            return <DonorCard key={donor.id} donor={donor} subscription={subscription} />;
          })}
        </div>
      </section>
    </div>
  );
}

function DonorRow({ donor, subscription }: { donor: DemoDonor; subscription?: DemoSubscription }) {
  return (
    <tr className="transition hover:bg-slate-50">
      <td className="px-5 py-4"><p className="font-semibold text-slate-900">{donor.fullName}</p><p className="mt-1 text-xs text-slate-500">{donor.city}</p></td>
      <td className="px-5 py-4 text-slate-600"><p>{listEmail(donor)}</p><p className="mt-1 text-xs">{listPhone(donor)}</p></td>
      <td className="px-5 py-4 font-semibold tabular-nums text-slate-900">{subscription ? <><p>{formatCurrencyCOP(subscription.amount)}</p><p className="mt-1 text-xs font-medium text-slate-500">{contributionLabel(subscription.frequency)}</p></> : "—"}</td>
      <td className="px-5 py-4">{subscription ? <StatusBadge type="subscription" status={subscription.status} /> : "—"}</td>
      <td className="px-5 py-4 text-slate-600">{subscription ? nextChargeLabel(subscription) : "—"}</td>
      <td className="px-5 py-4 text-right"><Link href={donorDetailHref(donor.id, subscription?.id)} className="inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-foundation-blue" aria-label={`Ver detalle de ${donor.fullName}`} title="Ver detalle"><ChevronRight aria-hidden="true" className="h-4 w-4" /></Link></td>
    </tr>
  );
}

function DonorCard({ donor, subscription }: { donor: DemoDonor; subscription?: DemoSubscription }) {
  return (
    <Link href={donorDetailHref(donor.id, subscription?.id)} className="block px-4 py-4 transition hover:bg-slate-50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="truncate font-semibold text-slate-900">{donor.fullName}</p><p className="mt-1 truncate text-sm text-slate-500">{listEmail(donor)}</p></div>
        {subscription && <StatusBadge type="subscription" status={subscription.status} />}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm">
        <div><SmallLabel>Aporte</SmallLabel><p className="mt-1 font-semibold tabular-nums text-slate-900">{subscription ? formatCurrencyCOP(subscription.amount) : "—"}</p>{subscription && <p className="mt-1 text-xs text-slate-500">{contributionLabel(subscription.frequency)}</p>}</div>
        <div><SmallLabel>Próximo cobro</SmallLabel><p className="mt-1 text-slate-700">{subscription ? nextChargeLabel(subscription) : "—"}</p></div>
      </div>
    </Link>
  );
}

function SubscriptionList({ data }: { data: AdminDemoState }) {
  const [status, setStatus] = useState<"all" | DemoSubscriptionStatus>("all");
  const [frequency, setFrequency] = useState<"all" | DemoSubscription["frequency"]>("all");
  const [query, setQuery] = useState("");
  const subscriptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.subscriptions.filter((subscription) => {
      const donor = data.donors.find((item) => item.id === subscription.donorId);
      const matchesStatus = status === "all" || subscription.status === status;
      const matchesFrequency = frequency === "all" || subscription.frequency === frequency;
      const matchesQuery = !needle || [donor?.fullName, donor?.email, subscription.reference].filter(Boolean).some((value) => value?.toLowerCase().includes(needle));
      return matchesStatus && matchesFrequency && matchesQuery;
    });
  }, [data, query, status, frequency]);

  return (
    <div className="space-y-7">
      <PageHeading eyebrow="Suscripciones" title="Aportes y suscripciones" description="Fechas según el calendario de Colombia." />
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr),10rem,12rem]">
        <SearchField value={query} onChange={setQuery} placeholder="Buscar por donante, correo o referencia" />
        <label className="block"><span className="sr-only">Tipo de aporte</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20"><option value="all">Todos los tipos</option><option value="monthly">Mensual</option><option value="one_time">Único</option></select></label>
        <label className="block"><span className="sr-only">Filtrar estado</span><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20"><option value="all">Todos los estados</option><option value="active">Activas</option><option value="pending">Pendientes</option><option value="past_due">Por revisar</option><option value="cancelled">Canceladas</option></select></label>
      </div>
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="relative hidden overflow-x-auto lg:block">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-3">Donante</th>
                <th scope="col" className="px-4 py-3">Aporte</th>
                <th scope="col" className="px-4 py-3">Tipo de aporte</th>
                <th scope="col" className="px-4 py-3">Estado</th>
                <th scope="col" className="px-4 py-3">Próximo cobro</th>
                <th scope="col" className="px-4 py-3">Último pago</th>
                <th scope="col" className="px-3 py-3"><span className="sr-only">Ver detalle</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {subscriptions.map((subscription) => {
                const donor = data.donors.find((item) => item.id === subscription.donorId);
                const latestPayment = data.payments.filter((payment) => payment.subscriptionId === subscription.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                return (
                  <tr key={subscription.id} className="transition hover:bg-slate-50">
                    <td className="max-w-[18rem] px-5 py-3"><Link href={donorDetailHref(subscription.donorId, subscription.id)} className="block min-w-0"><p className="truncate font-semibold text-slate-900 hover:text-foundation-blue">{donor?.fullName}</p><p className="mt-0.5 truncate text-xs text-slate-500">{subscription.reference}</p></Link></td>
                    <td className="px-4 py-3 font-semibold tabular-nums text-slate-900">{formatCurrencyCOP(subscription.amount)}</td>
                    <td className="px-4 py-3 text-slate-700">{contributionLabel(subscription.frequency)}</td>
                    <td className="px-4 py-3"><CompactStatus type="subscription" status={subscription.status} /></td>
                    <td className="px-4 py-3">{subscription.frequency === "monthly" ? <><p className="font-medium text-slate-800">Día {subscription.preferredPaymentDay}</p><p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">{nextChargeLabel(subscription)}</p></> : <span className="text-slate-500">No aplica</span>}</td>
                    <td className="px-4 py-3">{latestPayment ? <CompactStatus type="payment" status={latestPayment.status} /> : <span className="text-slate-400">Sin pago</span>}</td>
                    <td className="px-3 py-2 text-right"><Link href={donorDetailHref(subscription.donorId, subscription.id)} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-foundation-blue" aria-label={`Ver detalle de ${donor?.fullName ?? "donante"}`} title="Ver detalle"><ChevronRight aria-hidden="true" className="h-4 w-4" /></Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-100 lg:hidden">
          {subscriptions.map((subscription) => {
            const donor = data.donors.find((item) => item.id === subscription.donorId);
            const latestPayment = data.payments.filter((payment) => payment.subscriptionId === subscription.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            return (
              <Link key={subscription.id} href={donorDetailHref(subscription.donorId, subscription.id)} className="block px-4 py-3 transition hover:bg-slate-50">
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-semibold text-slate-900">{donor?.fullName}</p><p className="mt-0.5 truncate text-xs text-slate-500">{subscription.reference} · {contributionLabel(subscription.frequency)}</p></div><CompactStatus type="subscription" status={subscription.status} /></div>
                <div className="mt-3 grid grid-cols-3 gap-3 border-t border-slate-100 pt-3 text-sm"><div><SmallLabel>Aporte</SmallLabel><p className="mt-1 font-semibold tabular-nums text-slate-900">{formatCurrencyCOP(subscription.amount)}</p></div><div><SmallLabel>Cobro</SmallLabel><p className="mt-1 font-medium text-slate-800">{subscription.frequency === "monthly" ? `Día ${subscription.preferredPaymentDay}` : "No aplica"}</p></div><div><SmallLabel>Pago</SmallLabel><p className="mt-1">{latestPayment ? <CompactStatus type="payment" status={latestPayment.status} /> : <span className="text-slate-400">Sin pago</span>}</p></div></div>
              </Link>
            );
          })}
        </div>
        {subscriptions.length === 0 && <p className="px-5 py-10 text-center text-sm text-slate-500">No hay suscripciones que coincidan con los filtros.</p>}
      </section>
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
    <div className="space-y-7">
      <PageHeading eyebrow="Pagos" title="Historial de transacciones" description="Cada fila representa un intento de pago. Los estados son de solo lectura." />
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr),11rem,12rem] md:items-center">
        <p className="text-sm text-slate-500"><span className="font-semibold tabular-nums text-slate-900">{payments.length}</span> transacciones visibles</p>
        <label className="block"><span className="sr-only">Tipo de aporte</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20"><option value="all">Todos los tipos</option><option value="monthly">Mensual</option><option value="one_time">Único</option><option value="unlinked">Sin vincular</option></select></label>
        <label className="block"><span className="sr-only">Filtrar pagos por estado</span><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-foundation-blue focus:outline-none focus:ring-2 focus:ring-foundation-blue/20"><option value="all">Todos los pagos</option><option value="approved">Aprobados</option><option value="pending">Pendientes</option><option value="declined">Rechazados</option></select></label>
      </div>
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="divide-y divide-slate-100">
          {payments.map((payment) => {
            const subscription = data.subscriptions.find((item) => item.id === payment.subscriptionId);
            const donor = data.donors.find((item) => item.id === subscription?.donorId);
            return (
              <Link key={payment.id} href={donor && subscription ? donorDetailHref(donor.id, subscription.id) : "/admin"} className="grid gap-3 px-4 py-4 transition hover:bg-slate-50 sm:grid-cols-[minmax(12rem,1.2fr),auto,auto,minmax(10rem,1fr)] sm:items-center sm:px-5">
                <div className="min-w-0"><p className="truncate font-semibold text-slate-900">{donor?.fullName ?? "Sin donante vinculado"}</p><p className="mt-1 truncate text-xs text-slate-500">{payment.wompiTransactionId}</p><p className="mt-1 text-xs text-slate-600">{subscription ? contributionLabel(subscription.frequency) : "Sin vincular"}</p></div>
                <p className="font-semibold tabular-nums text-slate-900">{formatCurrencyCOP(payment.amount)}</p>
                <StatusBadge type="payment" status={payment.status} />
                <p className="text-sm text-slate-600 sm:text-right">{formatDate(payment.createdAt, true)}</p>
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
  action: "amount" | "schedule" | "cancel" | "reactivate";
  reason: string;
  totpCode: string;
  amount?: number;
  preferredPaymentDay?: 1 | 6 | 16 | 28;
  nextPaymentDate?: string;
  donorAuthorizationConfirmed?: boolean;
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
  const submittingRef = useRef(false);

  const openAction = useCallback((action: AdminMutation["action"]) => {
    if (readOnly || subscription?.frequency !== "monthly" || submittingRef.current) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    expectedVersionRef.current = subscription?.billingVersion ?? 0;
    beforeRef.current = subscription ? { ...subscription } : undefined;
    setActionOpen(action);
  }, [readOnly, subscription]);

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
  const canEdit = isMonthly && !readOnly && subscription.status === "active";
  const canCancel = isMonthly && !readOnly && (subscription.status === "active" || subscription.status === "past_due");
  const canReactivate = isMonthly && !readOnly && (subscription.status === "cancelled" || subscription.status === "past_due");
  const nextPaymentDate = getDemoNextPaymentDate(selectedDay, selectedMonth);
  const nextPaymentIsFuture = new Date(nextPaymentDate).getTime() > Date.now();
  const parsedAmount = Number(amount);
  const amountIsValid = Number.isInteger(parsedAmount) && parsedAmount >= 1500 && parsedAmount <= 21474836;
  const before = beforeRef.current ?? subscription;
  const beforeSummary = actionOpen === "amount" ? formatCurrencyCOP(before.amount)
    : actionOpen === "schedule" ? `Día ${before.preferredPaymentDay} · ${formatDate(before.nextPaymentDate)}`
      : `${subscriptionLabel(before.status)} · ${before.nextPaymentDate ? formatDate(before.nextPaymentDate) : "Sin próximo cobro"}`;
  const afterSummary = actionOpen === "amount" ? (amountIsValid ? formatCurrencyCOP(parsedAmount) : "Monto no válido")
    : actionOpen === "cancel" ? "Cancelada · Sin futuros cobros programados"
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
  } as const;

  return (
    <div className="space-y-7">
      <Link href="/admin/donantes" className="inline-flex items-center gap-2 text-sm font-semibold text-foundation-blue hover:underline"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Volver a donantes</Link>
      <PageHeading eyebrow="Detalle del donante" title={donor.fullName} description="Los datos personales y los identificadores de pago son de solo lectura." action={<StatusBadge type="subscription" status={subscription.status} />} />
      <p className="text-xs text-slate-500">Version de facturacion: {subscription.billingVersion}</p>

      {subscriptions.length > 1 && (
        <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[minmax(0,1fr),auto] sm:items-end">
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr),minmax(19rem,0.8fr)]">
        <div className="space-y-6">
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div><SmallLabel>{isMonthly ? "Aporte mensual" : "Aporte único"}</SmallLabel><p className="mt-2 text-xl font-bold tabular-nums text-slate-950">{formatCurrencyCOP(subscription.amount)}</p>{isMonthly && <button type="button" disabled={!canEdit} onClick={() => openAction("amount")} className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-foundation-blue disabled:text-slate-400"><Pencil aria-hidden="true" className="h-3 w-3" /> Cambiar siguiente cobro</button>}</div>
              <div><SmallLabel>Tipo de aporte</SmallLabel><p className="mt-2 text-xl font-bold text-slate-950">{contributionLabel(subscription.frequency)}</p>{isMonthly && <p className="mt-1 text-xs text-slate-500">Día {subscription.preferredPaymentDay} · Colombia</p>}</div>
              <div><SmallLabel>Próximo cobro</SmallLabel><p className="mt-2 text-lg font-bold text-slate-950">{nextChargeLabel(subscription)}</p>{isMonthly && <p className="mt-1 text-xs text-slate-500">7:00 a. m. Colombia</p>}</div>
              <div><SmallLabel>Método</SmallLabel><p className="mt-2 text-lg font-bold text-slate-950">{subscription.paymentMethod}</p></div>
            </div>
          </section>

          {isMonthly && <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-slate-950">Calendario de cobro</h2><p className="mt-1 text-sm text-slate-500">Elige el día y el mes del siguiente cobro. Guardar no genera un cargo inmediato.</p></div>
            <div className="p-5">
              <label className="mb-4 block max-w-xs text-sm font-semibold text-slate-700">Mes del próximo cobro<input type="month" value={selectedMonth} min={monthFromDate(null)} onChange={(event) => setSelectedMonth(event.target.value)} disabled={!canEdit && !canReactivate} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 text-base disabled:bg-slate-100" /></label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Día preferido de cobro">
                {dayOptions.map((day) => <button key={day} type="button" aria-pressed={selectedDay === day} onClick={() => setSelectedDay(day)} disabled={!canEdit && !canReactivate} className={cn("min-h-11 rounded-md border px-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foundation-blue", selectedDay === day ? "border-foundation-blue bg-blue-50 text-foundation-blue" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300", !canEdit && !canReactivate && "cursor-not-allowed opacity-50")}>Día {day}</button>)}
              </div>
              <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm leading-6 text-slate-600">Nueva fecha: <span className="font-semibold text-slate-900">{formatDate(nextPaymentDate)}</span></p>{canEdit && <button type="button" onClick={() => openAction("schedule")} className="min-h-11 rounded-md bg-foundation-blue px-4 text-sm font-bold text-white">Guardar cambios</button>}</div>
            </div>
          </section>}

          <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-slate-950">Pagos</h2><p className="mt-1 text-sm text-slate-500">{demo ? "Historial de intentos simulados." : "Historial de transacciones de solo lectura."}</p></div>
            <div className="divide-y divide-slate-100">
              {payments.map((payment) => <div key={payment.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold tabular-nums text-slate-900">{formatCurrencyCOP(payment.amount)}</p><p className="mt-1 text-xs text-slate-500">{payment.wompiTransactionId} · {formatDate(payment.createdAt, true)}</p></div><StatusBadge type="payment" status={payment.status} /></div>)}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-bold text-slate-950">Contacto</h2><dl className="mt-4 space-y-4 text-sm"><div><dt className="text-slate-500">Correo</dt><dd className="mt-1 break-all font-medium text-slate-900">{listEmail(donor)}</dd></div><div><dt className="text-slate-500">Teléfono</dt><dd className="mt-1 font-medium text-slate-900">{listPhone(donor)}</dd></div><div><dt className="text-slate-500">Ciudad</dt><dd className="mt-1 font-medium text-slate-900">{donor.city}</dd></div></dl></section>
          <section className="rounded-lg border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-slate-950">Actividad</h2></div><ol className="divide-y divide-slate-100">{events.map((event) => <li key={event.id} className="px-5 py-4"><p className="text-sm font-medium leading-5 text-slate-800">{event.detail}</p>{event.actorLabel && <p className="mt-1 text-xs text-slate-500">{event.actorLabel}{event.requestLabel ? ` · Solicitud ${event.requestLabel}` : ""}</p>}<p className="mt-1 text-xs text-slate-500">{formatDate(event.createdAt, true)}</p></li>)}</ol></section>
          {canReactivate && <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-5"><div className="flex gap-3"><Power aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" /><div><h2 className="font-bold text-emerald-950">Reactivar suscripción</h2><p className="mt-1 text-sm leading-6 text-emerald-800">Programa el próximo cobro sin cargar la tarjeta al guardar.</p></div></div><button type="button" onClick={() => { setDonorAuthorizationConfirmed(false); openAction("reactivate"); }} className="mt-5 min-h-11 w-full rounded-md bg-emerald-700 px-4 text-sm font-bold text-white">Revisar reactivación</button></section>}
          {canCancel && <section className="rounded-lg border border-rose-200 bg-rose-50 p-5"><div className="flex gap-3"><CircleX aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-rose-700" /><div><h2 className="font-bold text-rose-950">Cancelar suscripción</h2><p className="mt-1 text-sm leading-6 text-rose-800">Detiene futuros cobros y conserva el historial. Un cargo ya enviado a Wompi puede terminar. Si hay un intento en proceso o incierto, la cancelación se bloqueará hasta confirmar su resultado.</p></div></div><button type="button" onClick={() => openAction("cancel")} className="mt-5 min-h-11 w-full rounded-md border border-rose-300 bg-white px-4 text-sm font-bold text-rose-700">Cancelar suscripción</button></section>}
        </div>
      </div>

      {actionOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="admin-action-title">
          <div ref={dialogRef} tabIndex={-1} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-wide text-foundation-blue">Confirmación administrativa</p><h2 id="admin-action-title" className="mt-2 text-xl font-bold text-slate-950">{actionTitle[actionOpen]}</h2></div><button type="button" aria-label="Cerrar diálogo" disabled={submitting} onClick={closeAction} className="inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-50"><X aria-hidden="true" className="h-5 w-5" /></button></div>
            {actionOpen === "amount" && <label className="mt-5 block text-sm font-semibold text-slate-700">Nuevo monto mensual<input type="number" min={1500} max={21474836} step={1} disabled={submitting} value={amount} onChange={(event) => setAmount(event.target.value)} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 text-base" /><span className="mt-1 block text-xs font-normal text-slate-500">Aplicará al siguiente cobro. No modifica pagos anteriores.</span></label>}
            <section aria-label="Resumen del cambio" className="mt-5 border-y border-slate-200 py-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="min-w-0"><h3 className="font-semibold text-slate-500">Antes</h3><p className="mt-2 break-words text-slate-900">{beforeSummary}</p></div>
                <div className="min-w-0"><h3 className="font-semibold text-slate-500">Después</h3><p className="mt-2 break-words font-semibold text-slate-900">{afterSummary}</p></div>
              </div>
              <p className="mt-3 text-xs text-slate-500">Versión revisada: {expectedVersionRef.current}</p>
            </section>
            {actionOpen === "cancel" && <p className="mt-4 text-sm leading-6 text-rose-800">Se conserva el historial. Un cargo ya enviado a Wompi puede terminar. Si hay un intento en proceso o incierto, la cancelación se bloqueará hasta confirmar su resultado.</p>}
            {(actionOpen === "schedule" || actionOpen === "reactivate") && <p className={cn("mt-5 rounded-md p-3 text-sm", nextPaymentIsFuture ? "bg-blue-50 text-blue-900" : "bg-rose-50 text-rose-800")}>Próximo cobro: <strong>{formatDate(nextPaymentDate)}</strong>. {nextPaymentIsFuture ? "Guardar no realiza un cobro." : "Elige una fecha futura antes de continuar."}</p>}
            {actionOpen === "reactivate" && <label className="mt-4 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950"><input type="checkbox" disabled={submitting} checked={donorAuthorizationConfirmed} onChange={(event) => setDonorAuthorizationConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-emerald-300 text-emerald-700" /><span>Confirmo que el donante autorizó reactivar los cobros automáticos.</span></label>}
            <label className="mt-5 block text-sm font-semibold text-slate-700">Motivo<textarea data-dialog-initial-focus disabled={submitting} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 text-base font-normal" placeholder="Mínimo 5 caracteres para la auditoría" /></label>
            {!demo && <label className="mt-4 block text-sm font-semibold text-slate-700">Código actual de Google Authenticator<input inputMode="numeric" maxLength={6} disabled={submitting} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="mt-2 h-11 w-full rounded-md border border-slate-300 px-3 text-center text-lg font-bold tracking-[0.3em]" /></label>}
            <p className="mt-5 text-sm font-semibold text-slate-900">¿Confirmas este cambio?</p>
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button type="button" disabled={submitting} onClick={closeAction} className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-bold text-slate-700 disabled:opacity-50">Volver</button><button type="button" disabled={readOnly || submitting || reason.trim().length < 5 || (!demo && totpCode.length !== 6) || (actionOpen === "amount" && !amountIsValid) || ((actionOpen === "schedule" || actionOpen === "reactivate") && !nextPaymentIsFuture) || (actionOpen === "reactivate" && !donorAuthorizationConfirmed)} onClick={confirmAction} className="min-h-11 rounded-md bg-foundation-blue px-4 text-sm font-bold text-white disabled:opacity-50">{submitting ? "Guardando..." : "Confirmar cambio"}</button></div>
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
          if (mutation.action === "cancel") return { ...item, status: "cancelled" as const, nextPaymentDate: null, billingVersion: item.billingVersion + 1 };
          return { ...item, status: "active" as const, preferredPaymentDay: mutation.preferredPaymentDay ?? item.preferredPaymentDay, nextPaymentDate: mutation.nextPaymentDate ?? item.nextPaymentDate, billingVersion: item.billingVersion + 1 };
        });
        const actionMap = { amount: "amount_changed", schedule: "schedule_changed", cancel: "subscription_cancelled", reactivate: "subscription_reactivated" } as const;
        return addAudit({ ...current, subscriptions: updated }, { id: `event-local-${Date.now()}`, subscriptionId, action: actionMap[mutation.action], detail: `${mutation.action} aplicado en vista local. Motivo: ${mutation.reason}`, createdAt: new Date().toISOString(), actorLabel: "Administrador local", requestLabel: "demo" });
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
        preferredPaymentDay: row.preferred_payment_day ?? item.preferredPaymentDay, nextPaymentDate: row.next_payment_date } : item) }));
    setNotice({ type: "success", message: "Cambio aplicado y registrado en auditoría." });
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
