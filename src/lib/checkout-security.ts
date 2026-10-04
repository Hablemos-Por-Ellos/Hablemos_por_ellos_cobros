import crypto from "crypto";

function checkoutPepper() {
  const value = process.env.CHECKOUT_TOKEN_PEPPER;
  if (!value || value.length < 32) {
    throw new Error("CHECKOUT_TOKEN_PEPPER_NOT_CONFIGURED");
  }
  return value;
}

export function createCheckoutToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashCheckoutToken(token: string) {
  return crypto.createHmac("sha256", checkoutPepper()).update(token).digest("hex");
}

export function createDonationReference() {
  return `HPE-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`.toUpperCase();
}

export function requestKeyHash(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "unknown";
  return crypto.createHmac("sha256", checkoutPepper()).update(address).digest("hex");
}
