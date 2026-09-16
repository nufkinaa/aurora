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
  authMode: "open",     // "open" | "transition" | "closed" (from /api/me at boot)
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
  // The look: glass is the default; "legacy" is the classic design. No
  // profile yet (the door) also shows glass.
  const look = profile && profile.look === "legacy" ? null : "glass";
  {
    const root = document.documentElement;
    const was = root.dataset.look || null;
    if (look) root.dataset.look = look;
    else delete root.dataset.look;
    try {
      localStorage.setItem("aurora-look", look || "legacy");
    } catch {}
    if (was !== look) window.dispatchEvent(new CustomEvent("aurora-look", { detail: { look } }));
  }
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
  // The profile's subtitle language lands in this device's player settings
  // (the player and Preferences read those), so every device agrees.
  if (profile && profile.prefs && ["any", "he", "en", "ru"].includes(profile.prefs.subLang)) {
    try {
      const all = JSON.parse(localStorage.getItem("aurora-player") || "{}");
      if (all.subLang !== profile.prefs.subLang) {
        all.subLang = profile.prefs.subLang;
        localStorage.setItem("aurora-player", JSON.stringify(all));
      }
    } catch {}
  }
  // storage can be unavailable (private mode, restrictive embeds) — losing
  // the remember-me must never abort profile entry itself
  try { localStorage.setItem("aurora-profile", profile.id); localStorage.setItem("aurora-profile-name", JSON.stringify(profile.name || null)); } catch {}
  rememberRecentProfile(profile.id);
  // Remember the unlock token for THIS browser session only (sessionStorage
  // clears when the browser closes) so reloads/navigation don't re-prompt, but
  // a fresh session still requires the password.
  try {
    if (token) sessionStorage.setItem(`aurora-token-${profile.id}`, token);
  } catch {}
  await refreshProgress();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "hello", profile: profile.name, profileId: profile.id }));
  }
  window.dispatchEvent(new CustomEvent("aurora-profile", { detail: { profile } }));
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
    // Offline (or a blip): keep what we have — wiping it would drop every
    // resume point the moment the server is out of reach.
    if (!state.progress) state.progress = {};
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

// ---------- the download queue, as this profile sees it ----------
// One map fed by /api/downloads at boot and the download_update stream after
// (main.js). The server marks each job "mine" for the asking profile and
// never says who asked otherwise, so "mine" is the whole filter.
export const downloads = new Map();
export const myDownloads = () => (state.profile ? [...downloads.values()].filter((j) => j.mine) : []);
// Finished, indexed, and not yet opened by the person who asked for it.
export const readyDownloads = () =>
  myDownloads().filter((j) => j.status === "done" && j.libraryId && !j.seenAt);

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
  // One entry per EPISODE (or per film), whichever alias it was watched under:
  // the library file and the same episode's stream both key to "season:episode",
  // so a title watched twice is still one title — and a two-episode show with
  // one episode seen is not "finished" because that episode came in twice.
  const byKey = new Map();
  const add = (key, p) => {
    if (!p) return;
    const cur = byKey.get(key);
    if (!cur || (cur.updatedAt || 0) < (p.updatedAt || 0)) byKey.set(key, p);
  };
  const libKeys = new Set();
  if (isShow) {
    for (const s of item.seasons || []) {
      for (const e of s.episodes || []) {
        const key = `${e.season ?? s.number}:${e.episode}`;
        libKeys.add(key);
        add(key, state.progress[e.id]);
      }
    }
    if (item.imdbId) {
      const prefix = `${item.imdbId}:`;
      for (const [key, p] of Object.entries(state.episodeProgress)) {
        if (key.startsWith(prefix)) add(key.slice(prefix.length), p);
      }
    }
  } else {
    add("film", state.progress[item.id]);
    if (item.imdbId) {
      add("film", state.streamProgress[item.imdbId]);
      add("film", state.progress[`stream|${item.imdbId}`]);
    }
  }

  const seen = [...byKey.values()];
  const doneKeys = new Set([...byKey].filter(([, p]) => p.finished).map(([k]) => k));
  return {
    started: seen.length > 0,
    // A series is only done when every episode we can see is done. For a
    // streamable one we cannot see the full run at all, so it stays "in
    // progress" rather than claiming you finished it after one episode.
    finished: isShow
      ? libKeys.size > 0 && [...libKeys].every((k) => doneKeys.has(k))
      : doneKeys.size > 0,
    at: seen.reduce((latest, p) => Math.max(latest, p.updatedAt || 0), 0),
  };
};

// The title's history for an item that has no alias row of its own yet — a
// torrent of an episode watched before from another source, or a stream item
// for a film played as a library file. Same identity, so same resume point.
export const titleProgressFor = (item) => {
  if (!item || !item.imdbId) return null;
  if (item.season != null && item.episode != null) {
    return state.episodeProgress[`${item.imdbId}:${item.season}:${item.episode}`] || null;
  }
  return state.streamProgress[item.imdbId] || null;
};
