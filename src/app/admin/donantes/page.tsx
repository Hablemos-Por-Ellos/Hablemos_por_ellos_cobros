import { AdminPageView } from "@/components/admin/admin-page-view";

export const metadata = {
  title: "Donantes | Hablemos por Ellos",
};

export default function DonorsPage() {
  return <AdminPageView initialView="donors" />;
}
