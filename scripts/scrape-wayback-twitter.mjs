#!/usr/bin/env node
// Recovers a single Twitter account's tweets from Wayback Machine captures
// of twitter.com itself (plus mobile.twitter.com and favstar.fm), for
// accounts that never had a Cool Tweets page or downloadable archive.
// Output is data/cooltweets/<User>.json in the same shape as
// scrape-cooltweets.mjs, so merge-cooltweets.mjs folds it into the site.
//
// Usage: node scripts/scrape-wayback-twitter.mjs --user Arr [--cdx-extra file]
//        [--parse-only] [--max-status N] [--daily] [--profiles-only]
//
// --cdx-extra: file of extra captures to include, one "timestamp url" or
//   CDX-JSON-row per line (e.g. ?lang= profile variants that the CDX server
//   can only surface through an expensive prefix scan).
// --parse-only: skip all network fetches, re-parse the HTML cache.
// --daily: collapse profile captures to one per day. For firehose accounts
//   (news outlets) one capture/day of the last ~20 tweets is plenty, and the
//   full digest-distinct set would be 10-30k fetches.
// --profiles-only: skip the status-page, favstar and AJAX-fragment CDX
//   queries entirely (they can 504 or return 100k+ rows for huge accounts).
//
// Capture eras handled:
//   2007-2011  <li/tr class="hentry" id="status_N"> + entry-content +
//              <abbr class="published" title="ISO-UTC">
//   2012-2019  stream/permalink tweets: data-tweet-id / data-screen-name /
//              data-time / p.tweet-text / data-tweet-stat-count
//   2013-2015  mobile.twitter.com <table class="tweet"> blocks
//   2020+      React shell: tweet text only in og:description (title/og:title
//              carry the display name); exact time comes from the snowflake ID
//   2012-2019  AJAX JSON fragments (i/profiles/show/<u>/timeline/tweets,
//              timeline/with_replies, media_timeline, i/<u>/conversation):
//              items_html wraps ordinary stream markup; each capture is a
//              ~20-tweet window that often reaches uncaptured years
//   favstar.fm fs-tweet data-model='{JSON}' blocks
//
// Timestamps are exact: snowflake IDs after Nov 2010, ISO title attributes /
// favstar created_at before that. Engagement counts are taken where the
// markup has them (legacy permalink/stream pages), otherwise 0.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data", "cooltweets");
const htmlDir = join(outDir, "html");
mkdirSync(htmlDir, { recursive: true });

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const USER = argVal("--user");
if (!USER) {
  console.error("usage: node scripts/scrape-wayback-twitter.mjs --user <name> [--cdx-extra f] [--parse-only]");
  process.exit(1);
}
const LOWER = USER.toLowerCase();
const parseOnly = args.includes("--parse-only");
const maxStatus = argVal("--max-status") != null ? Number(argVal("--max-status")) : Infinity;
const daily = args.includes("--daily");
const profilesOnly = args.includes("--profiles-only");

const SNOWFLAKE_EPOCH = 1288834974657n;
const SNOWFLAKE_MIN = 30000000000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- shared text helpers ---------------- */

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
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

// innerHTML of a tweet-text node (any legacy era) -> plain text
function tweetText(html) {
  let s = html
    .replace(/<a[^>]*class="[^"]*u-hidden[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
    .replace(/<a[^>]*data-expanded-url="([^"]+)"[^>]*>[\s\S]*?<\/a>/g, (_, url) => url)
    .replace(/<img[^>]+>/g, (tag) =>
      /class="[^"]*Emoji/.test(tag) ? (tag.match(/alt="([^"]*)"/) || [])[1] || "" : ""
    )
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s).replace(/[ \t]+\n/g, "\n").replace(/\s+/g, (m) => (m.includes("\n") ? "\n" : " ")).trim();
}

function attr(s, name) {
  const m = s.match(new RegExp(`${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
}

function snowflakeTs(id) {
  const big = BigInt(id);
  return big >= SNOWFLAKE_MIN ? Number(((big >> 22n) + SNOWFLAKE_EPOCH) / 1000n) : null;
}

// wall-clock time in a named zone -> UTC seconds (two-pass DST correction)
function zonedToUtc(y, mo, d, h, mi, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const want = Date.UTC(y, mo, d, h, mi) / 1000;
  let ts = want;
  for (let i = 0; i < 2; i++) {
    const p = fmt.formatToParts(new Date(ts * 1000));
    const g = (t) => Number(p.find((x) => x.type === t).value);
    ts += want - Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) / 1000;
  }
  return ts;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Pre-snowflake captures whose markup has no ISO timestamp render tweet
// times as wall-clock text. Formats seen (offsets verified against captures
// that also carry ISO/snowflake twins):
//   "09:25 AM April 04, 2007"  2006-07 table markup, US Eastern (-4:00 exact)
//   "5:31 AM Sep 17th"         2009-10 logged-out pages, US Pacific (-7:00
//                              exact; Twitter's old default account timezone)
//   "about 4 hours ago"        relative to the capture moment
function parseRenderedTime(txt, captureTs, tz) {
  txt = decodeEntities(txt).trim();
  const rel = txt.match(/^(?:about |less than |over )?(a|an|half a|\d+) (second|minute|hour|day)s? ago$/i);
  if (rel) {
    if (!captureTs) return null;
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : rel[1] === "half a" ? 0.5 : 1;
    return Math.round(captureTs - n * { second: 1, minute: 60, hour: 3600, day: 86400 }[rel[2].toLowerCase()]);
  }
  const m = txt.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$/i);
  if (!m) return null;
  const mon = MONTHS[m[4].toLowerCase().slice(0, 3)];
  if (mon == null) return null;
  const h = (Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
  const day = Number(m[5]);
  const min = Number(m[2]);
  const year = m[6] ? Number(m[6]) : new Date((captureTs ?? Date.now() / 1000) * 1000).getUTCFullYear();
  let ts = zonedToUtc(year, mon, day, h, min, tz);
  // year-less dates belong to the year of the capture unless that lands in
  // the capture's future — then it's the previous year
  if (!m[6] && captureTs && ts > captureTs + 86400) ts = zonedToUtc(year - 1, mon, day, h, min, tz);
  return ts;
}

function makeTweet(id, ts, text, extra = {}) {
  return {
    id,
    user: USER,
    ts,
    day: dayFmt.format(new Date(ts * 1000)),
    text,
    retweets: extra.retweets || 0,
    likes: extra.likes || 0,
    ...(extra.media?.length ? { media: extra.media } : {}),
  };
}

/* ---------------- era parsers ----------------
 * Each returns [{id, ts, text, retweets, likes, media?, isRT?, foreign?}] —
 * `foreign` marks another user's tweet (conversation context) to be dropped,
 * `isRT` marks the owner retweeting someone else (kept, prefixed "RT @").
 */

// 2006-2011 markup: profile timelines and single-status pages
function parseOldEra(html, captureTs) {
  const out = [];
  const re = /id="status_(\d+)"([\s\S]*?)(?=id="status_\d+"|<\/(?:table|ol|body)>|$)/g;
  for (const m of html.matchAll(re)) {
    const [, id, block] = m;
    if (/class="status_actions"/.test(m[0]) && !/entry-content/.test(block)) continue;
    const textM = block.match(/<span class="entry-content">([\s\S]*?)<\/span>/);
    let text;
    if (textM) {
      text = tweetText(textM[1]);
    } else {
      // 2006-2007 table markup: bare tweet text in the <td>, before the meta span
      const td = block.match(/<td>([\s\S]*?)<span class="meta">/);
      if (!td) continue;
      text = tweetText(td[1]);
    }
    let ts = snowflakeTs(id);
    if (ts == null) {
      const iso = block.match(/class="published"[^>]*title="([^"]+)"/);
      if (iso) ts = Math.floor(Date.parse(iso[1]) / 1000);
    }
    if (ts == null) {
      // no ISO title: rendered wall-clock text (see parseRenderedTime)
      const pub = block.match(/<span class="published">([^<]+)<\/span>/);
      const meta = block.match(/<span class="meta">[\s\S]*?statuses\/\d+"[^>]*>([^<]+)<\/a>/);
      if (pub) ts = parseRenderedTime(pub[1], captureTs, "America/Los_Angeles");
      else if (meta) ts = parseRenderedTime(meta[1], captureTs, "America/New_York");
    }
    if (ts == null || Number.isNaN(ts)) continue;
    // old-era pages only ever show the owner's own tweets
    out.push({ id, ts, text });
  }
  return out;
}

// 2012-2019 desktop markup: profile streams, permalink pages, and the
// JSON timeline/conversation fragments (items_html) that carry the same markup
function parseStreamEra(html, { isPermalink, ajaxFragment }) {
  const out = [];
  const starts = [...html.matchAll(
    /<(?:div|li)[^>]*class="[^"]*(?:js-stream-tweet|permalink-tweet|tweet js-actionable-tweet)[^"]*"/g
  )].map((m) => m.index);
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? starts[i] + 40000);
    const head = block.slice(0, block.indexOf(">"));
    const id = attr(head, "data-tweet-id") || attr(head, "data-item-id");
    if (!id || !/^\d+$/.test(id)) continue;
    const author = (attr(head, "data-screen-name") || "").toLowerCase();
    const retweeter = (attr(head, "data-retweeter") || "").toLowerCase();
    const retweetedByOwner =
      retweeter === LOWER || new RegExp(`js-retweet-text[\\s\\S]{0,300}?@?${LOWER}\\b`, "i").test(block);
    const isRT = author && author !== LOWER && retweetedByOwner;
    if (author && author !== LOWER && !isRT) {
      // permalink pages show strangers' thread context; with_replies and
      // conversation fragments splice in other people's replies inline;
      // profile streams before data-retweeter only showed foreign tweets
      // as retweets
      if (isPermalink || ajaxFragment) continue;
    }
    const textM = block.match(/<p[^>]*class="[^"]*tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (!textM) continue;
    const timeM = block.match(/data-time="(\d+)"/);
    const ts = snowflakeTs(id) ?? (timeM ? Number(timeM[1]) : null);
    if (ts == null) continue;
    const stat = (kind) => {
      const m1 = block.match(
        new RegExp(`ProfileTweet-action--${kind}[\\s\\S]{0,600}?data-tweet-stat-count="(\\d+)"`)
      );
      if (m1) return Number(m1[1]);
      const m2 = block.match(new RegExp(`js-stat-${kind}s[\\s\\S]{0,200}?<strong>([\\d,]+)`));
      return m2 ? Number(m2[1].replace(/,/g, "")) : 0;
    };
    const media = isRT
      ? []
      : [...new Set([...block.matchAll(/data-image-url="([^"]+)"/g)].map((m) => m[1]))].map(
          (url) => ({ type: "photo", url })
        );
    let text = tweetText(textM[1]);
    // GIF/video tweets in card-era markup have only a hidden pic link and
    // no data-image-url; keep the visible link over an empty tweet
    if (!text && !media.length) {
      const pic = textM[1].match(/>\s*(pic\.twitter\.com\/\w+)\s*</);
      if (pic) text = pic[1];
    }
    out.push({
      id,
      ts,
      text: (isRT ? `RT @${attr(head, "data-screen-name")}: ` : "") + text,
      retweets: stat("retweet"),
      likes: stat("favorite"),
      media,
      isRT,
    });
  }
  return out;
}

// 2013-2015 mobile.twitter.com markup
function parseMobileEra(html) {
  const out = [];
  const starts = [...html.matchAll(/<table class="tweet[^"]*"/g)].map((m) => m.index);
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? starts[i] + 20000);
    const idM = block.match(/data-id="(\d+)"/) || block.match(/\/status(?:es)?\/(\d+)/);
    if (!idM) continue;
    const id = idM[1];
    const author = (block.match(/class="username[^"]*">[\s\S]{0,80}?@?<\/span>(\w+)/) ||
      block.match(/href="\/(\w+)\/status/) || [])[1];
    const textM = block.match(/<div class="tweet-text"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) ||
      block.match(/<div class="tweet-text"[^>]*>([\s\S]*?)<\/div>/);
    if (!textM) continue;
    const ts = snowflakeTs(id);
    if (ts == null) continue;
    const isRT = /tweet-social-context/.test(block) && author && author.toLowerCase() !== LOWER;
    if (author && author.toLowerCase() !== LOWER && !isRT) continue;
    out.push({ id, ts, text: (isRT ? `RT @${author}: ` : "") + tweetText(textM[1]), isRT });
  }
  return out;
}

// 2020+ React shell: only og: meta tags carry content
function parseReactEra(html, urlId) {
  const og = (prop) => {
    const m =
      html.match(new RegExp(`<meta\\s+property="og:${prop}"\\s+content="([\\s\\S]*?)"\\s*/?>`)) ||
      html.match(new RegExp(`<meta\\s+content="([\\s\\S]*?)"\\s+property="og:${prop}"\\s*/?>`));
    return m ? decodeEntities(m[1]) : null;
  };
  let text = og("description");
  if (!text || !urlId) return [];
  text = text.replace(/^[“"]/, "").replace(/[”"]$/, "").trim();
  if (!text) return [];
  const ts = snowflakeTs(urlId);
  if (ts == null) return [];
  const img = og("image");
  const media =
    img && /\/media\//.test(img)
      ? [{ type: "photo", url: img.replace(/:(large|small|medium|orig)$/, "").replace(/\?.*$/, "") }]
      : [];
  return [{ id: urlId, ts, text, media }];
}

// favstar.fm: <div class='fs-tweet' data-model='{json}'>
function parseFavstar(html) {
  const out = [];
  for (const m of html.matchAll(/data-model='([^']+)'/g)) {
    let model;
    try {
      model = JSON.parse(decodeEntities(m[1]));
    } catch {
      continue;
    }
    if (!model.tweet_id || (model.screen_name || "").toLowerCase() !== LOWER) continue;
    const ts =
      snowflakeTs(model.tweet_id) ??
      (model.created_at ? Math.floor(Date.parse(model.created_at) / 1000) : null);
    if (ts == null || Number.isNaN(ts)) continue;
    out.push({ id: model.tweet_id, ts, text: tweetText(decodeEntities(model.text || "")) });
  }
  return out;
}

// old-Twitter infinite-scroll AJAX: timeline/tweets, timeline/with_replies,
// media_timeline and i/<user>/conversation all return JSON whose items_html
// holds the ordinary 2012-2019 stream markup (JSON.parse handles the \" \/ \n
// escaping). A single capture can carry a window of ~20 older tweets, so these
// reach years Wayback never captured as standalone profile pages.
function parseAjaxFragment(html) {
  let j;
  try {
    j = JSON.parse(html);
  } catch {
    return null;
  }
  const items =
    j.items_html ||
    j.descendants?.items_html ||
    Object.values(j).find((v) => typeof v === "string" && /data-tweet-id="/.test(v));
  if (typeof items !== "string" || !/data-tweet-id="/.test(items)) return [];
  return parseStreamEra(items, { isPermalink: false, ajaxFragment: true });
}

function parseAny(html, { urlId, isPermalink, host, captureTs }) {
  if (html.trimStart().startsWith("{")) {
    const ajax = parseAjaxFragment(html);
    if (ajax) return ajax;
  }
  if (host === "favstar.fm") return parseFavstar(html);
  if (host === "mobile.twitter.com" && /<table class="tweet/.test(html)) return parseMobileEra(html);
  if (/id="status_\d+"/.test(html)) return parseOldEra(html, captureTs);
  if (/data-tweet-id="/.test(html)) return parseStreamEra(html, { isPermalink });
  return parseReactEra(html, urlId);
}

// 14-digit Wayback capture timestamp -> UTC seconds
const captureUtc = (t) =>
  Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14)) / 1000;

/* ---------------- CDX enumeration ---------------- */

async function fetchRetry(url, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120000) });
      if (res.ok) return res;
      if (res.status === 404) return null;
      if (i >= tries - 1) throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (i >= tries - 1) throw err;
    }
    const wait = 3000 * 2 ** i;
    console.log(`  retrying in ${wait / 1000}s ...`);
    await sleep(wait);
  }
}

async function cdx(query) {
  const url =
    `https://web.archive.org/cdx/search/cdx?${query}` +
    `&fl=timestamp,original,statuscode,length&filter=statuscode:200`;
  const res = await fetchRetry(url);
  if (!res) return [];
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error(`CDX returned HTML for ${query}`);
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [timestamp, original, , length] = l.split(" ");
      return { timestamp, original, len: Number(length) || 0 };
    });
}

// keep only captures that really belong to this user
function isOurs(original) {
  try {
    const u = new URL(original);
    const path = decodeURIComponent(u.pathname);
    if (u.hostname.endsWith("favstar.fm")) return new RegExp(`^/users/${LOWER}(/|$)`, "i").test(path);
    // old-Twitter AJAX timeline / conversation endpoints for this user
    if (new RegExp(`^/i/profiles/show/${LOWER}/`, "i").test(path)) return true;
    if (new RegExp(`^/i/${LOWER}/conversation/`, "i").test(path)) return true;
    return new RegExp(`^/${LOWER}([/?]|$)`, "i").test(path);
  } catch {
    return false;
  }
}

function classify(original) {
  const u = new URL(original);
  const host = u.hostname.replace(/^www\./, "").replace(":80", "");
  const path = decodeURIComponent(u.pathname).replace(/\/+$/, "");
  const statusM = path.match(/^\/[^/]+\/status(?:es)?\/(\d+)$/i);
  if (statusM) return { kind: "status", id: statusM[1], host };
  if (new RegExp(`^/${LOWER}$`, "i").test(path) || new RegExp(`^/users/${LOWER}$`, "i").test(path))
    return { kind: "profile", host };
  // JSON timeline/conversation fragments parse like extra profile pages
  if (/^\/i\/profiles\/show\//i.test(path) || /^\/i\/[^/]+\/conversation\//i.test(path))
    return { kind: "profile", host, ajax: true };
  return { kind: "other", host };
}

/* ---------------- capture download ---------------- */

function cacheName(timestamp, original) {
  let slug = original.replace(/[^A-Za-z0-9_.-]+/g, "_");
  // AJAX conversation URLs carry ~300-char max_position params; keep the
  // filename under the 255-byte limit by hashing the tail
  if (slug.length > 180) {
    const hash = createHash("sha1").update(original).digest("hex").slice(0, 12);
    slug = `${slug.slice(0, 160)}_${hash}`;
  }
  return join(htmlDir, `${timestamp}_${slug}.html`);
}

let lastFetch = 0;
async function getCapture(cap) {
  const file = cacheName(cap.timestamp, cap.original);
  if (existsSync(file)) return readFileSync(file, "utf8");
  if (parseOnly) return null;
  const wait = lastFetch + 350 - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  try {
    const res = await fetchRetry(`https://web.archive.org/web/${cap.timestamp}id_/${cap.original}`, 4);
    if (!res) return null;
    const html = await res.text();
    writeFileSync(file, html);
    return html;
  } catch (err) {
    console.log(`  FAILED ${cap.timestamp} ${cap.original}: ${err.message}`);
    return null;
  }
}

/* ---------------- main ---------------- */

console.log(`enumerating Wayback captures for @${USER} ...`);
const captures = [];
if (!parseOnly) {
  const profileCollapse = daily ? "collapse=timestamp:8" : "collapse=digest";
  captures.push(...(await cdx(`url=twitter.com/${USER}&${profileCollapse}`)));
  captures.push(...(await cdx(`url=mobile.twitter.com/${USER}&${profileCollapse}`)));
  if (!profilesOnly) {
    captures.push(...(await cdx(`url=twitter.com/${USER}/status*`)));
    captures.push(...(await cdx(`url=mobile.twitter.com/${USER}/status*`)));
    captures.push(...(await cdx(`url=favstar.fm/users/${USER}*`)));
    // old-Twitter infinite-scroll AJAX endpoints: each capture holds a JSON
    // window of ~20 tweets, often reaching years with no standalone captures
    captures.push(...(await cdx(`url=twitter.com/i/profiles/show/${USER}/timeline/tweets*`)));
    captures.push(...(await cdx(`url=twitter.com/i/profiles/show/${USER}/timeline/with_replies*`)));
    captures.push(...(await cdx(`url=twitter.com/i/profiles/show/${USER}/media_timeline*`)));
    captures.push(...(await cdx(`url=twitter.com/i/${USER}/conversation*`)));
  }
}
const extraFile = argVal("--cdx-extra");
if (extraFile) {
  for (const line of readFileSync(extraFile, "utf8").trim().split("\n")) {
    const m = line.match(/(\d{14})[^\d]+(https?:\/\/[^\s"',\]]+)/);
    if (m) captures.push({ timestamp: m[1], original: m[2], len: 0 });
  }
}
if (parseOnly) {
  // rebuild the capture list from the cache dir
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(htmlDir)) {
    const m = f.match(/^(\d{14})_(https?_.+)\.html$/);
    if (!m) continue;
    const original = m[2].replace(/^(https?)_+/, "$1://").replace(/_80_/, "/").replace(/_/g, "/");
    captures.push({ timestamp: m[1], original, len: 0, fromCache: true });
  }
}

const seen = new Set();
const profileCaps = [];
const statusCaps = new Map(); // id -> [captures]
for (const cap of captures) {
  // ":80" variants are the same resource and would split the cache
  cap.original = cap.original.replace(/^(https?:\/\/[^/]*):80(\/|$)/, "$1$2");
  if (!isOurs(cap.original)) continue;
  const key = `${cap.timestamp} ${cap.original}`;
  if (seen.has(key)) continue;
  seen.add(key);
  let cls;
  try {
    cls = classify(cap.original);
  } catch {
    continue;
  }
  if (cls.kind === "status") {
    if (!statusCaps.has(cls.id)) statusCaps.set(cls.id, []);
    statusCaps.get(cls.id).push({ ...cap, host: cls.host });
  } else if (cls.kind === "profile") {
    profileCaps.push({ ...cap, host: cls.host });
  }
}
console.log(`${profileCaps.length} profile-page captures, ${statusCaps.size} distinct status IDs`);

const byId = new Map();
const snapshots = new Set();
let richer = 0;

function absorb(list, source) {
  let added = 0;
  for (const t of list) {
    if (t.foreign) continue;
    const cur = byId.get(t.id);
    const cand = makeTweet(t.id, t.ts, t.text, t);
    if (!cur) {
      byId.set(t.id, cand);
      added++;
      continue;
    }
    // keep the richest record: max counts, first media, and fill an empty
    // text from any capture whose text has words (legacy markup hides
    // trailing t.co anchors, leaving link-only tweets blank)
    if (cand.retweets > cur.retweets) (cur.retweets = cand.retweets), richer++;
    if (cand.likes > cur.likes) (cur.likes = cand.likes), richer++;
    if (!cur.media && cand.media) cur.media = cand.media;
    if (!cur.text && cand.text.replace(/https?:\/\/\S+/g, "").trim()) {
      cur.text = cand.text;
      richer++;
    }
  }
  return added;
}

/* profile-style pages: parse every capture */
let done = 0;
for (const cap of profileCaps.sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
  const html = await getCapture(cap);
  done++;
  if (!html) continue;
  const found = parseAny(html, { isPermalink: false, host: cap.host, captureTs: captureUtc(cap.timestamp) });
  const added = absorb(found, "profile");
  snapshots.add(`https://web.archive.org/web/${cap.timestamp}/${cap.original}`);
  if (done % 25 === 0 || added > 10)
    console.log(`  [profiles ${done}/${profileCaps.length}] ${cap.timestamp} -> ${found.length} tweets (${added} new, total ${byId.size})`);
}
console.log(`after profile pages: ${byId.size} tweets`);

/* status pages: best capture per ID, with fallback */
const LEGACY_CUTOFF = "20200600000000";
let sDone = 0;
let sMissed = [];
const idsWanted = [...statusCaps.keys()]
  .filter((id) => {
    const cur = byId.get(id);
    return !cur || (!cur.text && !cur.media); // retry blank records too
  })
  .slice(0, maxStatus);
console.log(`${idsWanted.length} status IDs not covered by timeline pages; fetching those pages ...`);
for (const id of idsWanted) {
  sDone++;
  const caps = statusCaps.get(id);
  const legacy = caps.filter((c) => c.timestamp < LEGACY_CUTOFF).sort((a, b) => b.len - a.len);
  const react = caps.filter((c) => c.timestamp >= LEGACY_CUTOFF).sort((a, b) => b.len - a.len);
  const order = [...legacy.slice(0, 2), ...react.slice(0, 3)];
  for (const cap of order) {
    const html = await getCapture(cap);
    if (!html) continue;
    const found = parseAny(html, { urlId: id, isPermalink: true, host: cap.host, captureTs: captureUtc(cap.timestamp) });
    if (!found.length) continue;
    absorb(found, "status");
    snapshots.add(`https://web.archive.org/web/${cap.timestamp}/${cap.original}`);
    const cur = byId.get(id);
    if (cur && (cur.text || cur.media)) break; // else keep trying captures
  }
  if (!byId.has(id)) sMissed.push(id);
  if (sDone % 100 === 0)
    console.log(`  [status ${sDone}/${idsWanted.length}] total ${byId.size} tweets, ${sMissed.length} unrecoverable so far`);
}

/* ---------------- write ---------------- */

const tweets = [...byId.values()].sort((a, b) => a.ts - b.ts || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
if (!tweets.length) {
  console.error("no tweets recovered");
  process.exit(1);
}
const outFile = join(outDir, `${USER}.json`);
// missed IDs ride along in the main file: merge-cooltweets.mjs reads every
// *.json in the directory as an archive, so no sidecar files
writeFileSync(
  outFile,
  JSON.stringify({ user: USER, snapshots: [...snapshots].sort(), missedStatusIds: sMissed, tweets })
);

const rts = tweets.filter((t) => /^RT @/.test(t.text)).length;
const replies = tweets.filter((t) => /^@\w/.test(t.text)).length;
const withCounts = tweets.filter((t) => t.retweets + t.likes > 0).length;
console.log(
  `\n@${USER}: ${tweets.length} tweets recovered (${tweets[0].day} .. ${tweets[tweets.length - 1].day})\n` +
    `  ${rts} RTs, ${replies} @-replies, ${withCounts} with engagement counts, ${richer} records enriched\n` +
    `  ${sMissed.length} status IDs unrecoverable${sMissed.length ? " (JS-shell-only captures)" : ""}\n` +
    `  wrote ${outFile}`
);
