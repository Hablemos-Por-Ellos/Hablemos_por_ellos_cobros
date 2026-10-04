import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { labConfig } from './local-auth-lab.mjs';

const cutoverFixture = process.argv.includes('--cutover-webhook-fixture=yes');
if (cutoverFixture && (process.argv.includes('--financial=yes') || process.argv.includes('--sandbox-config=yes'))) {
  throw new Error('CUTOVER_FIXTURE_CANNOT_ENABLE_FINANCIAL_OR_PROVIDER_KEYS');
}
const config = await labConfig();
const env = { ...process.env,HPE_LOCAL_INTEGRATION: 'true',VERCEL_ENV: 'development',
  APP_OPERATION_MODE: cutoverFixture ? 'cutover' : 'active',ADMIN_DEMO_MODE: 'false',NEXT_PUBLIC_ADMIN_DEMO_MODE: 'false',
  NEXT_PUBLIC_APP_OPERATION_MODE: cutoverFixture ? 'cutover' : 'active',NEXT_PUBLIC_VERCEL_ENV: 'development',
  FINANCIAL_OPERATIONS_ENABLED: process.argv.includes('--financial=yes') ? 'true' : 'false',
  SUPABASE_URL: config.url,NEXT_PUBLIC_SUPABASE_URL: config.url,
  SUPABASE_SERVICE_ROLE_KEY: config.serviceKey,NEXT_PUBLIC_SUPABASE_ANON_KEY: config.anonKey,
  CHECKOUT_TOKEN_PEPPER: randomBytes(48).toString('base64url'),NEXT_PUBLIC_WOMPI_ENV: 'sandbox',
  WOMPI_ENV: 'sandbox',MAINTENANCE_MODE: 'false' };
delete env.VERCEL;
// Auth tests cannot inherit any production or sandbox payment credential from dotenv.
for (const name of ['NEXT_PUBLIC_WOMPI_PUBLIC_KEY','WOMPI_PRIVATE_KEY','WOMPI_INTEGRITY_SECRET','WOMPI_EVENTS_SECRET']) {
  for (const suffix of ['', '_PROD','_SANDBOX']) env[`${name}${suffix}`] = '';
}
if (cutoverFixture) env.WOMPI_EVENTS_SECRET_SANDBOX = 'test_events_local_cutover_fixture_only';
if (process.argv.includes('--sandbox-config=yes')) {
  if (!process.argv.includes('--financial=yes')) throw new Error('EXPLICIT_SANDBOX_FINANCIAL_OPT_IN_REQUIRED');
  const { sandboxRuntime } = await import('./sandbox-runtime.mjs');
  const sandbox = await sandboxRuntime();
  env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY_SANDBOX = sandbox.publicKey;
  env.WOMPI_PRIVATE_KEY_SANDBOX = sandbox.privateKey;
  env.WOMPI_INTEGRITY_SECRET_SANDBOX = sandbox.integritySecret;
  env.WOMPI_EVENTS_SECRET_SANDBOX = sandbox.eventsSecret;
}
const child = spawn(process.execPath,[path.resolve('node_modules/next/dist/bin/next'),'dev',
  '--hostname','127.0.0.1','--port','3001'],{ env,windowsHide: true,stdio: 'inherit' });
process.on('SIGINT',() => child.kill('SIGINT'));
process.on('SIGTERM',() => child.kill('SIGTERM'));
child.on('error',() => { console.error('LOCAL_APP_LAB_START_FAILED'); process.exitCode = 1; });
child.on('close',(code) => { process.exitCode = code === 0 || code === null ? 0 : 1; });
