# Weird Twitter Time Machine

A time capsule of a strange, golden stretch of the internet — roughly
2012–2014 — when a loose crowd of writers, comedians, and merry pranksters all
happened to land on the same underpowered website at the same time and started
making jokes at each other. It didn't last, and most of it is gone now. This
recreates it: pick a day from the archive and see the timeline exactly as it
looked, styled like Twitter of that era. Every post links back to the original
tweet. Reply to any post — your reply is stamped with today's date, so it reads
as a message sent back in time.

Live site: https://freethebikes.github.io/WeirdTwitterTimeMachine/

## Data sources

The archive is a recovered cross-section of that scene — the writers,
comedians, and shitposters who defined it — reassembled from two sources:

- [Cool Tweets](https://web.archive.org/web/2022/https://cooltweets.herokuapp.com/)
  (cooltweets.herokuapp.com, dead since mid-2023), which archived ~200 classic
  weird twitter accounts. Recovered from the Wayback Machine by
  `scripts/scrape-cooltweets.mjs` (every Cool Tweets page was static HTML with
  the full archive inline). These posts have no engagement stats; the UI hides
  the stats line for them. Post-Nov-2010 timestamps are exact (decoded from
  snowflake IDs); older ones use the page's rendered US/Pacific time, verified
  against dril-archive overlap. Only original posts are merged into the site —
  @-replies and RTs (two-thirds of the ~5M recovered tweets) are left out,
  both for size and because a timeline never showed strangers' replies. The
  complete unfiltered data (locally in gitignored `data/cooltweets/`) is
  published at
  [freethebikes/cooltweets-archive](https://github.com/freethebikes/cooltweets-archive).
- [dril-archive](https://github.com/codemasher/dril-archive), a
  community-compiled archive of every @dril tweet (2008–2023) with full stats
  and original tweet links — one account's complete run, folded in among the
  rest. `scripts/prepare-data.mjs` converts its `dril.json` export into the
  per-year files in `docs/data/`, then `merge-cooltweets.mjs` layers the Cool
  Tweets scene on top.

## Find Your Likes

The sidebar has a "Find Your Likes" panel: upload the `like.js` file from
your own X data archive (Settings → Download an archive of your data →
`data/like.js`) and it checks every liked tweet ID against the archive,
entirely client-side.

Real (post-2010-11-04) tweet IDs are Snowflake IDs that encode their own
creation timestamp, so the browser decodes each liked ID's day directly (no
lookup needed) to know which `tweets-YYYY-MM.json` file to check it against.
The small sliver of pre-Snowflake tweets (sequential IDs, no embedded
timestamp) are matched against `docs/data/legacy-ids.json`, a small
id → day index built by `scripts/build-likes-index.mjs`. In Supabase mode,
matching is a direct `id=in.(...)` query instead.

## Running modes

The site works two ways, controlled by `docs/js/config.js`:

- **Static (default)** — posts load from the bundled JSON in `docs/data/`.
  Replies you add are saved in your browser's `localStorage` only, and are
  not shared with other visitors.
- **Supabase** — posts, users, and replies are all served from a Supabase
  project, so replies are shared and persistent across visitors.

### Setting up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run `supabase/schema.sql`.
3. Import the archive data:
   ```
   SUPABASE_URL=https://xyz.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
   node scripts/import-supabase.mjs
   ```
   (Service role key is under Project Settings → API — required for the
   import since the public anon key can't write to `tweets`/`users`.)
4. Edit `docs/js/config.js` and set `SUPABASE_URL` and `SUPABASE_ANON_KEY`
   (the anon/public key, safe to ship in client code — row level security
   restricts it to reads, plus inserting into `replies`).

## Regenerating data from a fresh archive export

```
node scripts/prepare-data.mjs path/to/dril.json   # dril, from dril-archive
node scripts/scrape-cooltweets.mjs                # recover Cool Tweets from Wayback
node scripts/merge-cooltweets.mjs                 # fold them into docs/data/
node scripts/build-likes-index.mjs                # rebuild legacy-ids.json for Find Your Likes
```

`prepare-data.mjs` rewrites `docs/data/` with dril only, so always run
`merge-cooltweets.mjs` after it. The scraper caches everything under `data/`
(gitignored) and is safe to re-run; it only downloads what's missing.
`build-likes-index.mjs` should run last, after `docs/data/tweets-*.json` is
final.

## Local development

```
cd docs && python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Deployment

The site is plain static files in `docs/`, served via GitHub Pages
(Settings → Pages → Deploy from branch → `main` / `docs`). No build step,
no login.
