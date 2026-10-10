// What the site reports besides its usage events (docs/analytics.md) — all
// of it behind the same switch (Settings → More settings → Privacy), all of
// it sent to THIS server only, in the same batch as the usage events:
//
//   errors    what went wrong, by KIND and count: an uncaught error, an
//             unhandled rejection, console.error / console.warn, a request
//             the server refused ("GET /img/:id?w=256 → 401"), pictures that
//             would not load, the video element's error code, a stuck page.
//   timings   how long the moments people feel took (the same names and
//             definitions as the TV app).
//   controls  how many times each tagged control (`data-ui="detail.play"`)
//             was pressed, per screen — counts, sent when the page is idle.
//
// Never: a title, an id, an address, search text, a name, anything typed.
// The pure parts (and their tests) are in telemetry-core.js.
//
// Cost: a key press or a tap is one assignment (`lastInput = now`); a click
// on a tagged control is one `closest()` and one counter increment. Nothing
// is written to storage and nothing is sent while someone is moving about or
// a play is starting — usage.js asks `quiet()` before every batch.
import { state } from "./state.js";
import { enabled, deviceClass, setTelemetry, poke } from "./usage.js";
import { ErrorBook, ControlCounter, Timers, urlPattern, locOf, uaClass, idleNow, playPath, LIMITS } from "./telemetry-core.js";

const t = () => performance.now();
const DAY_KEY = "aurora-tel-day";
const IID_KEY = "aurora-iid";

// ---- the install id: random, made here, tied to nothing. It lets the
// server count "three different devices" and is hashed again before it is
// stored there.
let iid = "";
try {
  iid = localStorage.getItem(IID_KEY) || "";
  if (!/^[a-z0-9]{16}$/.test(iid)) {
    iid = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(IID_KEY, iid);
  }
} catch {
  iid = Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}

// how many kinds of error this device has already reported today
const today = () => new Date().toISOString().slice(0, 10);
let sentToday = 0;
try {
  const d = JSON.parse(localStorage.getItem(DAY_KEY) || "null");
  if (d && d.day === today()) sentToday = d.n | 0;
} catch {}

const book = new ErrorBook({ sentToday });
const controls = new ControlCounter();
const timers = new Timers(t);

let screen = ""; // the route PATTERN on show ("/movie/:id"), from the router
let lastInput = -1e9;
let input = "mouse";
let lastPath = "direct";
let firstBatch = true;
let version = "";
const isTv = deviceClass() === "tv";

// ---------- input: the idle gate and the "how" of a press ----------
const onKey = () => { lastInput = t(); input = isTv ? "remote" : "keyboard"; };
const onPointer = (e) => { lastInput = t(); input = e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse"; };
const onMove = () => { lastInput = t(); };
window.addEventListener("keydown", onKey, { capture: true, passive: true });
window.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
window.addEventListener("wheel", onMove, { capture: true, passive: true });
window.addEventListener("touchmove", onMove, { capture: true, passive: true });

// A play is "starting" from the player's mount to its first frame (a minute
// at most — a play that never starts must not hold the batch for ever).
let playAt = 0;
const playStarting = () => playAt > 0 && t() - playAt < 60000;
// usage.js asks before every batch (a hidden page sends regardless).
export const quiet = () => idleNow({ sinceInputMs: t() - lastInput, playStarting: playStarting() });

// ---------- controls ----------
// One delegated listener. A control says what it is (`data-ui`); nothing is
// ever guessed from its text.
document.addEventListener("click", (e) => {
  const el = e.target && e.target.closest ? e.target.closest("[data-ui]") : null;
  if (el) controls.hit(screen || "?", el.dataset.ui, e.detail === 0 && input !== "remote" ? "keyboard" : input);
}, { capture: true, passive: true });
// for a control that is not a click on an element (a keyboard shortcut)
export const uiHit = (id) => controls.hit(screen || "?", id, input);

// ---------- timings ----------
let navAt = 0; // when this screen was asked for (0: the page load itself)
let navOnce = new Set();
// Grid → first poster: armed by a navigation, answered by the first card
// poster that loads after it (one boolean test per image load, no call site).
const GRIDS = new Set(["/", "/movies", "/shows", "/list", "/new", "/search", "/search/:q"]);
let posterWait = true;
let posterMs = -1; // loaded before the router said which screen this is
let routed = false;
window.addEventListener("hashchange", () => { navAt = t(); navOnce = new Set(); posterWait = true; posterMs = -1; routed = false; }, true);
window.addEventListener("aurora-route", (e) => {
  const d = e.detail || {};
  if (!d.pattern) return;
  screen = d.pattern;
  routed = true;
  // navigation start → the first frame after the screen rendered
  timers.value("nav_paint", d.ms || 0, d.pattern);
  if (posterMs >= 0 && GRIDS.has(screen)) timers.value("grid_first_poster", posterMs, screen);
  posterMs = -1;
  poke();
});
document.addEventListener("load", (e) => {
  if (!posterWait) return;
  const el = e.target;
  if (!el || el.tagName !== "IMG" || !el.classList.contains("card-poster")) return;
  posterWait = false;
  if (!routed) posterMs = t() - navAt;
  else if (GRIDS.has(screen)) timers.value("grid_first_poster", t() - navAt, screen);
}, true);
export const tmStart = (name) => timers.start(name);
export const tmEnd = (name, dim) => timers.end(name, dim);
export const tmCancel = (name) => timers.cancel(name);
export const tmValue = (name, ms, dim) => timers.value(name, ms, dim);
// "since the keystroke": the time from a running timer, which keeps running
export const tmLap = (name, from, dim) => { const t0 = timers.open.get(from); if (t0 != null) timers.value(name, t() - t0, dim); };
// "since this screen was asked for" — once per visit to a screen
export const sinceNav = (name, dim) => {
  if (navOnce.has(name)) return;
  navOnce.add(name);
  timers.value(name, t() - navAt, dim);
};
export { playPath };
// A title page: → content shown (the frame after its hero block is in the
// page), → backdrop shown (the picture behind it has arrived). details.js.
export const titleShown = (backdropUrl) => {
  const dim = location.hash.startsWith("#/discover/") ? "catalogue" : "library";
  requestAnimationFrame(() => sinceNav("title_content", dim));
  if (!backdropUrl || navOnce.has("title_backdrop")) return;
  const asked = navAt;
  const probe = new Image(); // the same address the page paints: one download, shared
  probe.onload = () => { if (asked === navAt) sinceNav("title_backdrop", dim); };
  probe.src = backdropUrl;
};

// App start → Home usable, and profile picked → Home usable. "Usable" is the
// same moment on the TV: the first row's cards are on the screen (home.js
// calls this on the frame after it appended them).
let gateAt = 0;
let homeSeen = false;
const loadedHidden = document.visibilityState !== "visible";
export const profilePicked = () => { gateAt = t(); };
export const homeUsable = () => {
  if (gateAt) timers.value("gate_home", t() - gateAt);
  else if (!homeSeen && !loadedHidden && navAt === 0) timers.value("app_start_home", t());
  gateAt = 0;
  homeSeen = true;
};

// The player: mount → first frame (the player's own clock, the one its play
// marks use), and which path it took — remembered for the seeks that follow.
export const playMounted = () => { playAt = t(); };
export const playFirstFrame = (ms, what) => {
  playAt = 0;
  lastPath = playPath(what);
  timers.value("play_first_frame", ms, lastPath);
};
export const playGone = () => { playAt = 0; seekAt = 0; };

// Seek → playing again, read off the video element itself (media events do
// not bubble, but they can be captured): no call site in the player.
let seekAt = 0;
const inPlayer = (e) => e.target && e.target.tagName === "VIDEO" && e.target.closest && e.target.closest(".player");
document.addEventListener("seeking", (e) => { if (inPlayer(e) && !seekAt && !playStarting()) seekAt = t(); }, true);
const seekDone = (e) => {
  if (!seekAt || !inPlayer(e) || e.target.seeking || e.target.readyState < 3) return;
  timers.value("seek_resume", t() - seekAt, lastPath);
  seekAt = 0;
};
document.addEventListener("playing", seekDone, true);
document.addEventListener("canplay", seekDone, true);
document.addEventListener("seeked", seekDone, true);

// The live socket: lost → back (ws.js).
export const wsDown = () => { if (!timers.running("ws_reconnect")) timers.start("ws_reconnect"); };
export const wsUp = () => { timers.end("ws_reconnect"); };

// ---------- errors ----------
// reportError("media", "hls fragLoadError", { ctx: { code: 404 } })
export const reportError = (kind, message, { level = "error", loc = "", ctx = null, raw = false } = {}) => {
  try { note(kind, level, message, { loc, ctx, raw }); } catch {}
};
// every report goes through here: counted in the book, and the sender is
// reminded that there is something to carry (it waits for a quiet moment)
const note = (kind, level, message, o = {}) => {
  if (book.add(kind, level, message, { ...o, screen })) poke();
};

const statusOf = (url) => {
  try {
    const e = performance.getEntriesByName(url).pop();
    return e && e.responseStatus ? e.responseStatus : null;
  } catch { return null; }
};
const sameOrigin = (url) => {
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};
const shapeOf = (url) => (sameOrigin(url) ? urlPattern(url) : "/ext");

// A request that failed, as "GET /api/item/:id → 404". 5xx and "no answer"
// are errors; a 4xx is a warning (some are answers a screen expects).
const httpFailed = (method, url, status) => {
  if (!sameOrigin(url)) return;
  const shape = urlPattern(url);
  if (shape === "/api/usage") return;
  note("http", status >= 500 || status === 0 ? "error" : "warn", `${method} ${shape}`, { ctx: { status, online: navigator.onLine ? 1 : 0 }, raw: true });
};
if (typeof window.fetch === "function") {
  const real = window.fetch;
  window.fetch = function (resource, init) {
    const p = real.apply(this, arguments);
    try {
      const url = typeof resource === "string" ? resource : (resource && resource.url) || String(resource);
      const method = String((init && init.method) || (resource && resource.method) || "GET").toUpperCase();
      p.then(
        (res) => { if (res && res.status >= 400) httpFailed(method, url, res.status); },
        (err) => { if (!err || err.name !== "AbortError") httpFailed(method, url, 0); },
      );
    } catch {}
    return p;
  };
}

// Uncaught errors — and, in the capture phase, everything that failed to
// LOAD: a picture, the video, a script.
window.addEventListener("error", (e) => {
  try {
    const el = e.target;
    if (el && el !== window && el.tagName) {
      const tag = el.tagName;
      const url = el.currentSrc || el.src || el.href || "";
      if (tag === "IMG") {
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return;
        const status = statusOf(url);
        note("img", "error", shapeOf(url), { ctx: status ? { status } : null, raw: true });
      } else if (tag === "VIDEO" || tag === "AUDIO" || tag === "SOURCE") {
        const media = tag === "SOURCE" ? el.parentElement : el;
        const code = media && media.error ? media.error.code : 0; // 1 aborted · 2 network · 3 decode · 4 not supported
        if (code === 1) return;
        note("media", "error", `${tag === "AUDIO" ? "audio" : "video"} element error`, { ctx: { code } });
      } else if (tag === "SCRIPT" || tag === "LINK") {
        note("http", "error", `GET ${shapeOf(url)}`, { ctx: { status: statusOf(url) || 0 }, raw: true });
      }
      return;
    }
    const err = e.error;
    const file = String(e.filename || "").replace(/^[a-z]+:\/\/[^/]*/i, "").replace(/[?#].*$/, "").split("/").slice(-2).join("/");
    note("js", "error", e.message || (err && err.message) || "error", { loc: (err && locOf(err.stack)) || file });
  } catch {}
}, true);

window.addEventListener("unhandledrejection", (e) => {
  try {
    const r = e.reason;
    if (r && (r.name === "AbortError" || r.status != null || r.signinRequired)) return; // a refused request is already counted, by its shape
    const msg = r instanceof Error ? `${r.name && r.name !== "Error" ? `${r.name}: ` : ""}${r.message}` : typeof r === "string" ? r : "rejection (no message)";
    note("promise", "error", msg, { loc: r && r.stack ? locOf(r.stack) : "" });
  } catch {}
});

// console.error and console.warn. Only what cannot be a person's data is
// kept: the FIRST argument when it is a string (the message as written in
// the code) and the name and message of any Error after it. Every other
// argument — a title, an object, an address — is reduced to its type.
{
  let busy = false;
  const describe = (args) => {
    const parts = [];
    for (let i = 0; i < args.length && i < 4; i++) {
      const a = args[i];
      if (a instanceof Error) parts.push(`${a.name}: ${a.message}`);
      else if (i === 0 && typeof a === "string") parts.push(a);
      else parts.push(a === null ? "<null>" : `<${typeof a}>`);
    }
    return parts.join(" ");
  };
  for (const level of ["error", "warn"]) {
    const orig = console[level];
    console[level] = function (...args) {
      if (!busy) {
        busy = true;
        try {
          const err = args.find((a) => a instanceof Error);
          note("console", level, describe(args), { loc: err ? locOf(err.stack) : "" });
        } catch {}
        busy = false;
      }
      return orig.apply(this, args);
    };
  }
}

// A page that stood still: a task that held the main thread for a second or
// more (where the browser can tell us). Grouped coarsely so it is one kind.
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < 1000) continue;
      const band = e.duration >= 5000 ? "over 5 s" : e.duration >= 2000 ? "2 to 5 s" : "1 to 2 s";
      note("stall", "warn", `main thread blocked ${band}`, { ctx: { ms: Math.round(e.duration) }, raw: true });
    }
  }).observe({ type: "longtask", buffered: true });
} catch {}

// ---------- what goes into a batch (usage.js calls this when it sends) ----------
// The version comes from the same cached call the report sheet makes.
import("./api.js").then(({ api }) => api.version && api.version()).then((c) => { version = (c && c.version) || ""; }).catch(() => {});

let ua = null;
const facts = () => {
  ua = ua || uaClass(navigator.userAgent);
  const flags = [`look:${document.documentElement.dataset.look || "legacy"}`];
  if (window.matchMedia && matchMedia("(display-mode: standalone)").matches) flags.push("installed");
  if (navigator.serviceWorker && navigator.serviceWorker.controller) flags.push("sw");
  return { iid, app: "web", v: version || "?", model: ua.browser, os: ua.os, auth: state.authMode || "open", flags };
};

setTelemetry({
  quiet,
  facts,
  // → { s?, e?, t?, u? } or null when there is nothing to say
  take: () => {
    if (!enabled()) { clear(); return null; }
    const out = {};
    const e = book.drain();
    const tm = timers.drain();
    const u = controls.drain();
    if (e.length) out.e = e;
    if (tm.length) out.t = tm;
    if (u.length) out.u = u;
    if (!e.length && !tm.length && !u.length) return null;
    if (firstBatch) { out.s = 1; firstBatch = false; }
    if (e.length) {
      try { localStorage.setItem(DAY_KEY, JSON.stringify({ day: today(), n: book.sentToday + book.seen.size })); } catch {}
    }
    return out;
  },
  // a batch that did not get through: its error reports wait for the next one
  giveBack: (tel) => { if (tel && tel.e) book.restore(tel.e); },
  pending: () => book.size > 0 || timers.done.length > 0 || controls.any,
});

// Opted out (or the server said so): everything held is forgotten.
export const clear = () => {
  book.items.clear();
  timers.done.length = 0;
  controls.clear();
};

export const _state = { book, controls, timers, LIMITS };
