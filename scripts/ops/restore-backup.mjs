import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decryptBackupBuffer, fileSha256 } from "./backup-crypto.mjs";
import { compareManifests, databaseManifest, quoteIdentifier } from "./database-manifest.mjs";
import { parseArguments, postgresClient, privateConfig, safeOpsFailure } from "./private-config.mjs";
import { restoreArchive } from "./restore-archive.mjs";
import { reparseCheckDefinitions, restoreSchemaPermissions } from "./restore-metadata.mjs";
import { assertLocalLab } from "./local-docker-stream.mjs";

export async function restoreBackup(args) {
  if (!args.backup) throw new Error("EXPLICIT_LAB_TARGET_REQUIRED");
  assertLocalLab(args.container);
  if (!args['lab-url']) throw new Error("LOCAL_LAB_URL_REQUIRED");
  if (args['restore-role'] && args['restore-role'] !== "postgres") throw new Error("UNAPPROVED_LOCAL_RESTORE_ROLE");
  const labUrl = new URL(args['lab-url']);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(labUrl.hostname)) throw new Error("RESTORE_ONLY_PERMITTED_LOCALLY");
  if (args.container === "hpe-retry-v040-local" && !/^hpe_restore_retry040\d+$/.test(labUrl.pathname.slice(1))) {
    throw new Error("EXPLICIT_EMPTY_RETRY_RESTORE_DATABASE_REQUIRED");
  }
  const directory = path.resolve(args.backup);
  const metadata = JSON.parse(await fs.promises.readFile(path.join(directory, "verification.json"), "utf8"));
  for (const [name, key] of [["database.hpebk", "dumpEncryptedSha256"], ["manifest.hpebk", "manifestEncryptedSha256"]]) {
    if (await fileSha256(path.join(directory, name)) !== metadata[key]) throw new Error("ENCRYPTED_FILE_HASH_MISMATCH");
  }
  const { passphrase } = privateConfig(args.env);
  const dump = await decryptBackupBuffer(path.join(directory, "database.hpebk"), passphrase);
  const manifest = JSON.parse((await decryptBackupBuffer(path.join(directory, "manifest.hpebk"), passphrase)).toString("utf8"));
  if (crypto.createHash("sha256").update(dump).digest("hex") !== manifest.dumpSha256) throw new Error("DUMP_CONTENT_HASH_MISMATCH");
  const client = postgresClient(labUrl, { readOnly: false, labContainer: args.container });
  await client.connect();
  try {
    const operator = (await client.query("select current_user as name,rolsuper from pg_roles where rolname=current_user")).rows[0];
    if (!operator.rolsuper) throw new Error("LOCAL_RESTORE_SUPERUSER_REQUIRED");
    const operatorRole = (await client.query(`select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls
      from pg_roles where rolname=current_user`)).rows[0];
    const localOperator = manifest.roles.some((role) => role.rolname === operator.name) ? null : operatorRole;
    const offlineNoLoginRoles = [];
    const count = Number((await client.query("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname !~ '^pg_' and n.nspname<>'information_schema'")).rows[0].count);
    if (count !== 0) throw new Error("RESTORE_REQUIRES_EMPTY_NEW_DATABASE");
    for (const role of manifest.roles) {
      if (role.rolname === "postgres" || role.rolname === operator.name || role.rolname.startsWith("pg_")) continue;
      const exists = await client.query("select 1 from pg_roles where rolname=$1", [role.rolname]);
      if (!exists.rowCount) {
        await client.query(`create role ${quoteIdentifier(role.rolname)} nologin ${role.rolsuper ? "superuser" : "nosuperuser"}
          ${role.rolinherit ? "inherit" : "noinherit"} ${role.rolcreaterole ? "createrole" : "nocreaterole"}
          ${role.rolcreatedb ? "createdb" : "nocreatedb"} ${role.rolreplication ? "replication" : "noreplication"}
          ${role.rolbypassrls ? "bypassrls" : "nobypassrls"}`);
        offlineNoLoginRoles.push(role.rolname);
      }
    }
    for (const membership of manifest.memberships ?? []) {
      const existing = await client.query("select m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member where r.rolname=$1 and u.rolname=$2", [membership.role, membership.member]);
      if (!existing.rowCount || ["admin_option", "inherit_option", "set_option"].some((key) => existing.rows[0][key] !== membership[key])) {
        await client.query(`grant ${quoteIdentifier(membership.role)} to ${quoteIdentifier(membership.member)} with admin ${Boolean(membership.admin_option)}, inherit ${Boolean(membership.inherit_option)}, set ${Boolean(membership.set_option)}`);
      }
    }
    const restoreEvidence = await restoreArchive({ container: args.container, dump, manifest, client,
      database: labUrl.pathname.slice(1), operator: operator.name, password: decodeURIComponent(labUrl.password),
      postgresPassword: args['lab-postgres-password'] });
    const schemaPermissionsRestored = await restoreSchemaPermissions(client, manifest);
    const canonicalExpected = await reparseCheckDefinitions(client, manifest);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const actual = await databaseManifest(client, { original: manifest });
    await client.query("COMMIT");
    const canonicalActual = await reparseCheckDefinitions(client, actual);
    // Legacy archives remain restorable but cannot certify complete ACL coverage.
    if (manifest.format < 5 && !Array.isArray(manifest.columnPermissions)) delete canonicalActual.manifest.columnPermissions;
    const differences = compareManifests(canonicalExpected.manifest, canonicalActual.manifest, { compareMetadata: true, offlineNoLoginRoles, localOperator });
    if (differences.length) {
      const recordDifferences = differences.filter((entry) => !entry.section).length;
      console.error(JSON.stringify({ operation: "local_restore_comparison", recordDifferences,
        metadataSections: differences.filter((entry) => entry.section).map((entry) => entry.section), productionChanged: false }));
      throw new Error(recordDifferences ? "RESTORED_RECORD_CONTENT_MISMATCH" : "RESTORED_METADATA_NOT_VERIFIED");
    }
    const verified = { ...metadata, restorationVerified: true, restorationVerifiedAt: new Date().toISOString(),
      originalColumnsCompared: true,
      schemaAndPermissionsCompared: manifest.format >= 5 && Array.isArray(manifest.columnPermissions),
      columnPermissionsCompared: manifest.format >= 5 && Array.isArray(manifest.columnPermissions),
      differences: 0, productionChanged: false,
      offlineRoleOverrides: "New copied roles cannot log in; original superuser attributes retained for triggers; no passwords copied",
      localOnlyOperator: operator.name, ...restoreEvidence };
    verified.manifestCoverage = manifest.format;
    verified.offlineNoLoginRoles = offlineNoLoginRoles;
    verified.schemaPermissionsRestored = schemaPermissionsRestored;
    verified.checkComparison = { method: "PostgreSQL reparse of both CHECK definitions in temporary tables",
      originalDefinitionsPreserved: true, sourceRenderingsChanged: canonicalExpected.changed,
      restoredRenderingsChanged: canonicalActual.changed };
    await fs.promises.writeFile(path.join(directory, "verification.json"), JSON.stringify(verified, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ operation: "local_restoration_verified", directory, ...verified }));
    return verified;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  restoreBackup(parseArguments()).catch((error) => { console.error(JSON.stringify(safeOpsFailure("restore", error))); process.exitCode = 1; });
}
