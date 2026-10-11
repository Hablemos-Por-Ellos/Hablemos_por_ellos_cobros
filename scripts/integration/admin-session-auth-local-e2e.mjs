// ESCRITURA LOCAL: new fictional GoTrue/PostgREST lab; never reuse existing DBs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { parse, stringify } from 'yaml';

assert.ok(process.argv.includes('--local-session-auth=yes'), 'EXPLICIT_LOCAL_AUTH_OPT_IN_REQUIRED');
const option = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const playwright = option('playwright-module');
const cachedFont = option('cached-font');
const browsersPath = option('browsers-path');
const browserExecutable = option('browser-executable');
assert.ok(playwright && cachedFont && path.isAbsolute(playwright) && path.isAbsolute(cachedFont), 'EXISTING_LOCAL_RUNTIMES_REQUIRED');
await fs.access(playwright); await fs.access(cachedFont);
assert.ok(browsersPath && path.isAbsolute(browsersPath), 'EXISTING_LOCAL_BROWSERS_REQUIRED');
await fs.access(browsersPath);
assert.ok(browserExecutable && path.isAbsolute(browserExecutable), 'EXISTING_BROWSER_EXECUTABLE_REQUIRED');
await fs.access(browserExecutable);
const root = fileURLToPath(new URL('../../', import.meta.url));
const nonce = Date.now();
const project = `hpe-session-auth-042-${nonce}`;
const parent = process.platform === 'win32' ? 'D:/CodexScratch/HablemosPorEllos' : path.join(os.tmpdir(), 'hpe-auth');
const scratch = path.join(parent, project);
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'SystemDrive'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
const host = process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock';
const docker = (args) => execFileSync('docker', ['--host', host, ...args], {
  env, encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
});
const digest = (value) => createHash('sha256').update(value).digest('hex');
const freePort = (port) => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', () => reject(new Error('LOCAL_AUTH_PORT_ALREADY_USED')));
  server.listen(port, '127.0.0.1', () => server.close(resolve));
});
for (const port of [3001, 54321, 54327, 54328, 54329]) await freePort(port);
await fs.mkdir(parent, { recursive: true });
await fs.mkdir(scratch);
for (const name of ['src', 'scripts', 'supabase', 'public']) await fs.cp(path.join(root, name), path.join(scratch, name), {
  recursive: true, filter: (entry) => !path.basename(entry).toLowerCase().startsWith('.env'),
});
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'next-env.d.ts', 'next.config.js',
  'postcss.config.js', 'tailwind.config.ts', 'middleware.ts', '.eslintrc.json']) {
  await fs.copyFile(path.join(root, name), path.join(scratch, name));
}
await fs.symlink(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
assert.ok(!(await fs.readdir(scratch)).some((name) => name.startsWith('.env')), 'PRODUCTION_DOTENV_FORBIDDEN');
const home = path.join(scratch, 'runtime'); await fs.mkdir(home);
const font = path.join(home, 'font.woff2'); await fs.copyFile(cachedFont, font);
const fontPath = font.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '');
const fontCss = [400, 500, 600, 700].map((weight) => `@font-face{font-family:'Poppins';font-style:normal;font-weight:${weight};font-display:swap;src:url(${fontPath}) format('woff2');}`).join('\n');
await fs.writeFile(path.join(home, 'font-response.cjs'), `module.exports=new Proxy({},{get:()=>${JSON.stringify(fontCss)}});`);
process.chdir(scratch);
const { labConfig, launchGateway } = await import(pathToFileURL(path.join(scratch, 'scripts/integration/local-auth-lab.mjs')));
const config = await labConfig();
const compose = parse(await fs.readFile(path.join(scratch, 'scripts/integration/lab/compose.yml'), 'utf8'));
compose.name = project; delete compose.volumes;
compose.networks = { default: { internal: true, labels: { 'codex.project': project } } };
for (const [name, service] of Object.entries(compose.services)) {
  service.container_name = `${project}-${name}`;
  delete service.ports;
  service.labels = { 'codex.project': project };
  service.image = docker(['image', 'inspect', service.image, '--format', '{{.Id}}']).trim();
  service.pull_policy = 'never'; service.read_only = true;
  service.cap_drop = ['ALL']; service.security_opt = ['no-new-privileges:true'];
  service.cpus = 1; service.mem_limit = '384m'; service.pids_limit = 96;
  service.user = name === 'db' ? '70:70' : '1000:1000';
  service.tmpfs = ['/tmp:rw,nosuid,nodev,size=16m'];
}
compose.services.db.volumes = ['./roles.sql:/docker-entrypoint-initdb.d/10-roles.sql:ro'];
compose.services.db.tmpfs.push('/var/lib/postgresql/data:rw,nosuid,nodev,size=192m,uid=70,gid=70',
  '/var/run/postgresql:rw,nosuid,nodev,size=4m,uid=70,gid=70');
const composePath = path.join(scratch, 'scripts/integration/lab/compose.yml');
await fs.writeFile(composePath, stringify(compose));
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
  HPE_LAB_JWT_SECRET: config.jwtSecret, HPE_PLAYWRIGHT_MODULE: playwright,
  PLAYWRIGHT_BROWSERS_PATH: browsersPath,
  HPE_PLAYWRIGHT_EXECUTABLE: browserExecutable,
  NODE_OPTIONS: `--max-old-space-size=2048 --require "${path.join(scratch, 'scripts/integration/admin-session-network-guard.cjs').replaceAll('\\', '/')}"`,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, 'font-response.cjs'), NEXT_TELEMETRY_DISABLED: '1',
});
const composeArgs = ['--host', host, 'compose', '--project-name', project, '-f', composePath];
const terminateOwnedProcess = (child) => {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    catch { if (child.exitCode === null) child.kill(); }
  } else child.kill('SIGTERM');
};
const run = (executable, args, childEnv = env, timeout = 180_000) => new Promise((resolve, reject) => {
  let stdout = ''; let stderr = '';
  const child = spawn(executable, args, { cwd: scratch, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = setTimeout(() => { terminateOwnedProcess(child); reject(new Error('LOCAL_AUTH_STAGE_TIMEOUT')); }, timeout);
  child.stdout.on('data', (part) => { stdout += part; }); child.stderr.on('data', (part) => { stderr += part; });
  child.once('error', () => { clearTimeout(deadline); reject(new Error('LOCAL_AUTH_CHILD_FAILED')); });
  child.once('exit', (code) => {
    clearTimeout(deadline);
    if (code !== 0) {
      const summary = (stdout + '\n' + stderr).split('\n').map((line) => {
        try { const value = JSON.parse(line); return value.passed === false ? value : null; } catch { return null; }
      }).find(Boolean);
      if (summary) console.error(JSON.stringify(summary));
      reject(new Error('LOCAL_AUTH_STAGE_FAILED'));
    } else resolve(stdout);
  });
});
const wait = async (check, name) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if (await check()) return; } catch { /* The fresh service may still be initializing. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(name);
};
let app; let gateway; let composeStarted = false; let client; let stage = 'containers';
const relays = [];
const launchRelay = async (port, destination, targetPort) => {
  const connections = new Set();
  const server = net.createServer((socket) => {
    const child = spawn('docker', ['--host', host, 'exec', '-i', `${project}-db`, 'nc', destination, String(targetPort)],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    connections.add(socket);
    child.stderr.resume();
    child.stdin.on('error', () => socket.destroy());
    child.once('error', () => socket.destroy());
    child.once('exit', () => socket.end());
    socket.on('error', () => {});
    socket.once('close', () => { connections.delete(socket); child.stdin.end(); terminateOwnedProcess(child); });
    socket.setTimeout(90_000, () => socket.destroy());
    socket.pipe(child.stdin); child.stdout.pipe(socket);
  });
  server.maxConnections = 24;
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
  });
  relays.push({ server, connections });
};
const appLog = await fs.open(path.join(home, 'app.log'), 'w');
const rowFingerprint = async () => {
  const { rows: tables } = await client.query("select schemaname,tablename from pg_tables where schemaname in ('public','auth') order by 1,2");
  const fingerprints = [];
  for (const { schemaname, tablename } of tables) {
    const quote = (value) => `"${value.replaceAll('"', '""')}"`;
    const result = await client.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text as content from ${quote(schemaname)}.${quote(tablename)} t`);
    fingerprints.push([`${schemaname}.${tablename}`, digest(result.rows[0].content)]);
  }
  return fingerprints;
};
try {
  composeStarted = true;
  await run('docker', [...composeArgs, 'up', '-d', '--pull', 'never']);
  for (const name of ['db', 'auth', 'rest']) {
    const inspected = JSON.parse(docker(['inspect', `${project}-${name}`]))[0];
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspected.Config.Labels['codex.project'], project);
    assert.ok(inspected.Mounts.every((mount) => mount.Type === 'tmpfs' || name === 'db' && mount.Type === 'bind'
      && mount.Source.replaceAll('\\', '/').endsWith(`/${project}/scripts/integration/lab/roles.sql`) && !mount.RW));
    assert.ok(Object.values(inspected.NetworkSettings.Ports ?? {}).every((bindings) => !bindings || bindings.length === 0));
  }
  const network = JSON.parse(docker(['network', 'inspect', `${project}_default`]))[0];
  assert.equal(network.Internal, true);
  await launchRelay(54327, '127.0.0.1', 5432);
  await launchRelay(54328, 'auth', 9999);
  await launchRelay(54329, 'rest', 3000);
  await wait(async () => (await fetch('http://127.0.0.1:54328/health')).ok, 'LOCAL_AUTH_HEALTH_FAILED');
  client = new pg.Client({ host: '127.0.0.1', port: 54327, database: 'hpe_auth_lab',
    user: 'postgres', password: 'hpe-local-auth-fixture-only' });
  await client.connect();
  stage = 'schema';
  const { rows: [guard] } = await client.query("select current_database()='hpe_auth_lab' and to_regclass('public.donors') is null as fresh");
  assert.equal(guard.fresh, true, 'ONLY_NEW_FICTIONAL_DATABASE_ALLOWED');
  await client.query(await fs.readFile(path.join(scratch, 'scripts/integration/lab/baseline.sql'), 'utf8'));
  for (const name of ['202609190001_payment_and_admin_hardening.sql', '202610080001_billing_retry_cycles.sql']) {
    const sql = await fs.readFile(path.join(scratch, 'supabase/migrations', name), 'utf8');
    await client.query("select set_config('app.migration_digest',$1,false),set_config('app.billing_retry_migration_digest',$1,false)", [digest(sql)]);
    await client.query(sql);
  }
  const before = await rowFingerprint();
  const patch = await fs.readFile(path.join(scratch, 'supabase/migrations/202610100001_admin_session_mfa.sql'), 'utf8');
  await client.query(patch);
  assert.deepEqual(await rowFingerprint(), before, 'FUNCTION_PATCH_PRESERVES_ALL_FICTIONAL_ROWS');
  await client.query("notify pgrst, 'reload schema'");
  gateway = launchGateway(config);
  stage = 'app';
  const appEnv = { ...env, NODE_ENV: 'development', HPE_LOCAL_INTEGRATION: 'true', VERCEL_ENV: 'development',
    APP_OPERATION_MODE: 'active', NEXT_PUBLIC_APP_OPERATION_MODE: 'active', ADMIN_DEMO_MODE: 'false',
    NEXT_PUBLIC_ADMIN_DEMO_MODE: 'false', FINANCIAL_OPERATIONS_ENABLED: 'true', MAINTENANCE_MODE: 'false',
    SUPABASE_URL: config.url, NEXT_PUBLIC_SUPABASE_URL: config.url,
    SUPABASE_SERVICE_ROLE_KEY: config.serviceKey, NEXT_PUBLIC_SUPABASE_ANON_KEY: config.anonKey,
    CHECKOUT_TOKEN_PEPPER: 'fixture-auth-042-no-payment-authorization', NEXT_PUBLIC_WOMPI_ENV: 'sandbox', WOMPI_ENV: 'sandbox' };
  app = spawn(process.execPath, [path.join(scratch, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3001'],
    { cwd: scratch, env: appEnv, windowsHide: true, stdio: ['ignore', appLog.fd, appLog.fd] });
  await wait(async () => (await fetch('http://127.0.0.1:3001/admin/login')).ok, 'LOCAL_AUTH_APP_NOT_READY');
  stage = 'auth-integration';
  const authOutput = await run(process.execPath, [path.join(scratch, 'scripts/integration/auth-real-e2e.mjs')]);
  const authResult = authOutput.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((value) => value.operation === 'real_auth_next_rls_e2e');
  assert.equal(authResult?.passed, true);
  console.log(JSON.stringify(authResult));
  stage = 'browser-integration';
  const browserOutput = await run(process.execPath, [path.join(scratch, 'scripts/integration/admin-ui-local-e2e.mjs'), '--local-ui=yes', '--mutations=yes', '--browser=chromium']);
  const browserResult = browserOutput.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((value) => value.operation === 'admin_ui_local_e2e');
  assert.equal(browserResult?.passed, true);
  console.log(JSON.stringify(browserResult));
  const { rows: [counts] } = await client.query(`select (select count(*)::int from public.payments) as payments,
    (select count(*)::int from public.payment_attempts) as attempts,(select count(*)::int from public.billing_cycles) as cycles,
    (select count(*)::int from public.admin_audit_logs where actor_aal='aal2' and totp_verified_at is null) as "loginMfaAudits"`);
  assert.equal(counts.payments, 0); assert.equal(counts.attempts, 0); assert.equal(counts.cycles, 0);
  assert.equal(counts.loginMfaAudits, 6);
  const report = { version: '0.4.2', localOnly: true, realAuth: true, realBrowser: true,
    loginOnlyMfa: true, patchTablesCompared: before.length, patchRowsIdentical: true,
    authChecks: authResult.checks, browserChecks: browserResult.checks,
    loginMfaChallenges: browserResult.loginMfaChallenges, actionMfaChallenges: browserResult.actionMfaChallenges,
    mutationRequestsWithTotp: browserResult.mutationRequestsWithTotp, ...counts, sent: 0, charged: 0,
    network: 'internal', dockerPublishedPorts: 0, hostRelays: 'loopback_only',
    credentials: 'new_fictional_only', persistentVolumes: 0, patchDigest: digest(patch) };
  await fs.writeFile(path.join(scratch, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (stage === 'containers' && composeStarted) {
    for (const name of ['db', 'auth', 'rest']) {
      try {
        const state = JSON.parse(docker(['inspect', `${project}-${name}`]))[0].State;
        const logs = docker(['logs', '--tail', '8', `${project}-${name}`]);
        const messages = logs.split('\n').flatMap((line) => {
          try {
            const value = JSON.parse(line);
            const message = String(value.msg ?? value.message ?? '').replaceAll(config.jwtSecret, '[fixture]')
              .replaceAll(config.serviceKey, '[fixture]').replaceAll(config.anonKey, '[fixture]')
              .replace(/(?:postgres(?:ql)?|https?):\/\/\S+/g, '[local-destination]');
            return message ? [message.slice(0, 200)] : [];
          } catch { return []; }
        });
        console.error(JSON.stringify({ operation: 'fictional_lab_diagnostic', service: name,
          status: state.Status, exitCode: state.ExitCode, messages }));
      } catch { /* Failed containers may already be absent. */ }
    }
  }
  console.error(JSON.stringify({ operation: 'admin_session_auth_local_e2e', passed: false, stage,
    assertion: /^[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : undefined, failure: error.name }));
  process.exitCode = 1;
} finally {
  terminateOwnedProcess(app);
  try {
    await client?.end();
    if (gateway) {
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
    }
    for (const { server, connections } of relays) {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
    await appLog.close();
  } finally {
    try { if (composeStarted) await run('docker', [...composeArgs, 'down'], env, 120_000); }
    finally {
      await fs.unlink(path.join(scratch, '.env.integration-lab.local')).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
