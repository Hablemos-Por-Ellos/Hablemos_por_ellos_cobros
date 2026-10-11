// ESCRITURA LOCAL: disposable fictional PostgreSQL, no host ports or volumes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

assert.ok(process.argv.includes('--local-admin-session-mfa=yes'), 'EXPLICIT_LOCAL_OPT_IN_REQUIRED');
const container = `hpe-admin-session-mfa-042-${Date.now()}`;
const root = path.resolve('supabase');
const env = Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP']
  .filter((key) => process.env[key]).map((key) => [key,process.env[key]]));
if (process.platform === 'win32') env.DOCKER_HOST = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const docker = (args, input) => execFileSync('docker', args, {
  env, input, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  stdio: ['pipe','pipe','pipe'],
});
const sql = (input) => docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
  '-v','VERBOSITY=verbose','-U','postgres','-d','postgres'],input);
const read = (file) => fs.readFileSync(path.join(root,file),'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const patch = read('migrations/202610100001_admin_session_mfa.sql');
assert.doesNotMatch(patch,/\b(?:alter\s+table|create\s+table|insert\s+into|update\s+public\.|delete\s+from|truncate|drop\s+table)\b/i);
assert.equal((patch.match(/create or replace function/gi) ?? []).length,1);
const fingerprint = `
select jsonb_build_object(
  'relations',(select jsonb_agg(to_jsonb(c) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth')),
  'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth')),
  'constraints',(select jsonb_agg(to_jsonb(c) order by c.oid) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','auth')),
  'indexes',(select jsonb_agg(to_jsonb(i) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth')),
  'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p),
  'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth')),
  'otherFunctions',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth') and p.oid<>'public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz)'::regprocedure),
  'guardIdentity',(select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'args',proargtypes::text,'returns',prorettype,'securityDefiner',prosecdef) from pg_proc where oid='public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz)'::regprocedure)
)::text;
`;
let started = false;
try {
  const image = docker(['image','inspect','postgres:16','--format','{{.Id}}']).trim();
  docker(['run','--pull=never','--rm','-d','--name',container,'--label','codex.project=hpe-admin-042',
    '--network=none','--read-only','--user=999:999','--cap-drop=ALL','--security-opt=no-new-privileges',
    '--cpus=1','--memory=384m','--pids-limit=64',
    '--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=128m,uid=999,gid=999',
    '--tmpfs','/var/run/postgresql:rw,nosuid,nodev,size=4m,uid=999,gid=999',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=16m,uid=999,gid=999',
    '-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);
  started = true;
  for (let attempt=0;attempt<30;attempt++) {
    try { docker(['exec',container,'pg_isready','-U','postgres']); break; }
    catch (error) { if (attempt===29) throw error; await new Promise((resolve)=>setTimeout(resolve,250)); }
  }
  const inspection = JSON.parse(docker(['inspect',container]))[0];
  assert.equal(inspection.HostConfig.NetworkMode,'none');
  assert.equal(inspection.HostConfig.ReadonlyRootfs,true);
  assert.equal(inspection.Mounts.some((mount)=>mount.Type==='volume'||mount.Type==='bind'),false);
  assert.equal(Object.values(inspection.NetworkSettings.Ports ?? {}).some(Boolean),false);
  sql(read('tests/base_schema.sql'));
  const baseline = read('migrations/202609190001_payment_and_admin_hardening.sql');
  sql(`select set_config('app.migration_digest','${hash(baseline)}',false);\n${baseline}`);
  const retry = read('migrations/202610080001_billing_retry_cycles.sql');
  sql(`select set_config('app.migration_digest','${hash(retry)}',false);\nselect set_config('app.billing_retry_migration_digest','${hash(retry)}',false);\n${retry}`);
  sql(`insert into auth.users(id,email) values ('a4200000-0000-0000-0000-000000000001','admin042@example.test');
insert into public.admin_users(user_id,role,active,sessions_valid_after) values ('a4200000-0000-0000-0000-000000000001','admin',true,'1970-01-01T00:00:00Z');
insert into public.donors(id,email,first_name,last_name) values ('a4200000-0000-0000-0000-000000000002','donor042@example.test','Fictional','Fixture');
insert into public.subscriptions(id,donor_id,amount,currency,frequency,status,reference,wompi_payment_source_id,preferred_payment_day,next_payment_date)
values ('a4200000-0000-0000-0000-000000000003','a4200000-0000-0000-0000-000000000002',25000,'COP','monthly','active','HPE-042-FICTIONAL','fictional-source-042',16,clock_timestamp()+interval '60 days');`);
  const tables = sql("select quote_ident(n.nspname)||'.'||quote_ident(c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','auth') order by n.nspname,c.relname;").trim().split('\n');
  const rowsQuery = tables.map((table)=>`select '${table}'||':'||coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text from ${table} t;`).join('\n');
  const beforeSchema = sql(fingerprint);
  const beforeRows = sql(rowsQuery);
  assert.throws(()=>sql("select public.assert_admin_mutation_context('a4200000-0000-0000-0000-000000000001','aal2',now()-interval '1 hour',null);"),
    (error)=>String(error.stderr).includes('42501'));
  sql(patch);
  assert.equal(sql(fingerprint),beforeSchema,'ALL_TABLES_INDEXES_RLS_ACL_OWNERS_AND_OTHER_FUNCTIONS_PRESERVED');
  assert.equal(sql(rowsQuery),beforeRows,'ALL_FICTIONAL_IDS_HISTORY_AND_CONTENT_PRESERVED');
  const newDefinition = sql("select pg_get_functiondef('public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz)'::regprocedure);");
  assert.ok(newDefinition.includes('admin-session-mfa-v0.4.2'));
  sql(read('tests/admin_session_mfa_regression.sql'));
  assert.equal(sql(rowsQuery),beforeRows,'ALL_REGRESSION_WRITES_ROLLED_BACK');
  for (const role of ['anon','authenticated']) assert.throws(()=>sql(`set role ${role}; select public.assert_admin_mutation_context('a4200000-0000-0000-0000-000000000001','aal2',now(),null);`),
    (error)=>String(error.stderr).includes('42501'));
  sql(patch);
  assert.equal(sql(fingerprint),beforeSchema,'REAPPLY_PRESERVES_SCHEMA_AND_PERMISSIONS');
  assert.equal(sql(rowsQuery),beforeRows,'REAPPLY_PRESERVES_CONTENT');
  assert.equal(sql("select pg_get_functiondef('public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz)'::regprocedure);"),newDefinition,'EQUIVALENT_FUNCTION_REAPPLY');
  console.log(JSON.stringify({version:'0.4.2',localOnly:true,network:'none',persistentVolumes:0,
    patchDigest:hash(patch),tablesCompared:tables.length,tableDefinitions:'identical',rows:'identical',
    ownerAndPermissions:'identical',aal1:'rejected',revocation:'rejected',anonymousExecution:'rejected',
    sessionOnlyAmountAndSchedule:'passed',auditWithoutFabricatedTotp:'passed',replay:'passed',reapply:'passed',
    sent:0,charged:0,regressionWrites:'rolled_back'}));
} finally {
  if (started) docker(['stop','--time=5',container]);
}
