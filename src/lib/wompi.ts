export const WOMPI_WIDGET_URL = "https://checkout.wompi.co/widget.js";
export const WOMPI_API_BASE_URL = "https://production.wompi.co/v1";

export type WompiSimulatedResponse = {
  paymentSourceId: string;
  token: string;
  maskedDetails: string;
};

/**
 * Obtiene la llave pública de Wompi (para frontend/widget).
 * Esta llave es segura de exponer en el cliente.
 */
export function getWompiPublicKey(): string | undefined {
  return process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY;
}

/**
 * Obtiene la llave privada de Wompi (solo para backend).
 * NUNCA expongas esta llave en el cliente.
 */
export function getWompiPrivateKey(): string | undefined {
  return process.env.WOMPI_PRIVATE_KEY;
}

export function simulateWompiAuthorization(method: "card" | "nequi"): WompiSimulatedResponse {
  const token =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  const maskedDetails = method === "card" ? "Tarjeta •••• 4242" : "Nequi •••• 1234";
  return {
    paymentSourceId: `wompi-src-${token}`,
    token,
    maskedDetails,
  };
}
