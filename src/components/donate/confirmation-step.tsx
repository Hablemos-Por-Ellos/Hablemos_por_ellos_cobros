"use client";

import { Button } from "@/components/ui/button";
import type { DonorFormValues } from "@/lib/schemas";
import { formatCurrencyCOP } from "@/lib/utils";

interface ConfirmationStepProps {
  donor: DonorFormValues;
  amount: number;
  status: "confirmed" | "pending";
  paymentSummary: string;
  onGoHome: () => void;
}

export function ConfirmationStep({ donor, amount, status, paymentSummary, onGoHome }: ConfirmationStepProps) {
  return (
    <section className="grid gap-6 rounded-4xl bg-white/95 p-8 text-center shadow-card">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-foundation-green/10 text-4xl">
        🐾
      </div>
      <div>
        <p className="text-sm uppercase tracking-[0.3em] text-foundation-green">Paso final</p>
        <h2 className="mt-2 text-3xl font-semibold text-slate-900">
          {status === "confirmed" ? "¡Gracias! Ya formas parte de su manada" : "Estamos confirmando tu donación"}
        </h2>
        <p className="mt-2 text-lg text-slate-600">
          {status === "confirmed"
            ? `Tu donación mensual de ${formatCurrencyCOP(amount)} quedó activa. Cada mes recibirás un comprobante en ${donor.email}.`
            : `Recibirás un correo en ${donor.email} con la confirmación del banco en los próximos minutos.`}
        </p>
      </div>

      <div className="grid gap-4 rounded-4xl bg-foundation-cream p-6 text-left">
        <div className="grid gap-1">
          <p className="text-sm font-semibold text-slate-500">Donante</p>
          <p className="text-lg font-semibold text-slate-900">{donor.firstName} {donor.lastName}</p>
          <p className="text-sm text-slate-600">{donor.email} · {donor.phone}</p>
        </div>
        <div className="grid gap-1">
          <p className="text-sm font-semibold text-slate-500">Monto mensual</p>
          <p className="text-2xl font-semibold text-foundation-blue">{formatCurrencyCOP(amount)}</p>
        </div>
        <div className="grid gap-1">
          <p className="text-sm font-semibold text-slate-500">Método autorizado</p>
          <p className="text-lg text-slate-700">{paymentSummary}</p>
        </div>
      </div>

      <div className="rounded-4xl bg-white/80 p-4 text-sm text-slate-600">
        Tu donación se invierte en alimentación, rescates y atención veterinaria. Si deseas modificar o cancelar tu suscripción, escríbenos a contacto@hablemosporellos.org.
      </div>

      <div className="flex flex-wrap items-center justify-center gap-4">
        <Button onClick={onGoHome}>Volver a la página principal</Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            if (typeof navigator !== "undefined" && navigator.share) {
              navigator.share({
                title: "Hablemos por Ellos",
                text: "Me uní como donante mensual",
                url: typeof window !== "undefined" ? window.location.href : "https://hablemosporellos.org",
              });
            }
          }}
        >
          Compartir solidaridad
        </Button>
      </div>
    </section>
  );
}
