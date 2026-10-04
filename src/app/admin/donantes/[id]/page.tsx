import { AdminPageView } from "@/components/admin/admin-page-view";

export const metadata = {
  title: "Detalle de donante | Hablemos por Ellos",
};

export default async function DonorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ subscription?: string | string[] }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const subscriptionId = typeof query.subscription === "string" ? query.subscription : undefined;
  return <AdminPageView initialView="donors" donorId={id} subscriptionId={subscriptionId} />;
}
