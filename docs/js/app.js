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

  // supabase-js is used for auth only (OAuth/PKCE/session refresh); all data
  // still goes through plain PostgREST fetches in sbFetch.
  const sb = useSupabase && window.supabase
    ? window.supabase.createClient(SB_URL, SB_KEY, { auth: { flowType: "pkce", detectSessionInUrl: true } })
    : null;

  const TZ = "America/New_York";
  const REPLY_LIMIT = 140; // it's the past; you get 140 characters
  const POST_LIMIT = 280; // it's the present; you get the modern allowance
  const LS_REPLIES = "wttm-replies";
  const LS_AUTHOR = "wttm-author";
  const LS_AUTOSCROLL = "wttm-autoscroll";
  const LS_LIKES = "wttm-likes-matches";
  const LS_BLOCKED = "wttm-blocked";
  const LS_PHONE = "wttm-phone-mode";
  const LS_BATHROOM = "wttm-bathroom-mode";
  const LS_NEWS = "wttm-news-mode";
  const LS_FOLLOW_MODE = "wttm-follow-mode";
  const LS_AUTH_RETURN = "wttm-auth-return";

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
  let currentView = "day"; // "day" | "likes" | "search" | "blocked" | "post" | "liked" | "following"
  let currentPostId = null; // id shown by the "post" (permalink) view
  let lastTweets = []; // tweets currently on screen (for the time-of-day jump)
  let session = null; // Supabase Auth session, or null when signed out
  let profile = null; // row from profiles for the signed-in user
  let isModerator = false; // signed-in user has a row in moderators
  let likedSet = new Set(); // ids you've liked ("u"-prefixed for user posts)
  let followedSet = new Set(); // lowercase screen names you follow
  let onlyFollowing = localStorage.getItem(LS_FOLLOW_MODE) === "1";
  let userFilter = null; // screen_name to isolate, or null for everyone
  let blockedUsers = loadBlocked(); // screen names you've blocked, in the order you blocked them
  let blockedLower = new Set(blockedUsers.map((n) => n.toLowerCase()));
  let contextUsers = new Set(); // lowercase screen names of "the news" context accounts (users.json context flag)
  let showNews = localStorage.getItem(LS_NEWS) !== "0"; // news-of-the-day posts are on by default
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

  // Archive tweet ids are all-numeric strings; present-day post ids are
  // prefixed with "u" everywhere outside the database so the two can share
  // routes, data-ids, and like keys without colliding.
  const isUserPostId = (id) => String(id).startsWith("u");
  const postDbId = (id) => String(id).slice(1);

  /* ---------- data layer ---------- */

  // Writes ride the signed-in user's token so row level security can
  // attribute them; reads fall back to the anon key.
  async function sbFetch(path, opts = {}) {
    const headers = {
      apikey: SB_KEY,
      Authorization: `Bearer ${session ? session.access_token : SB_KEY}`,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.prefer) headers.Prefer = opts.prefer;
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      // surface PostgREST's message ("this account is suspended", …) when
      // there is one; fall back to the bare status
      let msg = `Supabase HTTP ${res.status}`;
      try {
        const detail = (await res.json()).message;
        if (detail) msg = detail;
      } catch { /* not JSON */ }
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
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

  // a posts row (with its profiles embed) in the same shape as an archive tweet
  const fromPostRow = (r) => ({
    id: "u" + r.id,
    user: r.profiles ? r.profiles.handle : "someone",
    authorName: r.profiles ? r.profiles.display_name : null,
    authorAvatar: r.profiles ? r.profiles.avatar : null,
    ts: Date.parse(r.created_at) / 1000,
    day: r.posted_day,
    text: r.text,
    media: [],
    userPost: true,
  });

  const POSTS_SELECT = "select=*,profiles(handle,display_name,avatar)";

  async function tweetsForDay(day) {
    if (useSupabase) {
      const [rows, postRows] = await Promise.all([
        sbFetch(`tweets?posted_day=eq.${day}&order=created_at.asc&select=*`),
        // tolerate a database that predates the accounts migration
        sbFetch(`posts?posted_day=eq.${day}&order=created_at.asc&${POSTS_SELECT}`).catch(() => []),
      ]);
      return rows.map(fromRow).concat(postRows.map(fromPostRow));
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
      const tweetIds = ids.filter((id) => !isUserPostId(id));
      const postIds = ids.filter(isUserPostId).map(postDbId);
      const batches = await Promise.all([
        tweetIds.length ? sbFetch(`replies?tweet_id=in.(${tweetIds.join(",")})&order=created_at.asc&select=*`) : [],
        postIds.length ? sbFetch(`replies?post_id=in.(${postIds.join(",")})&order=created_at.asc&select=*`).catch(() => []) : [],
      ]);
      for (const r of batches.flat()) {
        const key = r.post_id != null ? "u" + r.post_id : r.tweet_id;
        (grouped[key] = grouped[key] || []).push(r);
      }
    } else {
      const store = JSON.parse(localStorage.getItem(LS_REPLIES) || "{}");
      for (const id of ids) if (store[id] && store[id].length) grouped[id] = store[id];
    }
    return grouped;
  }

  async function postReply(targetId, author, text) {
    if (useSupabase) {
      // the stamp_reply trigger fills in user_id/author/created_at server-side
      const body = isUserPostId(targetId)
        ? { post_id: Number(postDbId(targetId)), text }
        : { tweet_id: targetId, text };
      const rows = await sbFetch("replies", { method: "POST", body, prefer: "return=representation" });
      return rows[0];
    }
    const reply = { tweet_id: targetId, author, text, created_at: new Date().toISOString() };
    const store = JSON.parse(localStorage.getItem(LS_REPLIES) || "{}");
    (store[targetId] = store[targetId] || []).push(reply);
    localStorage.setItem(LS_REPLIES, JSON.stringify(store));
    return reply;
  }

  async function createPost(text) {
    // the stamp_post trigger pins user_id/created_at/posted_day server-side
    const rows = await sbFetch("posts", { method: "POST", body: { text }, prefer: "return=representation" });
    return rows[0];
  }

  /* ---------- accounts ---------- */

  const todayNY = () => nyDayFmt.format(new Date());

  function initAuth() {
    renderAccountUI();
    if (!sb) return;
    sb.auth.onAuthStateChange((event, s) => {
      const prevUid = session && session.user.id;
      session = s;
      const uid = s && s.user.id;
      if (uid === prevUid) return; // token refresh; nothing visible changes
      // defer: supabase-js warns against awaiting inside this callback
      setTimeout(() => (uid ? onSignedIn() : onSignedOut()), 0);
    });
  }

  async function onSignedIn() {
    try {
      profile = await ensureProfile();
      await Promise.all([loadOwnedState(), mergeBlocksToServer(), loadModeratorFlag()]);
    } catch (err) {
      console.warn("account setup failed:", err);
    }
    renderAccountUI();
    updateFollowModeUI();
    const ret = localStorage.getItem(LS_AUTH_RETURN);
    localStorage.removeItem(LS_AUTH_RETURN);
    if (ret && location.hash !== ret) {
      location.hash = ret; // hashchange re-renders the right view
      return;
    }
    rerenderCurrentView();
  }

  function onSignedOut() {
    profile = null;
    isModerator = false;
    likedSet = new Set();
    followedSet = new Set();
    renderAccountUI();
    updateFollowModeUI();
    rerenderCurrentView();
  }

  // The on_auth_user_created trigger normally makes the profile; this covers
  // users who signed up before the trigger existed (or a failed trigger).
  async function ensureProfile() {
    const uid = session.user.id;
    const rows = await sbFetch(`profiles?id=eq.${uid}&select=*`);
    if (rows.length) return rows[0];
    const meta = session.user.user_metadata || {};
    let base = String(
      meta.user_name || meta.preferred_username || meta.full_name || meta.name ||
      (session.user.email || "").split("@")[0] || "timetraveler"
    ).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
    if (base.length < 2) base = "timetraveler";
    for (let n = 0; n < 50; n++) {
      const handle = n ? base.slice(0, 20 - String(n).length) + n : base;
      try {
        const created = await sbFetch("profiles", {
          method: "POST",
          body: {
            id: uid,
            handle,
            display_name: String(meta.full_name || meta.name || handle).slice(0, 50),
            avatar: meta.avatar_url || null,
          },
          prefer: "return=representation",
        });
        return created[0];
      } catch {
        /* handle taken; try the next suffix */
      }
    }
    throw new Error("could not pick a free handle");
  }

  async function loadOwnedState() {
    const uid = session.user.id;
    const [likes, follows] = await Promise.all([
      sbFetch(`likes?user_id=eq.${uid}&select=tweet_id,post_id`),
      sbFetch(`follows?user_id=eq.${uid}&select=screen_name`),
    ]);
    likedSet = new Set(likes.map((r) => (r.post_id != null ? "u" + r.post_id : r.tweet_id)));
    followedSet = new Set(follows.map((r) => r.screen_name.toLowerCase()));
  }

  async function loadModeratorFlag() {
    // tolerate a database that predates the moderation migration
    try {
      const rows = await sbFetch(`moderators?user_id=eq.${session.user.id}&select=user_id`);
      isModerator = rows.length > 0;
    } catch {
      isModerator = false;
    }
  }

  // Union the browser's block list with the server's so blocks made while
  // signed out (or on another device) all end up in both places.
  async function mergeBlocksToServer() {
    const uid = session.user.id;
    const server = await sbFetch(`blocks?user_id=eq.${uid}&select=screen_name`);
    const serverLower = new Set(server.map((r) => r.screen_name.toLowerCase()));
    const missing = blockedUsers.filter((n) => !serverLower.has(n.toLowerCase()));
    if (missing.length) {
      await sbFetch("blocks", {
        method: "POST",
        body: missing.map((n) => ({ user_id: uid, screen_name: n })),
        prefer: "resolution=merge-duplicates",
      });
    }
    for (const r of server) if (!blockedLower.has(r.screen_name.toLowerCase())) blockedUsers.push(r.screen_name);
    saveBlocked();
    applyUserFilter();
  }

  function toggleLike(id) {
    if (!profile) { openLoginModal(); return; }
    const uid = session.user.id;
    const wasLiked = likedSet.has(id);
    const revert = () => { (wasLiked ? likedSet.add(id) : likedSet.delete(id)); updateLikeLinks(id); };
    if (wasLiked) {
      likedSet.delete(id);
      const q = isUserPostId(id) ? `post_id=eq.${postDbId(id)}` : `tweet_id=eq.${id}`;
      sbFetch(`likes?user_id=eq.${uid}&${q}`, { method: "DELETE" }).catch(revert);
    } else {
      likedSet.add(id);
      const body = isUserPostId(id) ? { user_id: uid, post_id: Number(postDbId(id)) } : { user_id: uid, tweet_id: id };
      sbFetch("likes", { method: "POST", body }).catch(revert);
    }
    updateLikeLinks(id);
  }

  function updateLikeLinks(id) {
    const liked = likedSet.has(id);
    timeline.querySelectorAll(`.tweet[data-id="${CSS.escape(id)}"] .act-like`).forEach((a) => {
      a.classList.toggle("liked", liked);
      a.textContent = liked ? "★ Liked" : "☆ Like";
    });
  }

  function toggleFollow(screenName) {
    if (!profile) { openLoginModal(); return; }
    const uid = session.user.id;
    const lower = screenName.toLowerCase();
    const wasFollowed = followedSet.has(lower);
    const revert = () => { (wasFollowed ? followedSet.add(lower) : followedSet.delete(lower)); updateFollowLinks(screenName); };
    if (wasFollowed) {
      followedSet.delete(lower);
      sbFetch(`follows?user_id=eq.${uid}&screen_name=ilike.${encodeURIComponent(screenName)}`, { method: "DELETE" }).catch(revert);
    } else {
      followedSet.add(lower);
      sbFetch("follows", {
        method: "POST",
        body: { user_id: uid, screen_name: screenName },
        prefer: "resolution=merge-duplicates",
      }).catch(revert);
    }
    updateFollowLinks(screenName);
    if (onlyFollowing) applyUserFilter();
  }

  function updateFollowLinks(screenName) {
    const following = followedSet.has(screenName.toLowerCase());
    timeline.querySelectorAll(`.tweet[data-user="${CSS.escape(screenName)}"] .act-follow`).forEach((a) => {
      a.classList.toggle("following", following);
      a.textContent = following ? "Following" : "Follow";
    });
  }

  function renderAccountUI() {
    const slot = $("#topAccount");
    if (!slot) return;
    if (!sb) { slot.innerHTML = ""; return; }
    if (!profile) {
      slot.innerHTML = `<button type="button" class="ta-signin" id="signInBtn">Sign in</button>`;
      return;
    }
    slot.innerHTML = `
      <button type="button" class="ta-user" id="accountBtn" aria-expanded="false">
        <img class="ta-avatar" src="${esc(profile.avatar || "assets/egg.svg")}" alt="">
        <span class="ta-handle">@${esc(profile.handle)}</span>
      </button>
      <div class="ta-menu" id="accountMenu" hidden>
        <a href="#/${esc(todayNY())}">Post to today</a>
        <a href="#/liked">Posts you've liked</a>
        <a href="#/following">Following</a>
        ${isModerator ? `<a href="#/mod">Moderation</a>` : ""}
        <a href="#" id="editProfileLink">Edit profile</a>
        <a href="#" id="signOutLink">Sign out</a>
      </div>`;
  }

  function updateFollowModeUI() {
    const row = $("#followModeRow");
    if (row) row.hidden = !profile;
  }

  function rerenderCurrentView() {
    if (currentView === "day" && currentDay) render();
    else if (currentView === "post" && currentPostId) renderPost(currentPostId);
    else if (currentView === "liked") renderLiked();
    else if (currentView === "following") renderFollowing();
    else if (currentView === "mod") renderModeration();
  }

  /* ---------- account modals ---------- */

  function closeModal() {
    const m = $("#wttmModal");
    if (m) m.remove();
  }

  function openModal(html) {
    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "wm-backdrop";
    overlay.id = "wttmModal";
    overlay.innerHTML = `<div class="wm-box">${html}</div>`;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    return overlay;
  }

  function signInOAuth(provider) {
    localStorage.setItem(LS_AUTH_RETURN, location.hash);
    sb.auth.signInWithOAuth({
      provider,
      options: { redirectTo: location.origin + location.pathname },
    });
  }

  function openLoginModal() {
    const overlay = openModal(`
      <h2>Sign in</h2>
      <p class="wm-blurb">Sign in to post, reply from the future, and keep your likes, follows, and blocks on every device.</p>
      <button type="button" class="wm-provider" data-provider="google">Sign in with Google</button>
      <button type="button" class="wm-provider" data-provider="github">Sign in with GitHub</button>
      <div class="wm-divider">or</div>
      <form class="wm-magic">
        <input type="email" placeholder="you@example.com" required>
        <button type="submit">Email me a sign-in link</button>
      </form>
      <div class="wm-status"></div>`);
    const status = overlay.querySelector(".wm-status");
    overlay.querySelectorAll(".wm-provider").forEach((btn) =>
      btn.addEventListener("click", () => signInOAuth(btn.dataset.provider))
    );
    overlay.querySelector(".wm-magic").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = overlay.querySelector("input[type=email]").value.trim();
      if (!email) return;
      status.textContent = "sending…";
      try {
        localStorage.setItem(LS_AUTH_RETURN, location.hash);
        const { error } = await sb.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        status.textContent = "Check your email — and open the link in this same browser.";
      } catch (err) {
        status.textContent = `Couldn't send the link (${err.message}).`;
      }
    });
  }

  function openProfileModal() {
    if (!profile) return;
    const overlay = openModal(`
      <h2>Edit profile</h2>
      <form class="wm-profile">
        <label>Handle
          <input name="handle" value="${esc(profile.handle)}" maxlength="20" pattern="[a-z0-9_]{2,20}" title="2–20 characters: lowercase letters, numbers, underscores" required>
        </label>
        <label>Display name
          <input name="display_name" value="${esc(profile.display_name)}" maxlength="50" required>
        </label>
        <button type="submit">Save</button>
      </form>
      <div class="wm-status"></div>`);
    const status = overlay.querySelector(".wm-status");
    overlay.querySelector(".wm-profile").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const handle = form.handle.value.trim();
      const display_name = form.display_name.value.trim();
      status.textContent = "saving…";
      try {
        const rows = await sbFetch(`profiles?id=eq.${session.user.id}`, {
          method: "PATCH",
          body: { handle, display_name },
          prefer: "return=representation",
        });
        profile = rows[0];
        renderAccountUI();
        closeModal();
      } catch {
        status.textContent = "That handle is taken (or belongs to an archive account). Try another.";
      }
    });
  }

  // target is { post_id } or { reply_id }; the server snapshots everything
  // else (who wrote it, its text) from the id, so nothing here is trusted.
  function openReportModal(target, handle, text) {
    const overlay = openModal(`
      <h2>Report @${esc(handle)}</h2>
      <blockquote class="wm-quote">${esc(text)}</blockquote>
      <form class="wm-report">
        <textarea placeholder="What's wrong with it? (optional)" maxlength="500"></textarea>
        <button type="submit">Send report</button>
      </form>
      <div class="wm-status"></div>`);
    const status = overlay.querySelector(".wm-status");
    overlay.querySelector(".wm-report").addEventListener("submit", async (e) => {
      e.preventDefault();
      const reason = overlay.querySelector("textarea").value.trim();
      status.textContent = "sending…";
      try {
        await sbFetch("reports", { method: "POST", body: { ...target, reason: reason || null } });
        overlay.querySelector(".wm-box").innerHTML =
          `<h2>Report sent</h2><p class="wm-blurb">Thanks — a moderator will take a look.</p>`;
        setTimeout(closeModal, 1500);
      } catch (err) {
        status.textContent = /duplicate/.test(err.message)
          ? "You've already reported this."
          : `Couldn't send the report (${err.message}).`;
      }
    });
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
      // write-through: localStorage stays the instant source, the server
      // keeps the list available on other devices
      if (profile) {
        sbFetch("blocks", {
          method: "POST",
          body: { user_id: session.user.id, screen_name: screenName },
          prefer: "resolution=merge-duplicates",
        }).catch(() => {});
      }
    }
    if (userFilter && userFilter.toLowerCase() === screenName.toLowerCase()) userFilter = null;
    applyUserFilter();
  }

  function unblockUser(screenName) {
    blockedUsers = blockedUsers.filter((n) => n.toLowerCase() !== screenName.toLowerCase());
    saveBlocked();
    if (profile) {
      sbFetch(`blocks?user_id=eq.${session.user.id}&screen_name=ilike.${encodeURIComponent(screenName)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
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

  /* ---------- permalink, liked, following views ---------- */

  const backBox = (day) =>
    `<div class="state-box likes-back"><a href="#/${esc(day || currentDay || goldenRandomDay())}">← back to the time machine</a></div>`;

  async function renderPost(id) {
    const seq = ++searchSeq;
    currentView = "post";
    currentPostId = id;
    setActiveNav();
    document.title = "Post — Weird Twitter Time Machine";
    document.querySelectorAll("#yearList a").forEach((a) => a.classList.remove("active"));
    $("#dayCount").textContent = "";
    timeline.innerHTML = `<div class="state-box">finding that post…</div>`;

    let t = null;
    try {
      if (isUserPostId(id)) {
        if (!useSupabase) {
          timeline.innerHTML = backBox() + `<div class="state-box">Posts from the future live on the live site, not in the bundled archive.</div>`;
          return;
        }
        const rows = await sbFetch(`posts?id=eq.${postDbId(id)}&${POSTS_SELECT}`);
        if (rows.length) t = fromPostRow(rows[0]);
      } else if (useSupabase) {
        const rows = await sbFetch(`tweets?id=eq.${id}&select=*`);
        if (rows.length) t = fromRow(rows[0]);
      } else {
        // the id itself tells us which month file to look in
        let day = null;
        if (/^\d+$/.test(id)) day = BigInt(id) < SNOWFLAKE_MIN ? (await loadLegacyIds())[id] : snowflakeDay(id);
        if (day && monthsWithData.has(day.slice(0, 7))) {
          const tweets = await monthTweets(day.slice(0, 7));
          t = tweets.find((x) => x.id === id) || null;
        }
      }
    } catch (err) {
      timeline.innerHTML = backBox() + `<div class="state-box">Couldn't load that post (${esc(err.message)}).</div>`;
      return;
    }
    if (seq !== searchSeq) return;

    if (!t) {
      timeline.innerHTML = backBox() + `<div class="state-box">That post isn't in this archive.</div>`;
      return;
    }
    lastTweets = [t];
    updatePhoneFrame();
    let replies = {};
    try {
      replies = await repliesFor([t.id]);
    } catch {
      /* replies are decoration */
    }
    if (seq !== searchSeq) return;
    timeline.innerHTML = backBox(t.day) + tweetHtml(t, replies[t.id], { dayLink: true });
    applyUserFilter();
  }

  async function renderLiked() {
    const seq = ++searchSeq;
    currentView = "liked";
    setActiveNav();
    document.title = "Posts You've Liked — Weird Twitter Time Machine";
    document.querySelectorAll("#yearList a").forEach((a) => a.classList.remove("active"));
    $("#dayCount").textContent = "";

    if (!useSupabase || !profile) {
      timeline.innerHTML = backBox() + `<div class="state-box">Sign in to keep a list of posts you've liked here.</div>`;
      return;
    }
    timeline.innerHTML = `<div class="state-box">gathering your likes…</div>`;
    try {
      const likeRows = await sbFetch(`likes?user_id=eq.${session.user.id}&order=created_at.desc&select=tweet_id,post_id&limit=200`);
      if (seq !== searchSeq) return;
      if (!likeRows.length) {
        timeline.innerHTML = backBox() + `<div class="state-box">Nothing liked yet. Click ☆ Like under a post to keep it here.</div>`;
        return;
      }
      const tweetIds = likeRows.filter((r) => r.tweet_id).map((r) => r.tweet_id);
      const postIds = likeRows.filter((r) => r.post_id != null).map((r) => r.post_id);
      const [tRows, pRows] = await Promise.all([
        tweetIds.length ? sbFetch(`tweets?id=in.(${tweetIds.join(",")})&select=*`) : [],
        postIds.length ? sbFetch(`posts?id=in.(${postIds.join(",")})&${POSTS_SELECT}`) : [],
      ]);
      if (seq !== searchSeq) return;
      const byId = new Map(tRows.map((r) => [r.id, fromRow(r)]).concat(pRows.map((r) => ["u" + r.id, fromPostRow(r)])));
      const tweets = likeRows
        .map((r) => byId.get(r.post_id != null ? "u" + r.post_id : r.tweet_id))
        .filter(Boolean);
      $("#dayCount").textContent = `${tweets.length} liked post${tweets.length === 1 ? "" : "s"}.`;
      lastTweets = tweets;
      updatePhoneFrame();
      let replies = {};
      try {
        replies = await repliesFor(tweets.map((t) => t.id));
      } catch {
        /* replies are decoration */
      }
      if (seq !== searchSeq) return;
      timeline.innerHTML = backBox() + tweets.map((t) => tweetHtml(t, replies[t.id], { dayLink: true })).join("");
      applyUserFilter();
    } catch (err) {
      if (seq !== searchSeq) return;
      timeline.innerHTML = backBox() + `<div class="state-box">Couldn't load your likes (${esc(err.message)}).</div>`;
    }
  }

  async function renderFollowing() {
    const seq = ++searchSeq;
    currentView = "following";
    setActiveNav();
    document.title = "Following — Weird Twitter Time Machine";
    document.querySelectorAll("#yearList a").forEach((a) => a.classList.remove("active"));
    $("#dayCount").textContent = "";

    if (!useSupabase || !profile) {
      timeline.innerHTML = backBox() + `<div class="state-box">Sign in to follow archive accounts and filter the timeline to just them.</div>`;
      return;
    }
    timeline.innerHTML = `<div class="state-box">loading…</div>`;
    let rows;
    try {
      rows = await sbFetch(`follows?user_id=eq.${session.user.id}&order=created_at.desc&select=screen_name`);
    } catch (err) {
      timeline.innerHTML = backBox() + `<div class="state-box">Couldn't load your follows (${esc(err.message)}).</div>`;
      return;
    }
    if (seq !== searchSeq) return;
    $("#dayCount").textContent = rows.length
      ? `following ${rows.length} account${rows.length === 1 ? "" : "s"}.`
      : "";
    if (!rows.length) {
      timeline.innerHTML = backBox() + `<div class="state-box">You aren't following anyone. Hover over a name in the timeline and click Follow.</div>`;
      return;
    }
    timeline.innerHTML =
      backBox() +
      rows
        .map(({ screen_name: name }) => {
          const u = users.get(name) || { name, avatar: "" };
          return `
            <div class="blocked-row" data-user="${esc(name)}">
              <img class="avatar" src="${esc(u.avatar || "assets/egg.svg")}" alt="">
              <div class="blocked-who">
                <span class="fullname">${esc(u.name)}</span>
                <span class="username">@${esc(name)}</span>
              </div>
              <button type="button" class="bl-unblock fw-unfollow">Unfollow</button>
            </div>`;
        })
        .join("");
  }

  /* ---------- moderation ---------- */

  async function renderModeration() {
    const seq = ++searchSeq;
    currentView = "mod";
    setActiveNav();
    document.title = "Moderation — Weird Twitter Time Machine";
    document.querySelectorAll("#yearList a").forEach((a) => a.classList.remove("active"));
    $("#dayCount").textContent = "";

    if (!useSupabase || !profile || !isModerator) {
      timeline.innerHTML = backBox() + `<div class="state-box">This page is for the site's moderators.</div>`;
      return;
    }
    timeline.innerHTML = `<div class="state-box">loading reports…</div>`;
    let reports, banned;
    try {
      [reports, banned] = await Promise.all([
        sbFetch(`reports?resolved_at=is.null&order=created_at.desc&select=*`),
        sbFetch(`profiles?banned_at=not.is.null&order=banned_at.desc&select=id,handle,display_name,avatar,banned_at`),
      ]);
    } catch (err) {
      timeline.innerHTML = backBox() + `<div class="state-box">Couldn't load moderation data (${esc(err.message)}).</div>`;
      return;
    }
    if (seq !== searchSeq) return;

    const bannedIds = new Set(banned.map((p) => p.id));
    const when = (iso) => {
      const d = new Date(iso);
      return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    };

    const reportsHtml = reports.length
      ? reports
          .map((r) => `
            <div class="mod-report" data-report-id="${esc(r.id)}" data-reported-id="${esc(r.reported_id)}">
              <div class="mod-head">
                <b>@${esc(r.reported_handle)}</b> reported by @${esc(r.reporter_handle || "?")} · ${esc(when(r.created_at))}
                ${r.target_id ? ` · <a href="#/post/${esc(r.target_id)}">view post</a>` : ""}
              </div>
              <blockquote class="mod-quote">${esc(r.content)}</blockquote>
              ${r.reason ? `<div class="mod-reason">“${esc(r.reason)}”</div>` : ""}
              <div class="mod-actions">
                ${bannedIds.has(r.reported_id)
                  ? `<button type="button" class="mod-btn mod-unban">Unban @${esc(r.reported_handle)}</button>`
                  : `<button type="button" class="mod-btn mod-ban">Ban @${esc(r.reported_handle)}</button>`}
                <button type="button" class="mod-btn mod-dismiss">Dismiss report</button>
              </div>
            </div>`)
          .join("")
      : `<div class="state-box">No open reports. The past is at peace.</div>`;

    const bannedHtml = banned.length
      ? banned
          .map((p) => `
            <div class="blocked-row" data-reported-id="${esc(p.id)}">
              <img class="avatar" src="${esc(p.avatar || "assets/egg.svg")}" alt="">
              <div class="blocked-who">
                <span class="fullname">${esc(p.display_name)}</span>
                <span class="username">@${esc(p.handle)} · banned ${esc(when(p.banned_at))}</span>
              </div>
              <button type="button" class="bl-unblock mod-unban">Unban</button>
            </div>`)
          .join("")
      : `<div class="state-box">Nobody is banned.</div>`;

    timeline.innerHTML =
      backBox() +
      `<div class="mod-section-head">Open reports</div>` + reportsHtml +
      `<div class="mod-section-head">Banned accounts</div>` + bannedHtml;
  }

  // Ban/unban flip profiles.banned_at (RLS lets only moderators do this);
  // banning from a report card also resolves that report.
  async function moderate(el) {
    const row = el.closest("[data-reported-id]");
    const uid = row.dataset.reportedId;
    const reportId = el.closest("[data-report-id]") && el.closest("[data-report-id]").dataset.reportId;
    el.disabled = true;
    try {
      if (el.classList.contains("mod-ban")) {
        await sbFetch(`profiles?id=eq.${uid}`, { method: "PATCH", body: { banned_at: new Date().toISOString() } });
        if (reportId) await sbFetch(`reports?id=eq.${reportId}`, { method: "PATCH", body: { resolved_at: new Date().toISOString() } });
      } else if (el.classList.contains("mod-unban")) {
        await sbFetch(`profiles?id=eq.${uid}`, { method: "PATCH", body: { banned_at: null } });
      } else if (el.classList.contains("mod-dismiss")) {
        await sbFetch(`reports?id=eq.${reportId}`, { method: "PATCH", body: { resolved_at: new Date().toISOString() } });
      }
      renderModeration();
    } catch (err) {
      el.disabled = false;
      alert(`That didn't work (${err.message}).`);
    }
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

  // today's month-day in a random year that has posts, preferring busier days
  function todayRandomYear() {
    const candidates = index.years.map((y) => todayInYear(Number(y))).filter((d) => index.dayCounts[d]);
    if (!candidates.length) return null;
    const rich = candidates.filter((d) => index.dayCounts[d] >= 8);
    const pool = rich.length ? rich : candidates;
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
    // the visitor's wall clock, not TZ: tweets are displayed in TZ, but "the
    // current time of day" means whatever the visitor's own clock says
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    let best = null;
    for (const t of lastTweets) {
      const raw = Math.abs(minuteOfDay(new Date(t.ts * 1000)) - nowMin);
      const diff = Math.min(raw, 1440 - raw); // clock distance wraps at midnight
      if (!best || diff < best.diff) best = { id: t.id, diff };
    }
    const el = timeline.querySelector(`[data-id="${CSS.escape(best.id)}"]`);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // hide blocked accounts, news accounts when the news toggle is off, plus
  // every tweet that isn't by userFilter when one is set; label the stream
  // header. Isolating a news account (userFilter) overrides the news toggle.
  function applyUserFilter() {
    const tweetsEls = timeline.querySelectorAll(".tweet");
    let visible = 0;
    const followingOnly = onlyFollowing && !!profile;
    tweetsEls.forEach((el) => {
      const lower = el.dataset.user.toLowerCase();
      const hide =
        blockedLower.has(lower) ||
        (userFilter
          ? el.dataset.user !== userFilter
          : (!showNews && contextUsers.has(lower)) ||
            // present-day user posts stay visible; follows only cover the archive
            (followingOnly && !followedSet.has(lower) && !el.classList.contains("user-post")));
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
        : followingOnly
          ? `Nobody <a href="#/following">you follow</a> posted on this day. <a href="#" id="clearFollowMode">Show everyone</a>`
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

  // the status bar shows the visitor's own wall clock, not the tweets' era
  function updatePhoneClock() {
    const [time, ampm] = new Date()
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      .split(" ");
    const clock = document.querySelector(".ph-clock");
    clock.firstChild.nodeValue = time;
    clock.querySelector(".ph-ampm").textContent = ` ${ampm}`;
  }

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
    updatePhoneClock();
  }

  function renderSidebar(dayTweets) {
    const regular = dayTweets.filter((t) => !contextUsers.has(t.user.toLowerCase()));
    const count = regular.length;
    const newsCount = dayTweets.length - count;
    const voices = new Set(regular.map((t) => t.user)).size;
    $("#dayCount").textContent =
      (count
        ? `${count} post${count === 1 ? "" : "s"} by ${voices} account${voices === 1 ? "" : "s"} on this day.`
        : "the timeline is quiet on this day.") +
      (newsCount && showNews ? ` (+${newsCount} from the news)` : "");
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
      `news-of-the-day context from Wayback captures of the news accounts · ` +
      `<a href="https://github.com/freethebikes/WeirdTwitterTimeMachine" target="_blank" rel="noopener">source</a>`;
  }

  function replyHtml(r, parentId) {
    const when = new Date(r.created_at);
    const stamp = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    // only replies by registered accounts are reportable (and not your own)
    const canReport = useSupabase && r.id && r.user_id && (!session || r.user_id !== session.user.id);
    return `
      <div class="future-reply"${r.id ? ` data-reply-id="${esc(r.id)}" data-author="${esc(r.author)}"` : ""}>
        <div class="fr-head"><b>${esc(r.author)}</b> · ${parentId ? `<a href="#/post/${esc(parentId)}" title="Permalink">${stamp}</a>` : stamp} <span class="fr-badge">FROM THE FUTURE</span>${canReport ? ` <a href="#" class="act-report fr-report" title="Report this reply to the moderators">Report</a>` : ""}</div>
        <div class="fr-text">${linkify(r.text)}</div>
      </div>`;
  }

  function tweetHtml(t, replies, opts = {}) {
    const u = t.userPost
      ? { name: t.authorName || t.user, avatar: t.authorAvatar || "" }
      : users.get(t.user) || { name: t.user, avatar: "" };
    const avatar = u.avatar || "assets/egg.svg";
    const time = timeFmt.format(new Date(t.ts * 1000));
    const media = (t.media || [])
      .filter((m) => m.type === "photo")
      .map((m) => `<div class="tweet-media"><a href="${esc(originalUrl(t))}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt="" loading="lazy" onerror="this.parentNode.parentNode.remove()"></a></div>`)
      .join("");
    const ctx = t.reply_to_user
      ? `<div class="reply-context">in reply to <a href="https://twitter.com/${esc(t.reply_to_user)}/status/${esc(t.reply_to_id || "")}" target="_blank" rel="noopener">@${esc(t.reply_to_user)}</a></div>`
      : "";
    const futureReplies = (replies || []).map((r) => replyHtml(r, t.id)).join("");
    const liked = likedSet.has(t.id);
    const canFollow = useSupabase && !t.userPost && !u.context;
    return `
      <article class="tweet${u.context ? " context-tweet" : ""}${t.userPost ? " user-post" : ""}" data-id="${esc(t.id)}" data-user="${esc(t.user)}">
        <img class="avatar" src="${esc(avatar)}" alt="">
        <div class="tweet-body">
          <div class="tweet-head">
            <span class="fullname" title="Show only @${esc(t.user)}">${esc(u.name)}</span>
            ${u.context ? '<span class="verified" title="Verified account">✓</span>' : ""}
            <span class="username" title="Show only @${esc(t.user)}">@${esc(t.user)}</span>
            ${canFollow ? `<a href="#" class="act-follow${followedSet.has(t.user.toLowerCase()) ? " following" : ""}" title="Follow @${esc(t.user)}">${followedSet.has(t.user.toLowerCase()) ? "Following" : "Follow"}</a>` : ""}
            <a href="#" class="act-block" title="Hide all posts from @${esc(t.user)}">Block</a>
            ${t.userPost ? '<span class="fr-badge up-badge">FROM THE FUTURE</span>' : ""}
            <span class="timestamp"><a href="#/post/${esc(t.id)}" title="${esc(longFmt.format(dayDate(t.day)))} — permalink">${time}</a></span>
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
            ${useSupabase ? `<a href="#" class="act-like${liked ? " liked" : ""}">${liked ? "★ Liked" : "☆ Like"}</a>` : ""}
            ${t.userPost && (!profile || t.user !== profile.handle) ? `<a href="#" class="act-report" title="Report this post to the moderators">Report</a>` : ""}
            ${t.userPost ? "" : `<a href="${esc(originalUrl(t))}" target="_blank" rel="noopener">View original ↗</a>`}
            ${opts.dayLink ? `<a href="#/${esc(t.day)}">Time-travel to this day</a>` : ""}
          </div>
          <div class="future-replies" ${futureReplies ? "" : "hidden"}>${futureReplies}</div>
          <div class="composer-slot"></div>
        </div>
      </article>`;
  }

  function composerHtml() {
    const year = new Date().getFullYear();
    // signed-in identity replaces the free-text name box in Supabase mode
    const who = useSupabase
      ? `<span class="rc-as">replying as <b>@${esc(profile.handle)}</b></span>`
      : `<input type="text" placeholder="your name (optional)" maxlength="40" value="${esc(localStorage.getItem(LS_AUTHOR) || "")}">`;
    return `
      <form class="reply-composer">
        <textarea placeholder="Reply to this post from the year ${year}…" maxlength="280"></textarea>
        <div class="rc-row">
          ${who}
          <span class="rc-count">${REPLY_LIMIT}</span>
          <button type="submit" class="rc-send" disabled>Tweet</button>
        </div>
        <div class="rc-note">Your reply is stamped with today's date. The past cannot hear you, but it will remember.</div>
      </form>`;
  }

  function attachComposer(article) {
    const slot = article.querySelector(".composer-slot");
    if (slot.firstChild) { slot.innerHTML = ""; return; } // toggle off
    if (useSupabase && !profile) {
      slot.innerHTML = `<div class="rc-signin">Sign in to reply from the future. <button type="button" class="rc-signin-btn">Sign in</button></div>`;
      slot.querySelector(".rc-signin-btn").addEventListener("click", openLoginModal);
      return;
    }
    if (useSupabase && profile.banned_at) {
      // the stamp triggers reject the write anyway; this just says so up front
      slot.innerHTML = `<div class="rc-signin rc-suspended">Your account is suspended — you can read, but not post.</div>`;
      return;
    }
    slot.innerHTML = composerHtml();
    const form = slot.querySelector("form");
    const ta = form.querySelector("textarea");
    const nameInput = form.querySelector("input[type=text]");
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
      const author = nameInput ? nameInput.value.trim() || "time traveler" : profile.handle;
      if (!text) return;
      sendBtn.disabled = true;
      sendBtn.textContent = "…";
      try {
        if (nameInput) localStorage.setItem(LS_AUTHOR, nameInput.value.trim());
        const saved = await postReply(article.dataset.id, author, text);
        const list = article.querySelector(".future-replies");
        list.hidden = false;
        list.insertAdjacentHTML("beforeend", replyHtml(saved, article.dataset.id));
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

  /* ---------- post composer (the present day) ---------- */

  function postComposerHtml() {
    return `
      <div class="post-composer-wrap">
        <form class="reply-composer post-composer">
          <textarea placeholder="What's happening?" maxlength="${POST_LIMIT}"></textarea>
          <div class="rc-row">
            <span class="rc-as">posting as <b>@${esc(profile.handle)}</b></span>
            <span class="rc-count">${POST_LIMIT}</span>
            <button type="submit" class="rc-send" disabled>Tweet</button>
          </div>
          <div class="rc-note">Posts land on today's date, alongside whatever the archive remembers of this day.</div>
        </form>
      </div>`;
  }

  function attachPostComposer() {
    const form = timeline.querySelector(".post-composer");
    if (!form) return;
    const ta = form.querySelector("textarea");
    const countEl = form.querySelector(".rc-count");
    const sendBtn = form.querySelector(".rc-send");

    ta.addEventListener("input", () => {
      const left = POST_LIMIT - ta.value.length;
      countEl.textContent = left;
      countEl.classList.toggle("over", left < 0);
      sendBtn.disabled = left < 0 || ta.value.trim().length === 0;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      sendBtn.textContent = "…";
      try {
        const saved = await createPost(text);
        const t = fromPostRow({
          ...saved,
          profiles: { handle: profile.handle, display_name: profile.display_name, avatar: profile.avatar },
        });
        lastTweets.unshift(t);
        form.closest(".post-composer-wrap").insertAdjacentHTML("afterend", tweetHtml(t, null));
        ta.value = "";
        countEl.textContent = POST_LIMIT;
        sendBtn.textContent = "Tweet";
        applyUserFilter();
      } catch (err) {
        sendBtn.disabled = false;
        sendBtn.textContent = "Tweet";
        let errEl = form.querySelector(".rc-error");
        if (!errEl) {
          errEl = document.createElement("div");
          errEl.className = "rc-error";
          form.appendChild(errEl);
        }
        errEl.textContent = `Could not post (${err.message}). Try again.`;
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

    // you can only post into the present: the composer appears on today's
    // date, and past days get a gentle pointer instead
    const isToday = day === todayNY();
    const composer = profile && isToday
      ? profile.banned_at
        ? `<div class="present-note rc-suspended">Your account is suspended — you can read, but not post.</div>`
        : postComposerHtml()
      : "";
    const presentNote = profile && !isToday
      ? `<div class="present-note">✎ posting happens in the present — <a href="#/${esc(todayNY())}">go to today</a></div>`
      : "";

    if (!tweets.length) {
      const prev = neighborDay(currentDay, -1);
      const next = neighborDay(currentDay, +1);
      timeline.innerHTML = composer + presentNote + `
        <div class="state-box">
          It's ${esc(longFmt.format(dayDate(currentDay)))} and the timeline is quiet.
          <div class="state-links">
            ${prev ? `<a href="#/${prev}">← ${shortFmt.format(dayDate(prev))}</a>` : ""}
            ${next ? `<a href="#/${next}">${shortFmt.format(dayDate(next))} →</a>` : ""}
          </div>
        </div>`;
      attachPostComposer();
      return;
    }

    tweets.sort((a, b) => b.ts - a.ts); // reverse-chron, like a real timeline
    let replies = {};
    try {
      replies = await repliesFor(tweets.map((t) => t.id));
    } catch (err) {
      /* replies are decoration; the timeline must still render */
    }
    timeline.innerHTML = composer + presentNote + tweets.map((t) => tweetHtml(t, replies[t.id])).join("");
    attachPostComposer();
    applyUserFilter();

    if ($("#autoScroll").checked) requestAnimationFrame(scrollToNow);
  }

  /* ---------- boot ---------- */

  async function boot() {
    const [idxRes, usersRes] = await Promise.all([fetch("data/index.json"), fetch("data/users.json")]);
    index = await idxRes.json();
    for (const u of await usersRes.json()) {
      users.set(u.screen_name, u);
      if (u.context) contextUsers.add(u.screen_name.toLowerCase());
    }
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

    const newsMode = $("#newsMode");
    newsMode.checked = showNews;
    newsMode.addEventListener("change", () => {
      showNews = newsMode.checked;
      localStorage.setItem(LS_NEWS, showNews ? "1" : "0");
      applyUserFilter();
      if (currentView === "day") renderSidebar(lastTweets);
    });

    const followMode = $("#followMode");
    followMode.checked = onlyFollowing;
    followMode.addEventListener("change", () => {
      onlyFollowing = followMode.checked;
      localStorage.setItem(LS_FOLLOW_MODE, onlyFollowing ? "1" : "0");
      applyUserFilter();
    });

    // topbar account button + dropdown
    $("#topAccount").addEventListener("click", (e) => {
      if (e.target.closest("#signInBtn")) { openLoginModal(); return; }
      if (e.target.closest("#accountBtn")) {
        const menu = $("#accountMenu");
        menu.hidden = !menu.hidden;
        $("#accountBtn").setAttribute("aria-expanded", String(!menu.hidden));
        return;
      }
      const edit = e.target.closest("#editProfileLink");
      if (edit) { e.preventDefault(); openProfileModal(); }
      const out = e.target.closest("#signOutLink");
      if (out) { e.preventDefault(); sb.auth.signOut(); }
      const menu = $("#accountMenu");
      if (menu && e.target.closest("a")) menu.hidden = true;
    });
    document.addEventListener("click", (e) => {
      const menu = $("#accountMenu");
      if (menu && !menu.hidden && !e.target.closest("#topAccount")) menu.hidden = true;
    });
    initAuth();

    const phoneMode = $("#phoneMode");
    phoneMode.checked = localStorage.getItem(LS_PHONE) === "1";
    phoneMode.addEventListener("change", () => {
      localStorage.setItem(LS_PHONE, phoneMode.checked ? "1" : "0");
      updatePhoneFrame();
    });
    updatePhoneFrame();
    setInterval(updatePhoneClock, 30000);

    const bathroomMode = $("#bathroomMode");
    function updateBathroom() {
      const on = bathroomMode.checked;
      document.body.classList.toggle("bathroom-mode", on);
      if (on) {
        // pick one of the two stalls per visit, not per render
        if (!document.body.classList.contains("bathroom-1") && !document.body.classList.contains("bathroom-2")) {
          document.body.classList.add(Math.random() < 0.5 ? "bathroom-1" : "bathroom-2");
        }
      } else {
        document.body.classList.remove("bathroom-1", "bathroom-2");
      }
    }
    bathroomMode.checked = localStorage.getItem(LS_BATHROOM) === "1";
    bathroomMode.addEventListener("change", () => {
      localStorage.setItem(LS_BATHROOM, bathroomMode.checked ? "1" : "0");
      if (bathroomMode.checked && !phoneMode.checked) {
        // you read these on a phone in the stall; turn the phone on too
        phoneMode.checked = true;
        localStorage.setItem(LS_PHONE, "1");
        updatePhoneFrame();
      }
      updateBathroom();
    });
    updateBathroom();

    $("#prevDay").addEventListener("click", () => setDay(neighborDay(currentDay, -1)));
    $("#nextDay").addEventListener("click", () => setDay(neighborDay(currentDay, +1)));
    $("#randomDay").addEventListener("click", () => setDay(goldenRandomDay()));
    dayPicker.addEventListener("change", () => {
      if (dayPicker.value) setDay(dayPicker.value);
    });
    window.addEventListener("hashchange", () => {
      if (location.hash === "#/blocked") { renderBlocked(); return; }
      if (location.hash === "#/likes") { renderLikes(); return; }
      if (location.hash === "#/liked") { renderLiked(); return; }
      if (location.hash === "#/following") { renderFollowing(); return; }
      if (location.hash === "#/mod") { renderModeration(); return; }
      const pm = location.hash.match(/^#\/post\/(u?\d+)$/);
      if (pm) { renderPost(pm[1]); return; }
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
      const like = e.target.closest(".act-like");
      if (like) {
        e.preventDefault();
        toggleLike(like.closest(".tweet").dataset.id);
        return;
      }
      const report = e.target.closest(".act-report");
      if (report) {
        e.preventDefault();
        if (!profile) { openLoginModal(); return; }
        const fr = report.closest(".future-reply");
        if (fr) {
          openReportModal({ reply_id: Number(fr.dataset.replyId) }, fr.dataset.author, fr.querySelector(".fr-text").textContent);
        } else {
          const tw = report.closest(".tweet");
          openReportModal({ post_id: Number(postDbId(tw.dataset.id)) }, tw.dataset.user, tw.querySelector(".tweet-text").textContent);
        }
        return;
      }
      // before .bl-unblock: the banned list's Unban button reuses that class
      const modBtn = e.target.closest(".mod-ban, .mod-unban, .mod-dismiss");
      if (modBtn) {
        moderate(modBtn);
        return;
      }
      const follow = e.target.closest(".act-follow");
      if (follow) {
        e.preventDefault();
        toggleFollow(follow.closest(".tweet").dataset.user);
        return;
      }
      const unfollow = e.target.closest(".fw-unfollow");
      if (unfollow) {
        toggleFollow(unfollow.closest(".blocked-row").dataset.user);
        renderFollowing();
        return;
      }
      const unblock = e.target.closest(".bl-unblock");
      if (unblock) {
        unblockUser(unblock.closest(".blocked-row").dataset.user);
        renderBlocked();
        return;
      }
      const clearFollow = e.target.closest("#clearFollowMode");
      if (clearFollow) {
        e.preventDefault();
        onlyFollowing = false;
        localStorage.setItem(LS_FOLLOW_MODE, "0");
        $("#followMode").checked = false;
        applyUserFilter();
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
    const bootPost = location.hash.match(/^#\/post\/(u?\d+)$/);
    if (location.hash === "#/blocked") {
      renderBlocked();
    } else if (location.hash === "#/likes") {
      renderLikes();
    } else if (location.hash === "#/liked") {
      renderLiked();
    } else if (location.hash === "#/following") {
      renderFollowing();
    } else if (location.hash === "#/mod") {
      renderModeration();
    } else if (bootPost) {
      renderPost(bootPost[1]);
    } else if (bootSearch !== null) {
      renderSearch(bootSearch);
    } else {
      setDay(dayFromHash() || todayRandomYear() || goldenRandomDay());
    }
  }

  /* ---------- mobile sidebar drawer ---------- */

  const menuBtn = $("#menuBtn");
  function setSidebarOpen(open) {
    document.body.classList.toggle("sidebar-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
  }
  menuBtn.addEventListener("click", () => setSidebarOpen(!document.body.classList.contains("sidebar-open")));
  $("#sidebarBackdrop").addEventListener("click", () => setSidebarOpen(false));
  // any navigation (new day, year link, search, …) closes the drawer
  window.addEventListener("hashchange", () => setSidebarOpen(false));

  boot().catch((err) => {
    timeline.innerHTML = `<div class="state-box">Failed to start: ${esc(err.message)}</div>`;
  });
})();
