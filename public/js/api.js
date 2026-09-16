// Thin API client.

// Unlock token for the active protected profile, attached to every request so
// the server lets through reads/writes for that profile.
let authToken = null;
export const setAuthToken = (t) => { authToken = t || null; };

const withToken = (headers = {}) =>
  authToken ? { ...headers, "X-Profile-Token": authToken } : headers;

const json = async (url, options = {}, attempt = 0) => {
  let res;
  try {
    res = await fetch(url, { ...options, headers: withToken(options.headers) });
  } catch (err) {
    // A network blip (flaky wifi, server restarting). GETs are idempotent —
    // retry twice with a breath between instead of failing the screen.
    // HTTP error statuses are NOT retried here: some are meaningful signals
    // (the transcode probe's 504 means "not ready", not "try again").
    const method = (options.method || "GET").toUpperCase();
    // (two retries, ~1.2s in all — a dead server used to take 2.5s to admit)
    if (method === "GET" && attempt < 2) {
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1) + Math.random() * 150));
      return json(url, options, attempt + 1);
    }
    throw err;
  }
  if (!res.ok) {
    // Surface the server's own `error` when it sent one: routes reject with a
    // message written for the viewer ("that name is already taken"), which is
    // far more use than "400 /api/profiles". Falls back to the status line.
    let msg = "";
    try { msg = (await res.json()).error || ""; } catch {}
    throw new Error(msg || `${res.status} ${url}`);
  }
  return res.json();
};

let changelogP = null;

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

export const api = {
  library: () => json("/api/library"),
  home: (profileId) => json(`/api/home?profile=${encodeURIComponent(profileId || "")}`),
  // Pass the active profile so torrent items can be rebuilt from stored state
  // after a page refresh (harmless for library items).
  // `low`: a prefetch (prefetch.js) — same answer, queued behind real work
  item: (id, { low = false } = {}) => {
    let profile = "";
    try { profile = localStorage.getItem("aurora-profile") || ""; } catch {}
    return warmed(`/api/item/${encodeURIComponent(id)}${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`, 60 * 1000, { low });
  },
  search: (q) => json(`/api/search?q=${encodeURIComponent(q)}`),

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
  introAuto: (id) => json(`/api/intro/auto/${encodeURIComponent(id)}`),
  party: (code) => json(`/api/party/${encodeURIComponent(code)}`),
  offlinePrepare: (id) => post(`/api/offline/prepare/${encodeURIComponent(id)}`, {}),
  offlineStatus: (id) => json(`/api/offline/status/${encodeURIComponent(id)}`),
  parties: () => json("/api/party"),
  discoverSimilar: (type, id, tmdbId) =>
    json(
      `/api/discover/similar/${type}/${encodeURIComponent(id)}${tmdbId ? `?tmdbId=${tmdbId}` : ""}`,
    ),
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
  torrentSubtitles: (type, id, season, episode) => {
    const p = new URLSearchParams();
    if (season) p.set("season", season);
    if (episode) p.set("episode", episode);
    const qs = p.toString();
    return json(`/api/torrents/subtitles/${type}/${id}${qs ? "?" + qs : ""}`);
  },

  serverInfo: () => json("/api/server-info"),

  // ---- sign-in (prompt 10). The session rides an HttpOnly cookie the browser
  // sends by itself — nothing to attach client-side.
  me: () => json("/api/me"),
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
  suggest: (q, type, limit) =>
    json(`/api/search/suggest?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ""}${limit ? `&limit=${limit}` : ""}`),
  intro: (key) => json(`/api/intro/${encodeURIComponent(key)}`),
  subtitlesFetch: (id, lang) => post("/api/subtitles/fetch", { id, lang }),
  report: (text, context, profile) => post("/api/reports", { text, context, profile }),
  setIntro: (key, start, end) => {
    let by = null;
    try { by = (JSON.parse(localStorage.getItem("aurora-profile-name") || "null")); } catch {}
    return post(`/api/intro/${encodeURIComponent(key)}`, { start, end, by });
  },
  clearIntro: (key) =>
    json(`/api/intro/${encodeURIComponent(key)}`, { method: "DELETE" }),
  profiles: () => json("/api/profiles"),
  unlockProfile: (id, password) => post(`/api/profiles/${id}/unlock`, { password }),
  setPassword: (id, newPassword, currentPassword) =>
    post(`/api/profiles/${id}/password`, { newPassword, currentPassword }),
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
  setTaste: (id, liked) => post(`/api/profiles/${id}/taste`, { liked }),
  updateProfile: (id, fields) =>
    json(`/api/profiles/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }),
  deleteProfile: (id) => json(`/api/profiles/${id}`, { method: "DELETE" }),
  profileState: (id) => json(`/api/profiles/${id}/state`),
  // `item` (optional) is the torrent play-item meta, so Continue Watching can
  // render + resume streamed content.
  saveProgress: (id, itemId, position, duration, item) =>
    post(`/api/profiles/${id}/progress`, { itemId, position, duration, item }),
  clearProgress: (id, itemId) =>
    json(`/api/profiles/${id}/progress/${itemId}`, { method: "DELETE" }),
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
