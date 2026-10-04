-- v0.3.0 | 2026-10-03 | Local, unapplied. Preserve legacy data; fail closed on unknown dates.
-- 2026-10-03: Add single-use, UUID/session-bound administrative invitation consumption.
-- 2026-10-03: Fix snapshot ANY guards to select scalar booleans, avoiding SQLSTATE 22P02.
-- 2026-10-03: Recover verified status transitions, serialize authorization and revoke own sessions.
-- 2026-10-03: Enrich verified historical payments without replay; protect audited manual schedules.
-- 2026-10-03: Resolve undated verified non-approved terminals; retain TX-bound historical source evidence.
-- The parent runner must set app.migration_digest to this file's SHA-256 in the SAME session.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

create extension if not exists pgcrypto;

do $$
begin
  if coalesce(current_setting('app.migration_digest', true), '') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'MIGRATION_DIGEST_REQUIRED: set app.migration_digest in the runner session';
  end if;
end $$;

select pg_advisory_xact_lock(hashtextextended('payment_admin_hardening_v0.3.0', 0));

create table if not exists public.payment_admin_migrations (
  name text primary key,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1 from public.payment_admin_migrations
    where name = 'payment-admin-hardening-v0.3.0'
      and digest <> lower(current_setting('app.migration_digest'))
  ) then
    raise exception 'MIGRATION_DIGEST_MISMATCH: previously applied file has a different digest';
  end if;
end $$;

-- A same-digest reapply snapshots ALL then-current columns, not just a fixed legacy subset.
create temporary table payment_admin_original_schema (
  table_name text primary key,
  columns text[] not null,
  primary_columns text[] not null,
  row_count bigint not null,
  content_digest text not null
) on commit drop;
create temporary table payment_admin_original_rows (
  table_name text not null,
  primary_value jsonb not null,
  content jsonb not null,
  primary key (table_name, primary_value)
) on commit drop;

do $$
declare
  v_table text;
  v_columns text[];
  v_primary text[];
  v_count bigint;
  v_digest text;
begin
  foreach v_table in array array[
    'donors', 'subscriptions', 'payments', 'webhook_events', 'audit_logs',
    'admin_users', 'admin_invitations', 'admin_audit_logs', 'checkout_intents', 'payment_attempts', 'api_rate_limits'
  ] loop
    if to_regclass('public.' || v_table) is null then
      if v_table = any(array['donors', 'subscriptions', 'payments', 'webhook_events', 'audit_logs']) then
        raise exception 'REQUIRED_TABLE_MISSING: %', v_table;
      end if;
      continue;
    end if;
    execute format('lock table public.%I in share row exclusive mode', v_table);
    select array_agg(attname::text order by attnum) into v_columns
    from pg_attribute where attrelid = to_regclass('public.' || v_table)
      and attnum > 0 and not attisdropped;
    select array_agg(a.attname::text order by k.ordinality) into v_primary
    from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, ordinality)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indrelid = to_regclass('public.' || v_table) and i.indisprimary;
    if v_primary is null then raise exception 'REQUIRED_PRIMARY_KEY_MISSING: %', v_table; end if;
    execute format(
      'insert into pg_temp.payment_admin_original_rows select %L,
       (select jsonb_object_agg(k, to_jsonb(t) -> k) from unnest($1) k), to_jsonb(t)
       from public.%I t', v_table, v_table
    ) using v_primary;
    select count(*), encode(sha256(convert_to(coalesce(
      string_agg(content::text, E'\n' order by primary_value::text), ''), 'UTF8')), 'hex')
    into v_count, v_digest from pg_temp.payment_admin_original_rows where table_name = v_table;
    insert into pg_temp.payment_admin_original_schema
    values (v_table, v_columns, v_primary, v_count, v_digest);
  end loop;
end $$;

do $$
declare v_missing text;
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
  if v_missing is not null then raise exception 'REQUIRED_SCHEMA_MISSING: %', v_missing; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and (
    (table_name = any(array['donors','subscriptions','payments','webhook_events','audit_logs']) and column_name = 'id' and udt_name <> 'uuid')
    or (table_name in ('subscriptions','payments') and column_name = 'amount' and udt_name <> 'int4')
    or (table_name = 'webhook_events' and column_name = 'raw' and udt_name <> 'jsonb')
    or (table_name = 'subscriptions' and column_name = 'donor_id' and udt_name <> 'uuid')
    or (table_name = 'payments' and column_name = 'subscription_id' and udt_name <> 'uuid')
  )) then
    raise exception 'REQUIRED_SCHEMA_TYPE_MISMATCH';
  end if;
end $$;

alter table public.donors
  add column if not exists email_normalized text
  generated always as (lower(btrim(email))) stored;

alter table public.subscriptions
  add column if not exists preferred_payment_day integer,
  add column if not exists processed_transaction_ids text[] not null default '{}',
  add column if not exists billing_version integer not null default 0,
  add column if not exists schedule_updated_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Existing NULL arrays are evidence, not an excuse to rewrite a legacy column.

alter table public.subscriptions
  drop constraint if exists subscriptions_preferred_payment_day_check;

alter table public.subscriptions
  drop constraint if exists subscriptions_amount_check;

alter table public.subscriptions
  add constraint subscriptions_preferred_payment_day_check
  check (preferred_payment_day in (1, 6, 16, 28) or preferred_payment_day is null),
  add constraint subscriptions_amount_check
  check (amount between 1500 and 21474836) not valid;

alter table public.subscriptions
  validate constraint subscriptions_amount_check;

alter table public.payments
  add column if not exists approved_at timestamptz,
  add column if not exists provider_effective_at timestamptz,
  add column if not exists reference text,
  add column if not exists payment_attempt_id uuid,
  add column if not exists billing_review_required boolean not null default false;

alter table public.payments
  alter column provider_effective_at drop default,
  alter column provider_effective_at drop not null;

-- Only an existing finite approved_at is trusted here. Historic RAW has no stored
-- signature-verification evidence: neither its event timestamp nor finalized_at is inferred.
do $$
begin
  if not coalesce((select 'provider_effective_at' = any(columns)
    from pg_temp.payment_admin_original_schema where table_name = 'payments'), false) then
    update public.payments set provider_effective_at = approved_at
    where status = 'approved' and approved_at is not null and isfinite(approved_at)
      and approved_at >= timestamptz '1970-01-01 00:00:00+00';
  end if;
  if not coalesce((select 'billing_review_required' = any(columns)
    from pg_temp.payment_admin_original_schema where table_name = 'payments'), false) then
    update public.payments set billing_review_required = true
    where status is null or status = 'pending' or (status = 'approved'
      and (approved_at is null or not isfinite(approved_at) or approved_at < timestamptz '1970-01-01 00:00:00+00'));
  end if;
end $$;

alter table public.webhook_events
  add column if not exists event_key text,
  add column if not exists processing_state text not null default 'received',
  add column if not exists processed_at timestamptz,
  add column if not exists last_error text,
  add column if not exists record_kind text not null default 'legacy';

do $$
begin
  if not coalesce((select 'event_key' = any(columns)
    from pg_temp.payment_admin_original_schema where table_name = 'webhook_events'), false) then
    update public.webhook_events set event_key = case when raw ->> 'receipt_version' = '1'
      then 'receipt:' || id::text else 'legacy:' || id::text end;
  end if;
  if not coalesce((select 'record_kind' = any(columns)
    from pg_temp.payment_admin_original_schema where table_name = 'webhook_events'), false) then
    update public.webhook_events set record_kind = case when raw ->> 'receipt_version' = '1'
      then 'receipt' else 'legacy' end;
  end if;
  if not coalesce((select 'processing_state' = any(columns)
    from pg_temp.payment_admin_original_schema where table_name = 'webhook_events'), false) then
    update public.webhook_events e set processing_state = case
      when e.raw ->> 'receipt_version' = '1' then 'received'
      when exists (
        select 1 from public.payments p join public.subscriptions s on s.id = p.subscription_id
        where p.wompi_transaction_id = coalesce(e.transaction_id, e.raw ->> 'transaction_id',
          e.raw #>> '{transaction,id}', e.raw #>> '{data,transaction,id}')
          and p.status in ('approved','declined','error','voided')
          and p.wompi_transaction_id = any(coalesce(s.processed_transaction_ids, '{}'))
      ) then 'legacy_applied'
      else 'needs_review' end;
  end if;
end $$;

alter table public.webhook_events
  alter column event_key set default ('legacy:' || gen_random_uuid()::text),
  alter column event_key set not null;

alter table public.webhook_events
  drop constraint if exists webhook_events_processing_state_check;

alter table public.webhook_events
  add constraint webhook_events_processing_state_check
  check (processing_state in ('received', 'processed', 'legacy_applied', 'needs_review', 'unlinked', 'failed'));

alter table public.webhook_events
  drop constraint if exists webhook_events_record_kind_check;
alter table public.webhook_events
  add constraint webhook_events_record_kind_check check (record_kind in ('legacy', 'receipt', 'canonical'));

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'super_admin')),
  active boolean not null default true,
  sessions_valid_after timestamptz not null default timestamptz '1970-01-01 00:00:00+00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_users
  add column if not exists sessions_valid_after timestamptz not null default timestamptz '1970-01-01 00:00:00+00';

create table if not exists public.admin_invitations (
  token_hash_digest text primary key check (token_hash_digest ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id),
  recipient_email text not null check (recipient_email = btrim(recipient_email)
    and recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_session_id uuid,
  constraint admin_invitations_valid_window check (isfinite(issued_at) and isfinite(expires_at)
    and expires_at > issued_at and expires_at <= issued_at + interval '1 hour'),
  constraint admin_invitations_consumption_pair check (
    (consumed_at is null and consumed_session_id is null)
    or (consumed_at is not null and consumed_session_id is not null and isfinite(consumed_at)
      and consumed_at >= issued_at and consumed_at < expires_at))
);
create unique index if not exists admin_invitations_user_session_unique
  on public.admin_invitations(user_id, consumed_session_id) where consumed_session_id is not null;

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id),
  subscription_id uuid references public.subscriptions(id),
  action text not null,
  reason text not null,
  before_value jsonb not null,
  after_value jsonb not null,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique (actor_user_id, request_id)
);

alter table public.admin_audit_logs
  add column if not exists expected_version integer,
  add column if not exists actor_aal text,
  add column if not exists actor_session_issued_at timestamptz,
  add column if not exists totp_verified_at timestamptz;

create table if not exists public.checkout_intents (
  id uuid primary key default gen_random_uuid(),
  donor_id uuid not null references public.donors(id),
  reference text not null unique,
  secret_hash text not null unique,
  amount integer not null check (amount between 1500 and 21474836),
  currency text not null default 'COP' check (currency = 'COP'),
  is_recurring boolean not null,
  preferred_payment_day integer check (preferred_payment_day in (1, 6, 16, 28) or preferred_payment_day is null),
  payment_method_type text,
  environment text not null check (environment in ('sandbox', 'prod')),
  state text not null default 'draft' check (state in ('draft', 'checkout', 'processing', 'completed', 'expired', 'failed')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  checkout_intent_id uuid references public.checkout_intents(id),
  donor_id uuid references public.donors(id),
  subscription_id uuid references public.subscriptions(id),
  billing_period text,
  reference text not null unique,
  amount integer not null check (amount between 1500 and 21474836),
  currency text not null default 'COP' check (currency = 'COP'),
  subscription_version integer,
  state text not null check (state in ('prepared', 'dispatching', 'pending', 'approved', 'declined', 'failed', 'unknown')),
  wompi_transaction_id text,
  provider_status text,
  error_code text,
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payment_attempts
  add column if not exists donor_id uuid;

alter table public.payment_attempts
  drop constraint if exists payment_attempts_donor_id_fkey;
alter table public.payment_attempts
  add constraint payment_attempts_donor_id_fkey
  foreign key (donor_id) references public.donors(id);

alter table public.payment_attempts
  drop constraint if exists payment_attempts_checkout_intent_id_fkey;
alter table public.payment_attempts
  add constraint payment_attempts_checkout_intent_id_fkey
  foreign key (checkout_intent_id) references public.checkout_intents(id) on delete set null;

-- Do not backfill donor_id on a pre-existing attempts table: preserve all its old columns.

create table if not exists public.api_rate_limits (
  scope text not null,
  key_hash text not null,
  window_start timestamptz not null,
  request_count integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (scope, key_hash)
);

alter table public.payments
  drop constraint if exists payments_payment_attempt_id_fkey;

alter table public.payments
  add constraint payments_payment_attempt_id_fkey
  foreign key (payment_attempt_id) references public.payment_attempts(id);

do $$
begin
  if exists (
    select 1 from public.subscriptions where reference is not null
    group by reference having count(*) > 1
  ) then
    raise exception 'Duplicate subscriptions.reference values must be reconciled before this migration';
  end if;

  if exists (
    select 1 from public.donors
    group by lower(btrim(email)) having count(*) > 1
  ) then
    raise exception 'Donor emails that differ only by case must be reconciled before this migration';
  end if;

  if exists (
    select 1 from public.payments where wompi_transaction_id is not null
    group by wompi_transaction_id having count(*) > 1
  ) then
    raise exception 'Duplicate payments.wompi_transaction_id values must be reconciled before this migration';
  end if;

  if exists (
    select 1 from public.payment_attempts
    where donor_id is not null and state in ('dispatching', 'pending', 'unknown')
    group by donor_id having count(*) > 1
  ) then
    raise exception 'A donor has more than one unresolved payment attempt';
  end if;
end $$;

create unique index if not exists subscriptions_reference_unique
  on public.subscriptions(reference) where reference is not null;
create unique index if not exists donors_email_normalized_unique
  on public.donors(email_normalized);
create unique index if not exists payments_wompi_transaction_unique
  on public.payments(wompi_transaction_id) where wompi_transaction_id is not null;
drop index if exists public.payments_reference_unique;
drop index if exists public.payments_payment_attempt_unique;
create unique index if not exists payment_attempts_wompi_transaction_unique
  on public.payment_attempts(wompi_transaction_id) where wompi_transaction_id is not null;
create unique index if not exists payment_attempts_checkout_intent_unique
  on public.payment_attempts(checkout_intent_id) where checkout_intent_id is not null;
create unique index if not exists payment_attempts_subscription_period_unique
  on public.payment_attempts(subscription_id, billing_period)
  where subscription_id is not null and billing_period is not null;
create unique index if not exists payment_attempts_donor_unresolved_unique
  on public.payment_attempts(donor_id)
  where donor_id is not null and state in ('dispatching', 'pending', 'unknown');
drop index if exists public.idx_webhook_events_unique;
drop index if exists public.idx_webhook_events_raw_unique;
drop index if exists public.webhook_events_event_key_unique;
create unique index webhook_events_event_key_unique
  on public.webhook_events(event_key) where record_kind = 'canonical';
create unique index if not exists webhook_events_receipt_id_unique
  on public.webhook_events(event_key) where record_kind = 'receipt';
create index if not exists checkout_intents_expires_idx on public.checkout_intents(expires_at);
create index if not exists payment_attempts_state_idx on public.payment_attempts(state, updated_at);

alter table public.admin_users enable row level security;
alter table public.admin_invitations enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.checkout_intents enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.api_rate_limits enable row level security;
alter table public.donors enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
alter table public.webhook_events enable row level security;
alter table public.audit_logs enable row level security;
alter table public.payment_admin_migrations enable row level security;

revoke create on schema public from public, anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'donors', 'subscriptions', 'payments', 'webhook_events', 'audit_logs',
        'admin_users', 'admin_invitations', 'admin_audit_logs', 'checkout_intents', 'payment_attempts', 'api_rate_limits', 'payment_admin_migrations'
      )
      and not (
        (tablename = 'donors' and policyname = 'admin_read_donors')
        or (tablename = 'subscriptions' and policyname = 'admin_read_subscriptions')
        or (tablename = 'payments' and policyname = 'admin_read_payments')
        or (tablename = 'admin_users' and policyname = 'admin_read_admin_users')
        or (tablename = 'admin_audit_logs' and policyname = 'admin_read_audit')
        or (tablename = 'payment_attempts' and policyname = 'admin_read_payment_attempts')
      )
  ) then
    raise exception 'Unexpected RLS policies detected. Review and reconcile them before applying this migration.';
  end if;
end $$;

revoke all on table public.donors, public.subscriptions, public.payments, public.webhook_events,
  public.audit_logs, public.admin_users, public.admin_audit_logs, public.checkout_intents,
  public.payment_attempts, public.api_rate_limits, public.payment_admin_migrations, public.admin_invitations from public, anon, authenticated, service_role;

grant select on table public.payment_admin_migrations to service_role;

do $$
declare v_table text; v_columns text;
begin
  foreach v_table in array array['donors','subscriptions','payments','webhook_events','audit_logs',
    'admin_users','admin_invitations','admin_audit_logs','checkout_intents','payment_attempts','api_rate_limits','payment_admin_migrations'] loop
    select string_agg(quote_ident(attname), ', ' order by attnum) into v_columns
    from pg_attribute where attrelid = to_regclass('public.' || v_table) and attnum > 0 and not attisdropped;
    execute format('revoke select (%1$s), insert (%1$s), update (%1$s), references (%1$s)
      on public.%2$I from public, anon, authenticated, service_role', v_columns, v_table);
  end loop;
end $$;

grant select, insert, update on table public.donors, public.subscriptions, public.payments,
  public.audit_logs, public.admin_users, public.admin_audit_logs,
  public.checkout_intents, public.payment_attempts, public.api_rate_limits to service_role;
grant select, insert on table public.webhook_events to service_role;
grant update (event_key, processing_state, processed_at, last_error, record_kind) on public.webhook_events to service_role;
grant select on public.admin_invitations to service_role;
grant insert (token_hash_digest, user_id, recipient_email, issued_at, expires_at)
  on public.admin_invitations to service_role;

create or replace function public.is_active_admin(required_roles text[] default array['admin', 'super_admin'])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce((auth.jwt() ->> 'aal') = 'aal2', false)
    and exists (
      select 1
      from public.admin_users
      where user_id = auth.uid()
        and active
        and role in ('admin', 'super_admin')
        and role = any(required_roles)
        and case when (auth.jwt() ->> 'iat') ~ '^[0-9]{1,10}$'
          then to_timestamp((auth.jwt() ->> 'iat')::double precision) > sessions_valid_after
          else false end
    );
$$;

revoke all on function public.is_active_admin(text[]) from public;
grant execute on function public.is_active_admin(text[]) to authenticated;

create or replace function public.payment_admin_schema_ready()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.payment_admin_migrations
    where name = 'payment-admin-hardening-v0.3.0' and digest ~ '^[0-9a-f]{64}$');
$$;
revoke all on function public.payment_admin_schema_ready() from public, anon, authenticated;
grant execute on function public.payment_admin_schema_ready() to service_role;

-- The service API verifies invite OTP and the AAL1 session first. Email is only a
-- consistency check for the invited UUID, NEVER a lookup/allowlist authority.
create or replace function public.admin_consume_invitation(
  p_token_hash_digest text, p_user_id uuid, p_session_id uuid
)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  v_invitation public.admin_invitations%rowtype;
  v_now timestamptz;
begin
  if not public.payment_admin_schema_ready()
    or p_token_hash_digest is null or p_token_hash_digest !~ '^[0-9a-f]{64}$'
    or p_user_id is null or p_session_id is null then return false; end if;

  select * into v_invitation from public.admin_invitations
  where token_hash_digest = p_token_hash_digest and user_id = p_user_id for update;
  if not found or v_invitation.consumed_at is not null or v_invitation.consumed_session_id is not null then
    return false;
  end if;
  -- Lock both identities so deactivation/revocation/email changes cannot race consumption.
  perform 1 from public.admin_users a join auth.users u on u.id = a.user_id
  where a.user_id = p_user_id and a.active and a.role in ('admin','super_admin')
    and v_invitation.issued_at > a.sessions_valid_after
    and lower(u.email) = lower(v_invitation.recipient_email)
  for share of a, u;
  if not found then return false; end if;

  v_now := clock_timestamp();
  if not isfinite(v_invitation.issued_at) or not isfinite(v_invitation.expires_at)
    or v_invitation.issued_at > v_now or v_invitation.expires_at <= v_now
    or v_invitation.expires_at <= v_invitation.issued_at
    or v_invitation.expires_at > v_invitation.issued_at + interval '1 hour' then return false; end if;
  if exists (select 1 from public.admin_invitations
    where user_id = p_user_id and consumed_session_id = p_session_id) then return false; end if;

  update public.admin_invitations set consumed_at = v_now, consumed_session_id = p_session_id
  where token_hash_digest = p_token_hash_digest and user_id = p_user_id
    and consumed_at is null and consumed_session_id is null;
  return found;
exception when unique_violation then
  -- Concurrent invitations for the same session: only one may win.
  return false;
end;
$$;
revoke all on function public.admin_consume_invitation(text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_consume_invitation(text,uuid,uuid) to service_role;

-- API passes verified server context, NEVER request-body assertions or a TOTP code.
create or replace function public.assert_admin_mutation_context(
  p_actor_user_id uuid, p_actor_aal text,
  p_actor_session_issued_at timestamptz, p_totp_verified_at timestamptz
)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if p_actor_user_id is null or p_actor_aal is distinct from 'aal2'
     or p_actor_session_issued_at is null or not isfinite(p_actor_session_issued_at)
     or p_actor_session_issued_at > clock_timestamp()
     or p_totp_verified_at is null or not isfinite(p_totp_verified_at)
     or p_totp_verified_at < clock_timestamp() - interval '5 minutes'
     or p_totp_verified_at > clock_timestamp() then
    raise exception 'ADMIN_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  -- SHARE (not KEY SHARE) blocks changes to active/role/revocation through TX completion.
  perform 1 from public.admin_users where user_id = p_actor_user_id
    and active and role in ('admin','super_admin')
    and date_trunc('second', p_actor_session_issued_at) > sessions_valid_after
  for share;
  if not found or p_totp_verified_at < clock_timestamp() - interval '5 minutes' then
    raise exception 'ADMIN_NOT_AUTHORIZED' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz) to service_role;

-- Exact logout contract: the service API supplies UUID/iat from its verified AAL1/AAL2
-- bootstrap context, never request-body identity. A service JWT cannot attest user AAL.
create or replace function public.admin_revoke_own_sessions(
  p_actor_user_id uuid, p_actor_session_issued_at timestamptz
)
returns boolean language plpgsql security definer set search_path = public
as $$
declare v_admin public.admin_users%rowtype; v_now timestamptz;
begin
  if not public.payment_admin_schema_ready() or p_actor_user_id is null
    or p_actor_session_issued_at is null or not isfinite(p_actor_session_issued_at)
    or p_actor_session_issued_at > clock_timestamp() then return false; end if;
  select * into v_admin from public.admin_users where user_id = p_actor_user_id for update;
  if not found or not v_admin.active or v_admin.role not in ('admin','super_admin')
    or date_trunc('second', p_actor_session_issued_at) <= v_admin.sessions_valid_after then return false; end if;
  v_now := clock_timestamp();
  update public.admin_users set sessions_valid_after = greatest(sessions_valid_after,v_now), updated_at = v_now
  where user_id = p_actor_user_id;
  insert into public.admin_audit_logs(actor_user_id,action,reason,before_value,after_value,request_id,actor_session_issued_at)
  values (p_actor_user_id,'own_sessions_revoked','Server-verified logout',
    jsonb_build_object('sessions_valid_after',v_admin.sessions_valid_after),
    jsonb_build_object('sessions_valid_after',v_now),gen_random_uuid(),p_actor_session_issued_at);
  return true;
end;
$$;
revoke all on function public.admin_revoke_own_sessions(uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.admin_revoke_own_sessions(uuid,timestamptz) to service_role;

create or replace function public.prepare_wompi_receipt()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.record_kind = 'canonical' then return new; end if;
  if new.raw ->> 'receipt_version' = '1' then
    if new.transaction_id is not null or new.event_type is not null then
      raise exception 'RECEIPT_NORMALIZED_COLUMNS_MUST_BE_NULL' using errcode = '22023';
    end if;
    new.event_key := 'receipt:' || new.id::text;
    new.record_kind := 'receipt';
    new.processing_state := 'received';
  elsif new.record_kind = 'legacy' then
    new.processing_state := 'needs_review';
  end if;
  return new;
end;
$$;
revoke all on function public.prepare_wompi_receipt() from public, anon, authenticated;
drop trigger if exists prepare_wompi_receipt on public.webhook_events;
create trigger prepare_wompi_receipt before insert on public.webhook_events
  for each row execute function public.prepare_wompi_receipt();

create or replace function public.preserve_wompi_evidence()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.id is distinct from old.id or new.raw is distinct from old.raw
    or new.transaction_id is distinct from old.transaction_id
    or new.event_type is distinct from old.event_type or new.created_at is distinct from old.created_at then
    raise exception 'WEBHOOK_EVIDENCE_IMMUTABLE' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.preserve_wompi_evidence() from public, anon, authenticated;
drop trigger if exists preserve_wompi_evidence on public.webhook_events;
create trigger preserve_wompi_evidence before update on public.webhook_events
  for each row execute function public.preserve_wompi_evidence();

create or replace function public.mark_wompi_receipt(p_raw jsonb, p_result text, p_error text default null)
returns void language plpgsql security definer set search_path = public
as $$
declare v_receipt_id uuid;
begin
  if p_raw ->> 'receipt_id' is null then return; end if;
  begin
    v_receipt_id := (p_raw ->> 'receipt_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'INVALID_RECEIPT_ID' using errcode = '22023';
  end;
  update public.webhook_events set
    processing_state = case when p_result in ('processed','duplicate') then 'processed' else 'needs_review' end,
    processed_at = clock_timestamp(), last_error = p_error
  where id = v_receipt_id and raw ->> 'receipt_version' = '1' and record_kind = 'receipt';
  if not found then raise exception 'RECEIPT_NOT_FOUND' using errcode = '22023'; end if;
end;
$$;
revoke all on function public.mark_wompi_receipt(jsonb,text,text) from public, anon, authenticated;
grant execute on function public.mark_wompi_receipt(jsonb,text,text) to service_role;

create or replace function public.consume_api_rate_limit(
  p_scope text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if nullif(btrim(p_scope), '') is null
     or nullif(btrim(p_key_hash), '') is null
     or p_limit < 1
     or p_window_seconds < 1 then
    return false;
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.api_rate_limits(scope, key_hash, window_start, request_count)
  values (p_scope, p_key_hash, v_window, 1)
  on conflict (scope, key_hash)
  do update set
    window_start = excluded.window_start,
    request_count = case
      when public.api_rate_limits.window_start = excluded.window_start
        then public.api_rate_limits.request_count + 1
      else 1
    end,
    updated_at = now()
  returning request_count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer) to service_role;

create or replace function public.claim_monthly_payment_attempt(
  p_attempt_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.payment_attempts%rowtype;
  v_subscription public.subscriptions%rowtype;
  v_email text;
  v_period_year integer;
  v_period_month integer;
  v_month_start timestamptz;
  v_month_end timestamptz;
begin
  if p_now is null or not isfinite(p_now) then
    raise exception 'INVALID_CLAIM_TIME' using errcode = '22023';
  end if;
  select * into v_attempt
  from public.payment_attempts
  where id = p_attempt_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_claimed', 'reason', 'ATTEMPT_NOT_FOUND');
  end if;

  if v_attempt.state not in ('prepared', 'failed')
     or v_attempt.wompi_transaction_id is not null
     or (v_attempt.state = 'failed' and v_attempt.dispatched_at is not null) then
    return jsonb_build_object('result', 'not_claimed', 'reason', 'ATTEMPT_NOT_CLAIMABLE');
  end if;

  select * into v_subscription
  from public.subscriptions
  where id = v_attempt.subscription_id
  for update;

  if not found then
    update public.payment_attempts
    set state = 'failed', error_code = 'SUBSCRIPTION_NOT_FOUND', updated_at = now()
    where id = p_attempt_id;
    return jsonb_build_object('result', 'not_claimed', 'reason', 'SUBSCRIPTION_NOT_FOUND');
  end if;

  select email into v_email
  from public.donors
  where id = v_subscription.donor_id
  for update;

  if v_subscription.status is distinct from 'active'
     or v_subscription.frequency is distinct from 'monthly'
     or nullif(v_subscription.wompi_payment_source_id, '') is null
     or v_subscription.next_payment_date is null
     or v_subscription.next_payment_date > p_now then
    update public.payment_attempts
    set state = 'failed', error_code = 'SUBSCRIPTION_NOT_DUE', updated_at = now()
    where id = p_attempt_id;
    return jsonb_build_object('result', 'not_claimed', 'reason', 'SUBSCRIPTION_NOT_DUE');
  end if;

  if v_attempt.billing_period is null
     or v_attempt.billing_period !~ '^[0-9]{6}$'
     or substring(v_attempt.billing_period from 5 for 2)::integer not between 1 and 12 then
    update public.payment_attempts
    set state = 'failed', error_code = 'INVALID_BILLING_PERIOD', updated_at = now()
    where id = p_attempt_id;
    return jsonb_build_object('result', 'not_claimed', 'reason', 'INVALID_BILLING_PERIOD');
  end if;

  v_period_year := substring(v_attempt.billing_period from 1 for 4)::integer;
  v_period_month := substring(v_attempt.billing_period from 5 for 2)::integer;
  if v_period_year < 1970 or v_subscription.amount is null
     or v_subscription.amount not between 1500 and 21474836
     or v_subscription.currency is distinct from 'COP' then
    return jsonb_build_object('result', 'not_claimed', 'reason', 'INVALID_BILLING_SNAPSHOT');
  end if;
  v_month_start := make_timestamptz(v_period_year, v_period_month, 1, 0, 0, 0, 'America/Bogota');
  v_month_end := ((v_month_start at time zone 'America/Bogota') + interval '1 month') at time zone 'America/Bogota';

  if exists (select 1 from public.payments where subscription_id = v_subscription.id
    and (billing_review_required or status is null or status = 'pending'
      or (status = 'approved' and (coalesce(approved_at, provider_effective_at) is null
        or not isfinite(coalesce(approved_at, provider_effective_at)))))) then
    update public.payment_attempts set state = 'failed', error_code = 'PAYMENT_DATE_OR_RESULT_NEEDS_REVIEW', updated_at = now()
    where id = p_attempt_id;
    return jsonb_build_object('result', 'not_claimed', 'reason', 'PAYMENT_DATE_OR_RESULT_NEEDS_REVIEW');
  end if;

  if exists (
    select 1
    from public.payments
    where subscription_id = v_subscription.id
      and status = 'approved'
      and coalesce(approved_at, provider_effective_at) >= v_month_start
      and coalesce(approved_at, provider_effective_at) < v_month_end
  ) then
    update public.payment_attempts
    set state = 'failed', error_code = 'BILLING_PERIOD_ALREADY_HAS_PAYMENT', updated_at = now()
    where id = p_attempt_id;
    return jsonb_build_object('result', 'not_claimed', 'reason', 'BILLING_PERIOD_ALREADY_HAS_PAYMENT');
  end if;

  if exists (
    select 1
    from public.payment_attempts other_attempt
    where other_attempt.id <> v_attempt.id
      and (other_attempt.donor_id = v_subscription.donor_id
        or exists (select 1 from public.subscriptions other_subscription
          where other_subscription.id = other_attempt.subscription_id and other_subscription.donor_id = v_subscription.donor_id)
        or exists (select 1 from public.checkout_intents other_intent
          where other_intent.id = other_attempt.checkout_intent_id and other_intent.donor_id = v_subscription.donor_id))
      and other_attempt.state in ('dispatching', 'pending', 'unknown')
  ) then
    update public.payment_attempts
    set donor_id = v_subscription.donor_id,
        state = 'failed', error_code = 'DONOR_HAS_UNRESOLVED_ATTEMPT', updated_at = now()
    where id = p_attempt_id;
    return jsonb_build_object('result', 'not_claimed', 'reason', 'DONOR_HAS_UNRESOLVED_ATTEMPT');
  end if;

  update public.payment_attempts
  set donor_id = v_subscription.donor_id,
      amount = v_subscription.amount,
      currency = v_subscription.currency,
      subscription_version = v_subscription.billing_version,
      state = 'dispatching',
      dispatched_at = now(),
      provider_status = null,
      error_code = null,
      updated_at = now()
  where id = p_attempt_id
  returning * into v_attempt;

  return jsonb_build_object(
    'result', 'claimed',
    'attemptId', v_attempt.id,
    'subscriptionId', v_subscription.id,
    'reference', v_attempt.reference,
    'amount', v_attempt.amount,
    'currency', v_attempt.currency,
    'customerEmail', v_email,
    'paymentSourceId', v_subscription.wompi_payment_source_id,
    'preferredPaymentDay', v_subscription.preferred_payment_day,
    'nextPaymentDate', v_subscription.next_payment_date,
    'billingVersion', v_subscription.billing_version
  );
end;
$$;

revoke all on function public.claim_monthly_payment_attempt(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_monthly_payment_attempt(uuid, timestamptz) to service_role;

create or replace function public.advance_subscription_schedule(
  p_subscription_id uuid,
  p_expected_version integer,
  p_candidate timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subscription public.subscriptions%rowtype;
  v_last_approval timestamptz;
begin
  if p_candidate is null or not isfinite(p_candidate) or p_expected_version is null or p_expected_version < 0 then
    raise exception 'INVALID_SCHEDULE_ADVANCE' using errcode = '22023';
  end if;

  select * into v_subscription
  from public.subscriptions
  where id = p_subscription_id
  for update;

  if not found then
    return jsonb_build_object('result', 'protected', 'reason', 'SUBSCRIPTION_NOT_FOUND');
  end if;
  if v_subscription.status is distinct from 'active' then
    return jsonb_build_object('result', 'protected', 'reason', 'SUBSCRIPTION_NOT_ACTIVE');
  end if;
  if v_subscription.billing_version is distinct from p_expected_version then
    return jsonb_build_object('result', 'protected', 'reason', 'SUBSCRIPTION_VERSION_CHANGED');
  end if;

  if exists (select 1 from public.payments where subscription_id = p_subscription_id
    and (billing_review_required or (status = 'approved' and coalesce(approved_at, provider_effective_at) is null))) then
    return jsonb_build_object('result', 'protected', 'reason', 'PAYMENT_DATE_OR_RESULT_NEEDS_REVIEW');
  end if;

  select max(coalesce(approved_at,provider_effective_at)) into v_last_approval
  from public.payments where subscription_id = p_subscription_id and status = 'approved'
    and not billing_review_required and isfinite(coalesce(approved_at,provider_effective_at));
  -- Audit creation is the manual decision time, NEVER a substitute for payment approval time.
  if exists(select 1 from public.admin_audit_logs a where a.subscription_id = p_subscription_id
    and a.action in ('schedule','reactivate')
    and (v_last_approval is null or a.created_at >= v_last_approval)) then
    return jsonb_build_object('result','protected','reason','ADMIN_SCHEDULE_PROTECTED',
      'nextPaymentDate',v_subscription.next_payment_date);
  end if;

  if v_subscription.next_payment_date is null or p_candidate > v_subscription.next_payment_date then
    update public.subscriptions
    set next_payment_date = case
          when next_payment_date is null then p_candidate
          else greatest(next_payment_date, p_candidate)
        end,
        updated_at = now()
    where id = p_subscription_id
    returning * into v_subscription;
    return jsonb_build_object(
      'result', 'changed',
      'nextPaymentDate', v_subscription.next_payment_date
    );
  end if;

  return jsonb_build_object(
    'result', 'unchanged',
    'nextPaymentDate', v_subscription.next_payment_date
  );
end;
$$;

revoke all on function public.advance_subscription_schedule(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.advance_subscription_schedule(uuid, integer, timestamptz) to service_role;

create or replace function public.mark_subscription_past_due(
  p_subscription_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subscription public.subscriptions%rowtype;
begin
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'INVALID_PAST_DUE_CHANGE' using errcode = '22023';
  end if;

  select * into v_subscription
  from public.subscriptions
  where id = p_subscription_id
  for update;

  if not found then
    return jsonb_build_object('result', 'protected', 'reason', 'SUBSCRIPTION_NOT_FOUND');
  end if;
  if v_subscription.billing_version is distinct from p_expected_version then
    return jsonb_build_object('result', 'protected', 'reason', 'SUBSCRIPTION_VERSION_CHANGED');
  end if;
  if v_subscription.status is distinct from 'active' then
    return jsonb_build_object('result', 'protected', 'reason', 'SUBSCRIPTION_NOT_ACTIVE');
  end if;

  update public.subscriptions
  set status = 'past_due', updated_at = now()
  where id = p_subscription_id;

  return jsonb_build_object('result', 'changed', 'status', 'past_due');
end;
$$;

revoke all on function public.mark_subscription_past_due(uuid, integer) from public, anon, authenticated;
grant execute on function public.mark_subscription_past_due(uuid, integer) to service_role;

create or replace function public.cleanup_expired_operational_rows()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intents integer;
begin
  update public.checkout_intents
  set state = 'expired', updated_at = now()
  where expires_at < now()
    and state in ('draft', 'checkout');
  get diagnostics v_intents = row_count;

  return jsonb_build_object('checkoutIntentsExpired', v_intents, 'rowsDeleted', 0);
end;
$$;

revoke all on function public.cleanup_expired_operational_rows() from public, anon, authenticated;
grant execute on function public.cleanup_expired_operational_rows() to service_role;

drop function if exists public.admin_update_subscription(uuid, integer, text, text, uuid, integer, integer, timestamptz);
drop function if exists public.admin_update_subscription(uuid, integer, text, text, uuid, uuid, integer, integer, timestamptz);
drop function if exists public.admin_update_subscription(uuid, integer, text, text, uuid, uuid, integer, integer, timestamptz, boolean);

create or replace function public.admin_update_subscription(
  p_subscription_id uuid,
  p_expected_version integer,
  p_action text,
  p_reason text,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_amount integer default null,
  p_preferred_payment_day integer default null,
  p_next_payment_date timestamptz default null,
  p_donor_authorization_confirmed boolean default false,
  p_actor_aal text default null,
  p_actor_session_issued_at timestamptz default null,
  p_totp_verified_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.subscriptions%rowtype;
  v_after public.subscriptions%rowtype;
  v_month_start timestamptz;
  v_month_end timestamptz;
begin
  perform public.assert_admin_mutation_context(p_actor_user_id, p_actor_aal, p_actor_session_issued_at, p_totp_verified_at);
  if p_expected_version is null or p_expected_version < 0 or p_request_id is null then
    raise exception 'ADMIN_EXPECTED_VERSION_REQUIRED' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'ADMIN_REASON_REQUIRED' using errcode = '22023';
  end if;

  select * into v_before
  from public.subscriptions
  where id = p_subscription_id
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_before.billing_version is distinct from p_expected_version then
    raise exception 'SUBSCRIPTION_VERSION_CONFLICT' using errcode = '40001';
  end if;
  if p_action in ('amount', 'schedule', 'cancel', 'reactivate') and exists (
    select 1 from public.payment_attempts
    where subscription_id = p_subscription_id and state in ('dispatching', 'pending', 'unknown')
  ) then
    raise exception 'PAYMENT_IN_PROGRESS' using errcode = '55000';
  end if;

  if p_action = 'amount' then
    if v_before.status is distinct from 'active' or p_amount is null or p_amount not between 1500 and 21474836 then
      raise exception 'INVALID_AMOUNT_CHANGE' using errcode = '22023';
    end if;
    update public.subscriptions
    set amount = p_amount, billing_version = billing_version + 1,
        schedule_updated_at = now(), updated_at = now()
    where id = p_subscription_id returning * into v_after;
  elsif p_action = 'schedule' then
    if v_before.status is distinct from 'active'
       or p_preferred_payment_day is null or p_preferred_payment_day not in (1, 6, 16, 28)
       or p_next_payment_date is null
       or not isfinite(p_next_payment_date) or p_next_payment_date <= now()
       or extract(day from p_next_payment_date at time zone 'America/Bogota')::integer <> p_preferred_payment_day
       or extract(hour from p_next_payment_date at time zone 'America/Bogota')::integer <> 7
       or extract(minute from p_next_payment_date at time zone 'America/Bogota')::integer <> 0 then
      raise exception 'INVALID_SCHEDULE_CHANGE' using errcode = '22023';
    end if;
    v_month_start := date_trunc('month', p_next_payment_date at time zone 'America/Bogota') at time zone 'America/Bogota';
    v_month_end := (date_trunc('month', p_next_payment_date at time zone 'America/Bogota') + interval '1 month') at time zone 'America/Bogota';
    if exists (select 1 from public.payments where subscription_id = p_subscription_id
      and (billing_review_required or (status = 'approved' and coalesce(approved_at, provider_effective_at) is null))) then
      raise exception 'PAYMENT_DATE_OR_RESULT_NEEDS_REVIEW' using errcode = '55000';
    end if;
    if exists (
      select 1 from public.payments
      where subscription_id = p_subscription_id
        and status = 'approved'
        and coalesce(approved_at, provider_effective_at) >= v_month_start
        and coalesce(approved_at, provider_effective_at) < v_month_end
    ) then
      raise exception 'BILLING_MONTH_ALREADY_PAID' using errcode = '22023';
    end if;
    update public.subscriptions
    set preferred_payment_day = p_preferred_payment_day,
        next_payment_date = p_next_payment_date,
        billing_version = billing_version + 1,
        schedule_updated_at = now(), updated_at = now()
    where id = p_subscription_id returning * into v_after;
  elsif p_action = 'cancel' then
    if v_before.status is null or v_before.status not in ('active', 'past_due') then
      raise exception 'INVALID_CANCELLATION' using errcode = '22023';
    end if;
    update public.subscriptions
    set status = 'cancelled', cancelled_at = now(), next_payment_date = null,
        billing_version = billing_version + 1,
        schedule_updated_at = now(), updated_at = now()
    where id = p_subscription_id returning * into v_after;
  elsif p_action = 'reactivate' then
    if v_before.status is null or v_before.status not in ('cancelled', 'past_due')
       or p_donor_authorization_confirmed is not true
       or nullif(v_before.wompi_payment_source_id, '') is null
       or p_preferred_payment_day is null or p_preferred_payment_day not in (1, 6, 16, 28)
       or p_next_payment_date is null
       or not isfinite(p_next_payment_date) or p_next_payment_date <= now()
       or extract(day from p_next_payment_date at time zone 'America/Bogota')::integer <> p_preferred_payment_day
       or extract(hour from p_next_payment_date at time zone 'America/Bogota')::integer <> 7
       or extract(minute from p_next_payment_date at time zone 'America/Bogota')::integer <> 0 then
      raise exception 'INVALID_REACTIVATION' using errcode = '22023';
    end if;
    v_month_start := date_trunc('month', p_next_payment_date at time zone 'America/Bogota') at time zone 'America/Bogota';
    v_month_end := (date_trunc('month', p_next_payment_date at time zone 'America/Bogota') + interval '1 month') at time zone 'America/Bogota';
    if exists (select 1 from public.payments where subscription_id = p_subscription_id
      and (billing_review_required or (status = 'approved' and coalesce(approved_at, provider_effective_at) is null))) then
      raise exception 'PAYMENT_DATE_OR_RESULT_NEEDS_REVIEW' using errcode = '55000';
    end if;
    if exists (
      select 1 from public.payments
      where subscription_id = p_subscription_id
        and status = 'approved'
        and coalesce(approved_at, provider_effective_at) >= v_month_start
        and coalesce(approved_at, provider_effective_at) < v_month_end
    ) then
      raise exception 'BILLING_MONTH_ALREADY_PAID' using errcode = '22023';
    end if;
    update public.subscriptions
    set status = 'active', cancelled_at = null,
        preferred_payment_day = p_preferred_payment_day,
        next_payment_date = p_next_payment_date,
        billing_version = billing_version + 1,
        schedule_updated_at = now(), updated_at = now()
    where id = p_subscription_id returning * into v_after;
  else
    raise exception 'INVALID_ADMIN_ACTION' using errcode = '22023';
  end if;

  insert into public.admin_audit_logs(
    actor_user_id, subscription_id, action, reason, before_value, after_value, request_id,
    expected_version, actor_aal, actor_session_issued_at, totp_verified_at
  ) values (
    p_actor_user_id, p_subscription_id, p_action, trim(p_reason),
    jsonb_build_object(
      'id', v_before.id, 'amount', v_before.amount, 'status', v_before.status,
      'preferred_payment_day', v_before.preferred_payment_day,
      'next_payment_date', v_before.next_payment_date,
      'billing_version', v_before.billing_version
    ),
    jsonb_build_object(
      'id', v_after.id, 'amount', v_after.amount, 'status', v_after.status,
      'preferred_payment_day', v_after.preferred_payment_day,
      'next_payment_date', v_after.next_payment_date,
      'billing_version', v_after.billing_version,
      'donor_authorization_confirmed', case
        when p_action = 'reactivate' then p_donor_authorization_confirmed
        else null
      end
    ),
    p_request_id, p_expected_version, p_actor_aal, p_actor_session_issued_at, p_totp_verified_at
  );

  return jsonb_build_object(
    'id', v_after.id,
    'amount', v_after.amount,
    'status', v_after.status,
    'preferred_payment_day', v_after.preferred_payment_day,
    'next_payment_date', v_after.next_payment_date,
    'billing_version', v_after.billing_version
  );
end;
$$;

revoke all on function public.admin_update_subscription(uuid, integer, text, text, uuid, uuid, integer, integer, timestamptz, boolean, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_update_subscription(uuid, integer, text, text, uuid, uuid, integer, integer, timestamptz, boolean, text, timestamptz, timestamptz) to service_role;

create or replace function public.apply_verified_wompi_event(
  p_event_key text,
  p_transaction_id text,
  p_event_type text,
  p_reference text,
  p_payment_source_id text,
  p_amount integer,
  p_currency text,
  p_status text,
  p_effective_at timestamptz,
  p_candidate_next_payment timestamptz,
  p_raw jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.webhook_events%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_intent public.checkout_intents%rowtype;
  v_subscription public.subscriptions%rowtype;
  v_subscription_id uuid;
  v_source_count integer;
  v_payment public.payments%rowtype;
  v_current_attempt_payment public.payments%rowtype;
  v_can_change_schedule boolean;
  v_can_update_attempt boolean;
  v_is_historical_retry_failure boolean := false;
  v_is_latest_event boolean;
  v_apply_provider_state boolean;
  v_applied_status text;
  v_processed text[];
  v_candidate_next timestamptz;
  v_created_subscription boolean := false;
  v_legacy_applied boolean := false;
  v_needs_review boolean := false;
  v_historical_payment boolean;
  v_historical_before jsonb;
  v_historical_effective timestamptz;
  v_historical_result text;
  v_historical_reason text;
  v_failure_reason text;
begin
  if nullif(btrim(p_event_key), '') is null
     or nullif(btrim(p_transaction_id), '') is null
     or nullif(btrim(p_reference), '') is null
     or p_amount is null or p_amount not between 1500 and 21474836
     or p_currency is distinct from 'COP'
     or p_event_type is null or p_raw is null
     or (p_effective_at is not null and (not isfinite(p_effective_at) or p_effective_at < timestamptz '1970-01-01 00:00:00+00'))
     or p_status is null or p_status not in ('approved', 'pending', 'declined', 'error', 'voided') then
    raise exception 'INVALID_VERIFIED_WOMPI_EVENT' using errcode = '22023';
  end if;

  -- Canonical keys never compete with legacy rows or append-only receipt identities.
  insert into public.webhook_events(transaction_id, event_type, event_key, raw, processing_state, record_kind)
  values (p_transaction_id, p_event_type, p_event_key, p_raw, 'received', 'canonical')
  on conflict (event_key) where record_kind = 'canonical' do nothing;
  select * into v_event from public.webhook_events
  where event_key = p_event_key and record_kind = 'canonical' for update;

  if v_event.transaction_id is distinct from p_transaction_id or v_event.event_type is distinct from p_event_type then
    perform public.mark_wompi_receipt(p_raw, 'review', 'EVENT_KEY_COLLISION');
    return jsonb_build_object('result', 'review', 'processingState', 'needs_review', 'reason', 'EVENT_KEY_COLLISION');
  end if;
  -- Revalidate review/legacy_applied keys with current verified evidence; their original RAW stays immutable.
  begin
  select * into v_payment from public.payments where wompi_transaction_id = p_transaction_id for update;
  if v_payment.id is not null and (v_payment.amount is distinct from p_amount
    or v_payment.currency is distinct from p_currency
    or (v_payment.reference is not null and v_payment.reference <> p_reference)) then
    raise exception 'WOMPI_EVENT_HISTORICAL_PAYMENT_MISMATCH' using errcode = '22023';
  end if;

  select exists (select 1 from public.webhook_events old_event
    where old_event.record_kind = 'legacy' and old_event.processing_state = 'legacy_applied'
      and coalesce(old_event.transaction_id, old_event.raw ->> 'transaction_id',
        old_event.raw #>> '{transaction,id}', old_event.raw #>> '{data,transaction,id}') = p_transaction_id)
  into v_legacy_applied;
  v_legacy_applied := v_legacy_applied or v_event.processing_state = 'legacy_applied';
  select * into v_attempt
  from public.payment_attempts
  where wompi_transaction_id = p_transaction_id or reference = p_reference
  order by (wompi_transaction_id = p_transaction_id) desc, created_at desc
  limit 1
  for update;

  if v_attempt.id is not null and v_payment.id is null and (
    v_attempt.reference <> p_reference
    or v_attempt.amount <> p_amount
    or v_attempt.currency <> p_currency
  ) then
    raise exception 'WOMPI_EVENT_ATTEMPT_MISMATCH' using errcode = '22023';
  end if;

  if v_attempt.checkout_intent_id is not null and v_payment.id is null then
    select * into v_intent
    from public.checkout_intents
    where id = v_attempt.checkout_intent_id
    for update;
    if v_intent.id is null
       or v_intent.reference <> p_reference
       or v_intent.amount <> p_amount
       or v_intent.currency <> p_currency then
      raise exception 'WOMPI_EVENT_INTENT_MISMATCH' using errcode = '22023';
    end if;
  end if;

  if v_payment.id is not null and v_payment.subscription_id is null then
    raise exception 'HISTORICAL_PAYMENT_UNLINKED' using errcode = '22023';
  end if;
  v_subscription_id := coalesce(v_payment.subscription_id, v_attempt.subscription_id);
  if v_subscription_id is null then
    select id into v_subscription_id from public.subscriptions where reference = p_reference limit 1;
  end if;
  if v_subscription_id is null then
    if v_intent.id is null then
      select * into v_intent
      from public.checkout_intents
      where reference = p_reference
      limit 1
      for update;
    end if;

    if v_intent.id is not null then
      if v_intent.reference <> p_reference
         or v_intent.amount <> p_amount
         or v_intent.currency <> p_currency then
        raise exception 'WOMPI_EVENT_INTENT_MISMATCH' using errcode = '22023';
      end if;

      insert into public.subscriptions(
        donor_id, amount, currency, frequency, status, payment_method_type,
        wompi_payment_source_id, preferred_payment_day, reference,
        next_payment_date, processed_transaction_ids, updated_at
      ) values (
        v_intent.donor_id, v_intent.amount, v_intent.currency,
        case when v_intent.is_recurring then 'monthly' else 'one_time' end,
        'pending', v_intent.payment_method_type, p_payment_source_id,
        v_intent.preferred_payment_day, v_intent.reference, null, '{}', now()
      )
      on conflict do nothing
      returning id into v_subscription_id;

      v_created_subscription := v_subscription_id is not null;
      if v_subscription_id is null then
        select id into v_subscription_id
        from public.subscriptions
        where reference = p_reference
        limit 1;
      end if;
    end if;
  end if;
  if v_subscription_id is null and p_payment_source_id is not null then
    select (array_agg(id))[1], count(*) into v_subscription_id, v_source_count
    from public.subscriptions where wompi_payment_source_id = p_payment_source_id;
    if v_source_count <> 1 then v_subscription_id := null; end if;
  end if;

  if v_subscription_id is null then
    update public.webhook_events
    set processing_state = 'needs_review', processed_at = clock_timestamp(), last_error = 'SUBSCRIPTION_NOT_FOUND'
    where id = v_event.id;
    perform public.mark_wompi_receipt(p_raw, 'review', 'SUBSCRIPTION_NOT_FOUND');
    return jsonb_build_object('result', 'review', 'processingState', 'needs_review',
      'transactionId', p_transaction_id, 'reason', 'SUBSCRIPTION_NOT_FOUND');
  end if;

  select * into v_subscription from public.subscriptions where id = v_subscription_id for update;
  if not found then raise exception 'HISTORICAL_PAYMENT_UNLINKED' using errcode = '22023'; end if;
  v_historical_payment := v_payment.id is not null and (v_legacy_applied
    or (v_payment.payment_attempt_id is null and not coalesce(
      v_attempt.wompi_transaction_id = p_transaction_id and v_attempt.subscription_version is not null,false)));
  if v_historical_payment then
    if v_subscription.currency is distinct from p_currency or not coalesce(
      p_reference = v_subscription.reference or (v_subscription.frequency = 'monthly'
        and v_subscription.reference is not null
        and char_length(p_reference) = char_length(v_subscription.reference) + 7
        and left(p_reference,char_length(v_subscription.reference) + 1) = v_subscription.reference || '-'
        and right(p_reference,6) ~ '^[0-9]{6}$'
        and substring(right(p_reference,6) from 5 for 2)::integer between 1 and 12),false) then
      raise exception 'WOMPI_EVENT_HISTORICAL_REFERENCE_MISMATCH' using errcode = '22023';
    end if;
    if nullif(btrim(p_payment_source_id),'') is not null
      and nullif(btrim(v_subscription.wompi_payment_source_id),'') is not null
      and p_payment_source_id <> v_subscription.wompi_payment_source_id then
      if v_payment.payment_attempt_id is not null or v_attempt.id is not null or v_intent.id is not null
        or exists(select 1 from public.checkout_intents where reference = p_reference) then
        raise exception 'WOMPI_EVENT_PAYMENT_SOURCE_MISMATCH' using errcode = '22023';
      end if;
      -- Only the service caller can supply verified GET evidence. RAW alone is not authority.
      -- A past transaction's source is not replaced by today's subscription source.
      if p_raw #>> '{transaction,id}' is distinct from p_transaction_id
        or p_raw #>> '{transaction,reference}' is distinct from p_reference
        or p_raw #>> '{transaction,amount_in_cents}' is distinct from (p_amount * 100)::text
        or p_raw #>> '{transaction,currency}' is distinct from p_currency
        or lower(p_raw #>> '{transaction,status}') is distinct from p_status
        or (p_raw #>> '{transaction,payment_source_id}' is not null
          and p_raw #>> '{transaction,payment_source_id}' is distinct from p_payment_source_id)
        or (p_raw #>> '{transaction,payment_source,id}' is not null
          and p_raw #>> '{transaction,payment_source,id}' is distinct from p_payment_source_id) then
        raise exception 'WOMPI_EVENT_HISTORICAL_SOURCE_EVIDENCE_MISMATCH' using errcode = '22023';
      end if;
    end if;
    if v_payment.status is not null and v_payment.status <> 'pending' and v_payment.status <> p_status then
      raise exception 'WOMPI_EVENT_HISTORICAL_STATUS_CONFLICT' using errcode = '22023';
    end if;
    v_historical_before := jsonb_build_object('status',v_payment.status,'reference',v_payment.reference,
      'approved_at',v_payment.approved_at,'provider_effective_at',v_payment.provider_effective_at,
      'billing_review_required',v_payment.billing_review_required);
    v_historical_effective := case when p_status = 'approved' then coalesce(
      case when isfinite(v_payment.approved_at) and v_payment.approved_at >= timestamptz '1970-01-01 00:00:00+00'
        then v_payment.approved_at end,
      case when v_payment.status = 'approved' and isfinite(v_payment.provider_effective_at)
        and v_payment.provider_effective_at >= timestamptz '1970-01-01 00:00:00+00' then v_payment.provider_effective_at end,
      p_effective_at)
      else coalesce(p_effective_at,case when isfinite(v_payment.provider_effective_at) then v_payment.provider_effective_at end) end;
    v_historical_reason := case when p_status = 'pending' then 'HISTORICAL_PAYMENT_PENDING'
      when p_status = 'approved' and v_historical_effective is null then 'PAYMENT_DATE_OR_VERSION_NEEDS_REVIEW' else null end;
    -- Metadata-only enrichment of an existing, unversioned payment. No subscription/attempt/intent writes.
    update public.payments set status = p_status, reference = coalesce(reference,p_reference),
      approved_at = case when p_status = 'approved' then v_historical_effective else approved_at end,
      provider_effective_at = v_historical_effective, billing_review_required = v_historical_reason is not null
    where id = v_payment.id returning * into v_payment;
    v_historical_result := case when v_historical_reason is not null then 'review'
      when v_historical_before is distinct from jsonb_build_object('status',v_payment.status,'reference',v_payment.reference,
        'approved_at',v_payment.approved_at,'provider_effective_at',v_payment.provider_effective_at,
        'billing_review_required',v_payment.billing_review_required) then 'processed' else 'duplicate' end;
    update public.webhook_events set processing_state = case when v_historical_result = 'review' then 'needs_review' else 'processed' end,
      processed_at = clock_timestamp(), last_error = v_historical_reason where id = v_event.id;
    perform public.mark_wompi_receipt(p_raw,v_historical_result,v_historical_reason);
    return jsonb_build_object('result',v_historical_result,
      'processingState',case when v_historical_result = 'review' then 'needs_review' else 'processed' end,
      'reason',v_historical_reason,'transactionId',p_transaction_id,'subscriptionId',v_subscription_id,
      'legacyApplied',v_legacy_applied,'historicalOnly',true,'scheduleProtected',true);
  end if;
  if v_payment.id is null and v_attempt.id is null and v_intent.id is null and (
    v_subscription.amount <> p_amount
    or v_subscription.currency <> p_currency
    or not (
      p_reference = v_subscription.reference
      or (
        v_subscription.frequency = 'monthly'
        and v_subscription.reference is not null
        and char_length(p_reference) = char_length(v_subscription.reference) + 7
        and left(p_reference, char_length(v_subscription.reference) + 1) = v_subscription.reference || '-'
        and right(p_reference, 6) ~ '^[0-9]{6}$'
        and substring(right(p_reference, 6) from 5 for 2)::integer between 1 and 12
      )
    )
  ) then
    raise exception 'WOMPI_EVENT_SUBSCRIPTION_MISMATCH' using errcode = '22023';
  end if;
  if v_subscription.frequency = 'monthly' and (
    nullif(btrim(p_payment_source_id), '') is null
    or (
      nullif(btrim(v_subscription.wompi_payment_source_id), '') is not null
      and v_subscription.wompi_payment_source_id <> p_payment_source_id
    )
  ) then
    raise exception 'WOMPI_EVENT_PAYMENT_SOURCE_MISMATCH' using errcode = '22023';
  end if;

  if v_event.processing_state = 'processed' and v_payment.id is not null then
    perform public.mark_wompi_receipt(p_raw,'duplicate');
    return jsonb_build_object('result','duplicate','transactionId',p_transaction_id,'subscriptionId',v_subscription_id);
  end if;

  if v_attempt.subscription_id is not null and v_attempt.subscription_id <> v_subscription_id then
    raise exception 'TRANSACTION_ALREADY_LINKED' using errcode = '22023';
  end if;

  v_can_update_attempt := v_attempt.id is null
    or v_attempt.wompi_transaction_id is null
    or v_attempt.wompi_transaction_id = p_transaction_id;

  if v_attempt.id is not null
     and v_attempt.wompi_transaction_id is not null
     and v_attempt.wompi_transaction_id <> p_transaction_id then
    if v_payment.id is not null then
      v_can_update_attempt := false;
    else
      select * into v_current_attempt_payment
      from public.payments
      where wompi_transaction_id = v_attempt.wompi_transaction_id
      for update;

      if v_subscription.frequency = 'one_time'
         and p_status in ('declined', 'error', 'voided')
         and v_current_attempt_payment.id is not null
         and v_current_attempt_payment.subscription_id = v_subscription_id
         and v_current_attempt_payment.reference is not distinct from p_reference
         and v_current_attempt_payment.status in ('approved', 'pending') then
        v_is_historical_retry_failure := true;
        v_can_update_attempt := false;
      elsif v_subscription.frequency <> 'one_time'
         or v_current_attempt_payment.id is null
         or v_current_attempt_payment.subscription_id is distinct from v_subscription_id
         or v_current_attempt_payment.reference is distinct from p_reference
         or v_current_attempt_payment.status not in ('declined', 'error', 'voided') then
        raise exception 'WOMPI_EVENT_ATTEMPT_MISMATCH' using errcode = '22023';
      else
        v_can_update_attempt := true;
      end if;
    end if;
  end if;

  if v_payment.id is null and not v_is_historical_retry_failure and exists (
    select 1
    from public.payments reference_payment
    where reference_payment.subscription_id = v_subscription_id
      and reference_payment.reference = p_reference
      and reference_payment.wompi_transaction_id <> p_transaction_id
      and (
        v_subscription.frequency <> 'one_time'
        or reference_payment.status in ('approved', 'pending')
      )
  ) then
    raise exception 'WOMPI_EVENT_RETRY_NOT_ALLOWED' using errcode = '22023';
  end if;

  if p_effective_at is null or v_subscription.frequency <> 'monthly' then
    v_candidate_next := null;
  elsif v_subscription.preferred_payment_day in (1, 6, 16, 28) then
    v_candidate_next := (
      date_trunc('month', p_effective_at at time zone 'America/Bogota')
      + interval '1 month'
      + make_interval(days => v_subscription.preferred_payment_day - 1, hours => 7)
    ) at time zone 'America/Bogota';
  else
    v_candidate_next := p_candidate_next_payment;
  end if;

  v_apply_provider_state := v_payment.id is null
    or v_payment.status is null
    or (
      v_payment.status = 'pending'
      and p_status <> 'pending'
    )
    or (
      v_payment.status = 'pending'
      and p_status = 'pending'
      and p_effective_at is not null and (v_payment.provider_effective_at is null or p_effective_at >= v_payment.provider_effective_at)
    )
    or (
      v_payment.status = p_status
      and p_effective_at is not null and (v_payment.billing_review_required or v_payment.provider_effective_at is null or p_effective_at >= v_payment.provider_effective_at)
    );
  v_applied_status := case when v_apply_provider_state then p_status else v_payment.status end;

  if v_payment.id is null then
    insert into public.payments(
      subscription_id, payment_attempt_id, amount, currency, status,
      wompi_transaction_id, reference, approved_at, provider_effective_at, billing_review_required, updated_at
    ) values (
      v_subscription_id, v_attempt.id, p_amount, p_currency, p_status,
      p_transaction_id, p_reference,
      case when p_status = 'approved' then p_effective_at else null end,
      p_effective_at,
      p_status = 'approved' and p_effective_at is null,
      now()
    ) returning * into v_payment;
  else
    if v_payment.subscription_id <> v_subscription_id then
      raise exception 'TRANSACTION_ALREADY_LINKED';
    end if;
    update public.payments
    set status = v_applied_status,
        reference = coalesce(reference, p_reference),
        payment_attempt_id = coalesce(payment_attempt_id, v_attempt.id),
        approved_at = case
          when v_apply_provider_state and p_status = 'approved' then coalesce(approved_at, p_effective_at)
          else approved_at
        end,
        provider_effective_at = case
          -- A stored PENDING timestamp is not evidence of an undated final approval.
          when v_apply_provider_state and p_status = 'approved' then
            coalesce(approved_at, p_effective_at, case when status = 'approved' then provider_effective_at end)
          when v_apply_provider_state then coalesce(p_effective_at, provider_effective_at)
          else provider_effective_at
        end,
        billing_review_required = case when not v_apply_provider_state then billing_review_required
          else v_applied_status = 'approved'
            and (coalesce(approved_at, p_effective_at, case when status = 'approved' then provider_effective_at end) is null
              or not isfinite(coalesce(approved_at, p_effective_at, case when status = 'approved' then provider_effective_at end))) end,
        updated_at = now()
    where id = v_payment.id
    returning * into v_payment;
  end if;

  if v_attempt.id is not null and v_can_update_attempt then
    update public.payment_attempts
    set donor_id = v_subscription.donor_id,
        subscription_id = v_subscription_id,
        subscription_version = case when v_created_subscription then v_subscription.billing_version else subscription_version end,
        wompi_transaction_id = p_transaction_id,
        provider_status = v_applied_status,
        state = case
          when v_applied_status = 'approved' then 'approved'
          when v_applied_status = 'pending' then 'pending'
          when v_applied_status = 'declined' then 'declined'
          when v_applied_status in ('error', 'voided', 'failed') then 'failed'
          else 'unknown'
        end,
        completed_at = case
          when v_applied_status = 'pending' then null
          when v_apply_provider_state then p_effective_at
          else coalesce(v_attempt.completed_at, v_payment.provider_effective_at)
        end,
        error_code = case when v_payment.billing_review_required then 'PAYMENT_DATE_OR_VERSION_NEEDS_REVIEW' else null end,
        updated_at = now()
    where id = v_attempt.id;
  end if;

  select p_effective_at is not null and not exists (
    select 1
    from public.payments newer_payment
    where newer_payment.subscription_id = v_subscription_id
      and newer_payment.wompi_transaction_id <> p_transaction_id
      and (coalesce(newer_payment.provider_effective_at, newer_payment.approved_at) is null
        or coalesce(newer_payment.provider_effective_at, newer_payment.approved_at) > p_effective_at)
  ) into v_is_latest_event;

  v_can_change_schedule := v_subscription.status not in ('cancelled','canceled')
    and p_effective_at is not null
    and v_apply_provider_state
    and v_is_latest_event
    and (v_attempt.id is null or v_can_update_attempt)
    and (v_created_subscription or (v_attempt.id is not null and v_attempt.subscription_version is not null
      and v_attempt.subscription_version = v_subscription.billing_version));
  v_processed := coalesce(v_subscription.processed_transaction_ids, '{}');

  if v_can_change_schedule and v_applied_status = 'approved' and not v_payment.billing_review_required then
    update public.subscriptions
    set status = case when v_is_latest_event then 'active' else status end,
        wompi_payment_source_id = case
          when wompi_payment_source_id is null then p_payment_source_id
          else wompi_payment_source_id
        end,
        next_payment_date = case
          when p_transaction_id = any(v_processed) then next_payment_date
          when next_payment_date is null then v_candidate_next
          else greatest(next_payment_date, v_candidate_next)
        end,
        processed_transaction_ids = case
          when p_transaction_id = any(v_processed) then v_processed
          else array_append(v_processed, p_transaction_id)
        end,
        updated_at = now()
    where id = v_subscription_id;
  elsif v_can_change_schedule and v_is_latest_event and v_applied_status in ('declined', 'error', 'voided') then
    update public.subscriptions set status = 'past_due', updated_at = now() where id = v_subscription_id;
  elsif v_can_change_schedule and v_is_latest_event and v_applied_status = 'pending' and v_subscription.status <> 'active' then
    update public.subscriptions set status = 'pending', updated_at = now() where id = v_subscription_id;
  end if;

  if v_intent.id is not null then
    update public.checkout_intents
    set state = 'completed',
        consumed_at = coalesce(consumed_at, now()),
        updated_at = now()
    where id = v_intent.id;
  end if;

  v_needs_review := v_payment.billing_review_required
    or (v_applied_status = 'approved' and coalesce(v_payment.approved_at, v_payment.provider_effective_at) is null)
    or (v_subscription.frequency = 'monthly' and v_applied_status = 'approved'
      and v_subscription.status not in ('cancelled','canceled') and not v_created_subscription
      and v_apply_provider_state and (v_attempt.id is null or v_attempt.subscription_version is null));
  update public.webhook_events
  set processing_state = case when v_needs_review then 'needs_review' else 'processed' end,
      processed_at = clock_timestamp(), last_error = case when v_needs_review then 'PAYMENT_DATE_OR_VERSION_NEEDS_REVIEW' else null end
  where id = v_event.id;

  perform public.mark_wompi_receipt(p_raw, case when v_needs_review then 'review' else 'processed' end,
    case when v_needs_review then 'PAYMENT_DATE_OR_VERSION_NEEDS_REVIEW' else null end);
  return jsonb_build_object('result', case when v_needs_review then 'review' else 'processed' end,
    'processingState', case when v_needs_review then 'needs_review' else 'processed' end,
    'transactionId', p_transaction_id, 'subscriptionId', v_subscription_id,
    'scheduleProtected', not v_can_change_schedule);
  exception when others then
    v_failure_reason := case when sqlerrm in ('WOMPI_EVENT_HISTORICAL_PAYMENT_MISMATCH',
      'WOMPI_EVENT_HISTORICAL_REFERENCE_MISMATCH','WOMPI_EVENT_HISTORICAL_STATUS_CONFLICT',
      'WOMPI_EVENT_HISTORICAL_SOURCE_EVIDENCE_MISMATCH','HISTORICAL_PAYMENT_UNLINKED')
      then sqlerrm else 'WEBHOOK_APPLY_FAILED' end;
    update public.webhook_events
    set processing_state = 'needs_review', processed_at = clock_timestamp(), last_error = v_failure_reason
    where id = v_event.id;
    perform public.mark_wompi_receipt(p_raw, 'review', v_failure_reason);
    return jsonb_build_object('result', 'review', 'processingState', 'needs_review',
      'transactionId', p_transaction_id, 'error', v_failure_reason);
  end;
end;
$$;

revoke all on function public.apply_verified_wompi_event(text, text, text, text, text, integer, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.apply_verified_wompi_event(text, text, text, text, text, integer, text, text, timestamptz, timestamptz, jsonb) to service_role;

drop function if exists public.admin_reconcile_payment_attempt(uuid, uuid, text, uuid, text, text, text, integer, text, text, timestamptz, timestamptz, jsonb);
create or replace function public.admin_reconcile_payment_attempt(
  p_attempt_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_request_id uuid,
  p_transaction_id text,
  p_reference text,
  p_payment_source_id text,
  p_amount integer,
  p_currency text,
  p_status text,
  p_effective_at timestamptz,
  p_candidate_next_payment timestamptz,
  p_raw jsonb,
  p_expected_version integer default null,
  p_actor_aal text default null,
  p_actor_session_issued_at timestamptz default null,
  p_totp_verified_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.payment_attempts%rowtype;
  v_after public.payment_attempts%rowtype;
  v_applied jsonb;
  v_event_key text;
  v_subscription public.subscriptions%rowtype;
  v_subscription_after public.subscriptions%rowtype;
  v_payment_before public.payments%rowtype;
  v_payment_after public.payments%rowtype;
  v_audit public.admin_audit_logs%rowtype;
  v_request_digest text;
  v_response jsonb;
  v_changed boolean;
  v_owns_version boolean;
  v_review_reason text;
  v_terminal_status text;
begin
  perform public.assert_admin_mutation_context(p_actor_user_id, p_actor_aal, p_actor_session_issued_at, p_totp_verified_at);
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'ADMIN_EXPECTED_VERSION_REQUIRED' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 or p_request_id is null then
    raise exception 'ADMIN_REASON_REQUIRED' using errcode = '22023';
  end if;
  if nullif(trim(p_transaction_id), '') is null or nullif(trim(p_reference), '') is null
    or p_status is null or p_status not in ('pending','approved','declined','error','voided')
    or (p_effective_at is not null and not isfinite(p_effective_at)) then
    raise exception 'PAYMENT_RECOVERY_INVALID_INPUT' using errcode = '22023';
  end if;
  -- Receipt IDs and GET verification times may differ on a retry; business input may not.
  v_request_digest := encode(sha256(convert_to(jsonb_build_object(
    'attempt_id',p_attempt_id,'expected_version',p_expected_version,'reason',trim(p_reason),
    'transaction_id',p_transaction_id,'reference',p_reference,'source_id',p_payment_source_id,
    'amount',p_amount,'currency',p_currency,'status',p_status,
    'effective_at',extract(epoch from p_effective_at),
    'candidate_next',extract(epoch from p_candidate_next_payment)
  )::text,'UTF8')),'hex');

  select * into v_before
  from public.payment_attempts
  where id = p_attempt_id
  for update;

  if not found then
    raise exception 'PAYMENT_ATTEMPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_subscription from public.subscriptions where id = v_before.subscription_id for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_audit from public.admin_audit_logs
  where actor_user_id = p_actor_user_id and request_id = p_request_id;
  if found then
    if v_audit.action <> 'payment_recovery'
      or v_audit.after_value ->> 'request_digest' is distinct from v_request_digest then
      raise exception 'ADMIN_REQUEST_ID_CONFLICT' using errcode = '22023';
    end if;
    v_response := v_audit.after_value -> 'response';
    perform public.mark_wompi_receipt(p_raw,
      case when v_response ->> 'result' = 'review' then 'review' else 'duplicate' end, v_response ->> 'reason');
    return v_response || jsonb_build_object('result',
      case when v_response ->> 'result' = 'review' then 'review' else 'duplicate' end);
  end if;
  if v_subscription.billing_version is distinct from p_expected_version then
    raise exception 'SUBSCRIPTION_VERSION_CONFLICT' using errcode = '40001';
  end if;
  if v_before.wompi_transaction_id is not null and v_before.wompi_transaction_id <> p_transaction_id then
    raise exception 'PAYMENT_RECOVERY_TRANSACTION_ID_MISMATCH' using errcode = '22023';
  end if;
  if v_before.state <> 'unknown' and v_before.wompi_transaction_id is null
    and not (v_before.state = 'dispatching' and v_before.updated_at <= clock_timestamp() - interval '15 minutes') then
    raise exception 'PAYMENT_RECOVERY_NOT_ALLOWED' using errcode = '55000';
  end if;
  select * into v_payment_before from public.payments where wompi_transaction_id = p_transaction_id;
  if v_before.reference is distinct from p_reference
    or (v_payment_before.id is null and (v_before.amount is distinct from p_amount or v_before.currency is distinct from p_currency))
    or (v_payment_before.id is not null and (v_payment_before.amount is distinct from p_amount
      or v_payment_before.currency is distinct from p_currency
      or v_payment_before.subscription_id is distinct from v_subscription.id)) then
    raise exception 'PAYMENT_RECOVERY_MISMATCH' using errcode = '22023';
  end if;
  v_owns_version := coalesce(v_before.subscription_version = v_subscription.billing_version, false);
  v_terminal_status := case
    when v_before.state = 'approved' then 'approved'
    when v_before.state = 'declined' then 'declined'
    when v_before.provider_status in ('approved','declined','error','voided') then v_before.provider_status
    else null end;

  v_event_key := encode(sha256(convert_to(
    'admin-recovery|' || p_attempt_id::text || '|' || p_transaction_id || '|'
    || p_status || '|' || coalesce(extract(epoch from p_effective_at)::text, 'unknown'), 'UTF8'
  )), 'hex');
  if v_terminal_status is not null and v_terminal_status <> p_status then
    -- An old terminal attempt is evidence too, even if its historical payment is absent.
    v_applied := jsonb_build_object('result','review','reason','PAYMENT_RECOVERY_STATUS_NOT_APPLIED');
  else
    v_applied := public.apply_verified_wompi_event(
      v_event_key,
      p_transaction_id,
      'transaction.admin_recovery',
      p_reference,
      p_payment_source_id,
      p_amount,
      p_currency,
      p_status,
      p_effective_at,
      p_candidate_next_payment,
      p_raw
    );
  end if;
  if coalesce(v_applied ->> 'result', '') not in ('processed', 'duplicate', 'review') then
    raise exception 'PAYMENT_RECOVERY_APPLY_FAILED' using errcode = '55000';
  end if;

  select * into v_after from public.payment_attempts where id = p_attempt_id;
  select * into v_payment_after from public.payments where wompi_transaction_id = p_transaction_id;
  select * into v_subscription_after from public.subscriptions where id = v_subscription.id;
  v_changed := (to_jsonb(v_before) - array['created_at','updated_at','error_code'])
      is distinct from (to_jsonb(v_after) - array['created_at','updated_at','error_code'])
    or (to_jsonb(v_payment_before) - array['created_at','updated_at'])
      is distinct from (to_jsonb(v_payment_after) - array['created_at','updated_at'])
    or (to_jsonb(v_subscription) - array['updated_at','schedule_updated_at','billing_version'])
      is distinct from (to_jsonb(v_subscription_after) - array['updated_at','schedule_updated_at','billing_version']);
  if v_applied ->> 'result' = 'review' then
    v_review_reason := coalesce(v_applied ->> 'error',v_applied ->> 'reason','PAYMENT_DATE_OR_VERSION_NEEDS_REVIEW');
  elsif v_after.wompi_transaction_id is distinct from p_transaction_id or v_after.state = 'unknown' then
    v_review_reason := 'PAYMENT_RECOVERY_NOT_APPLIED';
  elsif v_after.provider_status is distinct from p_status then
    v_review_reason := 'PAYMENT_RECOVERY_STATUS_NOT_APPLIED';
  elsif not v_owns_version and (v_changed or p_status = 'pending') then
    v_review_reason := 'PAYMENT_RECOVERY_ADMIN_VERSION_PROTECTED';
  elsif v_changed and v_subscription.status in ('cancelled','canceled') then
    v_review_reason := 'PAYMENT_RECOVERY_CANCELLED_SUBSCRIPTION';
  elsif v_changed and p_status = 'approved' and v_applied ->> 'scheduleProtected' = 'true' then
    v_review_reason := 'PAYMENT_RECOVERY_SCHEDULE_PROTECTED';
  end if;
  if v_changed then
    update public.subscriptions set billing_version = billing_version + 1,
      schedule_updated_at = clock_timestamp(), updated_at = clock_timestamp() where id = v_subscription.id
    returning * into v_subscription_after;
    -- Only this explicit PENDING recovery owns the new snapshot. Never rebase a later admin decision.
    if p_status = 'pending' and v_after.state = 'pending' and v_owns_version
      and v_subscription.status not in ('cancelled','canceled') and v_applied ->> 'result' <> 'review' then
      update public.payment_attempts set subscription_version = v_subscription_after.billing_version
      where id = p_attempt_id returning * into v_after;
    end if;
  end if;
  if v_review_reason is not null then
    update public.payment_attempts set error_code = v_review_reason where id = p_attempt_id returning * into v_after;
    perform public.mark_wompi_receipt(p_raw, 'review', v_review_reason);
  end if;
  v_response := jsonb_build_object(
    'result',case when v_review_reason is not null then 'review' when v_changed then 'recovered' else 'duplicate' end,
    'attemptId',v_after.id,'transactionId',coalesce(v_after.wompi_transaction_id,p_transaction_id),
    'providerStatus',v_after.provider_status,'state',v_after.state,
    'billingVersion',v_subscription_after.billing_version,'reason',v_review_reason);

  insert into public.admin_audit_logs(
    actor_user_id, subscription_id, action, reason, before_value, after_value, request_id,
    expected_version, actor_aal, actor_session_issued_at, totp_verified_at
  ) values (
    p_actor_user_id,
    v_after.subscription_id,
    'payment_recovery',
    trim(p_reason),
    jsonb_build_object(
      'attempt_id', v_before.id,
      'state', v_before.state,
      'transaction_id_present', v_before.wompi_transaction_id is not null,
      'error_code', v_before.error_code,
      'subscription_version',v_before.subscription_version,
      'billing_version',v_subscription.billing_version
    ),
    jsonb_build_object(
      'attempt_id', v_after.id,
      'state', v_after.state,
      'transaction_id', v_after.wompi_transaction_id,
      'provider_status', v_after.provider_status,
      'application_result', v_applied ->> 'result',
      'billing_version', v_subscription_after.billing_version,
      'subscription_version',v_after.subscription_version,
      'request_digest',v_request_digest,'response',v_response
    ),
    p_request_id, p_expected_version, p_actor_aal, p_actor_session_issued_at, p_totp_verified_at
  );

  return v_response;
end;
$$;

revoke all on function public.admin_reconcile_payment_attempt(uuid, uuid, text, uuid, text, text, text, integer, text, text, timestamptz, timestamptz, jsonb, integer, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_reconcile_payment_attempt(uuid, uuid, text, uuid, text, text, text, integer, text, text, timestamptz, timestamptz, jsonb, integer, text, timestamptz, timestamptz) to service_role;

drop function if exists public.admin_close_unidentified_payment_attempt(uuid, uuid, text, uuid);
drop function if exists public.admin_close_unidentified_payment_attempt(uuid, uuid, text, uuid, boolean);

create or replace function public.admin_close_unidentified_payment_attempt(
  p_attempt_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_request_id uuid,
  p_no_transaction_confirmed boolean,
  p_expected_version integer default null,
  p_actor_aal text default null,
  p_actor_session_issued_at timestamptz default null,
  p_totp_verified_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.payment_attempts%rowtype;
  v_subscription_before public.subscriptions%rowtype;
  v_subscription_after public.subscriptions%rowtype;
begin
  perform public.assert_admin_mutation_context(p_actor_user_id, p_actor_aal, p_actor_session_issued_at, p_totp_verified_at);
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'ADMIN_EXPECTED_VERSION_REQUIRED' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 or p_request_id is null then
    raise exception 'ADMIN_REASON_REQUIRED' using errcode = '22023';
  end if;
  if p_no_transaction_confirmed is not true then
    raise exception 'NO_TRANSACTION_CONFIRMATION_REQUIRED' using errcode = '22023';
  end if;

  select * into v_before
  from public.payment_attempts
  where id = p_attempt_id
  for update;
  if not found then
    raise exception 'PAYMENT_ATTEMPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if (
       v_before.state <> 'unknown'
       and not (v_before.state = 'dispatching' and v_before.updated_at <= now() - interval '15 minutes')
     )
     or v_before.wompi_transaction_id is not null then
    raise exception 'PAYMENT_RECOVERY_NOT_ALLOWED' using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.payments
    where payment_attempt_id = v_before.id
       or (
         subscription_id = v_before.subscription_id
         and reference = v_before.reference
         and status in ('approved', 'pending')
       )
  ) then
    raise exception 'PAYMENT_RESULT_ALREADY_EXISTS' using errcode = '55000';
  end if;

  select * into v_subscription_before
  from public.subscriptions
  where id = v_before.subscription_id
  for update;
  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_subscription_before.billing_version is distinct from p_expected_version then
    raise exception 'SUBSCRIPTION_VERSION_CONFLICT' using errcode = '40001';
  end if;

  update public.payment_attempts
  set state = 'failed',
      subscription_version = v_subscription_before.billing_version,
      provider_status = null,
      error_code = 'ADMIN_CONFIRMED_NO_TRANSACTION',
      completed_at = now(),
      updated_at = now()
  where id = v_before.id;

  update public.subscriptions
  set status = case when status = 'cancelled' then status else 'past_due' end,
      billing_version = billing_version + 1,
      schedule_updated_at = now(),
      updated_at = now()
  where id = v_subscription_before.id
  returning * into v_subscription_after;

  if v_before.checkout_intent_id is not null then
    update public.checkout_intents
    set state = 'failed', updated_at = now()
    where id = v_before.checkout_intent_id
      and state = 'processing';
  end if;

  insert into public.admin_audit_logs(
    actor_user_id, subscription_id, action, reason, before_value, after_value, request_id,
    expected_version, actor_aal, actor_session_issued_at, totp_verified_at
  ) values (
    p_actor_user_id,
    v_before.subscription_id,
    'payment_recovery_closed',
    trim(p_reason),
    jsonb_build_object(
      'attempt_id', v_before.id,
      'attempt_state', v_before.state,
      'subscription_status', v_subscription_before.status,
      'billing_version', v_subscription_before.billing_version,
      'transaction_id_present', false
    ),
    jsonb_build_object(
      'attempt_id', v_before.id,
      'attempt_state', 'failed',
      'subscription_status', v_subscription_after.status,
      'billing_version', v_subscription_after.billing_version,
      'automatic_retry', false,
      'no_transaction_confirmed', p_no_transaction_confirmed
    ),
    p_request_id, p_expected_version, p_actor_aal, p_actor_session_issued_at, p_totp_verified_at
  );

  return jsonb_build_object(
    'result', 'closed',
    'attemptId', v_before.id,
    'state', 'failed',
    'subscriptionStatus', v_subscription_after.status,
    'billingVersion', v_subscription_after.billing_version
  );
end;
$$;

revoke all on function public.admin_close_unidentified_payment_attempt(uuid, uuid, text, uuid, boolean, integer, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_close_unidentified_payment_attempt(uuid, uuid, text, uuid, boolean, integer, text, timestamptz, timestamptz) to service_role;

grant select (id, email, first_name, last_name, phone, city, created_at)
  on public.donors to authenticated;
grant select (id, donor_id, amount, currency, frequency, status, payment_method_type,
  wompi_masked_details, preferred_payment_day, next_payment_date, reference, created_at,
  cancelled_at, billing_version, schedule_updated_at, updated_at)
  on public.subscriptions to authenticated;
grant select (id, subscription_id, amount, currency, status, wompi_transaction_id,
  reference, approved_at, provider_effective_at, billing_review_required, created_at, updated_at)
  on public.payments to authenticated;
grant select (user_id, role, active, sessions_valid_after, created_at, updated_at)
  on public.admin_users to authenticated;
grant select (id, actor_user_id, subscription_id, action, reason, before_value, after_value, request_id, created_at,
  expected_version, actor_aal, actor_session_issued_at, totp_verified_at)
  on public.admin_audit_logs to authenticated;
grant select (id, donor_id, subscription_id, reference, amount, currency, state, wompi_transaction_id,
  subscription_version, billing_period, provider_status, error_code, completed_at, created_at, updated_at)
  on public.payment_attempts to authenticated;

drop policy if exists admin_read_donors on public.donors;
drop policy if exists admin_read_subscriptions on public.subscriptions;
drop policy if exists admin_read_payments on public.payments;
drop policy if exists admin_read_admin_users on public.admin_users;
drop policy if exists admin_read_audit on public.admin_audit_logs;
drop policy if exists admin_read_payment_attempts on public.payment_attempts;

create policy admin_read_donors on public.donors for select to authenticated
  using (public.is_active_admin(array['admin', 'super_admin']));
create policy admin_read_subscriptions on public.subscriptions for select to authenticated
  using (public.is_active_admin(array['admin', 'super_admin']));
create policy admin_read_payments on public.payments for select to authenticated
  using (public.is_active_admin(array['admin', 'super_admin']));
create policy admin_read_admin_users on public.admin_users for select to authenticated
  using (user_id = auth.uid() and public.is_active_admin(array['admin','super_admin']));
create policy admin_read_audit on public.admin_audit_logs for select to authenticated
  using (public.is_active_admin(array['admin', 'super_admin']));
create policy admin_read_payment_attempts on public.payment_attempts for select to authenticated
  using (public.is_active_admin(array['admin', 'super_admin']));

-- Neither successful DDL nor a valid supplied digest is enough without content/PK checks.
do $$
declare
  v_original record;
  v_primary text[];
  v_count bigint;
  v_digest text;
  v_changed boolean;
begin
  if coalesce(current_setting('app.migration_digest', true), '') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'MIGRATION_DIGEST_REQUIRED';
  end if;
  for v_original in select * from pg_temp.payment_admin_original_schema loop
    select array_agg(a.attname::text order by k.ordinality) into v_primary
    from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, ordinality)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indrelid = to_regclass('public.' || v_original.table_name) and i.indisprimary;
    if v_primary is distinct from v_original.primary_columns then
      raise exception 'PRESERVATION_FAILED_PRIMARY_KEY: %', v_original.table_name;
    end if;
    execute format('select count(*), encode(sha256(convert_to(coalesce(string_agg(
      (select jsonb_object_agg(k, to_jsonb(t) -> k) from unnest($1) k)::text,
      E''\n'' order by (select jsonb_object_agg(k, to_jsonb(t) -> k) from unnest($2) k)::text), ''''), ''UTF8'')), ''hex'')
      from public.%I t', v_original.table_name)
    into v_count, v_digest using v_original.columns, v_original.primary_columns;
    execute format('select exists (select 1 from pg_temp.payment_admin_original_rows r
      where r.table_name = $1 and not exists (select 1 from public.%I t
        where r.primary_value <@ to_jsonb(t) and r.content <@ to_jsonb(t)))', v_original.table_name)
    into v_changed using v_original.table_name;
    if v_changed or v_count <> v_original.row_count or v_digest <> v_original.content_digest then
      raise exception 'PRESERVATION_FAILED_CONTENT: %', v_original.table_name;
    end if;
  end loop;
  insert into public.payment_admin_migrations(name, digest)
  values ('payment-admin-hardening-v0.3.0', lower(current_setting('app.migration_digest')))
  on conflict (name) do nothing;
  if not exists (select 1 from public.payment_admin_migrations
    where name = 'payment-admin-hardening-v0.3.0'
      and digest = lower(current_setting('app.migration_digest')))
    or not public.payment_admin_schema_ready() then
    raise exception 'MIGRATION_MARKER_ASSERTION_FAILED';
  end if;
end $$;

commit;
