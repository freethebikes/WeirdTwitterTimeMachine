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

-- Present-day replies to archived posts (or to present-day posts, below).
-- created_at is "now", by design: these are messages sent back in time.
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

-- ---------------------------------------------------------------------------
-- Accounts. One profile per Supabase Auth user; handles live in the same
-- textual namespace as the archive's screen_names but never collide with
-- them (enforced by profiles_handle_guard), so blocks, from: search, and
-- the name filter stay plain string matching.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text not null unique,
  display_name text not null,
  avatar text,
  created_at timestamptz not null default now(),
  constraint profiles_handle_format check (handle ~ '^[a-z0-9_]{2,20}$'),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 50)
);

-- Standalone posts from the present. posted_day is forced to today's
-- New York calendar day by stamp_post — nobody posts into the archive.
create table if not exists public.posts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now(),
  posted_day date not null default ((now() at time zone 'America/New_York')::date),
  constraint posts_text_length check (char_length(text) between 1 and 280)
);

create index if not exists posts_posted_day_idx on public.posts (posted_day);

-- Replies may now target either an archive tweet or a present-day post.
alter table public.replies add column if not exists user_id uuid references public.profiles (id) on delete set null;
alter table public.replies add column if not exists post_id bigint references public.posts (id) on delete cascade;
alter table public.replies alter column tweet_id drop not null;
do $$ begin
  alter table public.replies add constraint replies_one_target check (num_nonnulls(tweet_id, post_id) = 1);
exception when duplicate_object then null; end $$;

create index if not exists replies_post_id_idx on public.replies (post_id);

-- Per-user lists, private to their owner.
create table if not exists public.likes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  tweet_id text references public.tweets (id) on delete cascade,
  post_id bigint references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint likes_one_target check (num_nonnulls(tweet_id, post_id) = 1)
);

create unique index if not exists likes_user_tweet_idx on public.likes (user_id, tweet_id) where tweet_id is not null;
create unique index if not exists likes_user_post_idx on public.likes (user_id, post_id) where post_id is not null;

create table if not exists public.follows (
  user_id uuid not null references public.profiles (id) on delete cascade,
  screen_name text not null references public.users (screen_name) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, screen_name)
);

create table if not exists public.blocks (
  user_id uuid not null references public.profiles (id) on delete cascade,
  screen_name text not null, -- no FK: may name an archive account or a user handle
  created_at timestamptz not null default now(),
  primary key (user_id, screen_name)
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Keep user handles out of the archive namespace.
create or replace function public.profiles_handle_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (select 1 from public.users where lower(screen_name) = new.handle) then
    raise exception 'handle "%" belongs to an archive account', new.handle
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_handle_guard on public.profiles;
create trigger profiles_handle_guard
  before insert or update of handle on public.profiles
  for each row execute function public.profiles_handle_guard();

-- Create a profile as soon as an auth user exists. Handle comes from the
-- provider metadata (GitHub username, Google name, email local-part) and is
-- suffixed until it collides with neither profiles nor the archive.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := coalesce(
    new.raw_user_meta_data ->> 'user_name',
    new.raw_user_meta_data ->> 'preferred_username',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(new.email, '@', 1),
    'timetraveler'
  );
  base := regexp_replace(lower(base), '[^a-z0-9_]', '', 'g');
  if char_length(base) < 2 then base := 'timetraveler'; end if;
  base := left(base, 20);
  candidate := base;
  while exists (select 1 from public.profiles where handle = candidate)
     or exists (select 1 from public.users where lower(screen_name) = candidate)
  loop
    n := n + 1;
    candidate := left(base, 20 - char_length(n::text)) || n::text;
  end loop;
  insert into public.profiles (id, handle, display_name, avatar)
  values (
    new.id,
    candidate,
    left(coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      candidate
    ), 50),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stamp replies with the poster's identity server-side: the client never
-- sends user_id/author, so they can't be spoofed. created_at is forced to
-- now() — replies are always sent from the present.
create or replace function public.stamp_reply()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to reply';
  end if;
  new.user_id := auth.uid();
  new.author := (select handle from public.profiles where id = auth.uid());
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists stamp_reply on public.replies;
create trigger stamp_reply
  before insert on public.replies
  for each row execute function public.stamp_reply();

-- Posts always land on today's New York calendar day.
create or replace function public.stamp_post()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  new.user_id := auth.uid();
  new.created_at := now();
  new.posted_day := (now() at time zone 'America/New_York')::date;
  return new;
end;
$$;

drop trigger if exists stamp_post on public.posts;
create trigger stamp_post
  before insert on public.posts
  for each row execute function public.stamp_post();

-- ---------------------------------------------------------------------------
-- Row level security. The anon key may read the public tables; writing
-- anything requires a signed-in user, and the per-user lists are visible
-- only to their owner.
-- ---------------------------------------------------------------------------

alter table public.tweets enable row level security;
alter table public.users enable row level security;
alter table public.replies enable row level security;
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.likes enable row level security;
alter table public.follows enable row level security;
alter table public.blocks enable row level security;

drop policy if exists "public read tweets" on public.tweets;
create policy "public read tweets" on public.tweets for select using (true);

drop policy if exists "public read users" on public.users;
create policy "public read users" on public.users for select using (true);

drop policy if exists "public read replies" on public.replies;
create policy "public read replies" on public.replies for select using (true);

-- Replaces the old anonymous "public insert replies" policy: writing now
-- requires an account. stamp_reply forces user_id to auth.uid(), so the
-- check is belt-and-braces.
drop policy if exists "public insert replies" on public.replies;
drop policy if exists "authed insert replies" on public.replies;
create policy "authed insert replies" on public.replies
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "own delete replies" on public.replies;
create policy "own delete replies" on public.replies
  for delete using (auth.uid() = user_id);

drop policy if exists "public read profiles" on public.profiles;
create policy "public read profiles" on public.profiles for select using (true);

drop policy if exists "own insert profile" on public.profiles;
create policy "own insert profile" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "own update profile" on public.profiles;
create policy "own update profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "public read posts" on public.posts;
create policy "public read posts" on public.posts for select using (true);

drop policy if exists "authed insert posts" on public.posts;
create policy "authed insert posts" on public.posts
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "own delete posts" on public.posts;
create policy "own delete posts" on public.posts
  for delete using (auth.uid() = user_id);

drop policy if exists "own likes" on public.likes;
create policy "own likes" on public.likes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own follows" on public.follows;
create policy "own follows" on public.follows
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own blocks" on public.blocks;
create policy "own blocks" on public.blocks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
