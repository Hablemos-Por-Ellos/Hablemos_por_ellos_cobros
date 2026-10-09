-- LECTURA | v0.4.0 | 2026-10-08 | No provider calls, data edits, or historical classification.
begin transaction read only;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
do $$
declare missing text; t text; p record;
begin
  if to_regclass('public.payment_admin_migrations') is null or not exists(select 1
    from public.payment_admin_migrations where name = 'payment-admin-hardening-v0.3.0') then
    raise exception 'BILLING_PREFLIGHT_V1_MARKER_REQUIRED';
  end if;
  select string_agg(r.t||'.'||r.c,', ' order by r.t,r.c) into missing
  from (values
    ('subscriptions','id','uuid'),('subscriptions','donor_id','uuid'),('subscriptions','billing_version','int4'),
    ('subscriptions','amount','int4'),('subscriptions','preferred_payment_day','int4'),
    ('subscriptions','next_payment_date','timestamptz'),('subscriptions','processed_transaction_ids','_text'),
    ('checkout_intents','id','uuid'),('checkout_intents','environment','text'),('checkout_intents','is_recurring','bool'),
    ('checkout_intents','expires_at','timestamptz'),('checkout_intents','amount','int4'),
    ('payment_attempts','id','uuid'),('payment_attempts','subscription_id','uuid'),('payment_attempts','donor_id','uuid'),
    ('payment_attempts','subscription_version','int4'),('payment_attempts','amount','int4'),('payment_attempts','state','text'),
    ('payments','payment_attempt_id','uuid'),('payments','approved_at','timestamptz'),
    ('payments','provider_effective_at','timestamptz'),('payments','billing_review_required','bool'),
    ('webhook_events','raw','jsonb'),('webhook_events','processing_state','text'),('webhook_events','record_kind','text'),
    ('admin_audit_logs','request_id','uuid'),('admin_users','sessions_valid_after','timestamptz')
  ) r(t,c,typ) left join information_schema.columns col on col.table_schema = 'public'
    and col.table_name = r.t and col.column_name = r.c and col.udt_name = r.typ
  where col.column_name is null;
  if missing is not null then raise exception 'BILLING_PREFLIGHT_TYPE_OR_COLUMN_MISMATCH: %',missing; end if;
  foreach t in array array['donors','subscriptions','checkout_intents','payment_attempts','payments',
    'billing_cycles','webhook_events','admin_users','admin_audit_logs'] loop
    if t = 'billing_cycles' and to_regclass('public.billing_cycles') is null then continue; end if;
    if not exists(select 1 from pg_class where oid = to_regclass('public.'||t) and relrowsecurity)
      or not exists(select 1 from pg_index where indrelid = to_regclass('public.'||t) and indisprimary) then
      raise exception 'BILLING_PREFLIGHT_RLS_OR_PK_MISSING: %',t;
    end if;
  end loop;
  if to_regprocedure('public.assert_admin_mutation_context(uuid,text,timestamp with time zone,timestamp with time zone)') is null
    or to_regprocedure('public.is_active_admin(text[])') is null or to_regprocedure('public.mark_wompi_receipt(jsonb,text,text)') is null then
    raise exception 'BILLING_PREFLIGHT_AUTH_OR_RECEIPT_CONTRACT_MISSING';
  end if;
  if not exists(select 1 from pg_index where indexrelid = to_regclass('public.payment_attempts_subscription_period_unique')
    and indisunique and indisvalid) then raise exception 'BILLING_PREFLIGHT_MONTHLY_UNIQUENESS_MISSING'; end if;
  if exists(select 1 from public.payment_attempts where donor_id is not null and state in ('dispatching','pending','unknown')
    group by donor_id having count(*) > 1) or exists(select 1 from public.payments where wompi_transaction_id is not null
    group by wompi_transaction_id having count(*) > 1) then raise exception 'BILLING_PREFLIGHT_DUPLICATE_IDENTITY'; end if;
  if exists(select 1 from public.subscriptions where currency <> 'COP' or amount not between 1500 and 21474836
    or billing_version < 0) then raise exception 'BILLING_PREFLIGHT_INVALID_SNAPSHOT'; end if;
  if exists(select 1 from pg_policies where schemaname = 'public' and tablename in
    ('subscriptions','payments','payment_attempts','billing_cycles') and cmd <> 'SELECT') then
    raise exception 'BILLING_PREFLIGHT_UNEXPECTED_WRITE_POLICY';
  end if;
  -- An unrecognized SECURITY DEFINER financial writer would bypass table revocation.
  for p in select proname from pg_proc where pronamespace = 'public'::regnamespace and prokind = 'f' and prosecdef
    and pg_get_functiondef(oid) ~* '(insert[[:space:]]+into|update)[[:space:]]+public[.](subscriptions|payments|payment_attempts)'
    and proname not like 'billing_v2_%' and proname not in ('claim_monthly_payment_attempt','advance_subscription_schedule',
      'mark_subscription_past_due','admin_update_subscription','apply_verified_wompi_event',
      'admin_reconcile_payment_attempt','admin_close_unidentified_payment_attempt','cleanup_expired_operational_rows') loop
    raise exception 'BILLING_PREFLIGHT_UNRECOGNIZED_FINANCIAL_WRITER: %',p.proname;
  end loop;
end $$;
select 'billing-retry-v0.4.0' as target,
  (select count(*) from public.subscriptions) as subscriptions,
  (select count(*) from public.payment_attempts where state in ('dispatching','pending','unknown')) as unresolved_attempts,
  (select count(*) from public.webhook_events where processing_state in ('received','failed','needs_review')) as receipts_to_review,
  (select count(*) from public.payments where status = 'approved' and approved_at is null) as undated_approvals;
-- Counts describe preserved cases, not permission to activate or charge them.
commit;
