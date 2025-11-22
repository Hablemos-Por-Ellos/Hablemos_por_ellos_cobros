"use client";

import { useMemo, useState } from "react";
import { donorFormSchema, type DonorFormValues } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { AmountChip } from "@/components/ui/amount-chip";
import { formatCurrencyCOP } from "@/lib/utils";

const amountOptions = [
  { value: 20000, description: "Alimento y arena para un peludo" },
  { value: 50000, description: "Medicamentos y esterilización" },
  { value: 100000, description: "Rescate y hogar temporal" },
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

  const impactCopy = useMemo(() => {
    if (values.amount >= 100000) {
      return "Garantizas rescate, tratamientos y hogar temporal";
    }
    if (values.amount >= 50000) {
      return "Cubres medicamentos y citas veterinarias";
    }
    return "Aseguras alimento balanceado cada semana";
  }, [values.amount]);

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
        <div className="flex flex-wrap items-center gap-4">
          <div className="inline-flex items-center gap-3 rounded-full bg-foundation-blue/10 px-4 py-2 text-sm text-foundation-blue">
            <span>💙</span>
            <span>Tu apoyo mensual cambia vidas</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span>🐶</span>
            <span>🐱</span>
            <span>+120 peludos atendidos cada mes</span>
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
          <label className="flex items-start gap-3 rounded-3xl bg-foundation-green/5 p-4 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={values.wantsUpdates}
              onChange={(event) => handleFieldChange("wantsUpdates", event.target.checked)}
              className="mt-1 h-5 w-5 rounded border-foundation-green text-foundation-green focus:ring-foundation-green"
            />
            <span>Quiero recibir historias y actualizaciones de los peludos.</span>
          </label>
        </div>
      </div>

      <div className="grid gap-4 rounded-4xl bg-white/95 p-6 shadow-card">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <p className="text-sm font-semibold text-foundation-green">Tu donación mensual</p>
            <h2 className="text-2xl font-semibold text-slate-900">{formatCurrencyCOP(values.amount)} COP</h2>
            <p className="text-sm text-slate-500">{impactCopy}</p>
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-500">
            <span className="text-base">🩺</span>
            Tu aporte se transforma en alimento, rescates y atención veterinaria.
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
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
            placeholder="Ingresa un valor mínimo de $10.000"
            value={customAmount}
            onChange={(event) => handleCustomAmount(event.target.value)}
          />
          {errors.amount && <span className="text-xs text-foundation-warm">{errors.amount}</span>}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-4xl bg-white/90 p-6 text-sm text-slate-600 shadow-card">
        <p>
          Esta es una donación <span className="font-semibold text-foundation-blue">mensual</span>. Puedes cancelarla cuando
          quieras escribiendo a <span className="font-semibold">contacto@hablemosporellos.org</span>.
        </p>
        <p>
          Al continuar, crearemos un borrador de tu suscripción y te guiaremos al pago seguro con Wompi.
        </p>
        <Button type="submit" loading={loading} className="mt-2 self-start">
          Continuar con mi donación mensual
        </Button>
      </div>
    </form>
  );
}
