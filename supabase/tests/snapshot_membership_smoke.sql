-- v0.3.0 | 2026-10-03. Parent-only hpe_lab fixture; no product table or ledger writes.
-- Run independently before migration or through migration_regression.psql.
begin;
do $$ begin
  if current_database() <> 'hpe_lab' then raise exception 'DISPOSABLE_PARENT_FIXTURE_REQUIRED'; end if;
end $$;
create temporary table snapshot_membership_fixture (
  table_name text primary key,
  columns text[]
) on commit drop;
insert into pg_temp.snapshot_membership_fixture values
  ('payments',array['id','approved_at']),
  ('webhook_events',array['id','raw']),
  ('null_array',null),
  ('empty_array',array[]::text[]);

do $$
declare v_column text; v_table text;
begin
  foreach v_column in array array[
    'provider_effective_at','billing_review_required','event_key','record_kind','processing_state'
  ] loop
    v_table := case when v_column in ('provider_effective_at','billing_review_required')
      then 'payments' else 'webhook_events' end;
    if coalesce((select v_column = any(columns) from pg_temp.snapshot_membership_fixture
      where table_name = v_table),false) then
      raise exception 'SNAPSHOT_ABSENT_COLUMN_GUARD_FAILED: %',v_column;
    end if;
    update pg_temp.snapshot_membership_fixture set columns = array_append(columns,v_column)
    where table_name = v_table;
    if not coalesce((select v_column = any(columns) from pg_temp.snapshot_membership_fixture
      where table_name = v_table),false) then
      raise exception 'SNAPSHOT_PRESENT_COLUMN_GUARD_FAILED: %',v_column;
    end if;
    if coalesce((select v_column = any(columns) from pg_temp.snapshot_membership_fixture
      where table_name = 'missing_table'),false)
      or coalesce((select v_column = any(columns) from pg_temp.snapshot_membership_fixture
        where table_name = 'null_array'),false)
      or coalesce((select v_column = any(columns) from pg_temp.snapshot_membership_fixture
        where table_name = 'empty_array'),false) then
      raise exception 'SNAPSHOT_MISSING_OR_NULL_GUARD_FAILED: %',v_column;
    end if;
  end loop;
end $$;
commit;
