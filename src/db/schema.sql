-- Siren schema. Idempotent: safe to re-run (`npm run db:push`).
-- gen_random_uuid() is built into Postgres 13+ (Supabase ships 15+).

create table if not exists groups (
  id                bigserial primary key,
  telegram_chat_id  bigint unique not null,
  chat_title        text,
  created_by        bigint,
  created_at        timestamptz default now()
);

create table if not exists users (
  id                bigserial primary key,
  telegram_user_id  bigint unique not null,
  username          text,
  first_name        text,
  paypal_email      text,
  created_at        timestamptz default now()
);

create table if not exists splits (
  id                uuid primary key default gen_random_uuid(),
  group_id          bigint references groups(id) on delete cascade,
  creator_user_id   bigint references users(id),
  description       text,
  total_amount      numeric(10,2),
  currency          text default 'EUR' check (currency in ('EUR','USD','GBP')),
  per_person_amount numeric(10,2),
  status            text default 'open' check (status in ('draft','open','settled','cancelled')),
  next_nag_at       timestamptz,                -- set by schedule_followup tool
  created_at        timestamptz default now()
);

create table if not exists split_members (
  id                uuid primary key default gen_random_uuid(),
  split_id          uuid references splits(id) on delete cascade,
  user_id           bigint references users(id),
  display_name      text not null,
  paypal_invoice_id text,
  payment_link      text,
  status            text default 'pending' check (status in ('pending','sent','paid','failed','cancelled')),
  paid_at           timestamptz,
  reminders_sent    int default 0,
  last_reminded_at  timestamptz
);

create table if not exists user_memory (
  id                uuid primary key default gen_random_uuid(),
  user_id           bigint references users(id) on delete cascade,
  group_id          bigint references groups(id) on delete cascade,
  avg_hours_to_pay  numeric,
  reliability_score numeric,
  preferred_tone    text default 'neutral' check (preferred_tone in ('chill','neutral','direct')),
  total_splits      int default 0,
  total_paid_ontime int default 0,
  notes             text,
  updated_at        timestamptz default now(),
  unique (user_id, group_id)
);

create table if not exists reasoning_log (
  id             bigserial primary key,
  group_id       bigint references groups(id) on delete cascade,
  split_id       uuid references splits(id) on delete set null,
  trigger        text,                        -- 'user_message' | 'scheduled_run' | 'webhook'
  thoughts       jsonb,                       -- array of {step, text, toolCalls, toolResults}
  final_response text,
  created_at     timestamptz default now()
);

create index if not exists idx_split_members_invoice   on split_members(paypal_invoice_id);
create index if not exists idx_splits_group_open       on splits(group_id) where status = 'open';
create index if not exists idx_user_memory_user_group  on user_memory(user_id, group_id);
create index if not exists idx_reasoning_log_group     on reasoning_log(group_id, created_at desc);

-- The live tables pre-date this file (created from the original ARCHITECTURE.md SQL), so
-- `create table if not exists` never added columns introduced later. Add them explicitly.
alter table splits add column if not exists next_nag_at timestamptz;

-- Milestone 7: 'draft' = proposed by the agent, waiting for the creator to tap ✅ Send.
-- (`create table if not exists` won't change an existing table, so migrate the check explicitly.)
alter table splits drop constraint if exists splits_status_check;
alter table splits add constraint splits_status_check check (status in ('draft','open','settled','cancelled'));

-- Supabase exposes every public table over its REST API to anyone holding the anon key.
-- Enabling RLS with no policies blocks anon access entirely; our server uses the
-- service_role key, which bypasses RLS.
alter table groups        enable row level security;
alter table users         enable row level security;
alter table splits        enable row level security;
alter table split_members enable row level security;
alter table user_memory   enable row level security;
alter table reasoning_log enable row level security;
