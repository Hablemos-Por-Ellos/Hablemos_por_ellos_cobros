import { getServiceSupabaseClient } from "@/lib/supabase-server";

type Client = NonNullable<ReturnType<typeof getServiceSupabaseClient>>;

export async function paymentSchemaReady(client: Client) {
  const { data, error } = await client.rpc("payment_admin_schema_ready");
  return !error && data === true;
}
