// v0.3.0 | 2026-10-03. Fresh read-only commit evidence; never retry or release cutover.
import { compareManifests, databaseManifest } from "./database-manifest.mjs";

export const PAYMENT_MIGRATION = "payment-admin-hardening-v0.3.0";
export const BILLING_RETRY_MIGRATION = "billing-retry-v0.4.0";
const MIGRATIONS = new Set([PAYMENT_MIGRATION, BILLING_RETRY_MIGRATION]);

export function migrationPreservationManifest(original, actual, migration) {
  if (!MIGRATIONS.has(migration)) throw new Error("KNOWN_MIGRATION_REQUIRED");
  const key = JSON.stringify([migration]);
  const before = original.tables.find((table) => table.schema === "public" && table.name === "payment_admin_migrations");
  if (!before || before.rows.some((row) => row.key === key)) return actual;
  const after = actual.tables.find((table) => table.schema === "public" && table.name === "payment_admin_migrations");
  if (!after || JSON.stringify(before.keys) !== JSON.stringify(["name"])) return actual;
  const added = after.rows.filter((row) => row.key === key);
  if (added.length > 1) throw new Error("MIGRATION_MARKER_IDENTITY_INVALID");
  return { ...actual, tables: actual.tables.map((table) => table === after
    ? { ...table, rows: table.rows.filter((row) => row.key !== key), count: table.count - added.length } : table) };
}
export const WRITER_IDENTITY_SQL = `select pg_backend_pid() as pid, backend_start::text as backend_start
  from pg_catalog.pg_stat_activity where pid = pg_backend_pid()`;

export async function migrationWriterIdentity(client) {
  const { rows } = await client.query(WRITER_IDENTITY_SQL);
  const identity = rows[0];
  if (!Number.isInteger(identity?.pid) || identity.pid <= 0 || !identity.backend_start) {
    throw new Error("MIGRATION_WRITER_IDENTITY_REQUIRED");
  }
  return identity;
}

export async function closeMigrationConnection(client, timeoutMs = 2000) {
  let timer;
  try {
    // A timed-out query can still be active on the server. Disconnect, do not queue more SQL.
    client.connection?.stream?.destroy();
    return await Promise.race([
      client.end().then(() => true, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export async function observePaymentMigration({ createObserver, failedClient, writerIdentity,
  expectedDatabase, digest, originalManifest, readManifest = databaseManifest, migration = PAYMENT_MIGRATION }) {
  const result = { state: "unknown", code: "RECOVERY_OBSERVATION_FAILED", observerFresh: false,
    observerReadOnly: false, observerClosed: false, writerStoppedVerified: false,
    markerVerified: false, preservationChecked: false, originalRecordsPreserved: false,
    keepCutover: true, automaticRetry: false };
  if (!/^[0-9a-f]{64}$/.test(digest ?? "") || !expectedDatabase || !MIGRATIONS.has(migration)) {
    result.code = "RECOVERY_INPUT_INVALID";
    return result;
  }
  let observer;
  const ignoreConnectionError = () => {};
  const query = (text, values) => observer.query({ text, values, query_timeout: 10000 });
  try {
    observer = createObserver({ readOnly: true });
    if (!observer || observer === failedClient) {
      observer = undefined;
      result.code = "RECOVERY_FRESH_OBSERVER_REQUIRED";
      return result;
    }
    observer.on?.("error", ignoreConnectionError);
    await observer.connect();
    await query("SET default_transaction_read_only=on");
    const { rows: [session] } = await query(`select current_database() as database,
      pg_backend_pid() as pid, current_setting('default_transaction_read_only') as read_only`);
    if (session?.database !== expectedDatabase || session.read_only !== "on"
      || !Number.isInteger(session.pid) || session.pid === writerIdentity?.pid) {
      result.code = "RECOVERY_OBSERVER_GUARD_FAILED";
      return result;
    }
    result.observerFresh = true;
    const identified = Number.isInteger(writerIdentity?.pid) && writerIdentity.pid > 0
      && typeof writerIdentity.backend_start === "string" && writerIdentity.backend_start.length > 0;
    if (identified) {
      // This autocommit read MUST precede the snapshot: absence before a late COMMIT is not evidence.
      const { rows } = await query(`select backend_start is not null as identity_visible,
        backend_start=$2::timestamptz as same_backend from pg_catalog.pg_stat_activity where pid=$1`,
      [writerIdentity.pid, writerIdentity.backend_start]);
      result.writerStoppedVerified = rows.length === 0
        || (rows.length === 1 && rows[0].identity_visible === true && rows[0].same_backend === false);
    }
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await query("SET LOCAL statement_timeout='10s'");
    await query("SET LOCAL lock_timeout='2s'");
    const { rows: [transaction] } = await query("SHOW transaction_read_only");
    if (transaction?.transaction_read_only !== "on") {
      result.code = "RECOVERY_READ_ONLY_NOT_CONFIRMED";
      return result;
    }
    result.observerReadOnly = true;
    const { rows: [catalog] } = await query("select to_regclass('public.payment_admin_migrations') is not null as present");
    let markers = [];
    let markerFiltered = false;
    if (catalog?.present === true) {
      const { rows: [visibility] } = await query("select pg_catalog.row_security_active('public.payment_admin_migrations'::regclass) as filtered");
      if (typeof visibility?.filtered !== "boolean") {
        result.code = "RECOVERY_MARKER_VISIBILITY_UNCONFIRMED";
        return result;
      }
      markerFiltered = visibility.filtered;
      markers = (await query("select digest from public.payment_admin_migrations where name=$1", [migration])).rows;
    } else if (catalog?.present !== false) {
      result.code = "RECOVERY_CATALOG_EVIDENCE_INVALID";
      return result;
    }
    if (markers.length === 1 && markers[0].digest === digest) {
      result.state = "commitverified";
      result.markerVerified = true;
      result.code = "RECOVERY_COMMIT_VERIFIED";
    } else if (markers.length) {
      result.code = "RECOVERY_MARKER_CONFLICT";
    } else if (markerFiltered) {
      result.code = "RECOVERY_MARKER_VISIBILITY_UNCONFIRMED";
    } else if (result.writerStoppedVerified) {
      result.state = "notapplied";
      result.code = "RECOVERY_NOT_APPLIED_VERIFIED";
    } else {
      result.code = "RECOVERY_WRITER_UNRESOLVED";
    }
    if (originalManifest) {
      let actual = await readManifest(observer, { original: originalManifest });
      if (result.markerVerified) actual = migrationPreservationManifest(originalManifest, actual, migration);
      result.originalRecordsPreserved = compareManifests(originalManifest, actual, { allowAdditionalReceipts: true }).length === 0;
      result.preservationChecked = true;
      if (!result.originalRecordsPreserved) result.code = "RECOVERY_PRESERVATION_FAILED";
    }
  } catch {
    // An exact marker remains commit evidence even if a later preservation query fails.
    result.code = "RECOVERY_OBSERVATION_FAILED";
  } finally {
    if (observer) {
      result.observerClosed = await closeMigrationConnection(observer);
      observer.removeListener?.("error", ignoreConnectionError);
    }
  }
  return result;
}
