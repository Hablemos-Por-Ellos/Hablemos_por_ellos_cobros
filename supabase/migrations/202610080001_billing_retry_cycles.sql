-- ESCRITURA | v0.4.0 | 2026-10-08 | LOCAL ONLY, production authorization required.
-- Runner: same-session app.migration_digest = SHA-256 of this exact file, total budget 300s.
-- No historic backfill. Amounts are COP units; provider requests/results use integer cents.
-- Replaces only the monthly attempt index and v1 financial entry points/permissions.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if coalesce(current_setting('app.migration_digest',true),'') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'MIGRATION_DIGEST_REQUIRED';
  end if;
  if to_regclass('public.payment_admin_migrations') is null
    or not exists (select 1 from public.payment_admin_migrations where name = 'payment-admin-hardening-v0.3.0') then
    raise exception 'BILLING_V1_SCHEMA_REQUIRED';
  end if;
  if exists (select 1 from public.payment_admin_migrations where name = 'billing-retry-v0.4.0'
    and digest <> lower(current_setting('app.migration_digest'))) then
    raise exception 'MIGRATION_DIGEST_MISMATCH';
  end if;
end $$;

select pg_advisory_xact_lock(hashtextextended('billing-retry-v0.4.0',0));

create temporary table billing_retry_original_schema(
  table_name text primary key, columns text[] not null, primary_columns text[] not null,
  row_count bigint not null, content_digest text not null
) on commit drop;
create temporary table billing_retry_original_rows(
  table_name text not null, primary_value jsonb not null, content jsonb not null,
  primary key(table_name,primary_value)
) on commit drop;
create temporary table billing_retry_start on commit drop as select clock_timestamp() as started_at;

do $$
declare t text; cols text[]; pk text[]; n bigint; d text;
begin
  foreach t in array array['donors','subscriptions','payments','webhook_events','audit_logs',
    'admin_users','admin_invitations','admin_audit_logs','checkout_intents','payment_attempts','api_rate_limits',
    'payment_admin_migrations','billing_cycles'] loop
    if to_regclass('public.'||t) is null then
      if t <> 'billing_cycles' then raise exception 'BILLING_REQUIRED_TABLE_MISSING: %',t; end if;
      continue;
    end if;
    execute format('lock table public.%I in share row exclusive mode',t);
    select array_agg(attname::text order by attnum) into cols from pg_attribute
    where attrelid = to_regclass('public.'||t) and attnum > 0 and not attisdropped;
    select array_agg(a.attname::text order by k.ordinality) into pk
    from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum,ordinality)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indrelid = to_regclass('public.'||t) and i.indisprimary;
    if pk is null then raise exception 'BILLING_REQUIRED_PK_MISSING: %',t; end if;
    execute format('insert into pg_temp.billing_retry_original_rows select %L,
      (select jsonb_object_agg(k,to_jsonb(t)->k) from unnest($1) k),to_jsonb(t) from public.%I t',t,t) using pk;
    select count(*),encode(sha256(convert_to(coalesce(string_agg(content::text,E'\n'
      order by primary_value::text),''),'UTF8')),'hex') into n,d
    from pg_temp.billing_retry_original_rows where table_name = t;
    insert into pg_temp.billing_retry_original_schema values(t,cols,pk,n,d);
  end loop;
end $$;

alter table public.subscriptions
  add column if not exists billing_authorization jsonb,
  add column if not exists billing_authorization_revoked_at timestamptz,
  add column if not exists billing_hold_reason text;
alter table public.checkout_intents add column if not exists retry_authorization jsonb;
alter table public.admin_audit_logs
  add column if not exists request_fingerprint text,
  add column if not exists committed_response jsonb;

create table if not exists public.billing_cycles(
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id),
  donor_id uuid not null references public.donors(id),
  billing_period text not null check(billing_period ~ '^[0-9]{4}(0[1-9]|1[0-2])$'
    and left(billing_period,4)::integer between 1970 and 9999),
  origin text not null check(origin in ('initial','renewal','reactivation')),
  state text not null default 'open' check(state in ('open','retry_wait','approved','manual_review','cancelled')),
  checkout_intent_id uuid references public.checkout_intents(id),
  authorization_audit_id uuid references public.admin_audit_logs(id),
  retry_enabled boolean not null,
  authorization_snapshot jsonb,
  amount integer not null check(amount between 1500 and 21474836),
  currency text not null check(currency = 'COP'),
  payment_source_id text not null check(length(btrim(payment_source_id)) > 0),
  environment text not null check(environment in ('prod','sandbox')),
  preferred_payment_day integer not null check(preferred_payment_day in (1,6,16,28)),
  subscription_version integer not null check(subscription_version >= 0),
  original_due_at timestamptz not null check(isfinite(original_due_at)),
  retry_window_start timestamptz,
  retry_window_end timestamptz,
  retry_evidence_attempt_id uuid,
  first_approved_attempt_id uuid,
  first_approved_at timestamptz,
  closed_at timestamptz,
  hold_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check((retry_window_start is null and retry_window_end is null)
    or (retry_window_start is not null and retry_window_end is not null
      and isfinite(retry_window_start) and isfinite(retry_window_end) and retry_window_end > retry_window_start)),
  check((first_approved_attempt_id is null and first_approved_at is null)
    or (first_approved_attempt_id is not null and first_approved_at is not null and isfinite(first_approved_at))),
  check((origin = 'initial' and checkout_intent_id is not null and authorization_audit_id is null)
    or (origin = 'renewal' and checkout_intent_id is null and authorization_audit_id is null)
    or (origin = 'reactivation' and checkout_intent_id is null and authorization_audit_id is not null)),
  check(not retry_enabled or coalesce((jsonb_typeof(authorization_snapshot) = 'object'
    and authorization_snapshot->>'recurring' = 'true'
    and authorization_snapshot->>'retryAllowed' = 'true'
    and authorization_snapshot->>'sourceVerified' = 'true'),false))
);

alter table public.payment_attempts
  add column if not exists cycle_id uuid references public.billing_cycles(id),
  add column if not exists attempt_number smallint,
  add column if not exists parent_attempt_id uuid references public.payment_attempts(id),
  add column if not exists verified_reason text,
  add column if not exists verified_status_message text,
  add column if not exists verified_finalized_at timestamptz,
  add column if not exists verified_evidence jsonb,
  add column if not exists send_authorized_at timestamptz,
  add column if not exists send_window_end timestamptz,
  add column if not exists dispatch_snapshot jsonb;
alter table public.payment_attempts drop constraint if exists payment_attempts_state_check;
alter table public.payment_attempts add constraint payment_attempts_state_check
  check(state in ('prepared','dispatching','pending','approved','declined','failed','unknown','cancelled'));
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid = 'public.payment_attempts'::regclass
    and conname = 'billing_v2_attempt_ordinal_check') then
    alter table public.payment_attempts add constraint billing_v2_attempt_ordinal_check check(
      (cycle_id is null and attempt_number is null and parent_attempt_id is null)
      or (attempt_number is not null and attempt_number = 1 and parent_attempt_id is null)
      or (cycle_id is not null and attempt_number is not null and attempt_number = 2 and parent_attempt_id is not null));
  end if;
end $$;

-- Original v1 rows retain their unique subscription/period budget. V2 has a cycle budget.
drop index if exists public.payment_attempts_subscription_period_unique;
create unique index payment_attempts_subscription_period_unique on public.payment_attempts(subscription_id,billing_period)
  where subscription_id is not null and billing_period is not null and cycle_id is null;
create unique index if not exists billing_cycles_one_open on public.billing_cycles(subscription_id)
  where state in ('open','retry_wait');
create unique index if not exists billing_cycles_renewal_period_unique on public.billing_cycles(subscription_id,billing_period)
  where origin = 'renewal';
create unique index if not exists billing_cycles_initial_checkout_unique on public.billing_cycles(checkout_intent_id)
  where origin = 'initial';
create unique index if not exists billing_cycles_reactivation_audit_unique on public.billing_cycles(authorization_audit_id)
  where origin = 'reactivation';
create unique index if not exists payment_attempts_cycle_number_unique on public.payment_attempts(cycle_id,attempt_number)
  where cycle_id is not null;
create index if not exists billing_cycles_retry_queue on public.billing_cycles(retry_window_start,retry_window_end)
  where state = 'retry_wait';

create or replace function public.billing_retry_schema_ready()
returns boolean language sql stable security definer set search_path = pg_catalog,public as $$
  select exists(select 1 from public.payment_admin_migrations where name = 'billing-retry-v0.4.0'
    and digest ~ '^[0-9a-f]{64}$')
$$;

-- All v2 entry points take the same donor -> subscription -> cycles -> attempts order.
-- The unlocked lookup discovers identity only; locked rows are always re-read.
create or replace function public.billing_v2_lock_subscription(p_subscription_id uuid)
returns public.subscriptions language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; d uuid;
begin
  if not public.billing_retry_schema_ready() then raise exception 'BILLING_V2_SCHEMA_REQUIRED'; end if;
  select donor_id into d from public.subscriptions where id = p_subscription_id;
  if d is null then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002'; end if;
  perform 1 from public.donors where id = d for update;
  select * into s from public.subscriptions where id = p_subscription_id for update;
  if s.donor_id is distinct from d then raise exception 'SUBSCRIPTION_IDENTITY_CHANGED'; end if;
  perform 1 from public.billing_cycles where subscription_id = s.id order by id for update;
  perform 1 from public.payment_attempts where donor_id = d or subscription_id = s.id order by id for update;
  return s;
end $$;

create or replace function public.billing_v2_month_block(p_subscription_id uuid,p_at timestamptz,p_except_attempt uuid default null)
returns text language plpgsql security definer set search_path = pg_catalog,public as $$
declare start_at timestamptz; end_at timestamptz;
begin
  if p_at is null or not isfinite(p_at) then return 'INVALID_BILLING_CLOCK'; end if;
  start_at := date_trunc('month',p_at at time zone 'America/Bogota') at time zone 'America/Bogota';
  end_at := (date_trunc('month',p_at at time zone 'America/Bogota')+interval '1 month') at time zone 'America/Bogota';
  if exists(select 1 from public.payments where subscription_id = p_subscription_id
    and (billing_review_required or status is null or status = 'pending'
      or (status = 'approved' and (coalesce(approved_at,provider_effective_at) is null
        or not isfinite(coalesce(approved_at,provider_effective_at)))))) then
    return 'PAYMENT_DATE_OR_RESULT_NEEDS_REVIEW';
  end if;
  if exists(select 1 from public.payments where subscription_id = p_subscription_id and status = 'approved'
    and coalesce(approved_at,provider_effective_at) >= start_at
    and coalesce(approved_at,provider_effective_at) < end_at) then return 'BILLING_MONTH_ALREADY_PAID'; end if;
  if exists(select 1 from public.payment_attempts a join public.subscriptions s on s.id = p_subscription_id
    where a.id is distinct from p_except_attempt and (a.donor_id = s.donor_id
      or a.subscription_id in(select id from public.subscriptions where donor_id = s.donor_id))
    and a.state in ('dispatching','pending','unknown')) then return 'DONOR_HAS_UNRESOLVED_ATTEMPT'; end if;
  return null;
end $$;

create or replace function public.billing_v2_authorization_valid(p_subscription_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog,public as $$
  select coalesce(s.frequency = 'monthly' and s.billing_authorization_revoked_at is null
    and s.billing_authorization->>'version' = '0.4.0'
    and s.billing_authorization->>'recurring' = 'true'
    and s.billing_authorization->>'retryAllowed' = 'true'
    and s.billing_authorization->>'sourceVerified' = 'true'
    and s.billing_authorization->>'sourceId' = s.wompi_payment_source_id
    and s.billing_authorization->>'method' = 'CARD'
    and s.billing_authorization->>'environment' in ('prod','sandbox')
    and nullif(s.billing_authorization->>'mandateId','') is not null,false)
  from public.subscriptions s where s.id = p_subscription_id
$$;

create or replace function public.billing_v2_normalize_status_message(p_message text)
returns text language sql immutable set search_path = pg_catalog,public as $$
  select btrim(normalize(coalesce(p_message,''),NFKC),
    (select string_agg(chr(c),'' order by c) from unnest(array[9,10,11,12,13,32,160,5760,
      8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279]) c))
$$;

create or replace function public.billing_v2_preserve_snapshot()
returns trigger language plpgsql set search_path = pg_catalog,public as $$
begin
  if tg_table_name = 'billing_cycles' then
    if (to_jsonb(new) - array['state','retry_window_start','retry_window_end','retry_evidence_attempt_id',
      'first_approved_attempt_id','first_approved_at','closed_at','hold_reason','updated_at'])
      is distinct from (to_jsonb(old) - array['state','retry_window_start','retry_window_end','retry_evidence_attempt_id',
      'first_approved_attempt_id','first_approved_at','closed_at','hold_reason','updated_at']) then
      raise exception 'BILLING_CYCLE_SNAPSHOT_IMMUTABLE' using errcode = '22023';
    end if;
    if old.first_approved_attempt_id is not null and (new.first_approved_attempt_id is distinct from old.first_approved_attempt_id
      or new.first_approved_at is distinct from old.first_approved_at) then raise exception 'FIRST_APPROVAL_IMMUTABLE'; end if;
  elsif old.attempt_number is not null and
    (to_jsonb(new) - array['state','wompi_transaction_id','provider_status','error_code','dispatched_at','completed_at',
      'updated_at','verified_reason','verified_status_message','verified_finalized_at','verified_evidence',
      'send_authorized_at','send_window_end'])
    is distinct from (to_jsonb(old) - array['state','wompi_transaction_id','provider_status','error_code','dispatched_at','completed_at',
      'updated_at','verified_reason','verified_status_message','verified_finalized_at','verified_evidence',
      'send_authorized_at','send_window_end']) then raise exception 'BILLING_ATTEMPT_SNAPSHOT_IMMUTABLE';
  end if;
  if tg_table_name = 'payment_attempts' then
    if old.send_authorized_at is not null and
      (new.send_authorized_at is distinct from old.send_authorized_at or new.send_window_end is distinct from old.send_window_end) then
      raise exception 'SEND_AUTHORIZATION_IMMUTABLE';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists billing_v2_cycle_snapshot on public.billing_cycles;
create trigger billing_v2_cycle_snapshot before update on public.billing_cycles for each row execute function public.billing_v2_preserve_snapshot();
drop trigger if exists billing_v2_attempt_snapshot on public.payment_attempts;
create trigger billing_v2_attempt_snapshot before update on public.payment_attempts for each row execute function public.billing_v2_preserve_snapshot();

create or replace function public.billing_v2_prepare_subscription(p_checkout_id uuid,p_payment_method text)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare i public.checkout_intents; s public.subscriptions; d uuid;
begin
  if not public.billing_retry_schema_ready() then raise exception 'BILLING_V2_SCHEMA_REQUIRED'; end if;
  if p_payment_method is null or p_payment_method not in ('card','nequi') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  select donor_id into d from public.checkout_intents where id = p_checkout_id;
  if d is null then raise exception 'CHECKOUT_INVALID'; end if;
  perform 1 from public.donors where id = d for update;
  select * into i from public.checkout_intents where id = p_checkout_id;
  select * into s from public.subscriptions where reference = i.reference for update;
  select * into i from public.checkout_intents where id = p_checkout_id for update;
  if s.id is not null then
    if s.donor_id <> i.donor_id or s.amount <> i.amount or s.currency <> i.currency
      or s.frequency <> (case when i.is_recurring then 'monthly' else 'one_time' end) then raise exception 'CHECKOUT_SUBSCRIPTION_MISMATCH'; end if;
    return jsonb_build_object('id',s.id,'status',s.status,'billing_version',s.billing_version,
      'wompi_payment_source_id',s.wompi_payment_source_id);
  end if;
  if not isfinite(i.expires_at) or i.expires_at <= clock_timestamp() then raise exception 'CHECKOUT_EXPIRED'; end if;
  if i.state not in ('draft','checkout') or i.currency <> 'COP' or i.amount not between 1500 and 21474836
    or (i.is_recurring and (p_payment_method <> 'card' or i.preferred_payment_day is null)) then raise exception 'CHECKOUT_INVALID'; end if;
  insert into public.subscriptions(donor_id,amount,currency,frequency,status,payment_method_type,
    preferred_payment_day,reference,next_payment_date,processed_transaction_ids)
  values(i.donor_id,i.amount,i.currency,case when i.is_recurring then 'monthly' else 'one_time' end,
    'pending',p_payment_method,i.preferred_payment_day,i.reference,null,'{}') returning * into s;
  update public.checkout_intents set payment_method_type = p_payment_method,state = 'checkout',updated_at = clock_timestamp()
  where id = i.id;
  return jsonb_build_object('id',s.id,'status',s.status,'billing_version',s.billing_version,
    'wompi_payment_source_id',s.wompi_payment_source_id);
end $$;

create or replace function public.billing_v2_bind_source(p_checkout_id uuid,p_subscription_id uuid,
  p_payment_source_id text,p_source_verified boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; i public.checkout_intents; proof jsonb; accepted_at timestamptz;
begin
  s := public.billing_v2_lock_subscription(p_subscription_id);
  select * into i from public.checkout_intents where id = p_checkout_id for update;
  if i.id is null or s.reference <> i.reference or s.donor_id <> i.donor_id
    or p_source_verified is not true or nullif(btrim(p_payment_source_id),'') is null
    or s.payment_method_type <> 'card' or i.payment_method_type <> 'card' then raise exception 'SOURCE_VERIFICATION_REQUIRED'; end if;
  if s.wompi_payment_source_id is not null then
    if s.wompi_payment_source_id <> p_payment_source_id then raise exception 'PAYMENT_SOURCE_CONFLICT'; end if;
    return jsonb_build_object('id',s.id,'status',s.status,'billing_version',s.billing_version,
      'wompi_payment_source_id',s.wompi_payment_source_id);
  end if;
  if s.status <> 'pending' or i.state not in ('draft','checkout') or i.expires_at <= clock_timestamp()
    or exists(select 1 from public.payment_attempts where subscription_id = s.id) then raise exception 'CHECKOUT_STATE_INVALID'; end if;
  if i.is_recurring and i.retry_authorization->>'version' = '0.4.0'
    and i.retry_authorization->>'recurring' = 'true' and i.retry_authorization->>'retryAllowed' = 'true' then
    begin accepted_at := (i.retry_authorization->>'acceptedAt')::timestamptz;
    exception when others then accepted_at := null; end;
    if accepted_at is null or not isfinite(accepted_at) or accepted_at < i.created_at - interval '5 seconds'
      or accepted_at > clock_timestamp() or accepted_at >= i.expires_at then raise exception 'RETRY_CONSENT_INVALID'; end if;
    proof := jsonb_build_object('version','0.4.0','kind','checkout','checkoutId',i.id,'mandateId',gen_random_uuid(),
      'environment',i.environment,'authorizedAt',accepted_at,'recurring',true,'retryAllowed',true,
      'sourceVerified',true,'sourceVerifiedAt',clock_timestamp(),'sourceId',p_payment_source_id,'method','CARD');
  end if;
  update public.subscriptions set wompi_payment_source_id = p_payment_source_id,billing_authorization = proof,
    updated_at = clock_timestamp() where id = s.id returning * into s;
  return jsonb_build_object('id',s.id,'status',s.status,'billing_version',s.billing_version,
    'wompi_payment_source_id',s.wompi_payment_source_id);
end $$;

create or replace function public.billing_v2_reservation_response(p_attempt_id uuid,p_result text)
returns jsonb language sql stable security definer set search_path = pg_catalog,public as $$
  select jsonb_build_object('result',p_result,'attempt',to_jsonb(a),'dispatchSnapshot',a.dispatch_snapshot)
  from public.payment_attempts a where a.id = p_attempt_id
$$;

create or replace function public.billing_v2_insert_original(p_subscription_id uuid,p_origin text,
  p_environment text,p_checkout_id uuid default null,p_audit_id uuid default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; c public.billing_cycles; a public.payment_attempts;
  i public.checkout_intents; now_at timestamptz := clock_timestamp(); aid uuid := gen_random_uuid();
  cid uuid := gen_random_uuid(); period text; ref text; snapshot jsonb; block text;
begin
  s := public.billing_v2_lock_subscription(p_subscription_id);
  if p_origin not in ('initial','renewal','reactivation') or p_environment not in ('prod','sandbox') then raise exception 'INVALID_CYCLE_ORIGIN'; end if;
  if p_origin = 'initial' then
    select * into a from public.payment_attempts where checkout_intent_id = p_checkout_id;
    if a.id is not null then return public.billing_v2_reservation_response(a.id,'existing'); end if;
    select * into i from public.checkout_intents where id = p_checkout_id for update;
    if i.id is null or i.reference <> s.reference or i.donor_id <> s.donor_id or i.amount <> s.amount
      or i.currency <> s.currency or i.environment <> p_environment or i.is_recurring <> (s.frequency = 'monthly')
      or s.status <> 'pending' or i.state not in ('draft','checkout') then raise exception 'CHECKOUT_INVALID'; end if;
    if i.expires_at <= now_at or not isfinite(i.expires_at) then raise exception 'CHECKOUT_EXPIRED'; end if;
    ref := i.reference;
  else
    if s.status <> 'active' or s.frequency <> 'monthly' or s.next_payment_date is null
      or not isfinite(s.next_payment_date) or s.billing_hold_reason is not null then raise exception 'SUBSCRIPTION_NOT_DUE'; end if;
    if p_origin = 'renewal' and s.next_payment_date > now_at then raise exception 'SUBSCRIPTION_NOT_DUE'; end if;
  end if;
  if s.frequency = 'monthly' then
    if nullif(s.wompi_payment_source_id,'') is null or s.payment_method_type <> 'card'
      or s.preferred_payment_day is null or s.preferred_payment_day not in (1,6,16,28)
      or s.billing_authorization_revoked_at is not null then raise exception 'INVALID_BILLING_SNAPSHOT'; end if;
    period := to_char(case when p_origin = 'reactivation' then s.next_payment_date else now_at end
      at time zone 'America/Bogota','YYYYMM');
    select * into c from public.billing_cycles where subscription_id = s.id and state in ('open','retry_wait');
    if c.id is not null then
      select * into a from public.payment_attempts where cycle_id = c.id and attempt_number = 1;
      if a.id is null then raise exception 'OPEN_CYCLE_WITHOUT_ORIGINAL'; end if;
      return public.billing_v2_reservation_response(a.id,'existing');
    end if;
    if p_origin = 'renewal' then
      select * into c from public.billing_cycles where subscription_id = s.id and billing_period = period and origin = 'renewal';
      if c.id is not null then
        select * into a from public.payment_attempts where cycle_id = c.id and attempt_number = 1;
        return public.billing_v2_reservation_response(a.id,'existing');
      end if;
      select * into a from public.payment_attempts where subscription_id = s.id and billing_period = period and cycle_id is null;
      if a.id is not null then return public.billing_v2_reservation_response(a.id,'legacy_requires_reconciliation'); end if;
    end if;
    block := public.billing_v2_month_block(s.id,case when p_origin = 'reactivation' then s.next_payment_date else now_at end);
    if block is not null then raise exception '%',block using errcode = '55000'; end if;
    insert into public.billing_cycles(id,subscription_id,donor_id,billing_period,origin,checkout_intent_id,
      authorization_audit_id,retry_enabled,authorization_snapshot,amount,currency,payment_source_id,environment,
      preferred_payment_day,subscription_version,original_due_at)
    values(cid,s.id,s.donor_id,period,p_origin,p_checkout_id,p_audit_id,
      public.billing_v2_authorization_valid(s.id),s.billing_authorization,s.amount,s.currency,s.wompi_payment_source_id,
      p_environment,s.preferred_payment_day,s.billing_version,
      case when p_origin = 'initial' then now_at else s.next_payment_date end) returning * into c;
    ref := coalesce(ref,'hpe-'||cid::text||'-'||period||'-1');
  else
    cid := null;
    if p_origin <> 'initial' or s.frequency <> 'one_time' then raise exception 'ONE_TIME_NOT_RECURRING'; end if;
    block := public.billing_v2_month_block(s.id,now_at);
    if block is not null then raise exception '%',block using errcode = '55000'; end if;
  end if;
  select jsonb_build_object('attemptId',aid,'cycleId',cid,'subscriptionId',s.id,'frequency',s.frequency,
    'attemptNumber',1,'reference',ref,'amount',s.amount,'currency',s.currency,'paymentSourceId',s.wompi_payment_source_id,
    'customerEmail',d.email,'preferredPaymentDay',s.preferred_payment_day,'billingVersion',s.billing_version,
    'environment',p_environment,'paymentMethodType',s.payment_method_type,
    'retryEnabled',coalesce(c.retry_enabled,false)) into snapshot
  from public.donors d where d.id = s.donor_id;
  insert into public.payment_attempts(id,checkout_intent_id,donor_id,subscription_id,billing_period,reference,
    amount,currency,subscription_version,state,cycle_id,attempt_number,dispatch_snapshot)
  values(aid,p_checkout_id,s.donor_id,s.id,period,ref,s.amount,s.currency,s.billing_version,'prepared',cid,1,snapshot);
  if p_checkout_id is not null then
    update public.checkout_intents set state = 'processing',consumed_at = coalesce(consumed_at,now_at),
      updated_at = now_at where id = p_checkout_id;
  end if;
  return public.billing_v2_reservation_response(aid,'reserved');
end $$;

create or replace function public.billing_v2_reserve_initial(p_checkout_id uuid,p_subscription_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare env text;
begin
  select environment into env from public.checkout_intents where id = p_checkout_id;
  return public.billing_v2_insert_original(p_subscription_id,'initial',env,p_checkout_id);
end $$;

create or replace function public.billing_v2_reserve_original(p_subscription_id uuid,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; a public.payment_attempts; env text;
begin
  s := public.billing_v2_lock_subscription(p_subscription_id);
  if s.billing_version is distinct from p_expected_version then raise exception 'SUBSCRIPTION_VERSION_CONFLICT' using errcode = '40001'; end if;
  select * into a from public.payment_attempts where subscription_id = s.id and state = 'prepared'
    and attempt_number = 1 order by created_at desc limit 1;
  if a.id is not null then return public.billing_v2_reservation_response(a.id,'existing'); end if;
  -- V1 used production for renewals. Existing initial checkouts provide a more specific environment.
  env := coalesce(s.billing_authorization->>'environment',(select environment from public.checkout_intents
    where reference = s.reference limit 1),'prod');
  return public.billing_v2_insert_original(s.id,'renewal',env);
end $$;

create or replace function public.billing_v2_reserve_retry(p_cycle_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; c public.billing_cycles; a public.payment_attempts; original public.payment_attempts;
  aid uuid := gen_random_uuid(); block text; now_at timestamptz;
begin
  select subscription_id into s.id from public.billing_cycles where id = p_cycle_id;
  s := public.billing_v2_lock_subscription(s.id);
  select * into c from public.billing_cycles where id = p_cycle_id;
  select * into a from public.payment_attempts where cycle_id = c.id and attempt_number = 2;
  if a.id is not null then return public.billing_v2_reservation_response(a.id,'existing'); end if;
  now_at := clock_timestamp();
  if c.state <> 'retry_wait' or not c.retry_enabled or not public.billing_v2_authorization_valid(s.id)
    or s.billing_authorization is distinct from c.authorization_snapshot
    or s.billing_version <> c.subscription_version or s.billing_hold_reason is distinct from 'retry_wait'
    or s.status <> 'past_due' then raise exception 'RETRY_NOT_AUTHORIZED'; end if;
  if c.retry_window_start is null or c.retry_window_end is null then raise exception 'RETRY_WINDOW_MISSING'; end if;
  if now_at >= c.retry_window_end then
    update public.billing_cycles set state = 'manual_review',hold_reason = 'retry_window_missed',closed_at = now_at,updated_at = now_at where id = c.id;
    update public.subscriptions set status = 'past_due',next_payment_date = null,billing_hold_reason = 'retry_window_missed',updated_at = now_at where id = s.id;
    return jsonb_build_object('result','review','reason','RETRY_WINDOW_MISSED');
  end if;
  if now_at < c.retry_window_start then return jsonb_build_object('result','not_due','reason','RETRY_WINDOW_NOT_OPEN'); end if;
  select * into original from public.payment_attempts where cycle_id = c.id and attempt_number = 1;
  if original.state <> 'declined' or original.verified_reason <> 'insufficient_funds'
    or original.id is distinct from c.retry_evidence_attempt_id or original.verified_finalized_at is null then raise exception 'RETRY_EVIDENCE_REQUIRED'; end if;
  block := public.billing_v2_month_block(s.id,now_at);
  if block is not null then raise exception '%',block using errcode = '55000'; end if;
  insert into public.payment_attempts(id,donor_id,subscription_id,billing_period,reference,amount,currency,
    subscription_version,state,cycle_id,attempt_number,parent_attempt_id,dispatch_snapshot)
  values(aid,c.donor_id,c.subscription_id,c.billing_period,'hpe-'||c.id::text||'-'||c.billing_period||'-2',
    c.amount,c.currency,c.subscription_version,'prepared',c.id,2,original.id,
    original.dispatch_snapshot || jsonb_build_object('attemptId',aid,'attemptNumber',2,
      'reference','hpe-'||c.id::text||'-'||c.billing_period||'-2'));
  return public.billing_v2_reservation_response(aid,'reserved');
end $$;

create or replace function public.billing_v2_source_valid(p_source jsonb,p_expected_id text,p_environment text)
returns boolean language plpgsql security definer set search_path = pg_catalog,public as $$
declare verified_at timestamptz;
begin
  if p_source is null then return false; end if;
  begin verified_at := (p_source->>'verified_at')::timestamptz;
  exception when others then return false; end;
  return coalesce(p_source->>'id' = p_expected_id and p_source->>'type' = 'CARD'
    and p_source->>'status' = 'AVAILABLE' and p_source->>'environment' = p_environment
    and p_source->>'verification_source' = 'provider_get' and isfinite(verified_at)
    and verified_at between clock_timestamp()-interval '60 seconds' and clock_timestamp(),false);
end $$;

create or replace function public.billing_v2_authorize_send(p_attempt_id uuid,p_source_verification jsonb default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; a public.payment_attempts; c public.billing_cycles; i public.checkout_intents;
  now_at timestamptz; window_end timestamptz; block text; env text; source_id text;
begin
  select subscription_id into s.id from public.payment_attempts where id = p_attempt_id;
  s := public.billing_v2_lock_subscription(s.id);
  select * into a from public.payment_attempts where id = p_attempt_id;
  now_at := clock_timestamp();
  if a.state <> 'prepared' or a.attempt_number is null or a.send_authorized_at is not null
    or a.wompi_transaction_id is not null or a.dispatched_at is not null then
    return jsonb_build_object('canDispatch',false,'reason','ATTEMPT_NOT_CLAIMABLE');
  end if;
  if a.subscription_version <> s.billing_version or s.status = 'cancelled'
    or s.amount <> a.amount or s.currency <> a.currency
    or s.wompi_payment_source_id is distinct from a.dispatch_snapshot->>'paymentSourceId' then
    return jsonb_build_object('canDispatch',false,'reason','SUBSCRIPTION_VERSION_OR_SNAPSHOT_CHANGED');
  end if;
  env := a.dispatch_snapshot->>'environment'; source_id := a.dispatch_snapshot->>'paymentSourceId';
  if source_id is not null and not public.billing_v2_source_valid(p_source_verification,source_id,env) then
    return jsonb_build_object('canDispatch',false,'reason','SOURCE_VERIFICATION_REQUIRED');
  end if;
  if a.cycle_id is not null then
    select * into c from public.billing_cycles where id = a.cycle_id;
    if c.subscription_version <> s.billing_version or c.payment_source_id <> s.wompi_payment_source_id
      or c.amount <> s.amount or c.preferred_payment_day is distinct from s.preferred_payment_day
      or s.billing_authorization_revoked_at is not null or c.state not in ('open','retry_wait') then
      return jsonb_build_object('canDispatch',false,'reason','CYCLE_NOT_AUTHORIZED');
    end if;
    if c.retry_enabled and (not public.billing_v2_authorization_valid(s.id)
      or s.billing_authorization is distinct from c.authorization_snapshot) then
      return jsonb_build_object('canDispatch',false,'reason','AUTHORIZATION_REVOKED_OR_CHANGED');
    end if;
    if a.attempt_number = 2 then
      window_end := c.retry_window_end;
      if c.state <> 'retry_wait' or not c.retry_enabled or s.status <> 'past_due'
        or s.billing_hold_reason is distinct from 'retry_wait' or now_at < c.retry_window_start
        or now_at >= c.retry_window_end or c.retry_window_start is null then
        return jsonb_build_object('canDispatch',false,'reason','RETRY_WINDOW_OR_AUTHORIZATION_INVALID');
      end if;
      if not exists(select 1 from public.payment_attempts o where o.id = a.parent_attempt_id
        and o.cycle_id = c.id and o.attempt_number = 1 and o.state = 'declined'
        and o.verified_reason = 'insufficient_funds' and o.verified_finalized_at is not null) then
        return jsonb_build_object('canDispatch',false,'reason','RETRY_EVIDENCE_REQUIRED');
      end if;
    else
      window_end := ((now_at at time zone 'America/Bogota')::date+1)::timestamp at time zone 'America/Bogota';
      if c.original_due_at > now_at or (c.origin <> 'initial' and
        (s.status <> 'active' or s.billing_hold_reason is not null or s.next_payment_date is null or s.next_payment_date > now_at)) then
        return jsonb_build_object('canDispatch',false,'reason','ORIGINAL_NOT_DUE');
      end if;
    end if;
  else
    if s.frequency <> 'one_time' or a.attempt_number <> 1 or s.status <> 'pending' then
      return jsonb_build_object('canDispatch',false,'reason','ONE_TIME_NOT_RECURRING');
    end if;
  end if;
  if a.checkout_intent_id is not null then
    select * into i from public.checkout_intents where id = a.checkout_intent_id for update;
    if i.id is null or i.state <> 'processing' or i.expires_at <= now_at or i.environment <> env
      or i.reference <> a.reference or i.amount <> a.amount then
      return jsonb_build_object('canDispatch',false,'reason','CHECKOUT_EXPIRED_OR_CHANGED');
    end if;
    window_end := least(coalesce(window_end,i.expires_at),i.expires_at);
  end if;
  block := public.billing_v2_month_block(s.id,now_at,a.id);
  if block is not null then return jsonb_build_object('canDispatch',false,'reason',block); end if;
  -- clock_timestamp is re-read after every possible lock wait, never caller-supplied.
  now_at := clock_timestamp();
  if window_end is null or now_at >= window_end or
    (a.attempt_number = 2 and now_at < c.retry_window_start) then
    return jsonb_build_object('canDispatch',false,'reason','SEND_WINDOW_CLOSED');
  end if;
  update public.payment_attempts set state = 'dispatching',send_authorized_at = now_at,
    send_window_end = window_end,dispatched_at = now_at,updated_at = now_at where id = a.id;
  return a.dispatch_snapshot || jsonb_build_object('canDispatch',true,'reason',null,
    'sendAuthorizedAt',now_at,'windowEnd',window_end,'dispatchDeadline',least(now_at+interval '15 seconds',window_end));
end $$;

create or replace function public.billing_v2_mark_uncertain(p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; a public.payment_attempts;
begin
  select subscription_id into s.id from public.payment_attempts where id = p_attempt_id;
  s := public.billing_v2_lock_subscription(s.id);
  select * into a from public.payment_attempts where id = p_attempt_id;
  if a.send_authorized_at is null or a.state not in ('dispatching','unknown') then
    return jsonb_build_object('result','unchanged','state',a.state);
  end if;
  update public.payment_attempts set state = 'unknown',error_code = 'POSSIBLY_SENT_RECONCILE',
    updated_at = clock_timestamp() where id = a.id;
  return jsonb_build_object('result','reconcile','state','unknown','attemptId',a.id);
end $$;

create or replace function public.billing_v2_repair_schedule(p_subscription_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; last_approval timestamptz; candidate timestamptz;
  month_start timestamptz; month_end timestamptz; now_at timestamptz;
begin
  s := public.billing_v2_lock_subscription(p_subscription_id);
  now_at := clock_timestamp();
  if s.billing_version is distinct from p_expected_version or s.status <> 'active' or s.frequency <> 'monthly'
    or s.billing_hold_reason is not null or s.next_payment_date is null or s.next_payment_date > now_at
    or s.preferred_payment_day is null or s.preferred_payment_day not in (1,6,16,28) then
    return jsonb_build_object('result','unchanged','reason','SCHEDULE_PROTECTED','nextPaymentDate',s.next_payment_date);
  end if;
  if exists(select 1 from public.billing_cycles c where c.subscription_id = s.id and c.state in ('open','retry_wait')
      and (c.state = 'retry_wait' or exists(select 1 from public.payment_attempts a where a.cycle_id = c.id
        and (a.send_authorized_at is not null or a.wompi_transaction_id is not null))))
    or exists(select 1 from public.payment_attempts where donor_id = s.donor_id and state in ('dispatching','pending','unknown'))
    or exists(select 1 from public.payments where subscription_id = s.id and (billing_review_required
      or status is null or status = 'pending' or (status = 'approved' and (coalesce(approved_at,provider_effective_at) is null
        or not isfinite(coalesce(approved_at,provider_effective_at)))))) then
    return jsonb_build_object('result','blocked','reason','PAYMENT_OR_CYCLE_NEEDS_REVIEW');
  end if;
  month_start := date_trunc('month',now_at at time zone 'America/Bogota') at time zone 'America/Bogota';
  month_end := (date_trunc('month',now_at at time zone 'America/Bogota')+interval '1 month') at time zone 'America/Bogota';
  select max(coalesce(approved_at,provider_effective_at)) into last_approval from public.payments
  where subscription_id = s.id and status = 'approved' and not billing_review_required
    and coalesce(approved_at,provider_effective_at) >= month_start and coalesce(approved_at,provider_effective_at) < month_end;
  if last_approval is null or (s.schedule_updated_at is not null and s.schedule_updated_at >= last_approval) then
    return jsonb_build_object('result','unchanged','reason','NO_NEW_VERIFIED_APPROVAL');
  end if;
  candidate := (date_trunc('month',last_approval at time zone 'America/Bogota')+interval '1 month'
    +make_interval(days=>s.preferred_payment_day-1,hours=>7)) at time zone 'America/Bogota';
  if candidate > s.next_payment_date then
    update public.payment_attempts set state = 'cancelled',error_code = 'BILLING_MONTH_ALREADY_PAID',updated_at = now_at
    where subscription_id = s.id and state = 'prepared' and send_authorized_at is null and cycle_id in
      (select id from public.billing_cycles where subscription_id = s.id and state = 'open');
    update public.billing_cycles set state = 'cancelled',hold_reason = 'month_already_paid',
      closed_at = now_at,updated_at = now_at where subscription_id = s.id and state = 'open';
    update public.subscriptions set next_payment_date = candidate,updated_at = now_at where id = s.id;
    return jsonb_build_object('result','repaired','nextPaymentDate',candidate);
  end if;
  return jsonb_build_object('result','unchanged','nextPaymentDate',s.next_payment_date);
end $$;

create or replace function public.billing_v2_expire_retry(p_cycle_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; c public.billing_cycles; now_at timestamptz;
begin
  select subscription_id into s.id from public.billing_cycles where id = p_cycle_id;
  s := public.billing_v2_lock_subscription(s.id);
  select * into c from public.billing_cycles where id = p_cycle_id;
  now_at := clock_timestamp();
  if c.state <> 'retry_wait' or c.retry_window_end is null or now_at < c.retry_window_end then
    return jsonb_build_object('result','unchanged');
  end if;
  if c.subscription_version <> s.billing_version or s.billing_hold_reason is distinct from 'retry_wait'
    or exists(select 1 from public.payment_attempts where cycle_id = c.id and state in ('dispatching','pending','unknown')) then
    return jsonb_build_object('result','protected','reason','POSSIBLY_SENT_OR_CONFIGURATION_CHANGED');
  end if;
  update public.payment_attempts set state = 'cancelled',error_code = 'RETRY_WINDOW_MISSED',updated_at = now_at
  where cycle_id = c.id and state = 'prepared' and send_authorized_at is null;
  update public.billing_cycles set state = 'manual_review',hold_reason = 'retry_window_missed',closed_at = now_at,updated_at = now_at where id = c.id;
  update public.subscriptions set status = 'past_due',next_payment_date = null,billing_hold_reason = 'retry_window_missed',updated_at = now_at where id = s.id;
  return jsonb_build_object('result','expired');
end $$;

create or replace function public.billing_v2_record_dispatch(p_attempt_id uuid,p_transaction_id text,p_status text)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; a public.payment_attempts;
begin
  select subscription_id into s.id from public.payment_attempts where id = p_attempt_id;
  s := public.billing_v2_lock_subscription(s.id);
  select * into a from public.payment_attempts where id = p_attempt_id;
  if nullif(btrim(p_transaction_id),'') is null or length(p_transaction_id) > 255 then raise exception 'INVALID_TRANSACTION_ID'; end if;
  if a.wompi_transaction_id is not null then
    if a.wompi_transaction_id <> p_transaction_id then raise exception 'TRANSACTION_ALREADY_LINKED'; end if;
    return jsonb_build_object('result','existing','attemptId',a.id,'state',a.state);
  end if;
  -- POST responses are identifiers only, never final approval or retry evidence.
  if a.send_authorized_at is null and not (a.cycle_id is null and a.attempt_number = 1
    and s.frequency = 'one_time' and a.checkout_intent_id is not null) then raise exception 'SEND_NOT_AUTHORIZED'; end if;
  update public.payment_attempts set wompi_transaction_id = p_transaction_id,
    state = 'pending',provider_status = 'pending',updated_at = clock_timestamp() where id = a.id;
  return jsonb_build_object('result','recorded','attemptId',a.id,'state','pending');
end $$;

create or replace function public.billing_v2_apply_result(p_attempt_id uuid,p_transaction jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
<<result_apply>>
declare s public.subscriptions; a public.payment_attempts; c public.billing_cycles; pay public.payments;
  now_at timestamptz; final_at timestamptz; tx text; ref text; source_id text; env text; v_status text;
  cents bigint; message text; reason text; next_at timestamptz; start_at timestamptz; end_at timestamptz;
  evidence jsonb; can_schedule boolean; duplicate_money boolean := false; conflicting_status boolean := false;
  was_approved boolean; unchanged boolean; result text := 'processed'; window_start timestamptz; window_end timestamptz;
begin
  select subscription_id into s.id from public.payment_attempts where id = p_attempt_id;
  s := public.billing_v2_lock_subscription(s.id);
  select * into a from public.payment_attempts where id = p_attempt_id;
  if a.attempt_number is null then raise exception 'LEGACY_ATTEMPT_REQUIRES_LEGACY_RESULT'; end if;
  if p_transaction->>'verification_source' is distinct from 'provider_get' then raise exception 'PROVIDER_GET_REQUIRED'; end if;
  tx := p_transaction->>'id'; ref := p_transaction->>'reference';
  source_id := p_transaction->>'payment_source_id'; env := p_transaction->>'environment';
  v_status := lower(p_transaction->>'status'); message := p_transaction->>'status_message';
  begin cents := (p_transaction->>'amount_in_cents')::bigint;
  exception when others then raise exception 'INVALID_PROVIDER_AMOUNT'; end;
  if nullif(tx,'') is null or length(tx) > 255 or ref is distinct from a.reference
    or cents is distinct from (a.amount::bigint*100) or p_transaction->>'currency' is distinct from a.currency
    or env is distinct from a.dispatch_snapshot->>'environment'
    or v_status is null or v_status not in ('approved','pending','declined','error','voided')
    or (a.dispatch_snapshot->>'paymentSourceId' is not null
      and source_id is distinct from a.dispatch_snapshot->>'paymentSourceId') then
    raise exception 'WOMPI_RESULT_IDENTITY_MISMATCH';
  end if;
  now_at := clock_timestamp();
  begin final_at := case when p_transaction->>'finalized_at' ~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+]00:00)$'
    then (p_transaction->>'finalized_at')::timestamptz end;
  exception when others then final_at := null; end;
  if final_at is not null and (not isfinite(final_at) or final_at < timestamptz '1970-01-01'
    or final_at > now_at or (a.send_authorized_at is not null and final_at < a.send_authorized_at-interval '5 seconds')) then final_at := null; end if;
  if v_status = 'pending' then final_at := null; end if;
  if a.cycle_id is not null then select * into c from public.billing_cycles where id = a.cycle_id; end if;
  perform 1 from public.payments where subscription_id = s.id order by id for update;
  select * into pay from public.payments where wompi_transaction_id = tx;
  if pay.id is not null and (pay.subscription_id is distinct from s.id or pay.amount is distinct from a.amount
    or pay.currency is distinct from a.currency or pay.reference is distinct from a.reference) then
    raise exception 'TRANSACTION_ALREADY_LINKED';
  end if;
  was_approved := pay.status = 'approved';
  unchanged := pay.id is not null and pay.status = v_status and
    (v_status = 'pending' or pay.provider_effective_at is not distinct from final_at);
  -- APPROVED never downgrades. A verified approval may upgrade any prior terminal:
  -- real money is preserved, while the contradiction prohibits further automation.
  conflicting_status := pay.id is not null and pay.status not in ('pending',v_status)
    and not (pay.status = 'approved' and v_status <> 'approved');
  if was_approved and v_status <> 'approved' then v_status := 'approved'; final_at := pay.approved_at; unchanged := true; end if;
  if pay.id is not null and pay.status not in ('pending','approved',v_status) and v_status <> 'approved' then
    return jsonb_build_object('result','review','reason','CONTRADICTORY_TERMINAL_RESULT','attemptId',a.id,'subscriptionId',s.id);
  end if;
  evidence := jsonb_build_object('verification_source','provider_get','environment',env,'transaction_id',tx,
    'reference',ref,'amount_in_cents',cents,'currency',a.currency,'payment_source_id',source_id,
    'payment_method_type',p_transaction->>'payment_method_type','status',v_status,'status_message',message,
    'finalized_at',final_at,'verified_at',now_at);
  if pay.id is null then
    insert into public.payments(subscription_id,payment_attempt_id,amount,currency,status,wompi_transaction_id,
      reference,approved_at,provider_effective_at,billing_review_required,updated_at)
    values(s.id,a.id,a.amount,a.currency,v_status,tx,ref,case when v_status = 'approved' then final_at end,
      final_at,v_status = 'approved' and final_at is null,now_at) returning * into pay;
  elsif not unchanged or pay.billing_review_required then
    update public.payments set status = v_status,approved_at = case when v_status = 'approved'
        then coalesce(pay.approved_at,final_at) else pay.approved_at end,
      provider_effective_at = case when v_status = 'approved' then coalesce(pay.approved_at,final_at) else final_at end,
      billing_review_required = v_status = 'approved' and coalesce(pay.approved_at,final_at) is null,
      updated_at = now_at where id = pay.id returning * into pay;
  end if;
  if a.wompi_transaction_id is not null and a.wompi_transaction_id <> tx then duplicate_money := true; end if;
  if v_status = 'approved' and final_at is not null then
    start_at := date_trunc('month',final_at at time zone 'America/Bogota') at time zone 'America/Bogota';
    end_at := (date_trunc('month',final_at at time zone 'America/Bogota')+interval '1 month') at time zone 'America/Bogota';
    duplicate_money := duplicate_money or exists(select 1 from public.payments
      where subscription_id = s.id and wompi_transaction_id <> tx and status = 'approved'
      and coalesce(approved_at,provider_effective_at) >= start_at and coalesce(approved_at,provider_effective_at) < end_at);
  end if;
  if not duplicate_money or a.wompi_transaction_id = tx then
    update public.payment_attempts set wompi_transaction_id = coalesce(wompi_transaction_id,tx),provider_status = v_status,
      state = case when v_status in ('approved','pending','declined') then v_status else 'failed' end,
      verified_status_message = message,verified_finalized_at = final_at,verified_evidence = evidence,
      completed_at = case when v_status <> 'pending' then final_at else null end,
      verified_reason = case when v_status = 'declined'
        and public.billing_v2_normalize_status_message(message) = 'Intente mas tarde - Fondos Insuficientes'
        then 'insufficient_funds' when v_status = 'declined' then 'unknown_decline' else null end,
      updated_at = now_at where id = a.id returning * into a;
  end if;
  can_schedule := s.billing_version = a.subscription_version and s.status <> 'cancelled'
    and (s.billing_hold_reason is null or s.billing_hold_reason = 'retry_wait')
    and (a.send_authorized_at is not null or (s.frequency = 'one_time' and a.checkout_intent_id is not null))
    and (c.id is null or c.state in ('open','retry_wait'));
  if v_status = 'approved' then
    if duplicate_money or conflicting_status or final_at is null then
      reason := case when duplicate_money then 'duplicate_approval' when conflicting_status then 'contradictory_approval'
        else 'approval_date_missing' end;
      update public.payments set billing_review_required = true where id = pay.id;
      if c.id is not null then update public.billing_cycles set state = 'manual_review',hold_reason = reason,
        closed_at = now_at,updated_at = now_at where id = c.id; end if;
      if s.status <> 'cancelled' and s.billing_version = a.subscription_version then
        update public.subscriptions set status = 'past_due',next_payment_date = null,billing_hold_reason = reason,
          updated_at = now_at where id = s.id;
      end if;
      result := 'review';
    else
      if c.id is not null and c.first_approved_attempt_id is null then
        update public.billing_cycles set first_approved_attempt_id = a.id,first_approved_at = final_at,
          state = case when can_schedule then 'approved' else state end,
          closed_at = coalesce(closed_at,now_at),updated_at = now_at where id = c.id;
      end if;
      if can_schedule then
        next_at := case when s.frequency = 'monthly' then
          (date_trunc('month',final_at at time zone 'America/Bogota')+interval '1 month'
            +make_interval(days=>s.preferred_payment_day-1,hours=>7)) at time zone 'America/Bogota' else null end;
        if s.frequency = 'monthly' and s.preferred_payment_day is null then
          result := 'review'; reason := 'preferred_day_missing';
        else
          update public.subscriptions set status = 'active',next_payment_date = case when s.frequency = 'one_time'
              then null when next_payment_date is null then next_at else greatest(next_payment_date,next_at) end,
            billing_hold_reason = null,processed_transaction_ids = case when tx = any(coalesce(processed_transaction_ids,'{}'))
              then processed_transaction_ids else array_append(coalesce(processed_transaction_ids,'{}'),tx) end,
            updated_at = now_at where id = s.id;
        end if;
      elsif not unchanged then result := 'review'; reason := 'schedule_protected'; end if;
    end if;
  elsif v_status <> 'pending' and not unchanged then
    if can_schedule and c.id is not null and c.state in ('open','retry_wait') and a.attempt_number = 1
      and c.retry_enabled and public.billing_v2_authorization_valid(s.id)
      and s.billing_authorization is not distinct from c.authorization_snapshot and v_status = 'declined'
      and a.verified_reason = 'insufficient_funds' and final_at is not null
      and p_transaction->>'payment_method_type' = 'CARD'
      and public.billing_v2_source_valid(p_transaction->'payment_source_verification',c.payment_source_id,c.environment) then
      window_start := (((final_at at time zone 'America/Bogota')::date+1)::timestamp+interval '7 hours') at time zone 'America/Bogota';
      window_end := ((final_at at time zone 'America/Bogota')::date+2)::timestamp at time zone 'America/Bogota';
      if now_at < window_end then
        update public.billing_cycles set state = 'retry_wait',retry_window_start = window_start,
          retry_window_end = window_end,retry_evidence_attempt_id = a.id,updated_at = now_at where id = c.id;
        update public.subscriptions set status = 'past_due',next_payment_date = null,billing_hold_reason = 'retry_wait',
          updated_at = now_at where id = s.id;
        reason := 'retry_wait';
      else reason := 'retry_window_missed'; end if;
    else
      reason := case when a.attempt_number = 2 then 'retry_exhausted'
        when v_status = 'declined' and a.verified_reason = 'insufficient_funds' and final_at is null then 'decline_date_missing'
        when c.id is not null and not c.retry_enabled then 'retry_authorization_missing'
        else 'manual_review' end;
    end if;
    if reason is distinct from 'retry_wait' then
      result := 'review';
      if c.id is not null and c.state in ('open','retry_wait') then
        update public.billing_cycles set state = 'manual_review',hold_reason = reason,closed_at = now_at,
          updated_at = now_at where id = c.id;
      end if;
      if can_schedule then update public.subscriptions set status = 'past_due',next_payment_date = null,
        billing_hold_reason = reason,updated_at = now_at where id = s.id; end if;
    end if;
  end if;
  if a.checkout_intent_id is not null and v_status <> 'pending' then
    update public.checkout_intents set state = 'completed',consumed_at = coalesce(consumed_at,now_at),
      updated_at = now_at where id = a.checkout_intent_id;
  end if;
  return jsonb_build_object('result',case when unchanged and result <> 'review' then 'duplicate' else result end,
    'reason',reason,'attemptId',a.id,'cycleId',a.cycle_id,'subscriptionId',s.id,'transactionId',tx,
    'state',a.state,'scheduleProtected',not can_schedule,
    'retryQueued',exists(select 1 from public.billing_cycles where id=a.cycle_id and state='retry_wait'
      and retry_window_end > now_at));
end $$;

create or replace function public.billing_v2_admin_update_subscription(
  p_subscription_id uuid,p_expected_version integer,p_action text,p_reason text,p_request_id uuid,p_actor_user_id uuid,
  p_amount integer default null,p_preferred_payment_day integer default null,p_next_payment_date timestamptz default null,
  p_donor_authorization_confirmed boolean default false,p_actor_aal text default null,
  p_actor_session_issued_at timestamptz default null,p_totp_verified_at timestamptz default null,
  p_source_verification jsonb default null,p_expected_cycle_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; after_s public.subscriptions; old_audit public.admin_audit_logs;
  aid uuid := gen_random_uuid(); fingerprint text; response jsonb; now_at timestamptz;
  block text; before_value jsonb; warning boolean := false; env text; proof jsonb; cycle_result jsonb;
begin
  if not public.billing_retry_schema_ready() then raise exception 'BILLING_V2_SCHEMA_REQUIRED'; end if;
  perform public.assert_admin_mutation_context(p_actor_user_id,p_actor_aal,p_actor_session_issued_at,p_totp_verified_at);
  if p_request_id is null then raise exception 'ADMIN_REQUEST_ID_REQUIRED'; end if;
  fingerprint := encode(sha256(convert_to(jsonb_build_object('subscriptionId',p_subscription_id,
    'expectedVersion',p_expected_version,'action',p_action,'reason',btrim(p_reason),'amount',p_amount,
    'preferredPaymentDay',p_preferred_payment_day,'nextPaymentDate',p_next_payment_date,
    'donorAuthorizationConfirmed',p_donor_authorization_confirmed,'expectedCycleId',p_expected_cycle_id)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended('billing-admin:'||p_actor_user_id::text||':'||p_request_id::text,0));
  select * into old_audit from public.admin_audit_logs where actor_user_id = p_actor_user_id and request_id = p_request_id;
  if old_audit.id is not null then
    if old_audit.request_fingerprint is distinct from fingerprint or old_audit.committed_response is null then
      raise exception 'ADMIN_REQUEST_ID_CONFLICT' using errcode = '23505';
    end if;
    return old_audit.committed_response;
  end if;
  -- Replay resolution precedes all version/state validations, but not authorization.
  if p_expected_version is null or p_expected_version < 0 or length(btrim(coalesce(p_reason,''))) < 5
    or p_action is null or p_action not in ('amount','schedule','cancel','cancel_retry','reactivate') then
    raise exception 'INVALID_ADMIN_REQUEST' using errcode = '22023';
  end if;
  s := public.billing_v2_lock_subscription(p_subscription_id);
  now_at := clock_timestamp();
  if s.frequency <> 'monthly' then raise exception 'ONE_TIME_READ_ONLY' using errcode = '22023'; end if;
  if s.billing_version <> p_expected_version then raise exception 'SUBSCRIPTION_VERSION_CONFLICT' using errcode = '40001'; end if;
  before_value := jsonb_build_object('id',s.id,'amount',s.amount,'status',s.status,'preferred_payment_day',s.preferred_payment_day,
    'next_payment_date',s.next_payment_date,'billing_version',s.billing_version,'billing_hold_reason',s.billing_hold_reason);
  warning := exists(select 1 from public.payment_attempts where subscription_id = s.id
    and state in ('dispatching','pending','unknown'));
  if p_action in ('amount','schedule','reactivate') and (warning or exists(select 1 from public.billing_cycles
    where subscription_id = s.id and state in ('open','retry_wait'))) then raise exception 'BILLING_CYCLE_IN_PROGRESS' using errcode = '55000'; end if;
  if p_action = 'cancel_retry' and warning then raise exception 'PAYMENT_IN_PROGRESS' using errcode = '55000'; end if;
  if p_action = 'amount' then
    if s.status <> 'active' or p_amount is null or p_amount not between 1500 and 21474836 then raise exception 'INVALID_AMOUNT_CHANGE'; end if;
    update public.subscriptions set amount = p_amount,billing_version = billing_version+1,
      schedule_updated_at = now_at,updated_at = now_at where id = s.id;
  elsif p_action in ('schedule','reactivate') then
    if p_preferred_payment_day is null or p_preferred_payment_day not in (1,6,16,28)
      or p_next_payment_date is null or not isfinite(p_next_payment_date) or p_next_payment_date <= now_at
      or (p_next_payment_date at time zone 'America/Bogota')::time <> time '07:00:00'
      or extract(day from p_next_payment_date at time zone 'America/Bogota') <> p_preferred_payment_day then raise exception 'INVALID_SCHEDULE_CHANGE'; end if;
    block := public.billing_v2_month_block(s.id,p_next_payment_date);
    if block is not null then raise exception '%',block using errcode = '55000'; end if;
    if p_action = 'schedule' then
      if s.status <> 'active' then raise exception 'INVALID_SCHEDULE_CHANGE'; end if;
      update public.subscriptions set preferred_payment_day = p_preferred_payment_day,next_payment_date = p_next_payment_date,
        billing_version = billing_version+1,schedule_updated_at = now_at,updated_at = now_at where id = s.id;
    else
      env := coalesce(s.billing_authorization->>'environment',(select environment from public.checkout_intents where reference = s.reference limit 1),'prod');
      if s.status not in ('cancelled','past_due') then raise exception 'INVALID_REACTIVATION_STATE'; end if;
      if p_donor_authorization_confirmed is not true
        or s.payment_method_type <> 'card' or not public.billing_v2_source_valid(p_source_verification,s.wompi_payment_source_id,env) then
        raise exception 'REACTIVATION_AUTHORIZATION_REQUIRED';
      end if;
      proof := jsonb_build_object('version','0.4.0','kind','admin_reactivation','auditId',aid,'mandateId',gen_random_uuid(),
        'environment',env,'authorizedAt',now_at,'recurring',true,'retryAllowed',true,'sourceVerified',true,
        'sourceVerifiedAt',now_at,'sourceId',s.wompi_payment_source_id,'method','CARD','actorId',p_actor_user_id);
      update public.subscriptions set status = 'active',cancelled_at = null,preferred_payment_day = p_preferred_payment_day,
        next_payment_date = p_next_payment_date,billing_authorization = proof,billing_authorization_revoked_at = null,
        billing_hold_reason = null,billing_version = billing_version+1,schedule_updated_at = now_at,updated_at = now_at where id = s.id;
    end if;
  elsif p_action = 'cancel' then
    if s.status not in ('active','pending','past_due') then raise exception 'INVALID_CANCELLATION'; end if;
    update public.payment_attempts set state = 'cancelled',error_code = 'ADMIN_CANCELLED_BEFORE_SEND',updated_at = now_at
    where subscription_id = s.id and attempt_number is not null and state = 'prepared' and send_authorized_at is null;
    update public.billing_cycles set state = 'cancelled',hold_reason = 'admin_cancelled',closed_at = now_at,updated_at = now_at
    where subscription_id = s.id and state in ('open','retry_wait');
    update public.subscriptions set status = 'cancelled',cancelled_at = now_at,next_payment_date = null,
      billing_authorization_revoked_at = now_at,billing_hold_reason = 'admin_cancelled',
      billing_version = billing_version+1,schedule_updated_at = now_at,updated_at = now_at where id = s.id;
  else
    if p_expected_cycle_id is null or not exists(select 1 from public.billing_cycles
      where id = p_expected_cycle_id and subscription_id = s.id and state in ('open','retry_wait')) then
      raise exception 'BILLING_CYCLE_CONFLICT' using errcode = '40001';
    end if;
    if not exists(select 1 from public.billing_cycles where subscription_id = s.id and state in ('open','retry_wait')) then
      raise exception 'NO_CANCELABLE_RESERVATION';
    end if;
    update public.payment_attempts set state = 'cancelled',error_code = 'ADMIN_CANCELLED_RESERVATION',updated_at = now_at
    where subscription_id = s.id and attempt_number is not null and state = 'prepared' and send_authorized_at is null;
    update public.billing_cycles set state = 'manual_review',hold_reason = 'admin_cancel_retry',closed_at = now_at,updated_at = now_at
    where subscription_id = s.id and state in ('open','retry_wait');
    update public.subscriptions set status = 'past_due',next_payment_date = null,billing_hold_reason = 'admin_cancel_retry',
      billing_version = billing_version+1,schedule_updated_at = now_at,updated_at = now_at where id = s.id;
  end if;
  perform public.assert_admin_mutation_context(p_actor_user_id,p_actor_aal,p_actor_session_issued_at,p_totp_verified_at);
  select * into after_s from public.subscriptions where id = s.id;
  response := jsonb_build_object('id',after_s.id,'amount',after_s.amount,'status',after_s.status,
    'preferred_payment_day',after_s.preferred_payment_day,'next_payment_date',after_s.next_payment_date,
    'billing_version',after_s.billing_version,'billing_hold_reason',after_s.billing_hold_reason,'chargeMayComplete',warning);
  insert into public.admin_audit_logs(id,actor_user_id,subscription_id,action,reason,before_value,after_value,request_id,
    expected_version,actor_aal,actor_session_issued_at,totp_verified_at,request_fingerprint,committed_response)
  values(aid,p_actor_user_id,s.id,p_action,btrim(p_reason),before_value,
    response || jsonb_build_object('donor_authorization_confirmed',p_donor_authorization_confirmed),p_request_id,p_expected_version,
    p_actor_aal,p_actor_session_issued_at,p_totp_verified_at,fingerprint,response);
  if p_action = 'reactivate' then
    cycle_result := public.billing_v2_insert_original(s.id,'reactivation',env,null,aid);
  end if;
  return response;
end $$;

create or replace function public.billing_v2_recovery_fingerprint(p_attempt_id uuid,p_reason text,
  p_transaction_id text,p_expected_version integer)
returns text language sql immutable set search_path = pg_catalog as $$
  select encode(sha256(convert_to(jsonb_build_object('attemptId',p_attempt_id,'action','payment_recovery',
    'reason',btrim(p_reason),'transactionId',p_transaction_id,'expectedVersion',p_expected_version)::text,'UTF8')),'hex')
$$;

create or replace function public.billing_v2_admin_recovery_replay(
  p_attempt_id uuid,p_actor_user_id uuid,p_reason text,p_request_id uuid,p_transaction_id text,
  p_expected_version integer,p_actor_aal text,p_actor_session_issued_at timestamptz,p_totp_verified_at timestamptz)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare old_audit public.admin_audit_logs; fingerprint text;
begin
  if not public.billing_retry_schema_ready() then raise exception 'BILLING_V2_SCHEMA_REQUIRED'; end if;
  perform public.assert_admin_mutation_context(p_actor_user_id,p_actor_aal,p_actor_session_issued_at,p_totp_verified_at);
  if p_request_id is null or p_attempt_id is null or p_transaction_id is null or p_expected_version is null
    or length(btrim(coalesce(p_reason,''))) < 5 then raise exception 'PAYMENT_RECOVERY_INVALID_INPUT'; end if;
  fingerprint := public.billing_v2_recovery_fingerprint(p_attempt_id,p_reason,p_transaction_id,p_expected_version);
  perform pg_advisory_xact_lock(hashtextextended('billing-admin:'||p_actor_user_id::text||':'||p_request_id::text,0));
  select * into old_audit from public.admin_audit_logs where actor_user_id = p_actor_user_id and request_id = p_request_id;
  if old_audit.id is null then return jsonb_build_object('result','new'); end if;
  if old_audit.request_fingerprint is distinct from fingerprint or old_audit.committed_response is null then
    raise exception 'ADMIN_REQUEST_ID_CONFLICT' using errcode = '23505';
  end if;
  return jsonb_build_object('result','replay','response',old_audit.committed_response);
end $$;

create or replace function public.billing_v2_admin_reconcile_payment_attempt(
  p_attempt_id uuid,p_actor_user_id uuid,p_reason text,p_request_id uuid,p_transaction_id text,p_reference text,
  p_payment_source_id text,p_amount integer,p_currency text,p_status text,p_effective_at timestamptz,
  p_candidate_next_payment timestamptz,p_raw jsonb,p_expected_version integer default null,p_actor_aal text default null,
  p_actor_session_issued_at timestamptz default null,p_totp_verified_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare s public.subscriptions; a public.payment_attempts; after_a public.payment_attempts; old_audit public.admin_audit_logs;
  fingerprint text; response jsonb; applied jsonb; envelope jsonb; historical_payment public.payments;
begin
  if not public.billing_retry_schema_ready() then raise exception 'BILLING_V2_SCHEMA_REQUIRED'; end if;
  perform public.assert_admin_mutation_context(p_actor_user_id,p_actor_aal,p_actor_session_issued_at,p_totp_verified_at);
  if p_request_id is null then raise exception 'ADMIN_REQUEST_ID_REQUIRED'; end if;
  fingerprint := public.billing_v2_recovery_fingerprint(p_attempt_id,p_reason,p_transaction_id,p_expected_version);
  perform pg_advisory_xact_lock(hashtextextended('billing-admin:'||p_actor_user_id::text||':'||p_request_id::text,0));
  select * into old_audit from public.admin_audit_logs where actor_user_id = p_actor_user_id and request_id = p_request_id;
  if old_audit.id is not null then
    if old_audit.request_fingerprint is distinct from fingerprint or old_audit.committed_response is null then
      raise exception 'ADMIN_REQUEST_ID_CONFLICT' using errcode = '23505';
    end if;
    return old_audit.committed_response;
  end if;
  select subscription_id into s.id from public.payment_attempts where id = p_attempt_id;
  s := public.billing_v2_lock_subscription(s.id);
  select * into a from public.payment_attempts where id = p_attempt_id;
  if p_expected_version is null or s.billing_version <> p_expected_version then raise exception 'SUBSCRIPTION_VERSION_CONFLICT' using errcode = '40001'; end if;
  if length(btrim(coalesce(p_reason,''))) < 5 or p_reference is distinct from a.reference
    or p_amount is null or p_amount not between 1500 and 21474836 or p_currency is distinct from a.currency or p_transaction_id is null
    or (a.wompi_transaction_id is not null and a.wompi_transaction_id <> p_transaction_id) then raise exception 'PAYMENT_RECOVERY_INVALID_INPUT'; end if;
  if a.attempt_number is not null then
    if p_amount is distinct from a.amount then raise exception 'PAYMENT_RECOVERY_INVALID_INPUT'; end if;
  else
    perform 1 from public.payments where payment_attempt_id = a.id or wompi_transaction_id = p_transaction_id order by id for update;
    if (select count(*) from public.payments where payment_attempt_id = a.id or wompi_transaction_id = p_transaction_id) > 1 then
      raise exception 'PAYMENT_RECOVERY_INVALID_INPUT';
    end if;
    select * into historical_payment from public.payments where payment_attempt_id = a.id or wompi_transaction_id = p_transaction_id;
    if historical_payment.id is not null then
      if historical_payment.payment_attempt_id is distinct from a.id or historical_payment.subscription_id is distinct from s.id
        or historical_payment.wompi_transaction_id is distinct from p_transaction_id
        or historical_payment.amount is distinct from p_amount or historical_payment.currency is distinct from p_currency
        or (historical_payment.reference is not null and historical_payment.reference <> p_reference)
        or (p_amount is distinct from a.amount and historical_payment.reference is distinct from p_reference) then
        raise exception 'PAYMENT_RECOVERY_INVALID_INPUT';
      end if;
    elsif p_amount is distinct from a.amount then raise exception 'PAYMENT_RECOVERY_INVALID_INPUT'; end if;
  end if;
  if p_raw->>'verification_source' is distinct from 'provider_get' then raise exception 'PROVIDER_GET_REQUIRED'; end if;
  envelope := coalesce(p_raw->'transaction',p_raw) || jsonb_build_object(
    'verification_source','provider_get','environment',p_raw->>'environment',
    'payment_source_verification',p_raw->'payment_source_verification');
  if envelope->>'id' is distinct from p_transaction_id or envelope->>'reference' is distinct from p_reference
    or envelope->>'amount_in_cents' is distinct from (p_amount::bigint*100)::text
    or lower(envelope->>'status') is distinct from lower(p_status)
    or envelope->>'currency' is distinct from p_currency
    or envelope->>'payment_source_id' is distinct from p_payment_source_id then raise exception 'RECOVERY_EVIDENCE_MISMATCH'; end if;
  if a.attempt_number is not null then
    applied := public.billing_v2_apply_result(a.id,envelope);
  else
    applied := public.apply_verified_wompi_event('recovery:'||p_request_id::text,p_transaction_id,
      'transaction.reconciled',p_reference,p_payment_source_id,p_amount,p_currency,p_status,p_effective_at,
      p_candidate_next_payment,p_raw);
  end if;
  perform public.assert_admin_mutation_context(p_actor_user_id,p_actor_aal,p_actor_session_issued_at,p_totp_verified_at);
  select * into after_a from public.payment_attempts where id = a.id;
  response := jsonb_build_object('result',case when applied->>'result' = 'review' then 'review'
    when applied->>'result' = 'duplicate' then 'duplicate' else 'recovered' end,
    'attemptId',a.id,'transactionId',p_transaction_id,'providerStatus',after_a.provider_status,
    'state',after_a.state,'reason',applied->>'reason','needsReview',applied->>'result' = 'review');
  insert into public.admin_audit_logs(actor_user_id,subscription_id,action,reason,before_value,after_value,request_id,
    expected_version,actor_aal,actor_session_issued_at,totp_verified_at,request_fingerprint,committed_response)
  values(p_actor_user_id,s.id,'payment_recovery',btrim(p_reason),
    jsonb_build_object('attemptId',a.id,'state',a.state,'providerStatus',a.provider_status),response,p_request_id,
    p_expected_version,p_actor_aal,p_actor_session_issued_at,p_totp_verified_at,fingerprint,response);
  return response;
end $$;

-- The retained v1 event signature is a receipt/result bridge only. It NEVER
-- reserves/sends, invents a subscription, or updates legacy billing configuration.
create or replace function public.apply_verified_wompi_event(
  p_event_key text,p_transaction_id text,p_event_type text,p_reference text,p_payment_source_id text,
  p_amount integer,p_currency text,p_status text,p_effective_at timestamptz,p_candidate_next_payment timestamptz,p_raw jsonb
)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
<<event_apply>>
declare a public.payment_attempts; s public.subscriptions; pay public.payments; e public.webhook_events;
  envelope jsonb; response jsonb; final_at timestamptz; v_status text := lower(p_status); reason text;
begin
  if not public.billing_retry_schema_ready() or nullif(p_event_key,'') is null or nullif(p_transaction_id,'') is null
    or nullif(p_reference,'') is null or p_event_type is null or p_raw is null
    or p_amount is null or p_amount not between 1500 and 21474836 or p_currency is distinct from 'COP'
    or v_status is null or v_status not in ('approved','pending','declined','error','voided') then
    raise exception 'INVALID_VERIFIED_WOMPI_EVENT';
  end if;
  select * into a from public.payment_attempts where reference = p_reference or wompi_transaction_id = p_transaction_id
    order by (wompi_transaction_id = p_transaction_id) desc nulls last limit 1;
  select * into pay from public.payments where wompi_transaction_id = p_transaction_id;
  if a.subscription_id is not null then select * into s from public.subscriptions where id = a.subscription_id;
  elsif pay.subscription_id is not null then select * into s from public.subscriptions where id = pay.subscription_id;
  else
    select * into s from public.subscriptions where reference = p_reference or
      (frequency = 'monthly' and p_reference = reference||'-'||right(p_reference,6)
        and right(p_reference,6) ~ '^[0-9]{4}(0[1-9]|1[0-2])$') limit 1;
  end if;
  if s.id is not null then
    s := public.billing_v2_lock_subscription(s.id);
    perform 1 from public.payments where subscription_id = s.id order by id for update;
  end if;
  insert into public.webhook_events(transaction_id,event_type,event_key,raw,processing_state,record_kind)
  values(p_transaction_id,p_event_type,p_event_key,p_raw,'received','canonical')
  on conflict(event_key) where record_kind = 'canonical' do nothing;
  select * into e from public.webhook_events where event_key = p_event_key and record_kind = 'canonical' for update;
  if e.transaction_id is distinct from p_transaction_id or e.event_type is distinct from p_event_type then
    perform public.mark_wompi_receipt(p_raw,'review','EVENT_KEY_COLLISION');
    return jsonb_build_object('result','review','reason','EVENT_KEY_COLLISION');
  end if;
  begin
    if a.attempt_number is not null then
      envelope := coalesce(p_raw->'transaction',p_raw) || jsonb_build_object(
        'verification_source',p_raw->>'verification_source','environment',p_raw->>'environment',
        'payment_source_verification',p_raw->'payment_source_verification');
      response := public.billing_v2_apply_result(a.id,envelope);
    elsif s.id is null then response := jsonb_build_object('result','review','reason','SUBSCRIPTION_NOT_FOUND');
    else
      -- Legacy data cannot provide retry authorization; no history-to-cycle backfill.
      if (pay.id is not null and (pay.subscription_id is distinct from s.id or pay.amount is distinct from p_amount
        or pay.currency is distinct from p_currency or (pay.reference is not null and pay.reference <> p_reference)))
        or (pay.id is null and a.id is not null and (a.amount <> p_amount or a.currency <> p_currency or a.reference <> p_reference))
        or (pay.id is null and a.id is null and (s.amount <> p_amount or s.currency <> p_currency)) then
        raise exception 'WOMPI_LEGACY_RESULT_MISMATCH';
      end if;
      final_at := case when p_effective_at is not null and isfinite(p_effective_at)
        and p_effective_at >= timestamptz '1970-01-01' and p_effective_at <= clock_timestamp()+interval '5 seconds'
        then p_effective_at end;
      if v_status = 'pending' then final_at := null; end if;
      if pay.status = 'approved' and v_status <> 'approved' then v_status := 'approved'; final_at := pay.approved_at; end if;
      if pay.id is not null and pay.status = v_status
        and (v_status <> 'approved' or (pay.approved_at is not null and pay.approved_at = final_at))
        and pay.provider_effective_at is not distinct from final_at
        and pay.reference = p_reference
        and (a.id is null or (a.wompi_transaction_id = p_transaction_id and a.provider_status = v_status)) then
        response := jsonb_build_object('result','duplicate','historicalOnly',true,'scheduleProtected',true);
      else
      if pay.id is null then
        insert into public.payments(subscription_id,payment_attempt_id,amount,currency,status,wompi_transaction_id,
          reference,approved_at,provider_effective_at,billing_review_required)
        values(s.id,a.id,p_amount,p_currency,v_status,p_transaction_id,p_reference,
          case when v_status = 'approved' then final_at end,final_at,true) returning * into pay;
      else
        update public.payments set status = case when pay.status = 'approved' then 'approved' else lower(p_status) end,
          reference = coalesce(pay.reference,p_reference),
          approved_at = case when v_status = 'approved' then coalesce(pay.approved_at,final_at) else pay.approved_at end,
          provider_effective_at = case when v_status = 'approved' then coalesce(pay.approved_at,final_at) else final_at end,
          billing_review_required = true,updated_at = clock_timestamp() where id = pay.id;
      end if;
      if a.id is not null and (a.wompi_transaction_id is null or a.wompi_transaction_id = p_transaction_id) then
        update public.payment_attempts set wompi_transaction_id = p_transaction_id,provider_status = v_status,
          state = case when v_status in ('approved','pending','declined') then v_status else 'failed' end,
          completed_at = final_at,updated_at = clock_timestamp() where id = a.id;
      end if;
      response := jsonb_build_object('result','review','reason','LEGACY_RESULT_SCHEDULE_PROTECTED','historicalOnly',true,'scheduleProtected',true);
      end if;
    end if;
  exception when others then
    response := jsonb_build_object('result','review','reason','VERIFIED_RESULT_REJECTED','scheduleProtected',true);
  end;
  reason := response->>'reason';
  update public.webhook_events set processing_state = case when response->>'result' = 'review' then 'needs_review' else 'processed' end,
    processed_at = clock_timestamp(),last_error = reason where id = e.id;
  perform public.mark_wompi_receipt(p_raw,coalesce(response->>'result','review'),reason);
  return response || jsonb_build_object('transactionId',p_transaction_id,'subscriptionId',s.id,
    'processingState',case when response->>'result' = 'review' then 'needs_review' else 'processed' end);
end $$;

create or replace function public.billing_v2_validate_attempt()
returns trigger language plpgsql set search_path = pg_catalog,public as $$
declare c public.billing_cycles; parent public.payment_attempts;
begin
  if new.cycle_id is null then
    if new.attempt_number = 1 and (new.checkout_intent_id is null or not exists(
      select 1 from public.subscriptions where id = new.subscription_id and frequency = 'one_time')) then
      raise exception 'ONE_TIME_RESERVATION_REQUIRED';
    end if;
    return new;
  end if;
  select * into c from public.billing_cycles where id = new.cycle_id;
  if c.id is null or new.subscription_id is distinct from c.subscription_id
    or new.donor_id is distinct from c.donor_id or new.billing_period is distinct from c.billing_period
    or new.amount is distinct from c.amount or new.currency is distinct from c.currency
    or new.subscription_version is distinct from c.subscription_version
    or new.dispatch_snapshot->>'paymentSourceId' is distinct from c.payment_source_id
    or new.dispatch_snapshot->>'environment' is distinct from c.environment
    or new.dispatch_snapshot->>'preferredPaymentDay' is distinct from c.preferred_payment_day::text
    or new.attempt_number is null then raise exception 'CYCLE_ATTEMPT_SNAPSHOT_MISMATCH'; end if;
  if new.attempt_number = 2 then
    select * into parent from public.payment_attempts where id = new.parent_attempt_id;
    if parent.id is null or parent.cycle_id is distinct from c.id or parent.attempt_number <> 1
      or parent.state <> 'declined' or parent.verified_reason <> 'insufficient_funds'
      or parent.id is distinct from c.retry_evidence_attempt_id or not c.retry_enabled
      or c.state <> 'retry_wait' or new.checkout_intent_id is not null then raise exception 'RETRY_PARENT_INVALID'; end if;
  end if;
  return new;
end $$;
drop trigger if exists billing_v2_attempt_validate on public.payment_attempts;
create trigger billing_v2_attempt_validate before insert on public.payment_attempts
  for each row execute function public.billing_v2_validate_attempt();

-- A service role bypasses RLS, NOT SQL privileges. No direct financial writes.
revoke insert,update,delete,truncate,references,trigger on public.subscriptions,public.payment_attempts,
  public.payments,public.billing_cycles from public,anon,authenticated,service_role;
do $$
declare t text; col text; p record;
begin
  foreach t in array array['subscriptions','payment_attempts','payments','billing_cycles'] loop
    for col in select attname from pg_attribute where attrelid = to_regclass('public.'||t)
      and attnum > 0 and not attisdropped loop
      execute format('revoke insert(%I),update(%I),references(%I) on public.%I from public,anon,authenticated,service_role',col,col,col,t);
    end loop;
  end loop;
  -- No old SECURITY DEFINER writer may remain as a privilege bypass.
  for p in select oid::regprocedure as signature from pg_proc where pronamespace = 'public'::regnamespace
    and proname = any(array['claim_monthly_payment_attempt','advance_subscription_schedule','mark_subscription_past_due',
      'admin_update_subscription','admin_reconcile_payment_attempt','admin_close_unidentified_payment_attempt',
      'cleanup_expired_operational_rows']) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);
  end loop;
  for p in select oid::regprocedure as signature,proname from pg_proc where pronamespace = 'public'::regnamespace
    and (proname like 'billing_v2_%' or proname = 'billing_retry_schema_ready') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);
    if p.proname = any(array['billing_retry_schema_ready','billing_v2_prepare_subscription','billing_v2_bind_source',
      'billing_v2_reserve_initial','billing_v2_reserve_original','billing_v2_reserve_retry','billing_v2_authorize_send',
      'billing_v2_record_dispatch','billing_v2_apply_result','billing_v2_mark_uncertain',
      'billing_v2_admin_update_subscription','billing_v2_admin_recovery_replay','billing_v2_admin_reconcile_payment_attempt','billing_v2_repair_schedule','billing_v2_expire_retry']) then
      execute format('grant execute on function %s to service_role',p.signature);
    end if;
  end loop;
end $$;
revoke all on function public.apply_verified_wompi_event(text,text,text,text,text,integer,text,text,timestamptz,timestamptz,jsonb)
  from public,anon,authenticated;
grant execute on function public.apply_verified_wompi_event(text,text,text,text,text,integer,text,text,timestamptz,timestamptz,jsonb) to service_role;
grant select on public.subscriptions,public.payment_attempts,public.payments,public.billing_cycles to service_role;
alter table public.billing_cycles enable row level security;
drop policy if exists admin_read_billing_cycles on public.billing_cycles;
create policy admin_read_billing_cycles on public.billing_cycles for select to authenticated
  using(public.is_active_admin(array['admin','super_admin']));
-- Neither source identifiers nor authorization/dispatch/evidence JSON reach browser clients.
grant select(id,subscription_id,donor_id,billing_period,origin,state,retry_enabled,amount,currency,
  preferred_payment_day,subscription_version,original_due_at,retry_window_start,retry_window_end,
  first_approved_at,hold_reason,created_at,updated_at) on public.billing_cycles to authenticated;
grant select(cycle_id,attempt_number,parent_attempt_id,verified_reason,verified_finalized_at,
  send_authorized_at,send_window_end) on public.payment_attempts to authenticated;
grant select(billing_hold_reason,billing_authorization_revoked_at) on public.subscriptions to authenticated;

do $$
declare r record; n bigint; d text; pk text[]; changed boolean;
begin
  for r in select * from pg_temp.billing_retry_original_schema loop
    select array_agg(a.attname::text order by k.ordinality) into pk
    from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum,ordinality)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indrelid = to_regclass('public.'||r.table_name) and i.indisprimary;
    if pk is distinct from r.primary_columns then raise exception 'BILLING_PRESERVATION_PK_FAILED: %',r.table_name; end if;
    execute format('select count(*),encode(sha256(convert_to(coalesce(string_agg(
      (select jsonb_object_agg(k,to_jsonb(t)->k) from unnest($1) k)::text,E''\n''
      order by (select jsonb_object_agg(k,to_jsonb(t)->k) from unnest($2) k)::text),''''),''UTF8'')),''hex'')
      from public.%I t',r.table_name) into n,d using r.columns,r.primary_columns;
    execute format('select exists(select 1 from pg_temp.billing_retry_original_rows r where r.table_name = $1
      and not exists(select 1 from public.%I t where r.primary_value <@ to_jsonb(t) and r.content <@ to_jsonb(t)))',r.table_name)
      into changed using r.table_name;
    if changed or n <> r.row_count or d <> r.content_digest then raise exception 'BILLING_PRESERVATION_CONTENT_FAILED: %',r.table_name; end if;
  end loop;
  if clock_timestamp()-(select started_at from pg_temp.billing_retry_start) > interval '5 minutes' then raise exception 'BILLING_MIGRATION_TOTAL_TIMEOUT'; end if;
  insert into public.payment_admin_migrations(name,digest) values('billing-retry-v0.4.0',lower(current_setting('app.migration_digest')))
    on conflict(name) do nothing;
  if not exists(select 1 from public.payment_admin_migrations where name = 'billing-retry-v0.4.0'
    and digest = lower(current_setting('app.migration_digest'))) or not public.billing_retry_schema_ready() then
    raise exception 'BILLING_MIGRATION_MARKER_FAILED';
  end if;
end $$;
commit;
