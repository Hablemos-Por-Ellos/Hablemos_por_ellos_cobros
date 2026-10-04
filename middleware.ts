import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getAppOperationMode } from "@/lib/operation-mode";
import { authCookieOptions, isAuthEnvironmentAllowed } from "@/lib/auth-environment";

const privateHeaders = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
};

function preventSharedSessionCaching(response: NextResponse) {
  Object.entries(privateHeaders).forEach(([name, value]) => response.headers.set(name, value));
  return response;
}

export async function middleware(request: NextRequest) {
  let response = preventSharedSessionCaching(NextResponse.next({ request }));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key || !isAuthEnvironmentAllowed({
    operationMode: getAppOperationMode(),
    deploymentEnvironment: process.env.VERCEL_ENV,
    supabaseUrl: url,
    serviceUrl: process.env.SUPABASE_URL,
    anonKey: key,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  }, request.headers)) return response;

  const supabase = createServerClient(url, key, {
    cookieOptions: authCookieOptions(process.env.VERCEL_ENV),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values, headers) {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        const previousHeaders = new Headers(response.headers);
        const previousCookies = response.cookies.getAll();
        response = preventSharedSessionCaching(NextResponse.next({ request }));
        previousHeaders.forEach((value, name) => {
          if (name.toLowerCase() !== "set-cookie" && !name.toLowerCase().startsWith("x-middleware-")) {
            response.headers.set(name, value);
          }
        });
        previousCookies.forEach((cookie) => response.cookies.set(cookie));
        values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([name, value]) => response.headers.set(name, value));
      },
    },
  });

  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
