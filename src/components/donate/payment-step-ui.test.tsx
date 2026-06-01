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
  amount: 50000,
};

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("PaymentStep Wompi tokenization UX", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalPublicKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalPublicKey = process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX;
    process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX = "pub_test_mock";

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/wompi/signature")) {
        return jsonResponse({ signature: "sig_mock" });
      }
      if (url.includes("/api/wompi/acceptance")) {
        return jsonResponse({
          acceptanceToken: "acceptance_mock",
          acceptPersonalAuth: "personal_auth_mock",
          acceptancePermalink: "https://wompi.test/terms",
          personalDataAuthPermalink: "https://wompi.test/data",
        });
      }
      throw new Error(`Unhandled fetch ${url}`);
    }) as typeof fetch;
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
    (window as Partial<Window>).WidgetCheckout = vi.fn(() => ({ open })) as Window["WidgetCheckout"];

    render(
      <PaymentStep
        donor={donor}
        amount={50000}
        isRecurring
        paymentMethod="card"
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

    act(() => {
      vi.advanceTimersByTime(31000);
    });

    expect(screen.queryByText(/El proceso tardó demasiado/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Esto está tardando más de lo esperado/i)).not.toBeInTheDocument();
  });
});
