// ESCRITURA LOCAL: fictitious accounts in the existing loopback laboratory only.
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import pg from 'pg';
import { labConfig } from './local-auth-lab.mjs';

const app = 'http://127.0.0.1:3001';
const require = createRequire(import.meta.url);
let stage = 'guard';
let checks = 0;
let browser;
let unexpectedBrowserRequests = 0;
let privilegedBrowserRequests = 0;
let privilegedBundleMatches = 0;
const pendingBundles = [];
const mutations = process.argv.includes('--mutations=yes');
const check = (condition, name) => { assert.ok(condition, name); checks++; };
const database = new pg.Client({ host: '127.0.0.1', port: 54327, database: 'hpe_auth_lab',
  user: 'postgres', password: 'hpe-local-auth-fixture-only' });

function codeAt(secret, time = Date.now(), digits = 6) {
  let bits = '';
  for (const character of secret.toUpperCase().replace(/=+$/, '')) {
    const index = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character);
    if (index < 0) throw new Error('INVALID_FIXTURE_TOTP');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

async function nextCode(secret) {
  await new Promise((resolve) => setTimeout(resolve, 30000 - Date.now() % 30000 + 1200));
  return codeAt(secret);
}

async function snapshot() {
  const { rows: tables } = await database.query("select schemaname, tablename from pg_tables where schemaname in ('public','auth') order by 1,2");
  const result = new Map();
  for (const { schemaname, tablename } of tables) {
    const quote = (value) => `"${value.replaceAll('"', '""')}"`;
    const { rows } = await database.query(`select md5(to_jsonb(t)::text) as digest, count(*)::integer as count from ${quote(schemaname)}.${quote(tablename)} t group by 1`);
    result.set(`${schemaname}.${tablename}`, new Map(rows.map(({ digest, count }) => [digest, count])));
  }
  return result;
}

function sessionClient(config, cookies) {
  const jar = new Map(cookies.map(({ name, value }) => [name, value]));
  return createServerClient(config.url, config.anonKey, { auth: { autoRefreshToken: false },
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (values) => { for (const { name, value } of values) value ? jar.set(name, value) : jar.delete(name); } },
  });
}

async function waitForLogin(page) {
  await page.waitForURL(`${app}/admin/login`);
  await page.getByLabel('Correo', { exact: true }).waitFor();
}

try {
  check(process.argv.includes('--local-ui=yes'), 'EXPLICIT_LOCAL_UI_OPT_IN_REQUIRED');
  const modulePath = process.env.HPE_PLAYWRIGHT_MODULE;
  check(typeof modulePath === 'string' && modulePath.length > 0, 'EXISTING_PLAYWRIGHT_RUNTIME_REQUIRED');
  await fs.access('.env.integration-lab.local');
  const config = await labConfig();
  await database.connect();
  const { rows: [guard] } = await database.query("select current_database()='hpe_auth_lab' and public.payment_admin_schema_ready() as safe");
  check(guard.safe, 'EXISTING_AUTH_FIXTURE_REQUIRED');
  check(codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000, 8) === '94287082', 'RFC6238_VECTOR');
  const baseline = await snapshot();
  const service = createClient(config.url, config.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const suffix = randomUUID();
  const email = `hpe-ui-${suffix}@example.test`;
  const password = `Fictitious-${randomBytes(24).toString('base64url')}!`;

  stage = 'fixture';
  const account = await service.auth.admin.createUser({ email, password, email_confirm: true });
  check(!account.error && !!account.data.user?.id, 'FICTIONAL_UI_ACCOUNT_CREATED');
  const userId = account.data.user.id;
  const allowlist = await service.from('admin_users').insert({ user_id: userId, role: 'admin', active: true });
  check(!allowlist.error, 'FICTIONAL_ADMIN_ALLOWLIST_CREATED');
  const donorId = randomUUID();
  const subscriptionId = randomUUID();
  const donorName = `UI Fixture${suffix.slice(0, 8)}`;
  const initialDate = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 16, 12)).toISOString();
  if (mutations) {
    await database.query("insert into public.donors(id,email,first_name,last_name) values($1,$2,'UI',$3)",
      [donorId, `hpe-ui-donor-${suffix}@example.test`, `Fixture${suffix.slice(0, 8)}`]);
    await database.query(`insert into public.subscriptions(id,donor_id,amount,currency,frequency,status,reference,
      payment_method_type,preferred_payment_day,next_payment_date,wompi_payment_source_id)
      values($1,$2,1500,'COP','monthly','active',$3,'card',16,$4,'fixture-ui-source')`,
    [subscriptionId, donorId, `HPE-UI-${suffix}`, initialDate]);
  }
  const preparer = createClient(config.url, config.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  check(!(await preparer.auth.signInWithPassword({ email, password })).error, 'FIXTURE_PASSWORD_VALID');
  const enrollment = await preparer.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Local browser verification' });
  check(!enrollment.error && !!enrollment.data?.totp.secret, 'FIXTURE_TOTP_ENROLLED');
  const secret = enrollment.data.totp.secret;
  check(!(await preparer.auth.mfa.challengeAndVerify({ factorId: enrollment.data.id, code: codeAt(secret) })).error, 'FIXTURE_TOTP_VERIFIED');
  check(!(await preparer.auth.signOut({ scope: 'local' })).error, 'PREPARATION_SESSION_CLOSED');

  stage = 'browser';
  const { chromium } = require(modulePath);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let firstBootstrapObserved = false;
  let bootstrapObservation;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['3001', '54321'].includes(url.port)) {
      unexpectedBrowserRequests++;
      return route.abort();
    }
    if (request.headers().apikey === config.serviceKey) {
      privilegedBrowserRequests++;
      return route.abort();
    }
    if (url.pathname === '/api/admin/bootstrap' && !firstBootstrapObserved) {
      firstBootstrapObserved = true;
      const cookies = await context.cookies();
      const verifier = sessionClient(config, cookies);
      const identity = await verifier.auth.getUser();
      const claims = await verifier.auth.getClaims();
      const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
      const statuses = {};
      for (const [label, origin] of [['localhost', 'http://localhost:3001'], ['loopback', app], ['foreign', 'https://foreign.example.test']]) {
        const response = await fetch(`${app}/api/admin/bootstrap`, { method: 'POST', headers: { origin, cookie: cookieHeader } });
        statuses[label] = response.status;
      }
      bootstrapObservation = {
        cookiesPresent: cookies.length > 0, userMatchesFixture: identity.data.user?.id === userId,
        claimsVerified: !claims.error && !!claims.data?.claims,
        declaredAal1: claims.data?.claims?.aal === 'aal1', originMatchesApp: request.headers().origin === app,
        statuses };
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('response', (response) => {
    if (response.url().includes('/_next/') && response.url().split('?')[0].endsWith('.js')) {
      pendingBundles.push(response.text().then((body) => {
        if (body.includes(config.serviceKey)) privilegedBundleMatches++;
      }).catch(() => {}));
    }
  });
  await page.goto(`${app}/admin/login`);
  check(await page.getByRole('heading', { name: 'Panel administrativo', exact: true }).isVisible(), 'LOGIN_UI_RENDERED');
  for (const viewport of [{ width: 320, height: 700 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'LOGIN_NO_HORIZONTAL_SCROLL');
  }

  stage = 'wrong-password';
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Contrasena', { exact: true }).fill('Incorrect-local-fixture-password!');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'No fue posible iniciar sesion' }).waitFor();
  check((await page.getByLabel('Contrasena', { exact: true }).inputValue()) === '', 'FAILED_LOGIN_CLEARS_PASSWORD');

  stage = 'aal1';
  await page.getByLabel('Contrasena', { exact: true }).fill(password);
  await page.getByLabel('Contrasena', { exact: true }).press('Enter');
  await page.getByLabel('Codigo de Google Authenticator', { exact: true }).waitFor();
  check(bootstrapObservation?.cookiesPresent && bootstrapObservation.userMatchesFixture
    && bootstrapObservation.claimsVerified && bootstrapObservation.declaredAal1 && bootstrapObservation.originMatchesApp,
  'BOOTSTRAP_IDENTITY_OBSERVED_BEFORE_MFA');
  check(bootstrapObservation.statuses.loopback === 200 && bootstrapObservation.statuses.localhost === 403
    && bootstrapObservation.statuses.foreign === 403, 'EXACT_BROWSER_HOST_AND_CSRF_CHECKED');
  check(await page.getByAltText('Codigo QR para configurar Google Authenticator').count() === 0, 'VERIFIED_FACTOR_HAS_NO_NEW_QR');
  const aal1Cookies = await context.cookies();
  const aal1 = sessionClient(config, aal1Cookies);
  check((await aal1.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel === 'aal1', 'UI_PASSWORD_ONLY_IS_AAL1');
  const aal1Rows = await aal1.from('subscriptions').select('id');
  check(!aal1Rows.error && aal1Rows.data.length === 0, 'UI_AAL1_RLS_DENIES_ROWS');

  stage = 'mfa';
  await page.getByLabel('Codigo de Google Authenticator', { exact: true }).fill('000000');
  await page.getByRole('button', { name: 'Verificar e ingresar', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'El codigo no es valido' }).waitFor();
  check(page.url() === `${app}/admin/login`, 'WRONG_TOTP_DID_NOT_ENTER_PANEL');
  await page.getByLabel('Codigo de Google Authenticator', { exact: true }).fill(await nextCode(secret));
  await page.getByRole('button', { name: 'Verificar e ingresar', exact: true }).click();
  await page.waitForURL(`${app}/admin`);
  await page.getByRole('link', { name: 'Suscripciones', exact: true }).first().waitFor();
  check(true, 'REAL_UI_REACHED_PANEL');
  const authenticatedCookies = await context.cookies();
  const authenticated = sessionClient(config, authenticatedCookies);
  check((await authenticated.auth.getUser()).data.user?.id === userId, 'UI_COOKIE_IDENTITY_MATCHES_FIXTURE');
  check((await authenticated.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel === 'aal2', 'UI_COOKIE_IS_AAL2');
  const blockedSource = await authenticated.from('subscriptions').select('wompi_payment_source_id');
  check(!!blockedSource.error, 'UI_SESSION_CANNOT_READ_PAYMENT_SOURCES');
  check(await page.evaluate(() => localStorage.length === 0), 'REAL_PANEL_STORES_NO_LOCALSTORAGE_DATA');
  await page.reload();
  await page.getByRole('link', { name: 'Suscripciones', exact: true }).first().waitFor();
  check(page.url() === `${app}/admin`, 'PANEL_SURVIVES_RELOAD');
  await page.getByRole('link', { name: 'Suscripciones', exact: true }).first().click();
  await page.getByRole('table').waitFor();
  check(page.url() === `${app}/admin/suscripciones`, 'SUBSCRIPTIONS_TABLE_RENDERED');
  for (const viewport of [{ width: 320, height: 700 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'PANEL_NO_PAGE_HORIZONTAL_SCROLL');
  }

  if (mutations) {
    stage = 'amount-ui-open-detail';
    await page.getByRole('link', { name: `Ver detalle de ${donorName}`, exact: true }).click();
    stage = 'amount-ui-open-dialog';
    await page.getByRole('button', { name: 'Cambiar siguiente cobro', exact: true }).click();
    let dialog = page.getByRole('dialog');
    stage = 'amount-ui-edit';
    await dialog.getByLabel('Nuevo monto mensual').fill('1600');
    stage = 'amount-ui-close-unsaved';
    await dialog.getByRole('button', { name: 'Volver', exact: true }).click();
    let stored = (await database.query('select amount,billing_version from public.subscriptions where id=$1', [subscriptionId])).rows[0];
    check(stored.amount === 1500 && stored.billing_version === 0, 'LEAVING_AMOUNT_DIALOG_DOES_NOT_SAVE');
    await page.getByRole('button', { name: 'Cambiar siguiente cobro', exact: true }).click();
    dialog = page.getByRole('dialog');
    stage = 'amount-ui-confirm-inputs';
    await dialog.getByLabel('Nuevo monto mensual').fill('1600');
    await dialog.getByLabel('Motivo', { exact: true }).fill('Fictitious browser amount change');
    check(await dialog.getByLabel('Codigo actual de Google Authenticator', { exact: true }).count() === 0,
      'UNACCENTED_TOTP_SELECTOR_IS_NOT_THE_FIELD');
    check(await dialog.getByLabel('C\u00f3digo actual de Google Authenticator', { exact: true }).count() === 1,
      'EXACT_TOTP_FIELD_FOUND');
    await dialog.getByLabel('C\u00f3digo actual de Google Authenticator', { exact: true }).fill(await nextCode(secret));
    let responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/admin/subscriptions/${subscriptionId}`)
      && response.request().method() === 'PATCH');
    stage = 'amount-ui-save';
    await dialog.getByRole('button', { name: 'Confirmar cambio', exact: true }).click();
    check((await responsePromise).status() === 200, 'CONFIRMED_UI_AMOUNT_REACHES_REAL_API');
    await dialog.waitFor({ state: 'hidden' });
    stored = (await database.query('select amount,billing_version,next_payment_date from public.subscriptions where id=$1', [subscriptionId])).rows[0];
    check(stored.amount === 1600 && stored.billing_version === 1 && stored.next_payment_date.toISOString() === initialDate,
      'UI_AMOUNT_APPLIES_ONLY_TO_NEXT_CHARGE');

    stage = 'schedule-ui';
    const year = new Date().getUTCFullYear() + 1;
    await page.getByLabel('Mes del próximo cobro', { exact: true }).fill(`${year}-02`);
    await page.getByRole('group', { name: 'Día preferido de cobro', exact: true }).getByRole('button', { name: 'Día 6', exact: true }).click();
    stored = (await database.query('select next_payment_date from public.subscriptions where id=$1', [subscriptionId])).rows[0];
    check(stored.next_payment_date.toISOString() === initialDate, 'UNCONFIRMED_SCHEDULE_DOES_NOT_SAVE');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Motivo', { exact: true }).fill('Fictitious browser skip-month change');
    await dialog.getByLabel('C\u00f3digo actual de Google Authenticator', { exact: true }).fill(await nextCode(secret));
    responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/admin/subscriptions/${subscriptionId}`)
      && response.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: 'Confirmar cambio', exact: true }).click();
    check((await responsePromise).status() === 200, 'CONFIRMED_UI_SCHEDULE_REACHES_REAL_API');
    await dialog.waitFor({ state: 'hidden' });
    stored = (await database.query('select amount,billing_version,preferred_payment_day,next_payment_date from public.subscriptions where id=$1', [subscriptionId])).rows[0];
    check(stored.amount === 1600 && stored.billing_version === 2 && stored.preferred_payment_day === 6
      && stored.next_payment_date.toISOString() === new Date(Date.UTC(year, 1, 6, 12)).toISOString(), 'UI_SCHEDULE_STORES_COLOMBIA_DATE_IN_UTC');

    stage = 'cancel-ui';
    await page.getByRole('button', { name: 'Cancelar suscripción', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Motivo', { exact: true }).fill('Fictitious browser cancellation');
    await dialog.getByLabel('C\u00f3digo actual de Google Authenticator', { exact: true }).fill(await nextCode(secret));
    responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/admin/subscriptions/${subscriptionId}`)
      && response.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: 'Confirmar cambio', exact: true }).click();
    check((await responsePromise).status() === 200, 'CONFIRMED_UI_CANCELLATION_REACHES_REAL_API');
    await dialog.waitFor({ state: 'hidden' });
    stored = (await database.query('select status,billing_version,next_payment_date,cancelled_at from public.subscriptions where id=$1', [subscriptionId])).rows[0];
    check(stored.status === 'cancelled' && stored.billing_version === 3 && stored.next_payment_date === null
      && !!stored.cancelled_at, 'UI_CANCELLATION_STOPS_NEXT_CHARGES');
    const counts = (await database.query(`select (select count(*)::integer from public.admin_audit_logs where subscription_id=$1
      and actor_user_id=$2) as audit, (select count(*)::integer from public.payments where subscription_id=$1) as payments`,
    [subscriptionId, userId])).rows[0];
    check(counts.audit === 3 && counts.payments === 0, 'UI_CHANGES_AUDITED_WITHOUT_ANY_PAYMENT');
  }

  stage = 'logout';
  await page.getByRole('button', { name: /Cerrar sesi[oó]n/ }).first().click();
  await waitForLogin(page);
  check(await page.getByRole('table').count() === 0, 'LOGOUT_REMOVES_PRIVATE_TABLES');
  check((await context.cookies()).filter(({ name }) => name.startsWith('sb-') && name.includes('auth-token')).length === 0, 'LOGOUT_CLEARS_BROWSER_AUTH_COOKIES');
  const stale = sessionClient(config, authenticatedCookies);
  const staleRows = await stale.from('subscriptions').select('id');
  check(!staleRows.error && staleRows.data.length === 0, 'OLD_UI_JWT_REJECTED_BY_RLS');
  check(!!(await stale.auth.refreshSession()).error, 'OLD_UI_REFRESH_REJECTED');
  await page.goto(`${app}/admin`);
  await waitForLogin(page);
  check(true, 'LOGOUT_DIRECT_PAGE_REJECTED');

  stage = 'unlisted';
  const unlistedEmail = `hpe-ui-unlisted-${suffix}@example.test`;
  const unlisted = await service.auth.admin.createUser({ email: unlistedEmail, password, email_confirm: true });
  check(!unlisted.error, 'UNLISTED_FICTIONAL_ACCOUNT_CREATED');
  await page.getByLabel('Correo', { exact: true }).fill(unlistedEmail);
  await page.getByLabel('Contrasena', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Esta cuenta no esta autorizada' }).waitFor();
  check(await page.getByLabel('Codigo de Google Authenticator', { exact: true }).count() === 0, 'UNLISTED_UI_HAS_NO_MFA_OR_PANEL');
  check(page.url() === `${app}/admin/login`, 'UNLISTED_UI_REJECTED');
  await Promise.all(pendingBundles);
  check(unexpectedBrowserRequests === 0, 'BROWSER_REQUESTS_LOOPBACK_ONLY');
  check(privilegedBrowserRequests === 0 && privilegedBundleMatches === 0, 'PRIVATE_FIXTURE_KEY_NOT_EXPOSED_TO_BROWSER');

  stage = 'preservation';
  const after = await snapshot();
  let beforeCount = 0;
  let afterCount = 0;
  for (const [table, rows] of baseline) {
    check(after.has(table), 'ORIGINAL_TABLE_RETAINED');
    for (const [digest, count] of rows) {
      check((after.get(table).get(digest) ?? 0) >= count, 'ORIGINAL_ROW_CONTENT_RETAINED');
      beforeCount += count;
    }
  }
  for (const rows of after.values()) for (const count of rows.values()) afterCount += count;
  console.log(JSON.stringify({ operation: 'admin_ui_local_e2e', passed: true, checks,
    fixtureOnly: true, subscriptionMutations: mutations ? 3 : 0,
    observedTables: baseline.size, beforeRows: beforeCount, afterRows: afterCount,
    originalRowsPreserved: true, fixtureRecordsRetained: true, screenshots: 0, traces: 0,
    observedNonlocalBrowserRequests: unexpectedBrowserRequests, privilegedBrowserRequests,
    privilegedBundleMatches }));
} catch (error) {
  console.error(JSON.stringify({ operation: 'admin_ui_local_e2e', passed: false, stage, checks,
    assertion: /^[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : undefined,
    failure: error.name }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await database.end();
}
