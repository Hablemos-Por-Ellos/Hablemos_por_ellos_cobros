-- v0.3.0 | 2026-10-03. After base_schema + migration, ONLY in the parent's disposable fixture.
-- All runtime test mutations roll back. No provider, real Auth, network or secrets.
begin;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('aal', nullif(current_setting('request.jwt.claim.aal', true), ''),
    'iat', nullif(current_setting('request.jwt.claim.iat', true), ''))
$$;

insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000001','admin@example.test');
insert into public.admin_users(user_id,role) values ('00000000-0000-0000-0000-000000000001','super_admin');
insert into public.donors(id,email,first_name,last_name)
values ('10000000-0000-0000-0000-000000000001','donor@example.test','Donante','Fixture');

create temporary table fixture_receipts(id uuid primary key, original_raw jsonb) on commit drop;
create function pg_temp.receipt(p_transaction text, p_status text) returns jsonb language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_raw jsonb;
begin
  v_raw := jsonb_build_object('receipt_version',1,'event','transaction.updated','environment','sandbox',
    'event_timestamp',1789844400,'transaction',jsonb_build_object('id',p_transaction,'status',upper(p_status)),
    'checksum','fixture-checksum','body_sha256','fixture-body-sha256','received_at','2026-09-19T15:00:00Z');
  insert into public.webhook_events(id,transaction_id,event_type,raw) values (v_id,null,null,v_raw);
  insert into pg_temp.fixture_receipts values (v_id,v_raw);
  return jsonb_build_object('receipt_id',v_id,'fixture',true);
end;
$$;

do $$
begin
  if not public.payment_admin_schema_ready() then raise exception 'Schema readiness marker missing'; end if;
  if (select provider_effective_at from public.payments where id = '70000000-0000-0000-0000-000000000090') is not null
    or not (select billing_review_required from public.payments where id = '70000000-0000-0000-0000-000000000090') then
    raise exception 'Historic approval fabricated a timestamp or was not blocked';
  end if;
  if not exists (select 1 from public.payments where id = '70000000-0000-0000-0000-000000000091'
    and subscription_id is null and amount is null and currency = 'COP' and status is null
    and wompi_transaction_id is null and created_at is null and updated_at is null) then
    raise exception 'Nullable legacy payment fields were changed';
  end if;
  if (select processing_state from public.webhook_events where id = '60000000-0000-0000-0000-000000000001') <> 'needs_review'
    or (select raw from public.webhook_events where id = '60000000-0000-0000-0000-000000000001') <>
      '{"transaction_id":"legacy-transaction","event_type":"transaction.updated"}'::jsonb then
    raise exception 'Ambiguous historic event was treated as applied or RAW changed';
  end if;
  if not exists (select 1 from public.webhook_events where id = '60000000-0000-0000-0000-000000000090'
    and transaction_id is null and event_type is null and processing_state = 'received' and record_kind = 'receipt'
    and event_key = 'receipt:60000000-0000-0000-0000-000000000090') then
    raise exception 'Cold-schema receipt was reinterpreted as a canonical event';
  end if;
  if has_table_privilege('service_role','public.payment_admin_migrations','INSERT')
    or has_table_privilege('service_role','public.payment_admin_migrations','UPDATE')
    or has_table_privilege('anon','public.payment_admin_migrations','SELECT')
    or has_function_privilege('authenticated','public.payment_admin_schema_ready()','EXECUTE')
    or has_column_privilege('service_role','public.webhook_events','raw','UPDATE')
    or has_column_privilege('authenticated','public.subscriptions','wompi_payment_source_id','SELECT') then
    raise exception 'Ledger, receipt or source permissions are unsafe';
  end if;
end $$;

-- Invitation bootstrap is AAL1-only in the service API; it never grants business privileges.
-- The same email on a different UUID is not authority to consume another user's invitation.
insert into auth.users(id,email) values
  ('00000000-0000-0000-0000-000000000002','admin@example.test'),
  ('00000000-0000-0000-0000-000000000003','admin@example.test');
insert into public.admin_users(user_id,role)
values ('00000000-0000-0000-0000-000000000002','admin');
insert into public.admin_invitations(token_hash_digest,user_id,recipient_email,issued_at,expires_at)
select encode(sha256(convert_to(v.name,'UTF8')),'hex'),v.user_id::uuid,v.email,
  now() + make_interval(secs => v.issued_offset),now() + make_interval(secs => v.expires_offset)
from (values
  ('fixture-invite-valid','00000000-0000-0000-0000-000000000001','ADMIN@example.test',-60,3540),
  ('fixture-invite-session-reuse','00000000-0000-0000-0000-000000000001','admin@example.test',-60,3540),
  ('fixture-invite-expired','00000000-0000-0000-0000-000000000001','admin@example.test',-3600,-60),
  ('fixture-invite-future','00000000-0000-0000-0000-000000000001','admin@example.test',300,3600),
  ('fixture-invite-recipient-mismatch','00000000-0000-0000-0000-000000000001','other@example.test',-60,3540),
  ('fixture-invite-not-allowlisted','00000000-0000-0000-0000-000000000003','admin@example.test',-60,3540)
) v(name,user_id,email,issued_offset,expires_offset);

do $$
declare
  v_digest text := encode(sha256(convert_to('fixture-invite-valid','UTF8')),'hex');
  v_admin uuid := '00000000-0000-0000-0000-000000000001';
  v_session uuid := '80000000-0000-0000-0000-000000000001';
begin
  if has_function_privilege('anon','public.admin_consume_invitation(text,uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.admin_consume_invitation(text,uuid,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.admin_consume_invitation(text,uuid,uuid)','EXECUTE')
    or has_any_column_privilege('anon','public.admin_invitations','SELECT')
    or has_any_column_privilege('authenticated','public.admin_invitations','SELECT')
    or has_any_column_privilege('service_role','public.admin_invitations','UPDATE')
    or has_column_privilege('service_role','public.admin_invitations','consumed_at','INSERT') then
    raise exception 'Invitation boundary grants unsafe access';
  end if;
  if public.admin_consume_invitation(v_digest,'00000000-0000-0000-0000-000000000002',v_session)
    or public.admin_consume_invitation(null,v_admin,v_session)
    or public.admin_consume_invitation('invalid-digest',v_admin,v_session)
    or public.admin_consume_invitation(v_digest,null,v_session)
    or public.admin_consume_invitation(v_digest,v_admin,null) then
    raise exception 'Invitation accepted wrong UUID/same email or invalid identity';
  end if;
  if public.admin_consume_invitation(encode(sha256(convert_to('fixture-invite-expired','UTF8')),'hex'),v_admin,v_session)
    or public.admin_consume_invitation(encode(sha256(convert_to('fixture-invite-future','UTF8')),'hex'),v_admin,v_session)
    or public.admin_consume_invitation(encode(sha256(convert_to('fixture-invite-recipient-mismatch','UTF8')),'hex'),v_admin,v_session)
    or public.admin_consume_invitation(encode(sha256(convert_to('fixture-invite-not-allowlisted','UTF8')),'hex'),
      '00000000-0000-0000-0000-000000000003',v_session) then
    raise exception 'Invitation accepted expiry, future issuance, wrong recipient or absent allowlist';
  end if;
  update public.admin_users set active = false where user_id = v_admin;
  if public.admin_consume_invitation(v_digest,v_admin,v_session) then
    raise exception 'Inactive administrator consumed an invitation';
  end if;
  update public.admin_users set active = true,sessions_valid_after = now() where user_id = v_admin;
  if public.admin_consume_invitation(v_digest,v_admin,v_session) then
    raise exception 'Revocation did not invalidate an older invitation';
  end if;
  update public.admin_users set sessions_valid_after = timestamptz '1970-01-01 00:00:00+00' where user_id = v_admin;
  update public.payment_admin_migrations set name = 'fixture-invitation-schema-disabled'
  where name = 'payment-admin-hardening-v0.3.0';
  if public.admin_consume_invitation(v_digest,v_admin,v_session) then
    raise exception 'Invitation consumption ignored the schema/version marker';
  end if;
  update public.payment_admin_migrations set name = 'payment-admin-hardening-v0.3.0'
  where name = 'fixture-invitation-schema-disabled';
  begin
    insert into public.admin_invitations(token_hash_digest,user_id,recipient_email,issued_at,expires_at)
    values (encode(sha256(convert_to('fixture-invite-over-hour','UTF8')),'hex'),v_admin,'admin@example.test',
      now(),now()+interval '1 hour 1 second');
    raise exception 'Invitation TTL allowed more than one hour';
  exception when check_violation then null; end;
  begin
    update public.admin_invitations set consumed_at = now() where token_hash_digest = v_digest;
    raise exception 'Partial consumed invitation/session state was accepted';
  exception when check_violation then null; end;
end $$;

set local role service_role;
do $$
declare
  v_digest text := encode(sha256(convert_to('fixture-invite-valid','UTF8')),'hex');
  v_admin uuid := '00000000-0000-0000-0000-000000000001';
  v_session uuid := '80000000-0000-0000-0000-000000000001';
begin
  if not public.admin_consume_invitation(v_digest,v_admin,v_session) then
    raise exception 'Valid <=1h invitation could not be consumed by service';
  end if;
  if public.admin_consume_invitation(v_digest,v_admin,v_session)
    or public.admin_consume_invitation(v_digest,v_admin,'80000000-0000-0000-0000-000000000002')
    or public.admin_consume_invitation(encode(sha256(convert_to('fixture-invite-session-reuse','UTF8')),'hex'),v_admin,v_session) then
    raise exception 'Invitation or consumed session admitted a second use';
  end if;
  if not exists (select 1 from public.admin_invitations where token_hash_digest = v_digest
    and user_id = v_admin and consumed_session_id = v_session
    and consumed_at >= issued_at and consumed_at < expires_at) then
    raise exception 'Invitation consumption did not atomically bind its own session';
  end if;
end $$;
reset role;

-- UUID + active role + AAL2 + issued strictly AFTER revocation, including same-second rejection.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select set_config('request.jwt.claim.iat','1789844401',true);
select set_config('request.jwt.claim.aal','aal1',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.donors) <> 0 then raise exception 'AAL1 could read data'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.aal','aal2',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.donors) <> 2 then raise exception 'AAL2 allowlisted read failed'; end if;
end $$;
reset role;
update public.admin_users set sessions_valid_after = to_timestamp(1789844401)
where user_id = '00000000-0000-0000-0000-000000000001';
set local role authenticated;
do $$ begin
  if (select count(*) from public.donors) <> 0 or (select count(*) from public.admin_users) <> 0 then
    raise exception 'Same-second revoked JWT could read';
  end if;
end $$;
reset role;
select set_config('request.jwt.claim.iat','1789844402',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.donors) <> 2 then raise exception 'Fresh JWT could not read'; end if;
end $$;
reset role;
update public.admin_users set active = false where user_id = '00000000-0000-0000-0000-000000000001';
set local role authenticated;
do $$ begin
  if (select count(*) from public.donors) <> 0 then raise exception 'Inactive admin could read'; end if;
end $$;
reset role;
update public.admin_users set active = true, sessions_valid_after = timestamptz '1970-01-01 00:00:00+00'
where user_id = '00000000-0000-0000-0000-000000000001';

insert into public.subscriptions(id,donor_id,amount,status,frequency,wompi_payment_source_id,reference,preferred_payment_day,next_payment_date)
values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
  10000,'active','monthly','source-fixture','HPE-VERSIONED',16,'2026-09-16T12:00:00Z');

do $$
declare v_result jsonb;
begin
  begin
    perform public.admin_update_subscription('20000000-0000-0000-0000-000000000001',0,'amount',
      'Cambio autorizado fixture',gen_random_uuid(),'00000000-0000-0000-0000-000000000001',20000);
    raise exception 'Mutation accepted absent server AAL2/TOTP context';
  exception when insufficient_privilege then null; end;
  begin
    perform public.admin_update_subscription('20000000-0000-0000-0000-000000000001',null,'amount',
      'Cambio autorizado fixture',gen_random_uuid(),'00000000-0000-0000-0000-000000000001',20000,null,null,false,
      'aal2',now()-interval '1 minute',now());
    raise exception 'Mutation accepted NULL expectedVersion';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.assert_admin_mutation_context('00000000-0000-0000-0000-000000000001','aal2',now()-interval '1 minute',now()-interval '10 minutes');
    raise exception 'Mutation accepted stale TOTP verification';
  exception when insufficient_privilege then null; end;
  v_result := public.admin_update_subscription('20000000-0000-0000-0000-000000000001',0,'amount',
    'Cambio autorizado fixture','30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
    20000,null,null,false,'aal2',now()-interval '1 minute',now());
  if (v_result ->> 'billing_version')::integer <> 1 or (v_result ->> 'amount')::integer <> 20000 then
    raise exception 'Versioned mutation did not persist';
  end if;
  begin
    perform public.admin_update_subscription('20000000-0000-0000-0000-000000000001',0,'amount',
      'Conflicto autorizado fixture',gen_random_uuid(),'00000000-0000-0000-0000-000000000001',
      21000,null,null,false,'aal2',now()-interval '1 minute',now());
    raise exception 'Mutation accepted a stale expectedVersion';
  exception when serialization_failure then null; end;
  if not exists (select 1 from public.admin_audit_logs where request_id = '30000000-0000-0000-0000-000000000001'
    and expected_version = 0 and actor_aal = 'aal2' and actor_session_issued_at is not null
    and totp_verified_at is not null and before_value ->> 'amount' = '10000' and after_value ->> 'amount' = '20000') then
    raise exception 'Mutation was not atomically audited with server context';
  end if;
end $$;

insert into public.payment_attempts(id,subscription_id,billing_period,reference,amount,subscription_version,state)
values ('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
  '202609','HPE-VERSIONED-202609',10000,0,'prepared');
set local role service_role;
do $$ declare v_claim jsonb; begin
  v_claim := public.claim_monthly_payment_attempt('50000000-0000-0000-0000-000000000001','2026-09-16T13:00:00Z');
  if v_claim ->> 'result' <> 'claimed' or v_claim ->> 'amount' <> '20000' or v_claim ->> 'billingVersion' <> '1'
    or not exists (select 1 from public.payment_attempts where id = '50000000-0000-0000-0000-000000000001'
      and state = 'dispatching' and subscription_version = 1 and amount = 20000) then
    raise exception 'Claim did not atomically snapshot amount/version';
  end if;
end $$;
reset role;

do $$
declare v_raw jsonb; v_result jsonb; v_duplicate jsonb;
begin
  v_raw := pg_temp.receipt('tx-versioned','approved');
  v_result := public.apply_verified_wompi_event('key-versioned','tx-versioned','transaction.updated','HPE-VERSIONED-202609',
    'source-fixture',20000,'COP','approved','2026-09-19T15:00:00Z','2026-10-16T12:00:00Z',v_raw);
  if v_result ->> 'result' <> 'processed'
    or (select next_payment_date from public.subscriptions where id = '20000000-0000-0000-0000-000000000001') <> '2026-10-16T12:00:00Z'::timestamptz
    or (select processing_state from public.webhook_events where id = (v_raw ->> 'receipt_id')::uuid) <> 'processed' then
    raise exception 'Versioned approval did not atomically apply/mark receipt';
  end if;
  v_raw := pg_temp.receipt('tx-versioned','approved');
  v_duplicate := public.apply_verified_wompi_event('key-versioned','tx-versioned','transaction.updated','HPE-VERSIONED-202609',
    'source-fixture',20000,'COP','approved','2026-09-19T15:00:00Z','2026-11-16T12:00:00Z',v_raw);
  if v_duplicate ->> 'result' <> 'duplicate'
    or (select processing_state from public.webhook_events where id = (v_raw ->> 'receipt_id')::uuid) <> 'processed'
    or (select next_payment_date from public.subscriptions where id = '20000000-0000-0000-0000-000000000001') <> '2026-10-16T12:00:00Z'::timestamptz then
    raise exception 'Early duplicate did not mark receipt or replay altered schedule';
  end if;
  v_raw := pg_temp.receipt('tx-versioned','pending');
  perform public.apply_verified_wompi_event('key-late-pending','tx-versioned','transaction.updated','HPE-VERSIONED-202609',
    'source-fixture',20000,'COP','pending','2026-09-20T15:00:00Z',null,v_raw);
  if (select status from public.payments where wompi_transaction_id = 'tx-versioned') <> 'approved'
    or (select state from public.payment_attempts where id = '50000000-0000-0000-0000-000000000001') <> 'approved' then
    raise exception 'Terminal approved status regressed';
  end if;
end $$;

-- NULL finalized/effective date: durable approved payment, blocked review, no fabricated approval or agenda.
insert into public.subscriptions(id,donor_id,amount,status,wompi_payment_source_id,reference,preferred_payment_day,next_payment_date)
values ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',
  15000,'active','source-null-date','HPE-NULL-DATE',6,'2026-09-06T12:00:00Z');
insert into public.payment_attempts(id,donor_id,subscription_id,reference,amount,subscription_version,state)
values ('50000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002','HPE-NULL-DATE-202609',15000,0,'unknown');
do $$ declare v_raw jsonb; v_result jsonb; begin
  v_raw := pg_temp.receipt('tx-null-date','approved');
  v_result := public.apply_verified_wompi_event('key-null-date','tx-null-date','transaction.updated','HPE-NULL-DATE-202609',
    'source-null-date',15000,'COP','approved',null,'2026-10-06T12:00:00Z',v_raw);
  if v_result ->> 'result' <> 'review' or not exists (select 1 from public.payments where wompi_transaction_id = 'tx-null-date'
    and status = 'approved' and approved_at is null and provider_effective_at is null and billing_review_required)
    or (select next_payment_date from public.subscriptions where id = '20000000-0000-0000-0000-000000000002') <> '2026-09-06T12:00:00Z'::timestamptz
    or (select processing_state from public.webhook_events where id = (v_raw ->> 'receipt_id')::uuid) <> 'needs_review' then
    raise exception 'Undated approval did not fail closed';
  end if;
  v_raw := pg_temp.receipt('tx-null-date','approved');
  perform public.apply_verified_wompi_event('key-null-date','tx-null-date','transaction.updated','HPE-NULL-DATE-202609',
    'source-null-date',15000,'COP','approved',null,null,v_raw);
  if (select processing_state from public.webhook_events where id = (v_raw ->> 'receipt_id')::uuid) <> 'needs_review' then
    raise exception 'Early review return did not mark receipt';
  end if;
end $$;
insert into public.payment_attempts(id,subscription_id,billing_period,reference,amount,state)
values ('50000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000002',
  '202610','HPE-NULL-DATE-202610',15000,'prepared');
do $$ declare v_claim jsonb; begin
  v_claim := public.claim_monthly_payment_attempt('50000000-0000-0000-0000-000000000003','2026-10-06T13:00:00Z');
  if v_claim ->> 'result' <> 'not_claimed' or v_claim ->> 'reason' <> 'PAYMENT_DATE_OR_RESULT_NEEDS_REVIEW' then
    raise exception 'Monthly claim ignored an undated historical approval';
  end if;
end $$;

-- Reconciliation compares the immutable actual 10000 payment, NOT today's 25000 subscription amount.
do $$ declare v_result jsonb; v_raw jsonb; begin
  v_raw := pg_temp.receipt('tx-historic-10000','approved');
  v_result := public.apply_verified_wompi_event('key-historical-amount','tx-historic-10000','transaction.updated','HPE-LEGACY',
    'fixture-legacy-source',10000,'COP','approved','2026-09-19T15:00:00Z','2026-10-16T12:00:00Z',v_raw);
  if not exists (select 1 from public.payments where wompi_transaction_id = 'tx-historic-10000'
    and amount = 10000 and status = 'approved' and provider_effective_at = '2026-09-19T15:00:00Z'::timestamptz)
    or (select amount from public.subscriptions where id = '20000000-0000-0000-0000-000000000090') <> 25000
    or (select next_payment_date from public.subscriptions where id = '20000000-0000-0000-0000-000000000090') <> '2026-10-16T12:00:00Z'::timestamptz
    or v_result ->> 'result' <> 'processed' then
    raise exception 'Historical amount reconciliation failed or unversioned replay altered agenda';
  end if;
  v_raw := pg_temp.receipt('tx-historic-10000','pending');
  perform public.apply_verified_wompi_event('key-historical-pending','tx-historic-10000','transaction.updated','HPE-LEGACY',
    'fixture-legacy-source',10000,'COP','pending','2026-09-20T15:00:00Z',null,v_raw);
  if (select status from public.payments where wompi_transaction_id = 'tx-historic-10000') <> 'approved' then
    raise exception 'Historic terminal payment regressed';
  end if;
  v_raw := pg_temp.receipt('tx-historic-10000','approved');
  v_result := public.apply_verified_wompi_event('key-historical-wrong-amount','tx-historic-10000','transaction.updated','HPE-LEGACY',
    'fixture-legacy-source',25000,'COP','approved','2026-09-20T15:00:00Z',null,v_raw);
  if v_result ->> 'result' <> 'review' or (select amount from public.payments where wompi_transaction_id = 'tx-historic-10000') <> 10000
    or (select processing_state from public.webhook_events where id = (v_raw ->> 'receipt_id')::uuid) <> 'needs_review' then
    raise exception 'Historical actual amount was overwritten by current amount';
  end if;
end $$;

-- Administrative cancellation is irreversible by webhook, including a versioned old attempt.
do $$ declare v_raw jsonb; begin
  perform public.admin_update_subscription('20000000-0000-0000-0000-000000000001',1,'cancel',
    'Cancelacion fixture autorizada','30000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001',
    null,null,null,false,'aal2',now()-interval '1 minute',now());
  v_raw := pg_temp.receipt('tx-versioned','approved');
  perform public.apply_verified_wompi_event('key-approved-after-cancel','tx-versioned','transaction.updated','HPE-VERSIONED-202609',
    'source-fixture',20000,'COP','approved','2026-09-21T15:00:00Z','2026-11-16T12:00:00Z',v_raw);
  if not exists (select 1 from public.subscriptions where id = '20000000-0000-0000-0000-000000000001'
    and status = 'cancelled' and next_payment_date is null and billing_version = 2 and cancelled_at is not null) then
    raise exception 'Late approval overrode administrative cancellation/version';
  end if;
end $$;

-- Applied legacy evidence maps to duplicate and still marks the incoming receipt.
insert into public.webhook_events(transaction_id,event_type,raw,processing_state,record_kind)
values ('tx-historic-10000','transaction.updated','{"applied_fixture":true}', 'needs_review','legacy');
update public.webhook_events set processing_state = 'legacy_applied'
where transaction_id = 'tx-historic-10000' and record_kind = 'legacy';
do $$ declare v_raw jsonb; v_result jsonb; begin
  v_raw := pg_temp.receipt('tx-historic-10000','approved');
  v_result := public.apply_verified_wompi_event('key-legacy-applied','tx-historic-10000','transaction.updated','HPE-LEGACY',
    'fixture-legacy-source',10000,'COP','approved','2026-09-19T15:00:00Z','2026-12-16T12:00:00Z',v_raw);
  if v_result ->> 'result' <> 'duplicate' or v_result ->> 'legacyApplied' <> 'true'
    or (select processing_state from public.webhook_events where id = (v_raw ->> 'receipt_id')::uuid) <> 'processed'
    or (select next_payment_date from public.subscriptions where id = '20000000-0000-0000-0000-000000000090') <> '2026-10-16T12:00:00Z'::timestamptz then
    raise exception 'Legacy applied mapping replayed the schedule or did not mark receipt';
  end if;
end $$;

-- Recovery and closure require expectedVersion, recent server TOTP, and audit context.
insert into public.subscriptions(id,donor_id,amount,status,wompi_payment_source_id,reference,preferred_payment_day,next_payment_date)
values ('20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001',
  18000,'active','source-recovery','HPE-RECOVERY',28,'2026-09-28T12:00:00Z');
insert into public.payment_attempts(id,donor_id,subscription_id,reference,amount,subscription_version,state)
values ('50000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000004','HPE-RECOVERY-202609',18000,0,'unknown');
do $$ declare v_result jsonb; begin
  begin
    perform public.admin_reconcile_payment_attempt('50000000-0000-0000-0000-000000000004',
      '00000000-0000-0000-0000-000000000001','Conciliacion fixture autorizada',gen_random_uuid(),
      'tx-admin-recovery','HPE-RECOVERY-202609','source-recovery',18000,'COP','approved',null,null,'{}',
      1,'aal2',now()-interval '1 minute',now());
    raise exception 'Recovery accepted stale version';
  exception when serialization_failure then null; end;
  v_result := public.admin_reconcile_payment_attempt('50000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001','Conciliacion fixture autorizada','30000000-0000-0000-0000-000000000003',
    'tx-admin-recovery','HPE-RECOVERY-202609','source-recovery',18000,'COP','approved',null,null,'{}',
    0,'aal2',now()-interval '1 minute',now());
  if v_result ->> 'result' <> 'review'
    or not exists (select 1 from public.admin_audit_logs where request_id = '30000000-0000-0000-0000-000000000003'
      and action = 'payment_recovery' and expected_version = 0 and actor_aal = 'aal2')
    or (select next_payment_date from public.subscriptions where id = '20000000-0000-0000-0000-000000000004') <> '2026-09-28T12:00:00Z'::timestamptz then
    raise exception 'Undated recovery was not reviewed/audited without schedule change';
  end if;
end $$;

insert into public.payment_attempts(id,donor_id,subscription_id,reference,amount,subscription_version,state,updated_at)
values ('50000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000004','HPE-RECOVERY-202610',18000,1,'dispatching',now()-interval '20 minutes');
do $$ declare v_result jsonb; begin
  begin
    perform public.admin_close_unidentified_payment_attempt('50000000-0000-0000-0000-000000000005',
      '00000000-0000-0000-0000-000000000001','Cierre fixture autorizado',gen_random_uuid(),true,
      0,'aal2',now()-interval '1 minute',now());
    raise exception 'Closure accepted stale version';
  exception when serialization_failure then null; end;
  v_result := public.admin_close_unidentified_payment_attempt('50000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000001','Cierre fixture autorizado','30000000-0000-0000-0000-000000000004',true,
    1,'aal2',now()-interval '1 minute',now());
  if v_result ->> 'result' <> 'closed' or v_result ->> 'billingVersion' <> '2'
    or not exists (select 1 from public.admin_audit_logs where request_id = '30000000-0000-0000-0000-000000000004'
      and expected_version = 1 and actor_aal = 'aal2' and action = 'payment_recovery_closed') then
    raise exception 'Versioned closure was not atomically audited';
  end if;
end $$;

-- First-party WebCheckout keeps retry history without regressing its terminal transaction.
insert into public.subscriptions(id,donor_id,amount,status,frequency,reference)
values ('20000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001',19000,'pending','one_time','HPE-ONE-TIME');
insert into public.payment_attempts(id,donor_id,subscription_id,reference,amount,subscription_version,state)
values ('50000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000006','HPE-ONE-TIME',19000,0,'prepared');
do $$ declare v_result jsonb; begin
  perform public.apply_verified_wompi_event('key-one-pending','tx-one','transaction.updated','HPE-ONE-TIME',
    null,19000,'COP','pending','2026-09-19T15:00:00Z',null,'{}');
  perform public.apply_verified_wompi_event('key-one-declined','tx-one','transaction.updated','HPE-ONE-TIME',
    null,19000,'COP','declined','2026-09-19T15:01:00Z',null,'{}');
  v_result := public.apply_verified_wompi_event('key-one-retry','tx-one-retry','transaction.updated','HPE-ONE-TIME',
    null,19000,'COP','approved','2026-09-19T15:02:00Z',null,'{}');
  if v_result ->> 'result' <> 'processed'
    or (select count(*) from public.payments where reference = 'HPE-ONE-TIME') <> 2
    or not exists (select 1 from public.subscriptions where id = '20000000-0000-0000-0000-000000000006'
      and status = 'active' and next_payment_date is null) then
    raise exception 'One-time retry history/state regressed';
  end if;
end $$;

-- RAW, normalized columns and original received_at evidence remain immutable across ALL outcomes.
do $$ begin
  if exists (select 1 from pg_temp.fixture_receipts f join public.webhook_events e on e.id = f.id
    where f.original_raw <> e.raw or e.transaction_id is not null or e.event_type is not null or e.processed_at is null) then
    raise exception 'Receipt evidence changed or atomic marking was missed';
  end if;
  begin
    update public.webhook_events set raw = '{"tampered":true}' where id = '60000000-0000-0000-0000-000000000001';
    raise exception 'Evidence trigger allowed historical RAW modification';
  exception when invalid_parameter_value then null; end;
end $$;
rollback;
