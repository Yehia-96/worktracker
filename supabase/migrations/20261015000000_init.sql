-- Work Tracker cloud schema: per-day entries, synced settings, iPhone push subscriptions.
-- Every table is protected by row-level security: each user only ever sees their own rows.

-- ---------- Entries (one row per user per day; last write wins) ----------
create table public.entries (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  date       date not null,
  category   text check (category in ('office', 'home', 'trip', 'vacation', 'sick')),
  note       text not null default '',
  deleted    boolean not null default false,
  updated_at timestamptz not null,           -- when the user made the change (device clock)
  device_id  text,
  synced_at  timestamptz not null default clock_timestamp(), -- when the server stored it (pull cursor)
  primary key (user_id, date)
);
create index entries_user_synced on public.entries (user_id, synced_at);
alter table public.entries enable row level security;
create policy "own entries" on public.entries for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Upsert a batch; a row only replaces the stored one if it is newer.
create function public.upsert_entries(rows jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  insert into entries as e (user_id, date, category, note, deleted, updated_at, device_id, synced_at)
  select auth.uid(), (r->>'date')::date, nullif(r->>'category', ''), coalesce(r->>'note', ''),
         coalesce((r->>'deleted')::boolean, false), (r->>'updated_at')::timestamptz, r->>'device_id', clock_timestamp()
  from jsonb_array_elements(rows) r
  on conflict (user_id, date) do update
    set category = excluded.category, note = excluded.note, deleted = excluded.deleted,
        updated_at = excluded.updated_at, device_id = excluded.device_id, synced_at = clock_timestamp()
    where e.updated_at < excluded.updated_at;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Settings shared between PC and iPhone ----------
create table public.user_settings (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  settings   jsonb not null default '{}',
  timezone   text not null default 'Europe/Berlin',
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
create policy "own settings" on public.user_settings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- iPhone web-push subscriptions ----------
create table public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  device     text,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy "own subscriptions" on public.push_subscriptions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- What the reminder service already sent (written only by the server) ----------
create table public.push_log (
  user_id    uuid not null references auth.users on delete cascade,
  date       date not null,
  kind       text not null,                 -- 'checkin' | 'note' | 'linux-<n>'
  command_id text,
  sent_at    timestamptz not null default now(),
  primary key (user_id, date, kind)
);
alter table public.push_log enable row level security;
create policy "read own log" on public.push_log for select using (auth.uid() = user_id);

-- ---------- Run the reminder service every 5 minutes ----------
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.schedule(
  'worktracker-reminders',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://ljylvlolddaguzxenxdl.supabase.co/functions/v1/send-reminders',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb
     ) $$
);
