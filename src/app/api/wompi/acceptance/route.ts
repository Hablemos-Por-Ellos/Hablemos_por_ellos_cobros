import { NextResponse } from "next/server";
import { getWompiAcceptance } from "@/lib/wompi-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getWompiAcceptance());
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "No se pudieron obtener los terminos de Wompi." },
      { status: 500 }
    );
  }
}
