import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';

const client = new pg.Client({ host: '127.0.0.1',port: 54327,database: 'hpe_auth_lab',
  user: 'postgres',password: 'hpe-local-auth-fixture-only' });
try {
  await client.connect();
  const { rows: [guard] } = await client.query(`select current_database() = 'hpe_auth_lab'
    and exists(select 1 from information_schema.columns where table_schema = 'auth'
      and table_name = 'users' and column_name = 'encrypted_password') as safe`);
  if (!guard.safe) throw new Error('REAL_LOCAL_AUTH_FIXTURE_REQUIRED');
  const { rows: [baseline] } = await client.query("select to_regclass('public.donors') is not null as ready");
  if (!baseline.ready) await client.query(await fs.readFile('scripts/integration/lab/baseline.sql','utf8'));
  const sql = await fs.readFile('supabase/migrations/202609190001_payment_and_admin_hardening.sql','utf8');
  const digest = createHash('sha256').update(sql).digest('hex');
  await client.query(await fs.readFile('supabase/preflight/payment_admin_preflight.sql','utf8'));
  await client.query("select set_config('app.migration_digest',$1,false)",[digest]);
  await client.query("set transaction_timeout='300s'");
  await client.query({ text: sql,query_timeout: 300000 });
  await client.query(await fs.readFile('supabase/postflight/payment_admin_postflight.sql','utf8'));
  await client.query("notify pgrst, 'reload schema'");
  console.log(JSON.stringify({ operation: 'real_auth_lab_schema_verified',local: true,digest }));
} catch (error) {
  console.error('AUTH_LAB_SCHEMA_FAILED',/^[A-Z0-9_]{5,}$/.test(error.code ?? '') ? error.code : error.name);
  process.exitCode = 1;
} finally { await client.end(); }
