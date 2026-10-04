import { NextResponse } from "next/server";
import { getAdminBootstrapContext, isAdminDemoMode, isSameOriginRequest } from "@/lib/admin-auth";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ authorized: false }, { status: 403 });
  if (isAdminDemoMode()) return NextResponse.json({ authorized: false }, { status: 403 });
  const admin = await getAdminBootstrapContext();
  return admin
    ? NextResponse.json({ authorized: true })
    : NextResponse.json({ authorized: false }, { status: 403 });
}
