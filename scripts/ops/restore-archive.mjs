import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { withOriginalExtensionInstaller } from "./extension-installer.mjs";

export function splitRestoreToc(toc, extensions = []) {
  const lines = toc.split(/\r?\n/);
  const deferred = (line) => /^\d+; .*\b(?:EVENT TRIGGER - ensure_rls postgres|(?:COMMENT|SECURITY LABEL) - EVENT TRIGGER ensure_rls postgres)\s*$/.test(line);
  const ids = lines.filter(deferred).map((line) => Number(line.slice(0, line.indexOf(";"))));
  const schemaLines = extensions.length ? lines.filter((line) => /^\d+; \d+ \d+ SCHEMA - /.test(line)) : [];
  const extensionLines = extensions.length ? lines.filter((line) => /^\d+; \d+ \d+ EXTENSION - /.test(line)) : [];
  const early = new Set([...schemaLines, ...extensionLines]);
  const select = (selected) => lines.map((line) => /^\d+;/.test(line) && !selected.has(line) ? `; ${line}` : line).join("\n");
  const byOwner = new Map();
  for (const line of extensionLines) {
    const name = line.match(/^\d+; \d+ \d+ EXTENSION - (\S+)\s*$/)?.[1];
    const extension = extensions.find((item) => item.extname === name);
    if (!extension?.owner) throw new Error("BACKUP_EXTENSION_OWNER_METADATA_REQUIRED");
    if (!byOwner.has(extension.owner)) byOwner.set(extension.owner, new Set());
    byOwner.get(extension.owner).add(line);
  }
  return { regular: lines.map((line) => deferred(line) || early.has(line) ? `; ${line}` : line).join("\n"),
    schemas: select(new Set(schemaLines)), extensionGroups: [...byOwner].map(([owner, selected]) => ({ owner, list: select(selected) })),
    deferred: select(new Set(lines.filter(deferred))), ids };
}

async function runArchive(container, args, dump, password) {
  const child = spawn("docker", ["exec", "-i", "--env", "PGPASSWORD", container, "pg_restore", ...args], {
    windowsHide: true, env: { ...process.env, PGPASSWORD: password }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let diagnostics = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (output.length > 4 * 1024 * 1024) child.kill();
  });
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
  child.stdin.on("error", () => {});
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (isSuccessfulRestoreExit(code, signal)) return resolve(output);
      const reason = diagnostics.match(/(?:ERROR|pg_restore: error):\s*([^\r\n]+)/i)?.[1] || "UNKNOWN_RESTORE_ERROR";
      console.error(JSON.stringify({ operation: "local_restore_diagnostic", reason: reason.replace(/'[^']*'|"[^"]*"/g, "[object]").replace(/[\w.%+-]+@[\w.-]+/g, "[redacted]").slice(0, 240), productionChanged: false }));
      reject(new Error("LOCAL_PG_RESTORE_FAILED_NO_PRODUCTION_CHANGES"));
    });
  });
  child.stdin.end(dump);
  return completion;
}

export function isSuccessfulRestoreExit(code, signal) { return code === 0 && !signal; }

export async function restoreArchive({ container, dump, manifest, database, operator, password, postgresPassword, client }) {
  const toc = await runArchive(container, ["--list"], dump, password);
  const lists = splitRestoreToc(toc, manifest.extensions);
  if (lists.ids.length && !manifest.eventTriggers?.some((trigger) => trigger.name === "ensure_rls"
    && trigger.owner === "postgres" && trigger.function_owner === "postgres")) throw new Error("NON_SUPERUSER_EVENT_TRIGGER_NOT_IN_SNAPSHOT");
  if ((lists.ids.length || lists.extensionGroups.some((group) => group.owner === "postgres")) && !postgresPassword) throw new Error("LOCAL_POSTGRES_PASSWORD_REQUIRED_FOR_DEFERRED_TRIGGER");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hpe-restore-toc-"));
  const regular = path.join(directory, "regular.list");
  const deferred = path.join(directory, "deferred.list");
  const schemas = path.join(directory, "schemas.list");
  await fs.writeFile(regular, lists.regular, { flag: "wx", mode: 0o600 });
  await fs.writeFile(deferred, lists.deferred, { flag: "wx", mode: 0o600 });
  await fs.writeFile(schemas, lists.schemas, { flag: "wx", mode: 0o600 });
  for (let index = 0; index < lists.extensionGroups.length; index += 1) {
    await fs.writeFile(path.join(directory, `extension-${index}.list`), lists.extensionGroups[index].list, { flag: "wx", mode: 0o600 });
  }
  const remote = `/tmp/${path.basename(directory)}`;
  execFileSync("docker", ["cp", directory, `${container}:${remote}`], { windowsHide: true });
  await runArchive(container, ["--host=127.0.0.1", `--username=${operator}`, `--dbname=${database}`,
    "--exit-on-error", "--single-transaction", `--use-list=${remote}/schemas.list`], dump, password);
  const requiresOriginalOwner = lists.extensionGroups.some((group) => group.owner === "postgres");
  if (requiresOriginalOwner) {
    if (!client || !/^hpe_(restore_[a-z0-9]+|lab)$/.test(database)) throw new Error("EXPLICIT_ISOLATED_EXTENSION_RESTORE_REQUIRED");
  }
  const install = async () => {
    for (let index = 0; index < lists.extensionGroups.length; index += 1) {
      const { owner } = lists.extensionGroups[index];
      if (owner !== "postgres" && !manifest.roles.some((role) => role.rolname === owner && role.rolsuper)) throw new Error("EXTENSION_OWNER_RESTORE_NOT_VALIDATED");
      await runArchive(container, ["--host=127.0.0.1", `--username=${owner === "postgres" ? "postgres" : operator}`,
        ...(owner === "postgres" ? [] : [`--role=${owner}`]), `--dbname=${database}`,
        "--exit-on-error", "--single-transaction", `--use-list=${remote}/extension-${index}.list`], dump,
      owner === "postgres" ? postgresPassword : password);
    }
  };
  if (requiresOriginalOwner) await withOriginalExtensionInstaller(client, install);
  else await install();
  await runArchive(container, ["--host=127.0.0.1", `--username=${operator}`, `--dbname=${database}`,
    "--exit-on-error", "--single-transaction", `--use-list=${remote}/regular.list`], dump, password);
  if (lists.ids.length) {
    await runArchive(container, ["--host=127.0.0.1", "--username=postgres", `--dbname=${database}`,
      "--exit-on-error", "--single-transaction", `--use-list=${remote}/deferred.list`], dump, postgresPassword);
  }
  return { deferredTocIds: lists.ids, twoPhaseRestore: lists.ids.length > 0,
    extensionOwnersPreserved: lists.extensionGroups.map((group) => group.owner),
    offlineInstallerConfigurationRestored: requiresOriginalOwner };
}
