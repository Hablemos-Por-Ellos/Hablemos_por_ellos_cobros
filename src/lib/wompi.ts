export const WOMPI_WIDGET_URL = "https://checkout.wompi.co/widget.js";

export type WompiSimulatedResponse = {
  paymentSourceId: string;
  token: string;
  maskedDetails: string;
};

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
