import { AdminPageView } from "@/components/admin/admin-page-view";

export const metadata = {
  title: "Suscripciones | Hablemos por Ellos",
};

export default function SubscriptionsPage() {
  return <AdminPageView initialView="subscriptions" />;
}
