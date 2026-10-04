-- LECTURA | v0.3.0 | 2026-10-03. Run with ON_ERROR_STOP, in the runner's digest session.
begin transaction read only;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare v_table text; v_role text; v_rpc record;
begin
  if coalesce(current_setting('app.migration_digest', true), '') !~ '^[0-9a-fA-F]{64}$'
    or not public.payment_admin_schema_ready()
    or not exists (select 1 from public.payment_admin_migrations
      where name = 'payment-admin-hardening-v0.3.0' and digest = lower(current_setting('app.migration_digest'))) then
    raise exception 'POSTFLIGHT_MIGRATION_MARKER_INVALID';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'payments' and column_name = 'provider_effective_at'
    and is_nullable = 'YES' and column_default is null) then
    raise exception 'POSTFLIGHT_PAYMENT_DATE_MUST_REMAIN_NULLABLE_WITHOUT_DEFAULT';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'admin_users' and column_name = 'sessions_valid_after'
    and udt_name = 'timestamptz' and is_nullable = 'NO'
    and column_default like '%1970-01-01%') then
    raise exception 'POSTFLIGHT_SESSION_REVOCATION_COLUMN_INVALID';
  end if;
  if to_regprocedure('public.admin_revoke_own_sessions(uuid,timestamptz)') is null
    or not exists (select 1 from pg_proc where oid = 'public.admin_revoke_own_sessions(uuid,timestamptz)'::regprocedure
      and prorettype = 'boolean'::regtype and prosecdef and pronargs = 2
      and proargnames = array['p_actor_user_id','p_actor_session_issued_at']::text[]) then
    raise exception 'POSTFLIGHT_SESSION_REVOCATION_RPC_INVALID';
  end if;
  if exists (select 1 from (values
    ('token_hash_digest','text','NO'), ('user_id','uuid','NO'), ('recipient_email','text','NO'),
    ('issued_at','timestamptz','NO'), ('expires_at','timestamptz','NO'),
    ('consumed_at','timestamptz','YES'), ('consumed_session_id','uuid','YES')
  ) r(column_name, udt_name, nullable) where not exists (select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'admin_invitations'
      and c.column_name = r.column_name and c.udt_name = r.udt_name and c.is_nullable = r.nullable))
    or not exists (select 1 from pg_constraint where conrelid = 'public.admin_invitations'::regclass
      and contype = 'p' and pg_get_constraintdef(oid) = 'PRIMARY KEY (token_hash_digest)')
    or not exists (select 1 from pg_constraint where conrelid = 'public.admin_invitations'::regclass
      and contype = 'f' and confrelid = 'auth.users'::regclass
      and pg_get_constraintdef(oid) like 'FOREIGN KEY (user_id)%')
    or not exists (select 1 from pg_constraint where conrelid = 'public.admin_invitations'::regclass
      and conname = 'admin_invitations_valid_window' and contype = 'c' and convalidated)
    or not exists (select 1 from pg_constraint where conrelid = 'public.admin_invitations'::regclass
      and conname = 'admin_invitations_consumption_pair' and contype = 'c' and convalidated)
    or to_regclass('public.admin_invitations_user_session_unique') is null
    or to_regprocedure('public.admin_consume_invitation(text,uuid,uuid)') is null then
    raise exception 'POSTFLIGHT_INVITATION_SCHEMA_INVALID';
  end if;
  foreach v_role in array array['anon','authenticated'] loop
    if has_any_column_privilege(v_role,'public.admin_invitations','SELECT')
      or has_any_column_privilege(v_role,'public.admin_invitations','INSERT')
      or has_any_column_privilege(v_role,'public.admin_invitations','UPDATE') then
      raise exception 'POSTFLIGHT_INVITATION_CLIENT_PRIVILEGE: %', v_role;
    end if;
  end loop;
  if not has_table_privilege('service_role','public.admin_invitations','SELECT')
    or not has_column_privilege('service_role','public.admin_invitations','token_hash_digest','INSERT')
    or has_any_column_privilege('service_role','public.admin_invitations','UPDATE')
    or has_column_privilege('service_role','public.admin_invitations','consumed_at','INSERT')
    or has_column_privilege('service_role','public.admin_invitations','consumed_session_id','INSERT')
    or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'admin_invitations') then
    raise exception 'POSTFLIGHT_INVITATION_CONSUMPTION_BOUNDARY_INVALID';
  end if;
  if exists (select 1 from public.webhook_events where event_key is null
    or processing_state not in ('received','processed','legacy_applied','needs_review','unlinked','failed')
    or record_kind not in ('legacy','receipt','canonical')) then
    raise exception 'POSTFLIGHT_EVENT_METADATA_INVALID';
  end if;
  if exists (select 1 from public.webhook_events where record_kind = 'receipt'
    and (raw ->> 'receipt_version' is distinct from '1' or transaction_id is not null or event_type is not null
      or event_key <> 'receipt:' || id::text)) then
    raise exception 'POSTFLIGHT_RECEIPT_IDENTITY_INVALID';
  end if;
  if exists (select 1 from public.payments where status = 'approved'
    and coalesce(approved_at, provider_effective_at) is null and not billing_review_required) then
    raise exception 'POSTFLIGHT_UNDATED_APPROVAL_NOT_BLOCKED';
  end if;
  if to_regclass('public.idx_webhook_events_unique') is not null
    or to_regclass('public.idx_webhook_events_raw_unique') is not null
    or not exists (select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'webhook_events_event_key_unique' and indexdef like '%WHERE (record_kind = ''canonical''%')
    or not exists (select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'webhook_events_receipt_id_unique' and indexdef like '%WHERE (record_kind = ''receipt''%') then
    raise exception 'POSTFLIGHT_EVENT_UNIQUENESS_NOT_PARTITIONED';
  end if;
  foreach v_table in array array['donors','subscriptions','payments','webhook_events','audit_logs',
    'admin_users','admin_invitations','admin_audit_logs','checkout_intents','payment_attempts','api_rate_limits','payment_admin_migrations'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity) then
      raise exception 'POSTFLIGHT_RLS_DISABLED: %', v_table;
    end if;
    foreach v_role in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(v_role, 'public.' || v_table, 'DELETE')
        or has_table_privilege(v_role, 'public.' || v_table, 'TRUNCATE') then
        raise exception 'POSTFLIGHT_DESTRUCTIVE_PRIVILEGE: % %', v_role, v_table;
      end if;
    end loop;
  end loop;
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(v_role, 'public', 'CREATE') then
      raise exception 'POSTFLIGHT_SCHEMA_CREATE_PRIVILEGE: %', v_role;
    end if;
  end loop;
  if has_table_privilege('anon','public.payment_admin_migrations','SELECT')
    or has_table_privilege('authenticated','public.payment_admin_migrations','SELECT')
    or not has_table_privilege('service_role','public.payment_admin_migrations','SELECT')
    or has_table_privilege('service_role','public.payment_admin_migrations','INSERT')
    or has_table_privilege('service_role','public.payment_admin_migrations','UPDATE')
    or has_column_privilege('authenticated','public.subscriptions','wompi_payment_source_id','SELECT') then
    raise exception 'POSTFLIGHT_LEDGER_OR_SOURCE_PRIVILEGE_INVALID';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and
    ((tablename = 'donors' and policyname = 'admin_read_donors')
    or (tablename = 'subscriptions' and policyname = 'admin_read_subscriptions')
    or (tablename = 'payments' and policyname = 'admin_read_payments')
    or (tablename = 'admin_users' and policyname = 'admin_read_admin_users')
    or (tablename = 'admin_audit_logs' and policyname = 'admin_read_audit')
    or (tablename = 'payment_attempts' and policyname = 'admin_read_payment_attempts'))) <> 6 then
    raise exception 'POSTFLIGHT_ADMIN_POLICIES_MISSING';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
    and tablename in ('donors','subscriptions','payments','webhook_events','audit_logs',
      'admin_users','admin_invitations','admin_audit_logs','checkout_intents','payment_attempts','api_rate_limits','payment_admin_migrations')
    and (cmd <> 'SELECT' or roles <> array['authenticated']::name[]
      or qual not like '%is_active_admin%')) then
    raise exception 'POSTFLIGHT_UNSAFE_POLICY';
  end if;
  for v_rpc in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('payment_admin_schema_ready','admin_consume_invitation','assert_admin_mutation_context','admin_revoke_own_sessions',
      'mark_wompi_receipt','consume_api_rate_limit','claim_monthly_payment_attempt','advance_subscription_schedule',
      'mark_subscription_past_due','cleanup_expired_operational_rows','admin_update_subscription',
      'apply_verified_wompi_event','admin_reconcile_payment_attempt','admin_close_unidentified_payment_attempt') loop
    if has_function_privilege('anon', v_rpc.oid, 'EXECUTE')
      or has_function_privilege('authenticated', v_rpc.oid, 'EXECUTE')
      or not has_function_privilege('service_role', v_rpc.oid, 'EXECUTE') then
      raise exception 'POSTFLIGHT_RPC_PRIVILEGE_INVALID: %', v_rpc.proname;
    end if;
  end loop;
end $$;

select name, digest, applied_at from public.payment_admin_migrations
where name = 'payment-admin-hardening-v0.3.0';
select record_kind, processing_state, count(*) as event_count from public.webhook_events
group by record_kind, processing_state order by record_kind, processing_state;
select count(*) filter (where status = 'approved' and coalesce(approved_at, provider_effective_at) is null) as undated_approvals,
  count(*) filter (where billing_review_required) as blocked_payments from public.payments;
commit;
