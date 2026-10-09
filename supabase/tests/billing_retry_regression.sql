-- ESCRITURA | v0.4.0 | 2026-10-08 | Fictional, disposable parent-owned DB only.
-- No provider requests. All fixtures/functions below roll back at the end.
begin;
set local statement_timeout = '120s';
set local lock_timeout = '5s';
do $$ begin
  if current_database() not like 'hpe_retry_lab_%' or not public.billing_retry_schema_ready()
    or not exists(select 1 from public.donors where email = 'legacy@example.test') then
    raise exception 'BILLING_DISPOSABLE_FIXTURE_REQUIRED';
  end if;
end $$;

create function pg_temp.assert_true(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'BILLING_ASSERTION_FAILED: %',p_message; end if; end $$;
create function pg_temp.fixture_sub(p_retry boolean default true,p_monthly boolean default true)
returns uuid language plpgsql as $$
declare d uuid := gen_random_uuid(); s uuid := gen_random_uuid(); source text; proof jsonb;
begin
  source := 'fixture-source-'||s::text;
  if p_retry then proof := jsonb_build_object('version','0.4.0','kind','checkout','mandateId',gen_random_uuid(),
    'environment','sandbox','authorizedAt',clock_timestamp()-interval '3 days','recurring',true,'retryAllowed',true,
    'sourceVerified',true,'sourceVerifiedAt',clock_timestamp()-interval '3 days','sourceId',source,'method','CARD'); end if;
  insert into public.donors(id,email,first_name,last_name) values(d,d::text||'@example.test','Fictional','Fixture');
  insert into public.subscriptions(id,donor_id,amount,currency,frequency,status,payment_method_type,
    wompi_payment_source_id,reference,preferred_payment_day,next_payment_date,billing_authorization)
  values(s,d,30000,'COP',case when p_monthly then 'monthly' else 'one_time' end,
    'active','card',source,'fixture-'||s::text,16,clock_timestamp()-interval '1 hour',proof);
  return s;
end $$;
create function pg_temp.source_proof(p_sub uuid) returns jsonb language sql as $$
  select jsonb_build_object('id',wompi_payment_source_id,'type','CARD','status','AVAILABLE',
    'environment','sandbox','verification_source','provider_get','verified_at',clock_timestamp())
  from public.subscriptions where id = p_sub
$$;
create function pg_temp.tx(p_attempt uuid,p_status text,p_message text default null,p_final timestamptz default clock_timestamp())
returns jsonb language sql as $$
  select jsonb_build_object('id','fixture-tx-'||a.id::text,'reference',a.reference,'amount_in_cents',a.amount::bigint*100,
    'currency',a.currency,'payment_source_id',a.dispatch_snapshot->>'paymentSourceId','payment_method_type','CARD',
    'status',p_status,'status_message',p_message,'finalized_at',case when p_final is not null then
      to_char(p_final at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'environment',a.dispatch_snapshot->>'environment','verification_source','provider_get',
    'payment_source_verification',pg_temp.source_proof(a.subscription_id))
  from public.payment_attempts a where a.id = p_attempt
$$;
create function pg_temp.seed_yesterday_original(p_sub uuid,p_days integer default 1) returns uuid language plpgsql as $$
declare s public.subscriptions; cid uuid := gen_random_uuid(); aid uuid := gen_random_uuid(); sent_at timestamptz;
  ref text; period text; snapshot jsonb;
begin
  select * into s from public.subscriptions where id = p_sub;
  sent_at := (((clock_timestamp() at time zone 'America/Bogota')::date-p_days)::timestamp+interval '7 hours') at time zone 'America/Bogota';
  period := to_char(sent_at at time zone 'America/Bogota','YYYYMM'); ref := 'fixture-old-'||aid::text;
  insert into public.billing_cycles(id,subscription_id,donor_id,billing_period,origin,state,retry_enabled,
    authorization_snapshot,amount,currency,payment_source_id,environment,preferred_payment_day,subscription_version,
    original_due_at,created_at,updated_at)
  values(cid,s.id,s.donor_id,period,'renewal','open',true,s.billing_authorization,s.amount,s.currency,
    s.wompi_payment_source_id,'sandbox',16,s.billing_version,sent_at,sent_at,sent_at);
  snapshot := jsonb_build_object('attemptId',aid,'cycleId',cid,'subscriptionId',s.id,'frequency','monthly',
    'attemptNumber',1,'reference',ref,'amount',s.amount,'currency',s.currency,'paymentSourceId',s.wompi_payment_source_id,
    'customerEmail',(select email from public.donors where id = s.donor_id),'preferredPaymentDay',16,
    'billingVersion',s.billing_version,'environment','sandbox','paymentMethodType','card');
  insert into public.payment_attempts(id,donor_id,subscription_id,billing_period,reference,amount,currency,
    subscription_version,state,cycle_id,attempt_number,send_authorized_at,send_window_end,dispatched_at,
    dispatch_snapshot,created_at,updated_at)
  values(aid,s.donor_id,s.id,period,ref,s.amount,s.currency,s.billing_version,'dispatching',cid,1,
    sent_at,sent_at+interval '17 hours',sent_at,snapshot,sent_at,sent_at);
  return aid;
end $$;

do $$
declare sid uuid; aid uuid; bid uuid; cid uuid; r jsonb; r2 jsonb; payload jsonb; proof jsonb;
  declined_at timestamptz; next_at timestamptz; before_value jsonb; request_id uuid;
  actor uuid := gen_random_uuid(); i uuid; d uuid; failed boolean; midnight timestamptz;
begin
  perform pg_temp.assert_true(to_char(timestamptz '2026-07-01 02:40:00+00' at time zone 'America/Bogota','YYYYMM') = '202606',
    'UTC July 1 is Colombia June');
  perform pg_temp.assert_true(public.billing_v2_normalize_status_message(E'\t\nIntente mas tarde - Fondos Insuficientes \r\n')
    = 'Intente mas tarde - Fondos Insuficientes','NFKC trim tabs/newlines');
  perform pg_temp.assert_true(public.billing_v2_normalize_status_message(chr(65279)||'Intente mas tarde - Fondos Insuficientes'||chr(160))
    = 'Intente mas tarde - Fondos Insuficientes','JS trim BOM/NBSP');
  perform pg_temp.assert_true(public.billing_v2_normalize_status_message('Intente mas tarde - FONDOS Insuficientes')
    <> 'Intente mas tarde - Fondos Insuficientes','No case-folding classification');

  -- Original-only legacy renewal and durable uncertainty; no second send winner.
  sid := pg_temp.fixture_sub(false);
  -- Fixtures explicitly assign environment through an old checkout, not a cloud credential.
  insert into public.checkout_intents(donor_id,reference,secret_hash,amount,currency,is_recurring,
    preferred_payment_day,environment,expires_at,state)
  select donor_id,reference,gen_random_uuid()::text,amount,currency,true,16,'sandbox',clock_timestamp()+interval '30 minutes','completed'
  from public.subscriptions where id = sid;
  r := public.billing_v2_reserve_original(sid,0); aid := (r#>>'{attempt,id}')::uuid;
  perform pg_temp.assert_true((r->>'result') = 'reserved','Original reservation');
  perform pg_temp.assert_true(not (select retry_enabled from public.billing_cycles where id = (r#>>'{attempt,cycle_id}')::uuid),
    'Legacy active/source does not grant retry consent');
  perform pg_temp.assert_true((public.billing_v2_authorize_send(aid,null)->>'canDispatch') = 'false','Source proof required');
  r := public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid));
  perform pg_temp.assert_true(r->>'canDispatch' = 'true','Original send winner');
  perform pg_temp.assert_true((r->>'dispatchDeadline')::timestamptz <= (r->>'sendAuthorizedAt')::timestamptz+interval '15 seconds',
    'Send deadline bounded by 15 seconds');
  perform pg_temp.assert_true(public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid))->>'canDispatch' = 'false',
    'Authorization cannot be reused');
  perform public.billing_v2_mark_uncertain(aid);
  r := public.billing_v2_reserve_original(sid,0);
  perform pg_temp.assert_true((r#>>'{attempt,id}')::uuid = aid and
    (select state = 'unknown' from public.payment_attempts where id = aid),'Unknown retains same reservation');

  -- Real GET approval, duplicate and old decline cannot advance twice or downgrade.
  sid := pg_temp.fixture_sub(); r := public.billing_v2_reserve_original(sid,0); aid := (r#>>'{attempt,id}')::uuid;
  perform public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid));
  payload := pg_temp.tx(aid,'APPROVED');
  r := public.billing_v2_apply_result(aid,payload);
  select next_payment_date into next_at from public.subscriptions where id = sid;
  perform pg_temp.assert_true(next_at = (date_trunc('month',clock_timestamp() at time zone 'America/Bogota')
    +interval '1 month'+interval '15 days 7 hours') at time zone 'America/Bogota','Approval schedules preferred next month');
  r := public.billing_v2_apply_result(aid,payload);
  perform pg_temp.assert_true(r->>'result' = 'duplicate','Approval replay is duplicate');
  perform public.billing_v2_apply_result(aid,payload||'{"status":"DECLINED"}');
  perform pg_temp.assert_true((select next_payment_date = next_at and status = 'active' from public.subscriptions where id = sid)
    and (select status = 'approved' from public.payments where payment_attempt_id = aid),'Late decline does not downgrade');

  -- A legitimate initial monthly authorization is stored, not inferred from is_recurring alone.
  d := gen_random_uuid(); i := gen_random_uuid();
  insert into public.donors(id,email,first_name,last_name) values(d,d::text||'@example.test','Fictional','Checkout');
  insert into public.checkout_intents(id,donor_id,reference,secret_hash,amount,is_recurring,preferred_payment_day,
    environment,expires_at,retry_authorization)
  values(i,d,'initial-'||i::text,gen_random_uuid()::text,30000,true,6,'sandbox',clock_timestamp()+interval '30 minutes',
    jsonb_build_object('version','0.4.0','recurring',true,'retryAllowed',true,'acceptedAt',clock_timestamp()));
  r := public.billing_v2_prepare_subscription(i,'card'); sid := (r->>'id')::uuid;
  perform public.billing_v2_bind_source(i,sid,'fixture-initial-source',true);
  r := public.billing_v2_reserve_initial(i,sid); aid := (r#>>'{attempt,id}')::uuid; cid := (r#>>'{attempt,cycle_id}')::uuid;
  perform public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid));
  payload := pg_temp.tx(aid,'DECLINED','Intente mas tarde - Fondos Insuficientes');
  r := public.billing_v2_apply_result(aid,payload);
  r2 := public.billing_v2_apply_result(aid,payload);
  perform pg_temp.assert_true(r->>'retryQueued' = 'true' and r2->>'retryQueued' = 'true' and r2->>'result' = 'duplicate',
    'Repeated confirmation still reports the single queued retry from durable cycle state');
  perform pg_temp.assert_true((select state = 'retry_wait' and retry_enabled and
    (retry_window_start at time zone 'America/Bogota')::time = time '07:00:00'
    and (retry_window_end at time zone 'America/Bogota')::time = time '00:00:00'
    from public.billing_cycles where id = cid),'Exact funds decline queues next Colombia day');
  perform pg_temp.assert_true(public.billing_v2_reserve_retry(cid)->>'result' = 'not_due','No retry on original day');

  -- Unknown message and malformed/absent final time never create retry eligibility.
  sid := pg_temp.fixture_sub(); r := public.billing_v2_reserve_original(sid,0); aid := (r#>>'{attempt,id}')::uuid;
  perform public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid));
  perform public.billing_v2_apply_result(aid,pg_temp.tx(aid,'DECLINED','Intente mas tarde - Fondos Insuficientes EXTRA'));
  perform pg_temp.assert_true((select status = 'past_due' and next_payment_date is null and billing_hold_reason = 'manual_review'
    from public.subscriptions where id = sid),'Substring unknown decline requires manual review');
  sid := pg_temp.fixture_sub(); r := public.billing_v2_reserve_original(sid,0); aid := (r#>>'{attempt,id}')::uuid;
  perform public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid));
  perform public.billing_v2_apply_result(aid,pg_temp.tx(aid,'DECLINED','Intente mas tarde - Fondos Insuficientes',null));
  perform pg_temp.assert_true((select billing_hold_reason = 'decline_date_missing' from public.subscriptions where id = sid),
    'Missing finalized_at is not replaced by now');

  -- Yesterday's durable original has today's single retry window, even across month/year.
  sid := pg_temp.fixture_sub(); aid := pg_temp.seed_yesterday_original(sid);
  select send_authorized_at+interval '1 hour' into declined_at from public.payment_attempts where id = aid;
  perform public.billing_v2_apply_result(aid,pg_temp.tx(aid,'DECLINED',E'\tIntente mas tarde - Fondos Insuficientes\n',declined_at));
  select cycle_id into cid from public.payment_attempts where id = aid;
  r := public.billing_v2_reserve_retry(cid);
  if r->>'result' = 'not_due' then
    raise notice 'SKIP active retry dispatch before Colombia 07:00; window guard checked';
  else
    bid := (r#>>'{attempt,id}')::uuid;
    perform pg_temp.assert_true((select attempt_number = 2 and parent_attempt_id = aid and billing_period =
      (select billing_period from public.payment_attempts where id = aid) from public.payment_attempts where id = bid),
      'Additional keeps original period and parent');
    perform pg_temp.assert_true((public.billing_v2_reserve_retry(cid)#>>'{attempt,id}')::uuid = bid,'Only one additional reservation');
    perform public.billing_v2_authorize_send(bid,pg_temp.source_proof(sid));
    perform public.billing_v2_apply_result(bid,pg_temp.tx(bid,'DECLINED','Intente mas tarde - Fondos Insuficientes'));
    perform pg_temp.assert_true((select status = 'past_due' and next_payment_date is null and billing_hold_reason = 'retry_exhausted'
      from public.subscriptions where id = sid),'Additional exhausted stops all future originals');
    perform public.billing_v2_apply_result(aid,pg_temp.tx(aid,'APPROVED',null,declined_at));
    perform pg_temp.assert_true((select status = 'past_due' and next_payment_date is null from public.subscriptions where id = sid),
      'Old approval after exhaustion does not reactivate');
    perform pg_temp.assert_true((select count(*) = 2 from public.payment_attempts where cycle_id = cid),'Cycle budget stays two');
  end if;

  -- Late original plus successful additional: preserve both genuine money records.
  if (clock_timestamp() at time zone 'America/Bogota')::time >= time '07:00:00' then
    sid := pg_temp.fixture_sub(); aid := pg_temp.seed_yesterday_original(sid);
    select send_authorized_at+interval '1 hour' into declined_at from public.payment_attempts where id = aid;
    perform public.billing_v2_apply_result(aid,pg_temp.tx(aid,'DECLINED','Intente mas tarde - Fondos Insuficientes',declined_at));
    select cycle_id into cid from public.payment_attempts where id = aid;
    r := public.billing_v2_reserve_retry(cid); bid := (r#>>'{attempt,id}')::uuid;
    perform public.billing_v2_authorize_send(bid,pg_temp.source_proof(sid));
    perform public.billing_v2_apply_result(bid,pg_temp.tx(bid,'APPROVED'));
    perform public.billing_v2_apply_result(aid,pg_temp.tx(aid,'APPROVED',null,declined_at));
    perform pg_temp.assert_true((select count(*) = 2 from public.payments where subscription_id = sid and status = 'approved'),
      'Contradictory approved money retained');
    perform pg_temp.assert_true((select state = 'manual_review' from public.billing_cycles where id = cid),'Contradiction manual hold');
  end if;

  -- Missed D+1 never catches up on D+2. Reconcile expiry does not reserve or send.
  sid := pg_temp.fixture_sub(); aid := pg_temp.seed_yesterday_original(sid,2);
  select send_authorized_at+interval '1 hour' into declined_at from public.payment_attempts where id = aid;
  perform public.billing_v2_apply_result(aid,pg_temp.tx(aid,'DECLINED','Intente mas tarde - Fondos Insuficientes',declined_at));
  perform pg_temp.assert_true((select billing_hold_reason = 'retry_window_missed' and next_payment_date is null
    from public.subscriptions where id = sid),'Missed window is manual review');

  -- Atomic administrative replay BEFORE version/state validation; no secret audit data.
  insert into auth.users(id,email) values(actor,'admin-fixture@example.test');
  insert into public.admin_users(user_id,role,active) values(actor,'admin',true);
  -- API/RPC envelopes must retain retry consent, source, method and verified reason.
  sid := pg_temp.fixture_sub(); r := public.billing_v2_reserve_original(sid,0); aid := (r#>>'{attempt,id}')::uuid;
  perform pg_temp.assert_true(r#>>'{dispatchSnapshot,retryEnabled}' = 'true'
    and r#>>'{dispatchSnapshot,attemptId}' = r#>>'{attempt,id}','Actual reservation shape and frozen retry mandate');
  perform public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid));
  payload := pg_temp.tx(aid,'DECLINED','Intente mas tarde - Fondos Insuficientes');
  r := public.billing_v2_admin_reconcile_payment_attempt(aid,actor,'Fictional verified recovery',gen_random_uuid(),
    payload->>'id',payload->>'reference',payload->>'payment_source_id',30000,'COP','declined',
    (payload->>'finalized_at')::timestamptz,null,
    payload || jsonb_build_object('transaction',payload),0,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  perform pg_temp.assert_true(r->>'result' = 'recovered'
    and (select state = 'retry_wait' from public.billing_cycles where subscription_id = sid),
    'Complete admin nested GET envelope schedules the authorized retry');
  sid := pg_temp.fixture_sub(); r := public.billing_v2_reserve_original(sid,0); aid := (r#>>'{attempt,id}')::uuid;
  perform public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid));
  request_id := gen_random_uuid(); payload := pg_temp.tx(aid,'PENDING',null,null);
  r := public.billing_v2_admin_reconcile_payment_attempt(aid,actor,'Fictional same recovery request',request_id,
    payload->>'id',payload->>'reference',payload->>'payment_source_id',30000,'COP','pending',null,null,
    payload || jsonb_build_object('transaction',payload),0,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  payload := pg_temp.tx(aid,'APPROVED');
  r2 := public.billing_v2_admin_reconcile_payment_attempt(aid,actor,'Fictional same recovery request',request_id,
    payload->>'id',payload->>'reference',payload->>'payment_source_id',30000,'COP','approved',
    (payload->>'finalized_at')::timestamptz,null,payload || jsonb_build_object('transaction',payload),
    0,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  perform pg_temp.assert_true(r = r2 and r2->>'providerStatus' = 'pending'
    and (select count(*) = 1 from public.admin_audit_logs where subscription_id = sid),
    'Recovery replay uses user semantics, not changing provider evidence');
  r2 := public.billing_v2_admin_recovery_replay(aid,actor,'Fictional same recovery request',request_id,
    payload->>'id',0,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  perform pg_temp.assert_true(r2->>'result' = 'replay' and r2->'response' = r
    and r2#>>'{response,needsReview}' = 'false','Replay-first returns stable response without provider evidence');
  failed := false;
  begin
    perform public.billing_v2_admin_recovery_replay(aid,actor,'Fictional same recovery request',request_id,
      payload->>'id',0,'aal1',clock_timestamp()-interval '1 second',clock_timestamp());
  exception when others then failed := true; end;
  perform pg_temp.assert_true(failed,'Replay still requires MFA');
  failed := false;
  begin
    perform public.billing_v2_admin_reconcile_payment_attempt(aid,actor,'Different fictional requested reason',request_id,
      payload->>'id',payload->>'reference',payload->>'payment_source_id',30000,'COP','approved',
      (payload->>'finalized_at')::timestamptz,null,payload || jsonb_build_object('transaction',payload),
      0,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  exception when unique_violation then failed := true; end;
  perform pg_temp.assert_true(failed,'Recovery changed user content conflicts');
  -- Legacy intent/attempt amount can differ; only an exactly linked historical payment supplies the expected money.
  sid := pg_temp.fixture_sub(false); aid := gen_random_uuid(); request_id := gen_random_uuid();
  insert into public.payment_attempts(id,donor_id,subscription_id,billing_period,reference,amount,currency,
    subscription_version,state,wompi_transaction_id)
  select aid,donor_id,id,to_char(clock_timestamp() at time zone 'America/Bogota','YYYYMM'),reference,20000,'COP',0,'unknown',
    'fixture-legacy-recovery-'||aid::text from public.subscriptions where id=sid;
  insert into public.payments(subscription_id,payment_attempt_id,amount,currency,status,wompi_transaction_id,reference,
    approved_at,provider_effective_at)
  select id,aid,10000,'COP','approved','fixture-legacy-recovery-'||aid::text,reference,
    clock_timestamp()-interval '1 second',clock_timestamp()-interval '1 second' from public.subscriptions where id=sid;
  select jsonb_build_object('id',p.wompi_transaction_id,'reference',p.reference,'amount_in_cents',1000000,
    'currency','COP','payment_source_id',s.wompi_payment_source_id,'status','approved',
    'finalized_at',to_char(p.approved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'verification_source','provider_get','environment','sandbox') into payload
  from public.payments p join public.subscriptions s on s.id=p.subscription_id where p.payment_attempt_id=aid;
  update public.payments set reference=null where payment_attempt_id=aid;
  failed := false;
  begin
    perform public.billing_v2_admin_reconcile_payment_attempt(aid,actor,'Fictional linked historical recovery',request_id,
      payload->>'id',payload->>'reference',payload->>'payment_source_id',10000,'COP','approved',
      (payload->>'finalized_at')::timestamptz,null,payload || jsonb_build_object('transaction',payload),
      0,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  exception when others then
    if sqlerrm = 'PAYMENT_RECOVERY_INVALID_INPUT' then failed := true; else raise; end if;
  end;
  perform pg_temp.assert_true(failed and not exists(select 1 from public.admin_audit_logs where subscription_id=sid and action='payment_recovery'),
    'A different legacy amount without an exact historical reference cannot be reconciled');
  update public.payments set reference=payload->>'reference' where payment_attempt_id=aid;
  r := public.billing_v2_admin_reconcile_payment_attempt(aid,actor,'Fictional linked historical recovery',request_id,
    payload->>'id',payload->>'reference',payload->>'payment_source_id',10000,'COP','approved',
    (payload->>'finalized_at')::timestamptz,null,payload || jsonb_build_object('transaction',payload),
    0,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  perform pg_temp.assert_true(r->>'result' = 'review' and r->>'needsReview' = 'true'
    and (select amount=10000 from public.payments where payment_attempt_id=aid)
    and (select amount=20000 from public.payment_attempts where id=aid),'Legacy recovery preserves both amounts without inventing equality');
  sid := pg_temp.fixture_sub(false);
  payload := jsonb_build_object('verification_source','provider_get','environment','sandbox');
  r := public.apply_verified_wompi_event('fixture-legacy-'||sid::text,'fixture-legacy-tx-'||sid::text,
    'transaction.reconciled','fixture-'||sid::text,null,30000,'COP','approved',clock_timestamp()-interval '1 second',null,payload);
  perform pg_temp.assert_true(r->>'result' = 'review' and r->>'historicalOnly' = 'true'
    and r->>'subscriptionId' = sid::text,'First legacy review identifies its exact subscription');
  select approved_at into declined_at from public.payments where subscription_id = sid;
  r2 := public.apply_verified_wompi_event('fixture-legacy-'||sid::text,'fixture-legacy-tx-'||sid::text,
    'transaction.reconciled','fixture-'||sid::text,null,30000,'COP','approved',declined_at,null,payload);
  perform pg_temp.assert_true(r2->>'result' = 'duplicate'
    and (select count(*) = 1 from public.payments where subscription_id = sid),'Repeated verified legacy GET is idempotent');
  sid := pg_temp.fixture_sub(); request_id := gen_random_uuid();
  r := public.billing_v2_admin_update_subscription(sid,0,'amount','Fictional amount decision',request_id,actor,
    35000,null,null,false,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  r2 := public.billing_v2_admin_update_subscription(sid,0,'amount','Fictional amount decision',request_id,actor,
    35000,null,null,false,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  perform pg_temp.assert_true(r = r2 and (select billing_version = 1 from public.subscriptions where id = sid),
    'Replay returns committed result despite old version');
  failed := false;
  begin
    perform public.billing_v2_admin_update_subscription(sid,0,'amount','Fictional amount decision',request_id,actor,
      36000,null,null,false,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  exception when unique_violation then failed := true; end;
  perform pg_temp.assert_true(failed,'Changed body conflicts on same requestId');
  sid := pg_temp.fixture_sub(); r := public.billing_v2_reserve_original(sid,0); aid := (r#>>'{attempt,id}')::uuid;
  cid := (r#>>'{attempt,cycle_id}')::uuid;
  r := public.billing_v2_admin_update_subscription(sid,0,'cancel_retry','Fictional cancel before send',gen_random_uuid(),actor,
    null,null,null,false,'aal2',clock_timestamp()-interval '1 second',clock_timestamp(),null,cid);
  perform pg_temp.assert_true(public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid))->>'canDispatch' = 'false',
    'Cancelled reservation cannot be sent');
  sid := pg_temp.fixture_sub(); r := public.billing_v2_reserve_original(sid,0); aid := (r#>>'{attempt,id}')::uuid;
  perform public.billing_v2_authorize_send(aid,pg_temp.source_proof(sid));
  r := public.billing_v2_admin_update_subscription(sid,0,'cancel','Fictional cancellation after barrier',gen_random_uuid(),actor,
    null,null,null,false,'aal2',clock_timestamp()-interval '1 second',clock_timestamp());
  perform pg_temp.assert_true(r->>'chargeMayComplete' = 'true','Cancel after barrier warns possible completion');
  perform public.billing_v2_apply_result(aid,pg_temp.tx(aid,'APPROVED'));
  perform pg_temp.assert_true((select status = 'cancelled' and next_payment_date is null from public.subscriptions where id = sid),
    'Approval cannot reverse audited cancellation');
  next_at := (date_trunc('month',clock_timestamp() at time zone 'America/Bogota')+interval '1 month 15 days 7 hours') at time zone 'America/Bogota';
  proof := pg_temp.source_proof(sid);
  r := public.billing_v2_admin_update_subscription(sid,1,'reactivate','Fictional new donor authorization',gen_random_uuid(),actor,
    null,16,next_at,true,'aal2',clock_timestamp()-interval '1 second',clock_timestamp(),proof);
  perform pg_temp.assert_true((select after_value->>'donor_authorization_confirmed'='true' from public.admin_audit_logs
    where subscription_id=sid and action='reactivate'),'Audited reactivation consent is explicit');
  perform pg_temp.assert_true((select count(*) = 2 from public.billing_cycles where subscription_id = sid),
    'Reactivation creates new cycle instead of resetting old cycle');
  perform pg_temp.assert_true((select count(*) = 1 from public.payment_attempts where subscription_id = sid and send_authorized_at is not null),
    'Saving reactivation never authorizes immediate send');

  -- Repair approved current-month due date without accepting caller time/date.
  sid := pg_temp.fixture_sub(false);
  insert into public.payments(subscription_id,amount,currency,status,wompi_transaction_id,reference,approved_at,provider_effective_at)
  values(sid,30000,'COP','approved','fixture-repair-'||sid::text,'fixture-'||sid::text,
    clock_timestamp()-interval '1 second',clock_timestamp()-interval '1 second');
  perform pg_temp.assert_true(public.billing_v2_repair_schedule(sid,0)->>'result' = 'repaired','Approved repair');
  perform pg_temp.assert_true((select next_payment_date > clock_timestamp() from public.subscriptions where id = sid),'Repair advances to future month');

  -- One-time initial still records genuine GET result, without a monthly cycle.
  d := gen_random_uuid(); i := gen_random_uuid();
  insert into public.donors(id,email,first_name,last_name) values(d,d::text||'@example.test','Fictional','Unique');
  insert into public.checkout_intents(id,donor_id,reference,secret_hash,amount,is_recurring,environment,expires_at)
  values(i,d,'unique-'||i::text,gen_random_uuid()::text,1500,false,'sandbox',clock_timestamp()+interval '30 minutes');
  r := public.billing_v2_prepare_subscription(i,'card'); sid := (r->>'id')::uuid;
  r := public.billing_v2_reserve_initial(i,sid); aid := (r#>>'{attempt,id}')::uuid;
  perform pg_temp.assert_true(r#>>'{attempt,cycle_id}' is null,'Unique has no recurring cycle');
  perform public.billing_v2_apply_result(aid,pg_temp.tx(aid,'APPROVED'));
  perform pg_temp.assert_true((select frequency = 'one_time' and next_payment_date is null from public.subscriptions where id = sid),
    'Unique remains without scheduled/retry date');
  raise notice 'PASS billing v0.4.0 fictional regression assertions';
end $$;

set local role service_role;
do $$ declare denied boolean := false; begin
  begin update public.subscriptions set amount = amount where false;
  exception when insufficient_privilege then denied := true; end;
  perform pg_temp.assert_true(denied,'Direct service-role financial DML denied');
  perform pg_temp.assert_true(not has_function_privilege(current_user,'public.claim_monthly_payment_attempt(uuid,timestamptz)','EXECUTE'),
    'Old claim RPC revoked');
  perform pg_temp.assert_true(not has_function_privilege(current_user,'public.admin_reconcile_payment_attempt(uuid,uuid,text,uuid,text,text,text,integer,text,text,timestamptz,timestamptz,jsonb,integer,text,timestamptz,timestamptz)','EXECUTE'),
    'Old recovery RPC revoked');
end $$;
reset role;
rollback;
