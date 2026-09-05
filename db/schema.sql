-- Kids Classroom Reminders - schema v1
-- Postgres / Supabase. Small, structured, queried by kid + date. No vectors needed yet.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- kids
create table if not exists kids (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,              -- 'sophia'
  display_name text not null,
  grade        text,                              -- '6'
  google_email text unique,                       -- the student's school account
  chrome_profile text,                            -- 'u/1' - which profile the collector uses
  theme        text default 'blue',               -- kid page colour
  view_token   text not null unique default encode(gen_random_bytes(16),'hex'),
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------- classes
create table if not exists classes (
  id            uuid primary key default gen_random_uuid(),
  kid_id        uuid not null references kids(id) on delete cascade,
  classroom_id  text,                             -- Google course id when known
  name          text not null,                    -- 'Class 318 (2026/2027)'
  teacher       text,
  url           text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (kid_id, name)
);

-- ------------------------------------------------------- raw collected items
-- One row per Classroom post/material/assignment as collected. Never edited by hand.
create table if not exists raw_items (
  id             uuid primary key default gen_random_uuid(),
  kid_id         uuid not null references kids(id) on delete cascade,
  class_id       uuid references classes(id) on delete set null,
  source         text not null default 'cowork-chrome',   -- 'cowork-chrome' | 'classroom-api' | 'gmail-guardian'
  kind           text not null,                   -- 'announcement' | 'assignment' | 'material'
  title          text,
  body           text,
  attachments    jsonb not null default '[]'::jsonb,  -- [{title, type, url, extracted_text}]
  source_url     text,                            -- link back to the original post
  posted_at      timestamptz,
  due_at         timestamptz,
  content_hash   text not null,                   -- sha256(kind|title|body|attachment text)
  collected_at   timestamptz not null default now(),
  extracted_at   timestamptz,
  extractor_version text,
  unique (kid_id, content_hash)                   -- re-running the collector is idempotent
);
create index if not exists raw_items_pending_idx on raw_items (kid_id) where extracted_at is null;

-- ---------------------------------------------------------------- events
-- The product. One actionable thing, on one date, for one kid.
create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  kid_id        uuid not null references kids(id) on delete cascade,
  class_id      uuid references classes(id) on delete set null,
  raw_item_id   uuid references raw_items(id) on delete set null,
  rule_id       uuid,                             -- set when generated from a recurring rule
  event_date    date not null,
  start_time    time,
  end_time      time,
  type          text not null,                    -- due | bring | test | tryout | practice | form | gym | trip | info
  kid_title     text not null,                    -- 'Bring your gym uniform'  (5-ish words, kid voice)
  icon          text,                             -- emoji
  parent_detail text,                             -- fuller context for Henry
  source_url    text,
  confidence    numeric(3,2) default 1.00,
  status        text not null default 'pending',  -- pending | published | rejected
  extractor_version text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists events_kid_date_idx on events (kid_id, event_date) where status = 'published';
create index if not exists events_review_idx on events (status, created_at);

-- --------------------------------------------------- school day cycle (Day 1-8)
-- Maps real dates to the school's day number so "Gym on Day 3" becomes real dates.
create table if not exists day_cycle (
  school_date date primary key,
  day_number  int,                                -- 1..8, null = no school (PD day, holiday)
  note        text
);

-- ------------------------------------------------------- recurring rules
-- Gym days, library day, French days - stored as rules, expanded on read.
create table if not exists recurring_rules (
  id          uuid primary key default gen_random_uuid(),
  kid_id      uuid not null references kids(id) on delete cascade,
  class_id    uuid references classes(id) on delete set null,
  type        text not null,                      -- gym | library | french | practice
  kid_title   text not null,
  icon        text,
  parent_detail text,
  cycle_days  int[],                              -- e.g. '{1,4,7}' for Day 1/4/7
  weekdays    int[],                              -- alternative: 1=Mon..5=Fri
  start_time  time,
  end_time    time,
  starts_on   date,
  ends_on     date,
  source_url  text,
  active      boolean not null default true
);

-- --------------------------------------------------------------- checkoffs
-- Kid taps "done" on a card. Per kid, per event, per day.
create table if not exists checkoffs (
  id         uuid primary key default gen_random_uuid(),
  kid_id     uuid not null references kids(id) on delete cascade,
  event_id   uuid references events(id) on delete cascade,
  rule_key   text,                                -- for recurring items with no event row
  for_date   date not null,
  done_at    timestamptz not null default now(),
  unique (kid_id, event_id, for_date)
);

-- ------------------------------------------------------- collector runs (audit)
create table if not exists collection_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  source       text not null default 'cowork-chrome',
  kid_id       uuid references kids(id) on delete set null,
  items_seen   int default 0,
  items_new    int default 0,
  events_new   int default 0,
  status       text default 'running',            -- running | ok | error
  error        text
);

-- ------------------------------------------------------------------ views
create or replace view v_kid_agenda as
select e.kid_id, k.slug as kid_slug, e.event_date, e.start_time, e.type,
       e.kid_title, e.icon, e.parent_detail, e.source_url, e.id as event_id,
       c.name as class_name
from events e
join kids k on k.id = e.kid_id
left join classes c on c.id = e.class_id
where e.status = 'published'
order by e.event_date, e.start_time nulls last;

-- --------------------------------------------------------------------- RLS
-- Everything denied by default; the collector/extractor uses the service key
-- (which bypasses RLS). Kid pages read through an edge function that checks
-- view_token, so no anon policy is granted here on purpose.
alter table kids            enable row level security;
alter table classes         enable row level security;
alter table raw_items       enable row level security;
alter table events          enable row level security;
alter table day_cycle       enable row level security;
alter table recurring_rules enable row level security;
alter table checkoffs       enable row level security;
alter table collection_runs enable row level security;

-- ============================================================ v2 additions
-- Collector freshness: the cron lives outside the DB, so record the slots here
-- and expose "scheduled vs actual" as one row.
create table if not exists collector_schedule (
  slot_utc_hour   int primary key check (slot_utc_hour between 0 and 23),
  slot_utc_minute int not null default 0,
  label           text,
  active          boolean not null default true
);
-- 10:00 / 20:00 / 00:00 UTC = 6am / 4pm / 8pm America/Toronto (EDT)

-- collector_slots(from, to)      -> every scheduled instant in a window
-- v_collector_status             -> last run, last success, prev/next slot, on_schedule
-- v_public_status                -> the anon-readable projection the page reads
-- v_public_sync_log              -> scheduled slot vs actual run, one row each,
--                                   last 3 days + next 36h (the footer sync log)
--
-- Note: collector_schedule has RLS on with no policies and collector_slots() is
-- a plain invoker-rights function, so calling it from a view still ran as the
-- caller and anon saw zero slots. v_collector_status and v_public_sync_log
-- therefore expand the schedule inline instead of calling collector_slots().

-- ------------------------------------------------------- public read surface
-- Base tables keep RLS on with no policies; these owner-owned views are the
-- only thing granted to anon:
--   v_public_kids, v_public_agenda, v_public_school_events,
--   v_public_day_cycle, v_public_status, v_public_sync_log
