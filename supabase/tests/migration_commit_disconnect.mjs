// v0.3.0 | 2026-10-03. Parent-only ESCRITURA on two explicitly prepared disposable clones.
// Source + clones: offline Docker hpe-admin-lab-*; database hpe_lab; base_schema.sql fixture only.
// Parent labels each clone codex.recovery.source=<source> and codex.recovery.disposable=true.
// No cloning/restoring/cleanup here. No private config, environment credentials, provider or Auth calls.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { compareManifests, databaseManifest } from "../../scripts/ops/database-manifest.mjs";
import { migrationWriterIdentity, observePaymentMigration, PAYMENT_MIGRATION } from "../../scripts/ops/migration-recovery.mjs";

const labName = (value) => typeof value === "string" && /^hpe-admin-lab-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

export function recoveryFixtureArguments(args) {
  const names = ["--lab-url", "--lab-container", "--before-clone", "--after-clone", "--clones-confirmed"];
  if (args.length !== names.length * 2 || names.some((name, index) => args[index * 2] !== name)
    || args[9] !== "yes") throw new Error("EXPLICIT_RECOVERY_CLONES_REQUIRED");
  const [, input, , sourceContainer, , beforeClone, , afterClone] = args;
  if (![sourceContainer, beforeClone, afterClone].every(labName)
    || new Set([sourceContainer, beforeClone, afterClone]).size !== 3) throw new Error("DISTINCT_ADMIN_LAB_CLONES_REQUIRED");
  recoveryFixtureOptions(input, sourceContainer);
  return { input, sourceContainer, beforeClone, afterClone };
}

export function recoveryFixtureOptions(input, container, readOnly = true) {
  const url = new URL(input);
  if (!labName(container) || !["postgres:", "postgresql:"].includes(url.protocol)
    || url.hostname !== "127.0.0.1" || url.pathname !== "/hpe_lab" || !url.port
    || !url.username || !url.password || url.search || url.hash) throw new Error("EXPLICIT_OFFLINE_RECOVERY_FIXTURE_REQUIRED");
  return { host: "127.0.0.1", port: Number(url.port), database: "hpe_lab",
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false,
    connectionTimeoutMillis: 3000, query_timeout: 15000, statement_timeout: 10000,
    lock_timeout: 2000, application_name: "hpe-fixture-migration-disconnect-v0.3.0",
    options: readOnly ? "-c default_transaction_read_only=on" : "-c default_transaction_read_only=off" };
}

export function assertRecoveryContainers({ sourceContainer, beforeClone, afterClone }, inspect = (container) => {
  const format = '{"id":{{json .Id}},"project":{{json (index .Config.Labels "codex.project")}},'
    + '"compose":{{json (index .Config.Labels "com.docker.compose.project")}},'
    + '"source":{{json (index .Config.Labels "codex.recovery.source")}},'
    + '"disposable":{{json (index .Config.Labels "codex.recovery.disposable")}},'
    + '"network":{{json .HostConfig.NetworkMode}}}';
  return JSON.parse(execFileSync("docker", ["inspect", "--format", format, container],
    { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
}) {
  const names = [sourceContainer, beforeClone, afterClone];
  if (!names.every(labName) || new Set(names).size !== 3) throw new Error("DISTINCT_ADMIN_LAB_CLONES_REQUIRED");
  const ids = new Set();
  for (const [index, name] of names.entries()) {
    const metadata = inspect(name);
    if (!metadata.id || ids.has(metadata.id) || metadata.project !== "hpe-admin-030" || metadata.network !== "none"
      || (metadata.compose && !labName(metadata.compose))
      || (index > 0 && (metadata.source !== sourceContainer || metadata.disposable !== "true"))) {
      throw new Error("OFFLINE_EXPLICIT_FIXTURE_CLONE_GUARD_FAILED");
    }
    ids.add(metadata.id);
  }
}

// Same offline wire transport as ops, with stderr discarded and fixed error codes for this harness.
class FixtureDockerStream extends Duplex {
  constructor(container) { super(); this.container = container; }
  connect() {
    this.child = spawn("docker", ["exec", "-i", this.container, "nc", "127.0.0.1", "5432"],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    this.child.once("spawn", () => this.emit("connect"));
    this.child.once("error", () => this.destroy(new Error("FIXTURE_DOCKER_TRANSPORT_FAILED")));
    this.child.stdout.on("data", (chunk) => { if (!this.push(chunk)) this.child.stdout.pause(); });
    this.child.stdout.once("end", () => this.push(null));
    this.child.stdin.on("error", () => this.destroy(new Error("FIXTURE_DOCKER_TRANSPORT_FAILED")));
    this.child.once("close", (code) => {
      if (!this.destroyed) this.destroy(code ? new Error("FIXTURE_DOCKER_TRANSPORT_FAILED") : undefined);
    });
    return this;
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  _read() { this.child?.stdout.resume(); }
  _write(chunk, encoding, callback) { this.child.stdin.write(chunk, encoding, callback); }
  _final(callback) { this.child?.stdin.end(callback); }
  _destroy(error, callback) { this.child?.kill(); callback(error); }
}

// PostgreSQL CommandComplete(COMMIT) proves the server committed; drop it before pg sees the ACK.
export class CommitDisconnectStream extends Duplex {
  constructor(transport) {
    super();
    this.transport = transport;
    this.pending = Buffer.alloc(0);
    this.armed = false;
    this.commitAckDropped = false;
    transport.on("connect", () => this.emit("connect"));
    transport.on("data", (chunk) => this.receive(chunk));
    transport.on("end", () => this.push(null));
    transport.on("error", () => this.destroy(new Error("FIXTURE_TRANSPORT_FAILED")));
    transport.on("close", () => { if (!this.destroyed) this.destroy(); });
  }
  connect(...args) { this.transport.connect(...args); return this; }
  setNoDelay() { this.transport.setNoDelay?.(); return this; }
  setKeepAlive() { this.transport.setKeepAlive?.(); return this; }
  armAfterCommit() { this.armed = true; }
  disconnectBeforeCommit() { this.destroy(new Error("FIXTURE_BEFORE_COMMIT_DISCONNECT")); }
  receive(chunk) {
    if (!this.armed) { if (!this.push(chunk)) this.transport.pause(); return; }
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 5) {
      const length = this.pending.readUInt32BE(1) + 1;
      if (length < 5 || length > 1024 * 1024) { this.destroy(new Error("FIXTURE_PROTOCOL_FRAME_INVALID")); return; }
      if (this.pending.length < length) return;
      const frame = this.pending.subarray(0, length);
      this.pending = this.pending.subarray(length);
      if (frame[0] === 67 && frame.subarray(5).equals(Buffer.from("COMMIT\0"))) {
        this.commitAckDropped = true;
        this.destroy(new Error("FIXTURE_AFTER_COMMIT_ACK_DISCONNECT"));
        return;
      }
      if (!this.push(frame)) this.transport.pause();
    }
  }
  _read() { this.transport.resume(); }
  _write(chunk, encoding, callback) { this.transport.write(chunk, encoding, callback); }
  _final(callback) { this.transport.end(callback); }
  _destroy(error, callback) { this.transport.destroy(); callback(error); }
}

export function migrationBeforeCommit(sql) {
  if (!/^\s*(?:--[^\n]*\n\s*)*begin\s*;/i.test(sql) || !/\bcommit;\s*$/i.test(sql)) {
    throw new Error("FIXTURE_TRANSACTION_BOUNDARIES_REQUIRED");
  }
  return sql.replace(/\bcommit;\s*$/i, "");
}

async function assertBaseFixture(client) {
  const { rows: [guard] } = await client.query(`select current_database() = 'hpe_lab'
    and to_regclass('public.payment_admin_migrations') is null
    and (select count(*) from information_schema.columns where table_schema='auth' and table_name='users')=2
    and (select count(*) from auth.users)=0 and (select count(*) from public.donors)=1
    and (select count(*) from public.subscriptions)=1 and (select count(*) from public.payments)=2
    and (select count(*) from public.webhook_events)=2 and (select count(*) from public.audit_logs)=0
    and exists(select 1 from public.donors where id='10000000-0000-0000-0000-000000000090' and email='legacy@example.test')
    and exists(select 1 from public.payments where id='70000000-0000-0000-0000-000000000090'
      and amount=10000 and wompi_transaction_id='tx-historic-10000') as safe`);
  assert.equal(guard?.safe, true, "BASE_SCHEMA_DISPOSABLE_FIXTURE_ONLY");
}

async function snapshot(client, original = null) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try { return await databaseManifest(client, { original }); }
  finally { await client.query("ROLLBACK"); }
}

async function addReceipt(client, afterCommit = false) {
  const id = afterCommit ? "60000000-0000-0000-0000-000000000098" : "60000000-0000-0000-0000-000000000097";
  const raw = { receipt_version: 1, receipt_id: id, event: "transaction.updated", environment: "sandbox",
    transaction: { id: afterCommit ? "fixture-recovery-after" : "fixture-recovery-before", status: "PENDING" } };
  await client.query("insert into public.webhook_events(id,raw) values($1::uuid,$2::jsonb)", [id, raw]);
}

async function waitForWriterExit(observer, identity) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query("select pid from pg_catalog.pg_stat_activity where pid=$1 and backend_start=$2::timestamptz",
      [identity.pid, identity.backend_start]);
    if (rows.length === 0) return;
    await pause(25);
  }
  throw new Error("FIXTURE_WRITER_EXIT_NOT_OBSERVED");
}

export async function runMigrationDisconnectHarness(options) {
  const { input, sourceContainer, beforeClone, afterClone } = options;
  recoveryFixtureOptions(input, sourceContainer);
  assertRecoveryContainers(options);
  const clients = new Set();
  const createClient = (container, readOnly, fault = false) => {
    const settings = recoveryFixtureOptions(input, container, readOnly);
    let transport;
    const client = new pg.Client({ ...settings, stream: () => {
      const stream = new FixtureDockerStream(container);
      transport = fault ? new CommitDisconnectStream(stream) : stream;
      return transport;
    } });
    client.on("error", () => {});
    clients.add(client);
    return { client, transport: () => transport };
  };
  const sql = await readFile(new URL("../migrations/202609190001_payment_and_admin_hardening.sql", import.meta.url), "utf8");
  const digest = createHash("sha256").update(sql).digest("hex");
  const body = migrationBeforeCommit(sql);
  const source = createClient(sourceContainer, true).client;
  const results = [];
  try {
    await source.connect();
    await assertBaseFixture(source);
    const originals = await snapshot(source);
    // Validate BOTH explicit clones before any fixture write.
    const clones = [];
    for (const container of [beforeClone, afterClone]) {
      const fault = createClient(container, false, true);
      const witness = createClient(container, true).client;
      await fault.client.connect();
      await witness.connect();
      await assertBaseFixture(witness);
      assert.equal(compareManifests(originals, await snapshot(witness), { compareMetadata: true }).length, 0,
        "FIXTURE_CLONE_MUST_MATCH_SOURCE");
      clones.push({ container, fault, witness });
    }
    for (const [index, { container, fault, witness }] of clones.entries()) {
      const writer = fault.client;
      await addReceipt(writer);
      const before = await snapshot(witness);
      const identity = await migrationWriterIdentity(writer);
      const { rows: [other] } = await witness.query("select pg_backend_pid() as pid");
      assert.notEqual(other.pid, identity.pid, "INDEPENDENT_WITNESS_REQUIRED");
      await writer.query("select set_config('app.migration_digest',$1,false)", [digest]);
      await writer.query({ text: body, query_timeout: 300000 });
      if (index === 0) {
        fault.transport().disconnectBeforeCommit();
      } else {
        fault.transport().armAfterCommit();
        await assert.rejects(writer.query("COMMIT"));
        assert.equal(fault.transport().commitAckDropped, true, "COMMIT_ACK_WAS_NOT_DROPPED");
      }
      await writer.end().catch(() => {});
      await waitForWriterExit(witness, identity);
      if (index === 1) {
        const receiver = createClient(container, false).client;
        await receiver.connect();
        await addReceipt(receiver, true);
        await receiver.end();
      }
      const durable = await snapshot(witness);
      const observed = await observePaymentMigration({ createObserver: () => createClient(container, true).client,
        failedClient: writer, writerIdentity: identity, expectedDatabase: "hpe_lab", digest, originalManifest: before });
      assert.equal(observed.state, index === 0 ? "notapplied" : "commitverified", "RECOVERY_STATE_MISMATCH");
      assert.equal(observed.observerFresh && observed.observerReadOnly && observed.observerClosed, true);
      assert.equal(observed.originalRecordsPreserved, true);
      assert.equal(observed.keepCutover, true);
      assert.equal(observed.automaticRetry, false);
      const after = await snapshot(witness, durable);
      assert.equal(compareManifests(durable, after, { compareMetadata: true }).length, 0,
        "OBSERVER_CHANGED_DURABLE_DATA_OR_METADATA");
      assert.equal(compareManifests(originals, await snapshot(witness, originals), { allowAdditionalReceipts: true }).length, 0,
        "ORIGINALS_OR_NEW_RECEIPTS_LOST");
      if (index === 1) {
        const { rows: markers } = await witness.query("select digest from public.payment_admin_migrations where name=$1", [PAYMENT_MIGRATION]);
        assert.equal(markers.length, 1);
        assert.equal(markers[0].digest, digest);
      }
      results.push({ ...observed, scenarioCode: index === 0 ? "FIXTURE_BEFORE_COMMIT_VERIFIED" : "FIXTURE_AFTER_COMMIT_VERIFIED",
        originalsPreserved: true, newReceiptsPreserved: true, markerPreserved: index === 1, markerAbsenceVerified: index === 0,
        migrationIssuedOnce: true, restoreAttempted: false });
    }
    assert.equal(compareManifests(originals, await snapshot(source, originals), { compareMetadata: true }).length, 0,
      "READ_ONLY_SOURCE_CHANGED");
    return { code: "MIGRATION_DISCONNECT_FIXTURES_VERIFIED", verified: true, sourceUnchanged: true,
      keepCutover: true, automaticRetry: false, restoreAttempted: false, results };
  } finally {
    for (const client of clients) await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => runMigrationDisconnectHarness(recoveryFixtureArguments(process.argv.slice(2))))()
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(JSON.stringify({ code: "MIGRATION_DISCONNECT_FIXTURE_STOPPED", verified: false,
        keepCutover: true, automaticRetry: false, restoreAttempted: false }));
      process.exitCode = 1;
    });
}
