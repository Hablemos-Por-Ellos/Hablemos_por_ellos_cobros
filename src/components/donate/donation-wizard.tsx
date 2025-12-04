"use client";

import { useCallback, useState } from "react";
import { DonorFormStep } from "./donor-form-step";
import { PaymentStep } from "./payment-step";
import { ConfirmationStep } from "./confirmation-step";
import { Stepper } from "./stepper";
import { Toast } from "@/components/ui/toast";
import { type DonorFormValues } from "@/lib/schemas";
import { simulateWompiAuthorization } from "@/lib/wompi";
import { sleep } from "@/lib/utils";

const INITIAL_DONOR: DonorFormValues = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  documentType: "CC",
  documentNumber: "",
  city: "",
  wantsUpdates: false,
  amount: 50000,
};

type Step = 1 | 2 | 3;

export function DonationWizard() {
  const [step, setStep] = useState<Step>(1);
  const [donor, setDonor] = useState<DonorFormValues>(INITIAL_DONOR);
  const [paymentMethod, setPaymentMethod] = useState<"card" | "nequi">("card");
  const [isLoading, setIsLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [confirmationStatus, setConfirmationStatus] = useState<"confirmed" | "pending">("confirmed");
  const [paymentSummary, setPaymentSummary] = useState("Tarjeta •••• 4242");

  const persistDonation = useCallback(
    async (
      stage: "draft" | "confirm",
      overrides?: Partial<{ donor: DonorFormValues; amount: number; paymentMethod: "card" | "nequi" }>,
      extra?: Record<string, unknown>
    ) => {
      const donorSource = overrides?.donor ?? donor;
      const { amount: _omit, ...donorWithoutAmount } = donorSource;
      const body = {
        stage,
        donor: donorWithoutAmount,
        amount: overrides?.amount ?? donor.amount,
        paymentMethod: overrides?.paymentMethod ?? paymentMethod,
        ...extra,
      };

      const response = await fetch("/api/donations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error?.message ?? "No pudimos guardar la suscripción");
      }

      return response.json();
    },
    [donor, paymentMethod]
  );

  const handleDraftSubmit = async (values: DonorFormValues) => {
    try {
      setIsLoading(true);
      setDonor(values);
      await persistDonation("draft", { donor: values });
      setToast({ message: "Datos guardados. Sigamos al pago seguro", type: "success" });
      await sleep(300);
      setStep(2);
    } catch (error) {
      setToast({ message: (error as Error).message, type: "error" });
    } finally {
      setIsLoading(false);
    }
  };

  const handlePaymentAuthorized = async (wompiData?: { token: string; maskedDetails: string }) => {
    try {
      setIsLoading(true);
      // Use real Wompi data if provided, otherwise fall back to simulation for demo mode
      const paymentData = wompiData || simulateWompiAuthorization(paymentMethod);
      const result = await persistDonation("confirm", undefined, {
        wompi: { token: paymentData.token, maskedDetails: paymentData.maskedDetails },
      });
      setPaymentSummary(paymentData.maskedDetails);
      setConfirmationStatus(result?.status === "subscription_created" ? "confirmed" : "pending");
      setStep(3);
      setToast({ message: "¡Suscripción creada!", type: "success" });
    } catch (error) {
      setToast({ message: (error as Error).message, type: "error" });
    } finally {
      setIsLoading(false);
    }
  };

  const resetFlow = () => {
    setStep(1);
    setDonor(INITIAL_DONOR);
    setPaymentMethod("card");
    setPaymentSummary("Tarjeta •••• 4242");
  };

  return (
    <div className="grid gap-8">
      <Stepper currentStep={step} />

      {step === 1 && <DonorFormStep values={donor} onChange={setDonor} onSubmit={handleDraftSubmit} loading={isLoading} />}

      {step === 2 && (
        <PaymentStep
          donor={donor}
          amount={donor.amount}
          paymentMethod={paymentMethod}
          onMethodChange={setPaymentMethod}
          onBack={() => setStep(1)}
          onAuthorized={handlePaymentAuthorized}
          loading={isLoading}
        />
      )}

      {step === 3 && (
        <ConfirmationStep
          donor={donor}
          amount={donor.amount}
          status={confirmationStatus}
          paymentSummary={paymentSummary}
          onGoHome={resetFlow}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
}
