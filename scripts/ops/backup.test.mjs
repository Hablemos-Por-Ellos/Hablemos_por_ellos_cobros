// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptBackup, decryptBackup } from "./backup-crypto.mjs";
import { compareManifests, databaseManifest, quoteIdentifier } from "./database-manifest.mjs";
import { splitRestoreToc, isSuccessfulRestoreExit } from "./restore-archive.mjs";
import { withOriginalExtensionInstaller } from "./extension-installer.mjs";
import { isInsideRepository, assertExternalBackupOutput } from "./create-backup.mjs";
import { applyPaymentMigration } from "./apply-payment-migration.mjs";
import { restoreSchemaPermissions } from "./restore-metadata.mjs";

describe("private backup integrity", () => {
  it("authenticates encryption and refuses a wrong password", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hpe-crypto-"));
    const input = path.join(directory, "fixture");
    await fs.writeFile(input, "fictional fixture only");
    await encryptBackup(input, path.join(directory, "encrypted"), "fictional-password-for-test");
    await decryptBackup(path.join(directory, "encrypted"), path.join(directory, "restored"), "fictional-password-for-test");
    expect(await fs.readFile(path.join(directory, "restored"), "utf8")).toBe("fictional fixture only");
    await expect(decryptBackup(path.join(directory, "encrypted"), path.join(directory, "wrong"), "different-password-for-test")).rejects.toThrow();
    await expect(fs.stat(path.join(directory, "wrong"))).rejects.toThrow();
    await expect(decryptBackup(path.join(directory, "encrypted"), path.join(directory, "restored"), "fictional-password-for-test")).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, "restored"), "utf8")).toBe("fictional fixture only");
  });
  it("detects changed content even when IDs and counts match", () => {
    const before = { tables: [{ schema: "public", name: "donors", rows: [{ key: "1", hash: "old" }] }] };
    const after = { tables: [{ schema: "public", name: "donors", rows: [{ key: "1", hash: "new" }] }] };
    expect(compareManifests(before, after)).toHaveLength(1);
  });
  it("never allows loss of a webhook receipt", () => {
    const before = { tables: [{ schema: "public", name: "webhook_events", rows: [{ key: "1", hash: "old" }] }] };
    const after = { tables: [{ schema: "public", name: "webhook_events", rows: [] }] };
    expect(compareManifests(before, after, { allowAdditionalReceipts: true })).toHaveLength(1);
  });
  it("allows only durable v1 receipts added after the final snapshot", () => {
    const before = { tables: [{ schema: "public", name: "webhook_events", rows: [] }] };
    const actual = (receipt) => ({ tables: [{ schema: "public", name: "webhook_events", rows: [{ key: "new", hash: "abc", receipt }] }] });
    expect(compareManifests(before, actual(true), { allowAdditionalReceipts: true })).toEqual([]);
    expect(compareManifests(before, actual(false), { allowAdditionalReceipts: true })).toHaveLength(1);
  });
  it("rejects restored permission changes even when all records match", () => {
    const before = { tables: [], policies: [{ roles: ["service_role"] }] };
    const after = { tables: [], policies: [{ roles: ["anon"] }] };
    expect(compareManifests(before, after, { compareMetadata: true })).toEqual([{ section: "policies", kind: "metadata_difference" }]);
  });
  it("detects changed column ACLs even when table grants and records match", () => {
    const before = { tables: [],columnPermissions: [{ schema: "public",table_name: "donors",name: "email",acl: [] }] };
    const after = { ...before,columnPermissions: [{ ...before.columnPermissions[0],acl: [{ grantee: "anon",privilege: "SELECT" }] }] };
    expect(compareManifests(before, after, { compareMetadata: true })).toEqual([{ section: "columnPermissions",kind: "metadata_difference" }]);
  });
  it("includes column ACL coverage and guards empty ACL arrays", async () => {
    const queries = [];
    const manifest = await databaseManifest({ query: async (sql) => {
      queries.push(sql); return { rows: [],rowCount: 0 };
    } });
    expect(manifest.format).toBe(5);
    expect(manifest.columnPermissions).toEqual([]);
    expect(queries.some((sql) => sql.includes("a.attacl") && sql.includes("cardinality("))).toBe(true);
    expect(queries.some((sql) => sql.includes("when cardinality(c.relacl)>0 then c.relacl"))).toBe(true);
  });
  it("verifies schema ownership even when the schema ACL is empty", async () => {
    const queries = [];
    const client = { query: async (sql) => {
      queries.push(sql);
      return { rowCount: 1,rows: [{ owner: "postgres",grantee: null,grantor: null,privilege: null,grantable: null }] };
    } };
    expect(await restoreSchemaPermissions(client,{ schemas: [{ name: "fixture",owner: "postgres",acl: [] }] })).toBe(0);
    expect(queries[0]).toContain("left join lateral");
    expect(queries[0]).toContain("when cardinality(n.nspacl)>0 then n.nspacl");
    await expect(restoreSchemaPermissions(client,{ schemas: [{ name: "fixture",owner: "other",acl: [] }] })).rejects.toThrow("RESTORED_SCHEMA_OWNER_MISMATCH");
  });
  it("does not certify a missing schema through an empty ACL comparison", async () => {
    const client = { query: async () => ({ rowCount: 0,rows: [] }) };
    await expect(restoreSchemaPermissions(client,{ schemas: [{ name: "fixture",owner: "postgres",acl: [] }] })).rejects.toThrow("RESTORED_SCHEMA_OWNER_MISMATCH");
  });
  it.each([
    { manifestCoverage: 4 },
    { columnPermissionsCompared: false },
    { columnPermissionsCompared: undefined },
    { schemaAndPermissionsCompared: false },
    { restorationVerified: false },
    { differences: 1 },
  ])("refuses incomplete production restore proof: %j", async (override) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hpe-proof-"));
    await fs.writeFile(path.join(directory,"verification.json"),JSON.stringify({ restorationVerified: true,
      originalColumnsCompared: true,schemaAndPermissionsCompared: true,columnPermissionsCompared: true,
      differences: 0,manifestCoverage: 5,...override }));
    let connections = 0;
    await expect(applyPaymentMigration({ target: "production",backup: directory,
      "cutover-authorized": "yes","backup-confirmed-in-chat": "yes" },{
      loadConfig: () => ({ config: { EXPECTED_PROJECT_REF: "fixture" },
        url: new URL("postgresql://fixture:fixture-only@db.fixture.supabase.co/postgres"),passphrase: "fixture-only" }),
      createClient: () => { connections += 1; throw new Error("NO_CONNECTION_EXPECTED"); },
    })).rejects.toThrow("RESTORATION_PROOF_REQUIRED");
    expect(connections).toBe(0);
  });
  it.each(["", "copies", "..qa-backups"])("rejects repository descendants including dot prefixes: %s", (name) => {
    const repository = path.win32.resolve("D:/project");
    expect(isInsideRepository(repository,path.win32.join(repository,name),path.win32)).toBe(true);
  });
  it.each(["D:/Backups", "D:/project-sibling", "C:/PrivateBackups"])("allows genuine external Windows directories: %s", (output) => {
    expect(isInsideRepository("D:\\project",path.win32.resolve(output),path.win32)).toBe(false);
  });
  it("checks junction targets before creating a backup", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hpe-path-"));
    const repository = path.join(directory,"repository");
    const external = path.join(directory,"external");
    await fs.mkdir(repository);
    await fs.symlink(repository,external,process.platform === "win32" ? "junction" : "dir");
    expect(() => assertExternalBackupOutput(path.join(external,"copies"),repository)).toThrow("BACKUP_MUST_BE_OUTSIDE_REPOSITORY");
  });
  it("quotes identifiers without interpolating executable SQL", () => {
    expect(quoteIdentifier('table"name')).toBe('"table""name"');
  });
  it("defers only the exact non-superuser event trigger and its own metadata", () => {
    const toc = "10; 0 0 EVENT TRIGGER - ensure_rls postgres\n11; 0 0 COMMENT - EVENT TRIGGER ensure_rls postgres\n12; 0 0 TABLE DATA public donors postgres\n13; 0 0 EVENT TRIGGER - issue_pg_cron_access supabase_admin\n";
    const lists = splitRestoreToc(toc);
    expect(lists.ids).toEqual([10, 11]);
    expect(lists.regular).toContain("12; 0 0 TABLE DATA public donors postgres");
    expect(lists.regular).toContain("13; 0 0 EVENT TRIGGER - issue_pg_cron_access supabase_admin");
    expect(lists.deferred).toContain("; 12; 0 0 TABLE DATA public donors postgres");
  });
  it("restores schemas before extensions and keeps original extension owners", () => {
    const toc = "1; 1 1 SCHEMA - extensions postgres\n2; 1 2 EXTENSION - pg_stat_statements \n3; 1 3 EXTENSION - supabase_vault \n4; 0 0 TABLE DATA public donors postgres\n";
    const phases = splitRestoreToc(toc, [{ extname: "pg_stat_statements", owner: "postgres" }, { extname: "supabase_vault", owner: "supabase_admin" }]);
    expect(phases.extensionGroups.map(({ owner }) => owner)).toEqual(["postgres", "supabase_admin"]);
    expect(phases.regular).toContain("; 1; 1 1 SCHEMA - extensions postgres");
    expect(phases.schemas).toContain("; 4; 0 0 TABLE DATA public donors postgres");
    expect(phases.extensionGroups[0].list).toContain("; 3; 1 3 EXTENSION - supabase_vault");
    expect(() => splitRestoreToc(toc, [{ extname: "pg_stat_statements" }])).toThrow("BACKUP_EXTENSION_OWNER_METADATA_REQUIRED");
  });
  it("detects changed extension ownership and default privileges", () => {
    const before = { tables: [], extensions: [{ extname: "pgcrypto", owner: "postgres" }], defaultPrivileges: [{ owner: "postgres", acl: [] }] };
    const after = { tables: [], extensions: [{ extname: "pgcrypto", owner: "supabase_admin" }], defaultPrivileges: [{ owner: "postgres", acl: ["anon"] }] };
    expect(compareManifests(before, after, { compareMetadata: true }).map(({ section }) => section)).toEqual(["extensions", "defaultPrivileges"]);
  });
  it("revokes offline installer privileges and restores configuration even on failure", async () => {
    let setting = "pgcrypto,uuid-ossp";
    let superuser = false;
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql);
      if (sql.startsWith("select current_database")) return { rows: [{ database: "hpe_restore_fixture", operator: "hpe_lab_operator", superuser: true }] };
      if (sql.startsWith("select rolsuper")) return { rows: [{ rolsuper: superuser }] };
      if (sql.startsWith("select setting,context")) return { rows: [{ setting, context: "sighup", source: "configuration file", sourcefile: "/etc/supautils.conf" }] };
      if (sql.startsWith("select current_setting")) return { rows: [{ setting }] };
      if (sql === "alter role postgres superuser") superuser = true;
      if (sql === "alter role postgres nosuperuser") superuser = false;
      if (sql.startsWith("alter system set")) setting = "";
      if (sql.startsWith("alter system reset")) setting = "pgcrypto,uuid-ossp";
      return { rows: [] };
    } };
    await expect(withOriginalExtensionInstaller(client, async () => { throw new Error("fixture installer failed"); })).rejects.toThrow("fixture installer failed");
    expect(superuser).toBe(false);
    expect(setting).toBe("pgcrypto,uuid-ossp");
    expect(calls.at(-1)).toContain("pg_advisory_unlock");
  });
  it("refuses installer configuration on a production-shaped database", async () => {
    const calls = [];
    const client = { query: async (sql) => { calls.push(sql); return { rows: [{ database: "postgres", operator: "postgres", superuser: true }] }; } };
    await expect(withOriginalExtensionInstaller(client, async () => {})).rejects.toThrow("EXPLICIT_OFFLINE_INSTALLER_REQUIRED");
    expect(calls).toHaveLength(1);
  });
  it("rejects unexpected roles and LOGIN changes, with only explicit offline overrides", () => {
    const role = { rolname: "admin", rolsuper: false, rolcanlogin: true };
    const expected = { tables: [], roles: [role] };
    expect(compareManifests(expected, { tables: [], roles: [role, { rolname: "unexpected", rolsuper: true }] }, { compareMetadata: true })).toContainEqual({ section: "roles", kind: "metadata_difference" });
    const copied = { tables: [], roles: [{ ...role, rolcanlogin: false }] };
    expect(compareManifests(expected, copied, { compareMetadata: true })).toHaveLength(1);
    expect(compareManifests(expected, copied, { compareMetadata: true, offlineNoLoginRoles: ["admin"] })).toEqual([]);
    expect(compareManifests(expected, expected, { compareMetadata: true, offlineNoLoginRoles: ["admin"] })).toHaveLength(1);
    const operator = { rolname: "hpe_lab_operator", rolsuper: true, rolcanlogin: true };
    expect(compareManifests(expected, { tables: [], roles: [role, operator] }, { compareMetadata: true, localOperator: operator })).toEqual([]);
  });
  it("does not accept a signalled pg_restore as successful", () => {
    expect(isSuccessfulRestoreExit(0, null)).toBe(true);
    expect(isSuccessfulRestoreExit(null, "SIGTERM")).toBe(false);
    expect(isSuccessfulRestoreExit(1, null)).toBe(false);
  });
  it.each(["role", "configuration"])("cleans up %s after SQL applies but the response is lost", async (failure) => {
    let setting = "pgcrypto";
    let superuser = false;
    let injected = false;
    let installed = false;
    const client = { query: async (sql) => {
      if (sql.startsWith("select current_database")) return { rows: [{ database: "hpe_restore_fixture", operator: "hpe_lab_operator", superuser: true }] };
      if (sql.startsWith("select rolsuper")) return { rows: [{ rolsuper: superuser }] };
      if (sql.startsWith("select setting,context")) return { rows: [{ setting, context: "sighup", source: "configuration file", sourcefile: "/etc/supautils.conf" }] };
      if (sql.startsWith("select current_setting")) return { rows: [{ setting }] };
      if (sql === "alter role postgres superuser") {
        superuser = true;
        if (failure === "role" && !injected) { injected = true; throw new Error("fixture lost response"); }
      }
      if (sql === "alter role postgres nosuperuser") superuser = false;
      if (sql.startsWith("alter system set")) {
        setting = "";
        if (failure === "configuration" && !injected) { injected = true; throw new Error("fixture lost response"); }
      }
      if (sql.startsWith("alter system reset")) setting = "pgcrypto";
      return { rows: [] };
    } };
    await expect(withOriginalExtensionInstaller(client, async () => { installed = true; })).rejects.toThrow("fixture lost response");
    expect(superuser).toBe(false);
    expect(setting).toBe("pgcrypto");
    expect(installed).toBe(false);
  });
});
