#!/usr/bin/env node
// Loads the prepared archive data (docs/data/) into Supabase.
//
// Usage:
//   SUPABASE_URL=https://xyz.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   node scripts/import-supabase.mjs
//
// Run supabase/schema.sql in the Supabase SQL editor first. The service role
// key (Project Settings -> API) is required because the anon key cannot write
// to the tweets/users tables. Safe to re-run: rows are upserted by primary key.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "data");
const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.");
  process.exit(1);
}

async function upsert(table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const res = await fetch(`${url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      throw new Error(`${table} batch ${i}: HTTP ${res.status} ${await res.text()}`);
    }
    process.stdout.write(`\r${table}: ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }
  process.stdout.write("\n");
}

const users = JSON.parse(readFileSync(join(dataDir, "users.json"), "utf8")).map((u) => ({
  screen_name: u.screen_name,
  name: u.name,
  description: u.description,
  location: u.location,
  avatar: u.avatar,
  joined_at: new Date(u.joined * 1000).toISOString(),
  followers: u.followers,
  following: u.following,
  statuses: u.statuses,
}));

const tweetFiles = readdirSync(dataDir).filter((f) => /^tweets-\d{4}\.json$/.test(f)).sort();
const tweets = tweetFiles.flatMap((f) =>
  JSON.parse(readFileSync(join(dataDir, f), "utf8")).map((t) => ({
    id: t.id,
    screen_name: t.user,
    created_at: new Date(t.ts * 1000).toISOString(),
    posted_day: t.day,
    text: t.text,
    retweet_count: t.retweets,
    like_count: t.likes,
    reply_count: t.replies,
    quote_count: t.quotes,
    in_reply_to_status_id: t.reply_to_id,
    in_reply_to_screen_name: t.reply_to_user,
    media: t.media,
  }))
);

console.log(`importing ${users.length} users and ${tweets.length} tweets to ${url}`);
await upsert("users", users);
await upsert("tweets", tweets);
console.log("done.");
