/* Weird Twitter Time Machine
 *
 * Pick a day, see the timeline exactly as it was, reply from the future.
 * Posts come from Supabase when configured in js/config.js, otherwise from
 * the static JSON bundled in data/ (with replies kept in localStorage).
 */
(function () {
  "use strict";

  const cfg = window.WTTM_CONFIG || {};
  const SB_URL = (cfg.SUPABASE_URL || "").replace(/\/$/, "");
  const SB_KEY = cfg.SUPABASE_ANON_KEY || "";
  const useSupabase = Boolean(SB_URL && SB_KEY);

  const TZ = "America/New_York";
  const REPLY_LIMIT = 140; // it's the past; you get 140 characters
  const LS_REPLIES = "wttm-replies";
  const LS_AUTHOR = "wttm-author";
  const LS_AUTOSCROLL = "wttm-autoscroll";
  const LS_LIKES = "wttm-likes-matches";
  const LS_BLOCKED = "wttm-blocked";
  const LS_PHONE = "wttm-phone-mode";

  // Twitter switched tweet IDs from small sequential integers to Snowflake
  // IDs (which encode their creation time) on 2010-11-04. Snowflake IDs
  // start in the low quadrillions and only grow from there, so 10^12 sits
  // safely in the gap between the two schemes — keep in sync with
  // scripts/build-likes-index.mjs.
  const SNOWFLAKE_MIN = 1000000000000n;
  const TWITTER_EPOCH_MS = 1288834974657n;

  const $ = (sel) => document.querySelector(sel);
  const timeline = $("#timeline");
  const dayPicker = $("#dayPicker");

  let index = null; // data/index.json
  let users = new Map(); // screen_name -> profile
  let days = []; // sorted days that have posts
  let monthsWithData = new Set(); // "YYYY-MM" prefixes that appear in index.dayCounts
  let currentDay = null;
  let currentView = "day"; // "day" | "likes" | "search"
  let lastTweets = []; // tweets currently on screen (for the time-of-day jump)
  let userFilter = null; // screen_name to isolate, or null for everyone
  let blockedUsers = loadBlocked(); // screen names you've blocked, in the order you blocked them
  let blockedLower = new Set(blockedUsers.map((n) => n.toLowerCase()));
  let searchSeq = 0; // bumps on every view change; cancels in-flight search scans
  const monthCache = new Map();
  let legacyIds = null; // data/legacy-ids.json, loaded lazily

  /* ---------- tiny utils ---------- */

  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const longFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const shortFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "numeric", month: "short", year: "2-digit" });

  // "2013-03-12" -> Date at noon UTC (safe for date-only formatting)
  const dayDate = (day) => new Date(day + "T12:00:00Z");
  const fmtNum = (n) => (n >= 1000 ? n.toLocaleString("en-US") : String(n));

  const nyDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

  const hmFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  function minuteOfDay(date) {
    const p = hmFmt.formatToParts(date);
    const get = (type) => Number(p.find((x) => x.type === type).value);
    return get("hour") * 60 + get("minute");
  }

  // today's month-day transplanted into another year (Feb 29 clamps to 28)
  function todayInYear(year) {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const get = (type) => p.find((x) => x.type === type).value;
    let mmdd = `${get("month")}-${get("day")}`;
    if (mmdd === "02-29" && (year % 4 !== 0 || (year % 100 === 0 && year % 400 !== 0))) mmdd = "02-28";
    return `${year}-${mmdd}`;
  }

  function linkify(text) {
    return esc(text)
      .replace(/(https?:\/\/[^\s<]+[^\s<.,:;!?)\]])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[^\w/])@(\w{1,20})/g, '$1<a href="https://twitter.com/$2" target="_blank" rel="noopener">@$2</a>')
      .replace(/(^|[^\w&])#(\w+)/g, '$1<a href="https://twitter.com/hashtag/$2" target="_blank" rel="noopener">#$2</a>');
  }

  const originalUrl = (t) => `https://twitter.com/${t.user}/status/${t.id}`;

  /* ---------- data layer ---------- */

  async function sbFetch(path) {
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
    return res.json();
  }

  const fromRow = (r) => ({
    id: r.id,
    user: r.screen_name,
    ts: Date.parse(r.created_at) / 1000,
    day: r.posted_day,
    text: r.text,
    retweets: r.retweet_count,
    likes: r.like_count,
    reply_to_id: r.in_reply_to_status_id,
    reply_to_user: r.in_reply_to_screen_name,
    media: r.media || [],
  });

  async function tweetsForDay(day) {
    if (useSupabase) {
      const rows = await sbFetch(`tweets?posted_day=eq.${day}&order=created_at.asc&select=*`);
      return rows.map(fromRow);
    }
    const month = day.slice(0, 7);
    if (!monthCache.has(month)) {
      const res = await fetch(`data/tweets-${month}.json`);
      monthCache.set(month, res.ok ? await res.json() : []);
    }
    return monthCache.get(month).filter((t) => t.day === day);
  }

  async function repliesFor(ids) {
    const grouped = {};
    if (!ids.length) return grouped;
    if (useSupabase) {
      const rows = await sbFetch(`replies?tweet_id=in.(${ids.join(",")})&order=created_at.asc&select=*`);
      for (const r of rows) (grouped[r.tweet_id] = grouped[r.tweet_id] || []).push(r);
    } else {
      const store = JSON.parse(localStorage.getItem(LS_REPLIES) || "{}");
      for (const id of ids) if (store[id] && store[id].length) grouped[id] = store[id];
    }
    return grouped;
  }

  async function postReply(tweetId, author, text) {
    const reply = { tweet_id: tweetId, author, text, created_at: new Date().toISOString() };
    if (useSupabase) {
      const res = await fetch(`${SB_URL}/rest/v1/replies`, {
        method: "POST",
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ tweet_id: tweetId, author, text }),
      });
      if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
      return (await res.json())[0];
    }
    const store = JSON.parse(localStorage.getItem(LS_REPLIES) || "{}");
    (store[tweetId] = store[tweetId] || []).push(reply);
    localStorage.setItem(LS_REPLIES, JSON.stringify(store));
    return reply;
  }

  /* ---------- find your likes ---------- */

  // Parses the like.js file from an X ("Download an archive of your data")
  // export: `window.YTD.like.part0 = [ { "like": { "tweetId": "..." } }, ... ]`
  function parseLikesFile(text) {
    const start = text.indexOf("[");
    if (start < 0) return [];
    let data;
    try {
      data = JSON.parse(text.slice(start));
    } catch {
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) => (entry && entry.like ? entry.like.tweetId : entry && entry.tweetId) || null)
      .filter(Boolean)
      .map(String);
  }

  // Snowflake IDs encode their creation time: the top bits (after the low
  // 22 sequence/machine bits) are milliseconds since the Twitter epoch.
  // This works for ANY Snowflake-era tweet ID, not just ones in our
  // archive — it just tells us which day (and thus which tweets-*.json
  // file) to check for a match.
  function snowflakeDay(idStr) {
    try {
      const ms = Number((BigInt(idStr) >> 22n) + TWITTER_EPOCH_MS);
      return nyDayFmt.format(new Date(ms));
    } catch {
      return null;
    }
  }

  async function loadLegacyIds() {
    if (!legacyIds) {
      try {
        const res = await fetch("data/legacy-ids.json");
        legacyIds = res.ok ? await res.json() : {};
      } catch {
        legacyIds = {};
      }
    }
    return legacyIds;
  }

  async function monthTweets(month) {
    if (!monthCache.has(month)) {
      const res = await fetch(`data/tweets-${month}.json`);
      monthCache.set(month, res.ok ? await res.json() : []);
    }
    return monthCache.get(month);
  }

  async function matchLikesStatic(ids, onProgress) {
    const legacy = await loadLegacyIds();
    const byMonth = new Map(); // "YYYY-MM" -> Set of candidate ids that might land in that month

    for (const id of ids) {
      const day = /^\d+$/.test(id) && BigInt(id) < SNOWFLAKE_MIN ? legacy[id] : snowflakeDay(id);
      if (!day) continue; // pre-Snowflake id we don't recognize, or unparseable
      const month = day.slice(0, 7);
      if (!monthsWithData.has(month)) continue;
      if (!byMonth.has(month)) byMonth.set(month, new Set());
      byMonth.get(month).add(id);
    }

    const months = [...byMonth.keys()];
    const results = [];
    let done = 0;
    let cursor = 0;
    async function worker() {
      while (cursor < months.length) {
        const month = months[cursor++];
        let tweets = [];
        try {
          tweets = await monthTweets(month);
        } catch {
          /* skip months that fail to load */
        }
        const wanted = byMonth.get(month);
        for (const t of tweets) if (wanted.has(t.id)) results.push(t);
        done++;
        if (onProgress) onProgress(done, months.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, months.length) }, worker));
    return results;
  }

  async function matchLikesSupabase(ids, onProgress) {
    const CHUNK = 150;
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    const results = [];
    let done = 0;
    for (const chunk of chunks) {
      try {
        results.push(...(await sbFetch(`tweets?id=in.(${chunk.join(",")})&select=*`)).map(fromRow));
      } catch {
        /* skip failed chunk */
      }
      done++;
      if (onProgress) onProgress(done, chunks.length);
    }
    return results;
  }

  function matchLikes(ids, onProgress) {
    return useSupabase ? matchLikesSupabase(ids, onProgress) : matchLikesStatic(ids, onProgress);
  }

  function saveLikesMatches(totalLikes, matches) {
    const compact = matches.map((t) => ({ id: t.id, day: t.day }));
    localStorage.setItem(LS_LIKES, JSON.stringify({ totalLikes, matches: compact }));
  }

  function loadLikesMatches() {
    try {
      return JSON.parse(localStorage.getItem(LS_LIKES) || "null");
    } catch {
      return null;
    }
  }

  async function renderLikes() {
    searchSeq++;
    currentView = "likes";
    setActiveNav();
    document.title = "Your Recovered Likes — Weird Twitter Time Machine";
    timeline.innerHTML = `<div class="state-box">looking through your likes…</div>`;
    document.querySelectorAll("#yearList a").forEach((a) => a.classList.remove("active"));

    const cached = loadLikesMatches();
    if (!cached || !cached.matches.length) {
      timeline.innerHTML = `<div class="state-box">No recovered likes yet. Upload your <code>like.js</code> file in the "Find Your Likes" panel to get started.</div>`;
      $("#dayCount").textContent = "";
      return;
    }
    $("#dayCount").textContent = `${cached.matches.length} of your ${cached.totalLikes.toLocaleString()} likes found in this archive.`;

    let tweets;
    if (useSupabase) {
      const rows = await sbFetch(`tweets?id=in.(${cached.matches.map((m) => m.id).join(",")})&select=*`);
      tweets = rows.map(fromRow);
    } else {
      const months = [...new Set(cached.matches.map((m) => m.day.slice(0, 7)))];
      await Promise.all(months.map(monthTweets));
      const wanted = new Set(cached.matches.map((m) => m.id));
      tweets = months.flatMap((m) => monthCache.get(m) || []).filter((t) => wanted.has(t.id));
    }

    if (location.hash !== "#/likes") return; // user navigated away mid-load

    tweets.sort((a, b) => b.ts - a.ts);
    lastTweets = tweets;
    updatePhoneFrame();
    let replies = {};
    try {
      replies = await repliesFor(tweets.map((t) => t.id));
    } catch {
      /* replies are decoration; the timeline must still render */
    }
    timeline.innerHTML =
      `<div class="state-box likes-back"><a href="#/${esc(goldenRandomDay())}">← back to the time machine</a></div>` +
      tweets.map((t) => tweetHtml(t, replies[t.id], { dayLink: true })).join("");
    applyUserFilter();
  }

  /* ---------- block list ---------- */

  function loadBlocked() {
    try {
      const list = JSON.parse(localStorage.getItem(LS_BLOCKED) || "[]");
      return Array.isArray(list) ? list.filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
  }

  function saveBlocked() {
    localStorage.setItem(LS_BLOCKED, JSON.stringify(blockedUsers));
    blockedLower = new Set(blockedUsers.map((n) => n.toLowerCase()));
  }

  function blockUser(screenName) {
    if (!blockedLower.has(screenName.toLowerCase())) {
      blockedUsers.push(screenName);
      saveBlocked();
    }
    if (userFilter && userFilter.toLowerCase() === screenName.toLowerCase()) userFilter = null;
    applyUserFilter();
  }

  function unblockUser(screenName) {
    blockedUsers = blockedUsers.filter((n) => n.toLowerCase() !== screenName.toLowerCase());
    saveBlocked();
  }

  function renderBlocked() {
    searchSeq++;
    currentView = "blocked";
    setActiveNav();
    document.title = "Blocked Accounts — Weird Twitter Time Machine";
    document.querySelectorAll("#yearList a").forEach((a) => a.classList.remove("active"));
    $("#dayCount").textContent = blockedUsers.length
      ? `${blockedUsers.length} account${blockedUsers.length === 1 ? "" : "s"} blocked.`
      : "";

    const back = `<div class="state-box likes-back"><a href="#/${esc(currentDay || goldenRandomDay())}">← back to the time machine</a></div>`;
    if (!blockedUsers.length) {
      timeline.innerHTML = back + `<div class="state-box">You haven't blocked anyone. Hover over a name in the timeline and click Block to hide an account's posts.</div>`;
      return;
    }
    timeline.innerHTML =
      back +
      blockedUsers
        .map((name) => {
          const u = users.get(name) || { name, avatar: "" };
          return `
            <div class="blocked-row" data-user="${esc(name)}">
              <img class="avatar" src="${esc(u.avatar || "assets/egg.svg")}" alt="">
              <div class="blocked-who">
                <span class="fullname">${esc(u.name)}</span>
                <span class="username">@${esc(name)}</span>
              </div>
              <button type="button" class="bl-unblock">Unblock</button>
            </div>`;
        })
        .join("");
  }

  /* ---------- search ---------- */

  const SEARCH_CAP = 200;

  // "from:user" isolates an account; everything else is a substring match
  function parseQuery(q) {
    const terms = [];
    let from = null;
    for (const tok of q.trim().split(/\s+/)) {
      const m = tok.match(/^from:@?(\w{1,20})$/i);
      if (m) from = m[1].toLowerCase();
      else if (tok) terms.push(tok.toLowerCase());
    }
    return { from, text: terms.join(" ") };
  }

  async function renderSearch(q) {
    const seq = ++searchSeq;
    currentView = "search";
    setActiveNav();
    document.title = `${q} — Search — Weird Twitter Time Machine`;
    $("#topSearch").value = q;
    document.querySelectorAll("#yearList a").forEach((a) => a.classList.remove("active"));
    $("#dayCount").textContent = "";

    const { from, text } = parseQuery(q);
    if (!from && !text) {
      timeline.innerHTML = `<div class="state-box">Type a word to search for — or <code>from:username</code> to see one account.</div>`;
      return;
    }

    timeline.innerHTML = `
      <div class="state-box search-status" id="searchStatus"></div>
      <div id="searchResults"></div>`;
    const statusEl = $("#searchStatus");
    const resultsEl = $("#searchResults");
    const matches = [];
    const matchTweet = (t) =>
      (!from || t.user.toLowerCase() === from) && (!text || t.text.toLowerCase().includes(text));
    const addResults = (found) => {
      matches.push(...found);
      if (found.length) {
        resultsEl.insertAdjacentHTML("beforeend", found.map((t) => tweetHtml(t, null, { dayLink: true })).join(""));
        applyUserFilter();
      }
    };

    if (useSupabase) {
      statusEl.textContent = "searching…";
      const params = [];
      // PostgREST "reserved character" quoting: wrap the pattern in double quotes
      if (text) params.push(`text=ilike."*${encodeURIComponent(text.replace(/"/g, ""))}*"`);
      if (from) params.push(`screen_name=ilike.${encodeURIComponent(from)}`);
      try {
        const rows = await sbFetch(`tweets?${params.join("&")}&order=created_at.desc&limit=${SEARCH_CAP}`);
        if (seq !== searchSeq) return;
        addResults(rows.map(fromRow));
        statusEl.textContent = matches.length
          ? `${matches.length}${matches.length === SEARCH_CAP ? "+" : ""} matches`
          : `nothing in the archive matches "${q}"`;
      } catch (err) {
        statusEl.textContent = `search failed (${err.message})`;
      }
      lastTweets = matches;
      updatePhoneFrame();
      return;
    }

    // static mode: stream through the month files, newest first
    const months = [...monthsWithData].sort().reverse();
    let stopped = false;
    statusEl.innerHTML = `<span id="searchProgress">searching…</span> <button id="searchStop" class="search-stop">Stop</button>`;
    $("#searchStop").addEventListener("click", () => { stopped = true; });

    let lastMonth = "";
    for (let i = 0; i < months.length; i++) {
      if (seq !== searchSeq) return; // user moved on; a newer view owns the timeline
      if (stopped || matches.length >= SEARCH_CAP) break;
      lastMonth = months[i];
      let tweets = [];
      try {
        tweets = await monthTweets(lastMonth);
      } catch {
        /* skip months that fail to load */
      }
      if (seq !== searchSeq) return;
      const found = tweets.filter(matchTweet).sort((a, b) => b.ts - a.ts);
      addResults(found.slice(0, SEARCH_CAP - matches.length));
      const progress = $("#searchProgress");
      if (progress) progress.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"} · searched back to ${lastMonth} (${i + 1}/${months.length} months)`;
    }
    if (seq !== searchSeq) return;
    statusEl.textContent = !matches.length
      ? `nothing in the archive matches "${q}"`
      : matches.length >= SEARCH_CAP
        ? `first ${SEARCH_CAP} matches, newest first (stopped at ${lastMonth})`
        : stopped
          ? `${matches.length} matches · stopped at ${lastMonth}`
          : `${matches.length} matches across the whole archive`;
    lastTweets = matches;
    updatePhoneFrame();
  }

  /* ---------- navigation ---------- */

  function setActiveNav() {
    $("#navHome").classList.toggle("active", currentView !== "blocked");
    $("#navBlocked").classList.toggle("active", currentView === "blocked");
  }

  function dayFromHash() {
    const m = location.hash.match(/^#\/(\d{4}-\d{2}-\d{2})$/);
    return m ? m[1] : null;
  }

  function searchFromHash() {
    const m = location.hash.match(/^#\/search\/(.*)$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function goldenRandomDay() {
    const golden = days.filter((d) => d >= "2011-01-01" && d <= "2015-12-31" && index.dayCounts[d] >= 8);
    const pool = golden.length ? golden : days;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function neighborDay(day, dir) {
    // nearest day with posts, strictly before (dir=-1) or after (dir=+1)
    if (dir < 0) {
      for (let i = days.length - 1; i >= 0; i--) if (days[i] < day) return days[i];
    } else {
      for (let i = 0; i < days.length; i++) if (days[i] > day) return days[i];
    }
    return null;
  }

  function setDay(day, pushHash = true) {
    if (!day) return;
    currentDay = day;
    if (pushHash && dayFromHash() !== day) location.hash = `#/${day}`;
    dayPicker.value = day;
    render();
  }

  /* ---------- rendering ---------- */

  function renderYears() {
    $("#yearList").innerHTML = index.years
      .map((y) => `<li><a href="#/${todayInYear(Number(y))}" data-year="${esc(y)}">${esc(y)}</a></li>`)
      .join("");
  }

  function scrollToNow() {
    if (!lastTweets.length) return;
    const nowMin = minuteOfDay(new Date());
    let best = null;
    for (const t of lastTweets) {
      const diff = Math.abs(minuteOfDay(new Date(t.ts * 1000)) - nowMin);
      if (!best || diff < best.diff) best = { id: t.id, diff };
    }
    const el = timeline.querySelector(`[data-id="${CSS.escape(best.id)}"]`);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // hide blocked accounts, plus every tweet that isn't by userFilter
  // when one is set; label the stream header
  function applyUserFilter() {
    const tweetsEls = timeline.querySelectorAll(".tweet");
    let visible = 0;
    tweetsEls.forEach((el) => {
      const hide =
        blockedLower.has(el.dataset.user.toLowerCase()) ||
        (Boolean(userFilter) && el.dataset.user !== userFilter);
      el.classList.toggle("filtered-out", hide);
      if (!hide) visible++;
    });

    $("#streamFilter").innerHTML = userFilter
      ? `only <b>@${esc(userFilter)}</b> · <a href="#" id="clearFilter">show everyone</a>`
      : "";

    let note = timeline.querySelector(".filter-empty");
    const noteHtml = !visible && tweetsEls.length
      ? userFilter
        ? `@${esc(userFilter)} has no posts here.`
        : `Everything here is from <a href="#/blocked">accounts you've blocked</a>.`
      : "";
    if (noteHtml) {
      if (!note) {
        note = document.createElement("div");
        note.className = "state-box filter-empty";
        timeline.prepend(note);
      }
      note.innerHTML = noteHtml;
    } else if (note) {
      note.remove();
    }
  }

  function toggleUserFilter(screenName) {
    userFilter = userFilter === screenName ? null : screenName;
    applyUserFilter();
  }

  /* ---------- phone mode ---------- */

  // year -> [model name, chassis generation]; the frame CSS keys off ph-<gen>
  const PHONE_MODELS = [
    [2007, "iPhone", "2007"],
    [2008, "iPhone 3G", "3g"],
    [2009, "iPhone 3GS", "3g"],
    [2010, "iPhone 4", "4"],
    [2011, "iPhone 4S", "4"],
    [2012, "iPhone 5", "5"],
    [2013, "iPhone 5s", "5s"],
    [2014, "iPhone 6", "6"],
    [2015, "iPhone 6s", "6s"],
    [2016, "iPhone 7", "7"],
    [2017, "iPhone X", "x"],
    [2018, "iPhone XS", "x"],
    [2019, "iPhone 11", "x"],
    [2020, "iPhone 12", "12"],
    [2021, "iPhone 13", "12"],
    [2022, "iPhone 14 Pro", "14"],
    [2023, "iPhone 15 Pro", "14"],
  ];

  function phoneModelForYear(year) {
    return PHONE_MODELS.find(([y]) => year <= y) || PHONE_MODELS[PHONE_MODELS.length - 1];
  }

  // iOS 7 (2013) flattened the status bar
  const IOS_CLASSIC_GENS = new Set(["2007", "3g", "4", "5"]);

  function updatePhoneFrame() {
    const on = $("#phoneMode").checked;
    document.body.classList.toggle("phone-mode", on);
    const frame = $("#phoneFrame");
    if (!on) {
      frame.className = "phone-frame"; // drop the ph-* chassis so the chrome hides
      return;
    }
    const day =
      (currentView === "day" ? currentDay : lastTweets[0] && lastTweets[0].day) ||
      currentDay ||
      "2012-06-15";
    const year = Number(day.slice(0, 4));
    const [, name, gen] = phoneModelForYear(year);
    frame.className = `phone-frame ph-${gen} ${IOS_CLASSIC_GENS.has(gen) ? "ios-classic" : "ios-flat"}`;
    $("#phoneCaption").textContent = `${name} · ${year}`;
  }

  function renderSidebar(dayTweets) {
    const count = index.dayCounts[currentDay] || dayTweets.length;
    const voices = new Set(dayTweets.map((t) => t.user)).size;
    $("#dayCount").textContent = count
      ? `${count} post${count === 1 ? "" : "s"} by ${voices} account${voices === 1 ? "" : "s"} on this day.`
      : "the timeline is quiet on this day.";
    $("#dataMode").textContent = useSupabase
      ? "posts + replies served from Supabase"
      : "static archive mode — replies are saved in this browser only";

    const year = currentDay.slice(0, 4);
    document.querySelectorAll("#yearList a").forEach((a) => {
      a.classList.toggle("active", a.dataset.year === year);
    });

    const tags = [...new Set(dayTweets.flatMap((t) => (t.text.match(/#\w+/g) || [])))].slice(0, 6);
    const canned = ["#TeamFollowBack", "Corn", "The Economy", "#FF", "Doritos", "girther movement"];
    $("#trendList").innerHTML = (tags.length ? tags : canned)
      .map((h) => `<li>${esc(h)}</li>`)
      .join("");

    $("#pageFooter").innerHTML =
      `data from the <a href="https://github.com/codemasher/dril-archive" target="_blank" rel="noopener">dril-archive</a> ` +
      `and <a href="https://web.archive.org/web/2022/https://cooltweets.herokuapp.com/" target="_blank" rel="noopener">Cool Tweets</a> (via the Wayback Machine) · ` +
      `<a href="https://github.com/freethebikes/WeirdTwitterTimeMachine" target="_blank" rel="noopener">source</a>`;
  }

  function replyHtml(r) {
    const when = new Date(r.created_at);
    return `
      <div class="future-reply">
        <div class="fr-head"><b>${esc(r.author)}</b> · ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} <span class="fr-badge">FROM THE FUTURE</span></div>
        <div>${linkify(r.text)}</div>
      </div>`;
  }

  function tweetHtml(t, replies, opts = {}) {
    const u = users.get(t.user) || { name: t.user, avatar: "" };
    const avatar = u.avatar || "assets/egg.svg";
    const time = timeFmt.format(new Date(t.ts * 1000));
    const media = (t.media || [])
      .filter((m) => m.type === "photo")
      .map((m) => `<div class="tweet-media"><a href="${esc(originalUrl(t))}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt="" loading="lazy" onerror="this.parentNode.parentNode.remove()"></a></div>`)
      .join("");
    const ctx = t.reply_to_user
      ? `<div class="reply-context">in reply to <a href="https://twitter.com/${esc(t.reply_to_user)}/status/${esc(t.reply_to_id || "")}" target="_blank" rel="noopener">@${esc(t.reply_to_user)}</a></div>`
      : "";
    const futureReplies = (replies || []).map(replyHtml).join("");
    return `
      <article class="tweet" data-id="${esc(t.id)}" data-user="${esc(t.user)}">
        <img class="avatar" src="${esc(avatar)}" alt="">
        <div class="tweet-body">
          <div class="tweet-head">
            <span class="fullname" title="Show only @${esc(t.user)}">${esc(u.name)}</span>
            <span class="username" title="Show only @${esc(t.user)}">@${esc(t.user)}</span>
            <a href="#" class="act-block" title="Hide all posts from @${esc(t.user)}">Block</a>
            <span class="timestamp"><a href="${esc(originalUrl(t))}" target="_blank" rel="noopener" title="${esc(longFmt.format(dayDate(t.day)))} — view original on Twitter">${time}</a></span>
          </div>
          ${ctx}
          <p class="tweet-text">${linkify(t.text)}</p>
          ${media}
          ${t.retweets || t.likes ? `<div class="tweet-stats">
            <span><b>${fmtNum(t.retweets)}</b> Retweets</span>
            <span><b>${fmtNum(t.likes)}</b> <span class="star">★</span> Favorites</span>
          </div>` : ""}
          <div class="tweet-actions">
            <a href="#" class="act-reply">Reply</a>
            <a href="${esc(originalUrl(t))}" target="_blank" rel="noopener">View original ↗</a>
            ${opts.dayLink ? `<a href="#/${esc(t.day)}">Time-travel to this day</a>` : ""}
          </div>
          <div class="future-replies" ${futureReplies ? "" : "hidden"}>${futureReplies}</div>
          <div class="composer-slot"></div>
        </div>
      </article>`;
  }

  function composerHtml() {
    const author = localStorage.getItem(LS_AUTHOR) || "";
    return `
      <form class="reply-composer">
        <textarea placeholder="Reply to this post from the year ${new Date().getFullYear()}…" maxlength="280"></textarea>
        <div class="rc-row">
          <input type="text" placeholder="your name (optional)" maxlength="40" value="${esc(author)}">
          <span class="rc-count">${REPLY_LIMIT}</span>
          <button type="submit" class="rc-send" disabled>Tweet</button>
        </div>
        <div class="rc-note">Your reply is stamped with today's date. The past cannot hear you, but it will remember.</div>
      </form>`;
  }

  function attachComposer(article) {
    const slot = article.querySelector(".composer-slot");
    if (slot.firstChild) { slot.innerHTML = ""; return; } // toggle off
    slot.innerHTML = composerHtml();
    const form = slot.querySelector("form");
    const ta = form.querySelector("textarea");
    const nameInput = form.querySelector("input");
    const countEl = form.querySelector(".rc-count");
    const sendBtn = form.querySelector(".rc-send");

    ta.addEventListener("input", () => {
      const left = REPLY_LIMIT - ta.value.length;
      countEl.textContent = left;
      countEl.classList.toggle("over", left < 0);
      sendBtn.disabled = left < 0 || ta.value.trim().length === 0;
    });
    ta.focus();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      const author = nameInput.value.trim() || "time traveler";
      if (!text) return;
      sendBtn.disabled = true;
      sendBtn.textContent = "…";
      try {
        localStorage.setItem(LS_AUTHOR, nameInput.value.trim());
        const saved = await postReply(article.dataset.id, author, text);
        const list = article.querySelector(".future-replies");
        list.hidden = false;
        list.insertAdjacentHTML("beforeend", replyHtml(saved));
        slot.innerHTML = "";
      } catch (err) {
        sendBtn.disabled = false;
        sendBtn.textContent = "Tweet";
        let errEl = form.querySelector(".rc-error");
        if (!errEl) {
          errEl = document.createElement("div");
          errEl.className = "rc-error";
          form.appendChild(errEl);
        }
        errEl.textContent = `Could not send reply (${err.message}). Try again.`;
      }
    });
  }

  async function render() {
    searchSeq++;
    currentView = "day";
    setActiveNav();
    const day = currentDay;
    document.title = `${longFmt.format(dayDate(day))} — Weird Twitter Time Machine`;
    timeline.innerHTML = `<div class="state-box">loading the past…</div>`;
    let tweets;
    try {
      tweets = await tweetsForDay(day);
    } catch (err) {
      timeline.innerHTML = `<div class="state-box">Couldn't load posts (${esc(err.message)}).<br>Check your Supabase settings in js/config.js, or clear them to use the bundled archive.</div>`;
      return;
    }
    if (day !== currentDay) return; // user has moved on mid-load

    renderSidebar(tweets);
    lastTweets = tweets;
    updatePhoneFrame();

    if (!tweets.length) {
      const prev = neighborDay(currentDay, -1);
      const next = neighborDay(currentDay, +1);
      timeline.innerHTML = `
        <div class="state-box">
          It's ${esc(longFmt.format(dayDate(currentDay)))} and the timeline is quiet.
          <div class="state-links">
            ${prev ? `<a href="#/${prev}">← ${shortFmt.format(dayDate(prev))}</a>` : ""}
            ${next ? `<a href="#/${next}">${shortFmt.format(dayDate(next))} →</a>` : ""}
          </div>
        </div>`;
      return;
    }

    tweets.sort((a, b) => b.ts - a.ts); // reverse-chron, like a real timeline
    let replies = {};
    try {
      replies = await repliesFor(tweets.map((t) => t.id));
    } catch (err) {
      /* replies are decoration; the timeline must still render */
    }
    timeline.innerHTML = tweets.map((t) => tweetHtml(t, replies[t.id])).join("");
    applyUserFilter();

    if ($("#autoScroll").checked) requestAnimationFrame(scrollToNow);
  }

  /* ---------- boot ---------- */

  async function boot() {
    const [idxRes, usersRes] = await Promise.all([fetch("data/index.json"), fetch("data/users.json")]);
    index = await idxRes.json();
    for (const u of await usersRes.json()) users.set(u.screen_name, u);
    days = Object.keys(index.dayCounts).sort();

    dayPicker.min = index.minDay;
    dayPicker.max = index.maxDay;

    renderYears();

    const autoScroll = $("#autoScroll");
    autoScroll.checked = localStorage.getItem(LS_AUTOSCROLL) !== "0"; // on by default
    autoScroll.addEventListener("change", () => {
      localStorage.setItem(LS_AUTOSCROLL, autoScroll.checked ? "1" : "0");
      if (autoScroll.checked) scrollToNow();
    });

    const phoneMode = $("#phoneMode");
    phoneMode.checked = localStorage.getItem(LS_PHONE) === "1";
    phoneMode.addEventListener("change", () => {
      localStorage.setItem(LS_PHONE, phoneMode.checked ? "1" : "0");
      updatePhoneFrame();
    });
    updatePhoneFrame();

    $("#prevDay").addEventListener("click", () => setDay(neighborDay(currentDay, -1)));
    $("#nextDay").addEventListener("click", () => setDay(neighborDay(currentDay, +1)));
    $("#randomDay").addEventListener("click", () => setDay(goldenRandomDay()));
    dayPicker.addEventListener("change", () => {
      if (dayPicker.value) setDay(dayPicker.value);
    });
    window.addEventListener("hashchange", () => {
      if (location.hash === "#/blocked") { renderBlocked(); return; }
      if (location.hash === "#/likes") { renderLikes(); return; }
      const q = searchFromHash();
      if (q !== null) { renderSearch(q); return; }
      const d = dayFromHash();
      if (d && (d !== currentDay || currentView !== "day")) setDay(d, false);
      else if (!d && currentView !== "day") setDay(currentDay || goldenRandomDay());
    });

    // reply + block + name-click handling is delegated so it also covers
    // search results, which stream into the timeline in batches
    timeline.addEventListener("click", (e) => {
      const reply = e.target.closest(".act-reply");
      if (reply) {
        e.preventDefault();
        attachComposer(reply.closest(".tweet"));
        return;
      }
      const block = e.target.closest(".act-block");
      if (block) {
        e.preventDefault();
        blockUser(block.closest(".tweet").dataset.user);
        return;
      }
      const unblock = e.target.closest(".bl-unblock");
      if (unblock) {
        unblockUser(unblock.closest(".blocked-row").dataset.user);
        renderBlocked();
        return;
      }
      const name = e.target.closest(".fullname, .username");
      if (name && name.closest(".tweet")) toggleUserFilter(name.closest(".tweet").dataset.user);
    });
    $("#streamFilter").addEventListener("click", (e) => {
      if (e.target.closest("#clearFilter")) {
        e.preventDefault();
        toggleUserFilter(null);
      }
    });

    const topSearch = $("#topSearch");
    topSearch.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = topSearch.value.trim();
      if (!q) return;
      const hash = `#/search/${encodeURIComponent(q)}`;
      if (location.hash === hash) renderSearch(q); // hashchange won't fire on a repeat
      else location.hash = hash;
    });

    monthsWithData = new Set(days.map((d) => d.slice(0, 7)));

    const likesFile = $("#likesFile");
    const likesStatus = $("#likesStatus");
    const likesProgress = $("#likesProgress");
    const likesProgressFill = $("#likesProgressFill");
    const likesProgressText = $("#likesProgressText");
    const likesViewLink = $("#likesViewLink");

    const cachedLikes = loadLikesMatches();
    if (cachedLikes && cachedLikes.matches.length) {
      likesStatus.textContent = `Found ${cachedLikes.matches.length} of ${cachedLikes.totalLikes.toLocaleString()} likes in this archive.`;
      likesViewLink.hidden = false;
    }

    likesFile.addEventListener("change", async () => {
      const files = Array.from(likesFile.files || []);
      if (!files.length) return;
      likesViewLink.hidden = true;
      likesProgress.hidden = false;
      likesProgressFill.style.width = "0%";
      likesProgressText.textContent = "";
      likesStatus.textContent = "Reading file…";
      try {
        const texts = await Promise.all(files.map((f) => f.text()));
        const ids = [...new Set(texts.flatMap(parseLikesFile))];
        if (!ids.length) {
          likesProgress.hidden = true;
          likesStatus.textContent = "Couldn't find any likes in that file — make sure it's like.js from your X archive.";
          return;
        }
        likesStatus.textContent = `Checking ${ids.length.toLocaleString()} likes against the archive…`;
        const matches = await matchLikes(ids, (done, total) => {
          const pct = Math.round((done / total) * 100);
          likesProgressFill.style.width = `${pct}%`;
          likesProgressText.textContent = `${pct}%`;
        });
        likesProgress.hidden = true;
        saveLikesMatches(ids.length, matches);
        likesStatus.textContent = matches.length
          ? `Found ${matches.length} of ${ids.length.toLocaleString()} likes in this archive!`
          : `None of your ${ids.length.toLocaleString()} likes turned up in this archive.`;
        likesViewLink.hidden = matches.length === 0;
        if (location.hash === "#/likes") renderLikes();
      } catch (err) {
        likesProgress.hidden = true;
        likesStatus.textContent = `Couldn't process that file (${err.message}).`;
      }
    });

    const bootSearch = searchFromHash();
    if (location.hash === "#/blocked") {
      renderBlocked();
    } else if (location.hash === "#/likes") {
      renderLikes();
    } else if (bootSearch !== null) {
      renderSearch(bootSearch);
    } else {
      setDay(dayFromHash() || goldenRandomDay());
    }
  }

  boot().catch((err) => {
    timeline.innerHTML = `<div class="state-box">Failed to start: ${esc(err.message)}</div>`;
  });
})();
