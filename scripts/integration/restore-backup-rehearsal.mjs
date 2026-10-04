// ESCRITURA LOCAL: new empty database only, private encrypted archive, no cloud writes.
import { execFileSync } from 'node:child_process';
import { parseArguments, safeOpsFailure } from '../ops/private-config.mjs';
import { assertLocalLab } from '../ops/local-docker-stream.mjs';
import { restoreBackup } from '../ops/restore-backup.mjs';

try {
  const args = parseArguments();
  const container = args.container;
  const database = args.database;
  if (!/^hpe_restore_[a-z0-9]+$/.test(database ?? '') || !args.backup) throw new Error('EXPLICIT_REHEARSAL_ARGUMENTS_REQUIRED');
  assertLocalLab(container);
  const inspect = (type, value) => JSON.parse(execFileSync('docker',[type,'inspect',value],{
    encoding: 'utf8',windowsHide: true,stdio: ['ignore','pipe','pipe'],
  }))[0];
  const info = JSON.parse(execFileSync('docker',['inspect',container],{
    encoding: 'utf8',windowsHide: true,stdio: ['ignore','pipe','pipe'],
  }))[0];
  const networks = Object.keys(info.NetworkSettings.Networks ?? {});
  if (!networks.length || networks.some((name) => inspect('network',name).Internal !== true)
    || Object.values(info.NetworkSettings.Ports ?? {}).some(Boolean)) throw new Error('OFFLINE_UNPUBLISHED_LAB_REQUIRED');
  const env = Object.fromEntries(info.Config.Env.map((value) => {
    const at = value.indexOf('='); return [value.slice(0,at),value.slice(at + 1)];
  }));
  if (!env.POSTGRES_PASSWORD || !env.POSTGRES_USER) throw new Error('LOCAL_CONTAINER_CREDENTIAL_REQUIRED');
  const run = (sql) => execFileSync('docker',['exec','-e','PGPASSWORD',container,'psql','-h','127.0.0.1',
    '-U',env.POSTGRES_USER,'-d','postgres','-v','ON_ERROR_STOP=1','-Atc',sql],{
    encoding: 'utf8',windowsHide: true,env: { ...process.env,PGPASSWORD: env.POSTGRES_PASSWORD },
    stdio: ['ignore','pipe','pipe'],
  });
  if (run(`select count(*) from pg_database where datname='${database}'`).trim() !== '0') throw new Error('NEW_DATABASE_REQUIRED');
  run(`create database ${database} owner hpe_lab_operator`);
  const url = new URL(`postgresql://hpe_lab_operator@127.0.0.1:5432/${database}`);
  url.password = env.POSTGRES_PASSWORD;
  await restoreBackup({ backup: args.backup,container,'lab-url': url.toString(),
    'lab-postgres-password': env.POSTGRES_PASSWORD,env: args.env });
} catch (error) {
  console.error(JSON.stringify(safeOpsFailure('offline_restore_rehearsal',error)));
  process.exitCode = 1;
}
