"use client";

import { useState } from "react";
import { donorFormSchema, type DonorFormValues } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { AmountChip } from "@/components/ui/amount-chip";
import { formatCurrencyCOP } from "@/lib/utils";

const amountOptions = [
  { value: 2500, description: "" },
  { value: 5000, description: "" },
  { value: 10000, description: "" },
  { value: 20000, description: "" },
  { value: 50000, description: "" },
  { value: 100000, description: "" },
];

interface DonorFormStepProps {
  values: DonorFormValues;
  onChange: (values: DonorFormValues) => void;
  onSubmit: (values: DonorFormValues) => Promise<void> | void;
  loading?: boolean;
}

export function DonorFormStep({ values, onChange, onSubmit, loading }: DonorFormStepProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [customAmount, setCustomAmount] = useState(
    amountOptions.some((option) => option.value === values.amount) ? "" : values.amount.toString()
  );

  const handleFieldChange = (field: keyof DonorFormValues, value: string | number | boolean) => {
    setErrors((prev) => ({ ...prev, [field]: "" }));
    onChange({ ...values, [field]: value });
  };

  const handleCustomAmount = (raw: string) => {
    setCustomAmount(raw);
    const parsed = Number(raw.replace(/[^0-9]/g, ""));
    if (!Number.isNaN(parsed)) {
      handleFieldChange("amount", parsed);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = donorFormSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.issues.forEach((issue) => {
        const path = issue.path[0];
        if (typeof path === "string") {
          fieldErrors[path] = issue.message;
        }
      });
      setErrors(fieldErrors);
      return;
    }

    await onSubmit(parsed.data);
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-6">
      <div className="grid gap-4 rounded-4xl bg-white/90 p-6 shadow-card">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex items-center gap-3 rounded-full bg-foundation-blue/10 px-4 py-2 text-sm text-foundation-blue">
            <span>💙</span>
            <span>Tu apoyo mensual cambia vidas</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span>🐶</span>
            <span>🐱</span>
            <span>Peludos atendidos cada mes</span>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <TextInput
            label="Nombre"
            name="firstName"
            required
            value={values.firstName}
            onChange={(event) => handleFieldChange("firstName", event.target.value)}
            error={errors.firstName}
          />
          <TextInput
            label="Apellidos"
            name="lastName"
            required
            value={values.lastName}
            onChange={(event) => handleFieldChange("lastName", event.target.value)}
            error={errors.lastName}
          />
          <TextInput
            label="Correo electrónico"
            name="email"
            type="email"
            required
            value={values.email}
            onChange={(event) => handleFieldChange("email", event.target.value)}
            error={errors.email}
          />
          <TextInput
            label="Teléfono"
            name="phone"
            required
            placeholder="Ej: +57 300 123 4567"
            value={values.phone}
            onChange={(event) => handleFieldChange("phone", event.target.value)}
            error={errors.phone}
          />
          <SelectField
            label="Tipo de documento"
            name="documentType"
            required
            value={values.documentType}
            onChange={(event) => handleFieldChange("documentType", event.target.value)}
            error={errors.documentType}
          >
            <option value="">Selecciona</option>
            <option value="CC">C.C.</option>
            <option value="CE">C.E.</option>
            <option value="PA">Pasaporte</option>
            <option value="NIT">NIT</option>
          </SelectField>
          <TextInput
            label="Número de documento"
            name="documentNumber"
            required
            value={values.documentNumber}
            onChange={(event) => handleFieldChange("documentNumber", event.target.value)}
            error={errors.documentNumber}
          />
          <TextInput
            label="Ciudad / Departamento"
            name="city"
            required
            value={values.city}
            onChange={(event) => handleFieldChange("city", event.target.value)}
            error={errors.city}
          />
          {/* Removed: opt-in for receiving updates */}
        </div>
      </div>

      <div className="grid gap-4 rounded-4xl bg-white/95 p-6 shadow-card">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-foundation-green">Tu donación</p>
            <h2 className="text-2xl font-semibold text-slate-900">{formatCurrencyCOP(values.amount)} COP</h2>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span className="text-base">🩺</span>
            <span className="leading-snug">Tu aporte se transforma en alimento, rescates y atención veterinaria.</span>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-foundation-blue/20 bg-foundation-cream px-4 py-3">
          <input
            id="isRecurring"
            name="isRecurring"
            type="checkbox"
            className="h-5 w-5 rounded border-slate-300 text-foundation-blue focus:ring-foundation-blue"
            checked={values.isRecurring}
            onChange={(event) => handleFieldChange("isRecurring", event.target.checked)}
          />
          <div className="leading-snug">
            <label htmlFor="isRecurring" className="font-semibold text-slate-900">
              Activar cobro mensual automático
            </label>
            <p className="text-sm text-slate-600">Desmarca si solo quieres un cobro único.</p>
            <div className="mt-2 flex items-start gap-2 rounded-2xl border border-foundation-warm/30 bg-foundation-warm/15 px-3 py-2 text-sm text-slate-800">
              <span role="img" aria-label="Alerta" className="text-base text-foundation-warm">
                ⚠️
              </span>
              <p className="leading-snug">
                Cobro automático solo con tarjeta; con Nequi deberás aprobar cada mes.
              </p>
            </div>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          {amountOptions.map((option) => (
            <AmountChip
              key={option.value}
              value={option.value}
              description={option.description}
              selected={values.amount === option.value}
              onSelect={(selected) => {
                setCustomAmount("");
                handleFieldChange("amount", selected);
              }}
            />
          ))}
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-semibold text-slate-700" htmlFor="custom-amount">
            ¿Prefieres otro monto?
          </label>
          <input
            id="custom-amount"
            name="customAmount"
            inputMode="numeric"
            className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 focus:border-foundation-blue focus:outline-none"
            placeholder="Ingresa el monto que quieras donar"
            value={customAmount}
            onChange={(event) => handleCustomAmount(event.target.value)}
          />
          <p className="text-xs text-slate-500">Monto mínimo 1.500 COP.</p>
          {errors.amount && <span className="text-xs text-foundation-warm">{errors.amount}</span>}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-4xl bg-white/90 p-6 text-sm text-slate-600 shadow-card">
        <p>
          Esta es una donación <span className="font-semibold text-foundation-blue">mensual</span>. Puedes cancelarla cuando
          quieras contactando a <span className="font-semibold">la fundación Hablemos por ellos</span>.
        </p>
        <p>
          Al continuar, crearemos un borrador de tu suscripción y te guiaremos al pago seguro con Wompi.
        </p>
        <Button type="submit" loading={loading} className="mt-2 w-full sm:w-auto">
          {values.isRecurring ? "Continuar con mi donación mensual" : "Continuar con mi donación única"}
        </Button>
      </div>
    </form>
  );
}
