export type AppOperationMode = "demo" | "cutover" | "active";

export function getAppOperationMode(): AppOperationMode {
  const mode = process.env.APP_OPERATION_MODE;
  return mode === "demo" || mode === "active" ? mode : "cutover";
}

export function isAdminDemoModeAllowed() {
  return getAppOperationMode() === "demo"
    && process.env.VERCEL_ENV !== "production"
    && (process.env.NODE_ENV !== "production"
      || process.env.VERCEL_ENV === "preview"
      || process.env.ALLOW_LOCAL_DEMO === "true");
}

export function financialOperationsEnabled() {
  return getAppOperationMode() === "active"
    && process.env.FINANCIAL_OPERATIONS_ENABLED === "true";
}

export function assertFinancialOperationsEnabled() {
  if (!financialOperationsEnabled()) throw new Error("FINANCIAL_OPERATIONS_DISABLED");
}

export function isSafeSupabaseUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return false;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (local) return process.env.VERCEL_ENV !== "production";
    return url.protocol === "https:"
      && process.env.VERCEL_ENV === "production"
      && getAppOperationMode() !== "demo";
  } catch {
    return false;
  }
}
