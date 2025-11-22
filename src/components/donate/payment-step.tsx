"use client";

import { useState } from "react";
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
  onAuthorized: () => Promise<void> | void;
  loading?: boolean;
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
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const handleAuthorize = async () => {
    setInfoMessage("Estamos conectando con Wompi...");
    await onAuthorized();
    setInfoMessage(null);
  };

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

        <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50/80 p-6 text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-slate-500">Espacio reservado para Wompi</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">Aquí aparecerá el widget oficial de Wompi</p>
          <p className="mt-1 text-sm text-slate-500">
            Se cargará automáticamente al integrar el script <code>checkout.wompi.co/widget.js</code> y enviarás los datos del donante.
          </p>
          <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm text-slate-600">
            <span>🔐</span>
            El pago se procesa de manera segura a través de Wompi
          </div>
          <div className="mt-6 grid gap-3 text-left text-sm text-slate-600 md:grid-cols-2">
            <div className="rounded-2xl bg-white/90 p-4">
              <p className="font-semibold text-slate-800">Tarjeta</p>
              <p>Ingresa número, fecha y CVV directamente en el componente de Wompi.</p>
            </div>
            <div className="rounded-2xl bg-white/90 p-4">
              <p className="font-semibold text-slate-800">Nequi</p>
              <p>Autoriza desde tu celular con un código temporal.</p>
            </div>
          </div>
        </div>

        <SecurityNote />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="ghost" onClick={onBack}>
            Volver al paso anterior
          </Button>
          <Button type="button" onClick={handleAuthorize} loading={loading}>
            Autorizar donación mensual
          </Button>
          {infoMessage && <span className="text-sm text-slate-500">{infoMessage}</span>}
        </div>
      </div>
    </section>
  );
}
