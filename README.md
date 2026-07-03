# Weird Twitter Time Machine

Pick a day from the archive and see the timeline exactly as it looked, styled
like Twitter circa 2012–2014. Every post links back to the original tweet.
Reply to any post — your reply is stamped with today's date, so it reads as
a message sent back in time.

Live site: https://freethebikes.github.io/WeirdTwitterTimeMachine/

## Data source

Posts are from [dril-archive](https://github.com/codemasher/dril-archive), a
community-compiled archive of every @dril tweet (2008–2023) with full stats
and original tweet links. `scripts/prepare-data.mjs` converts its `dril.json`
export into the per-year files in `docs/data/`.

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
node scripts/prepare-data.mjs path/to/dril.json
```

This rewrites `docs/data/tweets-*.json`, `docs/data/users.json`, and
`docs/data/index.json`.

## Local development

```
cd docs && python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Deployment

The site is plain static files in `docs/`, served via GitHub Pages
(Settings → Pages → Deploy from branch → `main` / `docs`). No build step,
no login.
