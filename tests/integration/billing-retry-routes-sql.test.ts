// @vitest-environment node
// v0.4.0 | 2026-10-08 | ESCRITURA LOCAL only after explicit opt-in; default SKIP.
// HTTP handlers + real SQL, not SSR/Auth/Wompi network integration or COMMIT durability.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWompiEventChecksum, type WompiEventPayload } from '@/lib/wompi-webhook';

const providers = vi.hoisted(() => ({
  client: vi.fn(), acceptance: vi.fn(), source: vi.fn(), sourceAvailable: vi.fn(),
  create: vi.fn(), get: vi.fn(), admin: vi.fn(), adminSchema: vi.fn(), totp: vi.fn(), sameOrigin: vi.fn(),
}));
vi.mock('@/lib/supabase-server', () => ({ getServiceSupabaseClient: providers.client }));
vi.mock('@/lib/wompi', () => ({ WOMPI_ENV: 'sandbox', getWompiEventsSecret: () => 'test_events_ROUTE_FIXTURE_NOT_A_REAL_SECRET' }));
vi.mock('@/lib/wompi-server', () => ({
  getWompiAcceptance: providers.acceptance, createWompiPaymentSource: providers.source,
  isWompiPaymentSourceAvailable: providers.sourceAvailable,
  createWompiTransaction: providers.create, getWompiTransaction: providers.get,
  createWompiIntegritySignature: () => 'fixture-integrity-signature-not-a-provider-signature',
}));
vi.mock('@/lib/admin-auth', () => ({
  getAdminContext: providers.admin, isAdminSchemaReady: providers.adminSchema,
  isAdminDemoMode: () => false, verifyRecentTotp: providers.totp,
  isSameOriginRequest: providers.sameOrigin,
}));

const CONTAINER = 'hpe-retry-v040-local';
const DATABASE = 'hpe_retry_lab_1791517849626';
const DIGEST = 'dbb0b98ca4d44f0d999d0f7a77b28d9e88fb6d71799e577a0a65491533f3b34d';
const enabled = process.env.HPE_RETRY_ROUTE_LAB === 'yes' && process.env.HPE_RETRY_ROUTE_DB === DATABASE;
const EVENTS_SECRET = 'test_events_ROUTE_FIXTURE_NOT_A_REAL_SECRET';
const INSUFFICIENT_FUNDS = 'Intente mas tarde - Fondos Insuficientes';
const migration = fileURLToPath(new URL('../../supabase/migrations/202610080001_billing_retry_cycles.sql', import.meta.url));
const routePaths = [
  '../../src/app/api/donations/route.ts', '../../src/app/api/wompi/webhook/route.ts',
  '../../src/app/api/admin/payment-attempts/[id]/reconcile/route.ts',
].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const fileDigest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

type Row = Record<string, unknown>;
type SqlError = { message: string; code?: string };
type Result = { data: unknown; error: SqlError | null };
type PgConnection = {
  connect(): Promise<void>;
  query<T extends Row = Row>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};
type Transaction = {
  id: string; reference: string; amountInCents: number; currency: string;
  paymentSourceId: string | null; paymentMethodType: string;
  status: 'pending' | 'approved' | 'declined'; statusMessage: string | null;
  finalizedAt: string | null; environment: 'sandbox'; verificationSource: 'provider_get';
};
type CreateTransaction = {
  reference: string; amountInCents: number; currency: string; customerEmail: string;
  paymentSourceId: string; onSending: () => void;
};
type FixtureState = { subscription: Row; cycles: Row[]; attempts: Row[]; payments: Row[]; audits: Row[] };
type Draft = { token: string; reference: string; expiresAt: string };
type Donor = ReturnType<typeof donorInput>;

const columns = {
  donors: ['id', 'email', 'email_normalized', 'first_name', 'last_name', 'phone', 'document_type',
    'document_number', 'city', 'wants_updates'],
  checkout_intents: ['id', 'donor_id', 'reference', 'secret_hash', 'amount', 'currency', 'is_recurring',
    'preferred_payment_day', 'environment', 'state', 'expires_at', 'payment_method_type', 'retry_authorization'],
  payment_attempts: ['id', 'subscription_id', 'checkout_intent_id', 'reference', 'amount', 'currency', 'state',
    'wompi_transaction_id', 'attempt_number', 'cycle_id', 'dispatch_snapshot'],
  subscriptions: ['id', 'frequency', 'wompi_payment_source_id', 'preferred_payment_day'],
  payments: ['id', 'payment_attempt_id', 'subscription_id', 'wompi_transaction_id', 'reference', 'amount', 'currency'],
  webhook_events: ['id', 'transaction_id', 'event_type', 'raw'],
} as const;
type Table = keyof typeof columns;
const insertColumns: Partial<Record<Table, readonly string[]>> = {
  donors: ['email', 'first_name', 'last_name', 'phone', 'document_type', 'document_number', 'city', 'wants_updates'],
  checkout_intents: ['donor_id', 'reference', 'secret_hash', 'amount', 'currency', 'is_recurring',
    'preferred_payment_day', 'environment', 'state', 'expires_at', 'retry_authorization'],
  webhook_events: ['id', 'transaction_id', 'event_type', 'raw'],
};
const allowedRpc = new Set(['billing_retry_schema_ready', 'payment_admin_schema_ready', 'consume_api_rate_limit',
  'billing_v2_prepare_subscription', 'billing_v2_bind_source', 'billing_v2_reserve_initial',
  'billing_v2_authorize_send', 'billing_v2_record_dispatch', 'billing_v2_apply_result',
  'billing_v2_mark_uncertain', 'mark_wompi_receipt', 'billing_v2_admin_recovery_replay',
  'billing_v2_admin_reconcile_payment_attempt', 'apply_verified_wompi_event']);
const quote = (value: string) => {
  assert.match(value, /^[a-z_][a-z_0-9]*$/);
  return `"${value}"`;
};

let pg: PgConnection | undefined;
let connected = false;
let transactionOpen = false;
let adapter: SqlSupabaseAdapter;
let actor: string;
let context: { userId: string; demo: false; aal: string; sessionIssuedAt: string };
let postStatus: Transaction['status'];
let baseline: unknown;
let sourceHashes: string[];
let forbiddenFetches = 0;
let sqlErrors = 0;
let rollbackChecks = 0;
let totalRpc = 0;
let totalQueries = 0;
let fixtureDonors: string[] = [];
const transactions = new Map<string, Transaction>();
const sources = new Set<string>();

function connection() { assert.ok(pg && connected, 'GUARDED_PG_CONNECTION_REQUIRED'); return pg; }
async function observeClock() {
  const result = await connection().query<{ db_now: Date }>('select clock_timestamp() as db_now');
  vi.setSystemTime(result.rows[0].db_now);
  return result.rows[0].db_now.toISOString();
}
async function fixtureQuery<T extends Row = Row>(sql: string, values: unknown[] = []) {
  assert.ok(transactionOpen, 'FIXTURE_WRITES_REQUIRE_ROLLBACK_TRANSACTION');
  await connection().query('reset role');
  return connection().query<T>(sql, values);
}

// Each operation retains the real SQL error and rolls back only its savepoint on failure.
// Named RPC arguments and all data/filter values use PostgreSQL bind parameters.
class SqlSupabaseAdapter {
  reads: string[] = [];
  rpcs: { name: string; args: Row; data?: unknown; error?: SqlError }[] = [];
  blockEntityReads = false;

  async execute(sql: string, values: unknown[]): Promise<Result> {
    assert.ok(transactionOpen, 'ROUTE_SQL_REQUIRES_ROLLBACK_TRANSACTION');
    await connection().query('savepoint route_operation');
    try {
      await connection().query('set local role service_role');
      const result = await connection().query<{ data: unknown; db_now: Date }>(sql, values);
      const data = result.rows.map((row) => row.data);
      if (result.rows[0]?.db_now) vi.setSystemTime(result.rows[0].db_now);
      else await observeClock();
      await connection().query('release savepoint route_operation');
      return { data, error: null };
    } catch (error) {
      await connection().query('rollback to savepoint route_operation');
      await connection().query('release savepoint route_operation');
      await observeClock();
      sqlErrors += 1;
      const failure = error as Error & { code?: string };
      return { data: null, error: { message: failure.message, code: failure.code } };
    }
  }

  async rpc(name: string, args: Row = {}): Promise<Result> {
    assert.ok(allowedRpc.has(name), 'RPC_NOT_IN_ROUTE_LAB_ALLOWLIST');
    const keys = Object.keys(args);
    keys.forEach((key) => assert.match(key, /^p_[a-z_0-9]+$/));
    const parameters = keys.map((key, index) => `${quote(key)} => $${index + 1}`).join(',');
    const result = await this.execute(`select public.${quote(name)}(${parameters}) as data,clock_timestamp() as db_now`, Object.values(args));
    const response = { data: Array.isArray(result.data) ? result.data[0] : null, error: result.error };
    this.rpcs.push({ name, args: structuredClone(args), data: structuredClone(response.data), ...(response.error ? { error: response.error } : {}) });
    totalRpc += 1;
    return response;
  }

  from(name: string) {
    assert.ok(Object.hasOwn(columns, name), 'TABLE_NOT_IN_ROUTE_LAB_ALLOWLIST');
    return new SqlQuery(this, name as Table);
  }
}

class SqlQuery implements PromiseLike<Result> {
  private projection: string[] = [];
  private parameters: unknown[] = [];
  private predicates: string[] = [];
  private inserted: Row | null = null;
  private maximum: number | null = null;
  private execution: Promise<Result> | null = null;
  constructor(private client: SqlSupabaseAdapter, private table: Table) {}
  private column(value: string) {
    assert.ok((columns[this.table] as readonly string[]).includes(value), `COLUMN_NOT_ALLOWED_${this.table}`);
    return quote(value);
  }
  private bind(value: unknown) { this.parameters.push(value); return `$${this.parameters.length}`; }
  select(fields: string) {
    this.projection = fields.split(',').map((field) => field.trim());
    this.projection.forEach((field) => this.column(field));
    return this;
  }
  eq(field: string, value: unknown) { this.predicates.push(`${this.column(field)}=${this.bind(value)}`); return this; }
  or(expression: string) {
    const alternatives = expression.split(',').map((term) => {
      const match = /^([a-z_]+)\.eq\.([A-Za-z0-9_-]+)$/.exec(term);
      assert.ok(match, 'ONLY_SIMPLE_PARAMETERIZED_OR_EQ_ALLOWED');
      return `${this.column(match[1])}=${this.bind(match[2])}`;
    });
    this.predicates.push(`(${alternatives.join(' or ')})`);
    return this;
  }
  limit(count: number) { assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 100); this.maximum = count; return this; }
  insert(value: Row) {
    const allowed = insertColumns[this.table];
    assert.ok(allowed, 'DIRECT_FINANCIAL_ROUTE_INSERT_FORBIDDEN');
    Object.keys(value).forEach((key) => assert.ok(allowed.includes(key), 'INSERT_COLUMN_NOT_ALLOWED'));
    if (this.table === 'donors') assert.match(String(value.email), /^route-[^@]+@example\.test$/);
    if (this.table === 'checkout_intents') assert.equal(value.environment, 'sandbox');
    if (this.table === 'webhook_events') {
      const receipt = value.raw as { transaction?: { id?: string } };
      assert.ok(receipt.transaction?.id?.startsWith('fixture-route-'), 'ONLY_FICTIONAL_RECEIPTS_ALLOWED');
    }
    this.inserted = value;
    return this;
  }
  private run() {
    if (this.execution) return this.execution;
    this.execution = (async () => {
      const fields = this.projection.map((field) => this.column(field)).join(',');
      let sql: string;
      let values: unknown[];
      if (this.inserted) {
        assert.equal(this.predicates.length, 0);
        const keys = Object.keys(this.inserted);
        values = Object.values(this.inserted);
        sql = `with written as (insert into public.${quote(this.table)} (${keys.map(quote).join(',')})
          values(${keys.map((_, index) => `$${index + 1}`).join(',')}) returning ${fields || 'id'})
          select to_jsonb(written) as data,clock_timestamp() as db_now from written`;
      } else {
        assert.equal(this.client.blockEntityReads, false, 'REPLAY_MUST_NOT_READ_ENTITY_TABLES');
        assert.ok(fields && this.predicates.length, 'UNSCOPED_ROUTE_READ_FORBIDDEN');
        this.client.reads.push(this.table);
        totalQueries += 1;
        values = [...this.parameters];
        const maximum = this.maximum == null ? '' : ` limit $${values.push(this.maximum)}`;
        sql = `select to_jsonb(found) as data,clock_timestamp() as db_now from
          (select ${fields} from public.${quote(this.table)} where ${this.predicates.join(' and ')}${maximum}) found`;
      }
      const result = await this.client.execute(sql, values);
      if (this.table === 'donors' && this.inserted && !result.error && Array.isArray(result.data)) {
        for (const row of result.data) fixtureDonors.push((row as Row).id as string);
      }
      return result;
    })();
    return this.execution;
  }
  async maybeSingle() {
    const result = await this.run();
    if (result.error) return result;
    const rows = result.data as unknown[];
    if (rows.length > 1) return { data: null, error: { message: 'multiple rows', code: 'PGRST116' } };
    return { data: rows[0] ?? null, error: null };
  }
  async single() {
    const result = await this.run();
    if (result.error) return result;
    const rows = result.data as unknown[];
    return rows.length === 1 ? { data: rows[0], error: null }
      : { data: null, error: { message: 'single row required', code: 'PGRST116' } };
  }
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> { return this.run().then(onfulfilled, onrejected); }
}

const fingerprintSql = `select jsonb_object_agg(name,fingerprint) as data from (
  ${['donors', 'subscriptions', 'billing_cycles', 'payment_attempts', 'payments', 'webhook_events',
    'audit_logs', 'checkout_intents', 'admin_users', 'admin_audit_logs', 'api_rate_limits'].map((table) =>
    `select '${table}' as name,md5(coalesce(string_agg((to_jsonb(t)-'secret_hash')::text,E'\\n' order by (to_jsonb(t)-'secret_hash')::text),'')) as fingerprint from public.${table} t`).join(' union all ')}
  union all select 'auth.users',md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by id),'')) from auth.users t) hashes`;

let donationPost: typeof import('@/app/api/donations/route').POST;
let webhookPost: typeof import('@/app/api/wompi/webhook/route').POST;
let recoveryPost: typeof import('@/app/api/admin/payment-attempts/[id]/reconcile/route').POST;
function request(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:3000${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', origin: 'http://127.0.0.1:3000',
    'x-forwarded-for': actor, ...extraHeaders,
  }, body: JSON.stringify(body) });
}
function donorInput(recurring = true) {
  return { firstName: 'Route', lastName: 'Fictional', email: `route-${randomUUID()}@example.test`,
    phone: '3000000000', documentType: 'CC', documentNumber: '00000', city: 'Bogota', wantsUpdates: false,
    isRecurring: recurring, retryAuthorizationConfirmed: recurring, preferredPaymentDay: 16 };
}
async function draft(donor: Donor): Promise<Draft> {
  const response = await donationPost(request('/api/donations', { stage: 'draft', donor, amount: 30000 }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('draft_saved');
  return body.checkout;
}
function confirmInput(donor: Donor, checkout: Draft, transactionId?: string) {
  return { stage: 'confirm', donor, amount: 30000, paymentMethod: 'card', checkoutToken: checkout.token,
    wompi: { reference: checkout.reference, ...(transactionId ? { transactionId } : { cardToken: 'fixture-card-token-only' }) } };
}
async function state(reference: string): Promise<FixtureState> {
  const result = await fixtureQuery<{ data: FixtureState }>(`select jsonb_build_object('subscription',to_jsonb(s),
    'cycles',(select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]') from public.billing_cycles c where c.subscription_id=s.id),
    'attempts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.attempt_number,a.id),'[]') from public.payment_attempts a where a.subscription_id=s.id),
    'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.payments p where p.subscription_id=s.id),
    'audits',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]') from public.admin_audit_logs l where l.subscription_id=s.id)) as data
    from public.subscriptions s where s.reference=$1`, [reference]);
  assert.equal(result.rows.length, 1);
  return result.rows[0].data;
}
async function recover(attempt: Row, transactionId: string, requestId: string) {
  return recoveryPost(request(`/api/admin/payment-attempts/${attempt.id}/reconcile`, {
    action: 'reconcile', reason: 'Fictional route SQL verification', totpCode: '000000',
    requestId, transactionId, expectedVersion: 0,
  }), { params: Promise.resolve({ id: attempt.id as string }) });
}
function signedEvent(transaction: Transaction): { payload: WompiEventPayload; checksum: string } {
  const payload: WompiEventPayload = { event: 'transaction.updated', environment: 'test', timestamp: Math.floor(Date.now() / 1000),
    data: { transaction: { id: transaction.id, status: transaction.status.toUpperCase(), reference: transaction.reference,
      amount_in_cents: transaction.amountInCents, currency: transaction.currency, finalized_at: transaction.finalizedAt } },
    signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents', 'transaction.currency'] } };
  const checksum = computeWompiEventChecksum(payload, EVENTS_SECRET);
  assert.ok(checksum);
  payload.signature!.checksum = checksum;
  return { payload, checksum };
}

describe.skipIf(!enabled).sequential('v0.4.0 opted-in HTTP routes -> real PostgreSQL billing contract', () => {
  beforeAll(async () => {
    const inspected = JSON.parse(execFileSync('docker', ['inspect', '--format',
      '{"name":{{json .Name}},"image":{{json .Config.Image}},"network":{{json .HostConfig.NetworkMode}},"ports":{{json .NetworkSettings.Ports}},"bindings":{{json .HostConfig.PortBindings}},"running":{{json .State.Running}}}',
      CONTAINER], { encoding: 'utf8', windowsHide: true }));
    expect(inspected).toMatchObject({ name: `/${CONTAINER}`, image: 'postgres:16', network: 'none', running: true });
    expect(Object.values(inspected.ports ?? {}).some(Boolean)).toBe(false);
    expect(Object.keys(inspected.bindings ?? {})).toHaveLength(0);
    expect(await fileDigest(migration)).toBe(DIGEST);
    vi.stubGlobal('fetch', vi.fn(() => { forbiddenFetches += 1; throw new Error('ROUTE_LAB_EXTERNAL_FETCH_FORBIDDEN'); }));
    // This factory never reads env/CA files for a local URL. Only its guarded Docker wire transport is used.
    // @ts-expect-error Existing .mjs ops module has no TypeScript declaration.
    const { postgresClient } = await import('../../scripts/ops/private-config.mjs');
    pg = postgresClient(new URL(`postgresql://postgres@127.0.0.1:5432/${DATABASE}`),
      { labContainer: CONTAINER, readOnly: false }) as PgConnection;
    await pg.connect(); connected = true;
    await pg.query('begin read only');
    try {
      const result = await pg.query<{ data: Row }>(`select jsonb_build_object('database',current_database(),
        'legacy',exists(select 1 from public.donors where id='10000000-0000-0000-0000-000000000090' and email='legacy@example.test'),
        'nonFixtureDonors',(select count(*) from public.donors where email not like '%@example.test'),
        'nonFixtureUsers',(select count(*) from auth.users where email is null or email not like '%@example.test'),
        'ready',public.billing_retry_schema_ready(),
        'digest',(select digest from public.payment_admin_migrations where name='billing-retry-v0.4.0')) as data`);
      expect(result.rows[0].data).toEqual({ database: DATABASE, legacy: true, nonFixtureDonors: 0,
        nonFixtureUsers: 0, ready: true, digest: DIGEST });
    } finally { await pg.query('rollback'); }
    sourceHashes = await Promise.all(routePaths.map(fileDigest));
    donationPost = (await import('@/app/api/donations/route')).POST;
    webhookPost = (await import('@/app/api/wompi/webhook/route')).POST;
    recoveryPost = (await import('@/app/api/admin/payment-attempts/[id]/reconcile/route')).POST;
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('APP_OPERATION_MODE', 'active');
    vi.stubEnv('FINANCIAL_OPERATIONS_ENABLED', 'true');
    vi.stubEnv('CHECKOUT_TOKEN_PEPPER', 'route-fixture-pepper-not-a-real-secret-0000');
    fixtureDonors = []; transactions.clear(); sources.clear(); postStatus = 'declined';
    await connection().query('begin isolation level repeatable read'); transactionOpen = true;
    await connection().query("set local timezone='UTC'; set local statement_timeout='15s'; set local lock_timeout='2s'");
    baseline = (await connection().query(fingerprintSql)).rows[0].data;
    actor = randomUUID();
    await fixtureQuery('insert into auth.users(id,email) values($1,$2)', [actor, `route-admin-${actor}@example.test`]);
    await fixtureQuery("insert into public.admin_users(user_id,role,active) values($1,'admin',true)", [actor]);
    context = { userId: actor, demo: false, aal: 'aal2', sessionIssuedAt: await observeClock() };
    adapter = new SqlSupabaseAdapter();
    providers.client.mockReturnValue(adapter);
    providers.admin.mockImplementation(async () => ({ ...context }));
    providers.sameOrigin.mockImplementation((request: Request) => request.headers.get('origin') === 'http://127.0.0.1:3000');
    providers.adminSchema.mockImplementation(async () => {
      const result = await adapter.rpc('payment_admin_schema_ready'); return !result.error && result.data === true;
    });
    providers.totp.mockResolvedValue(true);
    providers.acceptance.mockResolvedValue({ acceptanceToken: 'fixture-acceptance', acceptPersonalAuth: 'fixture-personal-auth',
      acceptancePermalink: 'https://example.test/terms', personalDataAuthPermalink: 'https://example.test/privacy' });
    providers.source.mockImplementation(async ({ customerEmail }: { customerEmail: string }) => {
      expect(customerEmail).toMatch(/^route-[^@]+@example\.test$/);
      const id = 'fixture-route-source-' + randomUUID(); sources.add(id);
      return { id, type: 'CARD', status: 'AVAILABLE' };
    });
    providers.sourceAvailable.mockImplementation(async (id: string) => sources.has(id));
    providers.create.mockImplementation(async (input: CreateTransaction) => {
      expect(input.customerEmail).toMatch(/^route-[^@]+@example\.test$/);
      input.onSending();
      const id = 'fixture-route-tx-' + randomUUID();
      const finalizedAt = postStatus === 'pending' ? null : await observeClock();
      const transaction: Transaction = { id, reference: input.reference, amountInCents: input.amountInCents,
        currency: input.currency, paymentSourceId: input.paymentSourceId, paymentMethodType: 'CARD', status: postStatus,
        statusMessage: postStatus === 'declined' ? INSUFFICIENT_FUNDS : null, finalizedAt,
        environment: 'sandbox', verificationSource: 'provider_get' };
      transactions.set(id, transaction);
      return { id, status: postStatus };
    });
    providers.get.mockImplementation(async (id: string) => {
      const transaction = transactions.get(id); assert.ok(transaction, 'MOCK_PROVIDER_FIXTURE_NOT_FOUND');
      await observeClock(); return structuredClone(transaction);
    });
  }, 30_000);

  afterEach(async () => {
    try {
      if (transactionOpen) {
        await connection().query('reset role');
        await connection().query('rollback'); transactionOpen = false;
        expect((await connection().query(fingerprintSql)).rows[0].data).toEqual(baseline);
        expect((await connection().query('select count(*)::integer as count from public.donors where id=any($1::uuid[])', [fixtureDonors])).rows[0].count).toBe(0);
        rollbackChecks += 1;
      }
      expect(forbiddenFetches).toBe(0);
    } finally {
      providers.client.mockReturnValue(undefined);
      vi.useRealTimers(); vi.unstubAllEnvs();
    }
  }, 30_000);

  afterAll(async () => {
    try {
      if (connected) {
        if (transactionOpen) { await connection().query('rollback'); transactionOpen = false; }
        const marker = await connection().query("select digest from public.payment_admin_migrations where name='billing-retry-v0.4.0'");
        expect(marker.rows[0].digest).toBe(DIGEST);
        expect(await fileDigest(migration)).toBe(DIGEST);
        expect(await Promise.all(routePaths.map(fileDigest)), 'API_WORKER_CHANGED_SOURCE_DURING_RUN').toEqual(sourceHashes);
      }
    } finally {
      if (pg) await pg.end(); connected = false;
      vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    }
    console.log(JSON.stringify({ version: '0.4.0', localOnly: true, database: DATABASE, migrationDigest: DIGEST,
      container: CONTAINER, network: 'none', forbiddenFetches, totalRpc, totalQueries, sqlErrors, rollbackChecks,
      notCovered: ['real Auth/SSR/cookies/TOTP challenges', 'Wompi HTTP/widget/integrity signing',
        'COMMIT durability or loss of committed response: replay is semantic inside rollback TX',
        'concurrency, overnight waiting and exact 07:00/midnight boundaries', 'production deployment/configuration'] }));
  }, 30_000);

  it('monthly initial confirm uses nested SQL reservation/grant/full proof and second confirm never POSTs again', async () => {
    const donor = donorInput(); const checkout = await draft(donor);
    const input = confirmInput(donor, checkout);
    const first = await donationPost(request('/api/donations', input));
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: 'payment_pending' });
    expect(providers.create).toHaveBeenCalledTimes(1);
    const observed = await state(checkout.reference);
    expect(observed.cycles).toHaveLength(1);
    expect(observed.cycles[0]).toMatchObject({ origin: 'initial', retry_enabled: true, state: 'retry_wait', amount: 30000 });
    expect(observed.attempts).toHaveLength(1);
    expect(observed.attempts[0]).toMatchObject({ attempt_number: 1, state: 'declined', verified_reason: 'insufficient_funds' });
    expect(observed.attempts[0].send_authorized_at).not.toBeNull();
    expect(observed.subscription).toMatchObject({ status: 'past_due', next_payment_date: null, billing_hold_reason: 'retry_wait' });
    const reservation = adapter.rpcs.find((call) => call.name === 'billing_v2_reserve_initial')!.data as Row;
    expect((reservation.dispatchSnapshot as Row).attemptId).toBe((reservation.attempt as Row).id);
    const grant = adapter.rpcs.find((call) => call.name === 'billing_v2_authorize_send')!.data as Row;
    expect(grant.canDispatch).toBe(true);
    const applied = adapter.rpcs.find((call) => call.name === 'billing_v2_apply_result')!;
    expect(applied.data).toMatchObject({ retryQueued: true });
    expect((applied.args.p_transaction as Row).payment_source_verification).toMatchObject({ type: 'CARD', status: 'AVAILABLE',
      environment: 'sandbox', verification_source: 'provider_get', id: observed.subscription.wompi_payment_source_id });
    const window = await fixtureQuery(`select retry_window_start=(((a.verified_finalized_at at time zone 'America/Bogota')::date+1)::timestamp
      +interval '7 hours') at time zone 'America/Bogota' as starts_d1_07,
      retry_window_end=((a.verified_finalized_at at time zone 'America/Bogota')::date+2)::timestamp at time zone 'America/Bogota' as ends_midnight
      from public.billing_cycles c join public.payment_attempts a on a.cycle_id=c.id where c.id=$1`, [observed.cycles[0].id]);
    expect(window.rows[0]).toEqual({ starts_d1_07: true, ends_midnight: true });
    const second = await donationPost(request('/api/donations', input));
    const secondBody = await second.json();
    expect(providers.create).toHaveBeenCalledTimes(1);
    expect(providers.source).toHaveBeenCalledTimes(1);
    const repeated = await state(checkout.reference);
    expect(repeated.attempts).toHaveLength(1);
    expect(repeated.payments).toHaveLength(1);
    expect(repeated.cycles[0].retry_window_start).toBe(observed.cycles[0].retry_window_start);
    expect(repeated.cycles[0].state).toBe('retry_wait');
    console.log(JSON.stringify({ case: 'monthly-repeat', sends: providers.create.mock.calls.length,
      httpStatus: second.status, httpState: secondBody.status, sqlCycleState: repeated.cycles[0].state,
      sqlResult: adapter.rpcs.filter((call) => call.name === 'billing_v2_apply_result').at(-1)?.data }));
    expect(second.status, 'RETRY_WAIT_DUPLICATE_MUST_NOT_INVITE_A_NEW_CHECKOUT').toBe(202);
    expect(secondBody).toMatchObject({ status: 'payment_pending' });
    expect(secondBody.message).not.toMatch(/ma(?:\u00f1|n)ana/i);
    expect(adapter.rpcs.filter((call) => call.name === 'billing_v2_apply_result').at(-1)?.data)
      .toMatchObject({ result: 'duplicate', reason: null, retryQueued: true });
  }, 30_000);

  it('one-time widget checkout + really signed webhook approves NULL-cycle attempt without monthly billing', async () => {
    const donor = donorInput(false); const checkout = await draft(donor);
    const started = await donationPost(request('/api/donations', { ...confirmInput(donor, checkout), stage: 'checkout' }));
    expect(started.status).toBe(200);
    const before = await state(checkout.reference);
    expect(before.attempts).toHaveLength(1);
    expect(before.attempts[0]).toMatchObject({ cycle_id: null, attempt_number: 1, state: 'prepared' });
    const transaction: Transaction = { id: 'fixture-route-widget-' + randomUUID(), reference: checkout.reference,
      amountInCents: 3000000, currency: 'COP', paymentSourceId: null, paymentMethodType: 'CARD', status: 'approved',
      statusMessage: null, finalizedAt: await observeClock(), environment: 'sandbox', verificationSource: 'provider_get' };
    transactions.set(transaction.id, transaction);
    const signed = signedEvent(transaction);
    const badSignature = await webhookPost(request('/api/wompi/webhook', signed.payload, { 'x-event-checksum': '0'.repeat(64) }));
    expect(badSignature.status).toBe(401);
    expect(providers.get).not.toHaveBeenCalled();
    const applied = await webhookPost(request('/api/wompi/webhook', signed.payload, { 'x-event-checksum': signed.checksum }));
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ result: 'processed' });
    const repeated = await webhookPost(request('/api/wompi/webhook', signed.payload, { 'x-event-checksum': signed.checksum }));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ result: 'duplicate' });
    const confirmed = await donationPost(request('/api/donations', confirmInput(donor, checkout, transaction.id)));
    expect(confirmed.status).toBe(200);
    const after = await state(checkout.reference);
    expect(after.cycles).toHaveLength(0);
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]).toMatchObject({ cycle_id: null, attempt_number: 1, state: 'approved' });
    expect(after.subscription).toMatchObject({ frequency: 'one_time', status: 'active', next_payment_date: null, billing_authorization: null });
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({ status: 'approved', amount: 30000, wompi_transaction_id: transaction.id });
    expect(providers.create).not.toHaveBeenCalled();
    expect(providers.source).not.toHaveBeenCalled();
    const receipts = await fixtureQuery(`select count(*)::integer as count,bool_and(processing_state='processed') as all_processed
      from public.webhook_events where record_kind='receipt' and raw->'transaction'->>'id'=$1`, [transaction.id]);
    expect(receipts.rows[0]).toEqual({ count: 2, all_processed: true });
  }, 30_000);

  it('HTTP pending recovery replay precedes entity reads/GET after provider outage and source/version drift; SQL MFA still rejects', async () => {
    postStatus = 'pending';
    const donor = donorInput(); const checkout = await draft(donor);
    expect((await donationPost(request('/api/donations', confirmInput(donor, checkout)))).status).toBe(202);
    const observed = await state(checkout.reference);
    const attempt = observed.attempts[0]; const transactionId = attempt.wompi_transaction_id as string;
    const requestId = randomUUID();
    const first = await recover(attempt, transactionId, requestId);
    expect(providers.sameOrigin).toHaveBeenCalledTimes(1);
    expect(providers.sameOrigin.mock.calls[0][0]).toBeInstanceOf(Request);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ needsReview: false, recovery: { state: 'pending', needsReview: false } });
    const audited = await state(checkout.reference);
    expect(audited.audits).toHaveLength(1);
    expect(audited.audits[0].committed_response).toMatchObject(firstBody.recovery);
    await fixtureQuery('update public.subscriptions set wompi_payment_source_id=$1,billing_version=billing_version+1 where id=$2',
      ['fixture-route-changed-source-' + randomUUID(), observed.subscription.id]);
    providers.get.mockRejectedValue(new Error('FICTIONAL_PROVIDER_OUTAGE'));
    providers.sourceAvailable.mockRejectedValue(new Error('FICTIONAL_SOURCE_OUTAGE'));
    adapter.blockEntityReads = true;
    const reads = adapter.reads.length; const gets = providers.get.mock.calls.length; const rpcs = adapter.rpcs.length;
    const replay = await recover(attempt, transactionId, requestId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(adapter.reads).toHaveLength(reads);
    expect(providers.get).toHaveBeenCalledTimes(gets);
    expect(adapter.rpcs.slice(rpcs).map((call) => call.name)).toEqual(['payment_admin_schema_ready',
      'billing_retry_schema_ready', 'consume_api_rate_limit', 'billing_v2_admin_recovery_replay']);
    const after = await state(checkout.reference);
    expect(after.audits).toHaveLength(1);
    expect(after.attempts[0].state).toBe('pending');
    expect(after.subscription.billing_version).toBe(1);
    context.aal = 'aal1';
    const denied = await recover(attempt, transactionId, requestId);
    expect(denied.status).toBe(403);
    expect(adapter.rpcs.at(-1)?.error?.message).toContain('ADMIN_NOT_AUTHORIZED');
    expect(adapter.reads).toHaveLength(reads);
    expect(providers.get).toHaveBeenCalledTimes(gets);
    expect((await state(checkout.reference)).audits).toHaveLength(1);
  }, 30_000);

  it.each([
    { exactReference: true, providerAmountInCents: 1000000 },
    { exactReference: true, providerAmountInCents: 3000000 },
    { exactReference: false, providerAmountInCents: 1000000 },
  ])('HTTP legacy historical 10000 COP requires exact reference=$exactReference and provider cents=$providerAmountInCents', async ({ exactReference, providerAmountInCents }) => {
    const donor = randomUUID(); const subscription = randomUUID(); const attemptId = randomUUID(); const payment = randomUUID();
    const reference = 'route-legacy-' + randomUUID(); const source = 'fixture-route-legacy-source-' + randomUUID();
    const transactionId = 'fixture-route-legacy-money-' + randomUUID();
    fixtureDonors.push(donor);
    await fixtureQuery(`insert into public.donors(id,email,first_name,last_name) values($1,$2,'Route','Legacy')`, [donor, `route-${donor}@example.test`]);
    await fixtureQuery(`insert into public.subscriptions(id,donor_id,reference,amount,currency,frequency,status,payment_method_type,
      preferred_payment_day,wompi_payment_source_id,next_payment_date) values($1,$2,$3,35000,'COP','monthly','past_due','card',16,$4,null)`,
      [subscription, donor, reference, source]);
    await fixtureQuery(`insert into public.payment_attempts(id,donor_id,subscription_id,reference,amount,currency,
      subscription_version,state,wompi_transaction_id) values($1,$2,$3,$4,30000,'COP',0,'unknown',$5)`,
      [attemptId, donor, subscription, reference, transactionId]);
    await fixtureQuery(`insert into public.payments(id,subscription_id,payment_attempt_id,reference,amount,currency,status,
      wompi_transaction_id,billing_review_required) values($1,$2,$3,$4,10000,'COP','pending',$5,true)`,
      [payment, subscription, attemptId, exactReference ? reference : null, transactionId]);
    transactions.set(transactionId, { id: transactionId, reference, amountInCents: providerAmountInCents, currency: 'COP', paymentSourceId: source,
      paymentMethodType: 'CARD', status: 'approved', statusMessage: null, finalizedAt: await observeClock(),
      environment: 'sandbox', verificationSource: 'provider_get' });
    const before = await state(reference); const requestId = randomUUID();
    const recovered = await recover(before.attempts[0], transactionId, requestId);
    if (!exactReference || providerAmountInCents !== 1000000) {
      expect(recovered.status).toBe(409);
      expect(providers.get).toHaveBeenCalledTimes(exactReference ? 1 : 0);
      expect(adapter.rpcs.some((call) => call.name === 'billing_v2_admin_reconcile_payment_attempt')).toBe(false);
      expect(await state(reference)).toEqual(before);
      expect(providers.create).not.toHaveBeenCalled();
      return;
    }
    expect(recovered.status).toBe(200);
    const body = await recovered.json();
    expect(body).toMatchObject({ needsReview: true, recovery: { result: 'review', state: 'approved', needsReview: true } });
    const applied = adapter.rpcs.find((call) => call.name === 'billing_v2_admin_reconcile_payment_attempt')!;
    expect(applied.args.p_amount).toBe(10000);
    const after = await state(reference);
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({ id: payment, amount: 10000, status: 'approved', billing_review_required: true });
    expect(after.attempts[0]).toMatchObject({ id: attemptId, amount: 30000, cycle_id: null, attempt_number: null, state: 'approved' });
    expect(after.subscription).toEqual(before.subscription);
    expect(after.cycles).toHaveLength(0);
    expect(after.subscription.billing_authorization).toBeNull();
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0].committed_response).toMatchObject(body.recovery);
    const gets = providers.get.mock.calls.length; const reads = adapter.reads.length;
    providers.get.mockRejectedValue(new Error('FICTIONAL_LEGACY_PROVIDER_OUTAGE')); adapter.blockEntityReads = true;
    const replay = await recover(after.attempts[0], transactionId, requestId);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(body);
    expect(providers.get).toHaveBeenCalledTimes(gets); expect(adapter.reads).toHaveLength(reads);
    expect((await state(reference)).audits).toHaveLength(1);
    expect(providers.create).not.toHaveBeenCalled();
  }, 30_000);
});
