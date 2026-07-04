#!/usr/bin/env node
// Recovers era-appropriate profile avatars for the recovered accounts from
// Wayback Machine captures of their twitter.com profile pages.
//
// Usage: node scripts/scrape-avatars.mjs [--users a,b] [--force] [--limit N]
//
// For each account in docs/data/users.json without an avatar:
//   1. CDX-query archived captures of twitter.com/<handle>, preferring the
//      2011-2016 era (server-rendered HTML; modern captures are a JS shell)
//   2. pull the profile_images URL out of the archived HTML
//   3. download the archived image itself and save it under
//      docs/assets/avatars/, then point users.json at it
//
// Progress is checkpointed in data/avatars/progress.json so the script can
// be re-run to resume or to re-apply avatars after a data pipeline rebuild.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const usersPath = join(root, "docs", "data", "users.json");
const avatarDir = join(root, "docs", "assets", "avatars");
const progressDir = join(root, "data", "avatars");
const progressPath = join(progressDir, "progress.json");
mkdirSync(avatarDir, { recursive: true });
mkdirSync(progressDir, { recursive: true });

const args = process.argv.slice(2);
const force = args.includes("--force");
const onlyUsers = (() => {
  const i = args.indexOf("--users");
  return i >= 0 ? new Set(args[i + 1].split(",").map((s) => s.toLowerCase())) : null;
})();
const limit = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one polite request at a time; the Wayback Machine rate-limits hard
let lastRequest = 0;
const GAP = 1500;
async function fetchWayback(url, { binary = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    let res;
    try {
      res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(3000 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) return null;
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const backoff = Math.max(retryAfter * 1000, 10000 * 2 ** attempt);
      console.log(`    HTTP ${res.status}, backing off ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) return null;
    return binary
      ? { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") || "" }
      : res.text();
  }
}

/* ---------- find candidate profile-page captures ---------- */

async function profileCaptures(handle) {
  const cdx =
    `http://web.archive.org/cdx/search/cdx?url=twitter.com/${handle}` +
    `&output=json&filter=statuscode:200&filter=mimetype:text/html` +
    `&collapse=timestamp:6&fl=timestamp&limit=200`;
  const body = await fetchWayback(cdx);
  if (!body) return [];
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    return [];
  }
  rows.shift(); // header
  const stamps = rows.map((r) => r[0]).filter((ts) => ts < "2021"); // later captures are a JS shell
  // era preference: golden weird-twitter years first, then anything else
  const score = (ts) => {
    const y = Number(ts.slice(0, 4));
    if (y >= 2011 && y <= 2016) return 0;
    if (y >= 2017) return 1;
    return 2; // pre-2011
  };
  stamps.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  return stamps;
}

/* ---------- pull the avatar URL out of archived profile HTML ---------- */

const stripSize = (u) =>
  u.replace(/_(normal|bigger|mini|reasonably_small|200x200|400x400)(\.\w+)?$/, "$2");

function findAvatarUrl(html, handle) {
  // high-confidence, era-specific spots first
  const targeted = [
    /<img[^>]+class="ProfileAvatar-image[^"]*"[^>]+src="([^"]+profile_images[^"]+)"/i,
    /<img[^>]+src="([^"]+profile_images[^"]+)"[^>]+class="ProfileAvatar-image/i,
    /<meta\s+property="og:image"\s+content="([^"]+profile_images[^"]+)"/i,
    /<meta\s+content="([^"]+profile_images[^"]+)"\s+property="og:image"/i,
    /<img[^>]+id="profile-image"[^>]+src="([^"]+profile_images[^"]+)"/i,
    /<img[^>]+class="[^"]*\bavatar\b[^"]*"[^>]+src="([^"]+profile_images[^"]+)"[^>]*alt="[^"]*"/i,
  ];
  for (const re of targeted) {
    const m = html.match(re);
    if (m) return m[1];
  }
  // fallback: the account's own avatar is the most repeated profile_images URL
  // (it sits beside every tweet in 2010-2014 markup)
  const counts = new Map();
  for (const m of html.matchAll(/https?:\/\/[a-z0-9.]*twimg\.com\/profile_images\/[^"'\\\s)]+/gi)) {
    const base = stripSize(m[0]);
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  let best = null;
  for (const [url, n] of counts) if (!best || n > best[1]) best = [url, n];
  return best ? best[0] : null;
}

/* ---------- download the archived image ---------- */

function sizeVariants(url) {
  const base = stripSize(url);
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > base.lastIndexOf("/") ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  const out = [url]; // whatever size the page referenced was definitely captured with it
  for (const s of ["_400x400", "_bigger", "", "_normal"]) {
    const v = `${stem}${s}${ext}`;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

const extFromType = (t) =>
  t.includes("png") ? ".png" : t.includes("gif") ? ".gif" : t.includes("webp") ? ".webp" : ".jpg";

async function downloadAvatar(imgUrl, ts, handle) {
  for (const variant of sizeVariants(imgUrl)) {
    const got = await fetchWayback(`https://web.archive.org/web/${ts}im_/${variant}`, { binary: true });
    if (!got || !got.type.startsWith("image/") || got.buf.length < 100) continue;
    const file = `${handle}${extFromType(got.type)}`;
    writeFileSync(join(avatarDir, file), got.buf);
    return { file, source: variant };
  }
  return null;
}

/* ---------- main ---------- */

const users = JSON.parse(readFileSync(usersPath, "utf8"));
const progress = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, "utf8")) : {};

const queue = users.filter((u) => {
  if (onlyUsers && !onlyUsers.has(u.screen_name.toLowerCase())) return false;
  if (!force && u.avatar) return false;
  if (!force && progress[u.screen_name] && progress[u.screen_name].status === "none") return false;
  return true;
});

console.log(`${queue.length} accounts to try (${Object.keys(progress).length} already checked)`);

let found = 0;
let done = 0;
for (const u of queue) {
  if (done >= limit) break;
  done++;
  const handle = u.screen_name;
  process.stdout.write(`[${done}/${Math.min(queue.length, limit)}] ${handle} ... `);

  // resume: image already on disk from an earlier run, just relink it
  const prev = progress[handle];
  if (prev && prev.status === "ok" && existsSync(join(avatarDir, prev.file))) {
    u.avatar = `assets/avatars/${prev.file}`;
    found++;
    console.log(`already saved (${prev.file})`);
    continue;
  }

  try {
    const stamps = await profileCaptures(handle);
    if (!stamps.length) {
      progress[handle] = { status: "none", reason: "no captures" };
      console.log("no captures");
    } else {
      let result = null;
      for (const ts of stamps.slice(0, 3)) {
        const html = await fetchWayback(`https://web.archive.org/web/${ts}id_/https://twitter.com/${handle}`);
        if (!html) continue;
        const imgUrl = findAvatarUrl(html, handle);
        if (!imgUrl) continue;
        result = await downloadAvatar(imgUrl, ts, handle);
        if (result) {
          progress[handle] = { status: "ok", file: result.file, source: result.source, snapshot: ts };
          u.avatar = `assets/avatars/${result.file}`;
          found++;
          console.log(`saved ${result.file} (capture ${ts.slice(0, 4)})`);
          break;
        }
      }
      if (!result && !progress[handle]) {
        progress[handle] = { status: "none", reason: "no avatar in captures" };
        console.log("no avatar found");
      }
    }
  } catch (err) {
    console.log(`error: ${err.message}`);
  }

  // checkpoint every account; both files are cheap to write
  writeFileSync(progressPath, JSON.stringify(progress, null, 1));
  writeFileSync(usersPath, JSON.stringify(users));
}

console.log(`\ndone: ${found} avatars saved this run`);
