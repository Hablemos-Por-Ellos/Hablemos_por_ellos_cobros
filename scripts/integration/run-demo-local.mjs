import path from 'node:path';
import { spawn } from 'node:child_process';

const operation = process.argv[2];
if (!['dev','build'].includes(operation)) throw new Error('EXPLICIT_DEMO_COMMAND_REQUIRED');
const env = { ...process.env,APP_OPERATION_MODE: 'demo',NEXT_PUBLIC_APP_OPERATION_MODE: 'demo',
  FINANCIAL_OPERATIONS_ENABLED: 'false',ADMIN_DEMO_MODE: 'true',NEXT_PUBLIC_ADMIN_DEMO_MODE: 'true',
  VERCEL_ENV: 'development',NEXT_PUBLIC_VERCEL_ENV: 'development',HPE_LOCAL_INTEGRATION: 'false',
  MAINTENANCE_MODE: 'false',SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',SUPABASE_SERVICE_ROLE_KEY: 'local-build-fixture-only',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'local-build-fixture-only',
  CHECKOUT_TOKEN_PEPPER: 'local-build-pepper-fixture-only-at-least-32-characters',
  NEXT_PUBLIC_WOMPI_ENV: 'sandbox',WOMPI_ENV: 'sandbox' };
delete env.VERCEL;
// Preserve explicit empty values in the child environment so dotenv cannot fill them.
for (const name of ['NEXT_PUBLIC_WOMPI_PUBLIC_KEY','WOMPI_PRIVATE_KEY','WOMPI_INTEGRITY_SECRET','WOMPI_EVENTS_SECRET']) {
  for (const suffix of ['', '_PROD','_SANDBOX']) env[`${name}${suffix}`] = '';
}
const args = [path.resolve('node_modules/next/dist/bin/next'),operation];
if (operation === 'dev') args.push('--hostname','127.0.0.1','--port','3000');
const child = spawn(process.execPath,args,{ env,windowsHide: true,stdio: 'inherit' });
process.on('SIGINT',() => child.kill('SIGINT'));
process.on('SIGTERM',() => child.kill('SIGTERM'));
child.on('error',() => { console.error('LOCAL_DEMO_COMMAND_FAILED'); process.exitCode = 1; });
child.on('close',(code) => { process.exitCode = code === 0 || code === null ? 0 : 1; });
