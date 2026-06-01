"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import type { DonorFormValues } from "@/lib/schemas";
import { formatCurrencyCOP } from "@/lib/utils";
import { cleanupWompiOverlayDom, getWompiPublicKey, isProduction } from "@/lib/wompi";
import { SecurityNote } from "./security-note";

const methodOptions = [
  {
    id: "card" as const,
    title: "Tarjeta de crédito o débito",
    description: "Visa, MasterCard, American Express, Codensa",
    icon: "💳",
  },
  {
    id: "nequi" as const,
    title: "Cuenta Nequi",
    description: "Autoriza débitos mensuales desde tu celular",
    icon: "📱",
  },
];

interface PaymentStepProps {
  donor: DonorFormValues;
  amount: number;
  isRecurring: boolean;
  paymentMethod: "card" | "nequi";
  onMethodChange: (method: "card" | "nequi") => void;
  onBack: () => void;
  onCheckoutStarted: (data: { reference: string }) => Promise<void> | void;
  onAuthorized: (wompiData: {
    token: string;
    cardToken?: string;
    paymentSourceType?: string;
    paymentSourceId?: string;
    transactionId?: string;
    maskedDetails: string;
    reference: string;
    acceptanceToken?: string;
    acceptPersonalAuth?: string;
  }) => Promise<void> | void;
  loading?: boolean;
}

// Declare WidgetCheckout global type (from Wompi)
declare global {
  interface Window {
    WidgetCheckout?: new (config: WidgetCheckoutConfig) => WidgetCheckoutInstance;
  }
}

interface WidgetCheckoutConfig {
  widgetOperation?: "purchase" | "tokenize";
  currency: string;
  amountInCents?: number;
  reference?: string;
  publicKey: string;
  redirectUrl?: string;
  customerData?: {
    email: string;
    fullName: string;
    phoneNumber: string;
    phoneNumberPrefix?: string;
    legalId: string;
    legalIdType: string;
  };
  // Optional server-generated signature for integrity (Wompi)
  signature?: {
    integrity: string;
  };
}

interface WidgetCheckoutInstance {
  open: (callback: (result: WidgetCheckoutResult) => void) => void;
}

interface WidgetCheckoutResult {
  payment_source?: {
    token?: string;
    type?: string;
  };
  transaction?: {
    id: string;
    status: string;
    paymentMethodType: string;
    paymentMethod?: {
      type: string;
      extra?: {
        lastFour?: string;
        brand?: string;
      };
    };
  };
}

type AcceptanceData = {
  acceptanceToken: string;
  acceptPersonalAuth: string;
  acceptancePermalink: string | null;
  personalDataAuthPermalink: string | null;
};

export function recurringMissingPaymentSourceMessage(paymentMethodType: unknown) {
  return String(paymentMethodType).toUpperCase() === "NEQUI"
    ? "Nequi no permite cobro mensual automatico. Cambia a tarjeta o desactiva el cobro mensual."
    : "Wompi aprobo el pago, pero no devolvio una fuente tokenizada para cobro mensual.";
}

// Generate unique reference for each transaction
function generateReference(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `HPE-${timestamp}-${random}`.toUpperCase();
}

export function PaymentStep({
  donor,
  amount,
  isRecurring,
  paymentMethod,
  onMethodChange,
  onBack,
  onCheckoutStarted,
  onAuthorized,
  loading,
}: PaymentStepProps) {
  const [isWidgetLoaded, setIsWidgetLoaded] = useState(false);
  const [wompiError, setWompiError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTakingLong, setIsTakingLong] = useState(false);
  
  // New state for pre-fetching signature
  const [integritySignature, setIntegritySignature] = useState<string | null>(null);
  const [currentReference, setCurrentReference] = useState<string | null>(null);
  const [isSignatureLoading, setIsSignatureLoading] = useState(false);
  const [acceptance, setAcceptance] = useState<AcceptanceData | null>(null);
  const [isAcceptanceLoading, setIsAcceptanceLoading] = useState(false);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(false);

  useEffect(() => {
    if (isRecurring && paymentMethod === "nequi") {
      onMethodChange("card");
    }
  }, [isRecurring, paymentMethod, onMethodChange]);

  const canOpenCheckout =
    isWidgetLoaded &&
    !!integritySignature &&
    !!currentReference &&
    !isProcessing &&
    !isSignatureLoading &&
    (!isRecurring || (!!acceptance && hasAcceptedTerms && !isAcceptanceLoading));

  // Load Wompi script
  useEffect(() => {
    if (typeof window === "undefined") return;
    
    // Check if already loaded
    if (window.WidgetCheckout) {
      setIsWidgetLoaded(true);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://checkout.wompi.co/widget.js";
    script.async = true;

    script.onload = () => {
      setIsWidgetLoaded(true);
      setWompiError(null);
    };

    script.onerror = () => {
      setWompiError("No se pudo cargar el widget de Wompi. Por favor, recarga la página.");
      setIsWidgetLoaded(false);
    };

    document.head.appendChild(script);
  }, []);

  // Ensure any leftover overlay is removed when mounting/unmounting this step
  useEffect(() => {
    cleanupWompiOverlayDom();
    return () => cleanupWompiOverlayDom();
  }, []);

  // Fetch signature on mount/amount change with AbortController timeout
  const fetchSignature = useCallback(async () => {
    setIsSignatureLoading(true);
    setWompiError(null);
    
    // AbortController with 10s timeout to prevent hanging requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    try {
      const reference = generateReference();
      const amountInCents = Math.max(150000, Math.round(amount * 100));
      
      const response = await fetch("/api/wompi/signature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountInCents, currency: "COP", reference }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error("Signature error:", error);
        if (response.status === 500) {
             setWompiError("Error de configuración del servidor (Firma).");
        }
        return;
      }

      const { signature } = await response.json();
      setIntegritySignature(signature);
      setCurrentReference(reference);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        setWompiError("La conexión tardó demasiado. Por favor, intenta de nuevo.");
      } else {
        console.error("Signature fetch error:", error);
      }
    } finally {
      setIsSignatureLoading(false);
    }
  }, [amount]);

  // Prefetch signature/reference so the user doesn't need to click twice.
  useEffect(() => {
    fetchSignature();
  }, [fetchSignature]);

  const fetchAcceptance = useCallback(async () => {
    if (!isRecurring) return;

    setIsAcceptanceLoading(true);
    try {
      const response = await fetch("/api/wompi/acceptance");
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error?.message ?? "No pudimos cargar los terminos de Wompi.");
      }
      setAcceptance(await response.json());
    } catch (error) {
      setWompiError(error instanceof Error ? error.message : "No pudimos cargar los terminos de Wompi.");
    } finally {
      setIsAcceptanceLoading(false);
    }
  }, [isRecurring]);

  useEffect(() => {
    setHasAcceptedTerms(false);
    if (isRecurring) {
      fetchAcceptance();
    } else {
      setAcceptance(null);
    }
  }, [fetchAcceptance, isRecurring]);

  // Open Wompi checkout widget
  const openWompiCheckout = useCallback(async () => {
    if (!isWidgetLoaded || !window.WidgetCheckout) {
      setWompiError("El widget de Wompi aún no está listo.");
      return;
    }

    if (!integritySignature || !currentReference) {
      // Evita el doble click: si aún no está lista la firma/referencia, no intentes abrir.
      setWompiError("Preparando transacción, por favor espera un momento.");
      return;
    }

    if (isRecurring && paymentMethod !== "card") {
      setWompiError("El cobro mensual solo esta disponible con tarjeta por ahora.");
      return;
    }

    if (isRecurring && (!acceptance || !hasAcceptedTerms)) {
      setWompiError("Debes aceptar los terminos de Wompi para guardar la tarjeta.");
      return;
    }

    const publicKey = getWompiPublicKey();
    const expectedPrefix = isProduction ? "pub_prod_" : "pub_test_";
    if (!publicKey || !publicKey.startsWith(expectedPrefix)) {
      setWompiError(`Configura la llave pública de ${isProduction ? "producción" : "sandbox"} (debe iniciar con ${expectedPrefix}).`);
      return;
    }

    const redirectUrl =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? `${window.location.origin}/donar`
        : undefined;

    setIsProcessing(true);
    setIsTakingLong(false);
    setWompiError(null);

    // Show "taking long" message after 15s
    const longTimeoutId = window.setTimeout(() => {
      setIsTakingLong(true);
    }, 15000);

    // Full timeout at 30s
    const timeoutId = window.setTimeout(() => {
      setIsProcessing(false);
      setIsTakingLong(false);
      cleanupWompiOverlayDom();
      setWompiError("El proceso tardó demasiado. Por favor, intenta de nuevo.");
    }, 30000);

    const finishProcessing = () => {
      window.clearTimeout(timeoutId);
      window.clearTimeout(longTimeoutId);
      cleanupWompiOverlayDom();
      setIsProcessing(false);
      setIsTakingLong(false);
    };

    try {
      if (isRecurring) {
        await onCheckoutStarted({ reference: currentReference });

        cleanupWompiOverlayDom();
        const checkout = new window.WidgetCheckout({
          widgetOperation: "tokenize",
          currency: "COP",
          publicKey,
        });

        checkout.open((result: WidgetCheckoutResult) => {
          finishProcessing();
          fetchSignature();

          const paymentSource = result.payment_source;
          const cardToken = paymentSource?.token ?? null;
          const paymentSourceType = paymentSource?.type ?? "CARD";

          if (!cardToken) {
            setWompiError("Wompi no devolvio el token de la tarjeta. Intenta de nuevo.");
            console.warn("Wompi tokenizacion sin token", { paymentSource });
            return;
          }

          void onAuthorized({
            token: cardToken,
            cardToken,
            paymentSourceType,
            reference: currentReference,
            maskedDetails: "Tarjeta tokenizada",
            acceptanceToken: acceptance?.acceptanceToken,
            acceptPersonalAuth: acceptance?.acceptPersonalAuth,
          });
        });
        return;
      }

      cleanupWompiOverlayDom();
      const checkout = new window.WidgetCheckout({
        currency: "COP",
        amountInCents: Math.max(150000, Math.round(amount * 100)),
        reference: currentReference,
        publicKey,
        redirectUrl,
        customerData: {
          email: donor.email,
          fullName: `${donor.firstName} ${donor.lastName}`,
          phoneNumber: donor.phone.replace(/\D/g, ""),
          phoneNumberPrefix: "+57",
          legalId: donor.documentNumber,
          legalIdType: donor.documentType,
        },
        signature: {
          integrity: integritySignature,
        },
      });

      checkout.open((result: WidgetCheckoutResult) => {
        // console.log("Wompi widget result:", result);
        finishProcessing();
        
        // Regenerate signature for next attempt
        fetchSignature();

        if (!result.transaction) {
          setWompiError("No recibimos confirmación de Wompi. Intenta de nuevo.");
          return;
        }

        const tx = result.transaction;
        const paymentInfo = (tx as any).payment_method ?? tx.paymentMethod;
        const actualPaymentMethod =
          (tx as any)?.payment_method_type ??
          (tx as any)?.paymentMethodType ??
          paymentInfo?.type ??
          paymentMethod;
        const paymentSourceId =
          (paymentInfo as any)?.extra?.payment_source_id ??
          (paymentInfo as any)?.extra?.token ??
          (tx as any)?.payment_source_id ??
          (tx as any)?.paymentSourceId ??
          null;

        const transactionId = (tx as any)?.id ?? null;

        if (!paymentSourceId && isRecurring) {
          setWompiError(recurringMissingPaymentSourceMessage(actualPaymentMethod));
          console.warn("Wompi sin payment_source_id", { transaction: tx, paymentInfo, actualPaymentMethod });
          return;
        }

        const wompiToken = transactionId ?? paymentSourceId;
        if (!wompiToken) {
          setWompiError("No recibimos confirmación de Wompi. Intenta de nuevo.");
          console.warn("Wompi sin transaction id", { transaction: tx, paymentInfo });
          return;
        }
        
        if (tx.status === "APPROVED") {
          let maskedDetails = "Pago aprobado";
          
          if (paymentInfo?.type === "CARD" && (paymentInfo as any)?.extra) {
            const extra = (paymentInfo as any).extra;
            maskedDetails = `${extra.brand || "Tarjeta"} **** ${extra.lastFour || "****"}`;
          } else if (paymentInfo?.type === "NEQUI") {
            maskedDetails = "Nequi autorizado";
          }

          onAuthorized({
            token: wompiToken,
            paymentSourceId: paymentSourceId ?? undefined,
            transactionId,
            reference: currentReference ?? "",
            maskedDetails,
          });
        } else if (tx.status === "PENDING") {
          onAuthorized({
            token: wompiToken,
            paymentSourceId: paymentSourceId ?? undefined,
            transactionId,
            reference: currentReference ?? "",
            maskedDetails: "Pago pendiente de confirmación",
          });
        } else {
          setWompiError(`El pago fue ${tx.status === "DECLINED" ? "rechazado" : "cancelado"}. Por favor, intenta de nuevo.`);
        }
      });
    } catch (error) {
      finishProcessing();
      setWompiError(error instanceof Error ? error.message : "Error al abrir el checkout de Wompi.");
      console.error("Wompi checkout error:", error);
    }
  }, [
    isWidgetLoaded,
    amount,
    donor,
    isRecurring,
    paymentMethod,
    onCheckoutStarted,
    onAuthorized,
    integritySignature,
    currentReference,
    acceptance,
    hasAcceptedTerms,
    fetchSignature,
  ]);

  return (
    <section className="grid gap-6">
      <div className="rounded-4xl bg-white/95 p-6 shadow-card">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-foundation-green">Revisa tus datos</p>
            <h2 className="text-xl font-semibold text-slate-900">{donor.firstName} {donor.lastName}</h2>
            <p className="text-sm text-slate-500">{donor.email} · {donor.phone}</p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-sm text-slate-500">{isRecurring ? "Donación mensual" : "Donación única"}</p>
            <p className="text-2xl font-semibold text-foundation-blue">{formatCurrencyCOP(amount)}</p>
          </div>
        </div>
        <button type="button" onClick={onBack} className="mt-3 text-sm font-semibold text-foundation-blue">
          Editar mis datos
        </button>
      </div>

      <div className="grid gap-4 rounded-4xl bg-white/95 p-6 shadow-card">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foundation-green">Paso 2</p>
          <h2 className="text-2xl font-semibold text-slate-900">Configura tu pago seguro</h2>
          <p className="text-sm text-slate-500">Solo lo harás una vez. Wompi guardará tu medio de pago con total seguridad.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {methodOptions.map((option) => {
            const isDisabled = isRecurring && option.id === "nequi";
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onMethodChange(option.id)}
                disabled={isDisabled}
                title={isDisabled ? "Nequi no está disponible para cobro mensual automático." : undefined}
                className={`flex flex-col gap-2 rounded-3xl border p-4 text-left transition ${
                  paymentMethod === option.id
                    ? "border-foundation-blue bg-foundation-blue/10"
                    : "border-slate-200 bg-white hover:border-foundation-blue/50"
                } ${isDisabled ? "cursor-not-allowed opacity-50 hover:border-slate-200" : ""}`}
              >
                <span className="text-3xl">{option.icon}</span>
                <p className="text-lg font-semibold text-slate-900">{option.title}</p>
                <p className="text-sm text-slate-500">{option.description}</p>
              </button>
            );
          })}
        </div>

        {isRecurring && (
          <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={hasAcceptedTerms}
              disabled={isAcceptanceLoading || !acceptance}
              onChange={(event) => setHasAcceptedTerms(event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-foundation-blue"
            />
            <span>
              Acepto los{" "}
              {acceptance?.acceptancePermalink ? (
                <a
                  href={acceptance.acceptancePermalink}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-foundation-blue underline"
                >
                  terminos de Wompi
                </a>
              ) : (
                "terminos de Wompi"
              )}{" "}
              y la{" "}
              {acceptance?.personalDataAuthPermalink ? (
                <a
                  href={acceptance.personalDataAuthPermalink}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-foundation-blue underline"
                >
                  autorizacion de datos personales
                </a>
              ) : (
                "autorizacion de datos personales"
              )}
              .
            </span>
          </label>
        )}

        {/* Wompi Payment Button */}
        <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6">
          <div className="flex flex-col items-center gap-4 text-center">
            {wompiError ? (
              <div className="flex flex-col items-center gap-3 rounded-2xl bg-red-50 p-4 w-full">
                <span className="text-3xl">⚠️</span>
                <p className="font-medium text-red-900">{wompiError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setWompiError(null);
                    fetchSignature();
                    if (isRecurring) {
                      fetchAcceptance();
                    }
                  }}
                  className="text-sm font-semibold text-red-700 underline hover:text-red-900"
                >
                  Intentar de nuevo
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-foundation-blue">
                  <span className="text-2xl">🔒</span>
                  <p className="font-semibold">Pago 100% seguro con Wompi</p>
                </div>
                <p className="text-sm text-slate-600 max-w-md">
                  Al hacer clic en el botón, se abrirá una ventana segura de Wompi donde podrás 
                  {paymentMethod === "card" 
                    ? " ingresar los datos de tu tarjeta" 
                    : " autorizar el pago desde tu cuenta Nequi"
                  }.
                </p>
                <Button
                  type="button"
                  onClick={openWompiCheckout}
                  loading={isProcessing || !isWidgetLoaded || isSignatureLoading || isAcceptanceLoading}
                  disabled={!canOpenCheckout}
                  className="w-full sm:max-w-xs text-lg py-6"
                >
                  {!isWidgetLoaded || isSignatureLoading || isAcceptanceLoading
                    ? "Preparando..."
                    : isProcessing
                      ? "Procesando..."
                      : isRecurring
                        ? `Guardar tarjeta y donar ${formatCurrencyCOP(amount)}`
                        : `Pagar ${formatCurrencyCOP(amount)}`}
                </Button>
                {isTakingLong && (
                  <div className="flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <span className="animate-pulse">⏳</span>
                    <p>Esto está tardando más de lo esperado. Por favor, espera un momento...</p>
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>🛡️</span>
                  <span>Protegido por Wompi · Grupo Bancolombia</span>
                </div>
              </>
            )}
          </div>
        </div>

        <SecurityNote />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="ghost" onClick={onBack} disabled={isProcessing} className="w-full sm:w-auto">
            Volver al paso anterior
          </Button>
        </div>
      </div>
    </section>
  );
}
