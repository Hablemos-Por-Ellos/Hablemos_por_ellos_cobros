import { NextResponse } from "next/server";
import { getWompiAcceptance } from "@/lib/wompi-server";
import { financialOperationsEnabled } from "@/lib/operation-mode";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!financialOperationsEnabled()) return NextResponse.json({ message: "Pagos temporalmente en mantenimiento." }, { status: 503 });
  try {
    const acceptance = await getWompiAcceptance();
    return NextResponse.json({
      acceptancePermalink: acceptance.acceptancePermalink,
      personalDataAuthPermalink: acceptance.personalDataAuthPermalink,
    });
  } catch {
    return NextResponse.json(
      { message: "No se pudieron obtener los terminos de Wompi." },
      { status: 502 }
    );
  }
}
