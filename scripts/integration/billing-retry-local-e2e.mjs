// ESCRITURA LOCAL: a fresh fictional database in a network-disabled container.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const container = 'hpe-retry-v040-local';
const database = `hpe_retry_lab_${Date.now()}`;
assert.ok(process.argv.includes('--local-retry-lab=yes'), 'EXPLICIT_LOCAL_OPT_IN_REQUIRED');
const inspection = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8', windowsHide: true }))[0];
assert.equal(inspection.Name, `/${container}`);
assert.equal(inspection.HostConfig.NetworkMode, 'none', 'LAB_MUST_HAVE_NO_NETWORK');
assert.equal(inspection.Config.Image, 'postgres:16');
assert.equal(Object.keys(inspection.NetworkSettings.Ports ?? {}).filter((port) => inspection.NetworkSettings.Ports[port]).length, 0);
assert.ok(/^hpe_retry_lab_\d+$/.test(database));
const source = path.resolve('supabase');
execFileSync('docker', ['cp', source + path.sep + '.', `${container}:/tmp/hpe-retry-source`], { windowsHide: true });
execFileSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `create database ${database}`], { windowsHide: true });

async function sql(input, label, target = database) {
  assert.ok(/^hpe_retry_lab_\d+(?:_before|_after)?$/.test(target), 'FICTIONAL_TARGET_ONLY');
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-A', '-t', '-U', 'postgres', '-d', target, '-v', 'ON_ERROR_STOP=1'], { windowsHide: true });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const timer = setTimeout(() => child.kill(), 300_000);
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${label}: ${output.slice(-5000)}`)); });
  });
  child.stdin.end(input);
  return result;
}

const digest = async (file) => createHash('sha256').update(await fs.readFile(path.join(source, file))).digest('hex');
const oldFile = 'migrations/202609190001_payment_and_admin_hardening.sql';
const newFile = 'migrations/202610080001_billing_retry_cycles.sql';
for (const file of [oldFile, newFile]) {
  const copiedHash = execFileSync('docker', ['exec', container, 'sha256sum', '/tmp/hpe-retry-source/' + file], { encoding: 'utf8', windowsHide: true }).split(/\s+/)[0];
  assert.equal(copiedHash, await digest(file), 'EXACT_COPIED_SQL_DIGEST_REQUIRED');
}
const include = (file) => String.fromCharCode(92) + 'i /tmp/hpe-retry-source/' + file;
// Roles are cluster-wide; repeated runs create fresh databases, not fresh clusters.
await sql(`do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;`, 'FICTIONAL_ROLES');
let baseSchema = await fs.readFile(path.join(source, 'tests/base_schema.sql'), 'utf8');
for (const statement of ['create role anon nologin;', 'create role authenticated nologin;', 'create role service_role nologin bypassrls;']) {
  assert.ok(baseSchema.includes(statement), 'KNOWN_BASE_FIXTURE_REQUIRED');
  baseSchema = baseSchema.replace(statement, '');
}
await sql([baseSchema, `select set_config('app.migration_digest','${await digest(oldFile)}',false);`, include(oldFile), ''].join('\n'), 'BASELINE');
const marker = await digest(newFile);
const setDigest = `select set_config('app.migration_digest','${marker}',false);
select set_config('app.billing_retry_migration_digest','${marker}',false);`;
await sql([setDigest, include('preflight/billing_retry_preflight.sql'), include(newFile), include('postflight/billing_retry_postflight.sql'), ''].join('\n'), 'MIGRATION');
const regression = path.join(source, 'tests/billing_retry_regression.sql');
await fs.access(regression);
const output = await sql([setDigest, include('tests/billing_retry_regression.sql'), ''].join('\n'), 'REGRESSION');
await sql([setDigest, include(newFile), include('postflight/billing_retry_postflight.sql'), ''].join('\n'), 'EQUIVALENT_REAPPLY');

const originalSnapshot = ['donors', 'subscriptions', 'payments', 'webhook_events', 'audit_logs'].map((table) =>
  `select '${table}' || ':' || count(*) || ':' || md5(coalesce(string_agg(jsonb_strip_nulls(to_jsonb(t))::text,E'\\n' order by id),'')) from public.${table} t;`).join('\n');
const newSql = await fs.readFile(path.join(source, newFile), 'utf8');
assert.ok(/\bcommit;\s*$/i.test(newSql), 'SINGLE_FINAL_COMMIT_REQUIRED');
for (const position of ['before', 'after']) {
  const target = `${database}_${position}`;
  execFileSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `create database ${target}`], { windowsHide: true });
  await sql([baseSchema, `select set_config('app.migration_digest','${await digest(oldFile)}',false);`, include(oldFile), ''].join('\n'), 'RECOVERY_BASELINE', target);
  const before = await sql(originalSnapshot, 'READ_ONLY_ORIGINAL_HASHES', target);
  const injected = position === 'before'
    ? newSql.replace(/\bcommit;\s*$/i, 'select pg_terminate_backend(pg_backend_pid());\ncommit;')
    : newSql + '\nselect pg_terminate_backend(pg_backend_pid());\n';
  let disconnected = false;
  try { await sql(setDigest + '\n' + injected, 'INTENTIONAL_DISCONNECT', target); }
  catch { disconnected = true; }
  assert.equal(disconnected, true, 'DISCONNECT_MUST_BE_OBSERVED_NOT_ASSUMED');
  // Observe from a NEW read-only connection. Never automatically repeat a lost-response migration.
  const observation = await sql(`begin read only;
select count(*) from public.payment_admin_migrations where name='billing-retry-v0.4.0' and digest='${marker}';
${originalSnapshot}
commit;`, 'FRESH_RECOVERY_OBSERVER', target);
  assert.equal(observation.split('\n')[0], position === 'before' ? '0' : '1', 'EXACT_COMMIT_STATE_VERIFIED');
  assert.equal(observation.split('\n').slice(1).join('\n'), before, 'ALL_ORIGINAL_FICTIONAL_CONTENT_PRESERVED');
}
console.log(JSON.stringify({ version: '0.4.0', localOnly: true, network: 'none', container, database, migrationDigest: marker,
  regression: 'passed', equivalentReapply: 'passed', beforeCommitDisconnect: 'rolled_back', afterCommitDisconnect: 'committed_observed',
  originalContent: 'identical', output: output.trim().slice(-1000) }));
