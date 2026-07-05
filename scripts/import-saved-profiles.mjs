#!/usr/bin/env node
// Imports tweets from "Webpage, Complete" saves of legacy twitter.com
// profile pages (the 2018-2019 markup with js-stream-tweet nodes) into
// data/cooltweets/<user>.json — the same shape scrape-cooltweets.mjs
// produces — so merge-cooltweets.mjs can fold them into the site.
//
// Beyond the Cool Tweets shape, tweets carry real engagement counts and
// photo media when the page has them (merge-cooltweets passes them
// through). The profile header (bio, location, joined, follower counts,
// avatar image from the save's _files folder) is upserted into
// docs/data/users.json, and the avatar is copied to docs/assets/avatars/.
//
// Usage: node scripts/import-saved-profiles.mjs <saved-page.htm> [...]
//
// Only the profile owner's posts are kept: originals as-is, their
// retweets as "RT @author: ..." (merge-cooltweets filters those out of
// the site but the raw file keeps them). Other people's tweets that
// appear in conversation context are dropped.

import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctDir = join(root, "data", "cooltweets");
const usersPath = join(root, "docs", "data", "users.json");
const avatarDir = join(root, "docs", "assets", "avatars");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/import-saved-profiles.mjs <saved-page.htm> [...]");
  process.exit(1);
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => NAMED[n]);
}

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// innerHTML of a legacy tweet-text <p> -> plain text
function tweetText(html) {
  let s = html
    // media links (pic.twitter.com) are hidden in the text; media is captured separately
    .replace(/<a[^>]*class="[^"]*u-hidden[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
    // outbound links: show the expanded URL, not the t.co wrapper
    .replace(/<a[^>]*data-expanded-url="([^"]+)"[^>]*>[\s\S]*?<\/a>/g, (_, url) => url)
    .replace(/<img[^>]+>/g, (tag) =>
      /class="[^"]*Emoji/.test(tag) ? (tag.match(/alt="([^"]*)"/) || [])[1] || "" : ""
    )
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s).replace(/[ \t]+\n/g, "\n").trim();
}

function attr(s, name) {
  const m = s.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function parseJoined(title) {
  // "3:40 PM - 11 Sep 2009"
  const m = title.match(/(\d{1,2}):(\d{2}) (AM|PM) - (\d{1,2}) (\w{3}) (\d{4})/);
  if (!m) return null;
  const t = Date.parse(`${m[4]} ${m[5]} ${m[6]} ${m[1]}:${m[2]} ${m[3]} UTC`);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function navCount(html, nav) {
  const m = html.match(new RegExp(`data-nav="${nav}"[\\s\\S]{0,400}?data-count="(\\d+)"`));
  return m ? Number(m[1]) : null;
}

// a saved page's relative asset may sit next to the .htm or in a
// stray _files folder elsewhere; try both
function resolveAsset(htmPath, rel) {
  const clean = decodeURIComponent(rel).replace(/^\.\//, "");
  const candidates = [
    join(dirname(htmPath), clean),
    join(dirname(htmPath), "Twitter archives", clean),
  ];
  return candidates.find(existsSync) || null;
}

const users = JSON.parse(readFileSync(usersPath, "utf8"));

for (const file of files) {
  const html = readFileSync(file, "utf8");

  const titleMatch = html.match(/<title>(.*?) \(@(\w+)\)/);
  if (!titleMatch) {
    console.error(`${basename(file)}: not a saved twitter profile page (no "name (@user)" title), skipping`);
    continue;
  }
  const owner = titleMatch[2];
  const displayName = decodeEntities(titleMatch[1]);

  // each block runs from one js-stream-tweet opening tag to the next
  const starts = [...html.matchAll(/<div class="tweet js-stream-tweet[^"]*"/g)].map((m) => m.index);
  const byId = new Map();
  let dropped = 0;
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? html.length);
    const head = block.slice(0, block.indexOf(">"));
    const id = attr(head, "data-tweet-id");
    const author = attr(head, "data-screen-name");
    const retweeter = attr(head, "data-retweeter");
    const isRT = retweeter === owner && author !== owner;
    if (!id || byId.has(id)) continue;
    if (author !== owner && !isRT) {
      dropped++; // a stranger's tweet shown as conversation context
      continue;
    }
    const time = block.match(/data-time="(\d+)"/);
    const textM = block.match(/<p class="TweetTextSize[^"]*tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (!time || !textM) continue;
    const ts = Number(time[1]);
    const text = tweetText(textM[1]);
    const rts = block.match(/ProfileTweet-action--retweet[\s\S]{0,600}?data-tweet-stat-count="(\d+)"/);
    const favs = block.match(/ProfileTweet-action--favorite[\s\S]{0,600}?data-tweet-stat-count="(\d+)"/);
    const media = isRT
      ? []
      : [...new Set([...block.matchAll(/data-image-url="([^"]+)"/g)].map((m) => m[1]))].map(
          (url) => ({ type: "photo", url })
        );
    byId.set(id, {
      id,
      user: owner,
      ts,
      day: dayFmt.format(new Date(ts * 1000)),
      text: isRT ? `RT @${author}: ${text}` : text,
      retweets: rts ? Number(rts[1]) : 0,
      likes: favs ? Number(favs[1]) : 0,
      ...(media.length ? { media } : {}),
    });
  }

  const tweets = [...byId.values()].sort((a, b) => a.ts - b.ts);
  if (!tweets.length) {
    console.error(`${basename(file)}: no tweets found, skipping`);
    continue;
  }

  const saved = statSync(file).mtime.toISOString().slice(0, 10);
  writeFileSync(
    join(ctDir, `${owner}.json`),
    JSON.stringify({
      user: owner,
      snapshots: [`saved-profile-page:${basename(file)} (saved ${saved})`],
      tweets,
    })
  );

  // profile header -> users.json (+ era avatar from the save's assets)
  const bio = html.match(/ProfileHeaderCard-bio[^>]*>([\s\S]*?)<\/p>/);
  const loc = html.match(/ProfileHeaderCard-locationText[^>]*>([\s\S]*?)<\/span>/);
  const joinTitle = html.match(/ProfileHeaderCard-joinDateText[^>]*title="([^"]+)"/);
  let avatarPath = "";
  const avatarSrc = html.match(/ProfileAvatar-image[^>]*src="([^"]+)"/);
  if (avatarSrc) {
    const local = resolveAsset(file, avatarSrc[1]);
    if (local) {
      const dest = `${owner}${extname(local).toLowerCase() || ".jpg"}`;
      copyFileSync(local, join(avatarDir, dest));
      avatarPath = `assets/avatars/${dest}`;
    }
  }
  const entry = {
    screen_name: owner,
    name: displayName,
    description: bio ? tweetText(bio[1]) : "",
    location: loc ? decodeEntities(loc[1].replace(/<[^>]+>/g, "")).trim() : "",
    avatar: avatarPath,
    joined: joinTitle ? parseJoined(joinTitle[1]) : tweets[0].ts,
    followers: navCount(html, "followers"),
    following: navCount(html, "following"),
    statuses: navCount(html, "tweets"),
  };
  const idx = users.findIndex((u) => u.screen_name.toLowerCase() === owner.toLowerCase());
  if (idx >= 0) users[idx] = { ...users[idx], ...entry, avatar: avatarPath || users[idx].avatar };
  else users.push(entry);

  const rtCount = tweets.filter((t) => /^RT @/.test(t.text)).length;
  const withMedia = tweets.filter((t) => t.media).length;
  console.log(
    `${owner}: ${tweets.length} tweets (${tweets[0].day} .. ${tweets[tweets.length - 1].day}), ` +
      `${rtCount} RTs, ${withMedia} with photos, ${dropped} strangers' context tweets dropped, ` +
      `avatar ${avatarPath ? "copied" : "NOT found"}`
  );
}

writeFileSync(usersPath, JSON.stringify(users));
console.log("users.json updated");
