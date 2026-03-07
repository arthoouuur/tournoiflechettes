-- Run this SQL in Supabase SQL Editor.

create table if not exists public.tournament_state (
  id text primary key,
  state jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.referee_lock (
  id text primary key,
  owner_id text not null,
  owner_label text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.tournament_state enable row level security;
alter table public.referee_lock enable row level security;

drop policy if exists "anon read tournament_state" on public.tournament_state;
drop policy if exists "anon write tournament_state" on public.tournament_state;
drop policy if exists "anon read referee_lock" on public.referee_lock;
drop policy if exists "anon write referee_lock" on public.referee_lock;

create policy "anon read tournament_state"
  on public.tournament_state
  for select
  to anon
  using (true);

create policy "anon write tournament_state"
  on public.tournament_state
  for all
  to anon
  using (true)
  with check (true);

create policy "anon read referee_lock"
  on public.referee_lock
  for select
  to anon
  using (true);

create policy "anon write referee_lock"
  on public.referee_lock
  for all
  to anon
  using (true)
  with check (true);

alter publication supabase_realtime add table public.tournament_state;
alter publication supabase_realtime add table public.referee_lock;
