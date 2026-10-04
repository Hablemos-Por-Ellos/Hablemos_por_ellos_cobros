import { redirect } from "next/navigation";
import { AdminLogin } from "@/components/admin/admin-login";
import { getAdminContext, isAdminDemoMode, isAdminSchemaReady } from "@/lib/admin-auth";

export const metadata = { title: "Ingreso administrativo | Hablemos por Ellos" };

export default async function AdminLoginPage() {
  const context = await getAdminContext();
  if (context) redirect("/admin");
  return <AdminLogin authEnabled={!isAdminDemoMode() && await isAdminSchemaReady()} deploymentEnvironment={process.env.VERCEL_ENV ?? "local"} />;
}
