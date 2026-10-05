import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decryptBackupBuffer, fileSha256 } from "./backup-crypto.mjs";
import { compareManifests, databaseManifest, MANIFEST_METADATA_SECTIONS, quoteIdentifier } from "./database-manifest.mjs";
import { assertExpectedProductionProject, connectionFingerprint, parseArguments, postgresClient, privateConfig } from "./private-config.mjs";
import { closeMigrationConnection, migrationWriterIdentity, observePaymentMigration, PAYMENT_MIGRATION } from "./migration-recovery.mjs";

// v0.3.0 | 2026-10-04. Verify the final backup under the same locks as the migration.
const MIGRATION = PAYMENT_MIGRATION;
const MIGRATION_TABLES = ["donors", "subscriptions", "payments", "webhook_events", "audit_logs",
  "admin_users", "admin_invitations", "admin_audit_logs", "checkout_intents", "payment_attempts",
  "api_rate_limits", "payment_admin_migrations"];
export function migrationTransactionBody(sql) {
  // Only the versioned files' outer transaction is removed; PL/pgSQL blocks stay intact.
  const match = sql.match(/^((?:\s|--[^\r\n]*(?:\r?\n|$))*)begin(?:\s+transaction\s+read\s+only)?\s*;([\s\S]*?)\bcommit\s*;\s*$/i);
  if (!match) throw new Error("EXPECTED_SQL_TRANSACTION_REQUIRED");
  return match[1] + match[2];
}

async function verifiedMigrationBackup(args, url, passphrase) {
    const directory = path.resolve(args.backup);
    const proof = JSON.parse(await fs.promises.readFile(path.join(directory, "verification.json"), "utf8"));
    if (!proof.restorationVerified || !proof.originalColumnsCompared || !proof.schemaAndPermissionsCompared
      || !proof.columnPermissionsCompared || proof.differences !== 0 || proof.manifestCoverage < 5
      || !Number.isInteger(proof.manifestCoverage)) throw new Error("RESTORATION_PROOF_REQUIRED");
    if (proof.sourceFingerprint !== connectionFingerprint(url)) throw new Error("BACKUP_WAS_CREATED_FROM_A_DIFFERENT_SOURCE");
    const age = Date.now() - Date.parse(proof.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > 4 * 60 * 60 * 1000) throw new Error("FRESH_FINAL_BACKUP_REQUIRED");
    if (await fileSha256(path.join(directory, "database.hpebk")) !== proof.dumpEncryptedSha256) throw new Error("BACKUP_HASH_MISMATCH");
    if (await fileSha256(path.join(directory, "manifest.hpebk")) !== proof.manifestEncryptedSha256) throw new Error("BACKUP_MANIFEST_HASH_MISMATCH");
    return JSON.parse((await decryptBackupBuffer(path.join(directory, "manifest.hpebk"), passphrase)).toString("utf8"));
}

export function assertCompleteMigrationManifest(manifest) {
  const sections = ["tables", "roles", "storage", ...MANIFEST_METADATA_SECTIONS];
  if (manifest?.format !== 5 || sections.some((section) => !Array.isArray(manifest[section]))
    || !manifest.tables.length) throw new Error("COMPLETE_BACKUP_MANIFEST_REQUIRED");
  const identities = new Set();
  for (const table of manifest.tables) {
    const identity = JSON.stringify([table.schema, table.name]);
    if (typeof table.schema !== "string" || !table.schema || typeof table.name !== "string" || !table.name
      || identities.has(identity) || !Array.isArray(table.columns) || !table.columns.length
      || table.columns.some((column) => typeof column !== "string" || !column)
      || !Array.isArray(table.keys) || table.keys.some((key) => !table.columns.includes(key))
      || !Array.isArray(table.rows) || table.count !== table.rows.length
      || table.rows.some((row) => !/^[0-9a-f]{64}$/.test(row.hash ?? ""))) {
      throw new Error("COMPLETE_BACKUP_MANIFEST_REQUIRED");
    }
    identities.add(identity);
  }
}

export async function lockMigrationTables(client) {
  const { rows } = await client.query(`select n.nspname as schema,c.relname as name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','p') and n.nspname='public' and c.relname=any($1::text[])
    order by n.nspname,c.relname`, [MIGRATION_TABLES]);
  if (!rows.length) throw new Error("MIGRATION_TABLE_INVENTORY_REQUIRED");
  if (rows.some(({ schema, name }) => schema !== "public" || !MIGRATION_TABLES.includes(name))) {
    throw new Error("MIGRATION_TABLE_INVENTORY_OUTSIDE_SCOPE");
  }
  // Provider-managed schemas remain fully compared, but this migration never writes them.
  const qualified = rows.map(({ schema, name }) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`);
  await client.query(`LOCK TABLE ${qualified.join(",")} IN ACCESS EXCLUSIVE MODE`);
}

export async function applyPaymentMigration(args, { loadConfig = privateConfig, createClient = postgresClient,
  readFile = fs.promises.readFile.bind(fs.promises), readManifest = databaseManifest,
  readBackup = verifiedMigrationBackup, report = console } = {}) {
  if (!["local", "production"].includes(args.target)) throw new Error("EXPLICIT_MIGRATION_TARGET_REQUIRED");
  const { config, url, passphrase } = loadConfig(args.env);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((args.target === "local") !== local) throw new Error("MIGRATION_TARGET_MISMATCH");
  let manifest;
  if (!local) {
    assertExpectedProductionProject(url, config);
    if (args['cutover-authorized'] !== "yes" || args['backup-confirmed-in-chat'] !== "yes" || !args.backup) {
      throw new Error("PRODUCTION_REQUIRES_CUTOVER_AUTHORIZATION_AND_CHAT_BACKUP_CONFIRMATION");
    }
    manifest = await readBackup(args, url, passphrase);
    assertCompleteMigrationManifest(manifest);
  }
  const sql = await readFile(path.resolve("supabase/migrations/202609190001_payment_and_admin_hardening.sql"), "utf8");
  const digest = crypto.createHash("sha256").update(sql).digest("hex");
  const body = migrationTransactionBody(sql);
  const preflight = migrationTransactionBody(await readFile("supabase/preflight/payment_admin_preflight.sql", "utf8"));
  const postflight = migrationTransactionBody(await readFile("supabase/postflight/payment_admin_postflight.sql", "utf8"));
  const clientOptions = { caFile: config.DATABASE_CA_CERT || ".env.backup-ca.local", labContainer: args['lab-container'] };
  const client = createClient(url, { ...clientOptions, readOnly: false });
  let writerIdentity;
  let protectedManifest = manifest;
  let failurePhase = "connect";
  let deadline;
  const ignoreConnectionError = () => {};
  client.on?.("error", ignoreConnectionError);
  try {
    await client.connect();
    writerIdentity = await migrationWriterIdentity(client);
    deadline = setTimeout(() => { void closeMigrationConnection(client); }, 300000);
    deadline.unref?.();
    const version = Number((await client.query("show server_version_num")).rows[0].server_version_num);
    if (version >= 170000) await client.query("set transaction_timeout='300s'");
    await client.query("set idle_in_transaction_session_timeout='60s'");
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    const { rows: [settings] } = await client.query("SHOW search_path");
    if (typeof settings?.search_path !== "string" || !settings.search_path) throw new Error("MIGRATION_SEARCH_PATH_REQUIRED");
    await client.query("select pg_advisory_xact_lock(hashtextextended('payment_admin_hardening_v0.3.0',0))");
    if (manifest) {
      failurePhase = "application_table_locks";
      await lockMigrationTables(client);
      failurePhase = "source_comparison";
      const before = await readManifest(client);
      if (compareManifests(manifest, before, { allowAdditionalReceipts: true, compareMetadata: true,
        compareInventory: true }).length) throw new Error("SOURCE_CHANGED_AFTER_FINAL_BACKUP");
      protectedManifest = before;
    }
    await client.query("select pg_catalog.set_config('search_path',$1,true)", [settings.search_path]);
    failurePhase = "preflight";
    await client.query(preflight);
    await client.query("select set_config('app.migration_digest',$1,true)", [digest]);
    failurePhase = "migration";
    await client.query({ text: body, query_timeout: 300000 });
    const marker = await client.query("select digest from public.payment_admin_migrations where name=$1", [MIGRATION]);
    if (marker.rows[0]?.digest !== digest) throw new Error("MIGRATION_MARKER_MISMATCH");
    failurePhase = "postflight";
    await client.query(postflight);
    if (protectedManifest) {
      failurePhase = "preservation_comparison";
      const after = await readManifest(client, { original: protectedManifest });
      if (compareManifests(protectedManifest, after).length) throw new Error("PRECOMMIT_PRESERVATION_FAILED_KEEP_CUTOVER");
    }
    failurePhase = "commit";
    await client.query("COMMIT");
    report.log(JSON.stringify({ operation: "migration_verified", code: "MIGRATION_VERIFIED", verified: true,
      originalRecordsPreserved: Boolean(manifest), keepCutover: true, automaticRetry: false }));
  } catch (error) {
    // Close the writer, never inspect or send more SQL on its failed connection.
    const writerConnectionClosed = await closeMigrationConnection(client);
    const recovery = await observePaymentMigration({
      createObserver: () => createClient(url, { ...clientOptions, readOnly: true }),
      failedClient: client, writerIdentity, expectedDatabase: decodeURIComponent(url.pathname.slice(1)),
      digest, originalManifest: protectedManifest,
    });
    const sqlState = /^[0-9A-Z]{5}$/.test(error?.code ?? "") ? error.code : undefined;
    report.error(JSON.stringify({ operation: "migration_stopped", verified: false, failurePhase,
      sqlState, writerConnectionClosed, ...recovery }));
    throw new Error("MIGRATION_STOPPED_NO_AUTOMATIC_RETRY");
  } finally {
    clearTimeout(deadline);
    await closeMigrationConnection(client);
    client.removeListener?.("error", ignoreConnectionError);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => applyPaymentMigration(parseArguments()))().catch(() => {
    console.error(JSON.stringify({ operation: "migration_stopped", code: "MIGRATION_STOPPED_NO_AUTOMATIC_RETRY",
      verified: false, keepCutover: true, automaticRetry: false }));
    process.exitCode = 1;
  });
}
