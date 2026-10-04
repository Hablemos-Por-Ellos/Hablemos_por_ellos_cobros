import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import crypto from "node:crypto";
import { localDockerStream } from "./local-docker-stream.mjs";

export function connectionFingerprint(url) {
  return crypto.createHash("sha256").update(`${url.hostname}|${url.port || "5432"}|${url.username}|${url.pathname}`).digest("hex");
}

export function assertExpectedProductionProject(url, config) {
  let expected = config.EXPECTED_PROJECT_REF;
  if (!expected && fs.existsSync(".env.local")) {
    const existing = parseEnv(fs.readFileSync(".env.local", "utf8"));
    const apiUrl = existing.SUPABASE_URL;
    if (apiUrl) {
      const hostname = new URL(apiUrl).hostname;
      if (hostname.endsWith(".supabase.co")) expected = hostname.slice(0, -".supabase.co".length);
    }
  }
  if (!expected || (!url.hostname.startsWith(`db.${expected}.`) && !decodeURIComponent(url.username).endsWith(`.${expected}`))) {
    throw new Error("DATABASE_CONNECTION_DOES_NOT_MATCH_EXPECTED_PROJECT");
  }
}

export function privateConfig(file = ".env.backup.local") {
  const config = parseEnv(fs.readFileSync(path.resolve(file), "utf8"));
  const connection = config.DATABASE_URL;
  if (!connection) throw new Error("DATABASE_URL_MISSING_IN_PRIVATE_FILE");
  const url = new URL(connection);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("POSTGRES_URL_REQUIRED");
  if (url.port === "6543") throw new Error("USE_DIRECT_OR_SESSION_POOLER_PORT_5432");
  const passphrase = config.BACKUP_PASSPHRASE || decodeURIComponent(url.password);
  return { config, url, passphrase };
}

export function postgresClient(url, { readOnly = true, caFile = ".env.backup-ca.local", labContainer } = {}) {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (labContainer && !local) throw new Error("DOCKER_TRANSPORT_ONLY_FOR_LOCAL_LAB");
  const connection = new URL(url);
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) connection.searchParams.delete(key);
  const client = new pg.Client({
    connectionString: connection.toString(),
    ...(labContainer ? { stream: () => localDockerStream(labContainer) } : {}),
    ssl: local ? false : { rejectUnauthorized: true, ...(fs.existsSync(caFile) ? { ca: fs.readFileSync(caFile, "utf8") } : {}) },
    application_name: readOnly ? "hpe-backup-readonly-v0.3.0" : "hpe-local-rehearsal-v0.3.0",
    connectionTimeoutMillis: 15000,
    statement_timeout: 120000,
    options: readOnly ? "-c default_transaction_read_only=on" : undefined,
  });
  const connect = client.connect.bind(client);
  client.connect = async () => {
    await connect();
    if (readOnly) {
      // Some poolers discard startup options: enforce and verify after authentication.
      await client.query("set default_transaction_read_only=on");
      const result = await client.query("show default_transaction_read_only");
      if (result.rows[0].default_transaction_read_only !== "on") throw new Error("READ_ONLY_SESSION_NOT_CONFIRMED");
    }
  };
  return client;
}

export function parseArguments(args = process.argv.slice(2)) {
  return Object.fromEntries(args.map((arg) => {
    if (!arg.startsWith("--") || !arg.includes("=")) throw new Error("USE_NAMED_ARGUMENTS");
    const index = arg.indexOf("=");
    return [arg.slice(2, index), arg.slice(index + 1)];
  }));
}

export function safeOpsFailure(operation, error) {
  const message = String(error?.message ?? "");
  return { operation, code: error?.code || (/^[A-Z0-9_]+$/.test(message) ? message : "OPERATION_FAILED"), verified: false };
}
