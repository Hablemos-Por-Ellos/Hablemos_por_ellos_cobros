"use client";

import { useCallback, useEffect, useState } from "react";
import { DonorFormStep } from "./donor-form-step";
import { PaymentStep } from "./payment-step";
import { ConfirmationStep } from "./confirmation-step";
import { Stepper } from "./stepper";
import { Toast } from "@/components/ui/toast";
import { type DonorFormValues } from "@/lib/schemas";
import { sleep } from "@/lib/utils";
import { cleanupWompiOverlayDom } from "@/lib/wompi";

const INITIAL_DONOR: DonorFormValues = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  documentType: "CC",
  documentNumber: "",
  city: "",
  wantsUpdates: false,
  isRecurring: true,
  amount: 50000,
};

type Step = 1 | 2 | 3;
type DonationStage = "draft" | "checkout" | "confirm";
type WompiAuthorizationData = {
  token: string;
  cardToken?: string;
  paymentSourceType?: string;
  paymentSourceId?: string;
  transactionId?: string;
  maskedDetails: string;
  reference: string;
  acceptanceToken?: string;
  acceptPersonalAuth?: string;
};

export function DonationWizard() {
  const [step, setStep] = useState<Step>(1);
  const [donor, setDonor] = useState<DonorFormValues>(INITIAL_DONOR);
  const [paymentMethod, setPaymentMethod] = useState<"card" | "nequi">("card");
  const [isLoading, setIsLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [confirmationStatus, setConfirmationStatus] = useState<"confirmed" | "pending">("confirmed");
  const [paymentSummary, setPaymentSummary] = useState("Tarjeta •••• 4242");

  // Remove any stuck Wompi overlay when step changes or component unmounts
  useEffect(() => {
    cleanupWompiOverlayDom();
    return () => cleanupWompiOverlayDom();
  }, [step]);

  const persistDonation = useCallback(
    async (
      stage: DonationStage,
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

  const handlePaymentAuthorized = async (
    wompiData: WompiAuthorizationData
  ) => {
    try {
      setIsLoading(true);
      if (!wompiData?.token) {
        throw new Error("No recibimos confirmaci\u00f3n del pago con Wompi. Int\u00e9ntalo de nuevo.");
      }
      const paymentData = wompiData;
      const result = await persistDonation("confirm", undefined, {
        wompi: {
          token: paymentData.token,
          cardToken: paymentData.cardToken,
          paymentSourceType: paymentData.paymentSourceType,
          paymentSourceId: paymentData.paymentSourceId,
          transactionId: paymentData.transactionId,
          reference: paymentData.reference,
          maskedDetails: paymentData.maskedDetails,
          acceptanceToken: paymentData.acceptanceToken,
          acceptPersonalAuth: paymentData.acceptPersonalAuth,
        },
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

  const handleCheckoutStarted = async ({ reference }: { reference: string }) => {
    await persistDonation("checkout", undefined, {
      wompi: { reference },
    });
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
          isRecurring={donor.isRecurring}
          paymentMethod={paymentMethod}
          onMethodChange={setPaymentMethod}
          onBack={() => setStep(1)}
          onCheckoutStarted={handleCheckoutStarted}
          onAuthorized={handlePaymentAuthorized}
          loading={isLoading}
        />
      )}

      {step === 3 && (
        <ConfirmationStep
          donor={donor}
          amount={donor.amount}
          isRecurring={donor.isRecurring}
          status={confirmationStatus}
          paymentSummary={paymentSummary}
          onGoHome={resetFlow}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
}
