import { AdminPageView } from "@/components/admin/admin-page-view";

export const metadata = {
  title: "Administración | Hablemos por Ellos",
};

export default function AdminPage() {
  return <AdminPageView initialView="dashboard" />;
}
