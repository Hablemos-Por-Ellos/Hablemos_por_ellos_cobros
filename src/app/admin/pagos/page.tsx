import { AdminPageView } from "@/components/admin/admin-page-view";

export const metadata = {
  title: "Pagos | Hablemos por Ellos",
};

export default function PaymentsPage() {
  return <AdminPageView initialView="payments" />;
}
