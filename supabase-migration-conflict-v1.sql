-- Stage 2 migration conflict protection.
-- Run this additive migration after supabase-schema.sql. It leaves the legacy
-- claim_anonymous_migration function unchanged for rollback compatibility.

create or replace function public.claim_anonymous_migration_safe(p_source_user_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $migration$
declare
  target_user_id uuid := auth.uid();
  valid_token boolean;
  conflicts jsonb := '[]'::jsonb;
  inserted jsonb := '{}'::jsonb;
  moved_count integer;
begin
  if target_user_id is null or target_user_id = p_source_user_id then
    raise exception 'A different signed-in account is required';
  end if;

  select token_hash = p_token_hash and expires_at > now()
    into valid_token
    from public.account_migrations
   where source_user_id = p_source_user_id;
  if valid_token is distinct from true then
    raise exception 'Migration token is invalid or expired';
  end if;

  -- All entity IDs are global primary keys, so a source row and a target row
  -- cannot share an ID. The only business-key collision is daily summaries.
  select coalesce(jsonb_agg(jsonb_build_object(
    'entityType', 'dailySummaries',
    'sourceId', source_summary.id,
    'targetId', target_summary.id,
    'date', source_summary.date,
    'slot', source_summary.slot,
    'reason', '目标账号已存在相同日期和时段的每日总结，迁移已停止且未覆盖任何数据'
  )), '[]'::jsonb)
    into conflicts
    from public.daily_summaries as source_summary
    join public.daily_summaries as target_summary
      on target_summary.user_id = target_user_id
     and target_summary.date = source_summary.date
     and target_summary.slot = source_summary.slot
   where source_summary.user_id = p_source_user_id;

  if jsonb_array_length(conflicts) > 0 then
    return jsonb_build_object(
      'success', false,
      'inserted', inserted,
      'skipped', jsonb_build_object(),
      'failed', jsonb_array_length(conflicts),
      'conflicts', conflicts
    );
  end if;

  -- No UPSERT is used here. These updates only move source-owned rows and
  -- therefore cannot modify records already owned by the target account.
  update public.time_tasks set user_id = target_user_id where user_id = p_source_user_id;
  get diagnostics moved_count = row_count;
  inserted := inserted || jsonb_build_object('tasks', moved_count);

  update public.time_records set user_id = target_user_id where user_id = p_source_user_id;
  get diagnostics moved_count = row_count;
  inserted := inserted || jsonb_build_object('records', moved_count);

  update public.daily_summaries set user_id = target_user_id where user_id = p_source_user_id;
  get diagnostics moved_count = row_count;
  inserted := inserted || jsonb_build_object('dailySummaries', moved_count);

  update public.thought_entries set user_id = target_user_id where user_id = p_source_user_id;
  get diagnostics moved_count = row_count;
  inserted := inserted || jsonb_build_object('thoughts', moved_count);

  update public.reading_books set user_id = target_user_id where user_id = p_source_user_id;
  get diagnostics moved_count = row_count;
  inserted := inserted || jsonb_build_object('books', moved_count);

  update public.reading_notes set user_id = target_user_id where user_id = p_source_user_id;
  get diagnostics moved_count = row_count;
  inserted := inserted || jsonb_build_object('readingNotes', moved_count);

  delete from public.account_migrations where source_user_id = p_source_user_id;

  return jsonb_build_object(
    'success', true,
    'inserted', inserted,
    'skipped', jsonb_build_object(),
    'failed', 0,
    'conflicts', '[]'::jsonb
  );
end;
$migration$;

revoke all on function public.claim_anonymous_migration_safe(uuid, text) from public;
grant execute on function public.claim_anonymous_migration_safe(uuid, text) to authenticated;
