// Report a problem: a sheet with one box, and everything the server would
// otherwise have to ask for (where you were, what was playing, which look,
// which browser, the last client-side errors) attached by itself.
import { el, toast } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { pushScope, popScope } from "./focus.js";
import { track, deviceClass } from "./usage.js";
import { netInfo, dataMode } from "./net.js";
import { trailTake, recentRequests, sessionMs } from "./trail.js";
import { trailText, safeRoute, short } from "./trail-core.js";
import { uaClass } from "./telemetry-core.js";

// A small ring of the last client errors — window errors, unhandled
// rejections, console.error calls — so a report carries what went wrong
// even when the viewer only saw "it didn't work".
const errors = [];
const remember = (msg) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${String(msg).slice(0, 300)}`;
  errors.push(line);
  if (errors.length > 20) errors.shift();
};
window.addEventListener("error", (e) => remember(`${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => remember(`rejection: ${e.reason && (e.reason.message || e.reason)}`));
{
  const orig = console.error.bind(console);
  console.error = (...args) => {
    try { remember(args.map((a) => (a && a.stack) || (typeof a === "object" ? JSON.stringify(a).slice(0, 200) : String(a))).join(" ")); } catch {}
    orig(...args);
  };
}

// The player registers what it's playing (and its start-up marks) so a
// report from inside it says which title and how it started.
let playing = null;
export const setPlayingContext = (ctx) => { playing = ctx; };

let version = null;
const versionP = api.version ? api.version().then((c) => { version = (c && c.version) || null; }).catch(() => {}) : Promise.resolve();

// (Get another version files its report with this whole context: replaceCopy.js → reportContext)
export const appVersion = () => versionP.then(() => version);

// ---------- what goes with a report besides the words (docs/report-trail.md) ----------
// Every fact is asked for on its own and a failure is only a missing line:
// nothing here may stop a report from going.
const fact = (fn) => { try { const v = fn(); return v == null || v === "" ? undefined : v; } catch { return undefined; } };
const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
// The other profiles' names never go in the trail (a toast saying who joined a party says "someone").
const otherNames = () => (state.profiles || []).filter((p) => p && p.name && (!state.profile || p.id !== state.profile.id)).map((p) => p.name);
const env = async () => {
  const [storage, cache] = await Promise.all([
    within(navigator.storage && navigator.storage.estimate ? navigator.storage.estimate().then((e) => (e && e.quota ? `${gb(e.usage || 0)} used of ${gb(e.quota)}` : undefined)) : undefined, 400),
    within(window.caches ? caches.keys().then((k) => k.filter((n) => /^aurora-/.test(n)).join(", ") || "none") : undefined, 400),
  ]);
  const ua = fact(() => uaClass(navigator.userAgent)) || {};
  const prefs = (state.profile && state.profile.prefs) || {};
  const c = fact(() => navigator.connection);
  return {
    app: "web",
    v: version || undefined,
    browser: ua.browser,
    os: ua.os,
    device: fact(deviceClass),
    screen: fact(() => `${screen.width}×${screen.height} @${Math.round((devicePixelRatio || 1) * 100) / 100}x`),
    viewport: fact(() => `${innerWidth}×${innerHeight}`),
    lang: fact(() => (navigator.languages && navigator.languages.length ? navigator.languages.slice(0, 3).join(", ") : navigator.language)),
    tz: fact(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    installed: fact(() => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true),
    sw: fact(() => {
      const sw = navigator.serviceWorker;
      if (!sw) return "not available";
      const ctl = sw.controller;
      return ctl ? `${ctl.state} (${short(new URL(ctl.scriptURL).pathname, 40)})` : "not in control";
    }),
    cache,
    storage,
    mem: fact(() => navigator.deviceMemory),
    cores: fact(() => navigator.hardwareConcurrency),
    saveData: fact(() => (c ? !!c.saveData : undefined)),
    dataMode: fact(dataMode),
    motion: fact(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
    look: fact(() => document.documentElement.dataset.look || "legacy"),
    subLang: fact(() => prefs.subLang),
    subsDefault: fact(() => (typeof prefs.subsDefault === "boolean" ? prefs.subsDefault : undefined)),
    audioLang: fact(() => prefs.audioLang),
    autoplayNext: fact(() => (typeof prefs.autoplayNext === "boolean" ? prefs.autoplayNext : undefined)),
    kids: fact(() => (state.profile && state.profile.kids ? true : undefined)),
    auth: fact(() => state.authMode),
    signedIn: fact(() => !!state.user),
    server: fact(() => location.origin),
    conn: fact(() => (c ? [c.effectiveType, c.downlink != null ? `${c.downlink} Mbit/s` : "", c.rtt != null ? `${c.rtt} ms` : ""].filter(Boolean).join(", ") : undefined)),
    socket: fact(() => (state.ws ? ["connecting", "open", "closing", "closed"][state.ws.readyState] : "none")),
    client: fact(() => state.clientId),
    up: fact(() => Math.round(sessionMs() / 1000)),
  };
};
// Everything a report sends besides the words: the old fields, and the
// trail, the facts, the player's state and the last request timings.
export const reportContext = async () => {
  await versionP;
  const sentAt = Date.now();
  const facts = await env().catch(() => null);
  let player = null;
  try { player = playing && playing.state ? playing.state() : null; } catch {}
  return {
    route: safeRoute(location.hash),
    title: playing ? playing.title : null,
    itemId: playing ? playing.id : null,
    look: document.documentElement.dataset.look || "legacy",
    ua: navigator.userAgent,
    viewport: `${innerWidth}×${innerHeight}`,
    online: navigator.onLine,
    net: (() => {
      const n = netInfo();
      return [n.tier, n.source, n.kbps != null ? `${n.kbps} kbit/s` : null, n.rtt != null ? `${n.rtt} ms` : null].filter(Boolean).join(" · ");
    })(),
    version,
    errors: errors.slice(),
    playMarks: playing && playing.marks ? playing.marks() : [],
    // the start-up of what is playing, step by step from the press (startline.js)
    startup: playing && playing.startup ? playing.startup() : null,
    // [report trail] what the viewer did before (trail.js), what this device is, what the player was doing
    profileId: state.profile ? state.profile.id : null,
    trail: trailTake({ sentAt, names: otherNames() }),
    env: facts,
    player,
    reqs: recentRequests(sentAt),
  };
};

export const showReportSheet = ({ hint = "" } = {}) => {
  if (document.querySelector(".report-wrap")) return;
  const box = el("textarea", { class: "report-text focusable", rows: 5, placeholder: "What went wrong? What did you expect to happen?" });
  const doing = el("input", { class: "report-doing focusable", placeholder: "What were you doing? (optional)" });
  const status = el("div", { class: "report-status" });
  const close = () => {
    document.removeEventListener("ui-back", onBack);
    popScope(wrap);
    wrap.classList.add("leaving");
    setTimeout(() => wrap.remove(), 220);
  };
  const onBack = (e) => { e.preventDefault(); close(); };
  const send = async () => {
    const text = box.value.trim();
    if (!text) { box.focus(); return; }
    sendBtn.disabled = true;
    status.textContent = "Sending…";
    // (what was shown under "See what will be sent" is what goes, if it was opened)
    const context = shown || await reportContext();
    try {
      await api.report(`${text}${doing.value.trim() ? `\n\nDoing: ${doing.value.trim()}` : ""}${hint ? `\n\n(${hint})` : ""}`, context, state.profile ? state.profile.name : null);
      toast("Sent — thank you. It landed with the admin.", "🛠️");
      track("feat", { f: "report" });
      close();
    } catch (e) {
      status.textContent = e.message || "Couldn't send it — try again in a moment";
      sendBtn.disabled = false;
    }
  };
  const sendBtn = el("button", { "data-ui": "report.send", class: "btn btn-primary focusable", onclick: send }, "Send report");
  // "See what will be sent": gathered when opened (not before — the sheet stays as quick
  // as it was), and exactly that goes when Send is pressed.
  let shown = null;
  const peekText = el("pre", { class: "report-peek-text", tabindex: "0" });
  const peek = el("details", { class: "report-peek" }, el("summary", { "data-ui": "report.peek", class: "focusable" }, "See what will be sent"), peekText);
  peek.addEventListener("toggle", async () => {
    if (!peek.open || shown) return;
    peekText.textContent = "Gathering…";
    const ctx = await reportContext();
    shown = ctx;
    peekText.textContent = [
      `Where: ${ctx.route || "#/"}${ctx.title ? ` · playing ${ctx.title}` : ""}`,
      trailText({ trail: ctx.trail, env: ctx.env, player: ctx.player, reqs: ctx.reqs }),
      ctx.errors.length ? `Errors this page saw:\n${ctx.errors.map((e) => `  ${e}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  });
  const card = el("div", { class: "look-notice sheet report", role: "dialog", "aria-modal": "true", "aria-label": "Report a problem", tabindex: "-1" },
    el("div", { class: "sheet-icon" }, "🛠️"),
    el("div", { class: "look-notice-title" }, "Report a problem"),
    // [report trail] the sheet tells the truth: what comes along, and (below) a look at it before it goes
    el("p", { class: "look-notice-text" }, "A few words is enough. Where you are, what's playing, your last steps in the app and facts about this device come along by themselves — never anything you typed, except a search you ran."),
    box,
    doing,
    el("div", { class: "report-ctx" },
      `${safeRoute(location.hash)}${playing ? ` · ${playing.title}` : ""} · ${document.documentElement.dataset.look === "glass" ? "Apple Horror" : "Legacy"}${errors.length ? ` · ${errors.length} recent error${errors.length > 1 ? "s" : ""} attached` : ""}`),
    peek,
    status,
    el("div", { class: "look-notice-actions" },
      el("button", { class: "btn focusable", onclick: close }, "Cancel"),
      sendBtn));
  const wrap = el("div", { class: "look-notice-wrap ui-overlay report-wrap", onclick: (e) => e.target === wrap && close() }, card);
  document.addEventListener("ui-back", onBack);
  // inside the fullscreen element when there is one (the player's), or the
  // sheet would sit outside the top layer and never paint
  (document.fullscreenElement || document.body).append(wrap);
  pushScope(wrap);
  // a phone shouldn't get its keyboard shoved up before the sheet is read
  const coarse = matchMedia("(pointer: coarse)").matches;
  setTimeout(() => (coarse ? card : box).focus({ preventScroll: true }), 60);
};
