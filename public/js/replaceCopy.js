// "Problem with this copy? → Get another version" (elia, 2026-10-26): the
// sheet. One tap says what is wrong with the copy in the library ("Other" first
// asks for a few words, then asks whether to get another version at all —
// Jesse's report, 2026-11-08), the next picks another version of the same
// title (only that pick starts a download), and the server swaps it in when
// it has landed — the copy you have plays until then, and your place, My
// List and ratings stay (src/media/replace.js has the rules). The TV app has
// the same sheet with the same words (tv-native ReplaceSheet).
//
//   openReplaceSheet({ libraryId, title })
//
// Opened from the title page (a film you own), an episode's sources (hold an
// episode) and the player's menu. Inside the player it is drawn in the
// fullscreen element, like Report a problem.
import { el, toast, fmtBytes, confirmSheet } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { pushScope, popScope } from "./focus.js";
import { onMessage } from "./ws.js";
import { track } from "./usage.js";
import { earlyOk, isEarly, sourceBadge } from "./releaseWords.js";
import { reportContext } from "./report.js";

export const COPY_PROBLEM = "Problem with this copy?";
export const GET_ANOTHER = "Get another version";
const GET_ANOTHER_NEXT = "Pick another version";
// The sheet's words, the TV's and the phone's letter for letter (tv-native replaceLogic.ts WORDS)
export const RC_WORDS = {
  step1Body: "Pick one. Nothing downloads until you pick another version — your place, My List and ratings stay.",
  step2Body: "Pick one and it starts downloading now. Your copy stays playable until the new one is in.",
  otherHeading: "What's wrong with it?",
  otherBody: "A few words, so the admin knows what you saw or heard. Nothing downloads yet.",
  otherPlaceholder: "What is wrong with this copy?",
  otherNext: "Next",
  otherEmpty: "Say what's wrong first — a few words is enough.",
  askHeading: "Get another version?",
  askBody: "Your words go to the admin either way. Another version downloads now and replaces this copy once it's in — or keep this copy and just send them.",
  askYes: "Yes — pick another version",
  askNo: "No — just send it",
  sent: "Sent — thank you. Your copy stays as it was.",
};
export const COPY_NOTE_MAX = 300;
// The report "No — just send it" files: the first line is the server's own for a
// replacement (src/media/replace.js), the TV's copyReport word for word.
export const copyReport = ({ reasonLabel, note }) =>
  `Problem with this copy: ${reasonLabel || "Other"} — ${String(note || "").replace(/\s+/g, " ").trim()}\nNo other version asked for — the copy stays.`;

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

// The ★ on a row: the server's (never a pre-release copy or a dub, never a
// release reported bad here — src/media/replace.js sources) — and a person
// replacing a copy BECAUSE of burned-in subtitles is never pointed at another
// copy with burned-in subtitles (then there is no clean one left: no ★). The
// TV's replaceRowText says the same.
export const replaceBestOf = (s, reason) => !!(s && s.recommended && !isEarly(s) && !s.dubbed && !(reason === "burned" && s.hardsub));

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

// What a report says about the client, as "Report a problem" says it — the
// last steps, the facts and the player's state included (docs/report-trail.md).
const contextNow = () => reportContext();

// Another version of yours ended without you (it failed, or the admin took it
// back): said wherever you are. The TV's replaceEndedToast says the same.
export const replaceEndedLine = (job) => {
  if (!job || !job.replaces || !job.mine) return null;
  const name = `“${job.title || "that title"}”`;
  if (job.status === "error") return `The other version of ${name} failed — your copy stays. Open “${COPY_PROBLEM}” to pick the next one.`;
  if (job.status === "declined") return `${state.adminName} said no to the other version of ${name} — your copy stays.`;
  if (job.status === "canceled" && job.canceledBy === "admin") return `${state.adminName} cancelled the other version of ${name} — your copy stays.`;
  return null;
};

export const openReplaceSheet = ({ libraryId, title = "" } = {}) => {
  if (!libraryId || document.querySelector(".replace-wrap")) return;
  const profile = state.profile ? state.profile.id : null;
  const body = el("div", { class: "rc-body" });
  const card = el("div", { class: "look-notice sheet replace-copy", role: "dialog", "aria-modal": "true", "aria-label": COPY_PROBLEM, tabindex: "-1" }, body);
  const wrap = el("div", { class: "look-notice-wrap ui-overlay replace-wrap", onclick: (e) => e.target === wrap && close() }, card);
  let step = "load"; // load | reasons | other | ask | sources | active | ended | refused
  let reason = null;
  let otherNote = ""; // "Other": the person's own words (asked for before anything else)
  let unsub = null;
  let info = null;
  let asking = false; // the "not the real release" question is up over the sheet (its own Back closes it)

  const close = () => {
    document.removeEventListener("ui-back", onBack);
    if (unsub) unsub();
    unsub = null;
    popScope(wrap);
    wrap.classList.add("leaving");
    setTimeout(() => wrap.remove(), 220);
  };
  const onBack = (e) => {
    if (asking) return;
    e.preventDefault();
    if (step === "sources") return reason === "other" ? showAsk() : showReasons();
    if (step === "ask") return showOther();
    if (step === "other") return showReasons();
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
          ? el("button", { "data-ui": "replace.cancel", type: "button", class: "btn focusable", onclick: () => doCancel() }, "Cancel — keep this copy")
          : !done && r.by ? el("div", { class: "rc-by" }, `Asked for by ${r.by}`) : null,
        // the first focus: a stray Enter must not cancel it
        el("button", { type: "button", class: "btn focusable rc-first", onclick: close }, "Close")),
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
          // the server's own words for how it ended, and the next candidates
          return load();
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
    // asked first, like every cancel (js/dlcancel.js)
    asking = true;
    const sure = await confirmSheet({
      title: "Cancel this version?",
      text: "Your copy stays as it was. What has come down so far is thrown away.",
      ok: "Cancel — keep this copy",
      cancel: "Keep going",
      icon: "🗑",
    });
    asking = false;
    if (!sure) {
      if (b) { b.disabled = false; b.focus({ preventScroll: true }); }
      return;
    }
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

  // ---- the last try ended without replacing anything: what happened, what next ----
  const showEnded = (last) => {
    step = "ended";
    paint(
      el("div", { class: "sheet-icon" }, "↩️"),
      ...head("That version didn't come through", null),
      el("div", { class: "rc-status", "aria-live": "polite" }, last.line),
      last.release ? el("div", { class: "rc-reason" }, `That was: ${last.release}${last.quality ? ` (${last.quality})` : ""}`) : null,
      el("div", { class: "rc-reason" }, `Reason: ${last.reasonLabel}`),
      el("p", { class: "look-notice-text" }, "Pick the next one, or keep this copy."),
      el("div", { class: "look-notice-actions" },
        el("button", { "data-ui": "replace.next", type: "button", class: "btn btn-primary focusable rc-first", onclick: () => { reason = last.reason; showSources(); } }, GET_ANOTHER_NEXT),
        el("button", { "data-ui": "replace.other", type: "button", class: "btn focusable", onclick: () => { otherNote = ""; showReasons(); } }, "Something else is wrong"),
        closeBtn("Keep this copy")),
    );
  };

  // ---- step 1: what is wrong ----
  const showReasons = () => {
    step = "reasons";
    const reasons = (info && info.reasons) || [];
    paint(
      el("div", { class: "sheet-icon" }, "🎞️"),
      ...head("What's wrong with this copy?", RC_WORDS.step1Body),
      title ? el("div", { class: "rc-title" }, title) : null,
      el("div", { class: "rc-reasons" }, ...reasons.map((r, i) =>
        el("button", {
          "data-ui": "replace.reason",
          type: "button",
          class: `rc-reason-btn focusable${i === 0 ? " rc-first" : ""}${reason === r.id ? " on" : ""}`,
          onclick: () => { reason = r.id; if (r.id === "other") showOther(); else showSources(); },
        }, r.label))),
      el("div", { class: "look-notice-actions" }, closeBtn("Cancel")),
    );
  };

  // ---- "Other": a few words first — nothing downloads ----
  const showOther = () => {
    step = "other";
    const field = el("textarea", {
      "data-ui": "replace.other.note",
      class: "rc-note rc-other-note focusable rc-first",
      placeholder: RC_WORDS.otherPlaceholder,
      maxlength: String(COPY_NOTE_MAX),
      rows: "3",
    });
    field.value = otherNote;
    const err = el("div", { class: "rc-error", role: "alert", hidden: true });
    const next = () => {
      const t = field.value.replace(/\s+/g, " ").trim();
      if (!t) {
        err.textContent = RC_WORDS.otherEmpty;
        err.hidden = false;
        field.focus({ preventScroll: true });
        return;
      }
      otherNote = t;
      showAsk();
    };
    field.addEventListener("input", () => { otherNote = field.value; err.hidden = true; });
    field.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); next(); } });
    paint(
      el("div", { class: "sheet-icon" }, "✍️"),
      ...head(RC_WORDS.otherHeading, RC_WORDS.otherBody),
      title ? el("div", { class: "rc-title" }, title) : null,
      field,
      err,
      el("div", { class: "look-notice-actions" },
        el("button", { "data-ui": "replace.other.next", type: "button", class: "btn btn-primary focusable", onclick: next }, RC_WORDS.otherNext),
        el("button", { type: "button", class: "btn focusable", onclick: showReasons }, "‹ Back")),
    );
  };

  // ---- "Other", then: another version, or just the words ----
  const showAsk = () => {
    step = "ask";
    const err = el("div", { class: "rc-error", role: "alert", hidden: true });
    const send = async (btn) => {
      btn.disabled = true;
      try {
        const label = ((info && info.reasons) || []).find((r) => r.id === "other")?.label || "Other";
        await api.report(copyReport({ reasonLabel: label, note: otherNote }),
          { ...(await contextNow()), title: title || null, itemId: libraryId, note: otherNote },
          state.profile ? state.profile.name : null);
        toast(RC_WORDS.sent, "🛠️");
        track("feat", { f: "replace-note-only" });
        close();
      } catch (e) {
        btn.disabled = false;
        err.textContent = (e && e.message) || "Couldn't send it — try again in a moment";
        err.hidden = false;
      }
    };
    paint(
      el("div", { class: "sheet-icon" }, "🎞️"),
      ...head(RC_WORDS.askHeading, RC_WORDS.askBody),
      el("p", { class: "rc-quote" }, `“${otherNote}”`),
      err,
      el("div", { class: "look-notice-actions" },
        el("button", { "data-ui": "replace.other.another", type: "button", class: "btn btn-primary focusable rc-first", onclick: () => { reason = "other"; showSources(); } }, RC_WORDS.askYes),
        el("button", { "data-ui": "replace.other.send", type: "button", class: "btn focusable", onclick: (ev) => send(ev.currentTarget) }, RC_WORDS.askNo),
        el("button", { type: "button", class: "btn focusable", onclick: showOther }, "‹ Back")),
    );
  };

  // ---- step 2: which version ----
  let expanded = false;
  const showSources = async () => {
    step = "sources";
    // (Other: the words were asked for already and go with the request)
    const note = reason === "other" ? null : el("input", { class: "rc-note focusable", placeholder: "Anything else? (optional)", maxlength: "300" });
    const listHost = el("div", { class: "rc-list" }, el("div", { class: "sources-loading" }, el("span", { class: "mini-spinner" }), "Finding other versions…"));
    const back = el("button", { type: "button", class: "btn small focusable rc-back", onclick: () => (reason === "other" ? showAsk() : showReasons()) }, "‹ Back");
    const cur = info && info.current;
    const noteLine = el("div", { class: "rc-now rc-lang-note", hidden: true });
    paint(
      ...head(GET_ANOTHER, RC_WORDS.step2Body),
      cur ? el("div", { class: "rc-now" }, `Now: ${[cur.quality, cur.sizeBytes ? fmtBytes(cur.sizeBytes) : null, cur.release].filter(Boolean).join(" · ")}`) : null,
      noteLine,
      listHost,
      note,
      el("div", { class: "look-notice-actions" }, back, closeBtn("Cancel")),
    );
    let streams = [];
    try {
      const got = await api.replaceSources(libraryId, profile, reason);
      streams = got.streams || [];
      if (got.note) { noteLine.textContent = got.note; noteLine.hidden = false; }
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
          class: `rc-src focusable${i === 0 ? " rc-first" : ""}${s.badHere ? " bad" : ""}${isEarly(s) ? " early" : ""}`,
          onclick: (ev) => pick(s, ev.currentTarget, note ? note.value : otherNote),
        },
        el("span", { class: "rc-src-q" }, s.quality || "?"),
        el("span", { class: "rc-src-main" },
          el("span", { class: "rc-src-name" }, s.release || s.provider || "Unnamed release"),
          el("span", { class: "rc-src-meta" },
            replaceBestOf(s, reason) ? el("b", { class: "rc-best" }, "★ BEST") : null,
            s.langLabel ? el("b", { class: "rc-lang" }, s.langLabel) : null,
            // what kind of copy it is — the title page's marks (CAM, TS, BURNED-IN SUBS)
            sourceBadge(s) ? el("b", { class: "rc-kind", title: s.warning || "" }, sourceBadge(s)) : null,
            s.badHere ? el("b", { class: "rc-bad" }, `Reported here: ${s.badHere.label}`) : s.tried ? el("b", { class: "rc-bad" }, s.tried.label) : null,
            factsOf(s)),
          (isEarly(s) || s.hardsub) && s.warning ? el("span", { class: "rc-warn" }, s.warning) : null))),
        shown.length < streams.length
          ? el("button", { type: "button", class: "focusable src-more", onclick: () => { expanded = true; render(); focusFirst(); } }, `Show all ${streams.length}`)
          : null,
      ].filter(Boolean));
      focusFirst();
    };
    render();
  };

  const pick = async (s, btn, noteText) => {
    // a copy made before the film is out at home: asked first, the title
    // page's words ("This is not the real release" — js/releaseWords.js)
    asking = isEarly(s);
    const go = await earlyOk(s, "download");
    asking = false;
    if (!go) return btn.isConnected && btn.focus({ preventScroll: true });
    if (!wrap.isConnected || step !== "sources") return;
    for (const b of body.querySelectorAll(".rc-src")) b.disabled = true;
    btn.classList.add("busy");
    try {
      const cleanNote = String(noteText || "").trim() || undefined;
      const r = await api.replaceCopy(libraryId, {
        profile, reason, note: cleanNote,
        source: { infoHash: s.infoHash, fileIdx: s.fileIdx || 0 },
        context: { ...(await contextNow()), note: cleanNote || null },
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
    if (info.last) return showEnded(info.last);
    showReasons();
  };

  document.addEventListener("ui-back", onBack);
  (document.fullscreenElement || document.body).append(wrap);
  pushScope(wrap);
  load();
};
