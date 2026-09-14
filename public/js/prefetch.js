// Quiet prefetching: the next screen's data, fetched while this one is read.
//
// Triggers, all cheap and all cancelled by circumstance:
//   idle    — once the profile is in and the browser has nothing to do, the
//             data the nav's pages open with is warmed one request at a time
//             (library index, the Movies/Shows catalogue's first page and
//             genres, My List), so the first tap on a tab paints from memory
//             instead of waiting on the network.
//   intent  — hovering, focusing or touching a nav link warms that page's
//             data at once; hovering, focusing or pressing a card warms that
//             title's page (its record and metadata); hovering Play on a
//             title page warms the server side of playback (the jit index /
//             copy job) so the first frame comes sooner.
//   home    — after Home renders: the first two Continue Watching titles
//             that aren't effectively finished, and the most recent series
//             still in progress, get their title page warmed — record,
//             metadata and, on a fast connection, the art.
// The answers land in api.js's short-lived cache (api.warmed), which the
// pages read through the same api.* calls they always made — nothing else
// changed. Every prefetch is low priority (the browser queues it behind
// anything the screen is waiting for), staggered, and skipped on data saver,
// a 2G-class connection, a hidden tab, offline, or while a film is playing.
import { api } from "./api.js";
import { state, loadLibrary, progressFor } from "./state.js";
import { artUrl, heroArtWidth } from "./ui.js";

const allowed = () => {
  if (document.hidden || !navigator.onLine) return false;
  const c = navigator.connection;
  if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ""))) return false;
  return true;
};
// art is only worth fetching ahead on a connection that is not the bottleneck
const fast = () => {
  const c = navigator.connection;
  return !c || !c.effectiveType || c.effectiveType === "4g";
};
// never behind a film — the player owns the bandwidth then
const busy = () => !!document.querySelector(".player");

const quiet = (p) => p && p.catch && p.catch(() => {});

// ---------- pages ----------
// What each nav destination opens with (see screens/browse.js: the "All"
// category asks the catalogue for trending, page 0, no genre).
const WARM = {
  "#/movies": () => {
    quiet(loadLibrary());
    quiet(api.catalog({ type: "movie", category: "trending", page: 0, low: true }));
    quiet(api.catalogGenres("movie", { low: true }));
  },
  "#/shows": () => {
    quiet(loadLibrary());
    quiet(api.catalog({ type: "show", category: "trending", page: 0, low: true }));
    quiet(api.catalogGenres("show", { low: true }));
  },
  "#/list": () => {
    if (state.profile) quiet(api.watchlist(state.profile.id, { low: true }));
  },
  "#/search": () => quiet(loadLibrary()),
};

const warm = (route) => {
  if (!allowed()) return;
  const fn = WARM[route];
  if (fn) fn();
};

// ---------- titles ----------
const warmedTitles = new Set();
// A title's page: its library record (the show's, for an episode) and its
// Discover metadata — what renderDetail asks for first. `art`: the poster
// and backdrop too, at the sizes the page draws them.
export const warmTitle = (item, { art = false } = {}) => {
  if (!item || !allowed() || busy()) return;
  const id = String(item.id || "");
  if (id.startsWith("torrent|")) return;
  const key = `${item.imdbId || ""}|${item.showId || id}`;
  if (warmedTitles.has(key)) return;
  warmedTitles.add(key);
  const isEpisode = !!item.showId && item.type !== "show";
  const libId = isEpisode ? item.showId : item.source !== "stream" && id ? id : null;
  if (libId) quiet(api.item(libId, { low: true }));
  if (item.imdbId) quiet(api.discoverMeta(item.type === "show" ? "show" : "movie", item.imdbId, { low: true }));
  if (art && fast()) {
    for (const [src, w] of [[item.cover, 300], [item.backdrop, heroArtWidth()]]) {
      if (!src) continue;
      const im = new Image();
      im.fetchPriority = "low";
      im.src = artUrl(src, w);
    }
  }
};

// The billboard's current title, once it has held still for a moment.
let heroCurrent = null;
export const warmHero = (item) => {
  heroCurrent = item;
  setTimeout(() => { if (heroCurrent === item) warmTitle(item); }, 1500);
};

// After Home painted: the two most recent Continue Watching titles that
// aren't effectively done (a film at 95%+, anything marked finished), plus
// the most recent series still in progress — one every 700ms, art included.
export const fromHome = (data) => {
  if (!data || !allowed()) return;
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 2000)))(() => {
    const cw = ((data.rows || []).find((r) => r.id === "continue") || {}).items || [];
    const done = (i) => {
      const p = progressFor(i.id) || (i.imdbId && state.streamProgress && state.streamProgress[i.imdbId]) || null;
      return !!(p && (p.finished || (p.duration > 0 && p.position / p.duration >= 0.95)));
    };
    const live = cw.filter((i) => !done(i));
    const picks = live.slice(0, 2);
    const series = live.find((i) => i.showId && i.type !== "show" && !picks.includes(i));
    if (series) picks.push(series);
    picks.forEach((it, n) => setTimeout(() => warmTitle(it, { art: true }), 400 + n * 700));
  }, { timeout: 5000 });
};

// ---------- playback ----------
// The server side of pressing Play on a title you own: for a file this
// device can't play as-is, the jit index or copy job starts now instead of
// on the tap (player.js decides which, exactly as it will when it opens).
// Direct-play files have nothing to warm. Once per title per page.
const warmedPlay = new Set();
export const warmPlay = (item) => {
  if (!item || !allowed() || busy() || warmedPlay.has(item.id)) return;
  warmedPlay.add(item.id);
  import("./screens/player.js").then((m) => m.warmPlayback(item)).catch(() => {});
};

// ---------- idle warm-up ----------
// One destination every 500ms so the requests never bunch up against the
// home screen's own artwork.
let idleArmed = false;
const idleWarm = () => {
  if (idleArmed) return;
  idleArmed = true;
  const order = ["#/list", "#/movies", "#/shows"];
  const step = (i) => {
    if (i >= order.length) return;
    if (allowed() && !busy()) warm(order[i]);
    setTimeout(() => step(i + 1), 500);
  };
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 3000)))(() => step(0), { timeout: 6000 });
};

export const initPrefetch = () => {
  // intent: the nav's links (top bar or the phone's tab bar — same nodes)
  for (const a of document.querySelectorAll(".nav-item[data-route]")) {
    const go = () => warm(a.getAttribute("data-route"));
    a.addEventListener("pointerenter", go);
    a.addEventListener("focus", go);
    a.addEventListener("touchstart", go, { passive: true });
  }
  // idle: after the profile is in (the first screen is painting by then)
  if (state.profile) setTimeout(idleWarm, 2500);
  window.addEventListener("aurora-profile", () => {
    idleArmed = false; // a profile switch warms the new profile's list
    warmedTitles.clear();
    setTimeout(idleWarm, 2500);
  });
};
