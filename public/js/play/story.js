// Aurora Play — the story shell: a full-screen run of chapters with the
// segments of progress along the top (Wrapped's form, ready for any feature
// that tells something in steps).
//
//   const story = createStory({
//     host,                   where it mounts (it covers the viewport itself)
//     label,                  what it is called ("Aurora Wrapped") — the
//                             dialog's name for screen readers
//     chapters: [{ id, label, ms, hold, build(stage, api) }],
//                             `ms` how long it stays before moving on by
//                             itself; `hold` never moves on by itself (a
//                             finale). build() draws the chapter into
//                             `stage` and may return { enter(), leave() }.
//     start = 0, still = reduced(),
//                             still: no auto-advance and no motion (the
//                             person moves on by hand; every chapter is drawn
//                             at its final state)
//     top,                    a node for the top-left corner (a title chip)
//     onExit(),               Esc / Back / the close button
//     onSkip(),               "Skip to the summary"
//     onEnd(),                moving on from the last chapter
//   })
//   -> { el, go(i), next(), prev(), pause(), resume(), destroy(), get index }
//
//   api (given to build): { still, at(ms, fn), signal, say(text), story }
//     at(ms, fn)   run fn `ms` into the chapter on the STORY's clock: it
//                  stops while the story is paused (hold, Space, the tab
//                  hidden) and is dropped when the chapter is left. Timed
//                  beats inside a chapter use this or CSS animation delays
//                  (which .is-paused freezes too) — never a bare setTimeout.
//     signal       aborted when the chapter is left
//     say(text)    tell screen readers what the motion shows
//
// Moving: tap the right two thirds / swipe left / Right arrow / the > button
// for next; tap the left third / swipe right / Left arrow for back; press
// and hold anywhere to pause (let go to carry on); Space or K pauses too;
// Home goes to the first chapter, End to the summary, Esc / Back leaves
// (the arrows and Back arrive through the app's key hub, focus.js: a TV
// remote works the same; the frame is a .ui-overlay with its own focus scope). Controls
// inside a chapter (buttons, links, [data-no-tap]) keep their own presses.
// The frame's own buttons are tagged story.* for the usage stats (the screen
// they were pressed on says which story).
import { el } from "../ui.js";
import { pushScope, popScope } from "../focus.js";
import { reduced } from "./motion.js";
import { pressable } from "./press.js";

const ICON = {
  pause: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.5" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.5" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const HOLD_MS = 190; // a press longer than this is a hold (pause), not a tap
const SWIPE_PX = 48;
const LEAVE_MS = 420;

export const createStory = ({ host, label = "Story", chapters, start = 0, still = reduced(), top = null, onExit, onSkip, onEnd, skipLabel = "Skip to the summary" }) => {
  let index = -1;
  let userPaused = false;
  let holding = false;
  let hiddenPause = false;
  let destroyed = false;
  let current = null; // { node, ctl, timers, abort }

  // ---- the story's clock: stops while paused ----
  let base = 0;
  let since = performance.now();
  let running = true;
  const elapsed = () => base + (running ? performance.now() - since : 0);
  const paused = () => userPaused || holding || hiddenPause;

  // ---- the frame ----
  const segs = chapters.map((c) => el("div", { class: "play-seg" }, el("i", { class: "play-seg-fill" })));
  const live = el("div", { class: "play-sr", "aria-live": "polite", role: "status" });
  const stage = el("div", { class: "play-story-stage" });
  const pauseBtn = el("button", { class: "play-icon-btn play-press focusable", type: "button", "aria-label": "Pause", "data-ui": "story.pause", html: ICON.pause });
  // (a phone has room for "Skip" only: the long words stay its name)
  const skipBtn = el("button", { class: "play-chip play-chip--ghost play-press focusable play-skip", type: "button", "data-ui": "story.skip", "aria-label": skipLabel },
    el("span", { class: "play-skip-long", "aria-hidden": "true" }, skipLabel), el("span", { class: "play-skip-short", "aria-hidden": "true" }, "Skip"));
  const closeBtn = el("button", { class: "play-icon-btn play-press focusable", type: "button", "aria-label": "Close", "data-ui": "story.close", html: ICON.close });
  const prevBtn = el("button", { class: "play-story-nav play-story-nav--prev", type: "button", "aria-label": "Previous", "data-ui": "story.prev", html: ICON.prev });
  const nextBtn = el("button", { class: "play-story-nav play-story-nav--next", type: "button", "aria-label": "Next", "data-ui": "story.next", html: ICON.next });
  const root = el("div", {
    class: `play-story play-surface ui-overlay${still ? " is-still" : ""}`,
    role: "dialog", "aria-modal": "true", "aria-label": label, tabindex: "-1",
  },
    el("div", { class: "play-story-chrome" },
      el("div", { class: "play-story-bar", "aria-hidden": "true" }, ...segs),
      el("div", { class: "play-story-top" },
        el("div", { class: "play-story-title" }, top),
        el("div", { class: "play-story-actions" }, still ? null : pauseBtn, onSkip ? skipBtn : null, closeBtn),
      ),
    ),
    stage, prevBtn, nextBtn, live,
  );
  [pauseBtn, skipBtn, closeBtn].forEach((b) => pressable(b));

  const say = (text) => { live.textContent = ""; if (text) requestAnimationFrame(() => { live.textContent = text; }); };

  // ---- timers on the story clock ----
  const schedule = (t) => {
    clearTimeout(t.handle);
    if (!running || t.done) return;
    t.handle = setTimeout(() => { t.done = true; if (!destroyed) t.fn(); }, Math.max(0, t.at - elapsed()));
  };
  const setRunning = () => {
    const want = !paused();
    if (want === running) return;
    if (want) {
      since = performance.now();
      running = true;
      if (current) current.timers.forEach(schedule);
    } else {
      base = elapsed();
      running = false;
      if (current) current.timers.forEach((t) => clearTimeout(t.handle));
    }
    root.classList.toggle("is-paused", !running);
    root.classList.toggle("is-holding", holding);
    pauseBtn.innerHTML = userPaused ? ICON.play : ICON.pause;
    pauseBtn.setAttribute("aria-label", userPaused ? "Play" : "Pause");
  };

  const paintSegs = () => {
    segs.forEach((s, i) => {
      s.classList.toggle("is-done", i < index);
      s.classList.toggle("is-now", i === index);
      const c = chapters[i];
      s.style.setProperty("--ms", `${(c && c.ms) || 6000}ms`);
      s.classList.toggle("is-hold", !!(c && c.hold) || still);
    });
  };

  const leaveCurrent = (dir) => {
    if (!current) return;
    const old = current;
    current = null;
    old.timers.forEach((t) => { t.done = true; clearTimeout(t.handle); });
    try { old.abort.abort(); } catch {}
    try { old.ctl && old.ctl.leave && old.ctl.leave(); } catch {}
    if (still) { old.node.remove(); return; }
    old.node.classList.remove("is-in");
    old.node.classList.add("is-leaving", dir > 0 ? "to-prev" : "to-next");
    old.node.setAttribute("aria-hidden", "true");
    setTimeout(() => old.node.remove(), LEAVE_MS);
  };

  const go = (i, dir = i >= index ? 1 : -1) => {
    if (destroyed) return;
    if (i < 0) i = 0;
    if (i >= chapters.length) { if (onEnd) onEnd(); return; }
    leaveCurrent(dir);
    index = i;
    // a fresh clock per chapter
    base = 0;
    since = performance.now();
    const c = chapters[i];
    const node = el("section", { class: `play-chapter play-chapter--${c.id} ${dir > 0 ? "from-next" : "from-prev"}`, "aria-label": c.label || "" });
    const abort = new AbortController();
    const timers = [];
    current = { node, ctl: null, timers, abort };
    const api = {
      still, story: handle, signal: abort.signal, say,
      at: (ms, fn) => {
        const t = { at: ms, fn, handle: 0, done: false };
        timers.push(t);
        schedule(t);
        return () => { t.done = true; clearTimeout(t.handle); };
      },
    };
    stage.append(node);
    try { current.ctl = c.build(node, api) || null; } catch (e) { console.warn("[play] a chapter failed to draw:", e && e.message); }
    paintSegs();
    // restart the current segment's fill animation from zero
    const fill = segs[i] && segs[i].firstChild;
    if (fill) { fill.style.animation = "none"; void fill.offsetWidth; fill.style.animation = ""; }
    prevBtn.disabled = i === 0;
    requestAnimationFrame(() => {
      if (current && current.node === node) {
        node.classList.add("is-in");
        try { current.ctl && current.ctl.enter && current.ctl.enter(); } catch (e) { console.warn("[play] a chapter failed to start:", e && e.message); }
      }
    });
    if (!still && !c.hold) api.at(c.ms || 6000, () => go(index + 1, 1));
    if (c.say) say(`${i + 1} of ${chapters.length}. ${c.say}`);
    else say(`${i + 1} of ${chapters.length}. ${c.label || ""}`);
    // a press while paused moves on and plays again: the pause was for this chapter
    if (userPaused) { userPaused = false; }
    setRunning();
  };
  const next = () => go(index + 1, 1);
  const prev = () => go(Math.max(0, index - 1), -1);

  // ---- input ----
  let down = null; // { x, y, t, timer, id }
  const interactive = (t) => !!(t && t.closest && t.closest("button, a, input, select, textarea, [data-no-tap]"));
  const onDown = (e) => {
    if (e.button > 0 || interactive(e.target)) return;
    down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, moved: false };
    down.timer = setTimeout(() => { if (down && !down.moved) { holding = true; setRunning(); } }, HOLD_MS);
  };
  const onMove = (e) => {
    if (!down || e.pointerId !== down.id) return;
    if (Math.abs(e.clientX - down.x) > 12 || Math.abs(e.clientY - down.y) > 12) down.moved = true;
  };
  const onUp = (e) => {
    if (!down || e.pointerId !== down.id) return;
    clearTimeout(down.timer);
    const d = down;
    down = null;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (holding) { holding = false; setRunning(); return; }
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.2) return dx < 0 ? next() : prev();
    if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5 && e.pointerType === "touch") return onExit && onExit(); // pull down to leave
    if (d.moved) return;
    const box = root.getBoundingClientRect();
    if (e.clientX - box.left < box.width / 3) prev();
    else next();
  };
  const onCancel = () => {
    if (down) clearTimeout(down.timer);
    down = null;
    if (holding) { holding = false; setRunning(); }
  };
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onCancel);
  stage.addEventListener("contextmenu", (e) => { if (e.pointerType === "touch" || holding) e.preventDefault(); });
  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);
  pauseBtn.addEventListener("click", () => { userPaused = !userPaused; setRunning(); });
  skipBtn.addEventListener("click", () => onSkip && onSkip());
  closeBtn.addEventListener("click", () => onExit && onExit());

  // The app's key hub (focus.js) turns the arrows into "nav-move" and Esc /
  // Back / Backspace into "ui-back": the story takes left/right and Back
  // (up/down still move the focus among its buttons — its own focus scope).
  const onMoveKey = (e) => {
    const dir = e.detail;
    if (dir !== "left" && dir !== "right") return;
    e.preventDefault();
    if (dir === "right") next();
    else prev();
  };
  const onBack = (e) => {
    e.preventDefault();
    if (onExit) onExit();
  };
  const onKey = (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === "PageDown") { e.preventDefault(); next(); }
    else if (k === "PageUp") { e.preventDefault(); prev(); }
    else if ((k === " " || k === "k" || k === "K") && !interactive(document.activeElement) && !still) { e.preventDefault(); userPaused = !userPaused; setRunning(); }
    else if (k === "Home") { e.preventDefault(); go(0, -1); }
    else if (k === "End") { e.preventDefault(); if (onSkip) onSkip(); else go(chapters.length - 1, 1); }
    else if (k === "Tab") {
      // keep the keyboard inside the story (it covers the page)
      const f = [...root.querySelectorAll("button:not([disabled]), a[href], [tabindex='0']")].filter((n) => n.getClientRects().length);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    }
  };
  const onVis = () => { hiddenPause = document.hidden; setRunning(); };
  document.addEventListener("keydown", onKey);
  document.addEventListener("nav-move", onMoveKey);
  document.addEventListener("ui-back", onBack);
  document.addEventListener("visibilitychange", onVis);
  document.documentElement.classList.add("play-story-open");

  const destroy = () => {
    if (destroyed) return;
    leaveCurrent(1);
    destroyed = true;
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("nav-move", onMoveKey);
    document.removeEventListener("ui-back", onBack);
    document.removeEventListener("visibilitychange", onVis);
    document.documentElement.classList.remove("play-story-open");
    popScope(root);
    root.remove();
  };

  const handle = {
    el: root, go, next, prev, destroy,
    pause: () => { userPaused = true; setRunning(); },
    resume: () => { userPaused = false; setRunning(); },
    get index() { return index; },
    get paused() { return paused(); },
  };
  host.append(root);
  pushScope(root); // (the D-pad stays inside; this focuses the first button)
  try { root.focus({ preventScroll: true }); } catch {}
  go(Math.max(0, Math.min(start, chapters.length - 1)), 1);
  return handle;
};
