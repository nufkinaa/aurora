// App-wide state: active profile, cached library, playback progress.
import { api, setAuthToken, forgetWarm } from "./api.js";
import { personPrefsFor, boxFrom } from "./personprefs.js";

export const state = {
  profile: null,        // active profile object
  token: null,          // unlock token for a protected active profile (memory only)
  profiles: [],
  library: null,        // {movies, shows}
  progress: {},         // itemId -> {position, duration, finished}
  historyOf: null,      // the profile id whose watch history the maps below were last READ for (null: never read)
  ratings: {},          // itemKey (id or imdbId) -> 1..5
  likedGenres: [],      // preferred genres for recommendations
  episodeProgress: {},  // "imdbId:season:episode" -> progress (streamed episodes)
  streamProgress: {},   // imdbId -> progress (streamed films)
  ws: null,
  clientId: null,       // this tab's socket, as the server names it (the welcome message)
  pendingItems: {},     // id -> item handed to the player without a server round-trip
  adminName: "the admin", // what UI copy calls whoever runs the server (configurable)
  // false on a server with "torrents": false in config.json — nothing that
  // streams or downloads from sources is offered then. The last answer is
  // remembered on the device so a reload knows before /api/server-info lands.
  torrents: (() => { try { return localStorage.getItem("aurora-torrents-off") !== "1"; } catch { return true; } })(),
  authMode: "open",     // "open" | "transition" | "closed" (from /api/me at boot)
  user: null,           // signed-in account {id, username, name, profileIds, hasGoogle} or null
};

// Settles once /api/server-info has answered (or failed, or two seconds have
// gone by): a screen whose buttons depend on a server fact waits on this, so a
// deep link opened cold does not paint buttons the server will refuse.
let serverInfoP = null;
export const serverFacts = () =>
  Promise.race([serverInfoP || Promise.resolve(), new Promise((r) => setTimeout(r, 2000))]);

export const loadProfiles = async () => {
  // Best-effort: copy that mentions the admin reads fine with the fallback.
  serverInfoP = api.serverInfo().then((info) => {
    if (info && info.adminName) state.adminName = info.adminName;
    if (info) {
      state.torrents = info.torrents !== false;
      try {
        if (state.torrents) localStorage.removeItem("aurora-torrents-off");
        else localStorage.setItem("aurora-torrents-off", "1");
      } catch {}
    }
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

// ---- settings that follow the person (personprefs.js has the rule) ----
// Lays the profile's choices over this browser's player settings; the first
// time a person is seen in this browser, what the browser itself had chosen
// (when it was a real choice) is offered to their profile.
const MOVED_KEY = "aurora-prefs-moved"; // profile ids the one-time move is done for
const BOX_KEY = "aurora-player-box"; // this browser's own old choices, kept once
const readJson = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
};
export const applyPersonPrefs = (profile) => {
  if (!profile || !profile.id) return;
  try {
    const local = readJson("aurora-player", {});
    let box = readJson(BOX_KEY, null);
    if (!box || typeof box !== "object") {
      box = boxFrom(local);
      localStorage.setItem(BOX_KEY, JSON.stringify(box));
    }
    const movedList = readJson(MOVED_KEY, []);
    const moved = Array.isArray(movedList) && movedList.includes(profile.id);
    const r = personPrefsFor({ prefs: profile.prefs, local, box, moved });
    if (r.changed) localStorage.setItem("aurora-player", JSON.stringify(r.local));
    const done = () => {
      try {
        const list = readJson(MOVED_KEY, []);
        if (Array.isArray(list) && !list.includes(profile.id)) {
          localStorage.setItem(MOVED_KEY, JSON.stringify([...list, profile.id].slice(-60)));
        }
      } catch {}
    };
    if (moved) return;
    if (!Object.keys(r.owed).length) return done();
    profile.prefs = { ...(profile.prefs || {}), ...r.owed };
    api.updateProfile(profile.id, { prefs: r.owed }).then(done).catch(() => {});
  } catch {}
};
// A switch changed here: the active profile carries it to every device.
export const setPersonPref = (key, value) => {
  if (!state.profile) return;
  state.profile.prefs = { ...(state.profile.prefs || {}), [key]: value };
  api.updateProfile(state.profile.id, { prefs: { [key]: value } }).catch(() => {});
};
// Another device changed this profile's settings (the server says so with
// `profile_updated`): read the profile again and lay its choices down here.
export const refreshPersonPrefs = async () => {
  if (!state.profile) return;
  const id = state.profile.id;
  try {
    const me = (await api.profiles()).find((p) => p.id === id);
    if (!me || !state.profile || state.profile.id !== id) return;
    state.profile.prefs = me.prefs || {};
    applyPersonPrefs(state.profile);
  } catch {}
};

// Is the active profile a kids one ({ maxAge } on its public view)?
export const isKids = () => !!(state.profile && state.profile.kids);

export const setProfile = async (profile, token = null) => {
  const changed = !state.profile || state.profile.id !== profile.id;
  // Kids mode switched on, off or to another limit on the profile that is
  // already active: as far as every list goes, that is a different person.
  const kidsAge = (p) => (p && p.kids ? p.kids.maxAge : null);
  const relist = changed || kidsAge(state.profile) !== kidsAge(profile);
  state.profile = profile;
  state.token = token;
  setAuthToken(token);
  applyAppearance(profile);
  // Kids profiles. Answers warmed for whoever was here before are dropped —
  // the server filters every list per profile, so the last person's must not
  // be read back. The "Kids" mark on the nav chip is CSS off this attribute.
  // Entering locks THIS BROWSER to the profile (a cookie the server sets, so
  // it covers the video and image requests too); leaving takes the household
  // PIN, asked at the profile wall. Awaited so the first requests below are
  // already made as the kids profile. A server without the route (older
  // build) or a blip must never block entry.
  if (relist) forgetWarm();
  document.documentElement.toggleAttribute("data-kids", !!profile.kids);
  if (profile.kids) {
    try { await api.kidsEnter(profile.id); } catch {}
  }
  // The library list is filtered per profile as well, and `state.library`
  // lives for the whole session: it was never dropped on a switch, so a kids
  // profile entered after a grown-up's showed the WHOLE library in Movies and
  // Shows (and a grown-up coming back after a child saw only the child's) —
  // found 2026-10-08. Asked for again here, after the lock above is in place.
  // A kids profile that can't get its list gets an empty one, never the last
  // person's. (Nothing loaded yet = the boot, which loads it itself.)
  if (relist && state.library) {
    try { state.library = await api.library(profile.id); }
    catch { if (profile.kids) state.library = { movies: [], shows: [] }; }
  }
  // The profile's own settings (subtitle language, play the next episode,
  // subtitles on by themselves) land in this device's player settings — the
  // player and Preferences read those — so every device agrees.
  applyPersonPrefs(profile);
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
  // `relist`: the lists this person may see differ from the last one's —
  // screens drop what they remembered (browse.js, search.js).
  window.dispatchEvent(new CustomEvent("aurora-profile", { detail: { profile, relist } }));
};

// A previously-unlocked token for this profile in this browser session, if any.
export const savedToken = (profileId) => {
  try { return sessionStorage.getItem(`aurora-token-${profileId}`); } catch { return null; }
};

// Resolves true when the history was read from the server just now, false
// when it could not be (the player refuses to save over a history it could
// not read — see player.js).
export const refreshProgress = async () => {
  if (!state.profile) return false;
  const pid = state.profile.id;
  let read = false;
  try {
    const { progress, ratings, likedGenres, episodeProgress, streamProgress } =
      await api.profileState(pid);
    if (!state.profile || state.profile.id !== pid) return false; // the profile changed while this was on its way
    state.progress = progress || {};
    state.ratings = ratings || {};
    state.likedGenres = likedGenres || [];
    state.episodeProgress = episodeProgress || {};
    state.streamProgress = streamProgress || {};
    state.historyOf = pid;
    read = true;
  } catch {
    if (!state.profile || state.profile.id !== pid) return false;
    // Offline (or a blip): keep what we have — wiping it would drop every
    // resume point the moment the server is out of reach.
    if (!state.progress) state.progress = {};
    // ...unless what we have is the LAST profile's (a switch whose first read
    // failed): somebody else's history must not stand in for this one's.
    if (state.historyOf !== pid) {
      state.progress = {};
      state.ratings = {};
      state.likedGenres = [];
      state.episodeProgress = {};
      state.streamProgress = {};
      state.historyOf = null;
    }
  }
  // Progress made with no server in reach is still waiting on this device
  // (offline.js queues it). Until it is delivered it is the truth: without
  // this, closing the app mid-film on a plane and opening it again resumed
  // from wherever the server last heard of — the start.
  try {
    const { queuedProgress } = await import("./offline.js");
    for (const r of await queuedProgress()) {
      if (r.profileId !== state.profile.id) continue;
      const have = state.progress[r.itemId];
      if (have && have.updatedAt >= r.at) continue;
      state.progress[r.itemId] = {
        position: Math.floor(r.position), duration: Math.floor(r.duration),
        finished: r.duration > 0 && r.position / r.duration > 0.95, updatedAt: r.at,
      };
    }
  } catch {}
  return read;
};

// The star rating for an item, by library id or IMDb id (0 = unrated).
export const ratingFor = (key) => (key && state.ratings[key]) || 0;

// Progress for a streamed episode (by show imdbId + season + episode), or null.
export const episodeProgressFor = (imdbId, season, episode) =>
  (imdbId && state.episodeProgress && state.episodeProgress[`${imdbId}:${season}:${episode}`]) || null;

export const loadLibrary = async (force = false) => {
  if (!state.library || force) {
    state.library = await api.library(state.profile && state.profile.id);
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
