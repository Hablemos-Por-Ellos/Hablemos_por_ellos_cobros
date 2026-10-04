-- v0.3.0 | 2026-10-03. Disposable fixture ONLY; the parent owns its database/container.
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;

create table public.donors (
  id uuid primary key default gen_random_uuid(),
  email varchar(255) not null unique,
  first_name varchar(100) not null,
  last_name varchar(100) not null,
  phone varchar(30),
  document_type varchar(10),
  document_number varchar(50),
  city varchar(100),
  wants_updates boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  donor_id uuid not null references public.donors(id) on delete cascade,
  amount integer not null,
  currency varchar(3) not null default 'COP',
  frequency varchar(20) not null default 'monthly',
  status varchar(30) not null default 'active',
  payment_method_type varchar(20),
  wompi_payment_source_id varchar(500),
  wompi_masked_details varchar(100),
  reference varchar(100),
  created_at timestamptz default now(),
  cancelled_at timestamptz,
  next_payment_date timestamptz
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references public.subscriptions(id) on delete cascade,
  amount integer,
  currency varchar(3) default 'COP',
  status varchar(30),
  wompi_transaction_id varchar(255),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  transaction_id text,
  event_type text,
  raw jsonb not null,
  created_at timestamptz default now()
);

create unique index idx_webhook_events_unique
  on public.webhook_events(transaction_id, event_type)
  where transaction_id is not null;

create unique index idx_webhook_events_raw_unique
  on public.webhook_events((raw ->> 'transaction_id'), (raw ->> 'event_type'))
  where raw ->> 'transaction_id' is not null;

insert into public.webhook_events(id, transaction_id, event_type, raw)
values (
  '60000000-0000-0000-0000-000000000001',
  'legacy-transaction',
  'transaction.updated',
  '{"transaction_id":"legacy-transaction","event_type":"transaction.updated"}'::jsonb
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  action varchar(255) not null,
  subscription_id uuid references public.subscriptions(id),
  donor_id uuid references public.donors(id),
  details jsonb,
  created_at timestamptz default now()
);

alter table public.donors enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
alter table public.webhook_events enable row level security;
alter table public.audit_logs enable row level security;

grant references, trigger, truncate on table public.donors, public.subscriptions,
  public.payments, public.webhook_events, public.audit_logs to anon, authenticated;

insert into public.donors(id, email, first_name, last_name)
values ('10000000-0000-0000-0000-000000000090','legacy@example.test','Legacy','Fixture');
insert into public.subscriptions(id, donor_id, amount, reference, wompi_payment_source_id, next_payment_date)
values ('20000000-0000-0000-0000-000000000090','10000000-0000-0000-0000-000000000090',
  25000,'HPE-LEGACY','fixture-legacy-source','2026-10-16T12:00:00Z');
insert into public.payments(id, subscription_id, amount, status, wompi_transaction_id, created_at, updated_at)
values ('70000000-0000-0000-0000-000000000090','20000000-0000-0000-0000-000000000090',
  10000,'approved','tx-historic-10000','2026-01-02T12:00:00Z','2026-02-03T12:00:00Z'),
  ('70000000-0000-0000-0000-000000000091',null,null,null,null,null,null);
insert into public.webhook_events(id, raw)
values ('60000000-0000-0000-0000-000000000090',
  '{"receipt_version":1,"event":"transaction.updated","environment":"sandbox","event_timestamp":1789844400,
    "transaction":{"id":"tx-historic-10000","status":"APPROVED","reference":"HPE-LEGACY","amount_in_cents":1000000,"currency":"COP","finalized_at":null},
    "checksum":"fixture-checksum","body_sha256":"fixture-body-sha256","received_at":"2026-09-19T15:00:00Z"}'::jsonb);
