import { AdminLogin } from "@/components/admin/admin-login";
import { getAdminActivationContext } from "@/lib/admin-auth-invitation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activar acceso | Hablemos por Ellos", referrer: "no-referrer" };

export default async function AdminActivatePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const query = await searchParams;
  const admin = query.error ? null : await getAdminActivationContext();
  return <AdminLogin activation authEnabled={!!admin} deploymentEnvironment={process.env.VERCEL_ENV ?? "local"} />;
}
