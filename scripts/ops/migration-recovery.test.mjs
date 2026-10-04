// @vitest-environment node
// v0.3.0 | 2026-10-03. Mock-only; no Docker, SQL engine, private files, environment or Auth.
// LECTURA: node --test scripts/ops/migration-recovery.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createHash } from "node:crypto";
import { applyPaymentMigration, assertCompleteMigrationManifest, lockMigrationTables, migrationTransactionBody } from "./apply-payment-migration.mjs";
import { MANIFEST_METADATA_SECTIONS } from "./database-manifest.mjs";
import { closeMigrationConnection, migrationWriterIdentity, observePaymentMigration, PAYMENT_MIGRATION } from "./migration-recovery.mjs";
import { assertRecoveryContainers, CommitDisconnectStream, migrationBeforeCommit,
  recoveryFixtureArguments, recoveryFixtureOptions } from "../../supabase/tests/migration_commit_disconnect.mjs";

// Keep Node's standalone runner out of Vite's static dependency analysis.
let test = globalThis.test;
if (typeof test !== "function") {
  const nodeTestModule = "node:" + "test";
  ({ test } = await import(/* @vite-ignore */ nodeTestModule));
}
const digest = "a".repeat(64);
const writerIdentity = { pid: 41, backend_start: "2026-10-03 12:00:00+00" };
const textOf = (input) => typeof input === "string" ? input : input.text;
class MockClient extends EventEmitter {
  constructor(handler) { super(); this.handler = handler; this.calls = []; this.connects = 0; this.ends = 0; }
  async connect() { this.connects += 1; if (this.connectError) throw this.connectError; }
  async query(input, values) { this.calls.push({ text: textOf(input), values: values ?? input.values }); return this.handler(textOf(input), values ?? input.values); }
  async end() { this.ends += 1; if (this.endError) throw this.endError; }
}

function observerFixture({ markers = [{ digest }], present = true, active = [],
  database = "hpe_lab", readOnly = "on", transactionReadOnly = "on", failAt } = {}) {
  return new MockClient(async (sql) => {
    if (failAt && sql.includes(failAt)) throw new Error("not-a-public-diagnostic");
    if (sql.startsWith("select current_database()")) return { rows: [{ database, pid: 42, read_only: readOnly }] };
    if (sql.includes("from pg_catalog.pg_stat_activity")) return { rows: active };
    if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: transactionReadOnly }] };
    if (sql.startsWith("select to_regclass")) return { rows: [{ present }] };
    if (sql.startsWith("select pg_catalog.row_security_active")) return { rows: [{ filtered: false }] };
    if (sql.startsWith("select digest")) return { rows: markers };
    if (/^(SET |BEGIN )/.test(sql)) return { rows: [] };
    throw new Error("UNEXPECTED_MOCK_QUERY");
  });
}

function observe(observer, extra = {}) {
  return observePaymentMigration({ createObserver: (options) => {
    assert.deepEqual(options, { readOnly: true }); return observer;
  }, failedClient: {}, writerIdentity, expectedDatabase: "hpe_lab", digest, ...extra });
}

function assertClosedCutover(result, observer) {
  assert.equal(result.keepCutover, true);
  assert.equal(result.automaticRetry, false);
  assert.equal(result.observerClosed, true);
  assert.equal(observer.ends, 1);
  assert.equal(observer.connects, 1);
  for (const { text } of observer.calls) assert.match(text, /^(?:select |SET |SHOW |BEGIN )/);
  assert.ok(!observer.calls.some(({ text }) => /INSERT|UPDATE|DELETE|ALTER|CREATE|pg_terminate_backend|set_config|COMMIT/i.test(text)));
}

test("exact committed marker is independently verified, with cutover retained", async () => {
  const observer = observerFixture();
  const result = await observe(observer);
  assert.equal(result.state, "commitverified");
  assert.equal(result.markerVerified, true);
  assert.equal(result.observerFresh && result.observerReadOnly, true);
  assert.equal(result.preservationChecked, false);
  assert.equal(result.originalRecordsPreserved, false);
  assertClosedCutover(result, observer);
  const writerCheck = observer.calls.findIndex(({ text }) => text.includes("from pg_catalog.pg_stat_activity"));
  const snapshot = observer.calls.findIndex(({ text }) => text.startsWith("BEGIN "));
  assert.ok(writerCheck >= 0 && writerCheck < snapshot, "writer exit precedes the marker snapshot");
  assert.deepEqual(observer.calls.find(({ text }) => text.startsWith("select digest")).values, [PAYMENT_MIGRATION]);
});

for (const present of [false, true]) {
  test(`absent marker and stopped writer verify notapplied (catalog ${present})`, async () => {
    const observer = observerFixture({ markers: [], present });
    const result = await observe(observer);
    assert.equal(result.state, "notapplied");
    assert.equal(result.writerStoppedVerified, true);
    assert.equal(result.markerVerified, false);
    assertClosedCutover(result, observer);
  });
}

for (const active of [[{ identity_visible: true, same_backend: true }],
  [{ identity_visible: false, same_backend: null }]]) {
  test(`absent marker with unresolved writer remains unknown (visible ${active[0].identity_visible})`, async () => {
    const observer = observerFixture({ markers: [], active });
    const result = await observe(observer);
    assert.equal(result.state, "unknown");
    assert.equal(result.writerStoppedVerified, false);
    assert.equal(result.code, "RECOVERY_WRITER_UNRESOLVED");
    assertClosedCutover(result, observer);
  });
}

test("a reused PID is not confused with the original writer", async () => {
  const result = await observe(observerFixture({ markers: [], active: [{ identity_visible: true, same_backend: false }] }));
  assert.equal(result.state, "notapplied");
  assert.equal(result.writerStoppedVerified, true);
});

test("missing writer identity cannot prove notapplied", async () => {
  const observer = observerFixture({ markers: [] });
  const result = await observe(observer, { writerIdentity: undefined });
  assert.equal(result.state, "unknown");
  assert.ok(!observer.calls.some(({ text }) => text.includes("pg_stat_activity")));
});

test("committed marker is enough even while the original connection is still alive", async () => {
  const result = await observe(observerFixture({ active: [{ identity_visible: true, same_backend: true }] }));
  assert.equal(result.state, "commitverified");
  assert.equal(result.writerStoppedVerified, false);
});

for (const markers of [[{ digest: "b".repeat(64) }], [{ digest }, { digest }]]) {
  test(`conflicting marker evidence stays unknown (rows ${markers.length})`, async () => {
    const result = await observe(observerFixture({ markers }));
    assert.equal(result.state, "unknown");
    assert.equal(result.code, "RECOVERY_MARKER_CONFLICT");
  });
}

test("failed connection is never reused, queried, or closed by observer helper", async () => {
  const failed = observerFixture();
  const result = await observe(failed, { failedClient: failed });
  assert.equal(result.state, "unknown");
  assert.equal(result.code, "RECOVERY_FRESH_OBSERVER_REQUIRED");
  assert.equal(failed.calls.length + failed.connects + failed.ends, 0);
});

test("invalid digest fails closed before any connection", async () => {
  const observer = observerFixture();
  const result = await observe(observer, { digest: "INVALID" });
  assert.equal(result.state, "unknown");
  assert.equal(result.code, "RECOVERY_INPUT_INVALID");
  assert.equal(observer.connects, 0);
});

for (const options of [{ database: "other" }, { readOnly: "off" }, { transactionReadOnly: "off" }]) {
  test(`observer refuses an invalid database or read-only guard (${Object.keys(options)[0]})`, async () => {
    const observer = observerFixture(options);
    const result = await observe(observer);
    assert.equal(result.state, "unknown");
    assert.equal(result.observerReadOnly, false);
    assert.ok(!observer.calls.some(({ text }) => text.startsWith("select digest")));
    assertClosedCutover(result, observer);
  });
}

test("observer with original backend PID is refused", async () => {
  const result = await observe(observerFixture(), { writerIdentity: { ...writerIdentity, pid: 42 } });
  assert.equal(result.state, "unknown");
  assert.equal(result.code, "RECOVERY_OBSERVER_GUARD_FAILED");
});

test("observer connection failure exposes only fixed codes and flags", async () => {
  const observer = observerFixture();
  observer.connectError = Object.assign(new Error("sensitive-driver-detail"), { code: "sensitive-code" });
  const result = await observe(observer);
  assert.equal(result.state, "unknown");
  assert.equal(result.code, "RECOVERY_OBSERVATION_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /sensitive|digest|backend_start|pid|hpe_lab/);
  assert.equal(observer.calls.length, 0);
  assertClosedCutover(result, observer);
});

test("catalog permission or timeout failure is never inferred as absent", async () => {
  const observer = observerFixture({ failAt: "select to_regclass" });
  const result = await observe(observer);
  assert.equal(result.state, "unknown");
  assert.equal(result.code, "RECOVERY_OBSERVATION_FAILED");
  assertClosedCutover(result, observer);
});

test("RLS-filtered absence cannot prove notapplied", async () => {
  const observer = observerFixture({ markers: [] });
  const handler = observer.handler;
  observer.handler = async (sql) => sql.startsWith("select pg_catalog.row_security_active")
    ? { rows: [{ filtered: true }] } : handler(sql);
  const result = await observe(observer);
  assert.equal(result.state, "unknown");
  assert.equal(result.writerStoppedVerified, true);
  assert.equal(result.code, "RECOVERY_MARKER_VISIBILITY_UNCONFIRMED");
});

test("cleanup has a deadline and never queues a rollback on a stuck connection", async () => {
  let destroyed = false;
  const client = { connection: { stream: { destroy: () => { destroyed = true; } } },
    end: () => new Promise(() => {}), query: () => { throw new Error("NO_CLEANUP_SQL"); } };
  assert.equal(await closeMigrationConnection(client, 5), false);
  assert.equal(destroyed, true);
});

const original = { tables: [{ schema: "public", name: "webhook_events", rows: [{ key: "1", hash: "old", receipt: true }] }] };
test("original receipts and additional new receipts are preserved", async () => {
  const result = await observe(observerFixture(), { originalManifest: original, readManifest: async (_client, options) => {
    assert.equal(options.original, original);
    return { tables: [{ ...original.tables[0], rows: [...original.tables[0].rows, { key: "2", hash: "new", receipt: true }] }] };
  } });
  assert.equal(result.state, "commitverified");
  assert.equal(result.preservationChecked && result.originalRecordsPreserved, true);
});

test("lost original receipt keeps commit evidence but fails preservation", async () => {
  const result = await observe(observerFixture(), { originalManifest: original,
    readManifest: async () => ({ tables: [{ ...original.tables[0], rows: [{ key: "2", hash: "new", receipt: true }] }] }) });
  assert.equal(result.state, "commitverified");
  assert.equal(result.code, "RECOVERY_PRESERVATION_FAILED");
  assert.equal(result.originalRecordsPreserved, false);
});

test("failed preservation query cannot relabel an already verified COMMIT as notapplied", async () => {
  const result = await observe(observerFixture(), { originalManifest: original,
    readManifest: async () => { throw new Error("private-detail"); } });
  assert.equal(result.state, "commitverified");
  assert.equal(result.markerVerified, true);
  assert.equal(result.code, "RECOVERY_OBSERVATION_FAILED");
  assert.equal(result.preservationChecked, false);
});

test("end failure is flagged without invalidating commit evidence", async () => {
  const observer = observerFixture();
  observer.endError = new Error("private-close-detail");
  const result = await observe(observer);
  assert.equal(result.state, "commitverified");
  assert.equal(result.observerClosed, false);
  assert.equal(result.keepCutover, true);
});

test("writer identity is obtained before the migration and validated", async () => {
  const writer = new MockClient(async () => ({ rows: [writerIdentity] }));
  assert.deepEqual(await migrationWriterIdentity(writer), writerIdentity);
  await assert.rejects(migrationWriterIdentity(new MockClient(async () => ({ rows: [{ pid: 41 }] }))),
    /MIGRATION_WRITER_IDENTITY_REQUIRED/);
});

function applicationFixture({ failAt = "migration", observerUnavailable = false } = {}) {
  const sql = "begin; select 'mock-only'; commit;";
  const body = migrationTransactionBody(sql);
  const preflight = "begin transaction read only; select 'mock-preflight'; commit;";
  const postflight = "begin transaction read only; select 'mock-postflight'; commit;";
  const preflightBody = migrationTransactionBody(preflight);
  const postflightBody = migrationTransactionBody(postflight);
  const actualDigest = createHash("sha256").update(sql).digest("hex");
  const output = [];
  let failed = false;
  const writer = new MockClient(async (text) => {
    assert.equal(failed, false, "no queries on the failed writer");
    if (text.includes("backend_start::text")) return { rows: [writerIdentity] };
    if (text === "show server_version_num") return { rows: [{ server_version_num: "170000" }] };
    if (text === "SHOW search_path") return { rows: [{ search_path: '"$user", public' }] };
    if (text === body || text === postflightBody || text === preflightBody) {
      if (text === ({ migration: body, postflight: postflightBody, preflight: preflightBody })[failAt]) {
        failed = true; throw Object.assign(new Error("do-not-log-driver-input"), { code: "do-not-log-driver-code" });
      }
    }
    if (text.startsWith("select digest")) return { rows: [{ digest: actualDigest }] };
    return { rows: [] };
  });
  const observer = observerFixture({ markers: failAt === "preflight" ? [] : [{ digest: actualDigest }] });
  if (observerUnavailable) observer.connectError = new Error("no-observer");
  const clients = [];
  const dependencies = { loadConfig: () => ({ config: {}, url: new URL("postgresql://127.0.0.1:5432/hpe_lab") }),
    createClient: (_url, options) => { clients.push(options); return options.readOnly ? observer : writer; },
    readFile: async (file) => file.endsWith("_preflight.sql") ? preflight
      : file.endsWith("_postflight.sql") ? postflight : sql,
    report: { log: (value) => output.push(JSON.parse(value)), error: (value) => output.push(JSON.parse(value)) } };
  return { sql: body, output, writer, observer, clients, dependencies };
}

for (const failAt of ["migration", "postflight", "preflight"]) {
  test(`CLI ${failAt} failure opens fresh read-only observer, never retries SQL`, async () => {
    const fixture = applicationFixture({ failAt });
    await assert.rejects(applyPaymentMigration({ target: "local" }, fixture.dependencies), /MIGRATION_STOPPED_NO_AUTOMATIC_RETRY/);
    assert.deepEqual(fixture.clients.map((options) => options.readOnly), [false, true]);
    assert.equal(fixture.writer.calls.filter(({ text }) => text === fixture.sql).length, failAt === "preflight" ? 0 : 1);
    assert.ok(!fixture.writer.calls.some(({ text }) => text === "ROLLBACK"));
    assert.equal(fixture.output[0].state, failAt === "preflight" ? "notapplied" : "commitverified");
    assert.equal(fixture.output[0].keepCutover, true);
    assert.equal(fixture.output[0].automaticRetry, false);
    assert.doesNotMatch(JSON.stringify(fixture.output), /do-not-log|digest|hpe_lab/);
  });
}

test("CLI uncertain response plus unavailable observer stays unknown with one migration", async () => {
  const fixture = applicationFixture({ observerUnavailable: true });
  await assert.rejects(applyPaymentMigration({ target: "local" }, fixture.dependencies));
  assert.equal(fixture.output[0].state, "unknown");
  assert.equal(fixture.writer.calls.filter(({ text }) => text === fixture.sql).length, 1);
  assert.equal(fixture.clients.length, 2);
});

test("CLI acknowledged SQL is not trusted after postflight failure with unavailable observer", async () => {
  const fixture = applicationFixture({ failAt: "postflight", observerUnavailable: true });
  await assert.rejects(applyPaymentMigration({ target: "local" }, fixture.dependencies));
  assert.equal(fixture.output[0].state, "unknown");
  assert.equal(fixture.output[0].markerVerified, false);
});

test("successful CLI does not open recovery and reports no database digest", async () => {
  const fixture = applicationFixture({ failAt: "none" });
  await applyPaymentMigration({ target: "local" }, fixture.dependencies);
  assert.equal(fixture.clients.length, 1);
  assert.equal(fixture.output[0].verified, true);
  assert.equal(fixture.output[0].keepCutover, true);
  assert.doesNotMatch(JSON.stringify(fixture.output), /digest|hpe_lab/);
});

const completeFixtureManifest = () => ({ format: 5,
  tables: [{ schema: "public", name: "webhook_events", columns: ["id", "raw"], keys: ["id"], count: 1,
    rows: [{ key: "original", hash: "a".repeat(64), receipt: true }] }], roles: [], storage: [],
  ...Object.fromEntries(MANIFEST_METADATA_SECTIONS.map((section) => [section, []])) });
const productionFixtureArgs = { target: "production", backup: "unused-fixture-only",
  "cutover-authorized": "yes", "backup-confirmed-in-chat": "yes" };

function guardedFixture({ changeBefore, changeAfter, failLock = false } = {}) {
  const fixture = applicationFixture({ failAt: "none" });
  const baseline = completeFixtureManifest();
  const before = structuredClone(baseline);
  changeBefore?.(before);
  const after = structuredClone(before);
  changeAfter?.(after);
  const events = [];
  const handler = fixture.writer.handler;
  fixture.writer.handler = async (sql, values) => {
    events.push(sql);
    if (sql.includes("c.relkind in ('r','p')")) return { rows: baseline.tables.map(({ schema, name }) => ({ schema, name })) };
    if (sql.startsWith("LOCK TABLE") && failLock) throw new Error("fixture-lock-timeout");
    return handler(sql, values);
  };
  fixture.dependencies.loadConfig = () => ({ config: { EXPECTED_PROJECT_REF: "fixture" },
    url: new URL("postgresql://fixture:unused@db.fixture.supabase.co/postgres"), passphrase: "unused-fixture" });
  fixture.dependencies.readBackup = async () => baseline;
  let reads = 0;
  fixture.dependencies.readManifest = async (_client, options) => {
    events.push("MANIFEST_READ");
    reads++;
    if (reads === 1) { assert.equal(options, undefined); return before; }
    assert.equal(options.original, before);
    return after;
  };
  return { ...fixture, baseline, before, after, events };
}

test("strict backup gate and preservation share one locked transaction and one COMMIT", async () => {
  const fixture = guardedFixture();
  await applyPaymentMigration(productionFixtureArgs, fixture.dependencies);
  const events = fixture.events;
  assert.equal(events.filter((sql) => sql.startsWith("BEGIN ")).length, 1);
  assert.equal(events.filter((sql) => sql === "COMMIT").length, 1);
  const lock = events.findIndex((sql) => sql.startsWith("LOCK TABLE"));
  const before = events.indexOf("MANIFEST_READ");
  const migration = events.indexOf(fixture.sql);
  const after = events.lastIndexOf("MANIFEST_READ");
  assert.ok(lock < before && before < migration && migration < after && after < events.indexOf("COMMIT"));
  assert.match(events[lock], /IN ACCESS EXCLUSIVE MODE$/);
  const path = fixture.writer.calls.find(({ text }) => text.includes("set_config('search_path'"));
  assert.deepEqual(path.values, ['"$user", public']);
  assert.ok(events.indexOf(path.text) > before && events.indexOf(path.text) < migration);
});

test("new v1 receipts become part of the locked preservation baseline", async () => {
  const fixture = guardedFixture({ changeBefore: (manifest) => {
    manifest.tables[0].rows.push({ key: "arrived-after-backup", hash: "b".repeat(64), receipt: true });
    manifest.tables[0].count++;
  } });
  await applyPaymentMigration(productionFixtureArgs, fixture.dependencies);
  assert.equal(fixture.output[0].originalRecordsPreserved, true);
});

for (const [label, changeBefore] of [
  ["changed original", (manifest) => { manifest.tables[0].rows[0].hash = "c".repeat(64); }],
  ["missing original", (manifest) => { manifest.tables[0].rows = []; manifest.tables[0].count = 0; }],
  ["non-receipt addition", (manifest) => { manifest.tables[0].rows.push({ key: "unbacked", hash: "b".repeat(64), receipt: false }); }],
  ["new empty table", (manifest) => { manifest.tables.push({ schema: "public", name: "unbacked", columns: ["id"], keys: [], count: 0, rows: [] }); }],
  ["new column", (manifest) => { manifest.tables[0].columns.push("unbacked_column"); }],
  ["changed primary key", (manifest) => { manifest.tables[0].keys = []; }],
  ["new column permission", (manifest) => { manifest.columnPermissions.push({ schema: "public", table_name: "webhook_events", name: "raw", acl: ["anon"] }); }],
  ["new role", (manifest) => { manifest.roles.push({ rolname: "unbacked-role", rolcanlogin: true }); }],
  ["new function permission", (manifest) => { manifest.functionPermissions.push({ name: "unbacked", acl: ["PUBLIC"] }); }],
]) {
  test(`backup drift blocks all DDL before COMMIT: ${label}`, async () => {
    const fixture = guardedFixture({ changeBefore });
    await assert.rejects(applyPaymentMigration(productionFixtureArgs, fixture.dependencies), /MIGRATION_STOPPED_NO_AUTOMATIC_RETRY/);
    assert.equal(fixture.events.includes(fixture.sql), false);
    assert.equal(fixture.events.includes("COMMIT"), false);
    assert.equal(fixture.output[0].verified, false);
    assert.equal(fixture.output[0].keepCutover, true);
  });
}

test("loss of a receipt arriving after backup is rejected before COMMIT", async () => {
  const fixture = guardedFixture({ changeBefore: (manifest) => {
    manifest.tables[0].rows.push({ key: "arrived-after-backup", hash: "b".repeat(64), receipt: true });
    manifest.tables[0].count++;
  }, changeAfter: (manifest) => { manifest.tables[0].rows.pop(); manifest.tables[0].count--; } });
  await assert.rejects(applyPaymentMigration(productionFixtureArgs, fixture.dependencies));
  assert.equal(fixture.events.includes(fixture.sql), true);
  assert.equal(fixture.events.includes("COMMIT"), false);
});

test("expected migration DDL does not require old metadata to remain unchanged", async () => {
  const fixture = guardedFixture({ changeAfter: (manifest) => {
    manifest.tableDefinitions.push({ name: "admin_users" });
    manifest.policies.push({ policyname: "new-admin-only-policy" });
  } });
  await applyPaymentMigration(productionFixtureArgs, fixture.dependencies);
  assert.equal(fixture.output[0].verified, true);
});

test("lock timeout prevents manifest reading, migration and COMMIT without retry", async () => {
  const fixture = guardedFixture({ failLock: true });
  await assert.rejects(applyPaymentMigration(productionFixtureArgs, fixture.dependencies));
  assert.equal(fixture.events.includes("MANIFEST_READ"), false);
  assert.equal(fixture.events.includes(fixture.sql), false);
  assert.equal(fixture.events.includes("COMMIT"), false);
  assert.equal(fixture.output[0].automaticRetry, false);
});

test("incomplete or duplicate-table manifest is refused before any connection", async () => {
  for (const alter of [(manifest) => { delete manifest.columnPermissions; },
    (manifest) => { manifest.tables.push(manifest.tables[0]); },
    (manifest) => { manifest.tables[0].rows[0].hash = "invalid"; }]) {
    const fixture = guardedFixture();
    alter(fixture.baseline);
    await assert.rejects(applyPaymentMigration(productionFixtureArgs, fixture.dependencies), /COMPLETE_BACKUP_MANIFEST_REQUIRED/);
    assert.equal(fixture.clients.length, 0);
  }
  assert.doesNotThrow(() => assertCompleteMigrationManifest(completeFixtureManifest()));
});

test("SQL wrappers are explicit and preserve internal PL/pgSQL BEGIN blocks", () => {
  const sql = "-- fixture\nbegin; do $$ begin perform 1; end $$; commit;\n";
  assert.equal(migrationTransactionBody(sql), "-- fixture\n do $$ begin perform 1; end $$; ");
  for (const invalid of ["select 1;", "select 1; begin; commit;", "begin; select 1;", "begin; commit; select 1;"]) {
    assert.throws(() => migrationTransactionBody(invalid), /EXPECTED_SQL_TRANSACTION_REQUIRED/);
  }
});

test("empty inventory refuses table locks without changing data", async () => {
  const client = new MockClient(async () => ({ rows: [] }));
  await assert.rejects(lockMigrationTables(client), /MIGRATION_TABLE_INVENTORY_REQUIRED/);
  assert.equal(client.calls.length, 1);
});

// Opaque parser-only input; never passed to a driver or used to authenticate.
const fixtureUrl = "postgresql://fixture:unused@127.0.0.1:5432/hpe_lab";
const containers = { sourceContainer: "hpe-admin-lab-source", beforeClone: "hpe-admin-lab-before", afterClone: "hpe-admin-lab-after" };
const args = ["--lab-url", fixtureUrl, "--lab-container", containers.sourceContainer,
  "--before-clone", containers.beforeClone, "--after-clone", containers.afterClone, "--clones-confirmed", "yes"];
test("harness requires both explicit distinct clones and offline fixture URL", () => {
  assert.deepEqual(recoveryFixtureArguments(args), { input: fixtureUrl, ...containers });
  for (const invalid of [[], args.slice(0, -2), [...args.slice(0, -1), "no"],
    args.map((value) => value === containers.beforeClone ? containers.sourceContainer : value),
    args.map((value) => value === containers.afterClone ? "hpe-admin-prod-after" : value),
    args.map((value) => value === fixtureUrl ? fixtureUrl.replace("127.0.0.1", "remote.example.test") : value)]) {
    assert.throws(() => recoveryFixtureArguments(invalid));
  }
  for (const input of [fixtureUrl.replace("hpe_lab", "postgres"), `${fixtureUrl}?options=unsafe`,
    `${fixtureUrl}#unsafe`, fixtureUrl.replace("127.0.0.1", "localhost"), "postgresql://127.0.0.1:5432/hpe_lab"]) {
    assert.throws(() => recoveryFixtureOptions(input, containers.sourceContainer));
  }
});

test("harness validates ownership, isolation, source provenance and container identity without Docker", () => {
  const metadata = (name) => ({ id: name, project: "hpe-admin-030", network: "none", compose: "hpe-admin-lab-recovery",
    source: containers.sourceContainer, disposable: "true" });
  assertRecoveryContainers(containers, metadata);
  for (const change of [{ network: "bridge" }, { project: "production" }, { compose: "production" },
    { source: "other" }, { disposable: "false" }, { id: containers.sourceContainer }]) {
    assert.throws(() => assertRecoveryContainers(containers,
      (name) => ({ ...metadata(name), ...(name === containers.beforeClone ? change : {}) })));
  }
});

test("harness splits only the final COMMIT without editing the migration", () => {
  const sql = "-- fixture only\nbegin; do $$ begin perform 1; end $$;\ncommit;\n";
  assert.equal(migrationBeforeCommit(sql), "-- fixture only\nbegin; do $$ begin perform 1; end $$;\n");
  for (const invalid of ["select 1;", "begin; commit; select 1;", "select 1; commit;"]) {
    assert.throws(() => migrationBeforeCommit(invalid));
  }
});

const frame = (type, payload) => {
  const bytes = Buffer.from(payload);
  const header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0);
  header.writeUInt32BE(bytes.length + 4, 1);
  return Buffer.concat([header, bytes]);
};
function faultStream() {
  const transport = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const stream = new CommitDisconnectStream(transport);
  stream.on("error", () => {});
  return stream;
}
test("wire harness drops COMMIT acknowledgement and ReadyForQuery, including split frames", async () => {
  const stream = faultStream();
  stream.armAfterCommit();
  const response = Buffer.concat([frame("C", "COMMIT\0"), frame("Z", "I")]);
  stream.receive(response.subarray(0, 3));
  assert.equal(stream.read(), null);
  stream.receive(response.subarray(3, 8));
  assert.equal(stream.read(), null);
  stream.receive(response.subarray(8));
  await nextTurn();
  assert.equal(stream.commitAckDropped, true);
  assert.equal(stream.destroyed, true);
  assert.equal(stream.transport.destroyed, true);
  assert.equal(stream.read(), null);
});

test("wire harness passes normal frames until armed and never mistakes ROLLBACK for COMMIT", async () => {
  const stream = faultStream();
  const ack = frame("C", "COMMIT\0");
  stream.receive(ack);
  assert.deepEqual(stream.read(), ack);
  stream.armAfterCommit();
  const rollback = frame("C", "ROLLBACK\0");
  stream.receive(rollback);
  assert.deepEqual(stream.read(), rollback);
  assert.equal(stream.commitAckDropped, false);
  stream.disconnectBeforeCommit();
  await nextTurn();
  assert.equal(stream.destroyed, true);
});
