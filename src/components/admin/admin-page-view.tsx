import { AdminConsole } from "@/components/admin/admin-console";
import { requireAdminPage } from "@/lib/admin-auth";
import { loadAdminData } from "@/lib/admin-data";
import { financialOperationsEnabled } from "@/lib/operation-mode";
import { BuildIdentity } from "@/components/build-identity";

export async function AdminPageView({
  initialView,
  donorId,
  subscriptionId,
}: {
  initialView: "dashboard" | "donors" | "subscriptions" | "payments";
  donorId?: string;
  subscriptionId?: string;
}) {
  const admin = await requireAdminPage();
  let data;
  try { data = await loadAdminData(donorId); } catch {
    return <main className="mx-auto max-w-3xl p-6"><h1 className="text-xl font-bold">Panel no disponible</h1><p role="alert" className="mt-3 text-sm">No se pudo verificar la sesion o cargar los datos. No se aplicaron cambios.</p><footer className="mt-6"><BuildIdentity /></footer></main>;
  }
  return (
    <AdminConsole
      key={`${admin.userId}:${admin.demo ? "demo" : "real"}`}
      initialView={initialView}
      donorId={donorId}
      subscriptionId={subscriptionId}
      initialData={data}
      demo={admin.demo}
      adminEmail={admin.email}
      readOnly={!admin.demo && !financialOperationsEnabled()}
    />
  );
}
