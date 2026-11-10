// "Save offline — at what quality?" A sheet with what the server can make
// for THIS file on THIS device, each with its real (or honestly estimated)
// size: the original as it is or repackaged in seconds, or a 1080p / 720p /
// 480p copy the server converts first. One press picks and starts.
//
// The last choice is remembered and marked; "Always use this size" stores it
// as the standing preference (Preferences → Offline changes it back to Ask).
import { el, fmtBytes } from "./ui.js";
import { pushScope, popScope } from "./focus.js";
import { preferredQuality, setPreferredQuality, soundLabel } from "./offline.js";

const LAST_KEY = "aurora-offline-last";
const lastPicked = () => {
  try { return localStorage.getItem(LAST_KEY) || ""; } catch { return ""; }
};

// Resolves the chosen quality ("original" | "1080" | "720" | "480"), or null.
// A standing preference that this file can honour skips the sheet.
// `lead`: the sheet's sentence, when the usual one does not fit (a title that
// is not on the server yet — offlineWish.js).
// `toggle`: { label, value } — one more choice as a chip (offlineWish.js: "and
// every new episode of season N"); its `value` is set when pressed.
export const pickOfflineQuality = (options, { title = "", lead = "", toggle = null } = {}) =>
  new Promise((resolve) => {
    const pref = preferredQuality();
    if (pref !== "ask" && options.some((o) => o.quality === pref)) return resolve(pref);

    let always = false;
    let done = false;
    const finish = (q) => {
      if (done) return;
      done = true;
      document.removeEventListener("ui-back", onBack);
      popScope(wrap);
      wrap.classList.add("leaving");
      setTimeout(() => wrap.remove(), 240);
      if (q) {
        try { localStorage.setItem(LAST_KEY, q); } catch {}
        if (always) setPreferredQuality(q);
      }
      resolve(q);
    };
    const onBack = (e) => { e.preventDefault(); finish(null); };
    const last = lastPicked();
    const rows = options.map((o) =>
      el("button", { class: "offline-opt focusable" + (o.quality === last ? " last" : ""), onclick: () => finish(o.quality) },
        el("span", { class: "offline-opt-main" },
          el("span", { class: "offline-opt-label" }, o.label,
            o.instant && el("span", { class: "offline-opt-tag" }, "FAST"),
            o.quality === last && el("span", { class: "offline-opt-tag dim" }, "LAST TIME")),
          el("span", { class: "offline-opt-detail" }, [o.detail, o.note].filter(Boolean).join(" — "))),
        el("span", { class: "offline-opt-size" }, o.sizeBytes ? `${o.estimated && !o.instant ? "≈ " : ""}${fmtBytes(o.sizeBytes)}` : "")));
    const alwaysBtn = el("button", {
      class: "chip focusable",
      "aria-pressed": "false",
      onclick: () => {
        always = !always;
        alwaysBtn.classList.toggle("on", always);
        alwaysBtn.setAttribute("aria-pressed", always ? "true" : "false");
      },
    }, "Always use the size I pick");
    const toggleBtn = toggle && el("button", {
      class: "chip focusable offline-toggle",
      "aria-pressed": "false",
      onclick: () => {
        toggle.value = !toggle.value;
        toggleBtn.classList.toggle("on", toggle.value);
        toggleBtn.setAttribute("aria-pressed", toggle.value ? "true" : "false");
      },
    }, toggle.label);
    // The sound, when the file has more than one (one copy = one language):
    // options.audio from the server, options.chosenAudio picked for the
    // person (offline.js) — a press here changes it.
    const sounds = Array.isArray(options.audio) && options.audio.length > 1 ? options.audio : [];
    const soundBtns = sounds.map((t, i) => el("button", {
      class: "chip focusable offline-sound" + (i === options.chosenAudio ? " on" : ""),
      "aria-pressed": i === options.chosenAudio ? "true" : "false",
      dir: "auto",
      onclick: () => {
        options.chosenAudio = i;
        soundBtns.forEach((b, k) => { b.classList.toggle("on", k === i); b.setAttribute("aria-pressed", k === i ? "true" : "false"); });
      },
    }, soundLabel(t)));
    const soundRow = sounds.length ? el("div", { class: "offline-sounds", role: "group", "aria-label": "Sound" },
      el("span", { class: "offline-sounds-label" }, "Sound"), soundBtns) : null;
    const card = el("div", { class: "look-notice sheet offline-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Save offline" },
      el("div", { class: "sheet-icon" }, "📱"),
      el("div", { class: "look-notice-title" }, "Save offline — which size?"),
      el("p", { class: "look-notice-text" }, lead || (title ? `“${title}” will be kept inside Aurora on this device and play with no server in reach.` : "It will be kept inside Aurora on this device and play with no server in reach.")),
      soundRow,
      el("div", { class: "offline-opts" }, rows),
      el("div", { class: "look-notice-actions offline-sheet-actions" },
        toggleBtn,
        alwaysBtn,
        el("button", { class: "btn focusable", onclick: () => finish(null) }, "Not now")));
    const wrap = el("div", { class: "look-notice-wrap ui-overlay", onclick: (e) => e.target === wrap && finish(null) }, card);
    document.addEventListener("ui-back", onBack);
    (document.fullscreenElement || document.body).append(wrap);
    pushScope(wrap);
    setTimeout(() => (card.querySelector(".offline-opt.last") || card.querySelector(".offline-opt"))?.focus({ preventScroll: true }), 60);
  });
