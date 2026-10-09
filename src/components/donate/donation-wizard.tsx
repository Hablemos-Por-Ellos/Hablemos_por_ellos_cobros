"use client";

import { useCallback, useEffect, useState } from "react";
import { DonorFormStep } from "./donor-form-step";
import { PaymentStep, type CheckoutSession } from "./payment-step";
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
  retryAuthorizationConfirmed: false,
  preferredPaymentDay: 16,
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
};

class DonationRequestError extends Error {
  status: number;
  code: string | null;
  transactionId: string | null;

  constructor(message: string, status: number, code: string | null, transactionId: string | null) {
    super(message);
    this.name = "DonationRequestError";
    this.status = status;
    this.code = code;
    this.transactionId = transactionId;
  }
}

export function DonationWizard() {
  const [step, setStep] = useState<Step>(1);
  const [donor, setDonor] = useState<DonorFormValues>(INITIAL_DONOR);
  const [paymentMethod, setPaymentMethod] = useState<"card" | "nequi">("card");
  const [isLoading, setIsLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [confirmationStatus, setConfirmationStatus] = useState<"confirmed" | "pending">("confirmed");
  const [paymentSummary, setPaymentSummary] = useState("Tarjeta •••• 4242");
  const [checkout, setCheckout] = useState<CheckoutSession | null>(null);
  const [pendingAuthorization, setPendingAuthorization] = useState<WompiAuthorizationData | null>(null);

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
        const error = await response.json().catch(() => ({})) as {
          message?: string;
          code?: string;
          transactionId?: string;
        };
        throw new DonationRequestError(
          error?.message ?? "No pudimos guardar la suscripción",
          response.status,
          error?.code ?? null,
          error?.transactionId ?? null
        );
      }

      return response.json();
    },
    [donor, paymentMethod]
  );

  const handleDraftSubmit = async (values: DonorFormValues) => {
    try {
      setIsLoading(true);
      setDonor(values);
      const result = await persistDonation("draft", { donor: values });
      if (!result?.checkout?.token || !result?.checkout?.reference || !result?.checkout?.signature) {
        throw new Error("No pudimos preparar una sesion de pago segura.");
      }
      setCheckout(result.checkout as CheckoutSession);
      setToast({ message: "Datos guardados. Sigamos al pago seguro", type: "success" });
      await sleep(300);
      setStep(2);
    } catch (error) {
      setToast({ message: (error as Error).message, type: "error" });
    } finally {
      setIsLoading(false);
    }
  };

  const confirmAuthorization = async (paymentData: WompiAuthorizationData) => {
    try {
      setIsLoading(true);
      if (!paymentData?.token) {
        throw new Error("No recibimos confirmaci\u00f3n del pago con Wompi. Int\u00e9ntalo de nuevo.");
      }
      if (!checkout) throw new Error("La sesion de pago no esta lista.");
      const result = await persistDonation("confirm", undefined, {
        checkoutToken: checkout.token,
        wompi: {
          token: paymentData.token,
          cardToken: paymentData.cardToken,
          paymentSourceType: paymentData.paymentSourceType,
          paymentSourceId: paymentData.paymentSourceId,
          transactionId: paymentData.transactionId,
          reference: paymentData.reference,
          maskedDetails: paymentData.maskedDetails,
        },
      });
      setPaymentSummary(paymentData.maskedDetails);
      setPendingAuthorization(null);
      const confirmed = result?.status === "subscription_created";
      setConfirmationStatus(confirmed ? "confirmed" : "pending");
      setStep(3);
      setToast({
        message: confirmed
          ? donor.isRecurring
            ? "¡Suscripción creada!"
            : "¡Donación confirmada!"
          : "Wompi está confirmando tu pago.",
        type: confirmed ? "success" : "info",
      });
    } catch (error) {
      const restartRequired = error instanceof DonationRequestError
        && (error.status === 402 || error.code === "checkout_restart_required");
      if (restartRequired) {
        setPendingAuthorization(null);
        setCheckout(null);
        setStep(1);
      } else {
        setPendingAuthorization({
          ...paymentData,
          transactionId: error instanceof DonationRequestError && error.transactionId
            ? error.transactionId
            : paymentData.transactionId,
        });
      }
      setToast({
        message: restartRequired
          ? (error as Error).message
          : "Estamos conciliando este mismo intento. No abras otro pago; usa Reintentar confirmación.",
        type: restartRequired ? "error" : "info",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handlePaymentAuthorized = async (wompiData: WompiAuthorizationData) => {
    if (pendingAuthorization) return;
    setPendingAuthorization(wompiData);
    await confirmAuthorization(wompiData);
  };

  const handleRetryConfirmation = async () => {
    if (!pendingAuthorization || isLoading) return;
    await confirmAuthorization(pendingAuthorization);
  };

  const handleCheckoutStarted = async () => {
    if (!checkout) throw new Error("La sesion de pago no esta lista.");
    await persistDonation("checkout", undefined, {
      checkoutToken: checkout.token,
      wompi: { reference: checkout.reference },
    });
  };

  const resetFlow = () => {
    setStep(1);
    setDonor(INITIAL_DONOR);
    setPaymentMethod("card");
    setPaymentSummary("Tarjeta •••• 4242");
    setConfirmationStatus("confirmed");
    setCheckout(null);
    setPendingAuthorization(null);
  };

  return (
    <div className="grid gap-8">
      <Stepper currentStep={step} />

      {step === 1 && <DonorFormStep values={donor} onChange={setDonor} onSubmit={handleDraftSubmit} loading={isLoading} />}

      {step === 2 && checkout && (
        <PaymentStep
          donor={donor}
          amount={donor.amount}
          isRecurring={donor.isRecurring}
          paymentMethod={paymentMethod}
          checkout={checkout}
          onMethodChange={setPaymentMethod}
          onBack={() => setStep(1)}
          onCheckoutStarted={handleCheckoutStarted}
          onAuthorized={handlePaymentAuthorized}
          reconciliationPending={Boolean(pendingAuthorization)}
          onRetryConfirmation={handleRetryConfirmation}
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
