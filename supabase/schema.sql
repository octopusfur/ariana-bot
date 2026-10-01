-- ─────────────────────────────────────────────────────────────
-- Ariana — Supabase schema (safe to re-run).
-- Supabase dashboard → SQL Editor → paste all → Run.
-- Tables are locked down (RLS on, no public policies): only the
-- server's service-role key can read/write them.
-- ─────────────────────────────────────────────────────────────

-- Dashboard settings / API keys saved from the app
create table if not exists user_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz default now()
);

-- Brain files + learned memories (the code writes jsonb in `data`, and plain text in `value` for wallets/schedules)
create table if not exists ariana_brain (
  key        text primary key,
  data       jsonb,
  value      text,
  updated_at timestamptz default now()
);

-- One row per conversation (phone / tg_<id> / sg_<number> …)
create table if not exists ariana_conversations (
  phone      text primary key,
  data       jsonb,
  updated_at timestamptz default now()
);

create table if not exists ariana_blocked (
  phone      text primary key,
  created_at timestamptz default now()
);

create table if not exists ariana_friends (
  phone      text primary key,
  created_at timestamptz default now()
);

create table if not exists ariana_push_subs (
  key        text primary key,
  sub        jsonb,
  created_at timestamptz default now()
);

-- Dashboard media library (selfies etc.)
create table if not exists ariana_media (
  id           uuid primary key default gen_random_uuid(),
  filename     text,
  media_type   text,            -- selfie | image | video
  url          text,
  storage_path text,
  tags         jsonb default '[]'::jsonb,
  created_at   timestamptz default now()
);

create table if not exists wardrobe_items (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  url           text,
  storage_path  text,
  display_order bigint,
  created_at    timestamptz default now()
);

create table if not exists facelock_images (
  id           uuid primary key default gen_random_uuid(),
  slot         text,
  url          text,
  storage_path text,
  created_at   timestamptz default now()
);

-- Self-learned skills (documented in skills_engine.js)
create table if not exists ariana_skills (
  id           bigint generated always as identity primary key,
  user_id      text,
  platform     text,
  trigger_text text not null,
  procedure    text not null,
  status       text not null default 'candidate',   -- candidate | confirmed
  uses         int  not null default 1,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index if not exists ariana_skills_trigger_idx on ariana_skills using gin (to_tsvector('english', trigger_text));

-- Influencer / social layer (documented in SOCIAL.md)
create table if not exists ariana_social_accounts (
  account_id      text primary key,
  platform        text not null,
  handle          text not null,
  label           text,
  provider        text,
  actions_enabled boolean default false,
  autopublish     boolean default false,
  status          text,
  status_detail   text,
  last_checked    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists ariana_social_activity (
  id            bigint generated always as identity primary key,
  account_id    text,
  platform      text,
  handle        text,
  action        text,
  target        text,
  target_handle text,
  status        text,
  error         text,
  actor         text,
  summary       text,
  detail        jsonb,
  duration_ms   int,
  created_at    timestamptz default now()
);
create index if not exists ariana_social_activity_created_idx on ariana_social_activity (created_at desc);

create table if not exists ariana_social_config (
  id         text primary key,
  config     jsonb,
  updated_at timestamptz default now()
);

-- Paired-account sessions (Telegram / Signal / …), so nothing lives only on a server disk
create table if not exists sessions (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,
  key        text not null default 'default',
  data       jsonb,
  updated_at timestamptz default now(),
  unique (type, key)
);
-- legacy table the reset endpoint still touches
create table if not exists whatsapp_auth (
  id   bigint generated always as identity primary key,
  data jsonb
);

-- Lock everything down: no policies = anon/public key can read nothing
alter table user_settings          enable row level security;
alter table ariana_brain           enable row level security;
alter table ariana_conversations   enable row level security;
alter table ariana_blocked         enable row level security;
alter table ariana_friends         enable row level security;
alter table ariana_push_subs       enable row level security;
alter table ariana_media           enable row level security;
alter table wardrobe_items         enable row level security;
alter table facelock_images        enable row level security;
alter table ariana_skills          enable row level security;
alter table ariana_social_accounts enable row level security;
alter table ariana_social_activity enable row level security;
alter table ariana_social_config   enable row level security;
alter table sessions               enable row level security;
alter table whatsapp_auth          enable row level security;

-- Storage buckets. ariana-media + avatars are public-read (the app uses public URLs);
-- wwebjs-session (WhatsApp login backup) is private and created by the WhatsApp service itself.
insert into storage.buckets (id, name, public) values ('ariana-media', 'ariana-media', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('wwebjs-session', 'wwebjs-session', false)
  on conflict (id) do nothing;
