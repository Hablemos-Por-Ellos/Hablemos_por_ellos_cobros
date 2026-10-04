import { createBrowserClient } from "@supabase/ssr";
import { authCookieOptions } from "@/lib/auth-environment";

let browserClient: ReturnType<typeof createBrowserClient> | null = null;
let clientConfig = "";

export function isSafeBrowserAuthUrl(value: string, deploymentEnvironment = process.env.NEXT_PUBLIC_VERCEL_ENV) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const localPage = typeof window !== "undefined"
      && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
    if (localPage && !local) return false;
    return local ? deploymentEnvironment !== "production"
      : url.protocol === "https:" && deploymentEnvironment === "production";
  } catch {
    return false;
  }
}

export function getBrowserSupabaseClient(deploymentEnvironment = process.env.NEXT_PUBLIC_VERCEL_ENV) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (process.env.NEXT_PUBLIC_APP_OPERATION_MODE === "demo"
    || !url || !key || !isSafeBrowserAuthUrl(url, deploymentEnvironment)) {
    browserClient = null;
    clientConfig = "";
    throw new Error("Autenticacion no disponible en este entorno.");
  }

  const config = `${url}|${key}|${deploymentEnvironment}`;
  if (config !== clientConfig) {
    browserClient = createBrowserClient(url, key, { cookieOptions: authCookieOptions(deploymentEnvironment) });
    clientConfig = config;
  }
  return browserClient;
}
