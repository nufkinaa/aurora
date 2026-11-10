// The trail a problem report carries (docs/report-trail.md): what the viewer
// did in the minutes before pressing Report, step by step. In memory only
// (a ring of the last 60 steps; the last ten minutes of it are sent), and
// sent ONLY inside a report the viewer chooses to send — not with the usage
// stats, not anywhere else. The rules (what is kept, what never is) are the
// pure trail-core.js; this file hooks the few central places:
//
//   screens       the router's route events            nav
//   presses       one delegated click listener         tap  (data-ui name, else role + label)
//   keys          one keydown listener                 key  (by name; never a character)
//   requests      a wrapper around fetch               req · search, and the last 10 timings
//   the player    its <video>'s own events, captured   play (play, pause, seek, stall, error…)
//   the page      visibility, fullscreen, online       app · net
//   and callers   toast (ui.js), sheets (focus.js), errors and features (telemetry.js, usage.js),
//                 the player's marks and choices (player.js) — each one line: trail(k, {...})
//
// Cost: an event is one object pushed onto a 60-slot array. Nothing is
// stored, nothing is sent, nothing is read from the page beyond the element
// that was pressed.
import { Trail, TRAIL, keyName, trailPath, searchOf, routeEntry, short } from "./trail-core.js";

const ring = new Trail();
export const trail = (k, fields) => {
  try { ring.add(k, fields); } catch {}
};
export const trailTake = (o) => ring.take(o);
export const trailClear = () => ring.clear();
const bootAt = Date.now();
export const sessionMs = () => Date.now() - bootAt;

// ---------- toasts: the words the viewer was shown ----------
// (the names of the files from this device stay on it: "Your files" and their
// player say what happened, never which file — js/localplay.js' rule)
export const trailToast = (message) => {
  try {
    let m = typeof message === "string" ? message : (message && message.textContent) || "";
    if (/^#\/(saved|play\/local-)/.test(location.hash)) m = m.replace(/“[^”]*”/g, "“…”");
    trail("toast", { m });
  } catch {}
};

// ---------- the last requests, for the report's context ----------
const reqs = [];
export const recentRequests = (sentAt = Date.now()) =>
  reqs.map((r) => ({ t: Math.max(0, sentAt - r.at), m: r.m, p: r.p, s: r.s, ms: r.ms }));

// ---------- screens ----------
window.addEventListener("aurora-route-start", (e) => {
  const d = e.detail || {};
  if (d.pattern) trail("nav", routeEntry(d.pattern, location.hash));
});

// ---------- presses ----------
const TYPING = /^(text|search|email|password|tel|url|number|date|datetime-local|month|week|time)$/i;
const isField = (el) => {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return TYPING.test(el.type || "text");
  return false;
};
const PRESSABLE = "button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=tab], [role=option], [role=switch], [role=link], summary, input[type=checkbox], input[type=radio], .focusable";
const labelOf = (c) => {
  if (c.tagName === "INPUT") return (c.labels && c.labels[0] && c.labels[0].textContent) || c.getAttribute("aria-label") || c.name || "";
  // (a container holding a field says nothing of what is in the field)
  if (c.querySelector && c.querySelector("input, textarea, [contenteditable=true]")) return c.getAttribute("aria-label") || "";
  return c.getAttribute("aria-label") || c.getAttribute("title") || c.textContent || "";
};
document.addEventListener("click", (e) => {
  try {
    const t = e.target;
    if (!t || !t.closest) return;
    const tagged = t.closest("[data-ui]");
    if (tagged) return trail("tap", { ui: tagged.dataset.ui });
    const c = t.closest(PRESSABLE);
    if (!c || isField(c)) return;
    const fields = { r: c.getAttribute("role") || c.tagName.toLowerCase(), l: short(labelOf(c), TRAIL.LABEL) };
    if (c.tagName === "INPUT") fields.on = !!c.checked;
    trail("tap", fields);
  } catch {}
}, { capture: true, passive: true });
// a choice from a list (never a field's words: a <select>'s chosen option is a choice)
document.addEventListener("change", (e) => {
  try {
    const s = e.target;
    if (!s || s.tagName !== "SELECT") return;
    const o = s.options[s.selectedIndex];
    trail("tap", { r: "select", l: short(s.getAttribute("aria-label") || (s.labels && s.labels[0] && s.labels[0].textContent) || s.name, TRAIL.LABEL), v: short(o ? o.textContent : "", TRAIL.LABEL) });
  } catch {}
}, { capture: true, passive: true });

// ---------- keys ----------
window.addEventListener("keydown", (e) => {
  try {
    const name = keyName(e.key, isField(e.target));
    if (name) trail("key", { key: name });
  } catch {}
}, { capture: true, passive: true });

// ---------- requests ----------
// Every request to this server is timed (the last ten go with a report);
// the trail gets the ones that are a step: a write, a failure, a slow answer.
// Polls and the app's own reporting are steps only when they fail or crawl.
const NOISE = /^\/api\/(usage|play-mark|reports|caps|presence|torrents\/perf-mark)(\/|$)|\/(progress|status|poll|heartbeat)$/;
const sameOrigin = (url) => {
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};
if (typeof window.fetch === "function") {
  const real = window.fetch;
  window.fetch = function (resource, init) {
    const p = real.apply(this, arguments);
    try {
      const url = typeof resource === "string" ? resource : (resource && resource.url) || String(resource);
      if (sameOrigin(url)) {
        const method = String((init && init.method) || (resource && resource.method) || "GET").toUpperCase();
        const path = trailPath(url);
        const q = searchOf(url);
        if (q) trail("search", { q });
        const t0 = performance.now();
        const done = (status) => {
          const ms = Math.round(performance.now() - t0);
          const noise = NOISE.test(path);
          if (!noise && path.startsWith("/api/")) {
            reqs.push({ at: Date.now(), m: method, p: path, s: status, ms });
            if (reqs.length > TRAIL.REQS) reqs.shift();
          }
          if (status === 0 || status >= 400 || ms >= TRAIL.SLOW_MS || (!noise && method !== "GET")) trail("req", { m: method, p: path, s: status, ms });
        };
        p.then((res) => done(res ? res.status : 0), (err) => { if (!err || err.name !== "AbortError") done(0); });
      }
    } catch {}
    return p;
  };
}

// ---------- the player ----------
// Read off its <video> (media events do not bubble, but they can be
// captured): no call site in the player for the plain ones.
const inPlayer = (t) => t && t.tagName === "VIDEO" && t.closest && t.closest(".player");
let pos = 0; // where the film was before a seek began
let waitAt = 0; // buffering since (0: not)
let seekAt = 0; // a seek in flight since
let height = 0;
const at = (v) => Math.round((v.currentTime || 0) * 10) / 10;
const cap = (type, fn) => document.addEventListener(type, (e) => { try { if (inPlayer(e.target)) fn(e.target); } catch {} }, true);
cap("timeupdate", (v) => { if (!v.seeking) pos = v.currentTime || 0; });
cap("loadstart", () => { pos = 0; waitAt = 0; seekAt = 0; height = 0; });
cap("play", (v) => trail("play", { e: "play", at: at(v) }));
cap("pause", (v) => { if (!v.ended) trail("play", { e: "pause", at: at(v) }); });
cap("seeking", (v) => {
  const last = ring.items[ring.items.length - 1];
  // a drag along the bar is one seek: from where it began to where it ends
  if (last && last.k === "play" && last.e === "seek" && Date.now() - last.at < 1500) {
    last.to = at(v);
    last.at = Date.now();
  } else trail("play", { e: "seek", from: Math.round(pos * 10) / 10, to: at(v) });
  seekAt = Date.now();
});
cap("waiting", () => { if (!waitAt) waitAt = Date.now(); });
const resumed = (v) => {
  const now = Date.now();
  if (seekAt) {
    if (!v.seeking) { trail("play", { e: "seeked", ms: now - seekAt, at: at(v) }); seekAt = 0; waitAt = 0; }
    return;
  }
  if (waitAt) {
    const ms = now - waitAt;
    waitAt = 0;
    if (ms >= 500) trail("play", { e: "stall", ms, at: at(v) });
  }
};
cap("playing", resumed);
cap("seeked", (v) => { if (v.readyState >= 3) resumed(v); });
cap("ended", (v) => trail("play", { e: "ended", at: at(v) }));
cap("ratechange", (v) => trail("play", { e: "rate", v: v.playbackRate }));
cap("resize", (v) => {
  if (!v.videoHeight || v.videoHeight === height) return;
  height = v.videoHeight;
  trail("play", { e: "picture", h: v.videoHeight, w: v.videoWidth });
});
cap("error", (v) => trail("play", { e: "error", code: v.error ? v.error.code : 0 }));
cap("enterpictureinpicture", () => trail("app", { e: "pip-on" }));
cap("leavepictureinpicture", () => trail("app", { e: "pip-off" }));
cap("webkitbeginfullscreen", () => trail("app", { e: "fullscreen-on" }));
cap("webkitendfullscreen", () => trail("app", { e: "fullscreen-off" }));
// what the player is doing right now, for its own state in a report
export const playerWaiting = () => (waitAt ? Date.now() - waitAt : 0);

// ---------- the page ----------
document.addEventListener("visibilitychange", () => trail("app", { e: document.hidden ? "hidden" : "shown" }));
document.addEventListener("fullscreenchange", () => trail("app", { e: document.fullscreenElement ? "fullscreen-on" : "fullscreen-off" }));
window.addEventListener("online", () => trail("net", { on: true }));
window.addEventListener("offline", () => trail("net", { on: false }));
try {
  const c = navigator.connection;
  if (c && c.addEventListener) c.addEventListener("change", () => trail("net", { type: c.effectiveType || "", mbps: c.downlink, rtt: c.rtt }));
} catch {}
// Another profile: what the last one did is not theirs to send — the trail
// starts over (the steps at the profile wall belong to whoever came in).
let profileId = null;
window.addEventListener("aurora-profile", (e) => {
  const p = e.detail && e.detail.profile;
  if (!p) return;
  if (profileId && p.id !== profileId) { ring.clear(); reqs.length = 0; }
  if (p.id !== profileId) trail("app", { e: "profile" });
  profileId = p.id;
});
trail("app", { e: "start" });
