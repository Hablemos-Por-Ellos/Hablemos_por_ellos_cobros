"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DonorFormValues } from "@/lib/schemas";
import { formatCurrencyCOP } from "@/lib/utils";
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
  paymentMethod: "card" | "nequi";
  onMethodChange: (method: "card" | "nequi") => void;
  onBack: () => void;
  onAuthorized: (wompiData?: { token: string; maskedDetails: string }) => Promise<void> | void;
  loading?: boolean;
}

// Declare Wompi global type
declare global {
  interface Window {
    Wompi?: {
      init: (config: WompiConfig) => void;
      render: (containerId: string) => void;
    };
  }
}

interface WompiConfig {
  publicKey: string;
  amountInCents: number;
  currency: string;
  customerData: {
    email: string;
    fullName: string;
    phoneNumber: string;
    documentType: string;
    documentNumber: string;
  };
  paymentMethods: string[];
  redirectUrl: string;
  onPaymentSuccess: (response: WompiResponse) => void;
  onPaymentError: (error: WompiError) => void;
}

interface WompiResponse {
  token: string;
  paymentSourceId: string;
  maskedDetails: string;
  transactionId?: string;
}

interface WompiError {
  message: string;
  code?: string;
}

export function PaymentStep({
  donor,
  amount,
  paymentMethod,
  onMethodChange,
  onBack,
  onAuthorized,
  loading,
}: PaymentStepProps) {
  const [isWidgetLoaded, setIsWidgetLoaded] = useState(false);
  const [wompiError, setWompiError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Load Wompi script
  useEffect(() => {
    if (typeof window === "undefined") return;
    
    // Check if already loaded
    if (window.Wompi) {
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

    return () => {
      if (document.head.contains(script)) {
        document.head.removeChild(script);
      }
    };
  }, []);

  // Initialize Wompi widget when ready
  useEffect(() => {
    if (!isWidgetLoaded || !window.Wompi) return;

    try {
      window.Wompi.init({
        publicKey: process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY || "",
        amountInCents: amount * 100, // Convert to cents
        currency: "COP",
        customerData: {
          email: donor.email,
          fullName: `${donor.firstName} ${donor.lastName}`,
          phoneNumber: donor.phone,
          documentType: donor.documentType,
          documentNumber: donor.documentNumber,
        },
        paymentMethods: [paymentMethod.toUpperCase()],
        redirectUrl:
          typeof window !== "undefined"
            ? `${window.location.origin}/donar/confirmacion`
            : "https://hablemosporellos.org/donar/confirmacion",
        onPaymentSuccess: async (response: WompiResponse) => {
          setIsProcessing(true);
          try {
            await onAuthorized({
              token: response.token,
              maskedDetails: response.maskedDetails,
            });
          } catch (error) {
            setWompiError("Error al procesar el pago. Por favor, intenta de nuevo.");
            setIsProcessing(false);
          }
        },
        onPaymentError: (error: WompiError) => {
          setWompiError(`Error en el pago: ${error.message}`);
          setIsProcessing(false);
        },
      });

      // Render widget
      window.Wompi.render("wompi-widget-container");
    } catch (error) {
      setWompiError("Error al inicializar el widget de Wompi.");
      console.error("Wompi init error:", error);
    }
  }, [isWidgetLoaded, paymentMethod, amount, donor, onAuthorized]);

  return (
    <section className="grid gap-6">
      <div className="rounded-4xl bg-white/95 p-6 shadow-card">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <p className="text-sm font-semibold text-foundation-green">Revisa tus datos</p>
            <h2 className="text-xl font-semibold text-slate-900">{donor.firstName} {donor.lastName}</h2>
            <p className="text-sm text-slate-500">{donor.email} · {donor.phone}</p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-sm text-slate-500">Donación mensual</p>
            <p className="text-2xl font-semibold text-foundation-blue">{formatCurrencyCOP(amount)}</p>
          </div>
        </div>
        <button type="button" onClick={onBack} className="mt-3 text-sm font-semibold text-foundation-blue">
          Editar mis datos
        </button>
      </div>

      <div className="grid gap-4 rounded-4xl bg-white/95 p-6 shadow-card">
        <div>
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

        {/* Wompi Widget Container */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6">
          {wompiError ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl bg-red-50 p-6 text-center">
              <span className="text-4xl">⚠️</span>
              <p className="font-semibold text-red-900">{wompiError}</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="text-sm font-semibold text-red-700 underline hover:text-red-900"
              >
                Recargar página
              </button>
            </div>
          ) : isWidgetLoaded ? (
            <div className="space-y-4">
              <div id="wompi-widget-container" className="w-full">
                {/* Wompi widget renders here */}
              </div>
              <div className="inline-flex items-center gap-2 rounded-full bg-green-50 px-4 py-2 text-sm text-green-700">
                <span>🔐</span>
                Tu pago es seguro y encriptado con Wompi
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-foundation-blue"></div>
              <p className="text-sm text-slate-600">Cargando widget de pago...</p>
            </div>
          )}
        </div>

        <SecurityNote />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="ghost" onClick={onBack} disabled={isProcessing || !isWidgetLoaded}>
            Volver al paso anterior
          </Button>
          {!isWidgetLoaded && (
            <span className="text-sm text-slate-500">Cargando widget...</span>
          )}
          {isProcessing && (
            <span className="text-sm text-slate-500">Procesando pago...</span>
          )}
        </div>
      </div>
    </section>
  );
}
