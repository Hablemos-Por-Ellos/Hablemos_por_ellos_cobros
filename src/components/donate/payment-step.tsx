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
  onAuthorized: (wompiData: { token: string; maskedDetails: string; reference: string }) => Promise<void> | void;
  loading?: boolean;
}

// Declare WidgetCheckout global type (from Wompi)
declare global {
  interface Window {
    WidgetCheckout?: new (config: WidgetCheckoutConfig) => WidgetCheckoutInstance;
  }
}

interface WidgetCheckoutConfig {
  currency: string;
  amountInCents: number;
  reference: string;
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

  const canOpenCheckout =
    isWidgetLoaded && !!integritySignature && !!currentReference && !isProcessing && !isSignatureLoading;

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

  // Open Wompi checkout widget
  const openWompiCheckout = useCallback(() => {
    if (!isWidgetLoaded || !window.WidgetCheckout) {
      setWompiError("El widget de Wompi aún no está listo.");
      return;
    }

    if (!integritySignature || !currentReference) {
      // Evita el doble click: si aún no está lista la firma/referencia, no intentes abrir.
      setWompiError("Preparando transacción, por favor espera un momento.");
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

    try {
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
        window.clearTimeout(timeoutId);
        window.clearTimeout(longTimeoutId);
        cleanupWompiOverlayDom();
        setIsProcessing(false);
        setIsTakingLong(false);
        
        // Regenerate signature for next attempt
        fetchSignature();

        if (!result.transaction) {
          setWompiError("No recibimos confirmación de Wompi. Intenta de nuevo.");
          return;
        }

        const tx = result.transaction;
        const paymentInfo = (tx as any).payment_method ?? tx.paymentMethod;
        const paymentSourceId =
          (paymentInfo as any)?.extra?.payment_source_id ??
          (paymentInfo as any)?.extra?.token ??
          (tx as any)?.payment_source_id ??
          tx.id ??
          null;

        if (!paymentSourceId) {
          setWompiError("No recibimos el payment_source_id de Wompi. No podemos guardar la suscripci?n.");
          console.warn("Wompi sin payment_source_id", { transaction: tx, paymentInfo });
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
            token: paymentSourceId,
            reference: currentReference ?? "",
            maskedDetails,
          });
        } else if (tx.status === "PENDING") {
          onAuthorized({
            token: paymentSourceId,
            reference: currentReference ?? "",
            maskedDetails: "Pago pendiente de confirmación",
          });
        } else {
          setWompiError(`El pago fue ${tx.status === "DECLINED" ? "rechazado" : "cancelado"}. Por favor, intenta de nuevo.`);
        }
      });
    } catch (error) {
      window.clearTimeout(timeoutId);
      window.clearTimeout(longTimeoutId);
      cleanupWompiOverlayDom();
      setIsProcessing(false);
      setIsTakingLong(false);
      setWompiError("Error al abrir el checkout de Wompi.");
      console.error("Wompi checkout error:", error);
    }
  }, [isWidgetLoaded, amount, donor, onAuthorized, integritySignature, currentReference, fetchSignature]);

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
          {methodOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onMethodChange(option.id)}
              className={`flex flex-col gap-2 rounded-3xl border p-4 text-left transition ${
                paymentMethod === option.id
                  ? "border-foundation-blue bg-foundation-blue/10"
                  : "border-slate-200 bg-white hover:border-foundation-blue/50"
              }`}
            >
              <span className="text-3xl">{option.icon}</span>
              <p className="text-lg font-semibold text-slate-900">{option.title}</p>
              <p className="text-sm text-slate-500">{option.description}</p>
            </button>
          ))}
        </div>

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
                  loading={isProcessing || !isWidgetLoaded || isSignatureLoading}
                  disabled={!canOpenCheckout}
                  className="w-full sm:max-w-xs text-lg py-6"
                >
                  {!isWidgetLoaded || isSignatureLoading
                    ? "Preparando..."
                    : isProcessing
                      ? "Procesando..."
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
