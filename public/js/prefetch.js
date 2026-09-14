// Quiet prefetching: the next screen's data, fetched while this one is read.
//
// Two triggers, both cheap and both cancelled by circumstance:
//   idle    — once the profile is in and the browser has nothing to do, the
//             data the nav's pages open with is warmed one request at a time
//             (library index, the Movies/Shows catalogue's first page and
//             genres, My List), so the first tap on a tab paints from memory
//             instead of waiting on the network.
//   intent  — hovering, focusing or touching a nav link warms that page's
//             data at once; the ~200ms between intent and the tap is usually
//             enough for a LAN round trip.
// The answers land in api.js's short-lived cache (api.warmed), which the
// pages read through the same api.* calls they always made — nothing else
// changed. Never on data saver or a 2G-class connection, never in a hidden
// tab, never while offline: a prefetch that competes with the picture you're
// looking at is worse than none.
import { api } from "./api.js";
import { state, loadLibrary } from "./state.js";

const allowed = () => {
  if (document.hidden || !navigator.onLine) return false;
  const c = navigator.connection;
  if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ""))) return false;
  return true;
};

const quiet = (p) => p && p.catch && p.catch(() => {});

// What each nav destination opens with (see screens/browse.js: the "All"
// category asks the catalogue for trending, page 0, no genre).
const WARM = {
  "#/movies": () => {
    quiet(loadLibrary());
    quiet(api.catalog({ type: "movie", category: "trending", page: 0 }));
    quiet(api.catalogGenres("movie"));
  },
  "#/shows": () => {
    quiet(loadLibrary());
    quiet(api.catalog({ type: "show", category: "trending", page: 0 }));
    quiet(api.catalogGenres("show"));
  },
  "#/list": () => {
    if (state.profile) quiet(api.watchlist(state.profile.id));
  },
  "#/search": () => quiet(loadLibrary()),
};

const warm = (route) => {
  if (!allowed()) return;
  const fn = WARM[route];
  if (fn) fn();
};

// Idle warm-up: one destination every 500ms so the requests never bunch up
// against the home screen's own artwork.
let idleArmed = false;
const idleWarm = () => {
  if (idleArmed) return;
  idleArmed = true;
  const order = ["#/list", "#/movies", "#/shows"];
  const step = (i) => {
    if (i >= order.length) return;
    if (allowed()) warm(order[i]);
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
    setTimeout(idleWarm, 2500);
  });
};
