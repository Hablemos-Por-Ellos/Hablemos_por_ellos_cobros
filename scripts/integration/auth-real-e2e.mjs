// ESCRITURA LOCAL: real GoTrue/PostgREST/Next, fictitious users, no provider requests.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import pg from 'pg';
import { labConfig } from './local-auth-lab.mjs';
import { prepareAdminTotp } from '../../src/lib/admin-mfa-enrollment.ts';

const app = 'http://localhost:3001';
let stage = 'guard';
let checks = 0;
let mutationDiagnostic;
const check = (value, name) => { assert.ok(value,name); checks += 1; };
function codeAt(secret, milliseconds = Date.now(), digits = 6) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const value of secret.toUpperCase().replace(/=+$/, '')) {
    const index = alphabet.indexOf(value);
    if (index < 0) throw new Error('INVALID_FIXTURE_TOTP_ENCODING');
    bits += index.toString(2).padStart(5,'0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset,offset + 8),2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(milliseconds / 30000)));
  const hash = createHmac('sha1',Buffer.from(bytes)).update(counter).digest();
  return String((hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 10 ** digits).padStart(digits,'0');
}
async function freshCode(secret) {
  // GoTrue rejects replay of the same TOTP step; wait only until the next real step.
  const delay = 30000 - Date.now() % 30000 + 1200;
  await new Promise((resolve) => setTimeout(resolve,delay));
  return codeAt(secret);
}
function sessionClient(config, jar = new Map()) {
  const sb = createServerClient(config.url,config.anonKey,{
    auth: { autoRefreshToken: false },
    cookies: { getAll: () => [...jar].map(([name,value]) => ({ name,value })),
      setAll: (values) => { for (const { name,value } of values) value ? jar.set(name,value) : jar.delete(name); } },
  });
  return { sb,jar };
}
async function appRequest(route, { jar = new Map(),method = 'GET',body,origin = app } = {}) {
  const response = await fetch(new URL(route,app),{ redirect: 'manual',method,
    headers: { cookie: [...jar].map(([name,value]) => `${name}=${value}`).join('; '),origin,
      ...(body ? { 'content-type': 'application/json' } : {}) },body: body ? JSON.stringify(body) : undefined });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0];
    const separator = pair.indexOf('=');
    const name = pair.slice(0,separator);
    const value = pair.slice(separator + 1);
    value ? jar.set(name,value) : jar.delete(name);
  }
  return response;
}
const client = new pg.Client({ host: '127.0.0.1',port: 54327,database: 'hpe_auth_lab',
  user: 'postgres',password: 'hpe-local-auth-fixture-only' });
try {
  check(codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',59000,8) === '94287082','RFC6238_VECTOR_59');
  check(codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',1234567890000,8) === '89005924','RFC6238_VECTOR_1234567890');
  const config = await labConfig();
  await client.connect();
  const { rows: [guard] } = await client.query(`select current_database() = 'hpe_auth_lab'
    and public.payment_admin_schema_ready()
    and exists(select 1 from information_schema.columns where table_schema = 'auth'
      and table_name = 'users' and column_name = 'encrypted_password') as safe`);
  check(guard.safe,'REAL_AUTH_LAB_REQUIRED');
  const service = createClient(config.url,config.serviceKey,{ auth: { persistSession: false,autoRefreshToken: false } });
  const anon = createClient(config.url,config.anonKey,{ auth: { persistSession: false,autoRefreshToken: false } });
  const suffix = randomUUID();
  const email = `hpe-admin-${suffix}@example.test`;
  const password = `Fictitious-${randomBytes(24).toString('base64url')}!`;
  stage = 'registration-disabled';
  const registration = await anon.auth.signUp({ email: `hpe-public-${suffix}@example.test`,password });
  check(!!registration.error,'PUBLIC_REGISTRATION_MUST_FAIL');
  const anonymousRead = await anon.from('donors').select('id');
  check(!!anonymousRead.error,'ANONYMOUS_DIRECT_DATA_MUST_FAIL');

  stage = 'invitation';
  const link = await service.auth.admin.generateLink({ type: 'invite',email,
    options: { redirectTo: `${app}/admin/auth/callback` } });
  check(!link.error && !!link.data.user?.id,'LOCAL_INVITE_GENERATION');
  const userId = link.data.user.id;
  const hash = link.data.properties.hashed_token;
  check(/^[a-f0-9]{56}$/.test(hash),'REAL_GOTRUE_SHA224_CONTRACT');
  const authorized = await service.from('admin_users').insert({ user_id: userId,role: 'admin',active: true });
  check(!authorized.error,'LOCAL_ALLOWLIST_INSERT');
  const invitation = await service.from('admin_invitations').insert({
    user_id: userId,recipient_email: email,token_hash_digest: createHash('sha256').update(hash).digest('hex'),
    issued_at: new Date(Date.now() - 1000).toISOString(),expires_at: new Date(Date.now() + 3500000).toISOString(),
  });
  check(!invitation.error,'LOCAL_INVITATION_RECORD');
  const jar = new Map();
  const activation = await appRequest(`/admin/auth/callback?type=invite&token_hash=${hash}`,{ jar });
  check(activation.status === 307 && activation.headers.get('location') === `${app}/admin/activar`,'INVITATION_CALLBACK_MUST_ACTIVATE');
  check(jar.size > 0,'INVITATION_MUST_SET_SSR_COOKIES');
  const reused = await appRequest(`/admin/auth/callback?type=invite&token_hash=${hash}`);
  check(reused.headers.get('location') === `${app}/admin/activar?error=invalid`,'INVITE_REUSE_MUST_FAIL');
  const passwordSetup = await appRequest('/api/admin/activation/password',{ jar,method: 'POST',body: { password } });
  check(passwordSetup.status === 200,'INVITED_ADMIN_DEFINES_PASSWORD');
  const noSession = await appRequest('/admin');
  check(noSession.status === 307 && noSession.headers.get('location')?.endsWith('/admin/login'),'PAGE_NO_SESSION_REJECTED');
  const invited = sessionClient(config,jar);
  const aal1 = await invited.sb.auth.mfa.getAuthenticatorAssuranceLevel();
  check(aal1.data?.currentLevel === 'aal1','INVITE_IS_ONLY_AAL1');
  const aal1Page = await appRequest('/admin',{ jar });
  check(aal1Page.status === 307,'AAL1_PAGE_REJECTED');
  const aal1Data = await invited.sb.from('donors').select('id');
  check(!aal1Data.error && aal1Data.data.length === 0,'AAL1_RLS_DENIES_ROWS');

  const donorId = randomUUID();
  const subscriptionId = randomUUID();
  await client.query("insert into public.donors(id,email,first_name,last_name) values($1,$2,'Fixture','Integration')",
    [donorId,`hpe-donor-${suffix}@example.test`]);
  const date = new Date(Date.UTC(new Date().getUTCFullYear() + 1,0,16,12)).toISOString();
  await client.query(`insert into public.subscriptions(id,donor_id,amount,currency,frequency,status,reference,
    preferred_payment_day,next_payment_date,wompi_payment_source_id) values($1,$2,1500,'COP','monthly','active',$3,16,$4,'fixture-source')`,
  [subscriptionId,donorId,`HPE-AUTH-${suffix}`,date]);
  const change = { action: 'amount',amount: 1600,reason: 'Fictitious Auth integration',totpCode: '000000',
    expectedVersion: 0,requestId: randomUUID() };
  check((await appRequest(`/api/admin/subscriptions/${subscriptionId}`,{ method: 'PATCH',body: change })).status === 401,'API_NO_SESSION_REJECTED');
  check((await appRequest(`/api/admin/subscriptions/${subscriptionId}`,{ jar,method: 'PATCH',body: change })).status === 401,'API_AAL1_REJECTED');

  stage = 'mfa';
  const interrupted = await invited.sb.auth.mfa.enroll({ factorType: 'totp',friendlyName: 'Hablemos por Ellos' });
  check(!interrupted.error,'INTERRUPTED_OWN_ENROLLMENT_EXISTS');
  const foreignPending = await invited.sb.auth.mfa.enroll({ factorType: 'totp',friendlyName: `other-fixture-${suffix}` });
  check(!foreignPending.error,'UNRELATED_PENDING_FACTOR_EXISTS');
  const firstResume = await prepareAdminTotp(invited.sb.auth.mfa);
  check(firstResume.stage === 'enroll' && !!firstResume.secret,'OWN_PENDING_ENROLLMENT_RECOVERED');
  const firstFactors = await invited.sb.auth.mfa.listFactors();
  check(!firstFactors.error && !firstFactors.data.all.some((factor) => factor.id === interrupted.data.id),'STALE_OWN_FACTOR_REMOVED');
  check(firstFactors.data.all.some((factor) => factor.id === foreignPending.data.id && factor.status === 'unverified'),'UNRELATED_PENDING_FACTOR_PRESERVED');
  const enrollment = await prepareAdminTotp(invited.sb.auth.mfa);
  check(enrollment.stage === 'enroll' && !!enrollment.secret,'SECOND_INTERRUPTION_RECOVERED');
  check(enrollment.factorId !== firstResume.factorId,'RETRY_REPLACES_ONLY_OWN_UNVERIFIED_FACTOR');
  const retryFactors = await invited.sb.auth.mfa.listFactors();
  check(!retryFactors.error && !retryFactors.data.all.some((factor) => factor.id === firstResume.factorId),'UUID_NAMED_PENDING_FACTOR_REMOVED');
  check(retryFactors.data.all.some((factor) => factor.id === foreignPending.data.id),'SECOND_RETRY_PRESERVES_UNRELATED_FACTOR');
  const secret = enrollment.secret;
  const factorId = enrollment.factorId;
  const challenge = await invited.sb.auth.mfa.challenge({ factorId });
  check(!challenge.error,'REAL_MFA_CHALLENGE');
  const verification = await invited.sb.auth.mfa.verify({ factorId,challengeId: challenge.data.id,code: codeAt(secret) });
  check(!verification.error,'REAL_MFA_VERIFY');
  const level = await invited.sb.auth.mfa.getAuthenticatorAssuranceLevel();
  const existingMfa = await prepareAdminTotp(invited.sb.auth.mfa);
  check(existingMfa.stage === 'verify' && existingMfa.factorId === factorId,'VERIFIED_FACTOR_REUSED_WITHOUT_REENROLLMENT');
  check(!('secret' in existingMfa) && !('qrCode' in existingMfa),'VERIFIED_FACTOR_HAS_NO_NEW_ENROLLMENT_SECRET');
  check(level.data?.currentLevel === 'aal2','REAL_AAL2_REQUIRED');
  stage = 'unlisted-user';
  const unlistedEmail = `hpe-unlisted-${suffix}@example.test`;
  const unlistedAccount = await service.auth.admin.createUser({ email: unlistedEmail,password,email_confirm: true });
  check(!unlistedAccount.error,'UNLISTED_FIXTURE_ACCOUNT_CREATED');
  const unlisted = sessionClient(config);
  check(!(await unlisted.sb.auth.signInWithPassword({ email: unlistedEmail,password })).error,'UNLISTED_FIRST_FACTOR');
  const unlistedFactor = await unlisted.sb.auth.mfa.enroll({ factorType: 'totp',friendlyName: 'unlisted-fixture' });
  check(!unlistedFactor.error,'UNLISTED_MFA_ENROLL');
  const unlistedVerified = await unlisted.sb.auth.mfa.challengeAndVerify({ factorId: unlistedFactor.data.id,
    code: codeAt(unlistedFactor.data.totp.secret) });
  check(!unlistedVerified.error,'UNLISTED_HAS_REAL_MFA');
  check((await appRequest('/admin',{ jar: unlisted.jar })).status === 307,'MFA_ALONE_DOES_NOT_AUTHORIZE_ADMIN');
  const unlistedData = await unlisted.sb.from('subscriptions').select('id');
  check(!unlistedData.error && unlistedData.data.length === 0,'UNLISTED_AAL2_RLS_REJECTED');
  check((await appRequest(`/api/admin/subscriptions/${subscriptionId}`,{ jar: unlisted.jar,method: 'PATCH',body: change })).status === 401,'UNLISTED_AAL2_API_REJECTED');
  stage = 'mfa';
  const page = await appRequest('/admin',{ jar });
  check(page.status === 200,'AAL2_PAGE_ALLOWED');
  const visible = await invited.sb.from('subscriptions').select('id,amount,status,next_payment_date').eq('id',subscriptionId);
  check(!visible.error && visible.data.length === 1,'REAL_AAL2_RLS_READ');
  const secretColumn = await invited.sb.from('subscriptions').select('wompi_payment_source_id').eq('id',subscriptionId);
  check(!!secretColumn.error,'PAYMENT_SOURCE_NOT_EXPOSED_TO_ADMIN_SESSION');
  const documentColumn = await invited.sb.from('donors').select('document_number').eq('id',donorId);
  check(!!documentColumn.error,'DOCUMENT_NOT_EXPOSED_TO_ADMIN_SESSION');
  const directChange = await invited.sb.from('subscriptions').update({ amount: 2000 }).eq('id',subscriptionId);
  check(!!directChange.error,'DIRECT_ADMIN_UPDATE_REJECTED');
  const forbiddenRpc = await invited.sb.rpc('admin_revoke_own_sessions',{ p_actor_user_id: userId,p_actor_session_issued_at: new Date().toISOString() });
  check(!!forbiddenRpc.error,'SERVICE_RPC_NOT_CALLABLE_FROM_BROWSER');
  const csrf = await appRequest(`/api/admin/subscriptions/${subscriptionId}`,{ jar,method: 'PATCH',body: change,origin: 'https://foreign.example.test' });
  check(csrf.status === 403,'CSRF_REJECTED');
  check((await appRequest(`/api/admin/subscriptions/${subscriptionId}`,{ jar,method: 'PATCH',body: change })).status === 403,'BAD_TOTP_REJECTED');
  stage = 'mutation';
  change.totpCode = await freshCode(secret);
  const updated = await appRequest(`/api/admin/subscriptions/${subscriptionId}`,{ jar,method: 'PATCH',body: change });
  if (updated.status !== 200) {
    const result = await updated.clone().json().catch(() => ({}));
    const categories = new Map([
      ['El codigo de Google Authenticator no es valido.', 'TOTP_REJECTED'],
      ['Origen no permitido.', 'ORIGIN_REJECTED'],
      ['La sesion administrativa no esta autorizada.', 'ADMIN_CONTEXT_REJECTED'],
      ['Esta operacion requiere una sesion administrativa real.', 'SESSION_REJECTED'],
      ['No se pudo aplicar el cambio solicitado.', 'RPC_REJECTED'],
      ['Operaciones financieras deshabilitadas.', 'OPERATIONS_DISABLED'],
    ]);
    mutationDiagnostic = { status: updated.status, category: categories.get(result.message) ?? 'OTHER_SANITIZED_API_ERROR' };
  }
  check(updated.status === 200,'VERIFIED_ADMIN_MUTATION_SUCCEEDS');
  const { rows: [stored] } = await client.query('select amount,billing_version,next_payment_date from public.subscriptions where id=$1',[subscriptionId]);
  check(stored.amount === 1600 && stored.billing_version === 1 && stored.next_payment_date.toISOString() === date,'NEXT_AMOUNT_ONLY_CHANGED');
  const { rows: [audit] } = await client.query('select count(*)::integer as count from public.admin_audit_logs where subscription_id=$1 and actor_user_id=$2',[subscriptionId,userId]);
  check(audit.count === 1,'ADMIN_CHANGE_AND_AUDIT_ATOMIC');
  const { rows: [payment] } = await client.query('select count(*)::integer as count from public.payments where subscription_id=$1',[subscriptionId]);
  check(payment.count === 0,'SAVING_NEVER_CREATES_PAYMENT');

  stage = 'schedule';
  const scheduledDate = new Date(Date.UTC(new Date().getUTCFullYear() + 1,1,6,12)).toISOString();
  const scheduleChange = { action: 'schedule',reason: 'Fictitious skip-month integration',expectedVersion: 1,
    preferredPaymentDay: 6,nextPaymentDate: scheduledDate,requestId: randomUUID(),totpCode: await freshCode(secret) };
  check((await appRequest(`/api/admin/subscriptions/${subscriptionId}`,{ jar,method: 'PATCH',body: scheduleChange })).status === 200,'REAL_SCHEDULE_MUTATION');
  const { rows: [schedule] } = await client.query('select amount,billing_version,preferred_payment_day,next_payment_date from public.subscriptions where id=$1',[subscriptionId]);
  check(schedule.amount === 1600 && schedule.billing_version === 2 && schedule.preferred_payment_day === 6
    && schedule.next_payment_date.toISOString() === scheduledDate,'SCHEDULE_PRESERVES_AMOUNT_AND_COLOMBIA_DATE');
  stage = 'cancel';
  const cancelChange = { action: 'cancel',reason: 'Fictitious cancellation integration',expectedVersion: 2,
    requestId: randomUUID(),totpCode: await freshCode(secret) };
  check((await appRequest(`/api/admin/subscriptions/${subscriptionId}`,{ jar,method: 'PATCH',body: cancelChange })).status === 200,'REAL_CANCELLATION_MUTATION');
  const { rows: [cancelled] } = await client.query('select status,billing_version,next_payment_date,cancelled_at from public.subscriptions where id=$1',[subscriptionId]);
  check(cancelled.status === 'cancelled' && cancelled.billing_version === 3
    && cancelled.next_payment_date === null && !!cancelled.cancelled_at,'CANCELLATION_STOPS_SCHEDULE_NOT_HISTORY');
  const { rows: [finalCounts] } = await client.query(`select
    (select count(*)::integer from public.admin_audit_logs where subscription_id=$1 and actor_user_id=$2) as audit,
    (select count(*)::integer from public.payments where subscription_id=$1) as payments`,[subscriptionId,userId]);
  check(finalCounts.audit === 3 && finalCounts.payments === 0,'ADMIN_ACTIONS_AUDITED_WITHOUT_CHARGES');

  stage = 'revocation';
  const oldJar = new Map(jar);
  await client.query('update public.admin_users set active=false where user_id=$1',[userId]);
  check((await appRequest('/admin',{ jar: new Map(oldJar) })).status === 307,'REVOKED_PAGE_REJECTED');
  const revokedDirect = await invited.sb.from('subscriptions').select('id').eq('id',subscriptionId);
  check(!revokedDirect.error && revokedDirect.data.length === 0,'REVOKED_RLS_REJECTED');
  check((await appRequest(`/api/admin/subscriptions/${subscriptionId}`,{ jar: new Map(oldJar),method: 'PATCH',body: change })).status === 401,'REVOKED_API_REJECTED');
  await client.query('update public.admin_users set active=true where user_id=$1',[userId]);
  stage = 'logout';
  const signedOut = await appRequest('/api/admin/logout',{ jar,method: 'POST',body: {} });
  check(signedOut.status === 200,'LOGOUT_DATABASE_AND_AUTH_CONFIRMED');
  check((await appRequest('/admin',{ jar: new Map(oldJar) })).status === 307,'OLD_JWT_REJECTED_AFTER_LOGOUT');
  const oldSession = sessionClient(config,new Map(oldJar));
  const oldDirect = await oldSession.sb.from('subscriptions').select('id').eq('id',subscriptionId);
  check(!oldDirect.error && oldDirect.data.length === 0,'OLD_JWT_DIRECT_RLS_REJECTED');
  check(!!(await oldSession.sb.auth.refreshSession()).error,'OLD_REFRESH_TOKEN_REJECTED_AFTER_LOGOUT');
  const passwordLogin = sessionClient(config);
  check(!(await passwordLogin.sb.auth.signInWithPassword({ email,password })).error,'ADMIN_CAN_USE_OWN_PASSWORD_NEXT_LOGIN');
  const nextLoginLevel = await passwordLogin.sb.auth.mfa.getAuthenticatorAssuranceLevel();
  check(nextLoginLevel.data?.currentLevel === 'aal1' && nextLoginLevel.data?.nextLevel === 'aal2','NEXT_LOGIN_REQUIRES_AUTHENTICATOR_AGAIN');
  console.log(JSON.stringify({ operation: 'real_auth_next_rls_e2e',checks,passed: true,local: true,
    realProviderCalls: 0,charges: 0,fixtureRecordsRetained: true }));
} catch (error) {
  console.error(JSON.stringify({ operation: 'real_auth_next_rls_e2e',passed: false,stage,checks,
    failure: error.name,assertion: /^[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : undefined,
    code: /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : undefined, mutationDiagnostic }));
  process.exitCode = 1;
} finally { await client.end(); }
