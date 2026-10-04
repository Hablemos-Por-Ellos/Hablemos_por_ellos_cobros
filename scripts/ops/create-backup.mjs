import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { encryptBackupStream, fileSha256 } from "./backup-crypto.mjs";
import { databaseManifest } from "./database-manifest.mjs";
import { assertExpectedProductionProject, connectionFingerprint, parseArguments, postgresClient, privateConfig, safeOpsFailure } from "./private-config.mjs";

export function isInsideRepository(repository, output, pathApi = path) {
  const relative = pathApi.relative(repository, output);
  return relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

export function assertExternalBackupOutput(output, repository = process.cwd()) {
  const resolved = path.resolve(output);
  if (isInsideRepository(path.resolve(repository), resolved)) throw new Error("BACKUP_MUST_BE_OUTSIDE_REPOSITORY");
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("BACKUP_PARENT_NOT_FOUND");
    ancestor = parent;
  }
  const canonical = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, resolved));
  if (isInsideRepository(fs.realpathSync(repository), canonical)) throw new Error("BACKUP_MUST_BE_OUTSIDE_REPOSITORY");
  return canonical;
}

export async function createBackup(args) {
  if (args.source !== "production-readonly" && args.source !== "local") throw new Error("EXPLICIT_BACKUP_SOURCE_REQUIRED");
  if (!args.output) throw new Error("EXTERNAL_OUTPUT_DIRECTORY_REQUIRED");
  const output = assertExternalBackupOutput(args.output);
  const { config, url, passphrase } = privateConfig(args.env);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((args.source === "local") !== local) throw new Error("BACKUP_SOURCE_MISMATCH");
  if (!local) assertExpectedProductionProject(url, config);
  const caFile = path.resolve(config.DATABASE_CA_CERT || ".env.backup-ca.local");
  const client = postgresClient(url, { caFile, labContainer: args['lab-container'] });
  await client.connect();
  let child;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const info = (await client.query("select pg_export_snapshot() as snapshot,current_setting('server_version_num')::integer as version")).rows[0];
    const major = Math.floor(info.version / 10000);
    if (major < 15 || major > 18) throw new Error("POSTGRES_VERSION_NOT_VALIDATED");
    const image = args.image || `postgres:${major}-alpine`;
    if (!/^postgres:(15|16|17|18)(-alpine)?$/.test(image) && !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("UNAPPROVED_POSTGRES_CLIENT_IMAGE");
    const manifest = await databaseManifest(client);
    manifest.serverMajor = major;
    manifest.sourceFingerprint = connectionFingerprint(url);
    manifest.snapshot = info.snapshot;
    if (manifest.storage.some(({ name, count }) => name === "objects" && count > 0)) throw new Error("STORAGE_OBJECT_BACKUP_REQUIRED_BEFORE_VERIFICATION");
    await fs.promises.mkdir(output, { recursive: true });
    assertExternalBackupOutput(output);
    const directory = path.join(output, new Date().toISOString().replaceAll(":", "-") + `-${process.pid}`);
    await fs.promises.mkdir(directory, { recursive: false });
    const dump = path.join(directory, "database.hpebk");
    const env = { ...process.env,
      PGHOST: local ? "host.docker.internal" : url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1) || "postgres",
      PGSSLMODE: local ? "disable" : "verify-full", PGSSLROOTCERT: !local && fs.existsSync(caFile) ? "/hpe/ca.crt" : "system",
    };
    const certificateMount = !local && fs.existsSync(caFile) ? ["--mount", `type=bind,source=${caFile},target=/hpe/ca.crt,readonly`] : [];
    const dumpArguments = local && args['lab-container']
      ? ["exec", args['lab-container'], "pg_dump", "--username=postgres", `--dbname=${url.pathname.slice(1)}`, "--format=custom", `--snapshot=${info.snapshot}`]
      : ["run", "--rm", ...certificateMount, "--env", "PGHOST", "--env", "PGPORT", "--env", "PGUSER", "--env", "PGPASSWORD",
      "--env", "PGDATABASE", "--env", "PGSSLMODE", "--env", "PGSSLROOTCERT", image,
      "pg_dump", "--format=custom", `--snapshot=${info.snapshot}`];
    child = spawn("docker", dumpArguments, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    // Provider diagnostics can contain connection details; only report the exit code.
    child.stderr.resume();
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error("PG_DUMP_FAILED")));
    });
    const [dumpSha256] = await Promise.all([encryptBackupStream(child.stdout, dump, passphrase), completion]);
    await client.query("COMMIT");
    manifest.dumpSha256 = dumpSha256;
    await encryptBackupStream(Readable.from([JSON.stringify(manifest)]), path.join(directory, "manifest.hpebk"), passphrase);
    const metadata = { version: "0.3.0", createdAt: manifest.createdAt, serverMajor: major,
      sourceFingerprint: manifest.sourceFingerprint,
      snapshotConsistent: true, restorationVerified: false,
      dumpEncryptedSha256: await fileSha256(path.join(directory, "database.hpebk")),
      manifestEncryptedSha256: await fileSha256(path.join(directory, "manifest.hpebk")),
      tables: manifest.tables.length, rows: manifest.tables.reduce((sum, table) => sum + table.count, 0) };
    await fs.promises.writeFile(path.join(directory, "verification.json"), JSON.stringify(metadata, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ operation: "backup_created_not_yet_restored", directory, ...metadata }));
    return directory;
  } finally {
    if (child && child.exitCode === null) child.kill();
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createBackup(parseArguments()).catch((error) => { console.error(JSON.stringify(safeOpsFailure("backup", error))); process.exitCode = 1; });
}
