-- v0.3.0 | 2026-10-03. Parent-only Postgres engine regression after base_schema + migration.
-- All fixture writes roll back. Mirrors the durable receipt CLI's apply_verified_wompi_event contract.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
do $$ begin
  if current_database() <> 'hpe_lab' or not public.payment_admin_schema_ready()
    or (select count(*) from information_schema.columns where table_schema = 'auth' and table_name = 'users') <> 2
    or not exists(select 1 from public.donors where id = '10000000-0000-0000-0000-000000000090'
      and email = 'legacy@example.test') then raise exception 'DISPOSABLE_BASE_SCHEMA_FIXTURE_REQUIRED'; end if;
  if not exists(select 1 from public.payments where id = '70000000-0000-0000-0000-000000000090'
    and wompi_transaction_id = 'tx-historic-10000' and amount = 10000 and currency = 'COP'
    and status = 'approved' and reference is null and approved_at is null and provider_effective_at is null
    and payment_attempt_id is null and billing_review_required) then raise exception 'UNENRICHED_LEGACY_FIXTURE_REQUIRED'; end if;
end $$;

update public.subscriptions set wompi_payment_source_id = 'fixture-current-new-source'
where id = '20000000-0000-0000-0000-000000000090';
insert into public.webhook_events(id,transaction_id,event_type,raw,record_kind)
values('60000000-0000-0000-0000-000000000030','tx-historic-10000','transaction.updated',
  '{"transaction_id":"tx-historic-10000","event_type":"transaction.updated","old_applied_evidence":true}','legacy');
update public.webhook_events set processing_state = 'legacy_applied' where id = '60000000-0000-0000-0000-000000000030';
create temporary table history_subscription_snapshot(id uuid primary key,value jsonb) on commit drop;
insert into history_subscription_snapshot select id,to_jsonb(s) from public.subscriptions s
where id = '20000000-0000-0000-0000-000000000090';
create temporary table history_receipts(id uuid primary key,raw jsonb,expected_state text default 'processed') on commit drop;
create function pg_temp.history_receipt(p_transaction text,p_reference text,p_old_status text default 'approved') returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_raw jsonb;
begin
  v_raw := jsonb_build_object('receipt_version',1,'event','transaction.updated','environment','sandbox',
    'event_timestamp',null,'transaction',jsonb_build_object('id',p_transaction,'reference',p_reference,
      'amount_in_cents',1000000,'currency','COP','status',upper(p_old_status),'finalized_at',null,
      'payment_source_id','fixture-legacy-source'),
    'checksum','fixture','body_sha256','fixture','received_at','2026-10-03T12:00:00Z');
  insert into public.webhook_events(id,transaction_id,event_type,raw) values(v_id,null,null,v_raw);
  insert into pg_temp.history_receipts(id,raw) values(v_id,v_raw);
  return v_id;
end $$;
create function pg_temp.history_apply(p_key text,p_tx text,p_ref text,p_receipt uuid,p_effective timestamptz,
  p_amount integer default 10000,p_status text default 'approved',p_source text default null) returns jsonb language sql as $$
  select public.apply_verified_wompi_event(p_key,p_tx,'transaction.reconciled',p_ref,p_source,p_amount,'COP',p_status,
    p_effective,'2028-01-16T12:00:00Z',jsonb_build_object('receipt_id',p_receipt,'source','durable_receipt',
      'transaction',jsonb_build_object('id',p_tx,'reference',p_ref,'amount_in_cents',p_amount * 100,
        'currency','COP','status',p_status,'finalized_at',p_effective,'payment_source_id',p_source)))
$$;

-- The same receipt/key may initially lack a finalized timestamp; GET later supplies proof.
do $$ declare v_receipt uuid; v_result jsonb; v_canonical_raw jsonb; begin
  v_receipt := pg_temp.history_receipt('tx-historic-10000','HPE-LEGACY');
  v_result := pg_temp.history_apply('history-review-key','tx-historic-10000','HPE-LEGACY',v_receipt,null,p_source => 'fixture-legacy-source');
  if v_result ->> 'result' <> 'review' or not exists(select 1 from public.payments
    where id = '70000000-0000-0000-0000-000000000090' and approved_at is null and provider_effective_at is null
      and billing_review_required) then raise exception 'LEGACY_APPLIED_UNDATED_PAYMENT_WAS_NOT_REVIEWED'; end if;
  select raw into v_canonical_raw from public.webhook_events where event_key = 'history-review-key' and record_kind = 'canonical';
  v_result := pg_temp.history_apply('history-review-key','tx-historic-10000','HPE-LEGACY',v_receipt,'2026-09-19T15:00:00Z',p_source => 'fixture-legacy-source');
  if v_result ->> 'result' <> 'processed' or v_result ->> 'legacyApplied' <> 'true'
    or v_result ->> 'historicalOnly' <> 'true' or v_result ->> 'scheduleProtected' <> 'true'
    or not exists(select 1 from public.payments where id = '70000000-0000-0000-0000-000000000090'
      and status = 'approved' and amount = 10000 and currency = 'COP' and reference = 'HPE-LEGACY'
      and approved_at = '2026-09-19T15:00:00Z' and provider_effective_at = approved_at
      and not billing_review_required and payment_attempt_id is null
      and created_at = '2026-01-02T12:00:00Z' and updated_at = '2026-02-03T12:00:00Z') then
    raise exception 'LEGACY_APPLIED_OR_REVIEW_KEY_BLOCKED_VERIFIED_METADATA'; end if;
  if not exists(select 1 from public.webhook_events where id = v_receipt and processing_state = 'processed'
    and processed_at is not null and last_error is null)
    or not exists(select 1 from public.webhook_events where event_key = 'history-review-key' and record_kind = 'canonical'
      and processing_state = 'processed' and raw = v_canonical_raw and processed_at is not null) then
    raise exception 'HISTORICAL_CURRENT_RECEIPT_NOT_PROCESSED_OR_CANONICAL_RAW_REWRITTEN'; end if;
  -- Even a previously processed key cannot bypass actual payment amount validation.
  v_result := pg_temp.history_apply('history-review-key','tx-historic-10000','HPE-LEGACY',v_receipt,'2026-09-19T15:00:00Z',25000);
  if v_result ->> 'result' <> 'review' or v_result ->> 'error' <> 'WOMPI_EVENT_HISTORICAL_PAYMENT_MISMATCH'
    or (select amount from public.payments where wompi_transaction_id = 'tx-historic-10000') <> 10000 then
    raise exception 'PROCESSED_KEY_ACCEPTED_CURRENT_INSTEAD_OF_HISTORICAL_AMOUNT'; end if;
  v_result := pg_temp.history_apply('history-review-key','tx-historic-10000','HPE-LEGACY',v_receipt,'2026-09-19T15:00:00Z');
  if v_result ->> 'result' <> 'duplicate' or (select processing_state from public.webhook_events where id = v_receipt) <> 'processed' then
    raise exception 'CORRECTED_VERIFIED_EVIDENCE_REMAINED_PERMANENTLY_BLOCKED'; end if;
  if exists(select 1 from pg_temp.history_subscription_snapshot b join public.subscriptions s using(id)
    where b.value <> to_jsonb(s)) or exists(select 1 from public.payment_attempts where wompi_transaction_id = 'tx-historic-10000') then
    raise exception 'HISTORICAL_ENRICHMENT_CHANGED_SUBSCRIPTION_OR_CREATED_ATTEMPT'; end if;
  if not exists(select 1 from public.webhook_events where id = '60000000-0000-0000-0000-000000000030'
    and processing_state = 'legacy_applied'
    and raw = '{"transaction_id":"tx-historic-10000","event_type":"transaction.updated","old_applied_evidence":true}'::jsonb) then
    raise exception 'HISTORICAL_LEGACY_RAW_OR_STATE_CHANGED'; end if;
end $$;

-- An old canonical legacy_applied marker also permits enrichment; only the exact reference family is valid.
insert into public.payments(id,subscription_id,amount,currency,status,wompi_transaction_id,billing_review_required)
values('70000000-0000-0000-0000-000000000030','20000000-0000-0000-0000-000000000090',
  10000,'COP','approved','tx-historical-suffix',true);
insert into public.webhook_events(transaction_id,event_type,event_key,raw,record_kind,processing_state)
values('tx-historical-suffix','transaction.reconciled','historical-old-canonical',
  '{"old_canonical_evidence":true}','canonical','legacy_applied');
do $$ declare v_receipt uuid; v_result jsonb; begin
  v_receipt := pg_temp.history_receipt('tx-historical-suffix','HPE-LEGACY-202609');
  v_result := pg_temp.history_apply('historical-old-canonical','tx-historical-suffix','HPE-LEGACY-202613',v_receipt,'2026-09-18T15:00:00Z');
  if v_result ->> 'result' <> 'review' or (select reference from public.payments where wompi_transaction_id = 'tx-historical-suffix') is not null then
    raise exception 'HISTORICAL_REFERENCE_ACCEPTED_INVALID_MONTH'; end if;
  v_result := pg_temp.history_apply('historical-old-canonical','tx-historical-suffix','HPE-LEGACY-EXTRA-202609',v_receipt,'2026-09-18T15:00:00Z');
  if v_result ->> 'result' <> 'review' then raise exception 'HISTORICAL_REFERENCE_ACCEPTED_PREFIX_COLLISION'; end if;
  v_result := pg_temp.history_apply('historical-old-canonical','tx-historical-suffix','HPE-LEGACY-202609',v_receipt,'2026-09-18T15:00:00Z');
  if v_result ->> 'result' <> 'processed' or not exists(select 1 from public.payments
    where wompi_transaction_id = 'tx-historical-suffix' and reference = 'HPE-LEGACY-202609'
      and approved_at = '2026-09-18T15:00:00Z' and not billing_review_required)
    or (select raw from public.webhook_events where event_key = 'historical-old-canonical' and record_kind = 'canonical') <> '{"old_canonical_evidence":true}'::jsonb then
    raise exception 'OLD_CANONICAL_LEGACY_MARKER_BLOCKED_VALID_REFERENCE_ENRICHMENT'; end if;
  v_result := pg_temp.history_apply('historical-old-canonical','tx-historical-suffix','HPE-LEGACY-202610',v_receipt,'2026-09-18T15:00:00Z');
  if v_result ->> 'result' <> 'review' or (select reference from public.payments where wompi_transaction_id = 'tx-historical-suffix') <> 'HPE-LEGACY-202609' then
    raise exception 'VERIFIED_GET_OVERWROTE_STORED_REFERENCE_CONFLICT'; end if;
  perform pg_temp.history_apply('historical-old-canonical','tx-historical-suffix','HPE-LEGACY-202609',v_receipt,'2026-09-18T15:00:00Z');
end $$;

-- A verified failure/void is terminal evidence, not an undated approval. No retry policy is introduced.
do $$ declare v_status text; v_tx text; v_key text; v_receipt uuid; v_result jsonb; begin
  foreach v_status in array array['declined','error','voided'] loop
    v_tx := 'tx-historical-terminal-' || v_status;
    v_key := 'historical-terminal-key-' || v_status;
    insert into public.payments(subscription_id,amount,currency,status,wompi_transaction_id,billing_review_required)
    values('20000000-0000-0000-0000-000000000090',10000,'COP','pending',v_tx,true);
    v_receipt := pg_temp.history_receipt(v_tx,'HPE-LEGACY','pending');
    insert into public.webhook_events(transaction_id,event_type,event_key,raw,record_kind,processing_state)
    values(v_tx,'transaction.reconciled',v_key,'{"old_terminal_review":true}','canonical','needs_review');
    v_result := pg_temp.history_apply(v_key,v_tx,'HPE-LEGACY',v_receipt,null,10000,v_status,'fixture-legacy-source');
    if v_result ->> 'result' <> 'processed' or not exists(select 1 from public.payments where wompi_transaction_id = v_tx
      and status = v_status and reference = 'HPE-LEGACY' and approved_at is null and provider_effective_at is null
      and not billing_review_required and payment_attempt_id is null) then
      raise exception 'UNDATED_VERIFIED_TERMINAL_REMAINED_BLOCKED: %',v_status; end if;
    -- Emulate the pre-fix terminal + billing_review_required flag that the new job sweep must find.
    update public.payments set billing_review_required = true where wompi_transaction_id = v_tx;
    update public.webhook_events set processing_state = 'needs_review' where id = v_receipt or event_key = v_key;
    v_result := pg_temp.history_apply(v_key,v_tx,'HPE-LEGACY',v_receipt,null,10000,v_status,'fixture-legacy-source');
    if v_result ->> 'result' <> 'processed' or (select billing_review_required from public.payments where wompi_transaction_id = v_tx) then
      raise exception 'PREEXISTING_TERMINAL_REVIEW_FLAG_WAS_NOT_CLEARED'; end if;
    v_result := pg_temp.history_apply(v_key,v_tx,'HPE-LEGACY',v_receipt,null,10000,v_status,'fixture-legacy-source');
    if v_result ->> 'result' <> 'duplicate' or not exists(select 1 from public.webhook_events where id = v_receipt
      and processing_state = 'processed' and processed_at is not null and raw #>> '{transaction,status}' = 'PENDING')
      or (select raw from public.webhook_events where event_key = v_key and record_kind = 'canonical') <> '{"old_terminal_review":true}'::jsonb then
      raise exception 'REPEATED_TERMINAL_KEY_LEFT_ALL_CHARGES_BLOCKED_OR_CHANGED_RAW'; end if;
  end loop;
  if exists(select 1 from pg_temp.history_subscription_snapshot b join public.subscriptions s using(id) where b.value <> to_jsonb(s)) then
    raise exception 'UNDATED_TERMINAL_CHANGED_SUBSCRIPTION_OR_AGENDA'; end if;
end $$;

-- A changed source needs the service caller's matching verified TX descriptor, never an unrelated/missing one.
do $$ declare v_receipt uuid; v_result jsonb; v_bad jsonb; begin
  v_receipt := pg_temp.history_receipt('tx-historic-10000','HPE-LEGACY');
  foreach v_bad in array array[
    '{}'::jsonb,
    '{"id":"unrelated-tx","reference":"HPE-LEGACY","amount_in_cents":1000000,"currency":"COP","status":"approved"}'::jsonb,
    '{"id":"tx-historic-10000","reference":"HPE-LEGACY","amount_in_cents":1000000,"currency":"COP","status":"approved","payment_source_id":"unrelated-source"}'::jsonb
  ] loop
    v_result := public.apply_verified_wompi_event('history-source-evidence','tx-historic-10000','transaction.reconciled',
      'HPE-LEGACY','fixture-legacy-source',10000,'COP','approved','2026-09-19T15:00:00Z',null,
      jsonb_build_object('receipt_id',v_receipt,'transaction',v_bad));
    if v_result ->> 'result' <> 'review' or v_result ->> 'error' <> 'WOMPI_EVENT_HISTORICAL_SOURCE_EVIDENCE_MISMATCH' then
      raise exception 'HISTORICAL_SOURCE_ACCEPTED_UNVERIFIED_OR_UNRELATED_TX_SOURCE'; end if;
  end loop;
  v_result := pg_temp.history_apply('history-source-evidence','tx-historic-10000','HPE-LEGACY',v_receipt,
    '2026-09-19T15:00:00Z',p_source => 'fixture-legacy-source');
  if v_result ->> 'result' <> 'duplicate' or (select wompi_payment_source_id from public.subscriptions
    where id = '20000000-0000-0000-0000-000000000090') <> 'fixture-current-new-source' then
    raise exception 'VERIFIED_OLD_SOURCE_WAS_REPLACED_OR_BLOCKED'; end if;
  v_result := pg_temp.history_apply('history-approved-no-downgrade','tx-historic-10000','HPE-LEGACY',v_receipt,
    null,10000,'declined','fixture-legacy-source');
  if v_result ->> 'result' <> 'review' or (select status from public.payments where wompi_transaction_id = 'tx-historic-10000') <> 'approved' then
    raise exception 'APPROVED_HISTORY_REGRESSED_TO_UNDATED_TERMINAL'; end if;
  perform pg_temp.history_apply('history-approved-no-downgrade','tx-historic-10000','HPE-LEGACY',v_receipt,
    '2026-09-19T15:00:00Z',p_source => 'fixture-legacy-source');
end $$;

-- Linked attempt/intent and unknown transactions retain current-source binding, even with a matching descriptor.
insert into public.donors(id,email,first_name,last_name)
values('10000000-0000-0000-0000-000000000038','source-bound@example.test','Bound','Fixture');
insert into public.subscriptions(id,donor_id,amount,currency,status,reference,wompi_payment_source_id)
values('20000000-0000-0000-0000-000000000038','10000000-0000-0000-0000-000000000038',
  10000,'COP','active','HPE-SOURCE-BOUND','fixture-bound-current-source');
insert into public.payment_attempts(id,subscription_id,reference,amount,subscription_version,state,wompi_transaction_id)
values('50000000-0000-0000-0000-000000000038','20000000-0000-0000-0000-000000000038',
  'HPE-SOURCE-BOUND-203801',10000,0,'prepared','tx-source-bound-attempt');
insert into public.payments(subscription_id,payment_attempt_id,amount,currency,status,wompi_transaction_id,reference)
values('20000000-0000-0000-0000-000000000038','50000000-0000-0000-0000-000000000038',
  10000,'COP','pending','tx-source-bound-attempt','HPE-SOURCE-BOUND-203801');
insert into public.checkout_intents(donor_id,reference,secret_hash,amount,is_recurring,environment,expires_at)
values('10000000-0000-0000-0000-000000000038','HPE-SOURCE-BOUND-203802','fixture-source-intent-hash',
  10000,true,'sandbox',clock_timestamp()+interval '1 hour');
insert into public.payments(subscription_id,amount,currency,status,wompi_transaction_id,reference)
values('20000000-0000-0000-0000-000000000038',10000,'COP','pending','tx-source-bound-intent','HPE-SOURCE-BOUND-203802');
do $$ declare v_case record; v_receipt uuid; v_result jsonb; begin
  for v_case in select * from (values
    ('tx-source-bound-attempt','HPE-SOURCE-BOUND-203801'),
    ('tx-source-bound-intent','HPE-SOURCE-BOUND-203802'),
    ('tx-source-unknown','HPE-SOURCE-BOUND-203803')
  ) r(tx,ref) loop
    v_receipt := pg_temp.history_receipt(v_case.tx,v_case.ref,'pending');
    v_result := pg_temp.history_apply('bound-source-' || v_case.tx,v_case.tx,v_case.ref,v_receipt,
      null,10000,'declined','fixture-bound-old-source');
    if v_result ->> 'result' <> 'review' then raise exception 'ATTEMPT_INTENT_OR_NEW_PAYMENT_LOST_SOURCE_BINDING'; end if;
    update pg_temp.history_receipts set expected_state = 'needs_review' where id = v_receipt;
  end loop;
  if exists(select 1 from public.payments where wompi_transaction_id = 'tx-source-unknown')
    or exists(select 1 from public.payments where wompi_transaction_id in ('tx-source-bound-attempt','tx-source-bound-intent')
      and (status <> 'pending' or approved_at is not null or provider_effective_at is not null)) then
    raise exception 'REJECTED_SOURCE_BINDING_MUTATED_PAYMENTS'; end if;
end $$;

-- A billing_version from amount/recovery is NOT a manual schedule decision.
insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000030','history-admin@example.test');
insert into public.admin_users(user_id,role) values('00000000-0000-0000-0000-000000000030','admin');
update public.subscriptions set billing_version = 1 where id = '20000000-0000-0000-0000-000000000090';
insert into public.admin_audit_logs(actor_user_id,subscription_id,action,reason,before_value,after_value,request_id,created_at)
values('00000000-0000-0000-0000-000000000030','20000000-0000-0000-0000-000000000090','amount',
  'Non-schedule fixture audit','{}','{}',gen_random_uuid(),'2026-10-01T12:00:00Z');
do $$ declare v_result jsonb; begin
  v_result := public.advance_subscription_schedule('20000000-0000-0000-0000-000000000090',1,'2026-11-16T12:00:00Z');
  if v_result ->> 'result' <> 'changed' then raise exception 'NON_MANUAL_BILLING_VERSION_BLOCKED_SCHEDULE_ADVANCE'; end if;
end $$;

-- A manual future schedule AFTER the last approval remains protected even at the current version.
update public.subscriptions set next_payment_date = '2026-12-16T12:00:00Z',billing_version = 2
where id = '20000000-0000-0000-0000-000000000090';
insert into public.admin_audit_logs(actor_user_id,subscription_id,action,reason,before_value,after_value,request_id,created_at)
values('00000000-0000-0000-0000-000000000030','20000000-0000-0000-0000-000000000090','schedule',
  'Manual future schedule fixture','{}','{"next_payment_date":"2026-12-16T12:00:00Z"}',gen_random_uuid(),'2026-10-02T12:00:00Z');
update pg_temp.history_subscription_snapshot set value = to_jsonb(s) from public.subscriptions s
where history_subscription_snapshot.id = s.id;
do $$ declare v_result jsonb; v_receipt uuid; begin
  v_result := public.advance_subscription_schedule('20000000-0000-0000-0000-000000000090',2,'2027-01-16T12:00:00Z');
  if v_result ->> 'result' <> 'protected' or v_result ->> 'reason' <> 'ADMIN_SCHEDULE_PROTECTED' then
    raise exception 'CURRENT_VERSION_OVERWROTE_PREVIOUS_ADMIN_SCHEDULE'; end if;
  v_receipt := pg_temp.history_receipt('tx-historic-10000','HPE-LEGACY');
  perform pg_temp.history_apply('manual-after-historical','tx-historic-10000','HPE-LEGACY',v_receipt,'2026-09-19T15:00:00Z');
  if exists(select 1 from pg_temp.history_subscription_snapshot b join public.subscriptions s using(id) where b.value <> to_jsonb(s)) then
    raise exception 'HISTORICAL_REPLAY_MOVED_MANUAL_FUTURE_SCHEDULE'; end if;
end $$;

-- Reactivation without a later approval is protected; a genuinely newer approval releases that guard.
insert into public.subscriptions(id,donor_id,amount,currency,status,reference,wompi_payment_source_id,next_payment_date,billing_version)
values('20000000-0000-0000-0000-000000000033','10000000-0000-0000-0000-000000000090',10000,'COP',
  'active','HPE-REACTIVATE-HISTORY','source-reactivate-history','2026-12-16T12:00:00Z',1);
insert into public.admin_audit_logs(actor_user_id,subscription_id,action,reason,before_value,after_value,request_id,created_at)
values('00000000-0000-0000-0000-000000000030','20000000-0000-0000-0000-000000000033','reactivate',
  'Reactivation schedule fixture','{}','{}',gen_random_uuid(),'2026-10-02T12:00:00Z');
do $$ declare v_result jsonb; v_receipt uuid; begin
  v_result := public.advance_subscription_schedule('20000000-0000-0000-0000-000000000033',1,'2027-01-16T12:00:00Z');
  if v_result ->> 'result' <> 'protected' or v_result ->> 'reason' <> 'ADMIN_SCHEDULE_PROTECTED' then
    raise exception 'REACTIVATION_WITHOUT_LATER_APPROVAL_WAS_NOT_PROTECTED'; end if;
  insert into public.payments(id,subscription_id,amount,currency,status,wompi_transaction_id,billing_review_required)
  values('70000000-0000-0000-0000-000000000033','20000000-0000-0000-0000-000000000033',
    10000,'COP','pending','tx-reactivate-later-approval',false);
  v_receipt := pg_temp.history_receipt('tx-reactivate-later-approval','HPE-REACTIVATE-HISTORY');
  perform pg_temp.history_apply('reactivate-later-approval','tx-reactivate-later-approval','HPE-REACTIVATE-HISTORY',
    v_receipt,'2026-11-19T15:00:00Z');
  v_result := public.advance_subscription_schedule('20000000-0000-0000-0000-000000000033',1,'2027-01-16T12:00:00Z');
  if v_result ->> 'result' <> 'changed' then raise exception 'NEW_VERIFIED_APPROVAL_DID_NOT_RELEASE_OLDER_MANUAL_GUARD'; end if;
end $$;

-- Enrichment clears date ambiguity, so a future due billing period can be claimed (never charged here).
insert into public.payment_attempts(id,subscription_id,billing_period,reference,amount,state)
values('50000000-0000-0000-0000-000000000030','20000000-0000-0000-0000-000000000090',
  '202612','HPE-LEGACY-202612',25000,'prepared');
do $$ declare v_result jsonb; begin
  v_result := public.claim_monthly_payment_attempt('50000000-0000-0000-0000-000000000030','2026-12-16T13:00:00Z');
  if v_result ->> 'result' <> 'claimed' or v_result ->> 'amount' <> '25000' or v_result ->> 'billingVersion' <> '2' then
    raise exception 'VERIFIED_HISTORICAL_PAYMENT_LEFT_MONTHLY_CLAIM_PERMANENTLY_BLOCKED'; end if;
  if exists(select 1 from pg_temp.history_receipts r join public.webhook_events e using(id)
    where e.raw <> r.raw or e.transaction_id is not null or e.event_type is not null
      or e.processing_state <> r.expected_state or e.processed_at is null) then
    raise exception 'CURRENT_HISTORICAL_RECEIPTS_NOT_PROCESSED_OR_RAW_CHANGED'; end if;
end $$;
rollback;
