export type DemoSubscriptionStatus = "active" | "cancelled" | "past_due" | "pending";
export type DemoPaymentStatus = "approved" | "pending" | "declined";
export type DemoAttemptState = "prepared" | "dispatching" | "pending" | "approved" | "declined" | "unknown" | "cancelled" | "failed";

// Administrative projections deliberately exclude payment sources and raw provider payloads.
export type DemoBillingAttempt = {
  id: string;
  subscriptionId: string;
  cycleId: string;
  attemptNumber: 1 | 2;
  state: DemoAttemptState;
  amount: number;
  createdAt: string;
  finalizedAt?: string | null;
  reasonLabel?: string | null;
};

export type DemoBillingCycle = {
  id: string;
  subscriptionId: string;
  billingPeriod: string;
  state: "open" | "retry_wait" | "approved" | "manual_review" | "cancelled";
  retryAt?: string | null;
  holdReason?: string | null;
};

export type DemoDonor = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  city: string;
  joinedAt: string;
  contactMasked?: boolean;
};

export type DemoSubscription = {
  id: string;
  donorId: string;
  amount: number;
  frequency: "monthly" | "one_time";
  status: DemoSubscriptionStatus;
  paymentMethod: "Tarjeta tokenizada" | "Tarjeta" | "Nequi";
  preferredPaymentDay: 1 | 6 | 16 | 28 | null;
  nextPaymentDate: string | null;
  reference: string;
  createdAt: string;
  billingVersion: number;
  billingHoldReason?: string | null;
  retryAt?: string | null;
  attemptNumber?: 1 | 2 | null;
  attemptState?: DemoAttemptState | null;
};

export type DemoPayment = {
  id: string;
  subscriptionId: string;
  amount: number;
  status: DemoPaymentStatus;
  createdAt: string;
  wompiTransactionId: string;
};

export type DemoRecoveryAttempt = {
  id: string;
  donorId: string;
  subscriptionId: string;
  reference: string;
  amount: number;
  state: "unknown" | "dispatching";
  createdAt: string;
  errorCode: string;
};

export type DemoAuditEvent = {
  id: string;
  subscriptionId: string;
  action:
    | "subscription_created"
    | "payment_approved"
    | "schedule_changed"
    | "amount_changed"
    | "subscription_cancelled"
    | "subscription_reactivated"
    | "payment_recovered"
    | "payment_recovery_closed"
    | "retry_cancelled";
  detail: string;
  createdAt: string;
  actorLabel?: string;
  requestLabel?: string;
};

export type AdminDemoState = {
  donors: DemoDonor[];
  subscriptions: DemoSubscription[];
  payments: DemoPayment[];
  recoveryAttempts: DemoRecoveryAttempt[];
  auditEvents: DemoAuditEvent[];
  billingCycles?: DemoBillingCycle[];
  billingAttempts?: DemoBillingAttempt[];
};

const DEMO_NOW = new Date("2026-08-31T12:00:00.000Z");

const DEMO_STATE: AdminDemoState = {
  donors: [
    {
      id: "donor-pending",
      fullName: "Tomas Vega Demo",
      email: "tomas.vega@example.test",
      phone: "+57 300 000 0082",
      city: "Cali",
      joinedAt: "2026-08-31T12:00:00.000Z",
    },
    {
      id: "donor-retry",
      fullName: "Lucia Rivas Demo",
      email: "lucia.rivas@example.test",
      phone: "+57 300 000 0042",
      city: "Bogota",
      joinedAt: "2026-07-06T12:00:00.000Z",
    },
    {
      id: "donor-security",
      fullName: "Camilo Luna Demo",
      email: "camilo.luna@example.test",
      phone: "+57 300 000 0071",
      city: "Medellin",
      joinedAt: "2026-07-06T12:00:00.000Z",
    },
    {
      id: "donor-unico",
      fullName: "Sofia Demo",
      email: "sofia.demo@example.test",
      phone: "+57 300 000 0000",
      city: "Bogota",
      joinedAt: "2026-08-20T15:00:00.000Z",
    },
    {
      id: "donor-alba",
      fullName: "Alba Restrepo",
      email: "alba.restrepo@example.test",
      phone: "+57 300 410 2881",
      city: "Medellin",
      joinedAt: "2026-04-16T15:10:00.000Z",
    },
    {
      id: "donor-diego",
      fullName: "Diego Benitez",
      email: "diego.benitez@example.test",
      phone: "+57 315 881 4290",
      city: "Bogota",
      joinedAt: "2026-05-09T18:30:00.000Z",
    },
    {
      id: "donor-elena",
      fullName: "Elena Marquez",
      email: "elena.marquez@example.test",
      phone: "+57 311 467 2330",
      city: "Cali",
      joinedAt: "2026-03-22T16:20:00.000Z",
    },
    {
      id: "donor-julian",
      fullName: "Julian Gomez",
      email: "julian.gomez@example.test",
      phone: "+57 302 900 6174",
      city: "Barranquilla",
      joinedAt: "2026-06-12T20:45:00.000Z",
    },
    {
      id: "donor-lucia",
      fullName: "Lucia Pardo",
      email: "lucia.pardo@example.test",
      phone: "+57 320 551 0847",
      city: "Pereira",
      joinedAt: "2026-02-07T14:15:00.000Z",
    },
    {
      id: "donor-mateo",
      fullName: "Mateo Arias",
      email: "mateo.arias@example.test",
      phone: "+57 300 777 9102",
      city: "Manizales",
      joinedAt: "2026-07-03T19:00:00.000Z",
    },
  ],
  subscriptions: [
    {
      id: "sub-alba",
      donorId: "donor-alba",
      amount: 50000,
      frequency: "monthly",
      status: "active",
      paymentMethod: "Tarjeta tokenizada",
      preferredPaymentDay: 16,
      nextPaymentDate: "2026-09-16T12:00:00.000Z",
      reference: "HPE-DEMO-ALBA-8162",
      createdAt: "2026-04-16T15:10:00.000Z",
      billingVersion: 0,
    },
    {
      id: "sub-diego",
      donorId: "donor-diego",
      amount: 100000,
      frequency: "monthly",
      status: "active",
      paymentMethod: "Tarjeta tokenizada",
      preferredPaymentDay: 1,
      nextPaymentDate: "2026-09-01T12:00:00.000Z",
      reference: "HPE-DEMO-DIEGO-4190",
      createdAt: "2026-05-09T18:30:00.000Z",
      billingVersion: 0,
    },
    {
      id: "sub-elena",
      donorId: "donor-elena",
      amount: 30000,
      frequency: "monthly",
      status: "past_due",
      paymentMethod: "Tarjeta tokenizada",
      preferredPaymentDay: 6,
      nextPaymentDate: null,
      reference: "HPE-DEMO-ELENA-2330",
      createdAt: "2026-03-22T16:20:00.000Z",
      billingVersion: 0,
      billingHoldReason: "retry_exhausted",
      attemptNumber: 2,
      attemptState: "declined",
    },
    {
      id: "sub-julian",
      donorId: "donor-julian",
      amount: 20000,
      frequency: "monthly",
      status: "pending",
      paymentMethod: "Tarjeta tokenizada",
      preferredPaymentDay: 28,
      nextPaymentDate: null,
      reference: "HPE-DEMO-JULIAN-6174",
      createdAt: "2026-06-12T20:45:00.000Z",
      billingVersion: 0,
      billingHoldReason: "result_unknown",
      attemptNumber: 1,
      attemptState: "unknown",
    },
    {
      id: "sub-lucia",
      donorId: "donor-lucia",
      amount: 75000,
      frequency: "monthly",
      status: "cancelled",
      paymentMethod: "Tarjeta tokenizada",
      preferredPaymentDay: 16,
      nextPaymentDate: null,
      reference: "HPE-DEMO-LUCIA-0847",
      createdAt: "2026-02-07T14:15:00.000Z",
      billingVersion: 0,
    },
    {
      id: "sub-mateo",
      donorId: "donor-mateo",
      amount: 10000,
      frequency: "monthly",
      status: "active",
      paymentMethod: "Tarjeta tokenizada",
      preferredPaymentDay: 28,
      nextPaymentDate: "2026-09-28T12:00:00.000Z",
      reference: "HPE-DEMO-MATEO-9102",
      createdAt: "2026-07-03T19:00:00.000Z",
      billingVersion: 0,
    },
    {
      id: "sub-unico",
      donorId: "donor-unico",
      amount: 25000,
      frequency: "one_time",
      status: "active",
      paymentMethod: "Tarjeta",
      preferredPaymentDay: null,
      nextPaymentDate: null,
      reference: "HPE-DEMO-UNICO",
      createdAt: "2026-08-20T15:00:00.000Z",
      billingVersion: 0,
    },
    {
      id: "sub-retry",
      donorId: "donor-retry",
      amount: 30000,
      frequency: "monthly",
      status: "past_due",
      paymentMethod: "Tarjeta tokenizada",
      preferredPaymentDay: 6,
      nextPaymentDate: null,
      reference: "HPE-DEMO-RETRY",
      createdAt: "2026-07-06T12:00:00.000Z",
      billingVersion: 0,
      billingHoldReason: "retry_scheduled",
      retryAt: "2026-09-01T12:00:00.000Z",
      attemptNumber: 1,
      attemptState: "declined",
    },
    {
      id: "sub-security",
      donorId: "donor-security",
      amount: 40000,
      frequency: "monthly",
      status: "past_due",
      paymentMethod: "Tarjeta tokenizada",
      preferredPaymentDay: 6,
      nextPaymentDate: null,
      reference: "HPE-DEMO-SECURITY",
      createdAt: "2026-07-06T12:00:00.000Z",
      billingVersion: 0,
      billingHoldReason: "security_decline",
      attemptNumber: 1,
      attemptState: "declined",
    },
    {
      id: "sub-pending",
      donorId: "donor-pending",
      amount: 25000,
      frequency: "monthly",
      status: "pending",
      paymentMethod: "Tarjeta tokenizada",
      preferredPaymentDay: 16,
      nextPaymentDate: null,
      reference: "HPE-DEMO-PENDING",
      createdAt: "2026-08-31T12:00:00.000Z",
      billingVersion: 0,
      attemptNumber: 1,
      attemptState: "pending",
    },
  ],
  payments: [
    {
      id: "pay-pending-initial",
      subscriptionId: "sub-pending",
      amount: 25000,
      status: "pending",
      createdAt: "2026-08-31T12:01:00.000Z",
      wompiTransactionId: "demo-pending-initial",
    },
    {
      id: "pay-retry-original",
      subscriptionId: "sub-retry",
      amount: 30000,
      status: "declined",
      createdAt: "2026-08-31T12:04:00.000Z",
      wompiTransactionId: "demo-retry-original",
    },
    {
      id: "pay-elena-additional",
      subscriptionId: "sub-elena",
      amount: 30000,
      status: "declined",
      createdAt: "2026-08-07T12:04:00.000Z",
      wompiTransactionId: "demo-exhausted-additional",
    },
    {
      id: "pay-security",
      subscriptionId: "sub-security",
      amount: 40000,
      status: "declined",
      createdAt: "2026-08-31T12:05:00.000Z",
      wompiTransactionId: "demo-security-original",
    },
    {
      id: "pay-unico",
      subscriptionId: "sub-unico",
      amount: 25000,
      status: "approved",
      createdAt: "2026-08-20T15:01:00.000Z",
      wompiTransactionId: "demo-unique-payment",
    },
    {
      id: "pay-001",
      subscriptionId: "sub-alba",
      amount: 50000,
      status: "approved",
      createdAt: "2026-08-16T12:06:00.000Z",
      wompiTransactionId: "1434410-demo-8162",
    },
    {
      id: "pay-002",
      subscriptionId: "sub-diego",
      amount: 100000,
      status: "approved",
      createdAt: "2026-08-01T12:04:00.000Z",
      wompiTransactionId: "1434410-demo-4190",
    },
    {
      id: "pay-003",
      subscriptionId: "sub-elena",
      amount: 30000,
      status: "declined",
      createdAt: "2026-08-06T12:08:00.000Z",
      wompiTransactionId: "1434410-demo-2330",
    },
    {
      id: "pay-005",
      subscriptionId: "sub-lucia",
      amount: 75000,
      status: "approved",
      createdAt: "2026-07-16T12:05:00.000Z",
      wompiTransactionId: "1434410-demo-0847",
    },
    {
      id: "pay-006",
      subscriptionId: "sub-mateo",
      amount: 10000,
      status: "approved",
      createdAt: "2026-08-28T12:06:00.000Z",
      wompiTransactionId: "1434410-demo-9102",
    },
  ],
  recoveryAttempts: [
    {
      id: "attempt-review-julian",
      donorId: "donor-julian",
      subscriptionId: "sub-julian",
      reference: "HPE-DEMO-JULIAN-202608",
      amount: 20000,
      state: "dispatching",
      createdAt: "2026-08-28T12:02:00.000Z",
      errorCode: "WOMPI_TIMEOUT",
    },
  ],
  auditEvents: [
    {
      id: "event-001",
      subscriptionId: "sub-julian",
      action: "subscription_created",
      detail: "Suscripcion pendiente de confirmacion del pago inicial.",
      createdAt: "2026-08-28T12:02:00.000Z",
    },
    {
      id: "event-002",
      subscriptionId: "sub-elena",
      action: "payment_recovery_closed",
      detail: "Original y adicional rechazados. Sin futuros cobros automaticos.",
      createdAt: "2026-08-07T12:04:00.000Z",
    },
    {
      id: "event-003",
      subscriptionId: "sub-lucia",
      action: "subscription_cancelled",
      detail: "Suscripcion cancelada. No hay proximo cobro programado.",
      createdAt: "2026-07-20T16:20:00.000Z",
    },
    {
      id: "event-004",
      subscriptionId: "sub-alba",
      action: "payment_approved",
      detail: "Cobro mensual aprobado y proxima fecha actualizada.",
      createdAt: "2026-08-16T12:06:00.000Z",
    },
  ],
  billingCycles: [
    { id: "cycle-pending", subscriptionId: "sub-pending", billingPeriod: "202608", state: "open" },
    { id: "cycle-retry", subscriptionId: "sub-retry", billingPeriod: "202608", state: "retry_wait", retryAt: "2026-09-01T12:00:00.000Z", holdReason: "retry_scheduled" },
    { id: "cycle-elena", subscriptionId: "sub-elena", billingPeriod: "202608", state: "manual_review", holdReason: "retry_exhausted" },
    { id: "cycle-julian", subscriptionId: "sub-julian", billingPeriod: "202608", state: "open", holdReason: "result_unknown" },
    { id: "cycle-security", subscriptionId: "sub-security", billingPeriod: "202608", state: "manual_review", holdReason: "security_decline" },
  ],
  billingAttempts: [
    { id: "attempt-pending-1", subscriptionId: "sub-pending", cycleId: "cycle-pending", attemptNumber: 1, state: "pending", amount: 25000, createdAt: "2026-08-31T12:00:00.000Z", reasonLabel: "Esperando estado final; sin repetir el envío" },
    { id: "attempt-retry-1", subscriptionId: "sub-retry", cycleId: "cycle-retry", attemptNumber: 1, state: "declined", amount: 30000, createdAt: "2026-08-31T12:00:00.000Z", finalizedAt: "2026-08-31T12:04:00.000Z", reasonLabel: "Fondos insuficientes verificados" },
    { id: "attempt-elena-1", subscriptionId: "sub-elena", cycleId: "cycle-elena", attemptNumber: 1, state: "declined", amount: 30000, createdAt: "2026-08-06T12:00:00.000Z", finalizedAt: "2026-08-06T12:08:00.000Z", reasonLabel: "Fondos insuficientes verificados" },
    { id: "attempt-elena-2", subscriptionId: "sub-elena", cycleId: "cycle-elena", attemptNumber: 2, state: "declined", amount: 30000, createdAt: "2026-08-07T12:00:00.000Z", finalizedAt: "2026-08-07T12:04:00.000Z", reasonLabel: "Adicional rechazado" },
    { id: "attempt-review-julian", subscriptionId: "sub-julian", cycleId: "cycle-julian", attemptNumber: 1, state: "unknown", amount: 20000, createdAt: "2026-08-28T12:02:00.000Z", reasonLabel: "Resultado incierto; conciliar el mismo intento" },
    { id: "attempt-security-1", subscriptionId: "sub-security", cycleId: "cycle-security", attemptNumber: 1, state: "declined", amount: 40000, createdAt: "2026-08-31T12:00:00.000Z", finalizedAt: "2026-08-31T12:05:00.000Z", reasonLabel: "Rechazo de seguridad; sin adicional automatico" },
  ],
};

export const DEMO_STORAGE_KEY = "hpe-admin-local-demo-v4";

export function createAdminDemoState(): AdminDemoState {
  return JSON.parse(JSON.stringify(DEMO_STATE)) as AdminDemoState;
}

export function getDemoNextPaymentDate(day: 1 | 6 | 16 | 28, month?: string) {
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [year, monthNumber] = month.split("-").map(Number);
    return new Date(Date.UTC(year, monthNumber - 1, day, 12, 0, 0, 0)).toISOString();
  }

  const colombiaNow = new Date(DEMO_NOW.getTime() - 5 * 60 * 60 * 1000);
  const year = colombiaNow.getUTCFullYear();
  const currentMonth = colombiaNow.getUTCMonth();
  const colombiaDay = colombiaNow.getUTCDate();
  const targetMonth = day > colombiaDay ? currentMonth : currentMonth + 1;

  return new Date(Date.UTC(year, targetMonth, day, 12, 0, 0, 0)).toISOString();
}

export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return email;

  const safeLocal = local.length <= 2 ? `${local[0] ?? ""}*` : `${local.slice(0, 2)}***`;
  return `${safeLocal}@${domain}`;
}

export function maskPhone(phone: string) {
  const visible = phone.slice(-4);
  return `+57 *** *** ${visible}`;
}
