// Widget URL is the same for sandbox and production; environment is
// determined by the public key (pub_test_ vs pub_prod_)
export const WOMPI_WIDGET_URL = "https://checkout.wompi.co/widget.js";

// Base URLs for REST API
const WOMPI_API_BASE_URL_PROD = "https://production.wompi.co/v1";
const WOMPI_API_BASE_URL_SANDBOX = "https://sandbox.wompi.co/v1";

export function resolveWompiEnvironment(
  configuredValue: string | undefined,
  nodeEnvironment: string | undefined
): "sandbox" | "prod" {
  const configured = configuredValue?.trim().toLowerCase();
  if (configured === "prod" || configured === "production") return "prod";
  if (configured === "sandbox" || configured === "test") return "sandbox";
  if (nodeEnvironment === "production") throw new Error("NEXT_PUBLIC_WOMPI_ENV_NOT_CONFIGURED");
  return "sandbox";
}

export const WOMPI_ENV = resolveWompiEnvironment(
  process.env.NEXT_PUBLIC_WOMPI_ENV,
  process.env.NODE_ENV
);

// Usa prod si WOMPI_ENV === "prod"; sandbox en cualquier otro caso
export const isProduction = WOMPI_ENV === "prod";

export const WOMPI_API_BASE_URL = isProduction
  ? WOMPI_API_BASE_URL_PROD
  : WOMPI_API_BASE_URL_SANDBOX;

/**
 * Determina la URL base de la API de Wompi según la llave configurada.
 * Si la llave es de pruebas (pub_test/prv_test) usamos sandbox; de lo contrario producción.
 */
export function getWompiApiBaseUrl(): string {
  return WOMPI_API_BASE_URL;
}

/**
 * Obtiene la llave pública de Wompi (para frontend/widget).
 * Selecciona automáticamente entre SANDBOX y PROD según NEXT_PUBLIC_WOMPI_ENV.
 */
export function getWompiPublicKey(): string {
  if (isProduction) {
    return (
      process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY_PROD ??
      process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY ??
      ""
    );
  }
  return (
    process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX ??
    process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY ??
    ""
  );
}

/**
 * Obtiene la llave privada de Wompi (solo para backend).
 * Selecciona automáticamente entre SANDBOX y PROD según NEXT_PUBLIC_WOMPI_ENV.
 * NUNCA expongas esta llave en el cliente.
 */
export function getWompiPrivateKey(): string {
  if (isProduction) {
    return (
      process.env.WOMPI_PRIVATE_KEY_PROD ??
      process.env.WOMPI_PRIVATE_KEY ??
      ""
    );
  }
  return (
    process.env.WOMPI_PRIVATE_KEY_SANDBOX ??
    process.env.WOMPI_PRIVATE_KEY ??
    ""
  );
}

/**
 * Obtiene el secreto de integridad de Wompi (solo para backend).
 * Selecciona automáticamente entre SANDBOX y PROD según NEXT_PUBLIC_WOMPI_ENV.
 */
export function getWompiIntegritySecret(): string {
  if (isProduction) {
    return (
      process.env.WOMPI_INTEGRITY_SECRET_PROD ??
      process.env.WOMPI_INTEGRITY_SECRET ??
      ""
    );
  }
  return (
    process.env.WOMPI_INTEGRITY_SECRET_SANDBOX ??
    process.env.WOMPI_INTEGRITY_SECRET ??
    ""
  );
}

/**
 * Obtiene el secreto de eventos de Wompi (solo para backend).
 * Selecciona automáticamente entre SANDBOX y PROD según NEXT_PUBLIC_WOMPI_ENV.
 */
export function getWompiEventsSecret(): string {
  if (isProduction) {
    return (
      process.env.WOMPI_EVENTS_SECRET_PROD ??
      process.env.WOMPI_EVENTS_SECRET ??
      ""
    );
  }
  return (
    process.env.WOMPI_EVENTS_SECRET_SANDBOX ??
    process.env.WOMPI_EVENTS_SECRET ??
    ""
  );
}

// Limpia cualquier overlay del widget de Wompi que quede pegado en el DOM
export function cleanupWompiOverlayDom(): void {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".waybox-backdrop, .waybox-preload-wrapper").forEach((el) => el.remove());
}
