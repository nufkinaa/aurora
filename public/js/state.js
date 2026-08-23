// App-wide state: active profile, cached library, playback progress.
import { api, setAuthToken } from "./api.js";

export const state = {
  profile: null,        // active profile object
  token: null,          // unlock token for a protected active profile (memory only)
  profiles: [],
  library: null,        // {movies, shows}
  progress: {},         // itemId -> {position, duration, finished}
  ratings: {},          // itemKey (id or imdbId) -> 1..5
  likedGenres: [],      // preferred genres for recommendations
  episodeProgress: {},  // "imdbId:season:episode" -> progress (streamed episodes)
  streamProgress: {},   // imdbId -> progress (streamed films)
  ws: null,
  pendingItems: {},     // id -> item handed to the player without a server round-trip
  adminName: "the admin", // what UI copy calls whoever runs the server (configurable)
  authMode: "open",     // "open" | "hybrid" | "required" (from /api/me at boot)
  user: null,           // signed-in account {id, username, name, profileIds, hasGoogle} or null
};

export const loadProfiles = async () => {
  // Best-effort: copy that mentions the admin reads fine with the fallback.
  api.serverInfo().then((info) => {
    if (info && info.adminName) state.adminName = info.adminName;
  }).catch(() => {});
  state.profiles = await api.profiles();
  const savedId = localStorage.getItem("aurora-profile");
  state.profile = state.profiles.find((p) => p.id === savedId) || null;
  return state.profiles;
};

// ---------- per-device profile recency ----------
// With a large household the picker can't be a flat wall of 50 tiles, so each
// DEVICE remembers the profiles it actually uses (most recent first) and the
// gate floats them to the top. Device-local on purpose: the TV in the living
// room and a kid's phone should each surface their own people.
const RECENTS_KEY = "aurora-recent-profiles";
const MAX_RECENTS = 10;

export const recentProfileIds = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const rememberRecentProfile = (id) => {
  try {
    const next = [id, ...recentProfileIds().filter((x) => x !== id)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {}
};

// `token` is the unlock token for a password-protected profile (from
// api.unlockProfile). Kept in memory only — never persisted — so a reload of a
// protected profile re-prompts for the password.
// Apply a profile's appearance (theme + accent) to the live document and
// mirror it in localStorage so the boot script in index.html paints the SAME
// look before the stylesheets on the next cold load — no flash.
export const applyAppearance = (profile) => {
  const theme = profile && (profile.theme === "oled" || profile.theme === "warm") ? profile.theme : null;
  const accent = profile && /^#[0-9a-f]{6}$/i.test(profile.accent || "") ? profile.accent : null;
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  if (accent) {
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-strong", accent);
    root.style.setProperty("--progress", accent);
    root.style.setProperty("--accent-rgb",
      [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16)).join(", "));
  } else {
    for (const v of ["--accent", "--accent-strong", "--progress", "--accent-rgb"])
      root.style.removeProperty(v);
  }
  try {
    if (theme) localStorage.setItem("aurora-theme", theme);
    else localStorage.removeItem("aurora-theme");
    if (accent) localStorage.setItem("aurora-accent", accent);
    else localStorage.removeItem("aurora-accent");
  } catch {}
};

export const setProfile = async (profile, token = null) => {
  state.profile = profile;
  state.token = token;
  setAuthToken(token);
  applyAppearance(profile);
  localStorage.setItem("aurora-profile", profile.id);
  rememberRecentProfile(profile.id);
  // Remember the unlock token for THIS browser session only (sessionStorage
  // clears when the browser closes) so reloads/navigation don't re-prompt, but
  // a fresh session still requires the password.
  try {
    if (token) sessionStorage.setItem(`aurora-token-${profile.id}`, token);
  } catch {}
  await refreshProgress();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "hello", profile: profile.name }));
  }
};

// A previously-unlocked token for this profile in this browser session, if any.
export const savedToken = (profileId) => {
  try { return sessionStorage.getItem(`aurora-token-${profileId}`); } catch { return null; }
};

export const refreshProgress = async () => {
  if (!state.profile) return;
  try {
    const { progress, ratings, likedGenres, episodeProgress, streamProgress } =
      await api.profileState(state.profile.id);
    state.progress = progress || {};
    state.ratings = ratings || {};
    state.likedGenres = likedGenres || [];
    state.episodeProgress = episodeProgress || {};
    state.streamProgress = streamProgress || {};
  } catch {
    state.progress = {};
  }
};

// The star rating for an item, by library id or IMDb id (0 = unrated).
export const ratingFor = (key) => (key && state.ratings[key]) || 0;

// Progress for a streamed episode (by show imdbId + season + episode), or null.
export const episodeProgressFor = (imdbId, season, episode) =>
  (imdbId && state.episodeProgress && state.episodeProgress[`${imdbId}:${season}:${episode}`]) || null;

export const loadLibrary = async (force = false) => {
  if (!state.library || force) {
    state.library = await api.library();
  }
  return state.library;
};

export const progressFor = (itemId) => state.progress[itemId] || null;

const episodeIdsOf = (item) =>
  ((item && item.seasons) || []).flatMap((s) => (s.episodes || []).map((e) => e.id)).filter(Boolean);

// What this profile's history says about a title: started, finished, and when it
// was last touched.
//
// Callers used to ask `progress[item.id]` directly, which only ever answers for a
// downloaded FILM. A show's history is filed under each EPISODE's own id, a
// streamed film's under the torrent file it played from, a streamed episode's in
// a separate map keyed by show — so the lookup came back empty for all three, and
// "Unwatched" happily offered you the series you finished last week.
export const watchState = (item) => {
  if (!item) return { started: false, finished: false, at: 0 };
  const isShow = item.type === "show";
  const episodeIds = isShow ? episodeIdsOf(item) : [];
  const found = [];

  if (isShow) {
    for (const id of episodeIds) found.push(state.progress[id]);
    if (item.imdbId) {
      for (const [key, p] of Object.entries(state.episodeProgress)) {
        if (key.startsWith(`${item.imdbId}:`)) found.push(p);
      }
    }
  } else {
    found.push(state.progress[item.id]);
    if (item.imdbId) found.push(state.streamProgress[item.imdbId], state.progress[`stream|${item.imdbId}`]);
  }

  const seen = found.filter(Boolean);
  const done = seen.filter((p) => p.finished).length;
  return {
    started: seen.length > 0,
    // A series is only done when every episode we can see is done. For a
    // streamable one we cannot see the full run at all, so it stays "in
    // progress" rather than claiming you finished it after one episode.
    finished: isShow ? episodeIds.length > 0 && done >= episodeIds.length : done > 0,
    at: seen.reduce((latest, p) => Math.max(latest, p.updatedAt || 0), 0),
  };
};
