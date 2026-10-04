-- v0.3.0 | 2026-10-03. Parent-only Postgres engine regression after base_schema + migration.
-- Independent of hardening_smoke.sql; every fixture/write rolls back, no real Auth/provider.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
do $$ begin
  if current_database() <> 'hpe_lab' or not public.payment_admin_schema_ready()
    or not exists (select 1 from public.donors where id = '10000000-0000-0000-0000-000000000090'
      and email = 'legacy@example.test') then raise exception 'DISPOSABLE_FIXTURE_REQUIRED'; end if;
end $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('aal',current_setting('request.jwt.claim.aal',true),
    'iat',current_setting('request.jwt.claim.iat',true))
$$;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000010','recovery-admin@example.test');
insert into public.admin_users(user_id,role) values ('00000000-0000-0000-0000-000000000010','super_admin');
insert into public.donors(id,email,first_name,last_name)
select ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
  'recovery-' || n || '@example.test','Recovery','Fixture' from generate_series(10,16) n;
insert into public.subscriptions(id,donor_id,amount,status,reference,wompi_payment_source_id,preferred_payment_day)
select ('20000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
  ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,10000,case when n = 13 then 'active' else 'pending' end,
  'HPE-REC-' || n,'source-rec-' || n,16 from generate_series(10,16) n;
insert into public.payment_attempts(id,subscription_id,donor_id,reference,amount,subscription_version,state,wompi_transaction_id)
select ('50000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
  ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
  'HPE-REC-' || n || '-202609',10000,0,case when n = 13 then 'failed' when n = 16 then 'approved' else 'unknown' end,
  case when n in (12,16) then 'tx-rec-' || n else null end from generate_series(10,16) n;

create temporary table recovery_receipts(id uuid primary key,raw jsonb) on commit drop;
create function pg_temp.recovery_receipt(p_tx text,p_status text) returns jsonb language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_raw jsonb;
begin
  v_raw := jsonb_build_object('receipt_version',1,'event','transaction.updated','environment','sandbox',
    'event_timestamp',1789844400,'transaction',jsonb_build_object('id',p_tx,'status',upper(p_status)),
    'checksum','fixture','body_sha256','fixture','received_at','2026-09-19T15:00:00Z');
  insert into public.webhook_events(id,transaction_id,event_type,raw) values(v_id,null,null,v_raw);
  insert into pg_temp.recovery_receipts values(v_id,v_raw);
  return jsonb_build_object('receipt_id',v_id);
end $$;
create function pg_temp.recover(p_number integer,p_status text,p_expected integer,p_request uuid default gen_random_uuid(),
  p_effective timestamptz default '2026-09-19T15:00:00Z',p_source text default null) returns jsonb language sql as $$
  select public.admin_reconcile_payment_attempt(
    ('50000000-0000-0000-0000-' || lpad(p_number::text,12,'0'))::uuid,
    '00000000-0000-0000-0000-000000000010','Recuperacion verificada fixture',p_request,
    'tx-rec-' || p_number,'HPE-REC-' || p_number || '-202609',coalesce(p_source,'source-rec-' || p_number),
    10000,'COP',p_status,p_effective,null,pg_temp.recovery_receipt('tx-rec-' || p_number,p_status),
    p_expected,'aal2',now()-interval '1 minute',clock_timestamp())
$$;

-- Explicit PENDING recovery owns its new version, then a normal webhook can activate.
do $$ declare v_result jsonb; begin
  v_result := pg_temp.recover(10,'pending',0,'30000000-0000-0000-0000-000000000010');
  if v_result ->> 'result' <> 'recovered'
    or not exists(select 1 from public.subscriptions where id = '20000000-0000-0000-0000-000000000010' and billing_version = 1)
    or not exists(select 1 from public.payment_attempts where id = '50000000-0000-0000-0000-000000000010'
      and state = 'pending' and subscription_version = 1) then raise exception 'PENDING_RECOVERY_SNAPSHOT_NOT_ALIGNED'; end if;
  v_result := public.apply_verified_wompi_event('rec-10-approved','tx-rec-10','transaction.updated',
    'HPE-REC-10-202609','source-rec-10',10000,'COP','approved','2026-09-19T15:01:00Z',null,
    pg_temp.recovery_receipt('tx-rec-10','approved'));
  if v_result ->> 'result' <> 'processed' or not exists(select 1 from public.subscriptions
    where id = '20000000-0000-0000-0000-000000000010' and status = 'active' and billing_version = 1
      and next_payment_date = '2026-10-16T12:00:00Z') then raise exception 'APPROVAL_AFTER_PENDING_RECOVERY_NOT_ACTIVE'; end if;
  -- Retry of the same request is read-only even after the callback changed provider status.
  v_result := pg_temp.recover(10,'pending',0,'30000000-0000-0000-0000-000000000010');
  if v_result ->> 'result' <> 'duplicate'
    or (select state from public.payment_attempts where id = '50000000-0000-0000-0000-000000000010') <> 'approved'
    or (select billing_version from public.subscriptions where id = '20000000-0000-0000-0000-000000000010') <> 1
    or (select count(*) from public.admin_audit_logs where request_id = '30000000-0000-0000-0000-000000000010') <> 1 then
    raise exception 'EXACT_RECOVERY_RETRY_REPLAYED_OR_BUMPED_VERSION'; end if;
  begin
    perform pg_temp.recover(10,'approved',0,'30000000-0000-0000-0000-000000000010');
    raise exception 'REQUEST_ID_ACCEPTED_DIFFERENT_VERIFIED_STATUS';
  exception when invalid_parameter_value then null; end;
  -- Actual historical payment amount remains authoritative, not a newer reserved/current amount.
  update public.payment_attempts set amount = 20000 where id = '50000000-0000-0000-0000-000000000010';
  update public.subscriptions set amount = 20000 where id = '20000000-0000-0000-0000-000000000010';
  v_result := pg_temp.recover(10,'approved',1,gen_random_uuid(),'2026-09-19T15:01:00Z');
  if v_result ->> 'result' <> 'duplicate' or not exists(select 1 from public.payments
    where wompi_transaction_id = 'tx-rec-10' and amount = 10000)
    or (select billing_version from public.subscriptions where id = '20000000-0000-0000-0000-000000000010') <> 1 then
    raise exception 'RECOVERY_COMPARED_CURRENT_AMOUNT_NOT_ACTUAL_HISTORICAL_PAYMENT'; end if;
end $$;

-- Known-ID PENDING must apply the GET-verified APPROVED, not return the old duplicate.
do $$ declare v_result jsonb; begin
  perform pg_temp.recover(11,'pending',0);
  v_result := pg_temp.recover(11,'approved',1,'30000000-0000-0000-0000-000000000011','2026-09-19T15:01:00Z');
  if v_result ->> 'result' <> 'recovered'
    or not exists(select 1 from public.subscriptions where id = '20000000-0000-0000-0000-000000000011'
      and status = 'active' and billing_version = 2 and next_payment_date = '2026-10-16T12:00:00Z')
    or not exists(select 1 from public.payment_attempts where id = '50000000-0000-0000-0000-000000000011'
      and state = 'approved' and subscription_version = 1) then raise exception 'KNOWN_PENDING_ID_APPROVAL_WAS_IGNORED'; end if;
  begin
    perform pg_temp.recover(11,'approved',1);
    raise exception 'KNOWN_ID_BYPASSED_EXPECTED_VERSION';
  exception when serialization_failure then null; end;
  begin
    perform public.admin_reconcile_payment_attempt('50000000-0000-0000-0000-000000000011',
      '00000000-0000-0000-0000-000000000010','Recuperacion verificada fixture',gen_random_uuid(),
      'tx-replacement','HPE-REC-11-202609','source-rec-11',10000,'COP','approved',now(),null,'{}',
      2,'aal2',now()-interval '1 minute',clock_timestamp());
    raise exception 'KNOWN_TRANSACTION_ID_WAS_REPLACED';
  exception when invalid_parameter_value then null; end;
  v_result := pg_temp.recover(11,'pending',2,gen_random_uuid(),'2026-09-19T15:02:00Z');
  if v_result ->> 'result' <> 'review' or v_result ->> 'reason' <> 'PAYMENT_RECOVERY_STATUS_NOT_APPLIED'
    or (select billing_version from public.subscriptions where id = '20000000-0000-0000-0000-000000000011') <> 2
    or not exists(select 1 from public.payments where wompi_transaction_id = 'tx-rec-11' and status = 'approved') then
    raise exception 'APPROVED_REGRESSED_ON_PENDING_RECOVERY'; end if;
end $$;

-- UNKNOWN with the SAME already-known ID is a permitted recovery.
do $$ declare v_result jsonb; begin
  v_result := pg_temp.recover(12,'approved',0);
  if v_result ->> 'result' <> 'recovered' or not exists(select 1 from public.payment_attempts
    where id = '50000000-0000-0000-0000-000000000012' and state = 'approved' and wompi_transaction_id = 'tx-rec-12') then
    raise exception 'UNKNOWN_SAME_KNOWN_ID_RECOVERY_REJECTED'; end if;
end $$;

-- A later admin schedule decision cannot be rebased by repeated PENDING recovery.
do $$ declare v_result jsonb; begin
  perform public.admin_update_subscription('20000000-0000-0000-0000-000000000013',0,'schedule',
    'Fecha administrada fixture',gen_random_uuid(),'00000000-0000-0000-0000-000000000010',null,16,
    '2026-12-16T12:00:00Z',false,'aal2',now()-interval '1 minute',clock_timestamp());
  perform public.apply_verified_wompi_event('rec-13-pending','tx-rec-13','transaction.updated','HPE-REC-13-202609',
    'source-rec-13',10000,'COP','pending','2026-09-19T15:00:00Z',null,'{}');
  v_result := pg_temp.recover(13,'pending',1,gen_random_uuid(),'2026-09-19T15:01:00Z');
  if v_result ->> 'result' <> 'review' or v_result ->> 'reason' <> 'PAYMENT_RECOVERY_ADMIN_VERSION_PROTECTED'
    or (select subscription_version from public.payment_attempts where id = '50000000-0000-0000-0000-000000000013') <> 0
    or (select next_payment_date from public.subscriptions where id = '20000000-0000-0000-0000-000000000013') <> '2026-12-16T12:00:00Z' then
    raise exception 'PENDING_RECOVERY_REBASED_LATER_ADMIN_VERSION'; end if;
  perform public.apply_verified_wompi_event('rec-13-approved','tx-rec-13','transaction.updated','HPE-REC-13-202609',
    'source-rec-13',10000,'COP','approved','2026-09-19T15:02:00Z',null,'{}');
  if (select next_payment_date from public.subscriptions where id = '20000000-0000-0000-0000-000000000013') <> '2026-12-16T12:00:00Z' then
    raise exception 'LATE_APPROVAL_OVERWROTE_LATER_ADMIN_SCHEDULE'; end if;
  perform public.admin_update_subscription('20000000-0000-0000-0000-000000000013',2,'cancel',
    'Cancelacion posterior fixture',gen_random_uuid(),'00000000-0000-0000-0000-000000000010',
    null,null,null,false,'aal2',now()-interval '1 minute',clock_timestamp());
  v_result := pg_temp.recover(13,'approved',3,gen_random_uuid(),'2026-09-19T15:03:00Z');
  perform public.apply_verified_wompi_event('rec-13-after-cancel','tx-rec-13','transaction.updated','HPE-REC-13-202609',
    'source-rec-13',10000,'COP','approved','2026-09-19T15:04:00Z',null,'{}');
  if v_result ->> 'result' <> 'review' or not exists(select 1 from public.subscriptions
    where id = '20000000-0000-0000-0000-000000000013' and status = 'cancelled'
      and next_payment_date is null and cancelled_at is not null)
    or (select subscription_version from public.payment_attempts where id = '50000000-0000-0000-0000-000000000013') <> 0 then
    raise exception 'RECOVERY_OR_LATE_WEBHOOK_REACTIVATED_CANCELLED_SUBSCRIPTION'; end if;
end $$;

-- Canonical review must stay durable/audited even when the attempt remains UNKNOWN.
do $$ declare v_result jsonb; begin
  v_result := pg_temp.recover(14,'approved',0,'30000000-0000-0000-0000-000000000014',null,'wrong-fixture-source');
  if v_result ->> 'result' <> 'review' or v_result ->> 'state' <> 'unknown'
    or not exists(select 1 from public.admin_audit_logs where request_id = '30000000-0000-0000-0000-000000000014'
      and after_value -> 'response' ->> 'result' = 'review' and expected_version = 0 and actor_aal = 'aal2')
    or (select billing_version from public.subscriptions where id = '20000000-0000-0000-0000-000000000014') <> 0 then
    raise exception 'CANONICAL_REVIEW_ROLLED_BACK_OR_WAS_NOT_AUDITED'; end if;
end $$;

-- A later undated APPROVED is durable and blocked, never a fabricated approval/agenda.
do $$ declare v_result jsonb; begin
  perform pg_temp.recover(15,'pending',0);
  v_result := pg_temp.recover(15,'approved',1,gen_random_uuid(),null);
  if v_result ->> 'result' <> 'review' or not exists(select 1 from public.payments where wompi_transaction_id = 'tx-rec-15'
    and status = 'approved' and approved_at is null and provider_effective_at is null and billing_review_required)
    or (select next_payment_date from public.subscriptions where id = '20000000-0000-0000-0000-000000000015') is not null then
    raise exception 'NULL_FINALIZED_RECOVERY_FABRICATED_APPROVAL_OR_AGENDA'; end if;
end $$;

-- Terminal attempt evidence is preserved even if no historical payment row exists.
do $$ declare v_result jsonb; begin
  v_result := pg_temp.recover(16,'pending',0);
  if v_result ->> 'result' <> 'review' or v_result ->> 'reason' <> 'PAYMENT_RECOVERY_STATUS_NOT_APPLIED'
    or (select state from public.payment_attempts where id = '50000000-0000-0000-0000-000000000016') <> 'approved'
    or exists(select 1 from public.payments where wompi_transaction_id = 'tx-rec-16')
    or (select billing_version from public.subscriptions where id = '20000000-0000-0000-0000-000000000016') <> 0 then
    raise exception 'TERMINAL_ATTEMPT_WITHOUT_PAYMENT_REGRESSED'; end if;
end $$;

-- Revocation goes LAST: service bootstrap permits AAL1/AAL2 logout, never client execution.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000010',true);
select set_config('request.jwt.claim.aal','aal2',true);
select set_config('request.jwt.claim.iat',floor(extract(epoch from now()-interval '1 minute'))::text,true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.donors) = 0 then raise exception 'UNREVOKED_ADMIN_CANNOT_READ'; end if;
  begin
    perform public.admin_revoke_own_sessions('00000000-0000-0000-0000-000000000010',now()-interval '1 minute');
    raise exception 'CLIENT_COULD_EXECUTE_LOGOUT_RPC';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$ declare v_started timestamptz := clock_timestamp(); begin
  if public.admin_revoke_own_sessions('00000000-0000-0000-0000-000000000099',now()-interval '1 minute')
    or public.admin_revoke_own_sessions('00000000-0000-0000-0000-000000000010',null)
    or public.admin_revoke_own_sessions('00000000-0000-0000-0000-000000000010','infinity')
    or public.admin_revoke_own_sessions('00000000-0000-0000-0000-000000000010',clock_timestamp()+interval '1 minute') then
    raise exception 'LOGOUT_ACCEPTED_INVALID_SERVER_IDENTITY'; end if;
  if not public.admin_revoke_own_sessions('00000000-0000-0000-0000-000000000010',now()-interval '1 minute') then
    raise exception 'SERVICE_LOGOUT_REVOCATION_FAILED'; end if;
  if (select sessions_valid_after from public.admin_users where user_id = '00000000-0000-0000-0000-000000000010') < v_started
    or not exists(select 1 from public.admin_audit_logs where actor_user_id = '00000000-0000-0000-0000-000000000010'
      and action = 'own_sessions_revoked' and actor_session_issued_at is not null) then
    raise exception 'LOGOUT_DID_NOT_USE_WALL_CLOCK_OR_AUDIT'; end if;
  if public.admin_revoke_own_sessions('00000000-0000-0000-0000-000000000010',now()-interval '1 minute')
    or public.admin_revoke_own_sessions('00000000-0000-0000-0000-000000000010',
      (select date_trunc('second',sessions_valid_after) from public.admin_users where user_id = '00000000-0000-0000-0000-000000000010')) then
    raise exception 'LOGOUT_ACCEPTED_OLDER_OR_SAME_SECOND_SESSION'; end if;
  begin
    perform public.admin_update_subscription('20000000-0000-0000-0000-000000000014',0,'amount',
      'Mutacion posterior al logout',gen_random_uuid(),'00000000-0000-0000-0000-000000000010',
      12000,null,null,false,'aal2',now()-interval '1 minute',clock_timestamp());
    raise exception 'REVOKED_SESSION_COULD_MUTATE';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  if (select count(*) from public.donors) <> 0 or (select count(*) from public.subscriptions) <> 0
    or (select count(*) from public.admin_users) <> 0 then raise exception 'REVOKED_TOKEN_RETAINED_RLS_DATA_ACCESS'; end if;
end $$;
reset role;
do $$ begin
  if exists(select 1 from pg_temp.recovery_receipts f join public.webhook_events e using(id)
    where f.raw <> e.raw or e.transaction_id is not null or e.event_type is not null or e.processed_at is null) then
    raise exception 'RECOVERY_RECEIPT_MUTATED_OR_NOT_MARKED'; end if;
  if exists(select 1 from public.admin_audit_logs where action = 'payment_recovery' and
    (expected_version is null or actor_aal <> 'aal2' or actor_session_issued_at is null or totp_verified_at is null
      or after_value ->> 'request_digest' !~ '^[0-9a-f]{64}$')) then raise exception 'RECOVERY_SERVER_CONTEXT_AUDIT_MISSING'; end if;
end $$;
rollback;
