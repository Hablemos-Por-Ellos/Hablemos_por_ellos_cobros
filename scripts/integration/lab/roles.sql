-- v0.3.0: disposable Auth laboratory, never a production connection.
do $$ begin
  if current_database() <> 'hpe_auth_lab' then raise exception 'AUTH_FIXTURE_DATABASE_REQUIRED'; end if;
end $$;
create schema extensions;
create extension pgcrypto with schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login noinherit password 'hpe-local-auth-fixture-only';
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login noinherit password 'hpe-local-auth-fixture-only';
create schema auth authorization supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth, public, extensions;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to supabase_auth_admin, anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
alter function auth.uid() owner to supabase_auth_admin;
alter function auth.jwt() owner to supabase_auth_admin;
