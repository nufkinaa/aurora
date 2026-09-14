// Usage stats: which screens, features and play paths actually get used,
// and how long they took — so Aurora is tuned for how the household really
// uses it rather than for guesses. A few dozen bytes per event, queued in
// memory and sent in one batch every 20 seconds (or when the tab hides),
// with sendBeacon so nothing ever waits on it. Goes to THIS server only; the
// admin's Analytics tab reads it (with a Copy button).
//
// What is recorded: the route pattern (never an id), the device class, the
// look, feature names, play-start timings, and the first line of a client
// error. Never search text, never anything typed. Off per profile under
// Preferences → Privacy (prefs.usageStats === false).
import { state } from "./state.js";

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

const flush = () => {
  clearTimeout(timer);
  timer = null;
  if (!queue.length || !state.profile) return;
  const body = JSON.stringify({
    profile: state.profile.id,
    sid,
    device: deviceClass(),
    look: document.documentElement.dataset.look || "legacy",
    events: queue.splice(0, queue.length),
  });
  try {
    // a Blob with a type: sendBeacon's plain-string form goes out as
    // text/plain, which the server's JSON parser ignores
    if (navigator.sendBeacon && navigator.sendBeacon("/api/usage", new Blob([body], { type: "application/json" }))) return;
  } catch {}
  fetch("/api/usage", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
};

// track("feat", { f: "peek" }) — `props` are short strings/numbers/booleans.
export const track = (name, props = {}) => {
  if (!enabled()) return;
  queue.push({ n: name, t: Date.now(), p: props });
  if (queue.length >= MAX_BATCH) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_MS);
};

// The router says which screen painted and how long it took (router.js).
window.addEventListener("aurora-route", (e) => {
  const d = e.detail || {};
  if (d.pattern) track("route", { r: d.pattern, ms: Math.round(d.ms || 0) });
});
// Errors: the message only, five per tab at most.
window.addEventListener("error", (e) => {
  if (errors++ >= 5) return;
  track("error", { m: String(e.message || "").slice(0, 120) });
});
window.addEventListener("unhandledrejection", (e) => {
  if (errors++ >= 5) return;
  track("error", { m: String((e.reason && (e.reason.message || e.reason)) || "").slice(0, 120) });
});
document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
window.addEventListener("pagehide", flush);
