import crypto from "node:crypto";
import { z } from "zod";
import { getAdminBootstrapContext, isAdminSchemaReady } from "@/lib/admin-auth";
import { getServerAuthSupabaseClient } from "@/lib/supabase-auth-server";
import { getServiceSupabaseClient } from "@/lib/supabase-server";

const invitationSchema = z.object({
  user_id: z.string().uuid(), recipient_email: z.string().email(),
  issued_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }),
  consumed_at: z.string().datetime({ offset: true }).nullable(),
});

function inWindow(invite: z.infer<typeof invitationSchema>) {
  const issued = Date.parse(invite.issued_at);
  const expires = Date.parse(invite.expires_at);
  return issued <= Date.now() && expires > Date.now() && expires > issued && expires - issued <= 3600000;
}

export async function activateAdminInvitation(tokenHash: string) {
  if (!/^(?:[a-f0-9]{56}|[a-f0-9]{64})$/i.test(tokenHash)) return false;
  if (!(await isAdminSchemaReady())) return false;
  const auth = await getServerAuthSupabaseClient();
  const service = getServiceSupabaseClient();
  if (!auth || !service) return false;
  const digest = crypto.createHash("sha256").update(tokenHash).digest("hex");
  const { data, error } = await service.from("admin_invitations")
    .select("user_id, recipient_email, issued_at, expires_at, consumed_at")
    .eq("token_hash_digest", digest).maybeSingle();
  const invite = invitationSchema.safeParse(data);
  if (error || !invite.success || invite.data.consumed_at || !inWindow(invite.data)) return false;
  const { data: verified, error: otpError } = await auth.auth.verifyOtp({ token_hash: tokenHash, type: "invite" });
  if (otpError || !verified.user) return false;
  const admin = await getAdminBootstrapContext();
  if (!admin || admin.user.id !== invite.data.user_id
    || admin.user.email?.toLowerCase() !== invite.data.recipient_email.toLowerCase()
    || admin.claims.aal !== "aal1" || !z.string().uuid().safeParse(admin.claims.session_id).success) {
    await auth.auth.signOut({ scope: "local" });
    return false;
  }
  // SQL must atomically check the recipient, expiry and one-use constraint.
  const { data: consumed, error: consumeError } = await service.rpc("admin_consume_invitation", {
    p_token_hash_digest: digest, p_user_id: admin.user.id, p_session_id: admin.claims.session_id,
  });
  if (consumeError || consumed !== true) {
    await auth.auth.signOut({ scope: "local" });
    return false;
  }
  return true;
}

export async function getAdminActivationContext() {
  const admin = await getAdminBootstrapContext();
  if (!admin || admin.claims.aal !== "aal1" || !z.string().uuid().safeParse(admin.claims.session_id).success) return null;
  const service = getServiceSupabaseClient();
  if (!service) return null;
  const { data, error } = await service.from("admin_invitations")
    .select("user_id, recipient_email, issued_at, expires_at, consumed_at")
    .eq("user_id", admin.user.id).eq("consumed_session_id", admin.claims.session_id).maybeSingle();
  const invite = invitationSchema.safeParse(data);
  return !error && invite.success && invite.data.consumed_at && inWindow(invite.data) ? admin : null;
}
