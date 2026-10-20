// Thin API client.
import { takeBlur } from "./blur.js";

// Unlock token for the active protected profile, attached to every request so
// the server lets through reads/writes for that profile.
let authToken = null;
export const setAuthToken = (t) => { authToken = t || null; };

// What this browser can play (avcaps.js, TV round 2026-10-19): the id of its
// report, put on the reads that ask how a title plays (?caps=). The last
// load's id at once — the same browser says the same thing — until this
// load's report is answered.
const CAPS_KEY = "aurora-caps-id";
let capsIdNow = null;
try {
  const v = localStorage.getItem(CAPS_KEY);
  if (v && /^[0-9a-f]{16}$/.test(v)) capsIdNow = v;
} catch {}
export const capsId = () => capsIdNow;
export const setCapsId = (id) => {
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return;
  capsIdNow = id;
  try { localStorage.setItem(CAPS_KEY, id); } catch {}
};

const withToken = (headers = {}) =>
  authToken ? { ...headers, "X-Profile-Token": authToken } : headers;
// GETs say they can take blur-up placeholders beside the answer (lib/blurup.js)
const withBlur = (options, headers) =>
  !options.method || String(options.method).toUpperCase() === "GET" ? { ...headers, "X-Blur": "1" } : headers;

// Boot's first questions are already on the wire when this module loads —
// index.html asks them before any code has arrived (see the note there). A
// plain GET that matches one (same address, same profile token) takes that
// answer instead of asking again. Once only, only while it is fresh, and only
// a 200: anything else is asked the ordinary way, so a failure, a refusal
// from before a sign-in, or an answer that has sat through a long wait at the
// profile door can never stand in for a real one.
const EARLY_MAX_AGE_MS = 15000;
const takeEarly = (url, options) => {
  try {
    const store = window.__auroraEarly;
    if (!store || options.method || options.body || options.priority || options.signal) return null;
    // The one call that names its own token: boot's "who am I", asked with
    // the remembered profile's unlock token before any profile is active
    // (api.me). The early one went out with the same token, or with none.
    let token = authToken || "";
    if (options.headers) {
      const names = Object.keys(options.headers);
      if (names.length !== 1 || names[0] !== "X-Profile-Token") return null;
      token = options.headers["X-Profile-Token"] || "";
    }
    const key = `${url}|${token}`;
    const hit = store[key];
    if (!hit) return null;
    delete store[key];
    return performance.now() - hit.at <= EARLY_MAX_AGE_MS ? hit : null;
  } catch {
    return null;
  }
};

// ---- how long a request may take ----
// Nothing here used to give up: a server that accepted a request and then
// said nothing left Home on its skeleton for as long as the browser cared to
// wait (minutes), and a history read that never answered left the page blank,
// because boot waits for it. Now a request that has not begun to answer in
// time fails like any request that fails — into the screen's own "couldn't
// load / Try again", and for the history into "could not be read", which is
// what the player's refusal to save over an unread history keys on
// (state.js refreshProgress, player.js).
// The limit is for the FIRST BYTE. An answer that has started may take as
// long as it takes while bytes keep coming; only a silence ends it. (The TV
// app's rule and numbers — tv-native/src/api.ts — where a fixed limit on the
// whole answer was measured turning a slow line into "the server took too
// long" on every list.) Generous on purpose: a slow answer that is still
// coming is not a dead one.
//   what boot waits for before it can draw anything      20 s
//   reads                                                45 s
//   the calls that think, and the big lists              90 s
//   writes                                               30 s
//   a file on its way up (an avatar)                     no limit
const IDLE_MS = 30000;
const BOOT_PATHS = /^\/api\/(me|server-info|profiles|profiles\/[^/]+\/state)$/;
const BIG_PATHS = /^\/api\/(ai\/|torrents\/sources|discover\/(search|catalog)|catalog|xray|library|browse|search|person\/)/;
export const requestLimitMs = (url, options = {}) => {
  if (options.body != null && typeof options.body !== "string") return 0;
  const path = String(url).split("?")[0];
  if (BIG_PATHS.test(path)) return 90000;
  if (BOOT_PATHS.test(path)) return 20000;
  return String(options.method || "GET").toUpperCase() === "GET" ? 45000 : 30000;
};
// What a caller catches. Not an AbortError: that name means "the caller gave
// up" and is passed over in silence everywhere (the error reports included —
// this one is counted, as a request that got no answer).
const tooSlow = (url, why = "The server took too long to answer") => {
  const err = new Error(why);
  err.name = "TimeoutError";
  err.timeout = true;
  err.url = url;
  return err;
};
// `p`, or a TimeoutError after `ms` (0: no limit).
const within = (p, ms, url, why) => {
  if (!(ms > 0)) return p;
  let timer = 0;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(tooSlow(url, why)), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};
// The answer's text, given up on only when the line goes quiet for IDLE_MS.
const readText = async (res, url, giveUp = null) => {
  const quiet = "The connection went quiet";
  const fail = (err) => { if (err && err.timeout && giveUp) { try { giveUp(err); } catch {} } throw err; };
  // (no readable stream to watch — an old browser, a stubbed answer: the whole text, on a longer leash)
  if (!res.body || typeof res.body.getReader !== "function") return within(res.text(), IDLE_MS * 2, url, quiet).catch(fail);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await within(reader.read(), IDLE_MS, url, quiet);
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (err) {
    try { reader.cancel().catch(() => {}); } catch {}
    return fail(err);
  }
};

const json = async (url, options = {}, attempt = 0) => {
  let res = null;
  const limit = requestLimitMs(url, options);
  const early = attempt === 0 ? takeEarly(url, options) : null;
  if (early) {
    let r = null;
    try {
      // (its time started when the page asked, not now)
      r = await within(early.res, limit ? Math.max(1, limit - (performance.now() - early.at)) : 0, url);
    } catch (err) {
      // it has had its time: the same end as the ordinary request below,
      // not a second wait of the same length. Any other failure is asked again.
      if (err && err.timeout) throw err;
    }
    // (a 429 is an answer too — "wait, then ask again": the turn-taking below
    // waits what the server asked instead of asking again this instant)
    if (r && (r.ok || r.status === 429)) res = r;
  }
  // One switch ends the request, whoever pulls it: the caller's own signal
  // (a newer search replaced this one), the first-byte limit, or an answer
  // that went quiet half-way.
  const ctrl = !res && typeof AbortController === "function" ? new AbortController() : null;
  let late = null;
  if (!res) {
    const outer = options.signal;
    if (ctrl && outer) {
      if (outer.aborted) ctrl.abort();
      else outer.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    const timer = ctrl && limit ? setTimeout(() => { late = tooSlow(url); ctrl.abort(late); }, limit) : 0;
    try {
      res = await fetch(url, { ...options, ...(ctrl ? { signal: ctrl.signal } : {}), headers: withBlur(options, withToken(options.headers)) });
    } catch (err) {
      // the limit: no second try — the screen's own "Try again" is the retry
      if (late) throw late;
      // the caller gave up on this one (a newer search replaced it): not a blip
      if (err && err.name === "AbortError") throw err;
      // A network blip (flaky wifi, server restarting). GETs are idempotent —
      // retry twice with a breath between instead of failing the screen.
      // HTTP error statuses are NOT retried here: some are meaningful signals
      // (the transcode probe's 504 means "not ready", not "try again").
      const method = (options.method || "GET").toUpperCase();
      // (two retries, ~1.2s in all — a dead server used to take 2.5s to admit)
      if (method === "GET" && attempt < 2) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1) + Math.random() * 150));
        return json(url, options, attempt + 1);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  // "Too many at once — try again in a moment" (the server's turn-taking for
  // its heavy answers, lib/admission.js): wait what it asks, plus a random
  // bit so a crowd does not come back together, and ask again. Twice at most.
  if (res.status === 429 && (options.method || "GET").toUpperCase() === "GET" && attempt < 2) {
    const after = Math.min(5, Math.max(0.5, parseFloat(res.headers.get("Retry-After")) || 1));
    try { if (res.body) res.body.cancel().catch(() => {}); } catch {} // (its body is not read: let the connection go)
    await new Promise((r) => setTimeout(r, after * 1000 + Math.random() * 1500));
    // (the next try has its own time limit: being asked to wait is not the server failing to answer)
    return json(url, options, attempt + 1);
  }
  const giveUp = ctrl ? (err) => ctrl.abort(err) : null;
  if (!res.ok) {
    // Surface the server's own `error` when it sent one: routes reject with a
    // message written for the viewer ("that name is already taken"), which is
    // far more use than "400 /api/profiles". Falls back to the status line.
    let msg = "";
    let body = null;
    try { body = JSON.parse(await readText(res, url, giveUp)); msg = (body && body.error) || ""; } catch {}
    const err = new Error(msg || `${res.status} ${url}`);
    // the status, and the one flag a caller acts on: "ask for the household PIN"
    err.status = res.status;
    if (body && body.pinRequired) err.pinRequired = true;
    if (body && body.code) err.code = body.code;
    // A new password is due on the profile this tab is using (the admin's
    // "Reset password"): the server refuses everything until one is saved.
    // Read BEFORE `signinRequired` — the refusal carries both, the second for
    // clients that do not know the first. The app raises the screen that asks
    // for the new password (resetwall.js, through main.js).
    if (res.status === 401 && body && body.passwordResetRequired) {
      err.passwordResetRequired = true;
      try { window.dispatchEvent(new CustomEvent("aurora-password-reset", { detail: { url, profileId: body.profileId || null } })); } catch {}
      throw err;
    }
    // The admin signed this profile out (Kick, Reset password) and this tab
    // is still showing the unlock it had: back to the sign-in / profile wall.
    if (res.status === 401 && body && body.signedOut) {
      err.signedOut = true;
      try { window.dispatchEvent(new CustomEvent("aurora-signed-out", { detail: { url } })); } catch {}
      throw err;
    }
    // The sign-in wall refused this (the server began to require sign-in, or
    // this session was revoked or ran out). The caller still gets its error;
    // the app is told too, so it can go to the sign-in screen (session.js)
    // instead of every screen failing on its own.
    if (res.status === 401 && body && body.signinRequired) {
      err.signinRequired = true;
      try { window.dispatchEvent(new CustomEvent("aurora-signin-required", { detail: { url } })); } catch {}
    }
    throw err;
  }
  // the tiny pictures that ride beside an answer go to blur.js; the screen
  // gets the answer it always got
  return takeBlur(JSON.parse(await readText(res, url, giveUp)));
};

let changelogP = null;
let versionP = null;

// ---- a short-lived cache for idempotent GETs a screen is likely to ask for
// next (prefetch.js fills it; the pages read through the same api.* calls).
// TTLs are short and anything that changes a list on the server forgets its
// entries first (see toggleWatchlist), so a warmed answer is never stale in
// a way a viewer could notice. A failed fetch drops out at once.
const warm = new Map(); // url -> { at, p }
const WARM_TTL = 90 * 1000;
// `low` marks a prefetch: the browser queues it behind anything the screen
// is actually waiting for (Fetch Priority API; ignored where unsupported).
const warmed = (url, ttl = WARM_TTL, { low = false } = {}) => {
  const hit = warm.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = json(url, low ? { priority: "low" } : {});
  warm.set(url, { at: Date.now(), p });
  p.catch(() => warm.delete(url));
  return p;
};
// Drop warmed answers whose URL starts with `prefix` (no prefix: all).
export const forgetWarm = (prefix = "") => {
  for (const k of [...warm.keys()]) if (k.startsWith(prefix)) warm.delete(k);
};

const post = (url, body) =>
  json(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const homeInFlight = new Map(); // profile id -> the request on its way

export const api = {
  // An AirPlay link for the stream an Apple TV should play (public/js/airplay.js,
  // src/routes/airplay.js) -> { url, expiresAt, needed }
  airplayLink: (path, profileId) => post("/api/airplay/link", { path, ...(profileId ? { profile: profileId } : {}) }),
  // `profileId` rides in the address so the offline copy the service worker
  // keeps (it caches by URL) is one per profile: a kids profile offline must
  // never be handed the list a grown-up loaded on the same device. The server
  // reads `profile` only to recognise a kids profile.
  library: (profileId) => json(profileId ? `/api/library?profile=${encodeURIComponent(profileId)}` : "/api/library"),
  // One Home request in flight per profile, whoever asks: the screen, its
  // refresh after a library change and the prefetch share the same answer
  // instead of each fetching the heaviest thing the server makes.
  home: (profileId) => {
    const key = profileId || "";
    let p = homeInFlight.get(key);
    if (!p) {
      p = json(`/api/home?profile=${encodeURIComponent(key)}`).finally(() => homeInFlight.delete(key));
      homeInFlight.set(key, p);
    }
    return p;
  },
  // Pass the active profile so torrent items can be rebuilt from stored state
  // after a page refresh (harmless for library items).
  // `low`: a prefetch (prefetch.js) — same answer, queued behind real work
  item: (id, { low = false } = {}) => {
    let profile = "";
    try { profile = localStorage.getItem("aurora-profile") || ""; } catch {}
    // ?caps=: how the file plays in THIS browser comes back with it (`play`)
    const caps = capsIdNow ? `${profile ? "&" : "?"}caps=${capsIdNow}` : "";
    return warmed(`/api/item/${encodeURIComponent(id)}${profile ? `?profile=${encodeURIComponent(profile)}` : ""}${caps}`, 60 * 1000, { low });
  },
  // what this browser can play (avcaps.js) → { id }
  reportCaps: (report) => post("/api/caps", report),
  search: (q) => json(`/api/search?q=${encodeURIComponent(q)}`),
  // The one ranked search (library + catalogue + a related tail). `wait`:
  // also wait for the live catalogue; `pin`: the card that is first now.
  // `voice`: q is what the microphone heard (the server tidies it, media/spoken.js).
  searchAll: (q, { wait = false, commit = false, voice = false, pin = null, profileId = "", signal } = {}) =>
    json(
      `/api/search?v=2&q=${encodeURIComponent(q)}${wait ? "&wait=1" : ""}${commit ? "&commit=1" : ""}${voice ? "&voice=1" : ""}` +
        `${pin ? `&pin=${encodeURIComponent(pin)}` : ""}${profileId ? `&profile=${encodeURIComponent(profileId)}` : ""}`,
      { signal },
    ),
  // Recent searches live on the server, per profile: every device shows the same list.
  recentSearches: (profileId) => json(`/api/profiles/${profileId}/searches`),
  addRecentSearch: (profileId, q) => post(`/api/profiles/${profileId}/searches`, { q }),
  removeRecentSearch: (profileId, q) =>
    json(`/api/profiles/${profileId}/searches`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(q == null ? {} : { q }),
    }),

  // Torrent stream sources for a title (movies + per-episode series)
  torrentSources: ({ type, title, year, season, episode }) => {
    const p = new URLSearchParams({ type, title });
    if (year) p.set("year", year);
    if (season) p.set("season", season);
    if (episode) p.set("episode", episode);
    return json(`/api/torrents/sources?${p.toString()}`);
  },
  torrentStatus: (infoHash) => json(`/api/torrents/status/${infoHash}`),
  // The library copy of a stream identity (movie, or one episode), or null.
  libraryFor: ({ imdbId, type, title, year, season, episode }) => {
    const p = new URLSearchParams();
    if (imdbId) p.set("imdbId", imdbId);
    if (type) p.set("type", type);
    if (title) p.set("title", title);
    if (year) p.set("year", year);
    if (season) p.set("season", season);
    if (episode) p.set("episode", episode);
    return json(`/api/library/for?${p.toString()}`).then((r) => (r && r.item) || null);
  },
  discoverMeta: (type, id, { low = false } = {}) => warmed(`/api/discover/meta/${type}/${id}`, 10 * 60 * 1000, { low }),
  discoverCollection: (type, id, tmdbId) =>
    json(
      `/api/discover/collection/${type}/${encodeURIComponent(id)}${tmdbId ? `?tmdbId=${tmdbId}` : ""}`,
    ),
  // Asked by the gear dot, the New tab's dot, the report sheet and the
  // pages themselves — one request, shared (a failure lets the next ask retry).
  changelog: () => changelogP || (changelogP = json("/api/changelog").catch((e) => { changelogP = null; throw e; })),
  // { version } alone — what the nav's dots need at boot (the full changelog
  // is only fetched by the page that prints it)
  version: () => versionP || (versionP = json("/api/changelog?head=1").catch((e) => { versionP = null; throw e; })),
  introAuto: (id) => json(`/api/intro/auto/${encodeURIComponent(id)}`),
  // intro / recap / credits for a STREAMED episode, by identity (the public
  // databases — a stream has no file to analyse)
  // Which episode comes after this one — the server's one rule for the
  // website and the TV (src/media/nextep.js). By library episode id, or by a
  // streamed episode's identity. → { next: null | {kind:"library"|"stream",…} }
  nextEpisode: ({ id, imdbId, season, episode, title, year }) => {
    const p = new URLSearchParams();
    if (id) p.set("id", id);
    else {
      p.set("imdbId", imdbId);
      p.set("season", season);
      p.set("episode", episode);
      if (title) p.set("title", title);
      if (year) p.set("year", year);
    }
    return json(`/api/next-episode?${p.toString()}`);
  },
  segments: ({ imdbId, season, episode, duration }) =>
    json(`/api/segments?imdbId=${encodeURIComponent(imdbId)}${season ? `&season=${season}` : ""}${episode ? `&episode=${episode}` : ""}${duration ? `&duration=${Math.round(duration)}` : ""}`),
  // cast, crew, ratings, facts — and one episode's own, for a series
  xray: ({ type, imdbId, season, episode, keys }) =>
    warmed(`/api/xray?type=${type}&imdbId=${encodeURIComponent(imdbId)}` +
      (season ? `&season=${season}&episode=${episode}` : "") + (keys && keys.length ? `&keys=${encodeURIComponent(keys.join(","))}` : ""), 10 * 60 * 1000),
  // A person (the sheet behind a press on an actor or director): `id` is what
  // X-Ray handed out ("tmdb:525") or "name:<their name>" with the title it was
  // pressed on. Not warmed: its titles carry this profile's My List marks.
  person: (id, { of = null, type = null, profile = null } = {}) =>
    json(`/api/person/${encodeURIComponent(id)}?` + [
      of && `of=${encodeURIComponent(of)}`, type && `type=${encodeURIComponent(type)}`, profile && `profile=${encodeURIComponent(profile)}`,
    ].filter(Boolean).join("&")),
  // what the household has been watching lately (the empty Search screen)
  popular: (profileId) => warmed(`/api/popular?profile=${encodeURIComponent(profileId || "")}`, 5 * 60 * 1000),
  party: (code) => json(`/api/party/${encodeURIComponent(code)}`),
  // q: original | 1080 | 720 | 480; hevc: this browser plays HEVC in MP4
  offlineOptions: (id, hevc) => json(`/api/offline/options/${encodeURIComponent(id)}${hevc ? "?hevc=1" : ""}`),
  offlinePrepare: (id, q, hevc) => post(`/api/offline/prepare/${encodeURIComponent(id)}?q=${encodeURIComponent(q || "720")}${hevc ? "&hevc=1" : ""}`, {}),
  offlineStatus: (id, q, hevc) => json(`/api/offline/status/${encodeURIComponent(id)}?q=${encodeURIComponent(q || "720")}${hevc ? "&hevc=1" : ""}`),
  // the phone's Cancel: the server stops making a copy nobody else waits for
  offlineCancel: (id, q) => post(`/api/offline/cancel/${encodeURIComponent(id)}?q=${encodeURIComponent(q || "720")}`, {}),
  parties: () => json("/api/party"),
  // `profileId` (optional): the row comes back in that person's order, with
  // what they have already watched left out.
  discoverSimilar: (type, id, tmdbId, profileId) => {
    const q = [tmdbId ? `tmdbId=${tmdbId}` : "", profileId ? `profile=${encodeURIComponent(profileId)}` : ""].filter(Boolean).join("&");
    return json(`/api/discover/similar/${type}/${encodeURIComponent(id)}${q ? `?${q}` : ""}`);
  },
  // One page of a Browse category (see /api/catalog). Paged per genre, so a
  // niche genre has a deep list of its own rather than a slice of trending.
  catalog: ({ type, category, genre, page = 0, low = false }) =>
    warmed(`/api/catalog?type=${encodeURIComponent(type)}&category=${encodeURIComponent(category)}` +
      (genre ? `&genre=${encodeURIComponent(genre)}` : "") + `&page=${page}`, WARM_TTL, { low }),
  catalogGenres: (type, { low = false } = {}) => warmed(`/api/catalog/genres?type=${encodeURIComponent(type)}`, 10 * 60 * 1000, { low }),
  // The IMDb id for a library title, so the one detail page can also offer
  // stream sources for something you already own (see /api/imdb-for).
  imdbFor: (type, title, year) =>
    json(`/api/imdb-for?type=${encodeURIComponent(type)}&title=${encodeURIComponent(title)}` +
      (year ? `&year=${encodeURIComponent(year)}` : "")),
  discover: () => json("/api/discover"),
  discoverSearch: (q) => json(`/api/discover/search?q=${encodeURIComponent(q)}`),
  // release: the stream's file name — the subtitles timed for it come first
  torrentSubtitles: (type, id, season, episode, release = null) => {
    const p = new URLSearchParams();
    if (season) p.set("season", season);
    if (episode) p.set("episode", episode);
    if (release) p.set("release", String(release).slice(0, 200));
    const qs = p.toString();
    return json(`/api/torrents/subtitles/${type}/${id}${qs ? "?" + qs : ""}`);
  },

  serverInfo: () => json("/api/server-info"),

  // ---- sign-in (prompt 10). The session rides an HttpOnly cookie the browser
  // sends by itself — nothing to attach client-side.
  // `token`: an unlock token to ask with, before any profile is active (boot
  // asks whether the profile this tab remembers owes a new password)
  me: (token) => json("/api/me", token ? { headers: { "X-Profile-Token": token } } : {}),
  login: (username, password) => post("/api/auth/login", { username, password }),
  logout: () => post("/api/auth/logout", {}),
  signupRequest: (fields) => post("/api/auth/signup", fields),
  accountSessions: () => json("/api/auth/sessions"),
  revokeSession: (key) => json(`/api/auth/sessions/${encodeURIComponent(key)}`, { method: "DELETE" }),
  // transition-mode onboarding: is there an unclaimed account behind this
  // profile, and claim it (sets username/password/email, signs you in)
  claimable: (profileId) => json(`/api/auth/claimable/${encodeURIComponent(profileId)}`),
  claimAccount: (fields) => post("/api/auth/claim", fields),
  // session → profile unlock token (a signed-in device never retypes the password)
  sessionProfileToken: () => post("/api/auth/profile-token", {}),
  setProfileEmail: (profileId, email) => post(`/api/profiles/${encodeURIComponent(profileId)}/email`, { email }),
  googleWebFinish: (state) => post("/api/auth/google/web-finish", { state }),
  // TV pairing by QR: the phone's confirm screen (#/pair/:code)
  devicePairDescribe: (code) => json(`/api/auth/device/describe/${encodeURIComponent(code)}`),
  devicePairApprove: (code) => post("/api/auth/device/approve", { code }),
  googleStart: () => post("/api/auth/google/start", {}),
  googlePoll: (pollId) => post("/api/auth/google/poll", { pollId }),
  googleLink: (pollId) => post("/api/auth/google/link", { pollId }),
  suggest: (q, type, limit, { profileId = "", signal } = {}) =>
    json(
      `/api/search/suggest?v=2&q=${encodeURIComponent(q)}${type ? `&type=${type}` : ""}${limit ? `&limit=${limit}` : ""}` +
        `${profileId ? `&profile=${encodeURIComponent(profileId)}` : ""}`,
      { signal },
    ),
  intro: (key) => json(`/api/intro/${encodeURIComponent(key)}`),
  subtitlesFetch: (id, lang) => post("/api/subtitles/fetch", { id, lang }),
  // The subtitle Resync button: the track on screen lined up with what is
  // SAID in the film (src/media/subaudio.js). body: { id, track (its url as
  // listed), audio (the playing audio track, 0-based) } -> the job:
  // { state: "listening"|"matching"|"done"|"failed"|"none", progress, verdict, applied, words, parts, ms, timing }
  subtitleResync: (body) => post("/api/subtitles/resync", body),
  subtitleResyncStatus: (body) => post("/api/subtitles/resync/status", body),
  subtitleResyncUndo: (body) => post("/api/subtitles/resync/undo", body),
  report: (text, context, profile) => post("/api/reports", { text, context, profile }),
  setIntro: (key, start, end) => {
    let by = null;
    try { by = (JSON.parse(localStorage.getItem("aurora-profile-name") || "null")); } catch {}
    return post(`/api/intro/${encodeURIComponent(key)}`, { start, end, by });
  },
  clearIntro: (key) =>
    json(`/api/intro/${encodeURIComponent(key)}`, { method: "DELETE" }),
  profiles: () => json("/api/profiles"),
  // `pin`: the household PIN, which opens a grown-up's profile that has no
  // password once the house has a kids profile (the server answers
  // `pinRequired` when it wants one)
  unlockProfile: (id, password, pin) => post(`/api/profiles/${id}/unlock`, pin ? { password, pin } : { password }),
  // `clientId` (optional): this tab's socket, so a forced reset saved here
  // does not tell this very tab that the profile was signed out
  setPassword: (id, newPassword, currentPassword, clientId) =>
    post(`/api/profiles/${id}/password`, { newPassword, currentPassword, ...(clientId ? { clientId } : {}) }),
  createProfile: (fields) => post("/api/profiles", fields),
  // Seconds watched today — only the narrator's "you've been at this a while" uses it.
  todayWatchTime: (id) => json(`/api/profiles/${encodeURIComponent(id)}/today`),
  wrapped: (id) => json(`/api/profiles/${id}/wrapped`),
  uploadAvatar: (id, file) =>
    json(`/api/profiles/${id}/avatar-image`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }),
  removeAvatar: (id) => json(`/api/profiles/${id}/avatar-image`, { method: "DELETE" }),
  taste: (id) => json(`/api/profiles/${id}/taste`),
  follow: (id, imdbId, on, title) => post(`/api/profiles/${id}/follow`, { imdbId, on, title }),
  pushKey: () => json("/api/push/key"),
  pushSet: (id, body) => post(`/api/profiles/${id}/push`, body),
  // `clientId`: this tab's own socket (ws.js keeps it), so the server does not
  // tell the tab that asked that it was signed out
  signOutEverywhere: (id, clientId) => post(`/api/profiles/${id}/signout-everywhere`, clientId ? { clientId } : {}),
  setTaste: (id, liked) => post(`/api/profiles/${id}/taste`, { liked }),
  // the swipe picker: the next cards, and one answer (verdict null = take it back)
  tasteDeck: (id, { n = 6, queued = [] } = {}) =>
    json(`/api/profiles/${id}/taste/deck?n=${n}${queued.length ? `&queued=${queued.map(encodeURIComponent).join(",")}` : ""}`),
  tasteAnswer: (id, body) => post(`/api/profiles/${id}/taste/answer`, body),
  updateProfile: (id, fields) =>
    json(`/api/profiles/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }),
  deleteProfile: (id) => json(`/api/profiles/${id}`, { method: "DELETE" }),
  // ---- kids profiles. The server locks this browser to a kids profile with
  // a cookie of its own on enter; only the household PIN lifts it (exit).
  // { pinSet, ages, lock: { profile, maxAge } | null }
  kidsStatus: () => json("/api/kids/status"),
  kidsEnter: (profile, pin) => post("/api/kids/enter", { profile, pin }),
  kidsExit: (pin) => post("/api/kids/exit", { pin }),
  // body: { kids: { maxAge } | null, pin } — or { kids, newPin } while the
  // household has no PIN yet
  setKids: (id, body) => post(`/api/profiles/${encodeURIComponent(id)}/kids`, body),
  profileState: (id) => json(`/api/profiles/${id}/state`),
  // `item` (optional) is the torrent play-item meta, so Continue Watching can
  // render + resume streamed content.
  saveProgress: (id, itemId, position, duration, item) =>
    post(`/api/profiles/${id}/progress`, { itemId, position, duration, item }),
  clearProgress: (id, itemId) =>
    json(`/api/profiles/${id}/progress/${itemId}`, { method: "DELETE" }),
  // Mark watched / unwatched by hand — never read as "watched it just now"
  // (no smart download, no Continue Watching bump). Unwatched puts back what
  // the mark replaced; `restore` sends a snapshot row ({position, duration,
  // finished, updatedAt}) to put back instead. One entry, or { items: [...] }.
  markWatched: (id, entry) => post(`/api/profiles/${id}/progress/mark`, entry),
  // Hide a show's synthesized "up next" card. clearProgress can't — the card's
  // id is the NEXT episode's, while the progress row lives under the previous
  // one, so deleting by the card's id was a silent no-op.
  dismissUpNext: (id, showId, episodeId) =>
    post(`/api/profiles/${id}/upnext-dismiss`, { showId, episodeId }),
  // itemOrRef: a local id string, or a stream ref {imdbId, type, title, poster, year}
  toggleWatchlist: (id, itemOrRef, add) => {
    forgetWarm(`/api/profiles/${id}/watchlist`); // the list is about to change
    return post(`/api/profiles/${id}/watchlist`,
      typeof itemOrRef === "string" ? { itemId: itemOrRef, add } : { stream: itemOrRef, add });
  },
  watchlist: (id, { low = false } = {}) => warmed(`/api/profiles/${id}/watchlist`, 60 * 1000, { low }),
  rate: (id, itemId, stars) => post(`/api/profiles/${id}/rating`, { itemId, stars }),
  setPreferences: (id, likedGenres) => post(`/api/profiles/${id}/preferences`, { likedGenres }),

  // AI recommender (the "AI" tab). Status is what decides whether the nav
  // entry exists at all, so it must never throw.
  aiStatus: () => json("/api/ai/status").catch(() => ({ enabled: false })),
  aiRecommend: (vibe, mix, era, length) =>
    post("/api/ai/recommend", { vibe, mix, era, length }),

  // Download-to-server
  downloads: (profileId) => json(`/api/downloads${profileId ? `?profile=${encodeURIComponent(profileId)}` : ""}`),
  requestDownload: (fields) => post("/api/downloads", fields),
  // The requester opened a finished download: clear its "ready" nudge.
  downloadSeen: (id, profile) => post(`/api/downloads/${encodeURIComponent(id)}/seen`, { profile }),
  downloadCancel: (id, profile) => post(`/api/downloads/${encodeURIComponent(id)}/cancel`, { profile }),
  // Clear a failed / declined / canceled request of yours off the page.
  downloadDismiss: (id, profile) => post(`/api/downloads/${encodeURIComponent(id)}/dismiss`, { profile }),
};
