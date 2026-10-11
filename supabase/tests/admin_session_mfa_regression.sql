-- v0.4.2. Fictional isolated lab only; every fixture operation is rolled back.
begin;
do $tests$
declare
  actor uuid := 'a4200000-0000-0000-0000-000000000001';
  subscription uuid := 'a4200000-0000-0000-0000-000000000003';
  issued timestamptz := clock_timestamp() - interval '1 hour';
  result jsonb; replay jsonb; rejected boolean;
  pending_date timestamptz;
  payment_count bigint; attempt_count bigint; cycle_count bigint;
begin
  perform public.assert_admin_mutation_context(actor,'aal2',issued,null);
  perform public.assert_admin_mutation_context(actor,'aal2',issued,issued - interval '1 day');

  foreach result in array array[
    jsonb_build_object('user',actor,'aal','aal1','iat',issued),
    jsonb_build_object('user',actor,'aal',null,'iat',issued),
    jsonb_build_object('user',null,'aal','aal2','iat',issued),
    jsonb_build_object('user','a4200000-0000-0000-0000-000000000099','aal','aal2','iat',issued),
    jsonb_build_object('user',actor,'aal','aal2','iat',null),
    jsonb_build_object('user',actor,'aal','aal2','iat','infinity'),
    jsonb_build_object('user',actor,'aal','aal2','iat',clock_timestamp() + interval '1 hour')
  ] loop
    rejected := false;
    begin
      perform public.assert_admin_mutation_context((result->>'user')::uuid,result->>'aal',
        (result->>'iat')::timestamptz,null);
    exception when insufficient_privilege then rejected := true;
    end;
    if not rejected then raise exception 'INVALID_SESSION_ACCEPTED'; end if;
  end loop;

  rejected := false;
  begin
    perform public.assert_admin_mutation_context(actor,'aal2',issued,clock_timestamp()+interval '1 hour');
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'FUTURE_TOTP_METADATA_ACCEPTED'; end if;

  update public.admin_users set active=false where user_id=actor;
  rejected := false;
  begin perform public.assert_admin_mutation_context(actor,'aal2',issued,null);
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'INACTIVE_ADMIN_ACCEPTED'; end if;
  update public.admin_users set active=true,sessions_valid_after=issued where user_id=actor;
  rejected := false;
  begin perform public.assert_admin_mutation_context(actor,'aal2',issued,null);
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'REVOKED_SESSION_ACCEPTED'; end if;
  update public.admin_users set sessions_valid_after='1970-01-01T00:00:00Z' where user_id=actor;

  if has_function_privilege('anon',
    'public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz)','EXECUTE')
    or has_function_privilege('authenticated',
    'public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz)','EXECUTE') then
    raise exception 'PUBLIC_FUNCTION_EXECUTION_ALLOWED';
  end if;

  select count(*) into payment_count from public.payments;
  select count(*) into attempt_count from public.payment_attempts;
  select count(*) into cycle_count from public.billing_cycles;
  result := public.billing_v2_admin_update_subscription(
    p_subscription_id=>subscription,p_expected_version=>0,p_action=>'amount',
    p_reason=>'Fictional local amount confirmation',p_request_id=>'a4200000-0000-0000-0000-000000000010',
    p_actor_user_id=>actor,p_amount=>26000,p_actor_aal=>'aal2',
    p_actor_session_issued_at=>issued,p_totp_verified_at=>null);
  replay := public.billing_v2_admin_update_subscription(
    p_subscription_id=>subscription,p_expected_version=>0,p_action=>'amount',
    p_reason=>'Fictional local amount confirmation',p_request_id=>'a4200000-0000-0000-0000-000000000010',
    p_actor_user_id=>actor,p_amount=>26000,p_actor_aal=>'aal2',
    p_actor_session_issued_at=>issued,p_totp_verified_at=>null);
  if result is distinct from replay or result->>'billing_version' <> '1'
    or (select count(*) from public.admin_audit_logs where actor_user_id=actor) <> 1 then
    raise exception 'ATOMIC_AUDIT_OR_REPLAY_CHANGED';
  end if;
  if not exists(select 1 from public.admin_audit_logs where actor_user_id=actor
    and totp_verified_at is null and actor_aal='aal2' and actor_session_issued_at=issued) then
    raise exception 'LOGIN_MFA_AUDIT_NOT_TRUTHFUL';
  end if;

  pending_date := (date_trunc('month',clock_timestamp() at time zone 'America/Bogota')
    + interval '1 month 15 days 7 hours') at time zone 'America/Bogota';
  result := public.billing_v2_admin_update_subscription(
    p_subscription_id=>subscription,p_expected_version=>1,p_action=>'schedule',
    p_reason=>'Fictional local schedule confirmation',p_request_id=>'a4200000-0000-0000-0000-000000000011',
    p_actor_user_id=>actor,p_preferred_payment_day=>16,p_next_payment_date=>pending_date,
    p_actor_aal=>'aal2',p_actor_session_issued_at=>issued,p_totp_verified_at=>null);
  if result->>'billing_version' <> '2' or result->>'preferred_payment_day' <> '16'
    or (result->>'next_payment_date')::timestamptz <> pending_date then
    raise exception 'SCHEDULE_WITH_LOGIN_MFA_FAILED';
  end if;
  if (select count(*) from public.payments) <> payment_count
    or (select count(*) from public.payment_attempts) <> attempt_count
    or (select count(*) from public.billing_cycles) <> cycle_count then
    raise exception 'CONFIRMATION_STARTED_A_PAYMENT';
  end if;
end;
$tests$;
rollback;
