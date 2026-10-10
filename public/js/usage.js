// Usage stats: which screens, features and play paths actually get used,
// and how long they took — so Aurora is tuned for how the household really
// uses it rather than for guesses. A few dozen bytes per event, queued in
// memory and sent in one batch every 20 seconds (or when the tab hides),
// when the page is idle — never while someone is moving about or a play is
// starting (telemetry.js says when). Goes to THIS server only; the
// admin's Analytics tab reads it (with a Copy button).
//
// What is recorded: the route pattern (never an id), the device class, the
// look, feature names, play-start timings, and the first line of a client
// error. Never search text, never anything typed. Off per profile under
// Preferences → Privacy (prefs.usageStats === false).
import { state } from "./state.js";
import { netTier } from "./net.js";
import { normMessage } from "./telemetry-core.js";

const queue = [];
let timer = null;
const sid = Math.random().toString(16).slice(2, 10); // this tab's session
const FLUSH_MS = 20000;
const MAX_BATCH = 25;
let errors = 0;

export const enabled = () =>
  !!state.profile && !(state.profile.prefs && state.profile.prefs.usageStats === false);

export const deviceClass = () => {
  const ua = navigator.userAgent || "";
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (/Android TV|SMART-TV|SmartTV|Tizen|Web0S|BRAVIA|AFT[A-Z]/i.test(ua)) return "tv";
  if (coarse && matchMedia("(hover: none)").matches && innerWidth >= 1200) return "tv";
  if (coarse && Math.min(innerWidth, innerHeight) < 700) return "phone";
  if (coarse) return "tablet";
  return "desktop";
};

// ---- the richer half (telemetry.js: error reports, timings, control
// counts) rides in the same batch. It registers itself here; this file works
// the same without it.
let tel = null; // { quiet(), facts(), take(), giveBack(tel), pending() }
export const setTelemetry = (t) => { tel = t; };
// The server's answer to "may I?": a batch for a profile that has usage
// stats off comes back with `X-Usage: off` (the server drops it — it reads
// the profile's own switch, whatever this tab believed). Nothing more is
// sent for that profile from this tab.
let refusedFor = null;
const MAX_QUEUE = 100; // held while someone is busy; the oldest go first
const QUIET_RETRY_MS = 1500;

// `force`: the page is going away (hidden, pagehide) — send now, by beacon.
const flush = (force = false) => {
  clearTimeout(timer);
  timer = null;
  if (!state.profile) { arm(); return; } // nobody to ask yet: what is held waits (bounded)
  if (!enabled() || refusedFor === state.profile.id) {
    queue.length = 0;
    if (tel) tel.take(); // (it forgets what it held when the switch is off)
    return;
  }
  if (!queue.length && !(tel && tel.pending())) return;
  // Never while someone is moving about or a play is starting, and not
  // into a dead line: try again shortly.
  if (!force && ((tel && !tel.quiet()) || navigator.onLine === false)) {
    timer = setTimeout(flush, QUIET_RETRY_MS);
    return;
  }
  const extra = tel ? tel.take() : null;
  if (!queue.length && !extra) return;
  const body = JSON.stringify({
    profile: state.profile.id,
    sid,
    device: deviceClass(),
    look: document.documentElement.dataset.look || "legacy",
    ...(tel ? tel.facts() : {}),
    net: netTier(),
    events: queue.splice(0, queue.length),
    ...(extra ? { tel: extra } : {}),
  });
  if (force) {
    try {
      // a Blob with a type: sendBeacon's plain-string form goes out as
      // text/plain, which the server's JSON parser ignores
      if (navigator.sendBeacon && navigator.sendBeacon("/api/usage", new Blob([body], { type: "application/json" }))) return;
    } catch {}
  }
  const forProfile = state.profile.id;
  fetch("/api/usage", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < 60000 })
    .then((res) => { if (res.headers.get("X-Usage") === "off") refusedFor = forProfile; })
    .catch(() => { if (tel && extra) tel.giveBack(extra); });
};
const arm = () => { if (!timer) timer = setTimeout(flush, FLUSH_MS); };
// telemetry.js has something to send and no event to carry it
export const poke = arm;

// track("feat", { f: "peek" }) — `props` are short strings/numbers/booleans.
export const track = (name, props = {}) => {
  if (!enabled()) return;
  queue.push({ n: name, t: Date.now(), p: props });
  if (queue.length > MAX_QUEUE) queue.shift();
  if (queue.length >= MAX_BATCH) { clearTimeout(timer); timer = setTimeout(flush, 0); }
  else arm();
};

// The router says which screen painted and how long it took (router.js).
window.addEventListener("aurora-route", (e) => {
  const d = e.detail || {};
  if (d.pattern) track("route", { r: d.pattern, ms: Math.round(d.ms || 0) });
});
// Errors: the message only (reduced: no address, id, number or quoted
// phrase — telemetry-core.js), five per tab at most. The fuller reports,
// with counts and where, are telemetry.js.
window.addEventListener("error", (e) => {
  if (errors++ >= 5) return;
  track("error", { m: normMessage(e.message).slice(0, 120) });
});
window.addEventListener("unhandledrejection", (e) => {
  if (errors++ >= 5) return;
  track("error", { m: normMessage((e.reason && (e.reason.message || e.reason)) || "").slice(0, 120) });
});
document.addEventListener("visibilitychange", () => { if (document.hidden) flush(true); });
window.addEventListener("pagehide", () => flush(true));
