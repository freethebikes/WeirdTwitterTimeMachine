#!/usr/bin/env node
// Transforms a dril-archive dril.json into the static data files used by the
// site (docs/data/) and by the Supabase importer.
//
// Usage: node scripts/prepare-data.mjs path/to/dril.json
//
// Tweet IDs are 64-bit integers that overflow JS numbers, so the raw JSON is
// patched to quote long integer literals before parsing.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/prepare-data.mjs path/to/dril.json");
  process.exit(1);
}

const raw = readFileSync(src, "utf8").replace(/:\s*(\d{15,})/g, ': "$1"');
const { tweets, users } = JSON.parse(raw);

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const userById = new Map(users.map((u) => [String(u.id), u]));

// archived tweet text carries Twitter's HTML entities; store plain text
const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const out = tweets
  .map((t) => {
    const user = userById.get(String(t.user_id));
    const day = dayFmt.format(new Date(t.created_at * 1000));
    return {
      id: String(t.id),
      user: user ? user.screen_name : "dril",
      ts: t.created_at,
      day,
      text: decode(t.text),
      retweets: t.retweet_count ?? 0,
      likes: t.like_count ?? 0,
      replies: t.reply_count ?? 0,
      quotes: t.quote_count ?? 0,
      reply_to_id: t.in_reply_to_status_id ? String(t.in_reply_to_status_id) : null,
      reply_to_user: t.in_reply_to_screen_name || null,
      media: (t.media || [])
        .filter((m) => m && m.url)
        .map((m) => ({ type: m.type, url: m.url, w: m.width, h: m.height })),
    };
  })
  .sort((a, b) => a.ts - b.ts);

const dataDir = join(root, "docs", "data");
mkdirSync(dataDir, { recursive: true });

// per-month tweet files, keyed by the New York calendar month of the post
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

// index: date range, per-day post counts (for prev/next-day-with-posts nav)
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

const authors = new Set(out.map((t) => t.user));
writeFileSync(
  join(dataDir, "users.json"),
  JSON.stringify(
    users
      .filter((u) => authors.has(u.screen_name))
      .map((u) => ({
      screen_name: u.screen_name,
      // dril's archive snapshot carries his 2023 display name; the classic is "wint"
      name: u.screen_name === "dril" ? "wint" : u.name,
      description: u.description,
      location: u.location,
      avatar: u.screen_name === "dril" ? "assets/dril.jpg" : u.profile_image_s,
      joined: u.created_at,
      followers: u.followers_count,
      following: u.friends_count,
        statuses: u.statuses_count,
      }))
  )
);

console.log(
  `wrote ${out.length} tweets across ${byMonth.size} month files, ` +
    `${days.length} distinct days (${days[0]} .. ${days[days.length - 1]})`
);
