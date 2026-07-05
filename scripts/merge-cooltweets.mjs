#!/usr/bin/env node
// Merges the recovered Cool Tweets archives (data/cooltweets/, produced by
// scrape-cooltweets.mjs) into the site's data files (docs/data/).
//
// Usage: node scripts/merge-cooltweets.mjs
//
// Rows already present in docs/data/ win on ID conflicts, so the dril rows
// from dril-archive keep their engagement stats. Safe to re-run. If you
// regenerate docs/data/ from a fresh dril.json (prepare-data.mjs), run this
// again afterwards to re-add the Cool Tweets accounts.
//
// Only original posts go into the site: @-replies and RTs are skipped (a
// timeline never showed strangers' replies, and with ~200 accounts they are
// two-thirds of the volume). The complete data stays in data/cooltweets/.
// Output is one file per month — per-year files would blow past GitHub's
// 100 MB file limit.

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "docs", "data");
const ctDir = join(root, "data", "cooltweets");

const byId = new Map();
for (const f of readdirSync(dataDir).filter((f) => /^tweets-\d{4}(-\d{2})?\.json$/.test(f))) {
  for (const t of JSON.parse(readFileSync(join(dataDir, f), "utf8"))) byId.set(t.id, t);
}
const existing = byId.size;

const ctFiles = readdirSync(ctDir).filter((f) => f.endsWith(".json"));
if (!ctFiles.length) {
  console.error(`no scraped archives in ${ctDir} — run scrape-cooltweets.mjs first`);
  process.exit(1);
}

const archiveCount = new Map(); // screen_name -> tweets in scraped archive
const firstTweet = new Map(); // screen_name -> earliest ts
let ctTotal = 0;
let skipped = 0;
for (const f of ctFiles) {
  const { tweets } = JSON.parse(readFileSync(join(ctDir, f), "utf8"));
  for (const t of tweets) {
    ctTotal++;
    archiveCount.set(t.user, (archiveCount.get(t.user) || 0) + 1);
    if (!firstTweet.has(t.user) || t.ts < firstTweet.get(t.user)) firstTweet.set(t.user, t.ts);
    if (/^@\w/.test(t.text) || /^RT @/i.test(t.text)) {
      skipped++;
      continue;
    }
    if (byId.has(t.id)) continue;
    byId.set(t.id, {
      id: t.id,
      user: t.user,
      ts: t.ts,
      day: t.day,
      text: t.text,
      // Cool Tweets pages had no engagement stats or media, but other
      // recovered sources (saved profile pages) do — pass them through
      retweets: t.retweets || 0,
      likes: t.likes || 0,
      replies: 0,
      quotes: 0,
      reply_to_id: null,
      reply_to_user: null,
      media: t.media || [],
    });
  }
}

const out = [...byId.values()].sort((a, b) => a.ts - b.ts);

const byMonth = new Map();
const dayCounts = {};
for (const t of out) {
  const month = t.day.slice(0, 7);
  if (!byMonth.has(month)) byMonth.set(month, []);
  byMonth.get(month).push(t);
  dayCounts[t.day] = (dayCounts[t.day] || 0) + 1;
}
for (const [month, rows] of byMonth) {
  writeFileSync(join(dataDir, `tweets-${month}.json`), JSON.stringify(rows));
}
// the site now loads per-month files; drop stale per-year ones
for (const f of readdirSync(dataDir).filter((f) => /^tweets-\d{4}\.json$/.test(f))) {
  unlinkSync(join(dataDir, f));
}

const days = Object.keys(dayCounts).sort();
writeFileSync(
  join(dataDir, "index.json"),
  JSON.stringify({
    minDay: days[0],
    maxDay: days[days.length - 1],
    years: [...new Set([...byMonth.keys()].map((m) => m.slice(0, 4)))].sort(),
    dayCounts,
    tweetCount: out.length,
  })
);

// keep existing profiles (dril has a real one); stub the recovered accounts
const users = JSON.parse(readFileSync(join(dataDir, "users.json"), "utf8"));
const known = new Set(users.map((u) => u.screen_name));
const added = [];
for (const name of [...archiveCount.keys()].sort((a, b) => a.localeCompare(b))) {
  if (known.has(name)) continue;
  users.push({
    screen_name: name,
    name,
    description: "",
    location: "",
    avatar: "",
    joined: firstTweet.get(name),
    followers: null,
    following: null,
    statuses: archiveCount.get(name),
  });
  added.push(name);
}
writeFileSync(join(dataDir, "users.json"), JSON.stringify(users));

console.log(
  `merged ${ctTotal} scraped tweets (${skipped} @-replies/RTs left out): ` +
    `${out.length - existing} new, ${out.length} total across ${byMonth.size} month files ` +
    `(${days[0]} .. ${days[days.length - 1]}), ${added.length} accounts added`
);
