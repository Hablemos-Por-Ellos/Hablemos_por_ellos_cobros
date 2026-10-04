import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext, isAdminDemoMode, isAdminSchemaReady, isSameOriginRequest, verifyRecentTotp } from "@/lib/admin-auth";
import { getServiceSupabaseClient } from "@/lib/supabase-server";
import { isWompiPaymentSourceAvailable } from "@/lib/wompi-server";
import { assertFinancialOperationsEnabled } from "@/lib/operation-mode";
import { confirmedSubscriptionSchema } from "@/types/admin";

const mutationSchema = z.object({
  action: z.enum(["amount", "schedule", "cancel", "reactivate"]),
  reason: z.string().trim().min(5).max(500),
  totpCode: z.string().regex(/^\d{6}$/),
  expectedVersion: z.number().int().min(0),
  requestId: z.string().uuid(),
  amount: z.number().int().min(1500).max(21474836).optional(),
  preferredPaymentDay: z.union([z.literal(1), z.literal(6), z.literal(16), z.literal(28)]).optional(),
  nextPaymentDate: z.string().datetime({ offset: true }).optional(),
  donorAuthorizationConfirmed: z.boolean().optional(),
}).superRefine((input, context) => {
  if (input.action === "amount" && input.amount === undefined) {
    context.addIssue({ code: "custom", message: "AMOUNT_REQUIRED" });
  }
  if (input.action === "schedule" || input.action === "reactivate") {
    const date = new Date(input.nextPaymentDate ?? "");
    const colombia = new Date(date.getTime() - 5 * 60 * 60 * 1000);
    if (!input.preferredPaymentDay || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()
      || colombia.getUTCDate() !== input.preferredPaymentDay
      || date.getUTCHours() !== 12 || date.getUTCMinutes() !== 0
      || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
      context.addIssue({ code: "custom", message: "INVALID_FUTURE_SCHEDULE" });
    }
  }
});

const mutationResultSchema = confirmedSubscriptionSchema.shape.subscription;

function publicAdminError(message: string) {
  if (message.includes("VERSION_CONFLICT")) return { status: 409, message: "La suscripcion cambio mientras la estabas revisando. Recarga e intenta de nuevo." };
  if (message.includes("PAYMENT_IN_PROGRESS")) return { status: 409, message: "Hay un cobro pendiente o en proceso. No se puede aplicar este cambio todavia." };
  if (message.includes("BILLING_MONTH_ALREADY_PAID")) return { status: 409, message: "Esa suscripcion ya tiene un pago aprobado en el mes elegido." };
  if (message.includes("ADMIN_NOT_AUTHORIZED")) return { status: 403, message: "La sesion administrativa no esta autorizada." };
  if (message.includes("NEEDS_REVIEW")) return { status: 409, message: "Hay un resultado de pago por revisar antes de cambiar el calendario." };
  return { status: 400, message: "No se pudo aplicar el cambio solicitado." };
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ message: "Origen no permitido." }, { status: 403 });
  if (isAdminDemoMode()) return NextResponse.json({ message: "Demo desconectada." }, { status: 401 });
  try { assertFinancialOperationsEnabled(); } catch {
    return NextResponse.json({ message: "Operaciones financieras deshabilitadas." }, { status: 503 });
  }
  if (!(await isAdminSchemaReady())) return NextResponse.json({ message: "Esquema administrativo no disponible." }, { status: 503 });

  const { id: subscriptionId } = await params;
  if (!z.string().uuid().safeParse(subscriptionId).success) return NextResponse.json({ message: "Suscripcion invalida." }, { status: 400 });
  const admin = await getAdminContext();
  if (!admin || admin.demo || isAdminDemoMode()) {
    return NextResponse.json({ message: "Esta operacion requiere una sesion administrativa real." }, { status: 401 });
  }

  const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "Datos de cambio invalidos." }, { status: 400 });
  const input = parsed.data;

  if (input.action === "reactivate" && input.donorAuthorizationConfirmed !== true) {
    return NextResponse.json({ message: "Debes confirmar la autorizacion del donante para reactivar." }, { status: 400 });
  }

  const serviceClient = getServiceSupabaseClient();
  if (!serviceClient) return NextResponse.json({ message: "Servicio de datos no configurado." }, { status: 503 });

  const { data: rateAllowed, error: rateError } = await serviceClient.rpc("consume_api_rate_limit", {
    p_scope: "admin_subscription_mutation",
    p_key_hash: crypto.createHash("sha256").update(admin.userId).digest("hex"),
    p_limit: 10,
    p_window_seconds: 600,
  });
  if (rateError) return NextResponse.json({ message: "No fue posible validar el limite de seguridad." }, { status: 503 });
  if (rateAllowed !== true) return NextResponse.json({ message: "Demasiados intentos. Espera unos minutos." }, { status: 429 });

  if (!(await verifyRecentTotp(input.totpCode))) {
    return NextResponse.json({ message: "El codigo de Google Authenticator no es valido." }, { status: 403 });
  }
  const totpVerifiedAt = new Date().toISOString();

  const { data: subscription, error: subscriptionError } = await serviceClient
      .from("subscriptions")
      .select("status, frequency, wompi_payment_source_id")
      .eq("id", subscriptionId)
      .maybeSingle();
  if (subscriptionError) return NextResponse.json({ message: "No se pudo verificar la suscripcion." }, { status: 503 });
  if (!subscription) return NextResponse.json({ message: "Suscripcion no encontrada." }, { status: 404 });
  if (subscription.frequency !== "monthly" || subscription.status === "pending") {
    return NextResponse.json({ message: "Esta suscripcion no admite cambios administrativos." }, { status: 409 });
  }
  if (input.action === "reactivate") {
    if (!["cancelled", "past_due"].includes(subscription.status)) {
      return NextResponse.json({ message: "La suscripcion no admite reactivacion." }, { status: 409 });
    }
    if (!subscription.wompi_payment_source_id) {
      return NextResponse.json({ message: "La suscripcion no tiene una fuente de pago reutilizable." }, { status: 409 });
    }
    try {
      if (!(await isWompiPaymentSourceAvailable(subscription.wompi_payment_source_id))) {
        return NextResponse.json({ message: "Wompi indica que la fuente de pago ya no esta disponible." }, { status: 409 });
      }
    } catch {
      return NextResponse.json({ message: "No fue posible verificar la fuente de pago con Wompi." }, { status: 503 });
    }
  }

  if ((input.action === "amount" || input.action === "schedule") && subscription.status !== "active") {
    return NextResponse.json({ message: "Solo una suscripcion activa admite este cambio." }, { status: 409 });
  }
  const currentAdmin = await getAdminContext();
  if (!currentAdmin || currentAdmin.demo || currentAdmin.userId !== admin.userId) {
    return NextResponse.json({ message: "La sesion administrativa cambio o fue revocada." }, { status: 403 });
  }
  try { assertFinancialOperationsEnabled(); } catch {
    return NextResponse.json({ message: "Operaciones financieras deshabilitadas." }, { status: 503 });
  }

  const { data, error } = await serviceClient.rpc("admin_update_subscription", {
    p_subscription_id: subscriptionId,
    p_expected_version: input.expectedVersion,
    p_action: input.action,
    p_reason: input.reason,
    p_request_id: input.requestId,
    p_actor_user_id: admin.userId,
    p_actor_aal: currentAdmin.aal,
    p_actor_session_issued_at: currentAdmin.sessionIssuedAt,
    p_totp_verified_at: totpVerifiedAt,
    p_amount: input.action === "amount" ? input.amount ?? null : null,
    p_preferred_payment_day: input.action === "schedule" || input.action === "reactivate" ? input.preferredPaymentDay ?? null : null,
    p_next_payment_date: input.action === "schedule" || input.action === "reactivate" ? input.nextPaymentDate ?? null : null,
    p_donor_authorization_confirmed: input.action === "reactivate" && input.donorAuthorizationConfirmed === true,
  });

  if (error) {
    const safe = publicAdminError(error.message);
    return NextResponse.json({ message: safe.message }, { status: safe.status });
  }

  const result = mutationResultSchema.safeParse(data);
  if (!result.success || result.data.id !== subscriptionId || result.data.billing_version <= input.expectedVersion) {
    return NextResponse.json({ message: "La base de datos devolvio una respuesta administrativa invalida." }, { status: 500 });
  }

  return NextResponse.json({ subscription: result.data });
}
