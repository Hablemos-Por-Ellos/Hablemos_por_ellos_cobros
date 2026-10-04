import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentStep } from "./payment-step";

const donor = {
  firstName: "Ana",
  lastName: "Prueba",
  email: "ana.prueba@example.com",
  phone: "+57 300 123 4567",
  documentType: "CC" as const,
  documentNumber: "123456789",
  city: "Bogota",
  wantsUpdates: false,
  isRecurring: true,
  preferredPaymentDay: 16 as const,
  amount: 50000,
};

const checkout = {
  token: "checkout-token-that-is-long-enough-for-tests",
  reference: "HPE-TEST-REFERENCE",
  signature: "sig_mock",
  amountInCents: 5000000,
  currency: "COP" as const,
  expiresAt: "2026-09-19T20:00:00.000Z",
  acceptancePermalink: "https://wompi.test/terms",
  personalDataAuthPermalink: "https://wompi.test/data",
};

describe("PaymentStep Wompi tokenization UX", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalPublicKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalPublicKey = process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX;
    process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX = "pub_test_mock";

    globalThis.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    if (originalPublicKey === undefined) {
      delete process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX;
    } else {
      process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX = originalPublicKey;
    }
    delete (window as Partial<Window>).WidgetCheckout;
  });

  it("does not show a hard timeout while the Wompi modal is open", async () => {
    const open = vi.fn();
    (window as Partial<Window>).WidgetCheckout = vi.fn(function WidgetCheckoutMock() {
      return { open };
    }) as Window["WidgetCheckout"];

    render(
      <PaymentStep
        donor={donor}
        amount={50000}
        isRecurring
        paymentMethod="card"
        checkout={checkout}
        onMethodChange={vi.fn()}
        onBack={vi.fn()}
        onCheckoutStarted={vi.fn()}
        onAuthorized={vi.fn()}
      />
    );

    expect(await screen.findByText(/puede verse en gris por diseño de Wompi/i)).toBeInTheDocument();

    const termsCheckbox = await screen.findByRole("checkbox", { name: /Acepto los/i });
    await waitFor(() => expect(termsCheckbox).toBeEnabled());
    fireEvent.click(termsCheckbox);

    const payButton = await screen.findByRole("button", { name: /Registrar tarjeta y donar/i });
    await waitFor(() => expect(payButton).toBeEnabled());

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(payButton);
      await Promise.resolve();
    });

    expect(open).toHaveBeenCalledTimes(1);
    expect(payButton).toBeEnabled();

    act(() => {
      vi.advanceTimersByTime(31000);
    });

    expect(screen.queryByText(/El proceso tardó demasiado/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Esto está tardando más de lo esperado/i)).not.toBeInTheDocument();
  });

  it("records checkout start before opening a one-time payment", async () => {
    const callOrder: string[] = [];
    const open = vi.fn(() => { callOrder.push("open"); });
    const onCheckoutStarted = vi.fn(async () => { callOrder.push("checkout"); });
    (window as Partial<Window>).WidgetCheckout = vi.fn(function WidgetCheckoutMock() {
      return { open };
    }) as Window["WidgetCheckout"];

    render(
      <PaymentStep
        donor={{ ...donor, isRecurring: false }}
        amount={50000}
        isRecurring={false}
        paymentMethod="card"
        checkout={checkout}
        onMethodChange={vi.fn()}
        onBack={vi.fn()}
        onCheckoutStarted={onCheckoutStarted}
        onAuthorized={vi.fn()}
      />
    );

    const payButton = await screen.findByRole("button", { name: /Pagar/i });
    await waitFor(() => expect(payButton).toBeEnabled());
    fireEvent.click(payButton);

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(onCheckoutStarted).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["checkout", "open"]);
  });

  it("keeps the payment button disabled while the backend confirmation is running", async () => {
    (window as Partial<Window>).WidgetCheckout = vi.fn(function WidgetCheckoutMock() {
      return { open: vi.fn() };
    }) as Window["WidgetCheckout"];

    render(
      <PaymentStep
        donor={donor}
        amount={50000}
        isRecurring
        paymentMethod="card"
        checkout={checkout}
        onMethodChange={vi.fn()}
        onBack={vi.fn()}
        onCheckoutStarted={vi.fn()}
        onAuthorized={vi.fn()}
        loading
      />
    );

    const termsCheckbox = await screen.findByRole("checkbox", { name: /Acepto los/i });
    fireEvent.click(termsCheckbox);

    const payButton = await screen.findByRole("button", { name: /Procesando/i });
    expect(payButton).toBeDisabled();
  });

  it("does not reopen Wompi while the same authorization is being reconciled", async () => {
    const open = vi.fn();
    const onRetryConfirmation = vi.fn();
    (window as Partial<Window>).WidgetCheckout = vi.fn(function WidgetCheckoutMock() {
      return { open };
    }) as Window["WidgetCheckout"];

    render(
      <PaymentStep
        donor={donor}
        amount={50000}
        isRecurring
        paymentMethod="card"
        checkout={checkout}
        onMethodChange={vi.fn()}
        onBack={vi.fn()}
        onCheckoutStarted={vi.fn()}
        onAuthorized={vi.fn()}
        reconciliationPending
        onRetryConfirmation={onRetryConfirmation}
      />
    );

    expect(await screen.findByText(/mismo pago está pendiente de confirmación/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Registrar tarjeta y donar/i })).not.toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: /Reintentar confirmación/i });
    fireEvent.click(retryButton);

    expect(onRetryConfirmation).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Volver al paso anterior/i })).toBeDisabled();
  });
});
