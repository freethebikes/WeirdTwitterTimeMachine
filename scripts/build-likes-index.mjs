#!/usr/bin/env node
// Builds docs/data/legacy-ids.json, a small id -> day map for tweets old
// enough to predate Twitter's Snowflake ID format (switched over 2010-11-04).
//
// The "find my likes" feature in the browser needs to know which day a
// liked tweet ID falls on before it can guess which docs/data/tweets-*.json
// file to fetch and search. For Snowflake IDs it can decode the day
// straight from the ID (see snowflakeDay() in js/app.js) with no index at
// all. Pre-Snowflake IDs are small sequential integers that don't encode a
// timestamp, so those need this lookup instead. There are only ~25k of
// them across the whole archive (vs. 1.3M Snowflake-era tweets), so the
// index stays tiny.
//
// Run this after prepare-data.mjs + merge-cooltweets.mjs, whenever
// docs/data/tweets-*.json changes.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "docs", "data");

// Real Twitter Snowflake IDs (post 2010-11-04) start in the low quadrillions
// and only grow from there; the old sequential scheme topped out in the low
// tens of billions. 10^12 sits comfortably in the gap between the two.
const SNOWFLAKE_MIN = 1_000_000_000_000n;

const files = readdirSync(dataDir).filter((f) => /^tweets-\d{4}-\d{2}\.json$/.test(f));

const legacy = {};
let scanned = 0;
for (const file of files) {
  const tweets = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
  for (const t of tweets) {
    scanned++;
    if (BigInt(t.id) < SNOWFLAKE_MIN) legacy[t.id] = t.day;
  }
}

writeFileSync(join(dataDir, "legacy-ids.json"), JSON.stringify(legacy));

console.log(
  `scanned ${scanned} tweets across ${files.length} files, ` +
    `wrote ${Object.keys(legacy).length} pre-Snowflake ids to legacy-ids.json`
);
