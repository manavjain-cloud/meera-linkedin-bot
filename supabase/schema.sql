-- Applied to Supabase project meera-linkedin-bot (migration: init_pipeline_tables)
create table public.voice_skill (
  id bigint generated always as identity primary key,
  name text not null default 'meera',
  content text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  telegram_update_id bigint unique,
  chat_id bigint not null,
  message_id bigint,
  text text not null,
  score smallint check (score between 1 and 10),
  score_reason text,
  status text not null default 'received' check (status in ('received','rejected','drafted','error')),
  feedback text,
  error text,
  created_at timestamptz not null default now()
);
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  thesis text,
  search_query text,
  news jsonb,
  model text,
  content text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index drafts_note_id_idx on public.drafts(note_id);
create index drafts_status_created_idx on public.drafts(status, created_at desc);
alter table public.voice_skill enable row level security;
alter table public.notes enable row level security;
alter table public.drafts enable row level security;
-- No policies: only the server (secret key) can read or write.
