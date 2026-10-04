-- v0.3.0: five legacy application tables, no real records. Auth manages auth.users.
do $$ begin
  if current_database() <> 'hpe_auth_lab'
    or not exists(select 1 from information_schema.columns where table_schema = 'auth'
      and table_name = 'users' and column_name = 'encrypted_password') then
    raise exception 'REAL_AUTH_FIXTURE_REQUIRED';
  end if;
end $$;
-- GoTrue's oldest migration uses legacy GUCs; PostgREST supplies modern JSON claims.
create or replace function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
create table public.donors (
  id uuid primary key default gen_random_uuid(), email varchar(255) not null unique,
  first_name varchar(100) not null, last_name varchar(100) not null, phone varchar(30),
  document_type varchar(10), document_number varchar(50), city varchar(100),
  wants_updates boolean default false, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(), donor_id uuid not null references public.donors(id),
  amount integer not null, currency varchar(3) not null default 'COP',
  frequency varchar(20) not null default 'monthly', status varchar(30) not null default 'active',
  payment_method_type varchar(20), wompi_payment_source_id varchar(500), wompi_masked_details varchar(100),
  reference varchar(100), created_at timestamptz default now(), cancelled_at timestamptz,
  next_payment_date timestamptz, processed_transaction_ids text[] default '{}', preferred_payment_day integer
);
create table public.payments (
  id uuid primary key default gen_random_uuid(), subscription_id uuid references public.subscriptions(id),
  amount integer, currency varchar(3) not null default 'COP', status varchar(30),
  wompi_transaction_id varchar(255), created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(), transaction_id text, event_type text,
  raw jsonb not null, created_at timestamptz default now()
);
create unique index idx_webhook_events_unique on public.webhook_events(transaction_id,event_type)
  where transaction_id is not null;
create unique index idx_webhook_events_raw_unique on public.webhook_events((raw ->> 'transaction_id'),(raw ->> 'event_type'))
  where raw ->> 'transaction_id' is not null;
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), action varchar(255) not null,
  subscription_id uuid references public.subscriptions(id), donor_id uuid references public.donors(id),
  details jsonb, created_at timestamptz default now()
);
alter table public.donors enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
alter table public.webhook_events enable row level security;
alter table public.audit_logs enable row level security;
