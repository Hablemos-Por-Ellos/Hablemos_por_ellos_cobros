// @vitest-environment node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Duplex } from 'node:stream';
import pg from 'pg';
import { test, vi } from 'vitest';
import { fixtureArguments, fixtureConnection, runFixtureConcurrency } from './admin_revocation_concurrency.mjs';
import { reconcileWompiReceipts } from '../../scripts/wompi-receipt-runner.mjs';

const dockerTransport = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock('../../scripts/ops/local-docker-stream.mjs', () => ({ localDockerStream: dockerTransport.factory }));

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const migration = read('../migrations/202609190001_payment_and_admin_hardening.sql');
const preflight = read('../preflight/payment_admin_preflight.sql');
const postflight = read('../postflight/payment_admin_postflight.sql');
const fixture = read('./base_schema.sql');
const smoke = read('./hardening_smoke.sql');
const regression = read('./migration_regression.psql');
const evidence = read('./legacy_evidence_regression.psql');
const snapshotSmoke = read('./snapshot_membership_smoke.sql');
const recoverySmoke = read('./admin_recovery_smoke.sql');
const concurrency = read('./admin_revocation_concurrency.mjs');
const historySmoke = read('./historical_reconciliation_smoke.sql');
const historyCliSmoke = read('./historical_cli_sql_smoke.mjs');

function sqlPrograms(directory = new URL('../', import.meta.url)) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) return sqlPrograms(path);
    return entry.isFile() && /\.(sql|psql)$/i.test(entry.name) ? [path] : [];
  });
}

// Lexical validation only: never connects to Postgres or evaluates SQL.
function lexical(sql) {
  const dollars = [];
  let clean = '';
  let depth = 0;
  let outer = '';
  for (let i = 0; i < sql.length;) {
    if (sql.slice(i, i + 2) === '--') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
    } else if (sql.slice(i, i + 2) === '/*') {
      const end = sql.indexOf('*/', i + 2);
      assert.ok(end >= 0, 'Unclosed SQL comment');
      i = end + 2;
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      let closed = false;
      while (i < sql.length) {
        if (sql[i++] === quote) {
          if (sql[i] === quote) i++;
          else { closed = true; break; }
        }
      }
      assert.ok(closed, 'Unclosed SQL literal');
      clean += ' '; if (!dollars.length) outer += ' ';
    } else if (sql[i] === '$' && /^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)[0];
      if (dollars.at(-1) === tag) dollars.pop(); else dollars.push(tag);
      i += tag.length;
    } else {
      const char = sql[i++];
      if (char === '(') depth++;
      if (char === ')') depth--;
      assert.ok(depth >= 0, 'Unexpected closing parenthesis');
      clean += char;
      if (!dollars.length) outer += char;
    }
  }
  assert.equal(depth, 0, 'Unbalanced SQL parentheses');
  assert.equal(dollars.length, 0, 'Unclosed dollar quote');
  return { clean, outer };
}

test('all SQL files are lexically balanced', () => {
  for (const path of sqlPrograms()) lexical(readFileSync(path, 'utf8'));
});
test('all snapshot guards select scalar booleans instead of comparing text to text[] subquery rows', () => {
  for (const [column, table] of [
    ['provider_effective_at','payments'], ['billing_review_required','payments'],
    ['event_key','webhook_events'], ['record_kind','webhook_events'], ['processing_state','webhook_events'],
  ]) {
    assert.match(migration, new RegExp(`if not coalesce\\(\\(select '${column}' = any\\(columns\\)\\s+from pg_temp\\.payment_admin_original_schema where table_name = '${table}'\\), false\\) then`));
  }
  for (const path of sqlPrograms()) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /\bany\s*\(\s*\(*\s*select\b/i,
      `ANY(subquery) array ambiguity in ${path.pathname}`);
  }
});
test('parent SQL regression exercises absent/present columns, missing snapshots and NULL/empty arrays', () => {
  assert.match(snapshotSmoke, /SNAPSHOT_ABSENT_COLUMN_GUARD_FAILED/);
  assert.match(snapshotSmoke, /SNAPSHOT_PRESENT_COLUMN_GUARD_FAILED/);
  assert.match(snapshotSmoke, /SNAPSHOT_MISSING_OR_NULL_GUARD_FAILED/);
  assert.match(regression, /\\ir snapshot_membership_smoke\.sql/);
});
test('one migration transaction, bounded locks/statements, digest before COMMIT', () => {
  const { outer } = lexical(migration);
  assert.equal((outer.match(/\bbegin\s*;/gi) ?? []).length, 1);
  assert.equal((outer.match(/\bcommit\s*;/gi) ?? []).length, 1);
  assert.match(migration, /lock_timeout = '5s'/);
  assert.match(migration, /statement_timeout = '120s'/);
  assert.match(migration, /app\.migration_digest/);
  assert.match(migration, /MIGRATION_DIGEST_MISMATCH/);
  assert.ok(migration.lastIndexOf('MIGRATION_MARKER_ASSERTION_FAILED') < migration.lastIndexOf('commit;'));
});
test('no destructive row/table operations or historic RAW rewrite', () => {
  assert.doesNotMatch(lexical(migration).clean, /^\s*(?:delete\s+from|truncate\s|drop\s+table)\b/gim);
  assert.doesNotMatch(migration, /\b(?:set|do update set)\s+raw\s*=/i);
  assert.match(migration, /PRESERVATION_FAILED_PRIMARY_KEY/);
  assert.match(migration, /PRESERVATION_FAILED_CONTENT/);
  assert.match(migration, /v_digest <> v_original\.content_digest/);
});
test('only core hashing/UUIDs; fixture installs pgcrypto under extensions', () => {
  assert.doesNotMatch(migration, /\b(?:digest|gen_random_bytes)\s*\(/i);
  assert.match(migration, /sha256\(convert_to/);
  assert.match(fixture, /pgcrypto with schema extensions/);
});
test('legacy timestamp backfill never uses creation/update/now as approval', () => {
  const backfill = migration.slice(migration.indexOf('-- Only an existing finite'), migration.indexOf('alter table public.webhook_events'));
  assert.match(backfill, /set provider_effective_at = approved_at/);
  assert.doesNotMatch(backfill, /\b(?:created_at|updated_at|now\(\))/);
  assert.doesNotMatch(migration, /provider_effective_at set (?:default|not null)/);
  assert.doesNotMatch(migration, /coalesce\(approved_at, created_at\)/);
});
test('NULL effective dates persist payment and fail closed on schedule/claim', () => {
  const body = migration.slice(migration.indexOf('create or replace function public.apply_verified_wompi_event'), migration.indexOf('drop function if exists public.admin_reconcile'));
  const validation = body.slice(body.indexOf('begin'), body.indexOf('insert into public.webhook_events'));
  assert.doesNotMatch(validation, /or p_effective_at is null/);
  assert.match(body, /p_status = 'approved' and p_effective_at is null/);
  assert.match(body, /and p_effective_at is not null/);
  assert.match(migration, /PAYMENT_DATE_OR_RESULT_NEEDS_REVIEW/);
  assert.match(body, /v_attempt\.subscription_version is not null/);
  assert.match(body, /v_subscription\.status not in \('cancelled','canceled'\)/);
});
test('canonical/receipt uniqueness are disjoint and canonical RAW never overwritten', () => {
  assert.match(migration, /on public\.webhook_events\(event_key\) where record_kind = 'canonical'/);
  assert.match(migration, /on public\.webhook_events\(event_key\) where record_kind = 'receipt'/);
  assert.match(migration, /on conflict \(event_key\) where record_kind = 'canonical' do nothing/);
  assert.match(migration, /WEBHOOK_EVIDENCE_IMMUTABLE/);
});
test('receipt marking occurs in duplicate, review and successful paths', () => {
  const body = migration.slice(migration.indexOf('create or replace function public.apply_verified_wompi_event'), migration.indexOf('drop function if exists public.admin_reconcile'));
  assert.ok((body.match(/perform public\.mark_wompi_receipt/g) ?? []).length >= 6);
  assert.match(migration, /p_raw ->> 'receipt_id'/);
  assert.match(smoke, /Early duplicate did not mark receipt/);
  assert.match(smoke, /Early review return did not mark receipt/);
});
test('historical metadata enrichment never mutates subscriptions/attempts/intents and accepts new evidence for review/legacy keys', () => {
  const body = migration.slice(migration.indexOf('create or replace function public.apply_verified_wompi_event'),
    migration.indexOf('drop function if exists public.admin_reconcile'));
  const historical = body.slice(body.indexOf('if v_historical_payment then'),
    body.indexOf('if v_payment.id is null and v_attempt.id is null and v_intent.id is null'));
  assert.doesNotMatch(body, /if v_event\.processing_state = 'needs_review' then/);
  assert.doesNotMatch(body, /if v_legacy_applied and v_payment\.id is not null then/);
  assert.match(historical, /update public\.payments set status = p_status, reference = coalesce\(reference,p_reference\)/);
  assert.match(historical, /approved_at = case when p_status = 'approved' then v_historical_effective/);
  assert.match(historical, /perform public\.mark_wompi_receipt\(p_raw,v_historical_result,v_historical_reason\)/);
  assert.doesNotMatch(historical, /(?:update|insert into) public\.(?:subscriptions|payment_attempts|checkout_intents)/);
  assert.doesNotMatch(historical, /\b(?:created_at|updated_at|now\(\))/);
  assert.match(historical, /char_length\(p_reference\) = char_length\(v_subscription\.reference\) \+ 7/);
  assert.match(historical, /substring\(right\(p_reference,6\) from 5 for 2\)::integer between 1 and 12/);
  assert.ok(body.indexOf('WOMPI_EVENT_HISTORICAL_PAYMENT_MISMATCH') < body.indexOf("if v_event.processing_state = 'processed'"));
  for (const marker of ['LEGACY_APPLIED_OR_REVIEW_KEY_BLOCKED_VERIFIED_METADATA',
    'OLD_CANONICAL_LEGACY_MARKER_BLOCKED_VALID_REFERENCE_ENRICHMENT','HISTORICAL_REFERENCE_ACCEPTED_INVALID_MONTH',
    'HISTORICAL_REFERENCE_ACCEPTED_PREFIX_COLLISION','HISTORICAL_LEGACY_RAW_OR_STATE_CHANGED',
    'VERIFIED_HISTORICAL_PAYMENT_LEFT_MONTHLY_CLAIM_PERMANENTLY_BLOCKED']) assert.ok(historySmoke.includes(marker));
});
test('verified historical declined/error/voided clear review without approval dates; APPROVED never degrades', () => {
  const body = migration.slice(migration.indexOf('if v_historical_payment then'),
    migration.indexOf('if v_payment.id is null and v_attempt.id is null and v_intent.id is null'));
  assert.match(body, /v_historical_reason := case when p_status = 'pending' then 'HISTORICAL_PAYMENT_PENDING'\s+when p_status = 'approved' and v_historical_effective is null then/);
  assert.match(body, /v_payment\.status is not null and v_payment\.status <> 'pending' and v_payment\.status <> p_status/);
  assert.match(body, /billing_review_required = v_historical_reason is not null/);
  for (const marker of ['UNDATED_VERIFIED_TERMINAL_REMAINED_BLOCKED','PREEXISTING_TERMINAL_REVIEW_FLAG_WAS_NOT_CLEARED',
    'REPEATED_TERMINAL_KEY_LEFT_ALL_CHARGES_BLOCKED_OR_CHANGED_RAW','APPROVED_HISTORY_REGRESSED_TO_UNDATED_TERMINAL']) {
    assert.ok(historySmoke.includes(marker));
  }
  assert.match(historySmoke, /foreach v_status in array array\['declined','error','voided'\]/);
});
test('changed source is allowed only for known unbound history with a matching service-verified TX descriptor', () => {
  const start = migration.indexOf('if v_historical_payment then');
  const body = migration.slice(start,migration.indexOf('if v_payment.id is null and v_attempt.id is null and v_intent.id is null',start));
  assert.match(body, /v_payment\.payment_attempt_id is not null or v_attempt\.id is not null or v_intent\.id is not null/);
  assert.match(body, /exists\(select 1 from public\.checkout_intents where reference = p_reference\)/);
  for (const [path,value] of [['id','p_transaction_id'],['reference','p_reference'],['currency','p_currency']]) {
    assert.ok(body.includes(`p_raw #>> '{transaction,${path}}' is distinct from ${value}`));
  }
  assert.match(body, /WOMPI_EVENT_HISTORICAL_SOURCE_EVIDENCE_MISMATCH/);
  assert.match(body, /payment_source_id}' is distinct from p_payment_source_id/);
  assert.match(body, /payment_source,id}' is distinct from p_payment_source_id/);
  assert.match(migration.slice(migration.indexOf('if v_subscription.frequency = \'monthly\' and (',start)),
    /v_subscription\.wompi_payment_source_id <> p_payment_source_id/);
  assert.match(migration, /revoke all on function public\.apply_verified_wompi_event\([^;]+from public, anon, authenticated/);
  for (const marker of ['HISTORICAL_SOURCE_ACCEPTED_UNVERIFIED_OR_UNRELATED_TX_SOURCE','VERIFIED_OLD_SOURCE_WAS_REPLACED_OR_BLOCKED',
    'ATTEMPT_INTENT_OR_NEW_PAYMENT_LOST_SOURCE_BINDING','REJECTED_SOURCE_BINDING_MUTATED_PAYMENTS']) assert.ok(historySmoke.includes(marker));
});
test('schedule advancement uses explicit manual audit decisions relative to actual approvals, not billing version or creation dates', () => {
  const body = migration.slice(migration.indexOf('create or replace function public.advance_subscription_schedule'),
    migration.indexOf('create or replace function public.mark_subscription_past_due'));
  assert.match(body, /select max\(coalesce\(approved_at,provider_effective_at\)\) into v_last_approval/);
  assert.match(body, /a\.action in \('schedule','reactivate'\)/);
  assert.match(body, /v_last_approval is null or a\.created_at >= v_last_approval/);
  assert.match(body, /ADMIN_SCHEDULE_PROTECTED/);
  assert.doesNotMatch(body, /billing_version\s*>\s*0|coalesce\(approved_at,\s*created_at\)|max\(created_at\)/);
  for (const marker of ['NON_MANUAL_BILLING_VERSION_BLOCKED_SCHEDULE_ADVANCE',
    'CURRENT_VERSION_OVERWROTE_PREVIOUS_ADMIN_SCHEDULE','HISTORICAL_REPLAY_MOVED_MANUAL_FUTURE_SCHEDULE',
    'NEW_VERIFIED_APPROVAL_DID_NOT_RELEASE_OLDER_MANUAL_GUARD']) assert.ok(historySmoke.includes(marker));
});
test('CLI durable receipt retry carries verified historical amount/reference/date to the existing SQL RPC (mock transport only)', async () => {
  const row = { id: '60000000-0000-0000-0000-000000000090', processing_state: 'received', raw: {
    receipt_version: 1, event: 'transaction.updated', environment: 'sandbox', event_timestamp: null,
    transaction: { id: 'tx-historic-10000', reference: 'HPE-LEGACY', amount_in_cents: 1000000,
      currency: 'COP', status: 'APPROVED', finalized_at: null, payment_source_id: 'fixture-legacy-source' },
    checksum: 'fixture', body_sha256: 'fixture', received_at: '2026-10-03T12:00:00Z',
  } };
  const originalRaw = JSON.stringify(row.raw);
  const payment = { id: '70000000-0000-0000-0000-000000000090',
    subscription_id: '20000000-0000-0000-0000-000000000090', wompi_transaction_id: 'tx-historic-10000',
    amount: 10000, currency: 'COP', status: 'approved', reference: null, approved_at: null,
    provider_effective_at: null, payment_attempt_id: null, billing_review_required: true };
  const subscription = { id: payment.subscription_id, amount: 25000, currency: 'COP', status: 'active',
    reference: 'HPE-LEGACY', frequency: 'monthly', wompi_payment_source_id: 'fixture-current-new-source',
    next_payment_date: '2026-12-16T12:00:00Z', billing_version: 1 };
  const supabase = { from(table) {
    let offset = 0;
    const rows = () => table === 'webhook_events' ? (row.processing_state !== 'processed' && offset === 0 ? [row] : [])
      : table === 'payments' ? [payment] : table === 'subscriptions' ? [subscription] : [];
    const query = { select() { return query; }, in() { return query; }, order() { return query; },
      eq() { return query; }, limit() { return query; }, range(start) { offset = start; return query; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve,reject) => Promise.resolve({ data: rows(), error: null }).then(resolve,reject) };
    return query;
  }, rpc: vi.fn(async (name,params) => {
    assert.equal(name,'apply_verified_wompi_event');
    const result = params.p_effective_at ? 'processed' : 'review';
    row.processing_state = result === 'processed' ? 'processed' : 'needs_review';
    return { data: { result }, error: null };
  }) };
  const getTransaction = vi.fn(async () => ({ id: 'tx-historic-10000', reference: 'HPE-LEGACY',
    amountInCents: 1000000, currency: 'COP', status: 'approved', finalizedAt: null, paymentSourceId: 'fixture-legacy-source' }));
  const logger = { error: vi.fn() };
  assert.deepEqual(await reconcileWompiReceipts({ supabase,getTransaction,logger }),
    { received: 1, processed: 0, review: 1, failed: 0 });
  getTransaction.mockResolvedValue({ id: 'tx-historic-10000', reference: 'HPE-LEGACY',
    amountInCents: 1000000, currency: 'COP', status: 'approved', finalizedAt: '2026-09-19T15:00:00Z', paymentSourceId: 'fixture-legacy-source' });
  assert.deepEqual(await reconcileWompiReceipts({ supabase,getTransaction,logger }),
    { received: 1, processed: 1, review: 0, failed: 0 });
  const params = supabase.rpc.mock.calls[1][1];
  assert.equal(params.p_transaction_id,'tx-historic-10000');
  assert.equal(params.p_reference,'HPE-LEGACY');
  assert.equal(params.p_amount,10000);
  assert.equal(params.p_currency,'COP');
  assert.equal(params.p_status,'approved');
  assert.equal(params.p_payment_source_id,'fixture-legacy-source');
  assert.notEqual(params.p_payment_source_id,subscription.wompi_payment_source_id);
  assert.equal(params.p_effective_at,'2026-09-19T15:00:00.000Z');
  assert.equal(params.p_raw.receipt_id,row.id);
  assert.equal(JSON.stringify(row.raw),originalRaw);
  assert.equal(logger.error.mock.calls.length,0);
  assert.match(historySmoke, /pg_temp\.history_apply\('history-review-key','tx-historic-10000','HPE-LEGACY',v_receipt,'2026-09-19T15:00:00Z',p_source => 'fixture-legacy-source'\)/);
});
test('CLI handles terminal GET with NULL finalized date and old PENDING receipt, then repeated keys without global charge blocking (mock transport)', async () => {
  for (const status of ['declined','error','voided']) {
    const tx = `tx-cli-terminal-${status}`;
    const row = { id: '60000000-0000-0000-0000-000000000034',processing_state: 'needs_review',raw: {
      receipt_version: 1,event: 'transaction.updated',environment: 'sandbox',event_timestamp: 1789844400,
      transaction: { id: tx,reference: 'HPE-LEGACY',amount_in_cents: 1000000,currency: 'COP',status: 'PENDING',
        finalized_at: null,payment_source_id: 'fixture-legacy-source' },
      checksum: 'fixture',body_sha256: 'fixture',received_at: '2026-10-03T12:00:00Z',
    } };
    const raw = JSON.stringify(row.raw);
    const payment = { id: '70000000-0000-0000-0000-000000000034',wompi_transaction_id: tx,
      subscription_id: '20000000-0000-0000-0000-000000000090',amount: 10000,currency: 'COP',status,
      reference: 'HPE-LEGACY',approved_at: null,provider_effective_at: null,payment_attempt_id: null,billing_review_required: true };
    const subscription = { id: payment.subscription_id,amount: 25000,currency: 'COP',status: 'active',frequency: 'monthly',
      reference: 'HPE-LEGACY',wompi_payment_source_id: 'fixture-current-new-source',next_payment_date: '2026-12-16T12:00:00Z' };
    const supabase = { from(table) {
      let offset = 0;
      const rows = () => table === 'webhook_events' ? (row.processing_state !== 'processed' && offset === 0 ? [row] : [])
        : table === 'payments' ? [payment] : table === 'subscriptions' ? [subscription] : [];
      const query = { select() { return query; },in() { return query; },order() { return query; },eq() { return query; },
        limit() { return query; },range(start) { offset = start; return query; },
        maybeSingle: async () => ({ data: rows()[0] ?? null,error: null }),single: async () => ({ data: rows()[0] ?? null,error: null }),
        then: (resolve,reject) => Promise.resolve({ data: rows(),error: null }).then(resolve,reject) };
      return query;
    },rpc: vi.fn(async (name,p) => {
      assert.equal(name,'apply_verified_wompi_event');
      assert.equal(p.p_transaction_id,tx);
      assert.equal(p.p_status,status);
      assert.equal(p.p_reference,'HPE-LEGACY');
      assert.equal(p.p_amount,10000);
      assert.equal(p.p_currency,'COP');
      assert.equal(p.p_effective_at,null,'Old PENDING event timestamp is not a finalized date');
      assert.equal(p.p_payment_source_id,'fixture-legacy-source');
      const result = payment.billing_review_required ? 'processed' : 'duplicate';
      payment.billing_review_required = false;
      row.processing_state = 'processed';
      return { data: { result },error: null };
    }) };
    const getTransaction = vi.fn(async () => ({ id: tx,reference: 'HPE-LEGACY',amountInCents: 1000000,currency: 'COP',
      status,finalizedAt: null,paymentSourceId: 'fixture-legacy-source' }));
    const logger = { error: vi.fn() };
    const resolved = { received: 1,processed: 1,review: 0,failed: 0 };
    assert.deepEqual(await reconcileWompiReceipts({ supabase,getTransaction,logger }),resolved);
    row.processing_state = 'needs_review';
    assert.deepEqual(await reconcileWompiReceipts({ supabase,getTransaction,logger }),resolved);
    assert.equal(supabase.rpc.mock.calls[0][1].p_event_key,supabase.rpc.mock.calls[1][1].p_event_key);
    assert.deepEqual(await reconcileWompiReceipts({ supabase,getTransaction,logger }),{ received: 0,processed: 0,review: 0,failed: 0 });
    assert.equal(JSON.stringify(row.raw),raw);
    assert.equal(payment.billing_review_required,false);
    assert.equal(payment.approved_at,null);
    assert.equal(payment.provider_effective_at,null);
    assert.equal(subscription.wompi_payment_source_id,'fixture-current-new-source');
    assert.equal(logger.error.mock.calls.length,0);
  }
});
test('parent CLI-to-SQL engine test has an explicit fixture target, real RPC binding and rollback-only writes', () => {
  assert.match(historyCliSmoke, /new pg\.Client\(fixtureConnection\(input, \{ labContainer \}\)\)/);
  assert.match(historyCliSmoke, /current_database\(\) = 'hpe_lab'/);
  assert.match(historyCliSmoke, /table_schema = 'auth' and table_name = 'users'\) = 2/);
  assert.match(historyCliSmoke, /select public\.apply_verified_wompi_event\(/);
  assert.match(historyCliSmoke, /p\.p_amount,p\.p_currency,p\.p_status,p\.p_effective_at,p\.p_candidate_next_payment,p\.p_raw/);
  assert.match(historyCliSmoke, /await client\.query\('begin'\)/);
  assert.match(historyCliSmoke, /await client\.query\('rollback'\)/);
  assert.match(historyCliSmoke, /CLI_HISTORICAL_ENRICHMENT_CHANGED_ADMIN_SCHEDULE/);
  assert.match(historyCliSmoke, /CLI_REPLACED_VERIFIED_HISTORICAL_SOURCE/);
  assert.match(historyCliSmoke, /wompi_payment_source_id = 'fixture-current-new-source'/);
  assert.match(historyCliSmoke, /for \(const status of \['declined','error','voided'\]\)/);
  assert.match(historyCliSmoke, /assert\.equal\(terminal\.billing_review_required,false\)/);
  assert.doesNotMatch(historyCliSmoke, /process\.env|dotenv|spawn\(|execSync|query\('commit'\)|delete from|truncate |drop table/i);
  assert.match(historyCliSmoke, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
});
test('admin revocation/context/version gates are shared and audited', () => {
  assert.match(migration, /sessions_valid_after timestamptz not null default timestamptz '1970-01-01/);
  assert.match(migration, /date_trunc\('second', p_actor_session_issued_at\) > sessions_valid_after/);
  assert.ok((migration.match(/perform public\.assert_admin_mutation_context/g) ?? []).length === 3);
  assert.ok((migration.match(/ADMIN_EXPECTED_VERSION_REQUIRED/g) ?? []).length === 3);
  assert.ok((migration.match(/p_request_id, p_expected_version, p_actor_aal, p_actor_session_issued_at, p_totp_verified_at/g) ?? []).length === 3);
});
test('financial authorization holds SHARE row locks for active/role/session serialization', () => {
  const context = migration.slice(migration.indexOf('create or replace function public.assert_admin_mutation_context'),
    migration.indexOf('revoke all on function public.assert_admin_mutation_context'));
  assert.match(context, /and active and role in \('admin','super_admin'\)/);
  assert.match(context, /sessions_valid_after\s+for share;/);
  assert.doesNotMatch(context, /for key share/);
  assert.match(concurrency, /pg_blocking_pids/);
  assert.match(concurrency, /REVOKED_WAITER_MUTATION_WAS_NOT_REJECTED/);
  assert.match(concurrency, /INACTIVE_WAITER_MUTATION_WAS_NOT_REJECTED/);
  assert.match(concurrency, /OLD_SESSION_RETAINED_RLS_AFTER_CONCURRENT_REVOKE/);
});
test('logout uses the exact two server identity arguments and is service-only, audited and wall-clock based', () => {
  const body = migration.slice(migration.indexOf('create or replace function public.admin_revoke_own_sessions'),
    migration.indexOf('create or replace function public.prepare_wompi_receipt'));
  assert.match(body, /p_actor_user_id uuid, p_actor_session_issued_at timestamptz\s+\)/);
  assert.match(body, /not public\.payment_admin_schema_ready\(\)/);
  assert.match(body, /where user_id = p_actor_user_id for update/);
  assert.match(body, /v_now := clock_timestamp\(\)/);
  assert.match(body, /own_sessions_revoked/);
  assert.match(body, /date_trunc\('second', p_actor_session_issued_at\) <= v_admin\.sessions_valid_after/);
  assert.match(body, /revoke all on function public\.admin_revoke_own_sessions\(uuid,timestamptz\) from public, anon, authenticated/);
  assert.match(body, /grant execute on function public\.admin_revoke_own_sessions\(uuid,timestamptz\) to service_role/);
  assert.match(postflight, /POSTFLIGHT_SESSION_REVOCATION_RPC_INVALID/);
  assert.match(recoverySmoke, /REVOKED_TOKEN_RETAINED_RLS_DATA_ACCESS/);
  assert.match(recoverySmoke, /LOGOUT_ACCEPTED_OLDER_OR_SAME_SECOND_SESSION/);
});
test('recovery only rebinds an owned PENDING snapshot and permits known-ID status transitions', () => {
  const body = migration.slice(migration.indexOf('create or replace function public.admin_reconcile_payment_attempt'),
    migration.indexOf('drop function if exists public.admin_close_unidentified_payment_attempt'));
  assert.doesNotMatch(body, /if v_before\.wompi_transaction_id = p_transaction_id and v_before\.state <> 'unknown'/);
  assert.match(body, /v_before\.wompi_transaction_id is not null and v_before\.wompi_transaction_id <> p_transaction_id/);
  assert.match(body, /v_owns_version := coalesce\(v_before\.subscription_version = v_subscription\.billing_version, false\)/);
  assert.match(body, /if p_status = 'pending' and v_after\.state = 'pending' and v_owns_version/);
  assert.match(body, /subscription_version = v_subscription_after\.billing_version/);
  assert.match(body, /if v_changed then/);
  assert.match(body, /v_payment_before\.amount is distinct from p_amount/);
  assert.match(body, /ADMIN_REQUEST_ID_CONFLICT/);
  assert.match(body, /PAYMENT_RECOVERY_ADMIN_VERSION_PROTECTED/);
  assert.match(body, /PAYMENT_RECOVERY_STATUS_NOT_APPLIED/);
  assert.match(body, /if v_terminal_status is not null and v_terminal_status <> p_status then/);
  assert.doesNotMatch(body, /raise exception 'PAYMENT_RECOVERY_NOT_APPLIED'/);
  for (const marker of ['PENDING_RECOVERY_SNAPSHOT_NOT_ALIGNED','APPROVAL_AFTER_PENDING_RECOVERY_NOT_ACTIVE',
    'EXACT_RECOVERY_RETRY_REPLAYED_OR_BUMPED_VERSION','KNOWN_PENDING_ID_APPROVAL_WAS_IGNORED',
    'KNOWN_ID_BYPASSED_EXPECTED_VERSION','UNKNOWN_SAME_KNOWN_ID_RECOVERY_REJECTED',
    'APPROVED_REGRESSED_ON_PENDING_RECOVERY','PENDING_RECOVERY_REBASED_LATER_ADMIN_VERSION',
    'CANONICAL_REVIEW_ROLLED_BACK_OR_WAS_NOT_AUDITED','TERMINAL_ATTEMPT_WITHOUT_PAYMENT_REGRESSED',
    'RECOVERY_COMPARED_CURRENT_AMOUNT_NOT_ACTUAL_HISTORICAL_PAYMENT',
    'RECOVERY_OR_LATE_WEBHOOK_REACTIVATED_CANCELLED_SUBSCRIPTION']) assert.ok(recoverySmoke.includes(marker));
});
test('PENDING dates cannot become an undated APPROVED payment effective date', () => {
  assert.match(migration, /when v_apply_provider_state and p_status = 'approved' then\s+coalesce\(approved_at, p_effective_at, case when status = 'approved' then provider_effective_at end\)/);
  assert.match(recoverySmoke, /NULL_FINALIZED_RECOVERY_FABRICATED_APPROVAL_OR_AGENDA/);
  assert.match(recoverySmoke, /approved_at is null and provider_effective_at is null and billing_review_required/);
});
test('manual concurrency runner cannot load environment credentials or connect outside the explicit fixture', () => {
  const options = fixtureConnection('postgresql://fixture:fixture-only@127.0.0.1:55432/hpe_lab');
  assert.equal(options.host,'127.0.0.1');
  assert.equal(options.database,'hpe_lab');
  assert.equal(options.ssl,false);
  for (const input of ['postgresql://fixture:fixture-only@cloud.example.test:55432/hpe_lab',
    'postgresql://fixture:fixture-only@127.0.0.1:55432/postgres',
    'postgresql://fixture:fixture-only@127.0.0.1:55432/hpe_lab?options=unsafe',
    'postgresql://127.0.0.1:55432/hpe_lab']) assert.throws(() => fixtureConnection(input));
  assert.doesNotMatch(concurrency, /process\.env|dotenv|execSync|spawn\(/);
  assert.match(concurrency, /table_schema = 'auth' and table_name = 'users'\) = 2/);
  assert.match(concurrency, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
});
test('Docker transport is explicitly opted in, retains loopback guards and rejects non-lab container names', () => {
  dockerTransport.factory.mockReset();
  const url = 'postgresql://fixture:fixture-only@127.0.0.1:5432/hpe_lab';
  const options = fixtureConnection(url, { labContainer: 'hpe-admin-lab-031' });
  assert.equal(options.host,'127.0.0.1');
  assert.equal(options.database,'hpe_lab');
  assert.equal(typeof options.stream,'function');
  assert.equal('stream' in fixtureConnection(url),false);
  for (const labContainer of ['production','hpe-admin-prod-031','../hpe-admin-lab-031','',null,{}]) {
    assert.throws(() => fixtureConnection(url, { labContainer }));
  }
  assert.throws(() => fixtureConnection('postgresql://fixture:fixture-only@cloud.example.test:5432/hpe_lab',
    { labContainer: 'hpe-admin-lab-031' }));
  assert.throws(() => fixtureConnection('postgresql://fixture:fixture-only@127.0.0.1:5432/postgres',
    { labContainer: 'hpe-admin-lab-031' }));
  assert.equal(dockerTransport.factory.mock.calls.length,0,'Configuration/parsing must never execute Docker');
  assert.match(concurrency, /stream: \(\) => localDockerStream\(labContainer\)/);
  const rejectedLabel = new Error('CONTAINER_NOT_OWNED_BY_THIS_LAB');
  dockerTransport.factory.mockImplementationOnce(() => { throw rejectedLabel; });
  assert.throws(() => options.stream(), (error) => error === rejectedLabel);
  assert.deepEqual(dockerTransport.factory.mock.calls,[['hpe-admin-lab-031']]);
  dockerTransport.factory.mockReset();
});
test('CLI accepts only explicit fixture URL and optional local container with no environment fallback', () => {
  dockerTransport.factory.mockReset();
  const url = 'postgresql://fixture:fixture-only@127.0.0.1:5432/hpe_lab';
  assert.deepEqual(fixtureArguments(['--lab-url',url]),{ input: url, labContainer: undefined });
  assert.deepEqual(fixtureArguments(['--lab-url',url,'--lab-container','hpe-admin-lab-031']),
    { input: url, labContainer: 'hpe-admin-lab-031' });
  for (const args of [[],['--lab-url'],['--lab-container','hpe-admin-lab-031'],
    ['--lab-url',url,'--lab-container'],['--lab-url',url,'--other','hpe-admin-lab-031'],
    ['--lab-url',url,'--lab-container','production'],['--lab-url',url,'--lab-url',url],
    ['--lab-url',url,'--lab-container','hpe-admin-lab-031','extra']]) assert.throws(() => fixtureArguments(args));
  assert.equal(dockerTransport.factory.mock.calls.length,0);
});
test('runFixtureConcurrency constructs a separate mocked Docker stream for each pg client without executing SQL', async () => {
  dockerTransport.factory.mockReset();
  dockerTransport.factory.mockImplementation(() => new Duplex({ read() {}, write(_chunk,_encoding,callback) { callback(); } }));
  const stopped = new Error('MOCKED_BEFORE_ANY_SQL');
  const connect = vi.spyOn(pg.Client.prototype,'connect').mockRejectedValue(stopped);
  const query = vi.spyOn(pg.Client.prototype,'query').mockResolvedValue({ rows: [] });
  const end = vi.spyOn(pg.Client.prototype,'end').mockResolvedValue(undefined);
  try {
    await assert.rejects(() => runFixtureConcurrency('postgresql://fixture:fixture-only@127.0.0.1:5432/hpe_lab',
      { labContainer: 'hpe-admin-lab-031' }), (error) => error === stopped);
    assert.deepEqual(dockerTransport.factory.mock.calls,Array.from({ length: 3 }, () => ['hpe-admin-lab-031']));
    assert.equal(new Set(dockerTransport.factory.mock.results.map((result) => result.value)).size,3);
    assert.equal(connect.mock.calls.length,1);
    assert.deepEqual(query.mock.calls,[['rollback'],['rollback'],['rollback']]);
    assert.equal(end.mock.calls.length,3);
  } finally {
    connect.mockRestore(); query.mockRestore(); end.mockRestore(); dockerTransport.factory.mockReset();
  }
});
test('preflight required fields exclude new columns and assert schema/type/identity', () => {
  const required = preflight.slice(preflight.indexOf('from (values'), preflight.indexOf(') r(table_name'));
  assert.doesNotMatch(required, /preferred_payment_day|processed_transaction_ids|provider_effective_at|billing_version|sessions_valid_after/);
  assert.match(preflight, /raise exception 'PREFLIGHT_REQUIRED_SCHEMA_MISSING/);
  assert.match(preflight, /PREFLIGHT_DUPLICATE_IDENTITY/);
  assert.match(preflight, /PREFLIGHT_REQUIRED_SCHEMA_TYPE_MISMATCH/);
});
test('legacy fixture has nullable payments and lacks newly introduced subscription fields', () => {
  const payments = fixture.slice(fixture.indexOf('create table public.payments'), fixture.indexOf('create table public.webhook_events'));
  assert.doesNotMatch(payments, /subscription_id uuid not null|amount integer not null|currency varchar\(3\) not null/);
  assert.doesNotMatch(fixture, /preferred_payment_day|processed_transaction_ids/);
  assert.match(fixture, /receipt_version/);
});
test('parent-only regression covers same digest, different digest, rollback and amount schema', () => {
  assert.match(regression, /current_database\(\) <> 'hpe_lab'/);
  assert.match(regression, /SAME digest/);
  assert.match(regression, /DIFFERENT_DIGEST_WAS_NOT_REJECTED/);
  assert.match(regression, /ORIGINAL_CONTENT_ASSERTION_DID_NOT_ROLL_BACK/);
  assert.match(regression, /rename column amount to amount_cop/);
});
test('alternative fixture covers valid approvals, unverifiable RAW and preservation of NULL original arrays', () => {
  assert.match(evidence, /VALID_APPROVED_AT_BACKFILL_FAILED/);
  assert.match(evidence, /UNVERIFIED_RAW_OR_INVALID_DATE_WAS_USED_AS_APPROVAL/);
  assert.match(evidence, /ORIGINAL_NULL_ARRAY_WAS_REWRITTEN/);
  assert.match(evidence, /LEGACY_APPLIED_RECEIVED_REVIEW_MAPPING_FAILED/);
});
test('invitations are digest-only, UUID/session-bound, RLS protected and service-only', () => {
  assert.match(migration, /token_hash_digest text primary key/);
  assert.match(migration, /user_id uuid not null references auth\.users\(id\)/);
  assert.match(migration, /consumed_session_id uuid/);
  assert.match(migration, /alter table public\.admin_invitations enable row level security/);
  assert.match(migration, /revoke all on function public\.admin_consume_invitation\(text,uuid,uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_consume_invitation\(text,uuid,uuid\) to service_role/);
  assert.match(migration, /grant insert \(token_hash_digest, user_id, recipient_email, issued_at, expires_at\)/);
  assert.match(postflight, /POSTFLIGHT_INVITATION_CONSUMPTION_BOUNDARY_INVALID/);
});
test('invitation consumption locks one token and active invited UUID, validates TTL and schema, never email-only authority', () => {
  const body = migration.slice(migration.indexOf('create or replace function public.admin_consume_invitation'), migration.indexOf('-- API passes verified server context'));
  assert.match(body, /not public\.payment_admin_schema_ready\(\)/);
  assert.match(body, /token_hash_digest = p_token_hash_digest and user_id = p_user_id for update/);
  assert.match(body, /a\.user_id = p_user_id and a\.active and a\.role in \('admin','super_admin'\)/);
  assert.match(body, /lower\(u\.email\) = lower\(v_invitation\.recipient_email\)/);
  assert.match(body, /for share of a, u/);
  assert.match(body, /v_invitation\.issued_at > a\.sessions_valid_after/);
  assert.match(body, /v_invitation\.expires_at > v_invitation\.issued_at \+ interval '1 hour'/);
  assert.match(body, /consumed_at is null and consumed_session_id is null/);
  assert.match(body, /exception when unique_violation/);
});
test('invitation smoke covers same-email/different-UUID, absent allowlist, expired, revoked and reused sessions', () => {
  assert.match(smoke, /Invitation accepted wrong UUID\/same email/);
  assert.match(smoke, /absent allowlist/);
  assert.match(smoke, /Revocation did not invalidate an older invitation/);
  assert.match(smoke, /schema\/version marker/);
  assert.match(smoke, /Invitation or consumed session admitted a second use/);
  assert.match(smoke, /Invitation TTL allowed more than one hour/);
});
