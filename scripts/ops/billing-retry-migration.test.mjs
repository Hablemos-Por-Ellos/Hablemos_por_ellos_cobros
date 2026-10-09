// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { applyBillingRetryMigration, BILLING_RETRY_MIGRATION_SPEC } from "./apply-billing-retry-migration.mjs";
import { BILLING_RETRY_MIGRATION, migrationPreservationManifest, observePaymentMigration } from "./migration-recovery.mjs";
import { compareManifests } from "./database-manifest.mjs";

describe("v0.4.0 migration operational boundary", () => {
  it.each([{}, { target: "production" }, { target: "production", "cutover-authorized": "yes" },
    { target: "production", "cutover-authorized": "yes", "backup-confirmed-in-chat": "yes" }])("rejects incomplete authorization before private config %j", async (args) => {
    const loadConfig = vi.fn();
    await expect(applyBillingRetryMigration(args, { loadConfig })).rejects.toThrow();
    expect(loadConfig).not.toHaveBeenCalled();
  });
  it("selects ONLY new SQL, its new marker and new postflight, with one COMMIT", async () => {
    const sql = "begin;\nselect 'fixture-billing-v040';\ncommit;";
    const digest = createHash("sha256").update(sql).digest("hex");
    const reads = [];
    const calls = [];
    const client = new EventEmitter();
    client.connect = vi.fn(); client.end = vi.fn();
    client.query = vi.fn(async (input, values) => {
      const text = typeof input === "string" ? input : input.text;
      calls.push({ text, values });
      if (text.includes("backend_start::text")) return { rows: [{ pid: 44, backend_start: "2026-10-08 12:00:00+00" }] };
      if (text === "show server_version_num") return { rows: [{ server_version_num: "160001" }] };
      if (text === "SHOW search_path") return { rows: [{ search_path: '"$user", public' }] };
      if (text.startsWith("select digest")) return { rows: [{ digest }] };
      return { rows: [] };
    });
    const report = { log: vi.fn(), error: vi.fn() };
    await applyBillingRetryMigration({ target: "local" }, { createClient: () => client, report,
      loadConfig: () => ({ config: {}, url: new URL("postgresql://postgres@127.0.0.1/fictional"), passphrase: "fixture-only" }),
      readFile: async (file) => {
        reads.push(file.replaceAll("\\", "/"));
        return file.endsWith("202610080001_billing_retry_cycles.sql") ? sql : "begin transaction read only;\nselect 1;\ncommit;";
      } });
    expect(reads).toHaveLength(3);
    expect(reads.some((file) => file.includes("202609190001"))).toBe(false);
    expect(reads.some((file) => file.endsWith(BILLING_RETRY_MIGRATION_SPEC.preflight))).toBe(true);
    expect(calls.filter(({ text }) => text === "COMMIT")).toHaveLength(1);
    expect(calls.find(({ text }) => text.startsWith("select digest")).values).toEqual([BILLING_RETRY_MIGRATION]);
    expect(calls).toContainEqual({ text: "select set_config($1,$2,true)", values: ["app.billing_retry_migration_digest", digest] });
    expect(report.error).not.toHaveBeenCalled();
    expect(JSON.parse(report.log.mock.calls[0][0])).toMatchObject({ verified: true, keepCutover: true, automaticRetry: false });
  });
});

describe("exact new marker is not mistaken for lost historical data", () => {
  const old = { key: '["payment-admin-hardening-v0.3.0"]', hash: "old" };
  const added = { key: JSON.stringify([BILLING_RETRY_MIGRATION]), hash: "new" };
  const manifest = (rows) => ({ tables: [{ schema: "public", name: "payment_admin_migrations", keys: ["name"], count: rows.length, rows }] });
  it("permits the single verified marker addition, but never changed/lost originals or other additions", () => {
    const before = manifest([old]);
    expect(compareManifests(before, migrationPreservationManifest(before, manifest([old, added]), BILLING_RETRY_MIGRATION))).toEqual([]);
    for (const rows of [[{ ...old, hash: "changed" }, added], [added], [old, added, { key: '["unapproved"]', hash: "other" }]]) {
      expect(compareManifests(before, migrationPreservationManifest(before, manifest(rows), BILLING_RETRY_MIGRATION)).length).toBeGreaterThan(0);
    }
    expect(() => migrationPreservationManifest(before, manifest([old, added, added]), BILLING_RETRY_MIGRATION)).toThrow();
    expect(() => migrationPreservationManifest(before, manifest([old, added]), "arbitrary-marker")).toThrow();
  });
  it("does not omit an already-backed-up marker on equivalent reapply", () => {
    const before = manifest([old, added]);
    expect(compareManifests(before, migrationPreservationManifest(before, manifest([old, { ...added, hash: "changed" }]), BILLING_RETRY_MIGRATION))).toHaveLength(1);
  });
  it("observes v0.4.0 from a fresh read-only connection without querying the old marker", async () => {
    const calls = [];
    const observer = new EventEmitter(); observer.connect = vi.fn(); observer.end = vi.fn();
    observer.query = async (input) => {
      const { text, values } = input; calls.push({ text, values });
      if (text.startsWith("select current_database()")) return { rows: [{ database: "fixture", pid: 2, read_only: "on" }] };
      if (text.includes("from pg_catalog.pg_stat_activity")) return { rows: [] };
      if (text === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
      if (text.startsWith("select to_regclass")) return { rows: [{ present: true }] };
      if (text.startsWith("select pg_catalog.row_security_active")) return { rows: [{ filtered: false }] };
      if (text.startsWith("select digest")) return { rows: [{ digest: "a".repeat(64) }] };
      return { rows: [] };
    };
    const before = manifest([old]);
    const result = await observePaymentMigration({ createObserver: () => observer, failedClient: {},
      writerIdentity: { pid: 1, backend_start: "2026-10-08 12:00:00+00" }, expectedDatabase: "fixture",
      digest: "a".repeat(64), migration: BILLING_RETRY_MIGRATION, originalManifest: before, readManifest: async () => manifest([old, added]) });
    expect(result).toMatchObject({ state: "commitverified", markerVerified: true, originalRecordsPreserved: true, observerReadOnly: true, keepCutover: true });
    expect(calls.find(({ text }) => text.startsWith("select digest")).values).toEqual([BILLING_RETRY_MIGRATION]);
  });
});
