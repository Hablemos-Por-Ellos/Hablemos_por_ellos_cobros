import type { AuthMFAEnrollTOTPResponse, Factor, GoTrueMFAApi, MFAEnrollTOTPParams } from "@supabase/supabase-js";

const friendlyName = "Hablemos por Ellos";
const ownEnrollmentName = /^Hablemos por Ellos \([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\)$/;
type EnrollmentMfa = Pick<GoTrueMFAApi, "listFactors" | "unenroll"> & {
  enroll(parameters: MFAEnrollTOTPParams): Promise<AuthMFAEnrollTOTPResponse>;
};
type AdminTotp = { stage: "verify"; factorId: string }
  | { stage: "enroll"; factorId: string; qrCode: string; secret: string };

function isOwnPendingTotp(factor: Factor) {
  return factor.factor_type === "totp" && factor.status === "unverified"
    && (factor.friendly_name === friendlyName || ownEnrollmentName.test(factor.friendly_name ?? ""));
}

// Caller must complete the allowlist bootstrap before invoking this onboarding flow.
export async function prepareAdminTotp(mfa: EnrollmentMfa): Promise<AdminTotp> {
  const { data: factors, error } = await mfa.listFactors();
  if (error || !factors) throw new Error("MFA_FACTORS_UNAVAILABLE");
  const verified = factors.totp.find((factor) => factor.status === "verified");
  if (verified) return { stage: "verify", factorId: verified.id };

  // The SDK's .totp list is verified-only; interrupted enrollments live in .all.
  for (const factor of factors.all.filter(isOwnPendingTotp)) {
    const { data, error: cleanupError } = await mfa.unenroll({ factorId: factor.id });
    if (cleanupError || data?.id !== factor.id) throw new Error("MFA_CLEANUP_FAILED");
  }

  const { data: enrollment, error: enrollmentError } = await mfa.enroll({
    factorType: "totp",
    friendlyName: `${friendlyName} (${crypto.randomUUID()})`,
    issuer: "Fundacion Hablemos por Ellos",
  });
  if (enrollmentError || !enrollment || enrollment.type !== "totp"
    || !enrollment.id || !enrollment.totp.qr_code || !enrollment.totp.secret) {
    throw new Error("MFA_ENROLLMENT_FAILED");
  }
  return {
    stage: "enroll", factorId: enrollment.id,
    qrCode: enrollment.totp.qr_code, secret: enrollment.totp.secret,
  };
}
