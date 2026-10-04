// ESCRITURA LOCAL: existing fictitious Auth lab only; no private production config.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { applyPaymentMigration } from '../ops/apply-payment-migration.mjs';
import { compareManifests, databaseManifest } from '../ops/database-manifest.mjs';
import { postgresClient } from '../ops/private-config.mjs';

const labOptions = { host: '127.0.0.1', port: 54327, database: 'hpe_auth_lab', user: 'postgres',
  password: 'hpe-local-auth-fixture-only', connectionTimeoutMillis: 3000, statement_timeout: 15000 };
const legacy = ['--legacy-guard=yes', '--legacy-source-guard=yes'].includes(process.argv[2]);
const legacyContainer = process.argv[2] === '--legacy-source-guard=yes' ? 'hpe-admin-lab-034' : 'hpe-admin-lab-034-before';
const fixtureUrl = new URL(`postgresql://fixture:unused@db.fixture.supabase.co/${legacy ? 'hpe_lab' : 'hpe_auth_lab'}`);
const args = { target: 'production', backup: 'in-memory-fictitious-proof-only',
  'cutover-authorized': 'yes', 'backup-confirmed-in-chat': 'yes' };
let checks = 0;
let stage = 'guard';
const check = (value, label) => { assert.ok(value, label); checks++; };
function labClient(readOnly = false) {
  return legacy ? postgresClient(new URL('postgresql://postgres:hpe-local-fixture-only@127.0.0.1:5432/hpe_lab'),
    { readOnly, labContainer: legacyContainer })
    : new pg.Client({ ...labOptions, options: readOnly ? '-c default_transaction_read_only=on' : undefined });
}
const operator = labClient();
let concurrent;
const clients = [];

async function snapshot(original) {
  await operator.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { return await databaseManifest(operator, original ? { original } : undefined); }
  finally { await operator.query('ROLLBACK'); }
}

function preservation(before, after) {
  for (const table of before.tables) {
    const actual = after.tables.find((item) => item.schema === table.schema && item.name === table.name);
    check(!!actual, 'ORIGINAL_TABLE_RETAINED');
    const counts = new Map();
    for (const row of actual.rows) {
      const key = JSON.stringify([row.key, row.hash]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const row of table.rows) {
      const key = JSON.stringify([row.key, row.hash]);
      check((counts.get(key) ?? 0) > 0, 'ORIGINAL_ROW_CONTENT_RETAINED');
      counts.set(key, counts.get(key) - 1);
    }
  }
}

function dependencies(baseline, { onLock } = {}) {
  const report = [];
  const events = [];
  const sqlFailures = [];
  let differences;
  let protectedManifest;
  return { report, events, sqlFailures, differences: () => differences, protected: () => protectedManifest,
    options: {
      loadConfig: () => ({ config: { EXPECTED_PROJECT_REF: 'fixture' }, url: fixtureUrl, passphrase: 'unused-fixture' }),
      // Exercise production-shaped orchestration; backup decryption itself is tested separately.
      readBackup: async () => baseline,
      createClient: (url, options) => {
        check(url.href === fixtureUrl.href, 'ONLY_RESERVED_FIXTURE_URL_ACCEPTED');
        const client = labClient(options.readOnly);
        clients.push(client);
        const query = client.query.bind(client);
        client.query = async (input, values) => {
          const text = typeof input === 'string' ? input : input.text;
          if (text.startsWith('LOCK TABLE')) { events.push('lock'); onLock?.(); }
          if (text.includes('create extension if not exists pgcrypto')) events.push('migration');
          if (text === 'COMMIT') events.push('commit');
          try { return await query(input, values); }
          catch (error) {
            sqlFailures.push({ phase: text.startsWith('LOCK TABLE') ? 'lock' : 'other',
              code: /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : 'OTHER_FIXED_SQL_ERROR' });
            throw error;
          }
        };
        return client;
      },
      readManifest: async (client, options) => {
        events.push('manifest');
        const value = await databaseManifest(client, options);
        if (!options) {
          protectedManifest = value;
          differences = compareManifests(baseline, value,
            { allowAdditionalReceipts: true, compareMetadata: true, compareInventory: true });
        }
        return value;
      },
      report: { log: (value) => report.push(JSON.parse(value)), error: (value) => report.push(JSON.parse(value)) },
    } };
}

try {
  check(process.argv.length === 3 && ['--local-guard=yes', '--legacy-guard=yes', '--legacy-source-guard=yes'].includes(process.argv[2]), 'EXPLICIT_LOCAL_GUARD_REQUIRED');
  if (legacy) {
    const format = '{"project":{{json (index .Config.Labels "codex.project")}},"source":{{json (index .Config.Labels "codex.recovery.source")}},'
      + '"disposable":{{json (index .Config.Labels "codex.recovery.disposable")}},"network":{{json .HostConfig.NetworkMode}}}';
    const metadata = JSON.parse(execFileSync('docker', ['--host', 'npipe:////./pipe/dockerDesktopLinuxEngine', 'inspect',
      '--format', format, legacyContainer], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
    check(metadata.project === 'hpe-admin-030' && metadata.network === 'none'
      && (legacyContainer === 'hpe-admin-lab-034' || (metadata.source === 'hpe-admin-lab-034'
        && metadata.disposable === 'true')), 'EXISTING_OFFLINE_LEGACY_FIXTURE_REQUIRED');
  }
  await operator.connect();
  const { rows: [identity] } = await operator.query('select current_database() as database');
  check(identity.database === (legacy ? 'hpe_lab' : 'hpe_auth_lab'), 'EXACT_FICTITIOUS_DATABASE_REQUIRED');
  const sql = await fs.readFile('supabase/migrations/202609190001_payment_and_admin_hardening.sql', 'utf8');
  const digest = createHash('sha256').update(sql).digest('hex');
  const { rows: [catalog] } = await operator.query("select to_regclass('public.payment_admin_migrations') is not null as present");
  if (legacy) check(catalog.present === false, 'LEGACY_FIXTURE_HAS_NO_MIGRATION_MARKER');
  else {
    const { rows: marker } = await operator.query("select digest from public.payment_admin_migrations where name='payment-admin-hardening-v0.3.0'");
    check(marker.length === 1 && marker[0].digest === digest, 'SAME_EXISTING_MIGRATION_REQUIRED');
  }
  const original = await snapshot();

  stage = 'receipt-lock-race';
  const baseline = await snapshot();
  concurrent = labClient();
  await concurrent.connect();
  await concurrent.query('BEGIN');
  const receiptId = randomUUID();
  await concurrent.query(legacy ? 'insert into public.webhook_events(id,raw) values($1,$2::jsonb)'
    : `insert into public.webhook_events(id,raw,record_kind,processing_state)
    values($1,$2::jsonb,'receipt','queued')`, [receiptId,
    JSON.stringify({ receipt_version: '1', fixture: 'local-migration-guard-only' })]);
  let signalLock;
  const lockIssued = new Promise((resolve) => { signalLock = resolve; });
  const fixture = dependencies(baseline, { onLock: signalLock });
  const pending = applyPaymentMigration(args, fixture.options);
  // Attach a rejection handler immediately while the writer deliberately holds its lock.
  const outcome = pending.then(() => ({ ok: true }), () => ({ ok: false }));
  let lockTimer;
  try {
    await Promise.race([lockIssued, new Promise((_, reject) => {
      lockTimer = setTimeout(() => reject(new Error('LOCK_NOT_REACHED')), 10000);
    })]);
  } finally { clearTimeout(lockTimer); }
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(!fixture.events.includes('manifest') && !fixture.events.includes('migration'), 'CHECK_AND_DDL_WAIT_FOR_LOCK');
  await concurrent.query('COMMIT');
  check((await outcome).ok, 'REAL_SQL_MIGRATION_WITH_CONCURRENT_RECEIPT_PASSED');
  const { rows: applied } = await operator.query("select digest from public.payment_admin_migrations where name='payment-admin-hardening-v0.3.0'");
  check(applied.length === 1 && applied[0].digest === digest, 'COMMITTED_MIGRATION_MARKER_MATCHES_SQL');
  check((await operator.query('select public.payment_admin_schema_ready() as ready')).rows[0].ready === true,
    'COMMITTED_SCHEMA_READY');
  const protectedReceipt = fixture.protected().tables.find((table) => table.schema === 'public' && table.name === 'webhook_events');
  check(protectedReceipt.rows.some((row) => row.key?.includes(receiptId)), 'AFTER_BACKUP_RECEIPT_INCLUDED_IN_PROTECTED_BASELINE');
  check(fixture.events.filter((event) => event === 'commit').length === 1, 'SINGLE_COMMIT');
  check(fixture.report[0].verified === true && fixture.report[0].keepCutover === true, 'VERIFIED_BUT_CUTOVER_RETAINED');
  await concurrent.end();
  concurrent = undefined;

  stage = 'unbacked-row';
  const beforeAddition = await snapshot();
  const auditId = randomUUID();
  await operator.query("insert into public.audit_logs(id,action,details) values($1,'fixture_migration_guard',$2::jsonb)",
    [auditId, JSON.stringify({ fixture: 'local-only-append-retained' })]);
  const drift = dependencies(beforeAddition);
  let rejected = false;
  try { await applyPaymentMigration(args, drift.options); } catch { rejected = true; }
  check(rejected && !drift.events.includes('migration') && !drift.events.includes('commit'), 'UNBACKED_ROW_ABORTS_BEFORE_DDL');
  check(drift.events.includes('lock') && drift.events.includes('manifest') && drift.sqlFailures.length === 0
    && drift.differences()?.length === 1 && drift.differences()[0].table === 'public.audit_logs'
    && drift.differences()[0].kind === 'row_difference' && drift.differences()[0].missing === 0
    && drift.differences()[0].added === 1, 'EXACT_UNBACKED_AUDIT_ROW_CAUSED_THE_REJECTION');
  check(drift.report[0].verified === false && drift.report[0].automaticRetry === false, 'DRIFT_FAILURE_NEVER_RETRIES');
  check((await operator.query('select count(*)::int as count from public.audit_logs where id=$1', [auditId])).rows[0].count === 1,
    'UNBACKED_FIXTURE_ROW_NOT_DELETED');

  stage = 'lock-timeout';
  const beforeTimeout = await snapshot();
  concurrent = labClient();
  await concurrent.connect();
  await concurrent.query('BEGIN');
  await concurrent.query('LOCK TABLE public.webhook_events IN ROW EXCLUSIVE MODE');
  const timeout = dependencies(beforeTimeout);
  rejected = false;
  try { await applyPaymentMigration(args, timeout.options); } catch { rejected = true; }
  check(rejected && !timeout.events.includes('manifest') && !timeout.events.includes('migration')
    && !timeout.events.includes('commit'), 'REAL_LOCK_TIMEOUT_BLOCKS_ALL_DDL');
  check(timeout.events.includes('lock') && timeout.sqlFailures.some((failure) => failure.phase === 'lock'
    && failure.code === '55P03'), 'POSTGRES_CONFIRMED_LOCK_TIMEOUT');
  check(timeout.report[0].automaticRetry === false && timeout.report[0].keepCutover === true, 'TIMEOUT_RETAINS_CUTOVER');
  await concurrent.query('ROLLBACK');
  await concurrent.end();
  concurrent = undefined;

  stage = 'preservation';
  const final = await snapshot(original);
  preservation(original, final);
  console.log(JSON.stringify({ operation: 'migration_guard_local_e2e', passed: true, checks,
    fixtureOnly: true, backupProof: 'in-memory-fixture', migrationKind: legacy ? 'initial' : 'reapply',
    concurrentReceiptPreserved: true, driftBlockedBeforeDdl: true, lockTimeoutBlockedBeforeDdl: true,
    originalTables: original.tables.length, originalRows: original.tables.reduce((sum, table) => sum + table.count, 0),
    originalRowsPreserved: true, newFictitiousRowsRetained: 2, productionConnections: 0 }));
} catch (error) {
  console.error(JSON.stringify({ operation: 'migration_guard_local_e2e', passed: false, stage, checks,
    failure: error?.name === 'AssertionError' ? error.message : 'LOCAL_GUARD_CHECK_FAILED' }));
  process.exitCode = 1;
} finally {
  if (concurrent) { await concurrent.query('ROLLBACK').catch(() => {}); await concurrent.end().catch(() => {}); }
  for (const client of clients) await client.end().catch(() => {});
  await operator.end().catch(() => {});
}
