#!/usr/bin/env node
// Recovers the cooltweets.herokuapp.com archives (dead since mid-2023) from
// the Wayback Machine. Every Cool Tweets page was static HTML with the full
// tweet archive inline, so one good snapshot per page recovers everything.
//
// Usage: node scripts/scrape-cooltweets.mjs [--users dril,2tonbug] [--force]
//
// Output: data/cooltweets/<user>.json, one file per archived account:
//   { user, snapshots: [wayback URLs used], tweets: [{id, user, ts, day, text}] }
// Raw snapshot HTML is cached in data/cooltweets/html/ so reruns don't
// re-download multi-megabyte pages from the Wayback Machine.
//
// Timestamps: snowflake-era tweet IDs (Nov 2010 onward) encode the exact UTC
// time, which we trust over the rendered time. Older tweets only have the
// rendered time, which Cool Tweets displayed in US/Pacific (verified against
// dril-archive: e.g. tweet 2304818973 renders "Jun 23, 2009 08:00:00 PM",
// dril-archive says 1245812400 = Jun 24 03:00 UTC = 8pm PDT).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data", "cooltweets");
const htmlDir = join(outDir, "html");
mkdirSync(htmlDir, { recursive: true });

const args = process.argv.slice(2);
const force = args.includes("--force");
const onlyUsers = (() => {
  const i = args.indexOf("--users");
  return i >= 0 ? new Set(args[i + 1].split(",").map((s) => s.toLowerCase())) : null;
})();

const SITE = "cooltweets.herokuapp.com";
const SNOWFLAKE_EPOCH = 1288834974657n;
// sequential tweet IDs ended around 29.7e9 when snowflake began (Nov 2010)
const SNOWFLAKE_MIN = 30000000000n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180000) });
      if (res.ok) return res;
      if (res.status === 404) return null;
      if (i >= tries - 1) throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (i >= tries - 1) throw err;
    }
    const wait = 4000 * 2 ** i;
    console.log(`  retrying in ${wait / 1000}s (attempt ${i + 2}) ...`);
    await sleep(wait);
  }
}

/* ---------- pick the best snapshot of every archived page ---------- */

async function bestSnapshots() {
  const cdxUrl =
    `http://web.archive.org/cdx/search/cdx?url=${SITE}/*` +
    `&output=json&filter=statuscode:200&fl=timestamp,original,length`;
  const rows = await (await fetchRetry(cdxUrl)).json();
  rows.shift(); // header row

  // path -> capture with the largest body (≈ most tweets), latest wins ties
  const pages = new Map();
  for (const [timestamp, original, length] of rows) {
    let path;
    try {
      path = decodeURIComponent(new URL(original).pathname).replace(/\/+$/, "");
    } catch {
      continue;
    }
    // keep only /<user> and /<user>/old pages
    if (!/^\/[A-Za-z0-9_]+(\/old)?$/.test(path)) continue;
    const user = path.split("/")[1];
    if (/\.(css|js|txt|ico)$/i.test(user) || user === "jquery-1.10.2.min") continue;
    const key = path.toLowerCase();
    const prev = pages.get(key);
    const len = Number(length) || 0;
    if (!prev || len > prev.len || (len === prev.len && timestamp > prev.timestamp)) {
      pages.set(key, { timestamp, original, len, user });
    }
  }

  // group the /user and /user/old variants per user
  const byUser = new Map();
  for (const [key, cap] of pages) {
    const ukey = key.replace(/\/old$/, "");
    if (!byUser.has(ukey)) byUser.set(ukey, []);
    byUser.get(ukey).push(cap);
  }
  return byUser;
}

/* ---------- tweet extraction ---------- */

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const laFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});

// epoch seconds for a wall-clock time in America/Los_Angeles
function pacificToTs(y, mo, d, h, mi, s) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(laFmt.formatToParts(guess).map((x) => [x.type, x.value]));
    const asLA = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const want = Date.UTC(y, mo - 1, d, h, mi, s);
    if (asLA === want) break;
    guess += want - asLA;
  }
  return Math.floor(guess / 1000);
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function parseDisplayTime(str) {
  // "Sep 15, 2008 10:25:20 AM" (sometimes date-only in odd captures)
  const m = str.match(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4})(?: (\d{1,2}):(\d{2}):(\d{2}) (AM|PM))?/);
  if (!m) return null;
  const [, mon, d, y, h12, mi, s, ap] = m;
  let h = h12 ? Number(h12) % 12 : 12; // no time -> noon
  if (ap === "PM") h += 12;
  return pacificToTs(Number(y), MONTHS[mon], Number(d), h, Number(mi || 0), Number(s || 0));
}

const TWEET_RE =
  /<li class='t[^']*' id='twit-(\d+)'>[\s\S]*?<div class='user'>([\s\S]*?)<\/div>\s*<div class='text'>([\s\S]*?)<\/div>[\s\S]*?<a href='https?:\/\/twitter\.com\/([^/']+)\/status\/\d+'>\s*([\s\S]*?)\s*<\/a>/g;

function parseTweets(html) {
  const tweets = [];
  for (const m of html.matchAll(TWEET_RE)) {
    const [, id, userDiv, textHtml, linkUser, timeStr] = m;
    const big = BigInt(id);
    const ts =
      big >= SNOWFLAKE_MIN
        ? Number((big >> 22n) + SNOWFLAKE_EPOCH) / 1000 | 0
        : parseDisplayTime(timeStr);
    if (ts == null) continue;
    tweets.push({
      id,
      user: decodeEntities(linkUser || userDiv.trim()),
      ts,
      day: dayFmt.format(new Date(ts * 1000)),
      text: decodeEntities(textHtml.replace(/<[^>]+>/g, "")).trim(),
    });
  }
  return tweets;
}

/* ---------- main ---------- */

console.log("querying Wayback CDX index ...");
const byUser = await bestSnapshots();
console.log(`${byUser.size} archived accounts found`);

let done = 0;
const failures = [];
for (const [ukey, captures] of [...byUser.entries()].sort()) {
  done++;
  if (onlyUsers && !onlyUsers.has(ukey.slice(1))) continue;
  const canonical = captures[0].user;
  const outFile = join(outDir, `${canonical}.json`);
  if (!force && existsSync(outFile)) {
    console.log(`[${done}/${byUser.size}] ${canonical}: already scraped, skipping`);
    continue;
  }

  const byId = new Map();
  const snapshots = [];
  let ok = true;
  for (const cap of captures) {
    const snapUrl = `https://web.archive.org/web/${cap.timestamp}id_/${cap.original}`;
    const cacheFile = join(htmlDir, `${cap.timestamp}_${cap.original.replace(/[^A-Za-z0-9_.-]+/g, "_")}.html`);
    let html;
    if (existsSync(cacheFile)) {
      html = readFileSync(cacheFile, "utf8");
    } else {
      try {
        const res = await fetchRetry(snapUrl);
        if (!res) continue; // capture vanished
        html = await res.text();
        writeFileSync(cacheFile, html);
        await sleep(700); // be gentle with the Wayback Machine
      } catch (err) {
        console.log(`  FAILED ${snapUrl}: ${err.message}`);
        ok = false;
        continue;
      }
    }
    snapshots.push(snapUrl);
    for (const t of parseTweets(html)) if (!byId.has(t.id)) byId.set(t.id, t);
  }

  if (!byId.size) {
    console.log(`[${done}/${byUser.size}] ${canonical}: NO TWEETS PARSED`);
    failures.push(canonical);
    continue;
  }
  if (!ok) failures.push(canonical); // partial: got some pages, not all

  const tweets = [...byId.values()].sort((a, b) => a.ts - b.ts || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  // canonical screen name = most common casing in the status links
  const counts = new Map();
  for (const t of tweets) counts.set(t.user, (counts.get(t.user) || 0) + 1);
  const screenName = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  writeFileSync(outFile, JSON.stringify({ user: screenName, snapshots, tweets }));
  console.log(`[${done}/${byUser.size}] ${canonical}: ${tweets.length} tweets (${tweets[0].day} .. ${tweets[tweets.length - 1].day})`);
}

if (failures.length) {
  console.log(`\nincomplete or failed: ${failures.join(", ")}\nrerun to retry (cached pages are not re-downloaded)`);
  process.exitCode = 1;
} else {
  console.log("\nall accounts scraped");
}
