type AuthEnvironment = {
  operationMode: string;
  deploymentEnvironment?: string;
  supabaseUrl?: string;
  serviceUrl?: string;
  anonKey?: string;
  serviceKey?: string;
};

type HostHeaders = { get(name: string): string | null };

export function authCookieOptions(deploymentEnvironment?: string) {
  return { path: "/", sameSite: "lax" as const, secure: deploymentEnvironment === "production" };
}

function parseProjectUrl(value?: string) {
  // Check the raw shape too: URL parsing normalizes paths and empty query markers.
  if (!value || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password || url.search || url.hash || url.pathname !== "/"
      ? null : url;
  } catch { return null; }
}

function isRemoteRequestHost(value: string | null) {
  if (!value || /[\s\\/?#@,]/.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return !!hostname && hostname !== "localhost" && !hostname.endsWith(".localhost")
      && !hostname.startsWith("127.")
      && !["0.0.0.0", "[::]", "[::1]"].includes(hostname)
      && !hostname.startsWith("[::ffff:7f") && hostname !== "[::ffff:0:0]";
  } catch { return false; }
}

export function isAuthEnvironmentAllowed(environment: AuthEnvironment, requestHeaders?: HostHeaders) {
  if (environment.operationMode === "demo" || !environment.anonKey?.trim()
    || !environment.serviceKey?.trim()) return false;
  const target = parseProjectUrl(environment.supabaseUrl);
  const serviceTarget = parseProjectUrl(environment.serviceUrl);
  if (!target || !serviceTarget || target.origin !== serviceTarget.origin) return false;

  const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (local) return environment.deploymentEnvironment !== "production";
  if (target.protocol !== "https:" || environment.deploymentEnvironment !== "production"
    || !requestHeaders || !isRemoteRequestHost(requestHeaders.get("host"))) return false;
  const forwardedHost = requestHeaders.get("x-forwarded-host");
  return forwardedHost === null || isRemoteRequestHost(forwardedHost);
}
