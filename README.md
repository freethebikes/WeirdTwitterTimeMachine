# Weird Twitter Time Machine

Pick a day from the archive and see the timeline exactly as it looked, styled
like Twitter circa 2012–2014. Every post links back to the original tweet.
Reply to any post — your reply is stamped with today's date, so it reads as
a message sent back in time.

Live site: https://freethebikes.github.io/WeirdTwitterTimeMachine/

## Data sources

- [dril-archive](https://github.com/codemasher/dril-archive), a
  community-compiled archive of every @dril tweet (2008–2023) with full stats
  and original tweet links. `scripts/prepare-data.mjs` converts its `dril.json`
  export into the per-year files in `docs/data/`.
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
  complete unfiltered data lives in `data/cooltweets/` (gitignored).

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
```

`prepare-data.mjs` rewrites `docs/data/` with dril only, so always run
`merge-cooltweets.mjs` after it. The scraper caches everything under `data/`
(gitignored) and is safe to re-run; it only downloads what's missing.

## Local development

```
cd docs && python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Deployment

The site is plain static files in `docs/`, served via GitHub Pages
(Settings → Pages → Deploy from branch → `main` / `docs`). No build step,
no login.
