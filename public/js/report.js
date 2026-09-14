// Report a problem: a sheet with one box, and everything the server would
// otherwise have to ask for (where you were, what was playing, which look,
// which browser, the last client-side errors) attached by itself.
import { el, toast } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { pushScope, popScope } from "./focus.js";
import { track } from "./usage.js";

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
const versionP = api.changelog ? api.changelog().then((c) => { version = c && (c.version || (c.entries && c.entries[0] && c.entries[0].version)) || null; }).catch(() => {}) : Promise.resolve();

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
    await versionP;
    const context = {
      route: location.hash,
      title: playing ? playing.title : null,
      itemId: playing ? playing.id : null,
      look: document.documentElement.dataset.look || "legacy",
      ua: navigator.userAgent,
      viewport: `${innerWidth}×${innerHeight}`,
      online: navigator.onLine,
      version,
      errors: errors.slice(),
      playMarks: playing && playing.marks ? playing.marks() : [],
    };
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
  const sendBtn = el("button", { class: "btn btn-primary focusable", onclick: send }, "Send report");
  const card = el("div", { class: "look-notice sheet report", role: "dialog", "aria-modal": "true", "aria-label": "Report a problem", tabindex: "-1" },
    el("div", { class: "sheet-icon" }, "🛠️"),
    el("div", { class: "look-notice-title" }, "Report a problem"),
    el("p", { class: "look-notice-text" }, "A few words is enough. Where you are, what's playing and the last errors this page saw come along by themselves."),
    box,
    doing,
    el("div", { class: "report-ctx" },
      `${location.hash}${playing ? ` · ${playing.title}` : ""} · ${document.documentElement.dataset.look === "glass" ? "Apple Horror" : "Legacy"}${errors.length ? ` · ${errors.length} recent error${errors.length > 1 ? "s" : ""} attached` : ""}`),
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
