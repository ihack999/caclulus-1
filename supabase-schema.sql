create table if not exists public.user_course_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  progress jsonb not null default '{}'::jsonb,
  youtube_links jsonb not null default '{}'::jsonb,
  lesson_notes jsonb not null default '{}'::jsonb,
  ui_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_course_state enable row level security;

grant select, insert, update, delete on public.user_course_state to authenticated;

create or replace function public.set_user_course_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_course_state_updated_at on public.user_course_state;

create trigger set_user_course_state_updated_at
before update on public.user_course_state
for each row
execute function public.set_user_course_state_updated_at();

drop policy if exists "Users can read own course state" on public.user_course_state;
drop policy if exists "Users can insert own course state" on public.user_course_state;
drop policy if exists "Users can update own course state" on public.user_course_state;
drop policy if exists "Users can delete own course state" on public.user_course_state;

create policy "Users can read own course state"
on public.user_course_state
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert own course state"
on public.user_course_state
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update own course state"
on public.user_course_state
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete own course state"
on public.user_course_state
for delete
to authenticated
using ((select auth.uid()) = user_id);
