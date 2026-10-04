// v0.3.0 | 2026-10-03. Fixture GET -> actual receipt/monthly runners -> real Postgres RPC.
// ESCRITURA (lab only): node supabase/tests/historical_cli_sql_smoke.mjs --lab-url <explicit-fixture-url> [--lab-container hpe-admin-lab-033]
// Eight isolated BEGIN/ROLLBACK scenarios. No real provider/Auth, environment credentials or charges.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { fixtureArguments, fixtureConnection } from './admin_revocation_concurrency.mjs';
import { reconcileWompiReceipts } from '../../scripts/wompi-receipt-runner.mjs';
import { runMonthlyCharges } from '../../scripts/monthly-charge-runner.mjs';

const subscriptionId = '20000000-0000-0000-0000-000000000090';
const paymentId = '70000000-0000-0000-0000-000000000090';
const transactionId = 'tx-historic-10000';
const oldSource = 'fixture-legacy-source';
const cutoverEnv = Object.freeze({ APP_OPERATION_MODE: 'active', FINANCIAL_OPERATIONS_ENABLED: 'false',
  WOMPI_ENV: 'sandbox', SUPABASE_URL: 'http://127.0.0.1:54321', VERCEL_ENV: 'preview' });

async function assertFixture(client) {
  const { rows: [guard] } = await client.query(`select current_database() = 'hpe_lab'
    and public.payment_admin_schema_ready()
    and (select count(*) from information_schema.columns where table_schema = 'auth' and table_name = 'users') = 2
    and exists(select 1 from public.donors where id = '10000000-0000-0000-0000-000000000090' and email = 'legacy@example.test')
    and exists(select 1 from public.payments where id = '70000000-0000-0000-0000-000000000090'
      and subscription_id = '20000000-0000-0000-0000-000000000090' and wompi_transaction_id = 'tx-historic-10000'
      and amount = 10000 and currency = 'COP' and status = 'approved' and reference is null
      and approved_at is null and provider_effective_at is null and payment_attempt_id is null and billing_review_required)
    and not exists(select 1 from public.payment_attempts where subscription_id = '20000000-0000-0000-0000-000000000090')
    and not exists(select 1 from public.checkout_intents where reference = 'HPE-LEGACY') as safe`);
  assert.equal(guard.safe,true,'UNENRICHED_DISPOSABLE_FIXTURE_REQUIRED');
}

// JSON projection gives timestamptz strings, as Supabase does, rather than pg's native Date objects.
function project(row, table, columns) {
  if (columns === '*' || columns === '*, subscription:subscription_id(id,preferred_payment_day)') return row;
  if (table === 'subscriptions' && columns === 'id, reference') return { id: row.id, reference: row.reference };
  if (table === 'webhook_events' && columns === 'id,raw,processing_state') {
    return { id: row.id, raw: row.raw, processing_state: row.processing_state };
  }
  const dueColumns = 'id, created_at, amount, currency, next_payment_date, wompi_payment_source_id, reference, preferred_payment_day, billing_version, donor:donor_id(id,email)';
  if (table === 'subscriptions' && columns === dueColumns) return Object.fromEntries([
    'id','created_at','amount','currency','next_payment_date','wompi_payment_source_id','reference',
    'preferred_payment_day','billing_version','donor',
  ].map((key) => [key,row[key]]));
  throw new Error('FIXTURE_ADAPTER_PROJECTION_NOT_ALLOWED');
}

export function createFixturePgAdapter(client, context) {
  return {
    get auth() { context.calls.auth += 1; throw new Error('REAL_AUTH_DISABLED'); },
    from(table) {
      let columns = '*';
      let start = 0;
      let end = Number.MAX_SAFE_INTEGER;
      let limit = Number.MAX_SAFE_INTEGER;
      const filters = [];
      const orders = [];
      const read = async () => {
        let result;
        if (table === 'webhook_events') result = await client.query('select to_jsonb(r) as value from public.webhook_events r where id = $1',[context.receiptId]);
        else if (table === 'payments') result = await client.query('select to_jsonb(r) as value from public.payments r where id = $1',[paymentId]);
        else if (table === 'subscriptions') result = await client.query(`select to_jsonb(s) || jsonb_build_object('donor',
          (select jsonb_build_object('id',d.id,'email',d.email) from public.donors d where d.id = s.donor_id)) as value
          from public.subscriptions s where s.id = $1`,[subscriptionId]);
        else if (table === 'payment_attempts') result = await client.query('select to_jsonb(r) as value from public.payment_attempts r where subscription_id = $1',[subscriptionId]);
        else throw new Error('FIXTURE_ADAPTER_TABLE_NOT_ALLOWED');
        let rows = result.rows.map((row) => row.value).filter((row) => filters.every((filter) => filter(row)));
        rows.sort((left,right) => {
          for (const { field,ascending } of orders) {
            const compared = String(left[field] ?? '').localeCompare(String(right[field] ?? ''));
            if (compared) return ascending ? compared : -compared;
          }
          return 0;
        });
        rows = rows.slice(start,Math.min(end + 1,start + limit));
        return { data: rows.map((row) => project(row,table,columns)), error: null };
      };
      const query = {
        select(value = '*') { columns = value; return query; },
        eq(field,value) { filters.push((row) => row[field] === value); return query; },
        in(field,values) { assert.ok(Array.isArray(values)); filters.push((row) => values.includes(row[field])); return query; },
        is(field,value) { filters.push((row) => row[field] === value); return query; },
        not(field,operator,value) { assert.equal(operator,'is'); filters.push((row) => row[field] !== value); return query; },
        lte(field,value) { filters.push((row) => row[field] != null && Date.parse(row[field]) <= Date.parse(value)); return query; },
        or(value) {
          assert.equal(value,'status.in.(approved,pending),billing_review_required.eq.true');
          filters.push((row) => ['approved','pending'].includes(row.status) || row.billing_review_required === true);
          return query;
        },
        order(field,{ ascending = true } = {}) { orders.push({ field,ascending }); return query; },
        range(from,to) { assert.ok(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from); start = from; end = to; return query; },
        limit(value) { limit = value; return query; },
        maybeSingle: async () => { const { data,error } = await read(); assert.ok(data.length <= 1); return { data: data[0] ?? null,error }; },
        single: async () => { const { data,error } = await read(); assert.equal(data.length,1); return { data: data[0],error }; },
        async insert(row) {
          assert.equal(table,'audit_logs','FIXTURE_RUNNER_ATTEMPTED_OPERATIONAL_INSERT');
          assert.ok(row.subscription_id == null || row.subscription_id === subscriptionId);
          context.calls.audit += 1;
          await client.query('insert into public.audit_logs(action,subscription_id,details) values($1,$2,$3)',
            [row.action,row.subscription_id,row.details]);
          return { data: null,error: null };
        },
        then: (resolve,reject) => read().then(resolve,reject),
      };
      return query;
    },
    async rpc(name,p = {}) {
      if (name === 'payment_admin_schema_ready') {
        assert.deepEqual(p,{});
        context.calls.schemaReady += 1;
        const { rows: [result] } = await client.query('select public.payment_admin_schema_ready() as value');
        return { data: result.value,error: null };
      }
      assert.equal(name,'apply_verified_wompi_event','FIXTURE_RUNNER_ATTEMPTED_CHARGE_OR_SCHEDULE_RPC');
      assert.equal(p.p_transaction_id,transactionId);
      assert.equal(p.p_reference,'HPE-LEGACY');
      assert.equal(p.p_amount,10000,'CLI_USED_CURRENT_SUBSCRIPTION_AMOUNT');
      assert.equal(p.p_currency,'COP');
      assert.equal(p.p_status,context.status);
      assert.equal(p.p_payment_source_id,oldSource,'CLI_REPLACED_VERIFIED_HISTORICAL_SOURCE');
      if (context.runner === 'monthly') assert.equal(p.p_candidate_next_payment,null,'MONTHLY_HISTORICAL_CANDIDATE_NOT_NULL');
      // Pass the actual runner descriptor untouched. Never normalize a flat p_raw to hide an integration bug.
      assert.equal(p.p_raw.transaction?.id,transactionId,'RUNNER_VERIFIED_DESCRIPTOR_NOT_NESTED');
      assert.equal(p.p_raw.transaction.reference,p.p_reference);
      assert.equal(p.p_raw.transaction.amount_in_cents,1000000);
      assert.equal(p.p_raw.transaction.currency,'COP');
      assert.equal(String(p.p_raw.transaction.status).toLowerCase(),context.status);
      context.calls.apply.push(p);
      const { rows: [result] } = await client.query(`select public.apply_verified_wompi_event(
        $1::text,$2::text,$3::text,$4::text,$5::text,$6::integer,$7::text,$8::text,
        $9::timestamptz,$10::timestamptz,$11::jsonb) as value`,
      [p.p_event_key,p.p_transaction_id,p.p_event_type,p.p_reference,p.p_payment_source_id,
        p.p_amount,p.p_currency,p.p_status,p.p_effective_at,p.p_candidate_next_payment,p.p_raw]);
      return { data: result.value,error: null };
    },
  };
}

async function seedScenario(client, runner, status) {
  const context = { runner,status,receiptId: randomUUID(),legacyId: randomUUID(),actorId: randomUUID(),
    finalizedAt: null,calls: { apply: [],schemaReady: 0,charge: 0,auth: 0,get: 0,audit: 0 }, errors: [] };
  context.legacyRaw = { transaction_id: transactionId,event_type: 'transaction.updated',applied_fixture: true };
  context.receiptRaw = { receipt_version: 1,event: 'transaction.updated',environment: 'sandbox',event_timestamp: null,
    transaction: { id: transactionId,reference: 'HPE-LEGACY',amount_in_cents: 1000000,currency: 'COP',
      status: status === 'approved' ? 'APPROVED' : 'PENDING',finalized_at: null,payment_source_id: oldSource },
    checksum: 'fixture',body_sha256: 'fixture',received_at: '2026-10-03T12:00:00Z' };
  await client.query('insert into auth.users(id,email) values($1,$2)',[context.actorId,`${context.actorId}@example.test`]);
  await client.query("insert into public.admin_users(user_id,role) values($1,'admin')",[context.actorId]);
  await client.query(`update public.subscriptions set amount = 20000,next_payment_date = '2026-12-16T12:00:00Z',billing_version = 1,
    status = 'active',wompi_payment_source_id = 'fixture-current-new-source' where id = $1`,[subscriptionId]);
  if (status !== 'approved') await client.query("update public.payments set status = 'pending' where id = $1",[paymentId]);
  await client.query(`insert into public.admin_audit_logs(actor_user_id,subscription_id,action,reason,before_value,after_value,request_id,created_at)
    values($1,$2,'schedule','Manual future fixture schedule','{}','{}',$3,'2026-10-02T12:00:00Z')`,
  [context.actorId,subscriptionId,randomUUID()]);
  const { rows: [before] } = await client.query('select to_jsonb(s) as value from public.subscriptions s where id = $1',[subscriptionId]);
  context.subscriptionBefore = before.value;
  await client.query(`insert into public.webhook_events(id,transaction_id,event_type,raw,record_kind)
    values($1,$2,'transaction.updated',$3,'legacy')`,[context.legacyId,transactionId,context.legacyRaw]);
  await client.query("update public.webhook_events set processing_state = 'legacy_applied' where id = $1",[context.legacyId]);
  if (runner === 'receipt') await client.query('insert into public.webhook_events(id,transaction_id,event_type,raw) values($1,null,null,$2)',
    [context.receiptId,context.receiptRaw]);
  context.supabase = createFixturePgAdapter(client,context);
  context.getTransaction = async ({ transactionId: requested }) => {
    assert.equal(requested,transactionId);
    context.calls.get += 1;
    return { id: transactionId,reference: 'HPE-LEGACY',amountInCents: 1000000,currency: 'COP',status,
      paymentSourceId: oldSource,finalizedAt: context.finalizedAt };
  };
  context.createTransaction = async () => { context.calls.charge += 1; throw new Error('REAL_PROVIDER_CHARGE_DISABLED'); };
  context.logger = { log() {},error() { context.errors.push('FIXTURE_RUNNER_ERROR'); } };
  return context;
}

async function runScenario(client, context, phase) {
  const applyCount = context.calls.apply.length;
  const getCount = context.calls.get;
  let result;
  if (context.runner === 'receipt') {
    result = await reconcileWompiReceipts(context);
    assert.deepEqual(result,phase === 'unknown' ? { received: 1,processed: 0,review: 1,failed: 0 }
      : phase === 'empty' ? { received: 0,processed: 0,review: 0,failed: 0 }
        : { received: 1,processed: 1,review: 0,failed: 0 });
  } else {
    result = await runMonthlyCharges({ ...context,mode: 'reconcile',now: new Date('2026-10-03T12:00:00Z'),env: cutoverEnv });
    assert.equal(result.mode,'reconcile');
    assert.equal(result.due,0,'MANUAL_FUTURE_AGENDA_WAS_TREATED_AS_DUE');
    assert.equal(result.outstanding,0);
    assert.equal(result.charged,0);
    assert.equal(result.reconciled,phase === 'unknown' || phase === 'empty' ? 0 : 1);
    assert.equal(result.blocked,phase === 'unknown' ? 1 : 0);
    assert.equal(result.failed,phase === 'unknown' ? 1 : 0);
    assert.equal(result.auditFailures,0);
    assert.equal(result.duplicateCheckFailures,0);
    assert.equal(result.schemaUnknown,0);
  }
  assert.equal(context.calls.apply.length - applyCount,phase === 'empty' ? 0 : 1);
  assert.equal(context.calls.get - getCount,phase === 'empty' ? 0 : 1);
  assert.equal(context.calls.charge,0);
  assert.equal(context.calls.auth,0);
  assert.equal(context.errors.length,0);
}

async function assertScenario(client, context) {
  const { rows: [payment] } = await client.query('select to_jsonb(p) as value from public.payments p where id = $1',[paymentId]);
  assert.equal(payment.value.amount,10000);
  assert.equal(payment.value.currency,'COP');
  assert.equal(payment.value.reference,'HPE-LEGACY');
  assert.equal(payment.value.status,context.status);
  assert.equal(payment.value.billing_review_required,false);
  assert.equal(payment.value.payment_attempt_id,null);
  if (context.status === 'approved') {
    assert.equal(Date.parse(payment.value.approved_at),Date.parse(context.finalizedAt));
    assert.equal(Date.parse(payment.value.provider_effective_at),Date.parse(context.finalizedAt));
  } else {
    const terminal = payment.value;
    assert.equal(terminal.approved_at,null);
    assert.equal(terminal.provider_effective_at,null);
    assert.equal(terminal.billing_review_required,false);
    assert.ok(context.calls.apply.every((p) => p.p_effective_at === null && p.p_candidate_next_payment === null));
  }
  const { rows: [after] } = await client.query('select to_jsonb(s) as value from public.subscriptions s where id = $1',[subscriptionId]);
  assert.deepEqual(after.value,context.subscriptionBefore,'CLI_HISTORICAL_ENRICHMENT_CHANGED_ADMIN_SCHEDULE');
  assert.equal(after.value.amount,20000);
  assert.equal(after.value.status,'active');
  assert.equal(after.value.billing_version,1);
  const { rows: [legacy] } = await client.query('select raw,processing_state from public.webhook_events where id = $1',[context.legacyId]);
  assert.deepEqual(legacy.raw,context.legacyRaw);
  assert.equal(legacy.processing_state,'legacy_applied');
  const { rows: [attempts] } = await client.query('select count(*)::integer as count from public.payment_attempts where subscription_id = $1',[subscriptionId]);
  assert.equal(attempts.count,0,'RUNNER_CREATED_CHARGE_ATTEMPT');
  if (context.runner === 'receipt') {
    const { rows: [receipt] } = await client.query('select raw,processing_state,processed_at from public.webhook_events where id = $1',[context.receiptId]);
    assert.deepEqual(receipt.raw,context.receiptRaw);
    assert.equal(receipt.processing_state,'processed');
    assert.ok(receipt.processed_at);
  } else {
    assert.equal(context.calls.schemaReady,context.status === 'approved' ? 4 : 3);
    assert.ok(context.calls.apply.every((p) => p.p_candidate_next_payment === null));
  }
}

export async function runHistoricalCliSql(input, { labContainer } = {}) {
  const client = new pg.Client(fixtureConnection(input, { labContainer }));
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const scenarios = [];
    for (const runner of ['receipt','monthly']) {
      scenarios.push({ runner,status: 'approved' });
      for (const status of ['declined','error','voided']) scenarios.push({ runner,status });
    }
    for (const { runner,status } of scenarios) {
      await client.query('begin');
      try {
        await assertFixture(client);
        const context = await seedScenario(client,runner,status);
        if (status === 'approved') {
          await runScenario(client,context,'unknown');
          context.finalizedAt = '2026-09-19T15:00:00Z';
        }
        await runScenario(client,context,'verified');
        const key = context.calls.apply.at(-1).p_event_key;
        if (runner === 'receipt') await client.query("update public.webhook_events set processing_state = 'needs_review' where id = $1",[context.receiptId]);
        else await client.query('update public.payments set billing_review_required = true where id = $1',[paymentId]);
        await runScenario(client,context,'repeated');
        assert.equal(context.calls.apply.at(-1).p_event_key,key,'REPEATED_VERIFICATION_CHANGED_CANONICAL_KEY');
        await runScenario(client,context,'empty');
        await assertScenario(client,context);
      } finally {
        await client.query('rollback');
      }
      await assertFixture(client);
    }
    return '8 receipt/monthly -> Postgres scenarios passed; FIN=false, charges=0, Auth=0, all fixture writes rolled back';
  } finally {
    try { if (connected) await client.query('rollback'); } finally { await client.end(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { input,labContainer } = fixtureArguments(process.argv.slice(2));
    console.log(await runHistoricalCliSql(input,{ labContainer }));
  } catch (error) {
    console.error('FIXTURE_CLI_SQL_FAILED',/^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : error.name);
    process.exitCode = 1;
  }
}
