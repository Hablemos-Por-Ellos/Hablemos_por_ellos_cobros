import { createClient } from "@supabase/supabase-js";
import { getAppOperationMode, isSafeSupabaseUrl } from "@/lib/operation-mode";

export function getServiceSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey || getAppOperationMode() === "demo" || !isSafeSupabaseUrl(url)) {
    return null;
  }

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
    },
  });
}
