// ESCRITURA LOCAL: operational v0.4.0 entry point against a fictional old-schema fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { applyBillingRetryMigration } from "../ops/apply-billing-retry-migration.mjs";
import { postgresClient } from "../ops/private-config.mjs";

const container = "hpe-retry-v040-local";
const database = process.argv.find((arg) => arg.startsWith("--database="))?.slice(11);
assert.ok(process.argv.includes("--local-retry-lab=yes") && /^hpe_retry_lab_\d+_before$/.test(database), "EXPLICIT_FICTIONAL_BASELINE_REQUIRED");
const url = new URL(`postgresql://postgres@127.0.0.1/${database}`);
const check = postgresClient(url, { labContainer: container });
await check.connect();
try {
  assert.equal((await check.query("select count(*)::int as n from public.donors where email='legacy@example.test'")).rows[0].n, 1);
  assert.equal((await check.query("select count(*)::int as n from public.payment_admin_migrations where name='billing-retry-v0.4.0'")).rows[0].n, 0);
} finally { await check.end(); }
const results = [];
await applyBillingRetryMigration({ target: "local", "lab-container": container }, {
  loadConfig: () => ({ config: {}, url, passphrase: "not-used-for-local-fixture" }),
  report: { log: (value) => results.push(JSON.parse(value)), error: (value) => { results.push(JSON.parse(value)); console.error(value); } },
});
assert.equal(results[0].verified, true);
assert.equal(results[0].keepCutover, true);
const sql = "begin read only; select public.billing_retry_schema_ready(); commit;";
const output = execFileSync("docker", ["exec", container, "psql", "-X", "-U", "postgres", "-d", database, "-Atc", sql], { encoding: "utf8", windowsHide: true });
assert.match(output, /\bt\b/);
console.log(JSON.stringify({ version: "0.4.0", localOnly: true, database, operationalEntryPoint: "passed", financialOperations: "not_enabled" }));
