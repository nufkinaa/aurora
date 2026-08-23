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
    if (method === "GET" && attempt < 2) {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1) + Math.random() * 300));
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
  item: (id) => {
    let profile = "";
    try { profile = localStorage.getItem("aurora-profile") || ""; } catch {}
    return json(`/api/item/${encodeURIComponent(id)}${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`);
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
  discoverMeta: (type, id) => json(`/api/discover/meta/${type}/${id}`),
  discoverSimilar: (type, id, tmdbId) =>
    json(
      `/api/discover/similar/${type}/${encodeURIComponent(id)}${tmdbId ? `?tmdbId=${tmdbId}` : ""}`,
    ),
  // One page of a Browse category (see /api/catalog). Paged per genre, so a
  // niche genre has a deep list of its own rather than a slice of trending.
  catalog: ({ type, category, genre, page = 0 }) =>
    json(`/api/catalog?type=${encodeURIComponent(type)}&category=${encodeURIComponent(category)}` +
      (genre ? `&genre=${encodeURIComponent(genre)}` : "") + `&page=${page}`),
  catalogGenres: (type) => json(`/api/catalog/genres?type=${encodeURIComponent(type)}`),
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
  suggest: (q, type, limit) =>
    json(`/api/search/suggest?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ""}${limit ? `&limit=${limit}` : ""}`),
  intro: (key) => json(`/api/intro/${encodeURIComponent(key)}`),
  setIntro: (key, start, end) =>
    post(`/api/intro/${encodeURIComponent(key)}`, { start, end }),
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
  toggleWatchlist: (id, itemOrRef, add) =>
    post(`/api/profiles/${id}/watchlist`,
      typeof itemOrRef === "string" ? { itemId: itemOrRef, add } : { stream: itemOrRef, add }),
  watchlist: (id) => json(`/api/profiles/${id}/watchlist`),
  rate: (id, itemId, stars) => post(`/api/profiles/${id}/rating`, { itemId, stars }),
  setPreferences: (id, likedGenres) => post(`/api/profiles/${id}/preferences`, { likedGenres }),

  // AI recommender (the "AI" tab). Status is what decides whether the nav
  // entry exists at all, so it must never throw.
  aiStatus: () => json("/api/ai/status").catch(() => ({ enabled: false })),
  aiRecommend: (vibe, mix, era, length) =>
    post("/api/ai/recommend", { vibe, mix, era, length }),

  // Download-to-server
  downloads: () => json("/api/downloads"),
  requestDownload: (fields) => post("/api/downloads", fields),
};
