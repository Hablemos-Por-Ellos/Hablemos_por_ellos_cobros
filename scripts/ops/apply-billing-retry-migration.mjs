// v0.4.0 | ESCRITURA: guarded entry point, never an automatic production cutover.
import { pathToFileURL } from "node:url";
import { applyVersionedPaymentMigration } from "./apply-payment-migration.mjs";
import { BILLING_RETRY_MIGRATION } from "./migration-recovery.mjs";
import { parseArguments } from "./private-config.mjs";

export const BILLING_RETRY_MIGRATION_SPEC = Object.freeze({ name: BILLING_RETRY_MIGRATION,
  sql: "supabase/migrations/202610080001_billing_retry_cycles.sql",
  preflight: "supabase/preflight/billing_retry_preflight.sql",
  postflight: "supabase/postflight/billing_retry_postflight.sql",
  lock: BILLING_RETRY_MIGRATION, digestSetting: "app.billing_retry_migration_digest" });

export async function applyBillingRetryMigration(args, dependencies = {}) {
  return applyVersionedPaymentMigration(args, { ...dependencies, migration: BILLING_RETRY_MIGRATION_SPEC });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyBillingRetryMigration(parseArguments()).catch(() => {
    console.error(JSON.stringify({ operation: "billing_retry_migration_stopped", code: "MIGRATION_STOPPED_NO_AUTOMATIC_RETRY",
      verified: false, keepCutover: true, automaticRetry: false }));
    process.exitCode = 1;
  });
}
