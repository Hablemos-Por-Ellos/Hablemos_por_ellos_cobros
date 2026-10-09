// ESCRITURA LOCAL: two real PostgreSQL sessions, fictional data only, no network.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const container = 'hpe-retry-v040-local';
const database = process.argv.find((arg) => arg.startsWith('--database='))?.slice(11);
assert.ok(process.argv.includes('--local-retry-lab=yes') && /^hpe_retry_lab_\d+$/.test(database), 'EXPLICIT_FICTIONAL_DB_REQUIRED');
const inspected = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8', windowsHide: true }))[0];
assert.equal(inspected.HostConfig.NetworkMode, 'none');
assert.equal(inspected.Config.Image, 'postgres:16');
let checks = 0;
const check = (value, name) => { assert.ok(value, name); checks++; };
async function query(input) {
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-A', '-t', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], { windowsHide: true });
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const timer = setTimeout(() => child.kill(), 30_000);
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(errors.slice(-2000))); });
  });
  child.stdin.end(input);
  return result;
}
check(await query("select public.billing_retry_schema_ready() and exists(select 1 from public.donors where email='legacy@example.test');") === 't', 'Fixture identity and schema');
const actor = randomUUID();
await query(`insert into auth.users(id,email) values('${actor}','concurrency-admin@example.test');
insert into public.admin_users(user_id,role,active) values('${actor}','admin',true);`);
async function fixture() {
  const donor = randomUUID(); const subscription = randomUUID(); const source = 'fixture-' + subscription;
  await query(`insert into public.donors(id,email,first_name,last_name) values('${donor}','${donor}@example.test','Concurrent','Fictional');
insert into public.subscriptions(id,donor_id,amount,currency,frequency,status,payment_method_type,wompi_payment_source_id,
reference,preferred_payment_day,next_payment_date,billing_authorization)
values('${subscription}','${donor}',30000,'COP','monthly','active','card','${source}','fixture-${subscription}',16,clock_timestamp()-interval '1 hour',
jsonb_build_object('version','0.4.0','kind','checkout','mandateId',gen_random_uuid(),'environment','sandbox',
'authorizedAt',clock_timestamp()-interval '1 day','recurring',true,'retryAllowed',true,'sourceVerified',true,
'sourceVerifiedAt',clock_timestamp()-interval '1 day','sourceId','${source}','method','CARD'));`);
  return { subscription, source };
}
const authorize = (attempt, source) => `set role service_role; select public.billing_v2_authorize_send('${attempt}',
jsonb_build_object('id','${source}','type','CARD','status','AVAILABLE','environment','sandbox',
'verification_source','provider_get','verified_at',clock_timestamp()));`;
const cancel = (subscription, requestId) => `set role service_role; select public.billing_v2_admin_update_subscription(
'${subscription}',0,'cancel','Fictional concurrent cancellation','${requestId}','${actor}',
null,null,null,false,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());`;

const first = await fixture();
const reserves = await Promise.all(Array.from({ length: 8 }, () => query(`set role service_role; select public.billing_v2_reserve_original('${first.subscription}',0);`).then(JSON.parse)));
const attempt = reserves[0].attempt.id;
check(reserves.every((row) => row.attempt.id === attempt), 'Concurrent reservation shares one original');
const winners = await Promise.all(Array.from({ length: 8 }, () => query(authorize(attempt, first.source)).then(JSON.parse)));
check(winners.filter((row) => row.canDispatch === true).length === 1, 'Exactly one durable send winner');
check(await query(`select count(*)=1 from public.payment_attempts where subscription_id='${first.subscription}';`) === 't', 'One attempt persisted');

for (let index = 0; index < 6; index++) {
  const row = await fixture();
  const reservation = JSON.parse(await query(`set role service_role; select public.billing_v2_reserve_original('${row.subscription}',0);`));
  const aid = reservation.attempt.id;
  const [send, cancellation] = await Promise.all([query(authorize(aid, row.source)).then(JSON.parse), query(cancel(row.subscription, randomUUID())).then(JSON.parse)]);
  check(send.canDispatch === cancellation.chargeMayComplete, 'Cancellation warning matches the actual barrier winner');
  const persisted = JSON.parse(await query(`select jsonb_build_object('status',s.status,'date',s.next_payment_date,'state',a.state,
'authorized',a.send_authorized_at is not null) from public.subscriptions s join public.payment_attempts a on a.subscription_id=s.id where a.id='${aid}';`));
  check(persisted.status === 'cancelled' && persisted.date === null, 'No future schedule after cancellation');
  check(persisted.authorized ? persisted.state === 'dispatching' : persisted.state === 'cancelled', 'No false release of a possibly sent charge');
}
const replayRow = await fixture(); const requestId = randomUUID();
const change = `set role service_role; select public.billing_v2_admin_update_subscription('${replayRow.subscription}',0,'amount',
'Fictional concurrent amount','${requestId}','${actor}',35000,null,null,false,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());`;
const replay = await Promise.all([query(change).then(JSON.parse), query(change).then(JSON.parse)]);
check(JSON.stringify(replay[0]) === JSON.stringify(replay[1]), 'Concurrent idempotent requests share their committed result');
check(await query(`select count(*)=1 from public.admin_audit_logs where request_id='${requestId}';`) === 't', 'One atomic audit row');
check(await query(`select billing_version=1 and amount=35000 from public.subscriptions where id='${replayRow.subscription}';`) === 't', 'Version advances only once');
await assert.rejects(query(change.replace('35000', '36000')), /ADMIN_REQUEST_ID_CONFLICT/);
checks++;
console.log(JSON.stringify({ version: '0.4.0', localOnly: true, network: 'none', database, checks, concurrentClaims: 8, cancellationRaces: 6 }));
