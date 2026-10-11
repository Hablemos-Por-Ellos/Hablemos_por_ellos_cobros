-- v0.4.2: MFA is established at login and checked on every admin operation.
-- Function-only change. No application tables, rows, indexes or grants change.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
declare target regprocedure := to_regprocedure(
  'public.assert_admin_mutation_context(uuid,text,timestamptz,timestamptz)');
begin
  if target is null or not exists (
    select 1 from pg_proc where oid = target and prosecdef and prorettype = 'void'::regtype
  ) then raise exception 'ADMIN_CONTEXT_FUNCTION_REQUIRED'; end if;
  if not has_function_privilege('service_role', target, 'EXECUTE')
    or has_function_privilege('anon', target, 'EXECUTE')
    or has_function_privilege('authenticated', target, 'EXECUTE') then
    raise exception 'ADMIN_CONTEXT_PRIVILEGES_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.assert_admin_mutation_context(
  p_actor_user_id uuid, p_actor_aal text,
  p_actor_session_issued_at timestamptz, p_totp_verified_at timestamptz
)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $function$
begin
  -- admin-session-mfa-v0.4.2: identity/AAL/iat are verified by the server, not the request body.
  if p_actor_user_id is null or p_actor_aal is distinct from 'aal2'
    or p_actor_session_issued_at is null or not isfinite(p_actor_session_issued_at)
    or p_actor_session_issued_at > clock_timestamp() then
    raise exception 'ADMIN_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  -- Preserve the old signature for existing RPCs. NULL means no per-action TOTP;
  -- do not fabricate a verification time. Existing historical values stay unchanged.
  if p_totp_verified_at is not null and (
    not isfinite(p_totp_verified_at) or p_totp_verified_at > clock_timestamp()
  ) then raise exception 'ADMIN_NOT_AUTHORIZED' using errcode = '42501'; end if;

  -- SHARE locks active/role/revocation until the surrounding audit transaction completes.
  perform 1 from public.admin_users where user_id = p_actor_user_id
    and active and role in ('admin','super_admin')
    and date_trunc('second', p_actor_session_issued_at) > sessions_valid_after
  for share;
  if not found then
    raise exception 'ADMIN_NOT_AUTHORIZED' using errcode = '42501';
  end if;
end;
$function$;

commit;
