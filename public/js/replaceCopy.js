// "Problem with this copy? → Get another version" (elia, 2026-10-26): the
// sheet. One tap says what is wrong with the copy in the library, the next
// picks another version of the same title, and the server swaps it in when
// it has landed — the copy you have plays until then, and your place, My
// List and ratings stay (src/media/replace.js has the rules). The TV app has
// the same sheet with the same words (tv-native ReplaceSheet).
//
//   openReplaceSheet({ libraryId, title })
//
// Opened from the title page (a film you own), an episode's sources (hold an
// episode) and the player's menu. Inside the player it is drawn in the
// fullscreen element, like Report a problem.
import { el, toast, fmtBytes } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { pushScope, popScope } from "./focus.js";
import { onMessage } from "./ws.js";
import { track } from "./usage.js";

export const COPY_PROBLEM = "Problem with this copy?";
export const GET_ANOTHER = "Get another version";

// The words for a replacement on its way — the TV says the same (tv-native).
export const replaceStatusText = (r) => {
  if (!r) return "";
  if (r.waiting) return "Ready — it takes over once nobody is playing this copy.";
  if (r.status === "done") return "The new version is in.";
  if (r.status === "pending") return "Waiting for approval";
  if (r.status === "approved") return "Queued to download";
  if (r.status === "downloading") {
    if (r.phase === "copying") return "Almost there…";
    const pct = Math.round((r.progress || 0) * 100);
    return pct > 0 ? `Downloading · ${pct}%` : "Starting download…";
  }
  if (r.status === "error") return "The download failed — your copy stays as it was.";
  if (r.status === "canceled" || r.status === "declined") return "Cancelled — your copy stays as it was.";
  return "";
};

// One source as a line of facts: "1080p · 2.1 GB · 120 seeders".
const factsOf = (s) => [s.qualityLabel || s.quality, s.sizeBytes ? fmtBytes(s.sizeBytes) : s.sizeString, s.seeders ? `${s.seeders} seeders` : null, s.provider].filter(Boolean).join(" · ");

// Who may see the entry at all: a grown-up profile on a server with sources.
export const canOfferReplace = () => !!(state.profile && !state.profile.kids && state.torrents !== false);

// The small line under a title you own ("Problem with this copy? Get another version").
export const copyProblemButton = ({ libraryId, title, ui = "detail.replace", className = "" }) =>
  el("button", {
    "data-ui": ui === "detail.episode.replace" ? "detail.episode.replace" : "detail.replace",
    type: "button",
    class: `copy-problem focusable ${className}`.trim(),
    "aria-haspopup": "dialog",
    onclick: () => openReplaceSheet({ libraryId, title }),
  }, el("span", { class: "copy-problem-q" }, COPY_PROBLEM), el("span", { class: "copy-problem-a" }, GET_ANOTHER));

const contextNow = () => ({
  route: location.hash,
  look: document.documentElement.dataset.look || "legacy",
  ua: navigator.userAgent,
  viewport: `${innerWidth}×${innerHeight}`,
  online: navigator.onLine,
});

export const openReplaceSheet = ({ libraryId, title = "" } = {}) => {
  if (!libraryId || document.querySelector(".replace-wrap")) return;
  const profile = state.profile ? state.profile.id : null;
  const body = el("div", { class: "rc-body" });
  const card = el("div", { class: "look-notice sheet replace-copy", role: "dialog", "aria-modal": "true", "aria-label": COPY_PROBLEM, tabindex: "-1" }, body);
  const wrap = el("div", { class: "look-notice-wrap ui-overlay replace-wrap", onclick: (e) => e.target === wrap && close() }, card);
  let step = "load"; // load | reasons | sources | active | refused
  let reason = null;
  let unsub = null;
  let info = null;

  const close = () => {
    document.removeEventListener("ui-back", onBack);
    if (unsub) unsub();
    unsub = null;
    popScope(wrap);
    wrap.classList.add("leaving");
    setTimeout(() => wrap.remove(), 220);
  };
  const onBack = (e) => {
    e.preventDefault();
    if (step === "sources") return showReasons();
    close();
  };
  const focusFirst = () => setTimeout(() => (body.querySelector(".rc-first") || body.querySelector(".focusable") || card).focus({ preventScroll: true }), 40);
  const paint = (...nodes) => { body.replaceChildren(...nodes.filter(Boolean)); focusFirst(); };
  const head = (text, sub) => [
    el("div", { class: "look-notice-title" }, text),
    sub ? el("p", { class: "look-notice-text" }, sub) : null,
  ];
  const closeBtn = (label = "Close") => el("button", { type: "button", class: "btn focusable", onclick: close }, label);

  const showRefused = (why) => {
    step = "refused";
    paint(el("div", { class: "sheet-icon" }, "🎞️"), ...head(COPY_PROBLEM, why || "This copy can't be replaced from here."), el("div", { class: "look-notice-actions" }, closeBtn()));
  };

  // ---- a replacement on its way ----
  const showActive = (r) => {
    step = "active";
    info = { ...(info || {}), active: r };
    const bar = el("div", { class: "rc-bar" }, el("i", { style: { width: `${Math.round((r.waiting ? 1 : r.progress || 0) * 100)}%` } }));
    const line = el("div", { class: "rc-status", "aria-live": "polite" }, replaceStatusText(r));
    const done = r.status === "done";
    paint(
      el("div", { class: "sheet-icon" }, done ? "✅" : "🎞️"),
      ...head(done ? "The new version is in" : "Another version is on its way", null),
      line,
      done ? null : bar,
      el("div", { class: "rc-reason" }, `Reason: ${r.reasonLabel}`),
      el("div", { class: "look-notice-actions" },
        !done && r.mine
          ? el("button", { "data-ui": "replace.cancel", type: "button", class: "btn focusable rc-first", onclick: () => doCancel() }, "Cancel — keep this copy")
          : !done && r.by ? el("div", { class: "rc-by" }, `Asked for by ${r.by}`) : null,
        closeBtn(done ? "Close" : "Close")),
    );
    if (!unsub) {
      unsub = onMessage("download_update", ({ job }) => {
        if (!wrap.isConnected) { if (unsub) unsub(); unsub = null; return; }
        if (!job || !job.replaces || job.replaces.libraryId !== libraryId || step !== "active") return;
        const cur = info.active || {};
        const next = { ...cur, status: job.status, phase: job.phase, progress: job.progress || 0, waiting: !!job.replaceWait };
        if (["canceled", "declined", "error"].includes(job.status)) {
          if (unsub) unsub();
          unsub = null;
          return paint(el("div", { class: "sheet-icon" }, "↩️"), ...head(COPY_PROBLEM, replaceStatusText(next)), el("div", { class: "look-notice-actions" }, closeBtn()));
        }
        // a live repaint of the line and the bar only (focus stays put)
        info.active = next;
        if (job.status === "done") return showActive(next);
        line.textContent = replaceStatusText(next);
        const fill = bar.querySelector("i");
        if (fill) fill.style.width = `${Math.round((next.waiting ? 1 : next.progress || 0) * 100)}%`;
      });
    }
  };
  const doCancel = async () => {
    const b = body.querySelector("[data-ui='replace.cancel']");
    if (b) b.disabled = true;
    try {
      await api.replaceCancel(libraryId, profile);
      toast("Cancelled — your copy stays as it was.", "↩️");
      track("feat", { f: "replace-cancel" });
      close();
    } catch (e) {
      if (b) b.disabled = false;
      toast((e && e.message) || "Couldn't cancel it — try again", "⚠️");
    }
  };

  // ---- step 1: what is wrong ----
  const showReasons = () => {
    step = "reasons";
    const reasons = (info && info.reasons) || [];
    paint(
      el("div", { class: "sheet-icon" }, "🎞️"),
      ...head("What's wrong with this copy?", "Pick one. Another version replaces it — your place, My List and ratings stay."),
      title ? el("div", { class: "rc-title" }, title) : null,
      el("div", { class: "rc-reasons" }, ...reasons.map((r, i) =>
        el("button", {
          "data-ui": "replace.reason",
          type: "button",
          class: `rc-reason-btn focusable${i === 0 ? " rc-first" : ""}${reason === r.id ? " on" : ""}`,
          onclick: () => { reason = r.id; showSources(); },
        }, r.label))),
      el("div", { class: "look-notice-actions" }, closeBtn("Cancel")),
    );
  };

  // ---- step 2: which version ----
  let expanded = false;
  const showSources = async () => {
    step = "sources";
    const note = el("input", { class: "rc-note focusable", placeholder: "Anything else? (optional)", maxlength: "300" });
    const listHost = el("div", { class: "rc-list" }, el("div", { class: "sources-loading" }, el("span", { class: "mini-spinner" }), "Finding other versions…"));
    const back = el("button", { type: "button", class: "btn small focusable rc-back", onclick: showReasons }, "‹ Back");
    const cur = info && info.current;
    paint(
      ...head(GET_ANOTHER, "Your copy stays playable until the new one is in."),
      cur ? el("div", { class: "rc-now" }, `Now: ${[cur.quality, cur.sizeBytes ? fmtBytes(cur.sizeBytes) : null, cur.release].filter(Boolean).join(" · ")}`) : null,
      listHost,
      note,
      el("div", { class: "look-notice-actions" }, back, closeBtn("Cancel")),
    );
    let streams = [];
    try {
      streams = (await api.replaceSources(libraryId, profile)).streams || [];
    } catch (e) {
      if (step !== "sources") return;
      listHost.replaceChildren(el("div", { class: "sources-empty" }, (e && e.message) || "Couldn't reach the source provider."));
      return;
    }
    if (step !== "sources" || !wrap.isConnected) return;
    const render = () => {
      if (!streams.length) {
        listHost.replaceChildren(el("div", { class: "sources-empty" }, "No other versions found."));
        return;
      }
      const FIRST = 6;
      const shown = expanded || streams.length <= FIRST + 1 ? streams : streams.slice(0, FIRST);
      listHost.replaceChildren(...[
        ...shown.map((s, i) => el("button", {
          "data-ui": "replace.pick",
          type: "button",
          class: `rc-src focusable${i === 0 ? " rc-first" : ""}${s.badHere ? " bad" : ""}`,
          onclick: (ev) => pick(s, ev.currentTarget, note.value),
        },
        el("span", { class: "rc-src-q" }, s.quality || "?"),
        el("span", { class: "rc-src-main" },
          el("span", { class: "rc-src-name" }, s.release || s.provider || "Unnamed release"),
          el("span", { class: "rc-src-meta" },
            s.recommended ? el("b", { class: "rc-best" }, "★ BEST") : null,
            s.badHere ? el("b", { class: "rc-bad" }, `Reported here: ${s.badHere.label}`) : null,
            factsOf(s))))),
        shown.length < streams.length
          ? el("button", { type: "button", class: "focusable src-more", onclick: () => { expanded = true; render(); focusFirst(); } }, `Show all ${streams.length}`)
          : null,
      ].filter(Boolean));
      focusFirst();
    };
    render();
  };

  const pick = async (s, btn, noteText) => {
    for (const b of body.querySelectorAll(".rc-src")) b.disabled = true;
    btn.classList.add("busy");
    try {
      const r = await api.replaceCopy(libraryId, {
        profile, reason, note: String(noteText || "").trim() || undefined,
        source: { infoHash: s.infoHash, fileIdx: s.fileIdx || 0 },
        context: contextNow(),
      });
      toast("Getting another version — your copy stays playable until it's in.", "🎞️");
      track("feat", { f: "replace" });
      showActive(r.replacement);
    } catch (e) {
      for (const b of body.querySelectorAll(".rc-src")) b.disabled = false;
      btn.classList.remove("busy");
      toast((e && e.message) || "Couldn't start it — try again", "⚠️");
      if (e && e.code === "busy") load();
    }
  };

  const load = async () => {
    step = "load";
    paint(el("div", { class: "sources-loading" }, el("span", { class: "mini-spinner" }), "Looking at this copy…"));
    try {
      info = await api.replaceInfo(libraryId, profile);
    } catch (e) {
      return showRefused((e && e.message) || "Couldn't reach the server.");
    }
    if (!wrap.isConnected) return;
    if (info.active) return showActive(info.active);
    if (!info.can) return showRefused(info.why);
    showReasons();
  };

  document.addEventListener("ui-back", onBack);
  (document.fullscreenElement || document.body).append(wrap);
  pushScope(wrap);
  load();
};
