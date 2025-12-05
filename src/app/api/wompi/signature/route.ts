import { NextResponse } from "next/server";
import crypto from "crypto";
import { getWompiIntegritySecret, WOMPI_ENV } from "@/lib/wompi";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const amountInCents = body?.amountInCents;
  const currency = body?.currency;
  const reference = body?.reference;

  if (!amountInCents || !currency || !reference) {
    return NextResponse.json({ message: "Faltan parámetros" }, { status: 400 });
  }

  const integritySecret = getWompiIntegritySecret();
  if (!integritySecret) {
    const suffix = WOMPI_ENV === "prod" ? "PROD" : "SANDBOX";
    return NextResponse.json(
      { message: `Configura WOMPI_INTEGRITY_SECRET_${suffix} en el servidor` },
      { status: 500 }
    );
  }

  // Validate that the secret matches the selected environment (avoids mismatched hashes/403)
  const expectedPrefix = WOMPI_ENV === "prod" ? "prod_integrity_" : "test_integrity_";
  if (!integritySecret.startsWith(expectedPrefix)) {
    const label = WOMPI_ENV === "prod" ? "producción" : "sandbox";
    return NextResponse.json(
      { message: `El secreto de integridad de ${label} debe iniciar con ${expectedPrefix}` },
      { status: 500 }
    );
  }

  // Orden correcto según docs Wompi: referencia + monto + moneda + secreto
  const stringToSign = `${reference}${amountInCents}${currency}${integritySecret}`;

  const signature = crypto.createHash("sha256").update(stringToSign).digest("hex");

  return NextResponse.json({ signature });
}
