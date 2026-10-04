// ESCRITURA LOCAL: synthetic receipts only; no provider, Auth or migration calls.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const endpoint = "http://127.0.0.1:3001/api/wompi/webhook";
const eventsSecret = "test_events_local_cutover_fixture_only";
const client = new pg.Client({
  host: "127.0.0.1", port: 54327, database: "hpe_auth_lab",
  user: "postgres", password: "hpe-local-auth-fixture-only",
  connectionTimeoutMillis: 5000, query_timeout: 15000,
});
let checks = 0;
const check = (condition) => { assert.ok(condition); checks += 1; };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const tables = ["donors", "subscriptions", "payments", "audit_logs", "webhook_events",
  "payment_attempts", "checkout_intents", "admin_audit_logs"];

async function snapshot() {
  const result = {};
  await client.query("begin isolation level repeatable read read only");
  try {
    for (const table of tables) {
      const { rows } = await client.query(`select id, to_jsonb(t)::text as content from public.${table} t order by id`);
      result[table] = new Map(rows.map((row) => [row.id, hash(row.content)]));
    }
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function request(body, { method = "POST", checksum } = {}) {
  return fetch(endpoint, {
    method, redirect: "error", signal: AbortSignal.timeout(60000),
    headers: { "content-type": "application/json", ...(checksum ? { "x-event-checksum": checksum } : {}) },
    ...(method === "POST" ? { body } : {}),
  });
}

try {
  await client.connect();
  const { rows: [guard] } = await client.query(`select current_database() = 'hpe_auth_lab'
    and public.payment_admin_schema_ready() as safe`);
  check(guard.safe);
  const before = await snapshot();
  const transactionId = `local-cutover-${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const transaction = {
    id: transactionId, status: "PENDING", reference: `LOCAL-${randomUUID()}`,
    amount_in_cents: 150000, currency: "COP",
  };
  const checksum = hash(`${transaction.id}${transaction.status}${transaction.amount_in_cents}${timestamp}${eventsSecret}`);
  const payload = {
    event: "transaction.updated", environment: "test", data: { transaction }, timestamp,
    signature: { properties: ["transaction.id", "transaction.status", "transaction.amount_in_cents"], checksum },
  };
  const body = JSON.stringify(payload);

  check((await request(undefined, { method: "GET" })).status === 405);
  check((await request("")).status === 400);
  check((await request("{invalid-json")).status === 400);
  check((await request("x".repeat(131073))).status === 413);
  check((await request(body, { checksum: "0".repeat(64) })).status === 401);
  check((await request(JSON.stringify({ ...payload, environment: "prod" }), { checksum })).status === 401);

  for (let repeat = 0; repeat < 2; repeat += 1) {
    const response = await request(body, { checksum });
    check(response.status === 200);
    check((await response.json()).result === "queued");
  }

  const after = await snapshot();
  for (const table of tables) {
    for (const [id, content] of before[table]) check(after[table].get(id) === content);
    if (table !== "webhook_events") check(after[table].size === before[table].size);
  }
  const addedIds = [...after.webhook_events.keys()].filter((id) => !before.webhook_events.has(id));
  check(addedIds.length === 2);
  const { rows: receipts } = await client.query(
    "select transaction_id, event_type, raw from public.webhook_events where id = any($1::uuid[])", [addedIds]
  );
  check(receipts.every((receipt) => receipt.transaction_id === null && receipt.event_type === null
    && receipt.raw.receipt_version === 1 && receipt.raw.environment === "test"
    && receipt.raw.transaction.id === transactionId && receipt.raw.body_sha256 === hash(body)));
  console.log(JSON.stringify({
    result: "passed", checks, endpoint: "loopback-only", expectedMode: "cutover",
    modeEvidence: "requires_parent_verified_startup_profile", observedTables: tables,
    syntheticReceiptsAdded: receipts.length, observedRowsPreserved: true,
    paymentsUnchanged: true, syntheticEvents: true, realWompiDeliveryVerified: false,
  }));
} catch {
  console.error("LOCAL_CUTOVER_WEBHOOK_CHECK_FAILED");
  process.exitCode = 1;
} finally {
  await client.end();
}
