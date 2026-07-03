-- Weird Twitter Time Machine schema
-- Run this in the Supabase SQL editor (or `supabase db push`) once per project.

-- Archived posts. IDs are Twitter snowflake IDs; they overflow JS numbers,
-- so they are stored and transported as text.
create table if not exists public.tweets (
  id text primary key,
  screen_name text not null,
  created_at timestamptz not null,
  posted_day date not null, -- calendar day in America/New_York, used by the date picker
  text text not null,
  retweet_count integer not null default 0,
  like_count integer not null default 0,
  reply_count integer not null default 0,
  quote_count integer not null default 0,
  in_reply_to_status_id text,
  in_reply_to_screen_name text,
  media jsonb not null default '[]'::jsonb
);

create index if not exists tweets_posted_day_idx on public.tweets (posted_day);
create index if not exists tweets_created_at_idx on public.tweets (created_at);

-- Archived account profiles.
create table if not exists public.users (
  screen_name text primary key,
  name text,
  description text,
  location text,
  avatar text,
  joined_at timestamptz,
  followers integer,
  following integer,
  statuses integer
);

-- Present-day replies to archived posts. created_at is "now", by design:
-- these are messages sent back in time.
create table if not exists public.replies (
  id bigint generated always as identity primary key,
  tweet_id text not null references public.tweets (id) on delete cascade,
  author text not null default 'time traveler',
  text text not null,
  created_at timestamptz not null default now(),
  constraint replies_text_length check (char_length(text) between 1 and 280),
  constraint replies_author_length check (char_length(author) between 1 and 40)
);

create index if not exists replies_tweet_id_idx on public.replies (tweet_id);

-- No login: the anon key may read everything and may only insert replies.
alter table public.tweets enable row level security;
alter table public.users enable row level security;
alter table public.replies enable row level security;

drop policy if exists "public read tweets" on public.tweets;
create policy "public read tweets" on public.tweets for select using (true);

drop policy if exists "public read users" on public.users;
create policy "public read users" on public.users for select using (true);

drop policy if exists "public read replies" on public.replies;
create policy "public read replies" on public.replies for select using (true);

drop policy if exists "public insert replies" on public.replies;
create policy "public insert replies" on public.replies
  for insert with check (true);
