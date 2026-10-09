-- LECTURA | v0.4.0 | 2026-10-08 | Preservation of content is asserted inside migration.
begin transaction read only;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
do $$
declare t text; c text; p record;
begin
  if not public.billing_retry_schema_ready() then raise exception 'BILLING_POSTFLIGHT_MARKER_MISSING'; end if;
  if coalesce(current_setting('app.billing_retry_migration_digest',true),'') ~ '^[0-9a-fA-F]{64}$'
    and not exists(select 1 from public.payment_admin_migrations where name = 'billing-retry-v0.4.0'
      and digest = lower(current_setting('app.billing_retry_migration_digest',true))) then raise exception 'BILLING_POSTFLIGHT_DIGEST_MISMATCH'; end if;
  foreach t in array array['subscriptions','payments','payment_attempts','billing_cycles'] loop
    if not exists(select 1 from pg_class where oid = to_regclass('public.'||t) and relrowsecurity) then
      raise exception 'BILLING_POSTFLIGHT_RLS_MISSING: %',t;
    end if;
    if has_table_privilege('service_role','public.'||t,'INSERT') or has_table_privilege('service_role','public.'||t,'UPDATE')
      or has_table_privilege('service_role','public.'||t,'DELETE') or has_table_privilege('authenticated','public.'||t,'INSERT')
      or has_table_privilege('anon','public.'||t,'UPDATE') then raise exception 'BILLING_POSTFLIGHT_DIRECT_WRITER: %',t; end if;
    for c in select attname from pg_attribute where attrelid = to_regclass('public.'||t) and attnum > 0 and not attisdropped loop
      if has_column_privilege('service_role','public.'||t,c,'INSERT') or has_column_privilege('service_role','public.'||t,c,'UPDATE') then
        raise exception 'BILLING_POSTFLIGHT_COLUMN_WRITER: %.%',t,c;
      end if;
    end loop;
  end loop;
  for p in select oid::regprocedure as signature,proname from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('claim_monthly_payment_attempt','advance_subscription_schedule','mark_subscription_past_due',
      'admin_update_subscription','admin_reconcile_payment_attempt','admin_close_unidentified_payment_attempt','cleanup_expired_operational_rows') loop
    if has_function_privilege('service_role',p.signature,'EXECUTE') or has_function_privilege('authenticated',p.signature,'EXECUTE')
      or has_function_privilege('anon',p.signature,'EXECUTE') then raise exception 'BILLING_POSTFLIGHT_OLD_RPC_WRITER: %',p.proname; end if;
  end loop;
  if has_column_privilege('authenticated','public.billing_cycles','payment_source_id','SELECT')
    or has_column_privilege('authenticated','public.billing_cycles','authorization_snapshot','SELECT')
    or has_column_privilege('authenticated','public.payment_attempts','dispatch_snapshot','SELECT')
    or has_column_privilege('authenticated','public.payment_attempts','verified_evidence','SELECT')
    or has_column_privilege('authenticated','public.subscriptions','billing_authorization','SELECT') then
    raise exception 'BILLING_POSTFLIGHT_PRIVATE_EVIDENCE_VISIBLE';
  end if;
  if not has_function_privilege('service_role','public.billing_v2_reserve_original(uuid,bigint)','EXECUTE')
    or not has_function_privilege('service_role','public.billing_v2_authorize_send(uuid,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.billing_v2_apply_result(uuid,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.billing_v2_admin_recovery_replay(uuid,uuid,text,uuid,text,integer,text,timestamptz,timestamptz)','EXECUTE')
    or has_function_privilege('authenticated','public.billing_v2_admin_recovery_replay(uuid,uuid,text,uuid,text,integer,text,timestamptz,timestamptz)','EXECUTE')
    or has_function_privilege('authenticated','public.billing_v2_apply_result(uuid,jsonb)','EXECUTE') then
    raise exception 'BILLING_POSTFLIGHT_V2_RPC_PERMISSIONS';
  end if;
  if not exists(select 1 from pg_indexes where schemaname = 'public' and indexname = 'payment_attempts_subscription_period_unique'
    and indexdef like '%cycle_id IS NULL%') then raise exception 'BILLING_POSTFLIGHT_LEGACY_INDEX_PREDICATE'; end if;
  if exists(select 1 from public.billing_cycles c join public.payment_attempts a on a.cycle_id = c.id
    where a.subscription_id <> c.subscription_id or a.donor_id <> c.donor_id or a.billing_period <> c.billing_period
      or a.amount <> c.amount or a.currency <> c.currency or a.subscription_version <> c.subscription_version) then
    raise exception 'BILLING_POSTFLIGHT_CYCLE_ATTEMPT_IDENTITY';
  end if;
end $$;
select name,digest,applied_at from public.payment_admin_migrations where name = 'billing-retry-v0.4.0';
select count(*) as cycles,count(*) filter(where state = 'retry_wait') as retry_wait,
  count(*) filter(where state = 'manual_review') as manual_review from public.billing_cycles;
commit;
