-- Stage 2 sync foundation.
-- Run after the existing schema and upgrade files. This is additive and does
-- not modify supabase-schema.sql.

-- 1. Inspect the business tables before adding compatibility columns.
do $$
declare
  v_table_name text;
begin
  foreach v_table_name in array array[
    'time_tasks',
    'time_records',
    'daily_summaries',
    'thought_entries',
    'reading_books',
    'reading_notes'
  ] loop
    if to_regclass('public.' || v_table_name) is null then
      raise notice 'Skipping missing table public.%', v_table_name;
    end if;
  end loop;
end $$;

-- 2. All syncable business rows need a server-side change timestamp.
do $$
declare
  v_table_name text;
begin
  foreach v_table_name in array array[
    'time_tasks',
    'time_records',
    'daily_summaries',
    'thought_entries',
    'reading_books',
    'reading_notes'
  ] loop
    if to_regclass('public.' || v_table_name) is not null then
      execute format(
        'alter table public.%I add column if not exists updated_at timestamptz not null default now()',
        v_table_name
      );
    end if;
  end loop;
end $$;

-- Every syncable table must remain tenant-scoped and protected by RLS.
do $$
declare
  v_table_name text;
begin
  foreach v_table_name in array array[
    'time_tasks',
    'time_records',
    'daily_summaries',
    'thought_entries',
    'reading_books',
    'reading_notes'
  ] loop
    if to_regclass('public.' || v_table_name) is not null then
      if not exists (
        select 1 from information_schema.columns as c
        where c.table_schema = 'public'
          and c.table_name = v_table_name
          and c.column_name = 'user_id'
      ) then
        raise exception 'public.% is missing required user_id column', v_table_name;
      end if;
      execute format('alter table public.%I enable row level security', v_table_name);
    end if;
  end loop;
end $$;

-- 3. Preserve the existing daily-summary uniqueness guarantee if an older
-- schema was created without it. Duplicates are reported, never deleted.
do $$
begin
  if to_regclass('public.daily_summaries') is not null
    and not exists (
      select 1 from pg_constraint
      where conrelid = 'public.daily_summaries'::regclass
        and contype = 'u'
        and conkey = array[
          (select attnum from pg_attribute where attrelid = 'public.daily_summaries'::regclass and attname = 'user_id'),
          (select attnum from pg_attribute where attrelid = 'public.daily_summaries'::regclass and attname = 'date'),
          (select attnum from pg_attribute where attrelid = 'public.daily_summaries'::regclass and attname = 'slot')
        ]::smallint[]
    )
  then
    if exists (
      select user_id, date, slot
      from public.daily_summaries
      group by user_id, date, slot
      having count(*) > 1
    ) then
      raise exception 'daily_summaries contains duplicate (user_id, date, slot) rows; resolve them before applying sync-v1';
    end if;
    alter table public.daily_summaries
      add constraint daily_summaries_user_date_slot_unique unique (user_id, date, slot);
  end if;
end $$;

-- 4. Operation log reserved for future reliable sync and migration batches.
create table if not exists public.sync_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id text not null,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  migration_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  error_message text,
  unique (user_id, operation_id)
);

create index if not exists sync_operations_user_status_idx
  on public.sync_operations (user_id, status, updated_at desc);

create index if not exists sync_operations_entity_idx
  on public.sync_operations (user_id, entity_type, entity_id);

-- Keep updated_at current for operation state transitions.
create or replace function public.set_sync_operations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sync_operations_set_updated_at on public.sync_operations;
create trigger sync_operations_set_updated_at
before update on public.sync_operations
for each row execute function public.set_sync_operations_updated_at();

-- 5. Re-check access boundaries: users can only inspect or mutate their own
-- operation records. The migration RPC remains separately protected.
alter table public.sync_operations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sync_operations'
      and policyname = 'users manage own sync operations'
  ) then
    create policy "users manage own sync operations"
      on public.sync_operations
      for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- No broad grants are added here. Supabase RLS remains the access boundary.

-- 6. Conflict-ready lifecycle metadata. Deletes become tombstones in the
-- application layer; no existing row is removed by this migration.
do $$
declare
  v_table_name text;
begin
  foreach v_table_name in array array[
    'time_tasks',
    'time_records',
    'daily_summaries',
    'thought_entries',
    'reading_books',
    'reading_notes'
  ] loop
    if to_regclass('public.' || v_table_name) is not null then
      execute format(
        'alter table public.%I add column if not exists deleted_at timestamptz',
        v_table_name
      );
      execute format(
        'create index if not exists %I on public.%I (user_id, deleted_at, updated_at desc)',
        v_table_name || '_sync_lifecycle_idx',
        v_table_name
      );
    end if;
  end loop;
end $$;

-- The database, rather than a client clock, owns the authoritative update
-- time. Existing rows and client-supplied timestamps are preserved until an
-- actual update occurs.
create or replace function public.set_business_row_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  v_table_name text;
  v_trigger_name text;
begin
  foreach v_table_name in array array[
    'time_tasks',
    'time_records',
    'daily_summaries',
    'thought_entries',
    'reading_books',
    'reading_notes'
  ] loop
    if to_regclass('public.' || v_table_name) is not null then
      v_trigger_name := v_table_name || '_set_updated_at';
      execute format('drop trigger if exists %I on public.%I', v_trigger_name, v_table_name);
      execute format(
        'create trigger %I before update on public.%I for each row execute function public.set_business_row_updated_at()',
        v_trigger_name,
        v_table_name
      );
    end if;
  end loop;
end $$;
