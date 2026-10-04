// ESCRITURA LOCAL: create three new offline fictitious databases, never reset existing ones.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const names = ['hpe-admin-lab-034','hpe-admin-lab-034-before','hpe-admin-lab-034-after'];
function command(args) {
  return execFileSync('docker',args,{ encoding: 'utf8',windowsHide: true,stdio: ['ignore','pipe','pipe'] });
}
async function sql(container,text) {
  await new Promise((resolve,reject) => {
    const child = spawn('docker',['exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','hpe_lab'],
      { windowsHide: true,stdio: ['pipe','ignore','ignore'] });
    child.stdin.on('error',() => {});
    child.stdin.end(text);
    child.on('error',() => reject(new Error('FIXTURE_SQL_LAUNCH_FAILED')));
    child.on('close',(code) => code === 0 ? resolve() : reject(new Error('FIXTURE_SQL_FAILED')));
  });
}
async function copyFixture(source,target) {
  await new Promise((resolve,reject) => {
    const dump = spawn('docker',['exec',source,'pg_dump','-Fc','-U','postgres','-d','hpe_lab'],
      { windowsHide: true,stdio: ['ignore','pipe','ignore'] });
    const restore = spawn('docker',['exec','-i',target,'pg_restore','--exit-on-error','-U','postgres','-d','hpe_lab'],
      { windowsHide: true,stdio: ['pipe','ignore','ignore'] });
    let completed = 0;
    let failed = false;
    const finish = (code) => {
      failed ||= code !== 0;
      if (++completed === 2) failed ? reject(new Error('FIXTURE_CLONE_FAILED')) : resolve();
    };
    dump.stdout.pipe(restore.stdin);
    restore.stdin.on('error',() => { failed = true; });
    dump.on('error',() => { dump.kill(); restore.kill(); reject(new Error('FIXTURE_DUMP_LAUNCH_FAILED')); });
    restore.on('error',() => { dump.kill(); restore.kill(); reject(new Error('FIXTURE_RESTORE_LAUNCH_FAILED')); });
    dump.on('close',finish);
    restore.on('close',finish);
  });
}
try {
  if (!process.argv.includes('--prepare-offline-fixtures=yes')) throw new Error('EXPLICIT_OFFLINE_PREPARATION_REQUIRED');
  for (const name of names) {
    try { command(['inspect',name]); throw new Error('FIXTURE_ALREADY_EXISTS_DO_NOT_RESET'); }
    catch (error) { if (error.message === 'FIXTURE_ALREADY_EXISTS_DO_NOT_RESET') throw error; }
  }
  const image = command(['image','inspect','postgres:17-alpine','--format','{{.Id}}']).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('EXISTING_POSTGRES_FIXTURE_IMAGE_REQUIRED');
  for (const [index,name] of names.entries()) {
    command(['run','-d','--name',name,'--network','none','--memory','256m','--cpus','0.5',
      '--label','codex.project=hpe-admin-030',
      ...(index ? ['--label',`codex.recovery.source=${names[0]}`,'--label','codex.recovery.disposable=true'] : []),
      '-e','POSTGRES_DB=hpe_lab','-e','POSTGRES_PASSWORD=hpe-local-fixture-only',image]);
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
      try { command(['exec',name,'pg_isready','-U','postgres','-d','hpe_lab']); ready = true; }
      catch { await new Promise((resolve) => setTimeout(resolve,1000)); }
    }
    if (!ready) throw new Error('FIXTURE_START_TIMEOUT');
  }
  await sql(names[0],await fs.readFile('supabase/tests/base_schema.sql','utf8'));
  for (const name of names.slice(1)) {
    await sql(name,"create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
    await copyFixture(names[0],name);
  }
  console.log(JSON.stringify({ operation: 'offline_recovery_clones_prepared',containers: names,fictitious: true,production: false }));
} catch (error) {
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'OFFLINE_FIXTURE_PREPARATION_FAILED');
  process.exitCode = 1;
}
