import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function isBypassedPath(pathname: string) {
  if (pathname.startsWith("/api")) return true;
  if (pathname.startsWith("/_next")) return true;
  if (pathname === "/favicon.ico") return true;
  if (pathname === "/robots.txt") return true;
  if (pathname === "/sitemap.xml") return true;
  return false;
}

export function middleware(req: NextRequest) {
  if (process.env.MAINTENANCE_MODE !== "true") {
    return NextResponse.next();
  }

  if (isBypassedPath(req.nextUrl.pathname)) {
    return NextResponse.next();
  }

  return new NextResponse("Sitio en mantenimiento", {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": "3600",
    },
  });
}

