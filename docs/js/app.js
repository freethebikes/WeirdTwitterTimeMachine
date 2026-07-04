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

  const $ = (sel) => document.querySelector(sel);
  const timeline = $("#timeline");
  const dayPicker = $("#dayPicker");

  let index = null; // data/index.json
  let users = new Map(); // screen_name -> profile
  let days = []; // sorted days that have posts
  let currentDay = null;
  const monthCache = new Map();

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

  /* ---------- navigation ---------- */

  function dayFromHash() {
    const m = location.hash.match(/^#\/(\d{4}-\d{2}-\d{2})$/);
    return m ? m[1] : null;
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

  function renderSidebar(dayTweets) {
    const count = index.dayCounts[currentDay] || dayTweets.length;
    const voices = new Set(dayTweets.map((t) => t.user)).size;
    $("#dayCount").textContent = count
      ? `${count} post${count === 1 ? "" : "s"} by ${voices} account${voices === 1 ? "" : "s"} on this day.`
      : "the timeline is quiet on this day.";
    $("#dataMode").textContent = useSupabase
      ? "posts + replies served from Supabase"
      : "static archive mode — replies are saved in this browser only";

    const tags = [...new Set(dayTweets.flatMap((t) => (t.text.match(/#\w+/g) || [])))].slice(0, 6);
    const canned = ["#TeamFollowBack", "Corn", "The Economy", "#FF", "Doritos", "girther movement"];
    $("#trendList").innerHTML = (tags.length ? tags : canned)
      .map((h) => `<li>${esc(h)}</li>`)
      .join("");

    const year = currentDay.slice(0, 4);
    $("#pageFooter").innerHTML =
      `© ${esc(year)} Weird Twitter Time Machine · ` +
      `posts by <a href="https://twitter.com/dril" target="_blank" rel="noopener">@dril</a> and the weird twitter greats · ` +
      `data from the <a href="https://github.com/codemasher/dril-archive" target="_blank" rel="noopener">dril-archive</a> ` +
      `and <a href="https://web.archive.org/web/2022/https://cooltweets.herokuapp.com/" target="_blank" rel="noopener">Cool Tweets</a> (via the Wayback Machine) · ` +
      `<a href="https://github.com/freethebikes/WeirdTwitterTimeMachine" target="_blank" rel="noopener">source</a>`;
  }

  function renderProfile() {
    const u = users.get("dril");
    if (!u) return;
    $("#profileCard").innerHTML = `
      <div class="p-head">
        <img src="${esc(u.avatar)}" alt="">
        <div><div class="p-name">${esc(u.name)}</div><div class="p-handle">@${esc(u.screen_name)}</div></div>
      </div>
      <p class="p-bio">${linkify(u.description || "")}</p>
      <div class="p-stats">
        <div><strong>${fmtNum(u.statuses)}</strong> Tweets</div>
        <div><strong>${fmtNum(u.following)}</strong> Following</div>
        <div><strong>${fmtNum(u.followers)}</strong> Followers</div>
      </div>`;
  }

  function replyHtml(r) {
    const when = new Date(r.created_at);
    return `
      <div class="future-reply">
        <div class="fr-head"><b>${esc(r.author)}</b> · ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} <span class="fr-badge">FROM THE FUTURE</span></div>
        <div>${linkify(r.text)}</div>
      </div>`;
  }

  function tweetHtml(t, replies) {
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
      <article class="tweet" data-id="${esc(t.id)}">
        <img class="avatar" src="${esc(avatar)}" alt="">
        <div class="tweet-body">
          <div class="tweet-head">
            <span class="fullname">${esc(u.name)}</span>
            <span class="username">@${esc(t.user)}</span>
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
    timeline.querySelectorAll(".act-reply").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        attachComposer(a.closest(".tweet"));
      });
    });
  }

  /* ---------- boot ---------- */

  async function boot() {
    const [idxRes, usersRes] = await Promise.all([fetch("data/index.json"), fetch("data/users.json")]);
    index = await idxRes.json();
    for (const u of await usersRes.json()) users.set(u.screen_name, u);
    days = Object.keys(index.dayCounts).sort();

    dayPicker.min = index.minDay;
    dayPicker.max = index.maxDay;

    renderProfile();

    $("#prevDay").addEventListener("click", () => setDay(neighborDay(currentDay, -1)));
    $("#nextDay").addEventListener("click", () => setDay(neighborDay(currentDay, +1)));
    $("#randomDay").addEventListener("click", () => setDay(goldenRandomDay()));
    dayPicker.addEventListener("change", () => {
      if (dayPicker.value) setDay(dayPicker.value);
    });
    window.addEventListener("hashchange", () => {
      const d = dayFromHash();
      if (d && d !== currentDay) setDay(d, false);
    });

    setDay(dayFromHash() || goldenRandomDay());
  }

  boot().catch((err) => {
    timeline.innerHTML = `<div class="state-box">Failed to start: ${esc(err.message)}</div>`;
  });
})();
