// Hash router. Routes render into #app; overlays (player) stack on top so
// Back works naturally on TVs.
import { $$ } from "./ui.js";

const routes = []; // {pattern: RegExp, render: fn(params)}
let appRoot;

export const route = (pattern, render) => {
  const names = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:[a-zA-Z]+/g, (m) => {
        names.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$"
  );
  routes.push({ pattern, regex, names, render });
};

// The page this one was reached from (null on a cold load), so a screen that
// "goes back" to a known place can use the browser's Back instead of pushing
// a second copy of that page onto the history.
let cameFromHash = null;
export const cameFrom = () => cameFromHash;

export const navigate = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

const markNav = (hash) => {
  $$("[data-route]").forEach((a) => {
    const target = a.getAttribute("data-route");
    a.classList.toggle("active", target === hash || (target !== "#/" && hash.startsWith(target)));
  });
};

let current = { cleanup: null };

// What a screen hung on something that OUTLIVES it — a listener on window or
// document, a subscription to the live socket — is let go when the screen is
// left. These used to be written to remove themselves "the next time the
// event arrives and finds the screen gone", and an event that never arrives
// (no download running; a phone, which sends no remote-control moves; a page
// nobody scrolls again) kept the listener for good — and through what it
// closes over, the whole screen: every title page, grid and Search ever
// opened stayed in memory (measured: tools/mobile-perf/holders.js). A
// screen's own `return () => …` is still the place for what its render
// function can reach; this is for code deep inside a screen, or shared by
// several, that has no way to hand a cleanup up to the router.
//   untilLeave(() => window.removeEventListener("scroll", onScroll));
//   const unsub = untilLeave(onMessage("download_update", …));
// -> the function it was given (so it can still be called earlier).
const leaving = new Set();
export const untilLeave = (undo) => {
  if (typeof undo === "function") leaving.add(undo);
  return undo;
};
const leave = () => {
  for (const undo of [...leaving]) {
    leaving.delete(undo);
    try { undo(); } catch {}
  }
};
export const _leaving = leaving; // (read-only, for tests)

const render = async () => {
  const hash = location.hash || "#/";
  const path = hash.replace(/^#/, "");

  for (const r of routes) {
    const m = path.match(r.regex);
    if (!m) continue;

    // Decode params BEFORE tearing down the current screen: a malformed
    // %-escape (e.g. "#/search/%") throws, and throwing after cleanup() left
    // the old screen visible but dead (listeners/timers already removed).
    const params = {};
    try {
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    } catch {
      return navigate("#/");
    }

    if (typeof current.cleanup === "function") current.cleanup();
    current.cleanup = null;
    leave();

    appRoot.innerHTML = "";
    markNav(hash);
    window.scrollTo(0, 0);
    const t0 = performance.now();
    window.dispatchEvent(new CustomEvent("aurora-route-start", { detail: { pattern: r.pattern } })); // [analytics] which screen is being opened (the pattern, never an id)
    const cleanup = await r.render(appRoot, params);
    if (typeof cleanup === "function") current.cleanup = cleanup;
    // Which screen painted and how long it took (the pattern, never an id) —
    // the usage stats listen for this. Measured to the next frame, so the
    // paint is in.
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("aurora-route", { detail: { pattern: r.pattern, ms: performance.now() - t0 } })));
    return;
  }

  // Unknown -> home
  navigate("#/");
};

export const startRouter = (root) => {
  appRoot = root;
  window.addEventListener("hashchange", (e) => {
    try {
      cameFromHash = new URL(e.oldURL).hash || "#/";
    } catch {
      cameFromHash = null;
    }
    render();
  });
  render();
};
