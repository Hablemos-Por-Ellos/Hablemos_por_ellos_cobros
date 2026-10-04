// v0.3.0 | 2026-10-03. Manual parent-only SQL engine test, never part of npm/Vitest.
// Requires the disposable base_schema fixture + migration. Leaves new fixture rows; no cleanup deletes.
// ESCRITURA: node supabase/tests/admin_revocation_concurrency.mjs --lab-url <explicit-loopback-fixture-url> [--lab-container hpe-admin-lab-031]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { localDockerStream } from '../../scripts/ops/local-docker-stream.mjs';

export function fixtureConnection(input, { labContainer } = {}) {
  const url = new URL(input);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.pathname !== '/hpe_lab' || !url.port || !url.username || !url.password
    || url.search || url.hash) throw new Error('EXPLICIT_LOOPBACK_DISPOSABLE_FIXTURE_URL_REQUIRED');
  if (labContainer !== undefined && (typeof labContainer !== 'string'
    || !/^hpe-(admin|backup)-lab-[a-z0-9-]+$/.test(labContainer))) throw new Error('EXPLICIT_LAB_TARGET_REQUIRED');
  return { host: '127.0.0.1', port: Number(url.port), database: 'hpe_lab',
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false,
    connectionTimeoutMillis: 3000, query_timeout: 10000, statement_timeout: 8000,
    lock_timeout: 7000, application_name: 'hpe-fixture-admin-revocation',
    ...(labContainer === undefined ? {} : { stream: () => localDockerStream(labContainer) }) };
}

export function fixtureArguments(args) {
  if ((args.length !== 2 && args.length !== 4) || args[0] !== '--lab-url'
    || (args.length === 4 && args[2] !== '--lab-container')) throw new Error('EXPLICIT_LAB_ARGUMENTS_REQUIRED');
  const labContainer = args.length === 4 ? args[3] : undefined;
  fixtureConnection(args[1], { labContainer });
  return { input: args[1], labContainer };
}

async function blockedBy(observer, waiter, holder) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query('select $2::integer = any(pg_blocking_pids($1::integer)) as blocked', [waiter, holder]);
    if (rows[0].blocked) return;
    await pause(25);
  }
  throw new Error('ADMIN_LOCK_DID_NOT_SERIALIZE_CONCURRENT_OPERATION');
}

const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
async function mutate(client, fixture, expected = 0) {
  return client.query(`select public.admin_update_subscription($1::uuid,$2::integer,'amount',
    'Concurrent fixture mutation',$3::uuid,$4::uuid,12000,null,null,false,'aal2',$5::timestamptz,clock_timestamp()) as result`,
  [fixture.subscription, expected, randomUUID(), fixture.actor, fixture.issuedAt]);
}
async function revoke(client, fixture) {
  return client.query('select public.admin_revoke_own_sessions($1::uuid,$2::timestamptz) as revoked',
    [fixture.actor, fixture.issuedAt]);
}

export async function runFixtureConcurrency(input, { labContainer } = {}) {
  // No environment credentials/production catalogs. Docker is opt-in through the guarded local helper.
  const options = fixtureConnection(input, { labContainer });
  const clients = [new pg.Client(options), new pg.Client(options), new pg.Client(options)];
  const [observer, first, second] = clients;
  try {
    for (const client of clients) await client.connect();
    const { rows: [guard] } = await observer.query(`select current_database() = 'hpe_lab'
      and exists(select 1 from public.donors where id = '10000000-0000-0000-0000-000000000090'
        and email = 'legacy@example.test')
      and (select count(*) from information_schema.columns where table_schema = 'auth' and table_name = 'users') = 2
      and public.payment_admin_schema_ready() as safe`);
    assert.equal(guard.safe, true, 'DISPOSABLE_BASE_SCHEMA_FIXTURE_REQUIRED');
    const { rows: [time] } = await observer.query("select date_trunc('second',clock_timestamp()-interval '1 minute') as issued_at");
    const fixtures = Array.from({ length: 3 }, () => ({ actor: randomUUID(), donor: randomUUID(),
      subscription: randomUUID(), issuedAt: time.issued_at }));
    await observer.query('begin');
    await observer.query(`create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$`);
    await observer.query(`create or replace function auth.jwt() returns jsonb language sql stable as $$
      select jsonb_build_object('aal',current_setting('request.jwt.claim.aal',true),
        'iat',current_setting('request.jwt.claim.iat',true)) $$`);
    for (const fixture of fixtures) {
      await observer.query('insert into auth.users(id,email) values($1,$2)', [fixture.actor, `${fixture.actor}@example.test`]);
      await observer.query("insert into public.admin_users(user_id,role) values($1,'admin')", [fixture.actor]);
      await observer.query("insert into public.donors(id,email,first_name,last_name) values($1,$2,'Concurrent','Fixture')",
        [fixture.donor, `${fixture.donor}@example.test`]);
      await observer.query(`insert into public.subscriptions(id,donor_id,amount,status,reference)
        values($1,$2,10000,'active',$3)`, [fixture.subscription, fixture.donor, `HPE-CONC-${fixture.subscription}`]);
    }
    await observer.query('commit');
    const { rows: [pidA] } = await first.query('select pg_backend_pid() as pid');
    const { rows: [pidB] } = await second.query('select pg_backend_pid() as pid');

    // Mutation holds SHARE until COMMIT; revocation MUST be the last write in this order.
    await first.query('begin');
    await first.query('set local role service_role');
    await mutate(first, fixtures[0]);
    await second.query('begin');
    await second.query('set local role service_role');
    const laterRevoke = outcome(revoke(second, fixtures[0]));
    await blockedBy(observer, pidB.pid, pidA.pid);
    await first.query('commit');
    const revoked = await laterRevoke;
    if (revoked.error) throw revoked.error;
    assert.equal(revoked.value.rows[0].revoked, true);
    await second.query('commit');
    const { rows: [lastWrite] } = await observer.query(`select s.amount,s.billing_version,
      a.sessions_valid_after > $2::timestamptz as revoked from public.subscriptions s
      join public.admin_users a on a.user_id = $1 where s.id = $3`,
    [fixtures[0].actor, fixtures[0].issuedAt, fixtures[0].subscription]);
    assert.equal(lastWrite.amount, 12000);
    assert.equal(lastWrite.billing_version, 1);
    assert.equal(lastWrite.revoked, true);
    await first.query('begin');
    await first.query('set local role service_role');
    await assert.rejects(() => mutate(first, fixtures[0], 1), (error) => error.code === '42501');
    await first.query('rollback');
    await first.query('begin');
    await first.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.aal','aal2',true),set_config('request.jwt.claim.iat',$2,true)",
      [fixtures[0].actor, Math.floor(fixtures[0].issuedAt.getTime() / 1000).toString()]);
    await first.query('set local role authenticated');
    const { rows: [rls] } = await first.query('select count(*)::integer as count from public.donors');
    assert.equal(rls.count, 0, 'OLD_SESSION_RETAINED_RLS_AFTER_CONCURRENT_REVOKE');
    await first.query('rollback');

    // Revocation holds UPDATE first; a waiter must re-evaluate active/iat after the lock.
    await first.query('begin');
    await first.query('set local role service_role');
    assert.equal((await revoke(first, fixtures[1])).rows[0].revoked, true);
    await second.query('begin');
    await second.query('set local role service_role');
    const laterMutation = outcome(mutate(second, fixtures[1]));
    await blockedBy(observer, pidB.pid, pidA.pid);
    await first.query('commit');
    const rejected = await laterMutation;
    assert.equal(rejected.error?.code, '42501', 'REVOKED_WAITER_MUTATION_WAS_NOT_REJECTED');
    await second.query('rollback');
    assert.equal((await observer.query('select billing_version from public.subscriptions where id = $1',
      [fixtures[1].subscription])).rows[0].billing_version, 0);

    // A concurrent allowlist deactivation must also reject a waiting mutation.
    await first.query('begin');
    await first.query('update public.admin_users set active = false where user_id = $1', [fixtures[2].actor]);
    await second.query('begin');
    await second.query('set local role service_role');
    const inactiveMutation = outcome(mutate(second, fixtures[2]));
    await blockedBy(observer, pidB.pid, pidA.pid);
    await first.query('commit');
    assert.equal((await inactiveMutation).error?.code, '42501', 'INACTIVE_WAITER_MUTATION_WAS_NOT_REJECTED');
    await second.query('rollback');
    assert.equal((await observer.query('select billing_version from public.subscriptions where id = $1',
      [fixtures[2].subscription])).rows[0].billing_version, 0);
    return '3 Postgres concurrency regressions passed (fixture rows retained)';
  } finally {
    for (const client of clients) {
      try { await client.query('rollback'); } catch { /* A disconnected client has no open transaction. */ }
      try { await client.end(); } catch { /* Best-effort fixture connection shutdown. */ }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { input, labContainer } = fixtureArguments(process.argv.slice(2));
    console.log(await runFixtureConcurrency(input, { labContainer }));
  } catch (error) {
    // Never echo connection URLs, credentials or database/provider payloads.
    console.error('FIXTURE_CONCURRENCY_FAILED', /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : error.name);
    process.exitCode = 1;
  }
}
