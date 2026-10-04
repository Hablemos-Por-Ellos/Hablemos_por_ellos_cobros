-- LECTURA | v0.3.0 | 2026-10-03. Base schema only; no new-column prerequisite.
-- Run with ON_ERROR_STOP. Exceptions are blocking gates, not advisory SELECTs.
begin transaction read only;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare v_missing text; v_table text;
begin
  select string_agg(r.table_name || '.' || r.column_name, ', ' order by r.table_name, r.column_name)
  into v_missing
  from (values
    ('donors','id'), ('donors','email'), ('donors','first_name'), ('donors','last_name'),
    ('donors','phone'), ('donors','document_type'), ('donors','document_number'), ('donors','city'),
    ('donors','wants_updates'), ('donors','created_at'), ('donors','updated_at'),
    ('subscriptions','id'), ('subscriptions','donor_id'), ('subscriptions','amount'),
    ('subscriptions','currency'), ('subscriptions','frequency'), ('subscriptions','status'),
    ('subscriptions','payment_method_type'), ('subscriptions','wompi_payment_source_id'),
    ('subscriptions','wompi_masked_details'), ('subscriptions','reference'),
    ('subscriptions','created_at'), ('subscriptions','cancelled_at'), ('subscriptions','next_payment_date'),
    ('payments','id'), ('payments','subscription_id'), ('payments','amount'), ('payments','currency'),
    ('payments','status'), ('payments','wompi_transaction_id'), ('payments','created_at'), ('payments','updated_at'),
    ('webhook_events','id'), ('webhook_events','transaction_id'), ('webhook_events','event_type'),
    ('webhook_events','raw'), ('webhook_events','created_at'),
    ('audit_logs','id'), ('audit_logs','action'), ('audit_logs','subscription_id'),
    ('audit_logs','donor_id'), ('audit_logs','details'), ('audit_logs','created_at')
  ) r(table_name, column_name)
  where not exists (select 1 from information_schema.columns c where c.table_schema = 'public'
    and c.table_name = r.table_name and c.column_name = r.column_name);
  if v_missing is not null then raise exception 'PREFLIGHT_REQUIRED_SCHEMA_MISSING: %', v_missing; end if;
  if to_regclass('auth.users') is null or to_regprocedure('auth.uid()') is null
    or to_regprocedure('auth.jwt()') is null then
    raise exception 'PREFLIGHT_AUTH_SCHEMA_MISSING';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and (
    (table_name in ('donors','subscriptions','payments','webhook_events','audit_logs') and column_name = 'id' and udt_name <> 'uuid')
    or (table_name in ('subscriptions','payments') and column_name = 'amount' and udt_name <> 'int4')
    or (table_name = 'webhook_events' and column_name = 'raw' and udt_name <> 'jsonb')
    or (table_name = 'subscriptions' and column_name = 'donor_id' and udt_name <> 'uuid')
    or (table_name = 'payments' and column_name = 'subscription_id' and udt_name <> 'uuid')
  )) then raise exception 'PREFLIGHT_REQUIRED_SCHEMA_TYPE_MISMATCH'; end if;
  foreach v_table in array array['donors','subscriptions','payments','webhook_events','audit_logs'] loop
    if not exists (select 1 from pg_index i where i.indrelid = to_regclass('public.' || v_table) and i.indisprimary) then
      raise exception 'PREFLIGHT_PRIMARY_KEY_MISSING: %', v_table;
    end if;
  end loop;
  if exists (select 1 from public.subscriptions where reference is not null group by reference having count(*) > 1)
    or exists (select 1 from public.payments where wompi_transaction_id is not null group by wompi_transaction_id having count(*) > 1)
    or exists (select 1 from public.donors group by lower(btrim(email)) having count(*) > 1) then
    raise exception 'PREFLIGHT_DUPLICATE_IDENTITY: preserve records; resolve explicitly before migration';
  end if;
  if exists (select 1 from public.subscriptions s left join public.donors d on d.id = s.donor_id where d.id is null)
    or exists (select 1 from public.payments p left join public.subscriptions s on s.id = p.subscription_id
      where p.subscription_id is not null and s.id is null)
    or exists (select 1 from public.audit_logs a left join public.subscriptions s on s.id = a.subscription_id
      where a.subscription_id is not null and s.id is null)
    or exists (select 1 from public.audit_logs a left join public.donors d on d.id = a.donor_id
      where a.donor_id is not null and d.id is null) then
    raise exception 'PREFLIGHT_ORPHAN_RECORD';
  end if;
  if exists (select 1 from public.subscriptions s where amount is null or amount not between 1500 and 21474836
    or ((to_jsonb(s) ->> 'preferred_payment_day') is not null
      and (to_jsonb(s) ->> 'preferred_payment_day') not in ('1','6','16','28'))) then
    raise exception 'PREFLIGHT_INVALID_SUBSCRIPTION_AMOUNT_OR_DAY';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
    and tablename in ('donors','subscriptions','payments','webhook_events','audit_logs',
      'admin_users','admin_invitations','admin_audit_logs','checkout_intents','payment_attempts','api_rate_limits','payment_admin_migrations')
    and not ((tablename = 'donors' and policyname = 'admin_read_donors')
      or (tablename = 'subscriptions' and policyname = 'admin_read_subscriptions')
      or (tablename = 'payments' and policyname = 'admin_read_payments')
      or (tablename = 'admin_users' and policyname = 'admin_read_admin_users')
      or (tablename = 'admin_audit_logs' and policyname = 'admin_read_audit')
      or (tablename = 'payment_attempts' and policyname = 'admin_read_payment_attempts'))) then
    raise exception 'PREFLIGHT_UNREVIEWED_RLS_POLICY';
  end if;
end $$;

-- Missing dates, NULL legacy payment fields and missing new columns are not migration failures.
select 'legacy_rows' as check_name,
  (select count(*) from public.donors) as donors,
  (select count(*) from public.subscriptions) as subscriptions,
  (select count(*) from public.payments) as payments,
  (select count(*) from public.webhook_events where raw ->> 'receipt_version' = '1') as receipts,
  (select count(*) from public.webhook_events where coalesce(raw ->> 'receipt_version','') <> '1') as historic_events;

select table_name, column_name, udt_name, is_nullable from information_schema.columns
where table_schema = 'public' and table_name in ('donors','subscriptions','payments','webhook_events','audit_logs')
order by table_name, ordinal_position;
commit;
