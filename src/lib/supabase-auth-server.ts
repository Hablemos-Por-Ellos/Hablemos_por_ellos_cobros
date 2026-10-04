import { clearAuthCookiesAtScopes, createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { getAppOperationMode } from "@/lib/operation-mode";
import { authCookieOptions, isAuthEnvironmentAllowed } from "@/lib/auth-environment";

export async function isServerAuthEnvironmentAllowed() {
  const environment = {
    operationMode: getAppOperationMode(),
    deploymentEnvironment: process.env.VERCEL_ENV,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceUrl: process.env.SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  if (isAuthEnvironmentAllowed(environment)) return true;
  try {
    return isAuthEnvironmentAllowed(environment, await headers());
  } catch { return false; }
}

export async function getServerAuthSupabaseClient() {
  if (!(await isServerAuthEnvironmentAllowed())) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookieOptions: authCookieOptions(process.env.VERCEL_ENV),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(values) {
        try {
          values.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot always write cookies. Middleware refreshes them.
        }
      },
    },
  });
}

export async function clearServerAuthCookies() {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    const cookieStore = await cookies();
    // This is the SDK's default storage key; never clear another project's cookies.
    const storageKey = `sb-${url.hostname.split(".")[0]}-auth-token`;
    await clearAuthCookiesAtScopes({
      storageKey,
      scopes: [{ path: "/" }],
      getAll: () => cookieStore.getAll(),
      setAll: (values) => { values.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); },
    });
    return true;
  } catch { return false; }
}
