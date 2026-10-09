// v0.4.0 | 2026-10-08 | ESCRITURA LOCAL: fictional fixtures, one rollback transaction.
// No migrations, HTTP clients, credentials, persistent fixtures, or production clocks.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runMonthlyRetryCharges } from '../monthly-retry-runner.mjs';
import { reconcileWompiReceipts } from '../wompi-receipt-runner.mjs';
import { VERIFIED_INSUFFICIENT_FUNDS_MESSAGE } from '../billing-retry-policy.mjs';

const CONTAINER = 'hpe-retry-v040-local';
// Main explicitly authorized this replacement DB; do not accept arbitrary lab names.
const DATABASE = 'hpe_retry_lab_1791517849626';
const AUTHORIZED_DIGEST = 'dbb0b98ca4d44f0d999d0f7a77b28d9e88fb6d71799e577a0a65491533f3b34d';
assert.deepEqual(process.argv.slice(2), ['--local-retry-lab=yes', `--database=${DATABASE}`],
  'EXACT_MAIN_OWNED_LAB_OPT_IN_REQUIRED');
// Select inspection fields explicitly: never load container environment/secrets.
const inspection = JSON.parse(execFileSync('docker', ['inspect', '--format',
  '{"name":{{json .Name}},"image":{{json .Config.Image}},"network":{{json .HostConfig.NetworkMode}},"ports":{{json .NetworkSettings.Ports}},"bindings":{{json .HostConfig.PortBindings}},"running":{{json .State.Running}}}',
  CONTAINER], { encoding: 'utf8', windowsHide: true }));
assert.equal(inspection.name, `/${CONTAINER}`);
assert.equal(inspection.image, 'postgres:16');
assert.equal(inspection.network, 'none');
assert.equal(inspection.running, true);
assert.equal(Object.values(inspection.ports ?? {}).some(Boolean), false);
assert.equal(Object.keys(inspection.bindings ?? {}).length, 0);

const migrationPath = fileURLToPath(new URL('../../supabase/migrations/202610080001_billing_retry_cycles.sql', import.meta.url));
const digest = async () => createHash('sha256').update(await readFile(migrationPath)).digest('hex');
const sourceDigestAtStart = await digest();
assert.equal(sourceDigestAtStart, AUTHORIZED_DIGEST, 'EXACT_MAIN_AUTHORIZED_SQL_SOURCE_REQUIRED');
// Read only: the parent installs migrations. This harness never rewrites markers.
const INSTALLED_DIGEST = sourceDigestAtStart;
const originalFetch = globalThis.fetch;
let forbiddenFetches = 0;
globalThis.fetch = () => { forbiddenFetches += 1; throw new Error('EXTERNAL_FETCH_FORBIDDEN'); };

const literal = (value) => {
  if (value == null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') { assert.ok(Number.isSafeInteger(value)); return String(value); }
  if (typeof value === 'object') return `${literal(JSON.stringify(value))}::jsonb`;
  assert.equal(typeof value, 'string');
  assert.equal(value.includes('\0'), false);
  return "'" + value.replaceAll("'", "''") + "'";
};
const identifier = (value) => { assert.match(value, /^[a-z_][a-z_0-9]*$/); return value; };
const rpcNames = new Set(['billing_retry_schema_ready', 'billing_v2_prepare_subscription',
  'billing_v2_bind_source', 'billing_v2_reserve_initial', 'billing_v2_reserve_original',
  'billing_v2_reserve_retry', 'billing_v2_authorize_send', 'billing_v2_record_dispatch',
  'billing_v2_apply_result', 'billing_v2_mark_uncertain', 'billing_v2_repair_schedule',
  'billing_v2_expire_retry', 'billing_v2_admin_update_subscription',
  'billing_v2_admin_recovery_replay', 'billing_v2_admin_reconcile_payment_attempt', 'apply_verified_wompi_event']);
function rpcExpression(name, args = {}) {
  assert.ok(rpcNames.has(name), 'RPC_NOT_IN_LAB_ALLOWLIST');
  return `public.${name}(${Object.entries(args).map(([key, value]) =>
    `${identifier(key)} => ${literal(value)}`).join(',')})`;
}

// Keep all job/RPC operations on ONE backend: closing it also rolls back on failure.
class LabSession {
  constructor() {
    this.child = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-q', '-A', '-t',
      '-U', 'postgres', '-d', DATABASE, '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off'], { windowsHide: true });
    this.buffer = '';
    this.errors = '';
    this.waiting = null;
    this.closed = false;
    this.clockBase = null;
    this.rpcCalls = 0;
    this.expectedSqlErrors = 0;
    this.exited = new Promise((resolve) => {
      this.child.once('close', (code) => {
        this.closed = true;
        this.rejectWaiting(new Error(`PSQL_EXIT_${code}: ${this.errors.slice(-2000)}`));
        resolve(code);
      });
    });
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '');
        this.buffer = this.buffer.slice(newline + 1);
        if (!this.waiting) continue;
        if (line === this.waiting.marker) {
          const pending = this.waiting;
          this.waiting = null;
          clearTimeout(pending.timer);
          pending.resolve(pending.lines);
        } else if (line) this.waiting.lines.push(line);
      }
    });
    this.child.stderr.on('data', (chunk) => { this.errors = (this.errors + chunk).slice(-5000); });
    this.child.once('error', (error) => this.rejectWaiting(error));
    this.child.stdin.on('error', (error) => this.rejectWaiting(error));
  }
  rejectWaiting(error) {
    if (!this.waiting) return;
    clearTimeout(this.waiting.timer);
    this.waiting.reject(error);
    this.waiting = null;
  }
  async execute(input) {
    assert.equal(this.closed, false, 'LAB_SESSION_CLOSED');
    assert.equal(this.waiting, null, 'SERIAL_SQL_ONLY');
    const marker = 'lab_' + randomUUID().replaceAll('-', '');
    const result = new Promise((resolve, reject) => {
      this.waiting = { marker, lines: [], resolve, reject,
        timer: setTimeout(() => {
          this.rejectWaiting(new Error('LAB_SQL_TIMEOUT_NO_RETRY'));
          this.child.stdin.destroy();
          this.child.kill();
        }, 30_000) };
    });
    this.child.stdin.write(`${input}\n\\echo ${marker}\n`);
    return result;
  }
  async value(expression, prefix = '') {
    const lines = await this.execute(`${prefix}\nselect jsonb_build_object('data',(${expression}),
      'dbNow',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));`);
    assert.equal(lines.length, 1, 'EXACT_ONE_REAL_SQL_ENVELOPE');
    const frame = JSON.parse(lines[0]);
    this.clockBase = { date: Date.parse(frame.dbNow), tick: process.hrtime.bigint() };
    assert.ok(Number.isFinite(this.clockBase.date));
    return frame.data;
  }
  clock = () => {
    assert.ok(this.clockBase, 'DB_CLOCK_NOT_OBSERVED');
    return new Date(this.clockBase.date + Number(process.hrtime.bigint() - this.clockBase.tick) / 1e6);
  };
  async now() { return this.value("to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"); }
  async write(input) { return this.value('true', `reset role;\n${input}`); }
  async rpc(name, args) {
    this.rpcCalls += 1;
    return this.value(rpcExpression(name, args), 'set local role service_role;');
  }
  async expectError(statement, message, role = 'postgres') {
    assert.ok(['postgres', 'service_role'].includes(role));
    const context = role === 'service_role' ? 'set local role service_role;' : 'reset role;';
    // PL/pgSQL subtransactions preserve the outer fixture transaction on expected failures.
    await this.value('true', `${context} do $lab_error$ begin
      begin ${statement}; raise exception 'EXPECTED_ERROR_NOT_RAISED';
      exception when others then if sqlerrm <> ${literal(message)} then raise; end if; end;
      end $lab_error$;`);
    this.expectedSqlErrors += 1;
  }
  async close() {
    if (!this.closed) {
      try { await this.execute('rollback;'); } finally { this.child.stdin.end('\\q\n'); }
    }
    return this.exited;
  }
}

const db = new LabSession();
const results = [];
const trace = [];
const fixtureDonors = [];
let checks = 0;
let baseline;
let rolledBack = false;
let fatal;
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
const ok = (value, label) => { assert.ok(value, label); checks += 1; };
const logger = { log() {}, error() {} };
const env = Object.freeze({ APP_OPERATION_MODE: 'active', FINANCIAL_OPERATIONS_ENABLED: 'true',
  SUPABASE_URL: 'http://127.0.0.1', WOMPI_ENV: 'sandbox' }); // Injected policy inputs, not a connection.

async function test(name, operation) {
  const before = checks;
  try { await operation(); results.push({ name, result: 'passed', checks: checks - before }); }
  catch (error) {
    results.push({ name, result: 'failed', checks: checks - before, error: error.message });
    if (db.closed) throw error;
  }
  console.log(JSON.stringify(results.at(-1)));
}

function clientFor(fixture, provider) {
  const tables = new Set(['subscriptions', 'billing_cycles', 'payment_attempts', 'payments', 'webhook_events']);
  return {
    rpc: async (name, args) => {
      const data = await db.rpc(name, args);
      trace.push({ fixture: fixture.label, name, args: structuredClone(args ?? {}), data: structuredClone(data) });
      return { data, error: null }; // No substituted/fabricated RPC response.
    },
    from(table) {
      assert.ok(tables.has(table));
      let projection = '*';
      const filters = [];
      const ordering = [];
      const query = {
        select(columns) {
          projection = columns === '*' ? '*' : columns.split(',').map(identifier).join(',');
          return query;
        },
        eq(column, value) { filters.push(`${identifier(column)}=${literal(value)}`); return query; },
        in(column, values) {
          filters.push(`${identifier(column)} in (${values.map(literal).join(',')})`); return query;
        },
        order(column, { ascending = true } = {}) {
          ordering.push(`${identifier(column)} ${ascending ? 'asc' : 'desc'}`); return query;
        },
        async range(start, end) {
          assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start);
          const txIds = [...provider.transactions.keys()];
          const scope = table === 'webhook_events'
            ? (txIds.length ? `coalesce(transaction_id,raw->'transaction'->>'id') in (${txIds.map(literal).join(',')})` : 'false')
            : `${table === 'subscriptions' ? 'id' : 'subscription_id'}=${literal(fixture.subscription)}`;
          const data = await db.value(`select coalesce(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) from
            (select ${projection} from public.${table} where ${[scope, ...filters].join(' and ')}
            order by ${ordering.join(',') || 'id'} limit ${end - start + 1} offset ${start}) rows`,
          'set local role service_role;');
          return { data, error: null };
        },
      };
      return query;
    },
  };
}

function mockedWompi(fixture, outcome = 'approved') {
  const transactions = new Map();
  const sends = [];
  const preparations = [];
  const gets = [];
  const sources = [];
  return {
    transactions, sends, preparations, gets, sources,
    async getPaymentSource({ paymentSourceId }) {
      equal(paymentSourceId, fixture.source, 'provider source is fixture scoped');
      const verifiedAt = await db.now();
      const source = { id: paymentSourceId, type: 'CARD', status: 'AVAILABLE', environment: 'sandbox',
        verificationSource: 'provider_get', verifiedAt };
      sources.push(source);
      return source;
    },
    async getTransaction({ transactionId }) {
      assert.ok(transactions.has(transactionId), 'MOCK_GET_UNKNOWN_TRANSACTION');
      gets.push(transactionId);
      await db.now();
      return structuredClone(transactions.get(transactionId));
    },
    async prepareTransaction(input) {
      equal(input.customerEmail, fixture.email, 'send is restricted to example.test donor');
      preparations.push(structuredClone(input));
      return { async send({ onSending, onDispatched }) {
        onSending();
        sends.push(structuredClone(input));
        if (outcome === 'timeout') throw new Error('MOCK_POST_RESPONSE_TIMEOUT');
        const id = 'fixture-tx-' + randomUUID();
        const status = outcome;
        const finalizedAt = status === 'pending' ? null : await db.now();
        transactions.set(id, { id, ...input, status, finalizedAt, paymentMethodType: 'CARD',
          statusMessage: status === 'declined' ? VERIFIED_INSUFFICIENT_FUNDS_MESSAGE : null,
          environment: 'sandbox', verificationSource: 'provider_get' });
        await onDispatched({ id, status });
        return { id, status }; // POST is an identifier only; final state comes from mocked GET.
      } };
    },
  };
}
function sourceEnvelope(source) {
  return { id: source.id, type: source.type, status: source.status, environment: source.environment,
    verification_source: source.verificationSource, verified_at: source.verifiedAt };
}
function transactionEnvelope(transaction) {
  return { id: transaction.id, reference: transaction.reference, amount_in_cents: transaction.amountInCents,
    currency: transaction.currency, payment_source_id: transaction.paymentSourceId,
    payment_method_type: transaction.paymentMethodType, status: transaction.status,
    status_message: transaction.statusMessage, finalized_at: transaction.finalizedAt,
    environment: transaction.environment, verification_source: transaction.verificationSource };
}
const run = async (fixture, provider, mode = 'charge') => runMonthlyRetryCharges({ mode, env, logger,
  supabase: clientFor(fixture, provider), clock: db.clock,
  getTransaction: provider.getTransaction, getPaymentSource: provider.getPaymentSource,
  prepareTransaction: provider.prepareTransaction });

async function fixture(label, { recurring = true, consent = true, due = false, modeledAt = null } = {}) {
  const donor = randomUUID();
  const checkout = randomUUID();
  const email = `contract-${donor}@example.test`;
  const reference = 'contract-' + checkout;
  const source = 'fixture-source-' + donor;
  const createdAt = modeledAt ? `${literal(modeledAt)}::timestamptz` : 'clock_timestamp()';
  fixtureDonors.push(donor);
  await db.write(`insert into public.donors(id,email,first_name,last_name)
    values(${literal(donor)},${literal(email)},'Contract','Fictional');
    insert into public.checkout_intents(id,donor_id,reference,secret_hash,amount,is_recurring,
      preferred_payment_day,environment,expires_at,retry_authorization,created_at,updated_at)
    values(${literal(checkout)},${literal(donor)},${literal(reference)},${literal(createHash('sha256').update(checkout).digest('hex'))},
      30000,${recurring},${recurring ? '16' : 'null'},'sandbox',clock_timestamp()+interval '2 hours',
      ${consent && recurring ? `jsonb_build_object('version','0.4.0','recurring',true,'retryAllowed',true,'acceptedAt',${createdAt})` : 'null'},
      ${createdAt},${createdAt});`);
  const prepared = await db.rpc('billing_v2_prepare_subscription', { p_checkout_id: checkout, p_payment_method: 'card' });
  const row = { label, donor, checkout, subscription: prepared.id, email, reference, source };
  await db.rpc('billing_v2_bind_source', { p_checkout_id: checkout, p_subscription_id: row.subscription,
    p_payment_source_id: source, p_source_verified: true });
  if (modeledAt) await db.write(`update public.subscriptions set created_at=${createdAt},
    billing_authorization=jsonb_set(billing_authorization,'{sourceVerifiedAt}',to_jsonb(${createdAt}))
    where id=${literal(row.subscription)};`);
  if (due) await db.write(`update public.subscriptions set status='active',next_payment_date=clock_timestamp()-interval '1 hour'
    where id=${literal(row.subscription)};`);
  return row;
}

async function state(row) {
  return db.value(`select jsonb_build_object('subscription',to_jsonb(s),
    'cycles',(select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at,c.id),'[]') from public.billing_cycles c where c.subscription_id=s.id),
    'attempts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.attempt_number,a.id),'[]') from public.payment_attempts a where a.subscription_id=s.id),
    'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.payments p where p.subscription_id=s.id),
    'audits',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]') from public.admin_audit_logs l where l.subscription_id=s.id))
    from public.subscriptions s where s.id=${literal(row.subscription)}`, 'reset role;');
}

async function initialDispatch(row, provider) {
  const reservation = await db.rpc('billing_v2_reserve_initial', { p_checkout_id: row.checkout, p_subscription_id: row.subscription });
  equal(reservation.result, 'reserved', 'real initial reservation envelope');
  const snapshot = reservation.dispatchSnapshot;
  equal(snapshot.attemptId, reservation.attempt.id, 'initial reservation links snapshot to attempt');
  const source = await provider.getPaymentSource({ paymentSourceId: snapshot.paymentSourceId });
  const prepared = await provider.prepareTransaction({ reference: snapshot.reference, amountInCents: snapshot.amount * 100,
    currency: snapshot.currency, paymentSourceId: snapshot.paymentSourceId, customerEmail: snapshot.customerEmail });
  const grant = await db.rpc('billing_v2_authorize_send', { p_attempt_id: snapshot.attemptId, p_source_verification: sourceEnvelope(source) });
  equal(grant.canDispatch, true, 'initial send uses real SQL grant');
  await prepared.send({ onSending: () => {}, onDispatched: async ({ id, status }) => {
    equal((await db.rpc('billing_v2_record_dispatch', { p_attempt_id: snapshot.attemptId,
      p_transaction_id: id, p_status: status })).result, 'recorded', 'initial POST identifier is recorded');
  } });
  return reservation;
}

// D-1 is a NEW fictional fixture, not legacy backfill and not a clock/grant rewrite.
// It models an original sent yesterday; the retry reservation and send grant are real RPCs today.
async function yesterdayInitial(label, daysAgo = 1) {
  const modeledAt = await db.value(`to_char((((clock_timestamp() at time zone 'America/Bogota')::date-${daysAgo})::timestamp
    +interval '11 hours') at time zone 'America/Bogota' at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  const row = await fixture(label, { modeledAt });
  const cycle = randomUUID();
  const attempt = randomUUID();
  const transaction = 'fixture-yesterday-' + randomUUID();
  const finalizedAt = await db.value(`to_char((((clock_timestamp() at time zone 'America/Bogota')::date-${daysAgo})::timestamp
    +interval '12 hours') at time zone 'America/Bogota' at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  await db.write(`insert into public.billing_cycles(id,subscription_id,donor_id,billing_period,origin,
    checkout_intent_id,retry_enabled,authorization_snapshot,amount,currency,payment_source_id,environment,
    preferred_payment_day,subscription_version,original_due_at)
    select ${literal(cycle)},id,donor_id,to_char(${literal(finalizedAt)}::timestamptz at time zone 'America/Bogota','YYYYMM'),
      'initial',${literal(row.checkout)},true,billing_authorization,amount,currency,wompi_payment_source_id,'sandbox',
      preferred_payment_day,billing_version,${literal(finalizedAt)}::timestamptz-interval '1 second'
      from public.subscriptions where id=${literal(row.subscription)};
    insert into public.payment_attempts(id,checkout_intent_id,donor_id,subscription_id,billing_period,
      reference,amount,currency,subscription_version,state,cycle_id,attempt_number,dispatch_snapshot,
      wompi_transaction_id,provider_status,send_authorized_at,send_window_end,dispatched_at)
    select ${literal(attempt)},${literal(row.checkout)},donor_id,id,
      to_char(${literal(finalizedAt)}::timestamptz at time zone 'America/Bogota','YYYYMM'),reference,amount,currency,billing_version,
      'pending',${literal(cycle)},1,jsonb_build_object('attemptId',${literal(attempt)},'cycleId',${literal(cycle)},
      'subscriptionId',id,'frequency','monthly','attemptNumber',1,'reference',reference,'amount',amount,'currency',currency,
      'paymentSourceId',wompi_payment_source_id,'customerEmail',${literal(row.email)},'preferredPaymentDay',preferred_payment_day,
      'billingVersion',billing_version,'environment','sandbox','paymentMethodType','card','retryEnabled',true),
      ${literal(transaction)},'pending',${literal(finalizedAt)}::timestamptz-interval '1 second',
      ((${literal(finalizedAt)}::timestamptz at time zone 'America/Bogota')::date+1)::timestamp at time zone 'America/Bogota',
      ${literal(finalizedAt)}::timestamptz-interval '1 second' from public.subscriptions where id=${literal(row.subscription)};
    update public.checkout_intents set state='processing',consumed_at=${literal(finalizedAt)}::timestamptz,
      expires_at=((${literal(finalizedAt)}::timestamptz at time zone 'America/Bogota')::date+1)::timestamp at time zone 'America/Bogota'
      where id=${literal(row.checkout)};`);
  const provider = mockedWompi(row);
  provider.transactions.set(transaction, { id: transaction, reference: row.reference, amountInCents: 3000000,
    currency: 'COP', paymentSourceId: row.source, paymentMethodType: 'CARD', status: 'declined',
    statusMessage: VERIFIED_INSUFFICIENT_FUNDS_MESSAGE, finalizedAt, environment: 'sandbox', verificationSource: 'provider_get' });
  return { row, provider, cycle, attempt, transaction, finalizedAt };
}

let actor;
async function adminArgs(row, action, requestId = randomUUID(), extra = {}) {
  const now = await db.now();
  return { p_subscription_id: row.subscription, p_expected_version: 0, p_action: action,
    p_reason: 'Fictional contract verification', p_request_id: requestId, p_actor_user_id: actor,
    p_actor_aal: 'aal2', p_actor_session_issued_at: now, p_totp_verified_at: now, ...extra };
}
async function recoveryArgs(row, transaction, attempt, requestId) {
  const now = await db.now();
  const envelope = transactionEnvelope(transaction);
  return { p_attempt_id: attempt.id, p_actor_user_id: actor, p_reason: 'Fictional pending recovery', p_request_id: requestId,
    p_transaction_id: transaction.id, p_reference: transaction.reference, p_payment_source_id: transaction.paymentSourceId,
    p_amount: attempt.amount, p_currency: attempt.currency, p_status: transaction.status,
    p_effective_at: transaction.finalizedAt, p_candidate_next_payment: null, p_expected_version: 0,
    p_actor_aal: 'aal2', p_actor_session_issued_at: now, p_totp_verified_at: now,
    p_raw: { ...envelope, source: 'admin_recovery', transaction: envelope, payment_source_verification: null, verified_at: now } };
}
function recoveryReplayArgs(args) {
  return Object.fromEntries(['p_attempt_id', 'p_actor_user_id', 'p_reason', 'p_request_id', 'p_transaction_id',
    'p_expected_version', 'p_actor_aal', 'p_actor_session_issued_at', 'p_totp_verified_at'].map((key) => [key, args[key]]));
}

const fingerprints = `select coalesce(jsonb_object_agg(name,fingerprint),'{}'::jsonb) from (
  ${['donors', 'subscriptions', 'billing_cycles', 'payment_attempts', 'payments', 'webhook_events',
    'audit_logs', 'checkout_intents', 'admin_users', 'admin_audit_logs'].map((table) =>
    `select '${table}' as name,md5(coalesce(string_agg((to_jsonb(t)-'secret_hash')::text,E'\\n' order by (to_jsonb(t)->>'id'),(to_jsonb(t)->>'user_id')),'')) as fingerprint from public.${table} t`).join(' union all ')}
  union all select 'auth.users',md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by id),'')) from auth.users t) hashes`;

try {
  // Only read aggregated identity guards before ANY fixture/financial write.
  await db.execute("begin isolation level repeatable read; set local timezone='UTC'; set local client_min_messages=warning; set local statement_timeout='15s'; set local lock_timeout='2s';");
  const guard = await db.value(`select jsonb_build_object('database',current_database(),
    'legacyFixture',exists(select 1 from public.donors where id='10000000-0000-0000-0000-000000000090' and email='legacy@example.test'),
    'nonFixtureDonors',(select count(*) from public.donors where email not like '%@example.test'),
    'nonFixtureUsers',(select count(*) from auth.users where email is null or email not like '%@example.test'),
    'ready',public.billing_retry_schema_ready(),
    'digest',(select digest from public.payment_admin_migrations where name='billing-retry-v0.4.0'),
    'colombianTime',(clock_timestamp() at time zone 'America/Bogota')::time,
    'retryWindowOpen',(clock_timestamp() at time zone 'America/Bogota')::time >= time '07:00:00')`);
  equal(guard.database, DATABASE, 'exact fictional database');
  equal(guard.legacyFixture, true, 'exact main-owned donor guard');
  equal(guard.nonFixtureDonors, 0, 'no non-fictional donors');
  equal(guard.nonFixtureUsers, 0, 'no non-fictional auth users');
  equal(guard.ready, true, 'actual SQL schema readiness');
  equal(guard.digest, INSTALLED_DIGEST, 'exact main-authorized installed SQL generation');
  baseline = await db.value(fingerprints);
  actor = randomUUID();
  await db.write(`insert into auth.users(id,email) values(${literal(actor)},${literal(`contract-admin-${actor}@example.test`)});
    insert into public.admin_users(user_id,role,active) values(${literal(actor)},'admin',true);`);

  await test('initial DECLINED with full source proof queues exactly one future D+1 retry', async () => {
    const row = await fixture('initial');
    const provider = mockedWompi(row, 'declined');
    const reservation = await initialDispatch(row, provider);
    const stats = await run(row, provider, 'reconcile');
    equal(stats.failed, 0, 'initial reconciliation succeeds');
    equal(stats.sent, 0, 'job does not resend checkout original');
    const observed = await state(row);
    equal(observed.cycles.length, 1, 'new initial creates one cycle');
    equal(observed.cycles[0].origin, 'initial', 'initial is not a renewal fixture');
    equal(observed.cycles[0].state, 'retry_wait', 'insufficient funds schedules retry');
    equal(observed.attempts.length, 1, 'D+1 is queued, not prematurely reserved');
    equal(observed.attempts[0].verified_reason, 'insufficient_funds', 'SQL records verified decline reason');
    equal(observed.attempts[0].verified_evidence.payment_source_id, row.source, 'full source identity reaches SQL');
    const expected = await db.value(`select jsonb_build_object('start',
      (((verified_finalized_at at time zone 'America/Bogota')::date+1)::timestamp+interval '7 hours') at time zone 'America/Bogota',
      'end',((verified_finalized_at at time zone 'America/Bogota')::date+2)::timestamp at time zone 'America/Bogota')
      from public.payment_attempts where id=${literal(reservation.attempt.id)}`);
    equal(observed.cycles[0].retry_window_start, expected.start, 'window starts D+1 07:00 Colombia');
    equal(observed.cycles[0].retry_window_end, expected.end, 'window excludes D+2 midnight Colombia');
    equal(observed.subscription.next_payment_date, null, 'retry hold removes next monthly date');
    const sends = provider.sends.length;
    for (let index = 0; index < 2; index += 1) equal((await run(row, provider)).sent, 0, 'repeat before D+1 does not send');
    const duplicate = trace.filter((entry) => entry.fixture === row.label && entry.name === 'billing_v2_apply_result').at(-1).data;
    equal(duplicate.result, 'duplicate', 'repeated decline is a real SQL duplicate');
    equal(duplicate.reason, null, 'duplicate does not fabricate a new decline reason');
    equal(duplicate.retryQueued, true, 'SQL duplicate reports authoritative current retry queue');
    equal(provider.sends.length, sends, 'one original total');
    const replay = await db.rpc('billing_v2_reserve_initial', { p_checkout_id: row.checkout, p_subscription_id: row.subscription });
    equal(replay.attempt.id, reservation.attempt.id, 'repeated checkout shares original');
    for (const field of ['amount', 'preferred_payment_day', 'subscription_version', 'payment_source_id']) {
      const value = field === 'payment_source_id' ? "'fixture-mutated-source'" : `${observed.cycles[0][field] + 1}`;
      await db.expectError(`update public.billing_cycles set ${field}=${value} where id=${literal(observed.cycles[0].id)}`,
        'BILLING_CYCLE_SNAPSHOT_IMMUTABLE');
      checks += 1;
    }
    await db.expectError(`update public.payment_attempts set amount=amount+1 where id=${literal(reservation.attempt.id)}`,
      'BILLING_ATTEMPT_SNAPSHOT_IMMUTABLE'); checks += 1;
  });

  await test('real JS job reserves original, grants send and receives actual SQL result envelope', async () => {
    const row = await fixture('job-original', { due: true });
    const provider = mockedWompi(row, 'declined');
    const stats = await run(row, provider);
    equal(stats.failed, 0, 'job original completes without contract mismatch');
    equal(stats.originalsReserved, 1, 'job creates original through real RPC');
    equal(stats.sent, 1, 'one durable authorized send');
    const observed = await state(row);
    equal(observed.cycles[0].state, 'retry_wait', 'job decline uses verified source proof');
    const applied = trace.find((entry) => entry.fixture === row.label && entry.name === 'billing_v2_apply_result');
    equal(applied.args.p_transaction.payment_source_verification.verification_source, 'provider_get', 'JS serializes full source proof');
    equal(applied.data.reason, 'retry_wait', 'real SQL result reaches job');
    equal((await run(row, provider)).sent, 0, 'job original never sends twice');
  });

  if (guard.retryWindowOpen) {
    await test('D+1 initial retry APPROVED advances next month once with frozen snapshot', async () => {
      const { row, provider, cycle, finalizedAt } = await yesterdayInitial('d-plus-one');
      equal((await run(row, provider, 'reconcile')).failed, 0, 'D-1 full source evidence reconciles');
      const before = await state(row);
      equal(before.cycles[0].state, 'retry_wait', 'SQL schedules today from yesterday provider UTC');
      ok(Date.parse(before.cycles[0].authorization_snapshot.authorizedAt) < Date.parse(before.attempts[0].send_authorized_at),
        'fictional D-1 consent precedes original send');
      ok(Date.parse(before.cycles[0].authorization_snapshot.sourceVerifiedAt) < Date.parse(before.attempts[0].send_authorized_at),
        'fictional D-1 source verification precedes original send');
      const stats = await run(row, provider);
      equal(stats.failed, 0, 'real retry dispatch accepts SQL grant shape');
      equal(stats.retriesReserved, 1, 'one additional reserved');
      equal(stats.sent, 1, 'one retry POST');
      equal(stats.approved, 1, 'one newly persisted approval');
      equal(trace.filter((entry) => entry.fixture === row.label && entry.name === 'billing_v2_apply_result').at(-1).data.retryQueued,
        false, 'approved retry closes authoritative queue');
      const observed = await state(row);
      equal(observed.attempts.length, 2, 'original plus ONE additional only');
      equal(observed.cycles[0].id, cycle, 'retry stays in original initial cycle');
      equal(observed.cycles[0].state, 'approved', 'cycle closes approved');
      equal(observed.subscription.status, 'active', 'approved retry restores active');
      const retry = observed.attempts[1];
      for (const field of ['amount', 'currency', 'paymentSourceId', 'preferredPaymentDay', 'billingVersion', 'customerEmail'])
        equal(retry.dispatch_snapshot[field], observed.attempts[0].dispatch_snapshot[field], `frozen retry ${field}`);
      const next = await db.value(`to_char((date_trunc('month',${literal(provider.transactions.get(retry.wompi_transaction_id).finalizedAt)}::timestamptz
        at time zone 'America/Bogota')+interval '1 month'+interval '15 days 7 hours')
        at time zone 'America/Bogota' at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
      equal(Date.parse(observed.subscription.next_payment_date), Date.parse(next), 'next month preferred day 07:00 Colombia');
      ok(Date.parse(finalizedAt) < Date.parse(retry.send_authorized_at), 'D-1 provider time precedes real D+1 grant');
      const stableDate = observed.subscription.next_payment_date;
      for (let index = 0; index < 3; index += 1) {
        const repeated = await run(row, provider);
        equal(repeated.sent, 0, 'repeated job cannot POST again');
        equal(repeated.approved, 0, 'repeated job does not count approval twice');
      }
      const source = await provider.getPaymentSource({ paymentSourceId: row.source });
      equal((await db.rpc('billing_v2_authorize_send', { p_attempt_id: retry.id,
        p_source_verification: sourceEnvelope(source) })).canDispatch, false, 'used retry grant is not reclaimable');
      const after = await state(row);
      equal(after.attempts.length, 2, 'no third attempt');
      equal(after.payments.filter((payment) => payment.status === 'approved').length, 1, 'one approved payment row');
      equal(after.subscription.next_payment_date, stableDate, 'repeats do not advance month again');
    });

    await test('exhausted retry stays off after repeated jobs', async () => {
      const { row, provider } = await yesterdayInitial('exhausted');
      const declinedProvider = mockedWompi(row, 'declined');
      for (const [key, value] of provider.transactions) declinedProvider.transactions.set(key, value);
      equal((await run(row, declinedProvider)).sent, 1, 'exactly one declined additional');
      const observed = await state(row);
      equal(observed.attempts.length, 2, 'budget exhausted at two');
      equal(observed.cycles[0].hold_reason, 'retry_exhausted', 'SQL records exhaustion');
      equal(observed.subscription.next_payment_date, null, 'exhaustion disables monthly schedule');
      for (let index = 0; index < 2; index += 1) equal((await run(row, declinedProvider)).sent, 0, 'exhausted stays off');
      equal(declinedProvider.sends.length, 1, 'no third send');
    });
  } else {
    results.push({ name: 'D+1 retry approval and exhaustion', result: 'blocked',
      reason: 'REAL_DB_COLOMBIAN_WINDOW_NOT_OPEN_07_TO_MIDNIGHT', colombianTime: guard.colombianTime });
  }

  await test('pending then approved administrative SAME request replays without applying new status', async () => {
    const row = await fixture('pending-replay', { due: true });
    const provider = mockedWompi(row, 'pending');
    equal((await run(row, provider)).sent, 1, 'pending original sent once');
    for (let index = 0; index < 2; index += 1) {
      const pending = await run(row, provider);
      equal(pending.sent, 0, 'repeated pending GET does not POST');
      equal(pending.approved, 0, 'pending is not an approval');
      equal(pending.skippedPending, 1, 'pending is reconciled and reported');
    }
    const observed = await state(row);
    const attempt = observed.attempts[0];
    const transaction = provider.transactions.get(attempt.wompi_transaction_id);
    const request = randomUUID();
    const first = await db.rpc('billing_v2_admin_reconcile_payment_attempt', await recoveryArgs(row, transaction, attempt, request));
    equal(first.state, 'pending', 'first recovery records pending response');
    equal(first.needsReview, false, 'pending response stores stable needsReview');
    transaction.status = 'approved'; transaction.finalizedAt = await db.now();
    const replayArgs = await recoveryArgs(row, transaction, attempt, request);
    equal(await db.rpc('billing_v2_admin_reconcile_payment_attempt', replayArgs), first, 'same request replays original pending response');
    let after = await state(row);
    equal(after.attempts[0].state, 'pending', 'changed provider status is not applied by replay');
    equal(after.audits.length, 1, 'one atomic recovery audit');
    equal(after.audits[0].committed_response, first, 'audit stores exact replay response');
    const stats = await run(row, provider, 'reconcile');
    equal(stats.approved, 1, 'independent job GET applies approved once');
    equal(stats.sent, 0, 'pending recovery never repeats POST');
    equal(await db.rpc('billing_v2_admin_reconcile_payment_attempt', replayArgs), first, 'replay stays stable after actual approval');
    after = await state(row);
    equal(after.attempts[0].state, 'approved', 'replay does not downgrade actual approved state');
    equal(after.payments.length, 1, 'pending upgrades same payment row');
    equal(after.audits.length, 1, 'replay has no extra audit');
    equal((await run(row, provider)).approved, 0, 'approval is not counted again');
    equal(provider.sends.length, 1, 'only original sent');
    const conflictArgs = { ...replayArgs, p_reason: 'Different fictional reason' };
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_reconcile_payment_attempt', conflictArgs)}`, 'ADMIN_REQUEST_ID_CONFLICT'); checks += 1;
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_reconcile_payment_attempt',
      { ...replayArgs, p_totp_verified_at: new Date(Date.parse(await db.now()) - 6 * 60_000).toISOString() })}`, 'ADMIN_NOT_AUTHORIZED'); checks += 1;
  });

  await test('direct replay helper ignores provider/version/source drift without GET and still requires fresh MFA', async () => {
    const row = await fixture('helper-replay', { due: true });
    const provider = mockedWompi(row, 'pending');
    equal((await run(row, provider)).sent, 1, 'helper fixture sends one original');
    const observed = await state(row);
    const attempt = observed.attempts[0];
    const transaction = provider.transactions.get(attempt.wompi_transaction_id);
    const request = randomUUID();
    const firstArgs = await recoveryArgs(row, transaction, attempt, request);
    equal(await db.rpc('billing_v2_admin_recovery_replay', recoveryReplayArgs(firstArgs)), { result: 'new' },
      'new request lookup does not invent a recovery');
    equal((await state(row)).audits.length, 0, 'helper miss does not write an audit');
    const first = await db.rpc('billing_v2_admin_reconcile_payment_attempt', firstArgs);
    equal(first.state, 'pending', 'pending recovery response stored before drift');
    equal(first.needsReview, false, 'pending needsReview is persisted, not recomputed');
    const ioBefore = { gets: provider.gets.length, sources: provider.sources.length, sends: provider.sends.length };
    transaction.status = 'approved'; transaction.finalizedAt = await db.now();
    provider.getTransaction = async () => { throw new Error('HELPER_REPLAY_MUST_NOT_GET_PROVIDER'); };
    provider.getPaymentSource = async () => { throw new Error('HELPER_REPLAY_MUST_NOT_GET_SOURCE'); };
    await db.write(`update public.subscriptions set billing_version=billing_version+1,
      wompi_payment_source_id=${literal('fixture-drift-source-' + row.donor)} where id=${literal(row.subscription)};`);
    const drifted = await state(row);
    equal(drifted.subscription.billing_version, 1, 'current version really differs from request version');
    ok(drifted.subscription.wompi_payment_source_id !== transaction.paymentSourceId, 'current source really differs from original');
    const replayArgs = recoveryReplayArgs(await recoveryArgs(row, transaction, attempt, request));
    equal(await db.rpc('billing_v2_admin_recovery_replay', replayArgs), { result: 'replay', response: first },
      'helper returns exact original response despite approved provider and stale version/source');
    equal(await state(row), drifted, 'replay helper is read-only for billing and audit rows');
    equal({ gets: provider.gets.length, sources: provider.sources.length, sends: provider.sends.length }, ioBefore,
      'direct helper performs zero additional mocked GET/source GET/POST');
    equal(drifted.audits[0].committed_response.needsReview, false, 'audit preserves original needsReview');
    for (const invalidContext of [{ p_actor_aal: 'aal1' },
      { p_totp_verified_at: new Date(Date.parse(await db.now()) - 6 * 60_000).toISOString() }]) {
      await db.expectError(`perform ${rpcExpression('billing_v2_admin_recovery_replay', { ...replayArgs, ...invalidContext })}`,
        'ADMIN_NOT_AUTHORIZED', 'service_role'); checks += 1;
    }
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_recovery_replay',
      { ...replayArgs, p_reason: 'Different fictional helper request' })}`, 'ADMIN_REQUEST_ID_CONFLICT', 'service_role'); checks += 1;
    equal(await state(row), drifted, 'rejected MFA/conflicting request does not mutate billing or audit');
    equal({ gets: provider.gets.length, sources: provider.sources.length, sends: provider.sends.length }, ioBefore,
      'MFA rejection and conflicting replay require no provider calls');
  });

  await test('POST timeout without id stays unknown and never sends again', async () => {
    const row = await fixture('timeout', { due: true });
    const provider = mockedWompi(row, 'timeout');
    const first = await run(row, provider);
    equal(first.sent, 1, 'timeout follows one send start');
    equal(first.failed, 1, 'timeout is reported as uncertainty');
    equal((await state(row)).attempts[0].state, 'unknown', 'uncertain SQL barrier survives timeout');
    for (let index = 0; index < 3; index += 1) {
      const stats = await run(row, provider);
      equal(stats.sent, 0, 'unknown without id cannot resend');
      equal(stats.noIds, 1, 'unknown without id is visibly blocked');
    }
    equal(provider.sends.length, 1, 'one possibly sent POST total');
    equal(provider.preparations.length, 1, 'no second prepared POST');
  });

  await test('late approval preserves money but cannot reopen cancelled billing', async () => {
    const row = await fixture('cancelled-late-approval', { due: true });
    const provider = mockedWompi(row, 'pending');
    equal((await run(row, provider)).sent, 1, 'possibly pending original sent once');
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_update_subscription',
      await adminArgs(row, 'amount', randomUUID(), { p_amount: 35000 }))}`, 'BILLING_CYCLE_IN_PROGRESS'); checks += 1;
    const cancelled = await db.rpc('billing_v2_admin_update_subscription', await adminArgs(row, 'cancel'));
    equal(cancelled.chargeMayComplete, true, 'atomic cancellation warns about already granted send');
    const transaction = [...provider.transactions.values()][0];
    transaction.status = 'approved'; transaction.finalizedAt = await db.now();
    const stats = await run(row, provider, 'reconcile');
    equal(stats.failed, 0, 'late GET records real money without transport failure');
    equal(stats.approved, 1, 'late approval is recorded once');
    equal(stats.sent, 0, 'late reconciliation does not send');
    const observed = await state(row);
    equal(observed.subscription.status, 'cancelled', 'late money cannot reactivate cancellation');
    equal(observed.subscription.next_payment_date, null, 'late money cannot restore schedule');
    equal(observed.cycles[0].state, 'cancelled', 'old cycle stays cancelled');
    equal(observed.payments[0].status, 'approved', 'real approval is retained');
    equal(observed.audits.length, 1, 'blocked in-progress amount change left no partial audit');
    equal((await run(row, provider)).sent, 0, 'cancelled remains off after approval');
    equal((await run(row, provider)).approved, 0, 'late approval not counted twice');
    const future = await db.value(`to_char((date_trunc('month',clock_timestamp() at time zone 'America/Bogota')
      +interval '1 month 15 days 7 hours') at time zone 'America/Bogota' at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
    const source = await provider.getPaymentSource({ paymentSourceId: row.source });
    await db.rpc('billing_v2_admin_update_subscription', await adminArgs(row, 'reactivate', randomUUID(), {
      p_expected_version: 1, p_preferred_payment_day: 16, p_next_payment_date: future,
      p_donor_authorization_confirmed: true, p_source_verification: sourceEnvelope(source) }));
    const reactivated = await state(row);
    equal(reactivated.cycles.length, 2, 'reactivation creates separate cycle beside cancelled original');
    equal(reactivated.cycles[0].id, observed.cycles[0].id, 'old cycle identity preserved');
    equal(reactivated.cycles[0].state, 'cancelled', 'reactivation never reopens old cycle');
    equal(reactivated.cycles[1].origin, 'reactivation', 'new future cycle has audited origin');
    equal(reactivated.cycles[1].subscription_version, 2, 'new cycle freezes fresh version');
    ok(reactivated.cycles[1].authorization_snapshot.mandateId !== observed.cycles[0].authorization_snapshot.mandateId,
      'reactivation creates fresh mandate');
    equal((await run(row, provider)).sent, 0, 'future new cycle does not immediately charge');
    equal(provider.sends.length, 1, 'no additional send on cancellation or reactivation');
  });

  await test('real receipt runner GET applies one-time approval idempotently; uniques never retry', async () => {
    const row = await fixture('unique-receipt', { recurring: false });
    const provider = mockedWompi(row, 'approved');
    await initialDispatch(row, provider);
    const transaction = [...provider.transactions.values()][0];
    const receipt = randomUUID();
    const raw = { receipt_version: 1, event: 'transaction.updated', environment: 'sandbox',
      event_timestamp: Math.floor(Date.parse(transaction.finalizedAt) / 1000),
      transaction: { id: transaction.id, status: 'APPROVED', reference: transaction.reference,
        amount_in_cents: transaction.amountInCents, currency: 'COP', finalized_at: transaction.finalizedAt },
      checksum: 'fixture-only', body_sha256: 'fixture-only', received_at: await db.now() };
    await db.write(`insert into public.webhook_events(id,raw) values(${literal(receipt)},${literal(raw)});`);
    const stats = await reconcileWompiReceipts({ supabase: clientFor(row, provider),
      getTransaction: provider.getTransaction, getPaymentSource: provider.getPaymentSource, logger });
    equal(stats.failed, 0, 'real receipt envelope reaches SQL without mismatch');
    equal(stats.processed, 1, 'receipt GET applies approval');
    equal((await state(row)).payments.length, 1, 'receipt produces one approved payment');
    const canonical = await db.value(`select jsonb_agg(to_jsonb(e)) from public.webhook_events e
      where transaction_id=${literal(transaction.id)} and record_kind='canonical'`);
    equal(canonical.length, 1, 'one canonical verified event');
    const rpcTrace = trace.find((entry) => entry.fixture === row.label && entry.name === 'apply_verified_wompi_event');
    equal(rpcTrace.args.p_raw.verification_source, 'provider_get', 'receipt trusts GET, not webhook claims');
    equal((await db.rpc('apply_verified_wompi_event', rpcTrace.args)).result, 'duplicate', 'identical verified event is idempotent');
    equal((await reconcileWompiReceipts({ supabase: clientFor(row, provider), getTransaction: provider.getTransaction,
      getPaymentSource: provider.getPaymentSource, logger })).received, 0, 'processed receipt not picked again');
    equal((await run(row, provider)).sent, 0, 'one-time approval cannot trigger monthly POST');
    const after = await state(row);
    equal(after.cycles.length, 0, 'one-time has no recurring cycle');
    equal(after.attempts.length, 1, 'one-time original only');
    equal(after.subscription.next_payment_date, null, 'one-time has no monthly date');
    equal(after.payments.filter((payment) => payment.status === 'approved').length, 1, 'repeats retain one approval');
    equal((await db.value(`select count(*) from public.webhook_events where transaction_id=${literal(transaction.id)} and record_kind='canonical'`)), 1,
      'event replay retains one canonical row');
  });

  await test('one-time DECLINED and missing consent cannot schedule retry', async () => {
    for (const options of [{ recurring: false }, { consent: false }]) {
      const row = await fixture(options.recurring === false ? 'unique-decline' : 'no-consent', options);
      const provider = mockedWompi(row, 'declined');
      await initialDispatch(row, provider);
      equal((await run(row, provider, 'reconcile')).failed, 0, 'decline reconciles without inventing consent');
      const observed = await state(row);
      equal(observed.cycles.some((cycle) => cycle.state === 'retry_wait'), false, 'no retry authorization means no queue');
      equal(observed.subscription.billing_authorization, null, 'no mandate fabricated');
      equal((await run(row, provider)).sent, 0, 'unauthorized decline never retries');
      equal((await state(row)).attempts.length, 1, 'one original only without retry consent');
    }
  });

  await test('unknown decline reason and incomplete source proof stay off', async () => {
    for (const incompleteSource of [false, true]) {
      const row = await fixture(incompleteSource ? 'incomplete-proof' : 'unknown-decline');
      const provider = mockedWompi(row, 'declined');
      await initialDispatch(row, provider);
      if (incompleteSource) provider.getPaymentSource = async () => ({ id: row.source, type: 'CARD',
        status: 'AVAILABLE', environment: 'sandbox', verificationSource: 'provider_get' });
      else [...provider.transactions.values()][0].statusMessage = 'DECLINED';
      const stats = await run(row, provider, 'reconcile');
      equal(stats.failed, 0, 'nonretryable result remains a SQL review, not a transport failure');
      const observed = await state(row);
      equal(observed.cycles[0].state, 'manual_review', 'insufficient proof or unknown reason closes automation');
      equal(observed.subscription.next_payment_date, null, 'nonretryable decline stays off');
      equal((await run(row, provider)).sent, 0, 'no retry for unverified insufficient funds');
    }
  });

  await test('cancelled retry and missed window stay off', async () => {
    const cancelled = await yesterdayInitial('cancelled-retry');
    await run(cancelled.row, cancelled.provider, 'reconcile');
    const args = await adminArgs(cancelled.row, 'cancel_retry', randomUUID(), { p_expected_cycle_id: cancelled.cycle });
    const first = await db.rpc('billing_v2_admin_update_subscription', args);
    equal(first.billing_version, 1, 'cancel_retry advances version atomically');
    equal(await db.rpc('billing_v2_admin_update_subscription', args), first, 'cancel_retry request is idempotent');
    equal((await run(cancelled.row, cancelled.provider)).sent, 0, 'cancelled reservation stays off');
    equal((await state(cancelled.row)).subscription.billing_hold_reason, 'admin_cancel_retry', 'explicit cancellation hold remains');
    equal((await state(cancelled.row)).audits.length, 1, 'one cancellation audit');
    const expired = await yesterdayInitial('expired-window', 2);
    equal((await run(expired.row, expired.provider)).sent, 0, 'D+2 never sends a missed retry');
    const observed = await state(expired.row);
    equal(observed.cycles[0].hold_reason, 'retry_window_missed', 'real DB clock excludes past midnight window');
    equal(observed.subscription.next_payment_date, null, 'missed retry disables schedule');
    equal((await run(expired.row, expired.provider)).sent, 0, 'missed retry stays off');
  });

  await test('admin amount/version/requestId/MFA is atomic and reactivation creates future cycle without charge', async () => {
    const row = await fixture('admin-reactivation', { due: true });
    const request = randomUUID();
    const args = await adminArgs(row, 'amount', request, { p_amount: 35000 });
    const first = await db.rpc('billing_v2_admin_update_subscription', args);
    equal(first.amount, 35000, 'authorized amount change');
    equal(first.billing_version, 1, 'version increases once');
    equal(await db.rpc('billing_v2_admin_update_subscription', args), first, 'same administrative request replays');
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_update_subscription', { ...args, p_amount: 36000 })}`, 'ADMIN_REQUEST_ID_CONFLICT'); checks += 1;
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_update_subscription', { ...args, p_request_id: randomUUID() })}`, 'SUBSCRIPTION_VERSION_CONFLICT'); checks += 1;
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_update_subscription', { ...args, p_actor_aal: 'aal1' })}`, 'ADMIN_NOT_AUTHORIZED'); checks += 1;
    const afterAmount = await state(row);
    equal(afterAmount.audits.length, 1, 'failed mutation/replay has no audit or partial version write');
    equal(afterAmount.subscription.amount, 35000, 'failed amount change is atomic');
    equal(afterAmount.audits[0].expected_version, 0, 'audit captures expected version');
    equal(afterAmount.audits[0].actor_aal, 'aal2', 'audit captures fresh MFA context');
    equal(afterAmount.audits[0].after_value.donor_authorization_confirmed, false, 'non-consent mutation records false audit consent');
    await db.rpc('billing_v2_admin_update_subscription', await adminArgs(row, 'cancel', randomUUID(), { p_expected_version: 1 }));
    const provider = mockedWompi(row);
    equal((await run(row, provider)).sent, 0, 'fully cancelled subscription stays off');
    const future = await db.value(`to_char((date_trunc('month',clock_timestamp() at time zone 'America/Bogota')
      +interval '1 month 15 days 7 hours') at time zone 'America/Bogota' at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
    const reactivateArgs = await adminArgs(row, 'reactivate', randomUUID(), { p_expected_version: 2,
      p_preferred_payment_day: 16, p_next_payment_date: future, p_donor_authorization_confirmed: true,
      p_source_verification: sourceEnvelope(await provider.getPaymentSource({ paymentSourceId: row.source })) });
    const reactivated = await db.rpc('billing_v2_admin_update_subscription', reactivateArgs);
    equal(reactivated.billing_version, 3, 'reactivation creates new version');
    equal(await db.rpc('billing_v2_admin_update_subscription', reactivateArgs), reactivated, 'reactivation replay does not create extra cycle');
    const observed = await state(row);
    equal(observed.cycles.length, 1, 'one new reactivation cycle');
    equal(observed.cycles[0].origin, 'reactivation', 'reactivation does not reuse cancelled cycle');
    const reactivationAudit = observed.audits.find((audit) => audit.action === 'reactivate');
    equal(reactivationAudit.after_value.donor_authorization_confirmed, true, 'reactivation audit records explicit donor consent');
    equal(observed.cycles[0].authorization_audit_id, reactivationAudit.id, 'future cycle links consent audit');
    equal(observed.cycles[0].authorization_snapshot.auditId, reactivationAudit.id, 'frozen mandate links same consent audit');
    equal(reactivationAudit.committed_response, reactivated, 'audit-only consent field does not change replay response');
    equal(observed.attempts[0].state, 'prepared', 'future original is reserved but unsent');
    equal(Date.parse(observed.cycles[0].original_due_at), Date.parse(future), 'new original has future due date');
    equal((await run(row, provider)).sent, 0, 'reactivation does not immediately charge');
    const source = await provider.getPaymentSource({ paymentSourceId: row.source });
    const denied = await db.rpc('billing_v2_authorize_send', { p_attempt_id: observed.attempts[0].id, p_source_verification: sourceEnvelope(source) });
    equal(denied.canDispatch, false, 'SQL denies future original grant');
    equal(denied.reason, 'ORIGINAL_NOT_DUE', 'future due guard is enforced');
    equal(provider.sends.length, 0, 'reactivation sends zero POSTs');
  });

  await test('fictional historical GET never fabricates cycles or consent', async () => {
    const row = await fixture('historical', { consent: false });
    const provider = mockedWompi(row);
    const attempt = randomUUID();
    const txId = 'fixture-history-' + randomUUID();
    await db.write(`insert into public.payment_attempts(id,donor_id,subscription_id,reference,amount,currency,
      subscription_version,state,wompi_transaction_id) values(${literal(attempt)},${literal(row.donor)},
      ${literal(row.subscription)},${literal(row.reference)},30000,'COP',0,'pending',${literal(txId)});`);
    provider.transactions.set(txId, { id: txId, reference: row.reference, amountInCents: 3000000, currency: 'COP',
      paymentSourceId: row.source, paymentMethodType: 'CARD', status: 'declined',
      statusMessage: VERIFIED_INSUFFICIENT_FUNDS_MESSAGE, finalizedAt: await db.now(),
      environment: 'sandbox', verificationSource: 'provider_get' });
    equal((await run(row, provider, 'reconcile')).failed, 0, 'historical GET uses retained SQL bridge');
    equal((await run(row, provider)).sent, 0, 'historical review never sends');
    const observed = await state(row);
    equal(observed.cycles.length, 0, 'no invented historical billing cycles');
    equal(observed.attempts[0].attempt_number, null, 'no invented historical ordinal');
    equal(observed.subscription.billing_authorization, null, 'no invented historical consent');
    equal(observed.subscription.next_payment_date, null, 'legacy schedule remains untouched');
  });

  await test('legacy recovery uses linked historical money, preserves schedule and replays stable needsReview', async () => {
    const row = await fixture('legacy-historical-money', { consent: false });
    const provider = mockedWompi(row);
    const attempt = randomUUID();
    const payment = randomUUID();
    const txId = 'fixture-legacy-money-' + randomUUID();
    await db.write(`update public.subscriptions set amount=35000 where id=${literal(row.subscription)};
      insert into public.payment_attempts(id,donor_id,subscription_id,reference,amount,currency,
        subscription_version,state,wompi_transaction_id) values(${literal(attempt)},${literal(row.donor)},
        ${literal(row.subscription)},${literal(row.reference)},30000,'COP',0,'unknown',${literal(txId)});
      insert into public.payments(id,subscription_id,payment_attempt_id,reference,amount,currency,status,
        wompi_transaction_id,billing_review_required) values(${literal(payment)},${literal(row.subscription)},
        ${literal(attempt)},${literal(row.reference)},10000,'COP','pending',${literal(txId)},true);`);
    const before = await state(row);
    equal(before.subscription.amount, 35000, 'current subscription amount differs from historical payment');
    equal(before.attempts[0].amount, 30000, 'legacy attempt amount differs from historical payment');
    equal(before.payments[0].amount, 10000, 'linked historical payment is authoritative money');
    provider.transactions.set(txId, { id: txId, reference: row.reference, amountInCents: 1000000, currency: 'COP',
      paymentSourceId: row.source, paymentMethodType: 'CARD', status: 'approved', statusMessage: null,
      finalizedAt: await db.now(), environment: 'sandbox', verificationSource: 'provider_get' });
    const transaction = await provider.getTransaction({ transactionId: txId });
    const request = randomUUID();
    const args = await recoveryArgs(row, transaction, { id: attempt, amount: before.payments[0].amount, currency: 'COP' }, request);
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_reconcile_payment_attempt',
      { ...args, p_amount: before.attempts[0].amount })}`, 'PAYMENT_RECOVERY_INVALID_INPUT', 'service_role'); checks += 1;
    equal((await state(row)).audits.length, 0, 'wrong current/attempt money does not leave partial audit');
    const first = await db.rpc('billing_v2_admin_reconcile_payment_attempt', args);
    equal(first.result, 'review', 'legacy real approval remains schedule-protected review');
    equal(first.needsReview, true, 'legacy needsReview is explicit and stored');
    equal(first.reason, 'LEGACY_RESULT_SCHEDULE_PROTECTED', 'legacy recovery uses retained bridge');
    const after = await state(row);
    equal(after.payments.length, 1, 'historical payment upgraded in place, not duplicated');
    equal(after.payments[0].id, payment, 'historical payment identity preserved');
    equal(after.payments[0].amount, 10000, 'historical money remains 10000 COP');
    equal(after.payments[0].status, 'approved', 'verified historic amount can be approved');
    equal(after.attempts[0].amount, 30000, 'legacy attempt money is not rewritten');
    equal(after.attempts[0].state, 'approved', 'legacy attempt reflects verified provider status');
    equal(after.subscription, before.subscription, 'legacy approval cannot update current billing configuration');
    equal(after.cycles.length, 0, 'legacy recovery invents no cycle');
    equal(after.subscription.billing_authorization, null, 'legacy recovery invents no consent');
    equal(after.audits.length, 1, 'one atomic historical recovery audit');
    equal(after.audits[0].committed_response, first, 'historic recovery response and needsReview stored exactly');
    const gets = provider.gets.length;
    transaction.status = 'pending'; transaction.finalizedAt = null;
    provider.getTransaction = async () => { throw new Error('LEGACY_REPLAY_MUST_NOT_GET_PROVIDER'); };
    const replayArgs = recoveryReplayArgs(await recoveryArgs(row, transaction, before.attempts[0], request));
    equal(await db.rpc('billing_v2_admin_recovery_replay', replayArgs), { result: 'replay', response: first },
      'pending provider drift cannot change original historical needsReview');
    equal(provider.gets.length, gets, 'historical helper replay performs no GET');
    equal(await state(row), after, 'historical replay leaves payment, subscription and audit unchanged');
    equal((await db.rpc('billing_v2_admin_reconcile_payment_attempt', args)), first, 'historical apply RPC also replays same response');
    await db.write(`update public.payments set reference=null where id=${literal(payment)};`);
    const nullReference = await state(row);
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_reconcile_payment_attempt',
      { ...args, p_request_id: randomUUID() })}`, 'PAYMENT_RECOVERY_INVALID_INPUT', 'service_role'); checks += 1;
    equal(await state(row), nullReference, 'different historical money with NULL reference rejects atomically');
    const otherPayment = randomUUID();
    await db.write(`insert into public.payments(id,subscription_id,payment_attempt_id,reference,amount,currency,status,
      wompi_transaction_id,billing_review_required) values(${literal(otherPayment)},${literal(row.subscription)},
      ${literal(attempt)},${literal(row.reference)},10000,'COP','pending',${literal('fixture-other-' + randomUUID())},true);`);
    const ambiguous = await state(row);
    await db.expectError(`perform ${rpcExpression('billing_v2_admin_reconcile_payment_attempt',
      { ...args, p_request_id: randomUUID() })}`, 'PAYMENT_RECOVERY_INVALID_INPUT', 'service_role'); checks += 1;
    equal(await state(row), ambiguous, 'ambiguous historical links reject atomically');
  });

  equal(forbiddenFetches, 0, 'zero real fetch GET/POST calls');
  equal(await db.value("select digest from public.payment_admin_migrations where name='billing-retry-v0.4.0'"),
    INSTALLED_DIGEST, 'installed SQL generation unchanged; no marker rewrites');
  equal(await digest(), sourceDigestAtStart, 'local migration source unchanged during this exact-generation test');
  await db.execute('reset role; rollback;');
  rolledBack = true;
  equal(await db.value(fingerprints), baseline, 'all pre-existing fictional contents preserved after rollback');
  equal(await db.value(`select count(*) from public.donors where id in (${fixtureDonors.map(literal).join(',')})`), 0,
    'no persistent contract fixtures');
} catch (error) {
  fatal = error.message;
} finally {
  try { await db.close(); } catch (error) { fatal ??= error.message; }
  globalThis.fetch = originalFetch;
}

const report = { version: '0.4.0', localOnly: true, container: CONTAINER, database: DATABASE,
  migrationDigest: INSTALLED_DIGEST, sourceDigestAtStart, network: 'none', noPorts: true,
  rollback: rolledBack, forbiddenFetches, checks,
  rpcCalls: db.rpcCalls, jobAndReceiptRpcCalls: trace.length, expectedSqlErrors: db.expectedSqlErrors,
  cases: results, ...(fatal ? { fatal } : {}),
  notCovered: ['Next.js HTTP route imports and response/Zod mapping', 'Origin/CSRF and HTTP rate limiting',
    'real session cookies, Auth/TOTP challenge verification', 'Wompi HTTP serialization, signatures and webhook checksum',
    'PostgreSQL lock/concurrent-worker races and response-loss across COMMIT',
    'waiting overnight: D-1 original is a newly inserted fictional fixture, not a clock override',
    'production behavior/deployment and exact wall-clock 07:00/midnight transitions'] };
console.log(JSON.stringify(report, null, 2));
process.exitCode = fatal || results.some((result) => result.result !== 'passed') ? 1 : 0;
