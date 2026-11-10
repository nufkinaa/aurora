// Taste (2026-10-17): one title at a time, three answers.
//
//   Love          swipe right · → · the ♥ button · Enter on the card
//   Not for me    swipe left  · ← · the ✕ button
//   Haven't seen  swipe up    · ↓ · the Skip button
//
// Every answer is saved the moment it is given (POST …/taste/answer), so
// "Done" only has to leave. Love lands in the same liked-titles list the old
// poster grid kept (that grid is still here, as "Edit list" — #/taste/list);
// "Not for me" is a small negative signal for the recommender; "Haven't seen"
// only keeps the title from being asked about again. WHICH titles come next
// is the server's (media/tastedeck.js): well-known, varied, and bent by the
// answers so far — each answer's reply carries the next cards.
//
// Motion is transform + opacity only, on a stage of fixed size: nothing
// around the card moves when it goes. prefers-reduced-motion: no flight, a
// quick fade.
import { el, posterImg, artUrl, debounce, toast, haptic } from "../ui.js";
import { api } from "../api.js";
import { state, loadLibrary } from "../state.js";
import { navigate, untilLeave } from "../router.js";
import { currentScope } from "../focus.js";
import { uiHit } from "../telemetry.js"; // [analytics]
// the look (2026-11-10, docs/play/taste.md): a deck on the night sky
import { mountPlay, star, say } from "../play/stage.js";
import { pullOf, setPull, depthOf, slam, SLAM_MS } from "../play/deck.js";
import { pressable } from "../play/press.js";
import { meteorBurst } from "../play/burst.js";
import { readTaste, marksOf, litAt, milestone } from "../play/tasteread.js";
import { constellationSvg, seedOf, MAX_STARS } from "../play/constellation.js";

const keyOf = (t) => t.imdbId || t.id;
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const leave = () => (history.length > 1 ? history.back() : navigate("#/preferences"));

// How far (px) or how fast (px/ms) a drag must go to count as an answer.
const DIST_X = 110;
const DIST_Y = 100;
const FLING = 0.55;
const KEEP = 4; // cards held on this side: the one on show, the one behind, two loading
const LABEL = { love: "Love", nope: "Not for me", skip: "Haven't seen" };

// A button a thumb presses right after a swipe. Chrome sometimes sends no
// click for a tap that comes just after a touch drag (seen in the phone tests:
// pointerdown, pointerup, touchend — and no click, about one tap in six), so a
// finger's tap acts on its pointerup; the click that may still follow is
// ignored. Mouse, keyboard and remote keep the plain click.
const tapButton = (attrs, act, ...children) => {
  let tapped = -Infinity;
  let clicked = false;
  let down = null;
  const b = el("button", {
    ...attrs,
    onpointerdown: (e) => { if (e.pointerType === "touch") down = { x: e.clientX, y: e.clientY, id: e.pointerId }; },
    onpointerup: (e) => {
      if (e.pointerType !== "touch" || !down || down.id !== e.pointerId) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 12 || b.disabled) return;
      tapped = performance.now();
      clicked = false;
      act();
      // usage stats count a control on its click (telemetry.js): a tap whose
      // click never came is counted here instead
      const id = attrs["data-ui"];
      if (id) setTimeout(() => { if (!clicked) uiHit(id); }, 800);
    },
    onpointercancel: () => { down = null; },
    onclick: () => {
      if (performance.now() - tapped < 800) { clicked = true; return; } // (the tap's own click)
      act();
    },
  }, ...children);
  return b;
};

const noProfile = (screen) =>
  screen.append(el("div", { class: "empty" }, el("div", { class: "glyph" }, "👤"), "Pick a profile first."));

export const renderTaste = async (root) => {
  const screen = el("div", { class: "screen taste-swipe page-pad pg-taste" });
  root.append(screen);
  // the play surface: its own night sky behind, shown once its stylesheet is in
  const play = mountPlay(screen, { seed: 31 });
  const timers = new Set(); // everything timed here stops when the screen goes
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  untilLeave(() => { play.destroy(); for (const t of timers) clearTimeout(t); timers.clear(); });
  if (!state.profile) return noProfile(screen);
  const pid = state.profile.id;

  // The room the page keeps under itself for a phone's tab bar is the
  // stylesheet's (#app's bottom padding). The glass look hands it to this
  // screen by name; where no rule does, it is read from where it stands.
  const app = document.getElementById("app");
  // (the window's size is read here and when it changes — never between two
  // changes to the page, where asking for it makes the page measure itself)
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  const fit = () => {
    vw = window.innerWidth;
    vh = window.innerHeight;
    screen.style.removeProperty("--ts-reserve");
    if (parseFloat(getComputedStyle(screen).getPropertyValue("--ts-reserve")) > 0) return;
    const pad = app ? parseFloat(getComputedStyle(app).paddingBottom) || 0 : 0;
    if (pad > 0) screen.style.setProperty("--ts-reserve", `${pad}px`);
  };
  fit();
  window.addEventListener("resize", fit);
  untilLeave(() => window.removeEventListener("resize", fit));
  // (a very wide screen draws the card big: its picture is asked for sharper)
  const artW = vw >= 1800 && vh >= 1000 ? 620 : 360;

  // ---------- the deck ----------
  let queue = [];          // cards, [0] on show
  let goal = 24;
  let more = 12;
  let answered = 0;        // this sitting
  const tally = { love: 0, nope: 0, skip: 0 };
  const history = [];      // [{ card, verdict, was }] — Undo walks it back
  const gone = new Set();  // answered this sitting: never back in the queue
  let exhausted = false;
  let busy = Promise.resolve(); // answers go to the server one after another
  let focusedOnce = false;

  // ---------- the page ----------
  const count = el("span", { class: "ts-count", "aria-live": "polite" });
  // (the ribbon lies still under the fill, which slides off it: its colours
  // are uncovered from the green end to the violet one, never squeezed)
  const ribbon = el("i", { class: "pg-ribbon" });
  const bar = el("span", { class: "ts-bar-fill" }, ribbon);
  const undoBtn = tapButton({ "data-ui": "taste.undo", class: "pg-tool pg-tool--undo ts-tool focusable", disabled: true, "aria-label": "Undo the last answer" }, () => undo(),
    el("span", { class: "pg-tool-glyph", "aria-hidden": "true" }, "↶"), el("span", { class: "pg-tool-label" }, " Undo"));
  // the taste meter: the ribbon fills, and a star lights at each quarter
  const pips = [1, 2, 3, 4].map((k) => el("i", { class: "pg-pip", style: `--at:${k * 25}%` }, star()));
  const meter = el("span", { class: "pg-meter", "aria-hidden": "true" }, el("span", { class: "ts-bar" }, bar), ...pips);
  const head = el("div", { class: "ts-head" },
    el("h1", {}, "What's your taste?"),
    el("div", { class: "ts-progress" }, meter, count),
    el("div", { class: "ts-toolbar" },
      undoBtn,
      el("button", { "data-ui": "taste.edit", class: "pg-tool pg-tool--edit ts-tool focusable", onclick: () => navigate("#/taste/list") }, "Edit list"),
      el("button", { "data-ui": "taste.done", class: "pg-tool pg-tool--solid ts-tool ts-done focusable", onclick: leave }, "Done")));
  // the deck: the card on show, the next one peeking, and two plates under them
  const deck = el("div", { class: "ts-deck pg-deck" },
    el("i", { class: "pg-ghost pg-ghost--2", "aria-hidden": "true" }),
    el("i", { class: "pg-ghost pg-ghost--1", "aria-hidden": "true" }));
  const callout = el("div", { class: "pg-callout", role: "status" });
  let hush = () => {};
  deck.append(callout); // (over the top edge of the card)
  const stage = el("div", { class: "ts-stage" }, deck);
  const btn = (attrs, verdict, glyph) =>
    tapButton({ ...attrs, class: `ts-answer pg-key ${verdict} focusable`, "aria-label": LABEL[verdict] }, () => answer(verdict),
      el("span", { class: "ts-answer-glyph", "aria-hidden": "true" }, glyph),
      el("span", { class: "ts-answer-label" }, LABEL[verdict]));
  const answers = el("div", { class: "ts-answers" },
    btn({ "data-ui": "taste.nope" }, "nope", "✕"),
    btn({ "data-ui": "taste.skip" }, "skip", "↑"),
    btn({ "data-ui": "taste.love" }, "love", "♥"));
  for (const b of answers.children) pressable(b, { tick: false }); // (answer() has its own tick)
  for (const b of head.querySelectorAll(".pg-tool")) pressable(b, { tick: false });
  const hint = el("p", { class: "ts-hint" }, "← Not for me · → Love · ↓ Haven't seen · Z undo");
  screen.append(head, stage, answers, hint);

  const paintProgress = () => {
    const n = Math.min(answered, goal);
    count.textContent = `${n} / ${goal}`;
    const left = 100 - (goal ? (n / goal) * 100 : 0);
    bar.style.transform = `translateX(${-left}%)`;
    ribbon.style.transform = `translateX(${left}%)`;
    undoBtn.disabled = !history.length;
    const lit = litAt(n, goal);
    pips.forEach((p, i) => p.classList.toggle("on", i < lit));
    // how much of the deck is left to see: it thins as the round runs down
    deck.dataset.depth = depthOf(Math.min(goal - answered, exhausted ? queue.length : 4));
  };

  // ---------- cards ----------
  const nodes = new Map(); // imdbId -> its element (the two on the stage)
  const makeCard = (c) => {
    const meta = [c.year, c.type === "show" ? "Series" : "Film", ...(c.genres || []).slice(0, 2)].filter(Boolean).join(" · ");
    const node = el("div", { class: "ts-card", tabindex: "-1", role: "group", "aria-label": `${c.title}${c.year ? ` (${c.year})` : ""}` },
      posterImg(c.poster, c.title, "ts-poster", "ts-poster-fallback", { w: artW, eager: true }),
      el("span", { class: "ts-stamp love", "aria-hidden": "true" }, "LOVE"),
      el("span", { class: "ts-stamp nope", "aria-hidden": "true" }, "NOPE"),
      el("span", { class: "ts-stamp skip", "aria-hidden": "true" }, "HAVEN'T SEEN"),
      el("div", { class: "ts-info" },
        el("div", { class: "ts-title", dir: "auto" }, c.title),
        meta && el("div", { class: "ts-meta" }, meta),
        c.line && el("div", { class: "ts-line", dir: "auto" }, c.line)));
    node.dataset.id = c.imdbId;
    return node;
  };
  // the picture of every card in the queue starts loading before its turn
  const warmed = new Set();
  const warm = (c) => {
    if (warmed.has(c.imdbId) || !c.poster) return;
    warmed.add(c.imdbId);
    // the very address the card's <img> will ask for (posterImg → artUrl)
    try { new Image().src = artUrl(c.poster, artW); } catch {}
  };

  // The end of a round — the reward: the loved titles as a constellation, the
  // number in gold with the one meteor burst, what Aurora learned as lit tags.
  const bursts = new Set(); // rounds (by their goal) that had their burst
  const endPanel = () => {
    const read = readTaste(history.map((h) => ({ verdict: h.verdict, genres: h.card.genres })));
    const loved = history.filter((h) => h.verdict === "love");
    const sky = loved.length
      ? el("div", { class: "pg-end-sky" },
        constellationSvg(loved.length, seedOf(loved.map((h) => h.card.imdbId).join(""))),
        el("span", { class: "play-sr" }, `${Math.min(loved.length, MAX_STARS)} stars lit, one for each title you loved. `))
      : null;
    const sep = () => el("span", { class: "play-sr" }, " · ");
    const tags = [
      ...read.liked.slice(0, 4).map((g) => el("span", { class: "pg-tag lit" }, star(), `${g.genre}${g.n > 1 ? ` ×${g.n}` : ""}`)),
      ...read.less.slice(0, 2).map((g) => el("span", { class: "pg-tag dim" }, `less ${g.genre}`)),
    ];
    // (what is read can scroll on a small screen; the keys under it never leave)
    const body = el("div", { class: "pg-reward-body" },
      sky,
      exhausted
        ? el("h2", { class: "pg-end-title" }, "That's every title we had for you")
        : el("h2", { class: "pg-end-title" }, el("span", { class: "pg-end-num play-num" }, String(answered)), el("span", { class: "pg-end-words" }, " answers — Home is already using them")),
      el("p", { class: "ts-end-tally" },
        el("span", { class: "pg-tchip love" }, `♥ ${tally.love} loved`), sep(),
        el("span", { class: "pg-tchip nope" }, `✕ ${tally.nope} not for you`), sep(),
        el("span", { class: "pg-tchip skip" }, `${tally.skip} not seen`)),
      tags.length ? el("div", { class: "pg-learned" }, el("span", { class: "play-eyebrow" }, "Aurora learned"), el("div", { class: "pg-tags" }, ...tags)) : null);
    const keys = el("div", { class: "ts-end-actions" },
      !exhausted && el("button", { "data-ui": "taste.more", class: "play-btn play-btn--aurora focusable", onclick: () => keepGoing() }, "Keep going"),
      el("button", { "data-ui": "taste.done", class: "play-btn play-btn--gold focusable", onclick: leave }, "Done"));
    // (nothing was asked — a profile with no titles to show: no row of noughts)
    const done = el("div", { class: `ts-end pg-reward${answered ? "" : " is-blank"}`, role: "status" }, body, keys);
    [...body.children, keys].forEach((c, i) => c.style.setProperty("--d", `${120 + i * 110}ms`));
    for (const b of done.querySelectorAll("button")) pressable(b);
    if (!calm() && !exhausted && !bursts.has(goal)) {
      const first = !bursts.size;
      bursts.add(goal);
      later(() => {
        const num = done.querySelector(".pg-end-num");
        if (!num || !done.isConnected) return;
        const a = num.getBoundingClientRect();
        const b = screen.getBoundingClientRect();
        meteorBurst(screen, { x: (a.left + a.width / 2 - b.left) / (b.width || 1), y: (a.top + a.height / 2 - b.top) / (b.height || 1), count: first ? 46 : 26, seed: goal });
      }, sky ? 520 : 300);
    }
    return done;
  };
  const roundOver = () => answered >= goal || (exhausted && !queue.length);

  // Put the right two cards on the stage. Cards already there keep their
  // element (the one behind slides forward instead of being rebuilt).
  const paint = () => {
    paintProgress();
    const old = stage.querySelector(".ts-end");
    screen.classList.toggle("is-over", roundOver());
    if (roundOver()) {
      hush();
      for (const n of nodes.values()) n.remove();
      nodes.clear();
      const waiting = stage.querySelector(".ts-wait");
      if (waiting) waiting.remove(); // (a deck that came back empty: the wait is over)
      if (!old) {
        const panel = endPanel();
        stage.append(panel);
        const first = panel.querySelector("button");
        if (first) first.focus({ preventScroll: true });
      }
      answers.classList.add("off");
      return;
    }
    if (old) old.remove();
    answers.classList.remove("off");
    const want = queue.slice(0, 2);
    for (const [id, n] of nodes) if (!want.some((c) => c.imdbId === id) && !n.classList.contains("leaving")) { n.remove(); nodes.delete(id); }
    want.forEach((c, i) => {
      let n = nodes.get(c.imdbId);
      if (!n) {
        n = makeCard(c);
        n.classList.add(i === 0 ? "top" : "behind", "entering");
        nodes.set(c.imdbId, n);
        deck.append(n); // (z-index orders them: leaving > top > behind)
        requestAnimationFrame(() => requestAnimationFrame(() => n.classList.remove("entering")));
      }
      n.classList.toggle("top", i === 0);
      n.classList.toggle("behind", i === 1);
      if (i === 0) {
        n.tabIndex = 0;
        n.classList.add("focusable");
        bindDrag(n, c);
      } else {
        n.tabIndex = -1;
        n.classList.remove("focusable");
      }
    });
    const top = want.length ? nodes.get(want[0].imdbId) : null;
    if (!want.length) {
      if (!stage.querySelector(".ts-wait")) stage.append(el("div", { class: "ts-wait" }, el("div", { class: "spinner" })));
    } else {
      const w = stage.querySelector(".ts-wait");
      if (w) w.remove();
    }
    queue.forEach(warm);
    // the first card takes the focus once (the keyboard and a remote answer
    // from it); after that only when the focus was on the deck already
    const onDeck = !document.activeElement || document.activeElement === document.body ||
      stage.contains(document.activeElement) || answers.contains(document.activeElement);
    if (top && (onDeck || !focusedOnce)) {
      focusedOnce = true;
      if (document.activeElement !== top) top.focus({ preventScroll: true });
    }
  };

  // Add cards from the server to the end of the queue — never one already
  // there or already answered in this sitting.
  const take = (cards, { replaceTail = false } = {}) => {
    if (replaceTail) queue = queue.slice(0, 2);
    for (const c of cards || []) {
      if (!c || !c.imdbId || gone.has(c.imdbId) || queue.some((q) => q.imdbId === c.imdbId)) continue;
      queue.push(c);
    }
  };

  // ---------- the motion ----------
  const fly = (node, verdict, from = null) => {
    node.classList.remove("top", "behind", "focusable");
    node.classList.add("leaving");
    node.tabIndex = -1;
    const w = Math.max(vw, 600);
    if (calm()) {
      node.style.transition = "opacity 140ms linear";
      node.style.opacity = "0";
    } else {
      const dx = from ? from.dx : 0;
      const dy = from ? from.dy : 0;
      const to = verdict === "love" ? `translate(${w}px, ${dy * 1.5}px) rotate(24deg)`
        : verdict === "nope" ? `translate(${-w}px, ${dy * 1.5}px) rotate(-24deg)`
        : `translate(${dx * 1.5}px, ${-Math.max(vh, 700)}px) rotate(${dx * 0.03}deg)`;
      const stamp = node.querySelector(`.ts-stamp.${verdict}`);
      const go = () => {
        node.style.transition = "transform 300ms cubic-bezier(.2,.7,.3,1), opacity 300ms ease-in";
        node.style.transform = to;
        node.style.opacity = "0";
      };
      if (!from) {
        // a button or a key: no drag showed the answer, so the stamp is slammed
        // on, the card takes the hit, and then it is thrown
        slam(node, stamp, verdict === "love" ? { x: 14, y: -4, r: 3 } : verdict === "nope" ? { x: -14, y: -4, r: -3 } : { y: -12 });
        setTimeout(go, SLAM_MS);
        setTimeout(() => node.remove(), SLAM_MS + 320);
        return;
      }
      stamp?.style.setProperty("opacity", "1");
      go();
    }
    setTimeout(() => node.remove(), calm() ? 160 : 320);
  };
  // the key that matches the answer lights for a moment (arrows teach the buttons)
  const flashKey = (verdict) => {
    const k = answers.querySelector(`.ts-answer.${verdict}`);
    if (!k || calm()) return;
    k.classList.add("is-hit");
    later(() => k.classList.remove("is-hit"), 260);
  };
  // a star of the meter lit with this answer: say something about it (once)
  const said = new Set();
  const remark = () => {
    if (calm()) hush();
    const k = marksOf(goal).indexOf(answered) + 1;
    if (k < 1 || k > 3 || said.has(`${goal}:${k}`) || roundOver()) return;
    said.add(`${goal}:${k}`);
    const words = milestone(k, readTaste(history.map((h) => ({ verdict: h.verdict, genres: h.card.genres }))));
    if (words) hush = say(callout, words);
  };

  // ---------- answering ----------
  const answer = (verdict, from = null) => {
    if (roundOver()) return;
    const card = queue[0];
    if (!card) return;
    queue.shift();
    gone.add(card.imdbId);
    answered++;
    tally[verdict]++;
    const node = nodes.get(card.imdbId);
    nodes.delete(card.imdbId);
    setPull(deck, 0);
    if (node) fly(node, verdict, from);
    haptic(10);
    flashKey(verdict);
    const entry = { card, verdict, was: null };
    history.push(entry);
    remark();
    paint();
    // saved now; the reply brings the next cards, chosen with this answer known
    const queued = queue.slice(0, 2).map((c) => c.imdbId);
    busy = busy.then(async () => {
      try {
        const r = await api.tasteAnswer(pid, { imdbId: card.imdbId, id: card.id, title: card.title, verdict, queued, n: KEEP - 2 });
        entry.was = r.was || null;
        take(r.cards, { replaceTail: true });
        if (!r.cards || !r.cards.length) exhausted = true; // nothing left to ask about
        paint();
      } catch {
        // not saved: the card comes back, as if it had not been answered
        const i = history.indexOf(entry);
        if (i < 0) return; // (already taken back with Undo)
        toast("Couldn't save that answer — try again", "⚠️");
        history.splice(i, 1);
        answered = Math.max(0, answered - 1);
        tally[verdict] = Math.max(0, tally[verdict] - 1);
        gone.delete(card.imdbId);
        queue.unshift(card);
        paint();
      }
    });
  };

  const undo = () => {
    const last = history.pop();
    if (!last) return;
    const { card, verdict } = last;
    hush();
    answered = Math.max(0, answered - 1);
    tally[verdict] = Math.max(0, tally[verdict] - 1);
    gone.delete(card.imdbId);
    queue.unshift(card);
    // it comes back from where it went
    const n = makeCard(card);
    n.classList.add("top");
    if (!calm()) {
      const w = Math.max(vw, 600);
      n.style.transition = "none";
      n.style.transform = verdict === "love" ? `translate(${w}px, 0) rotate(24deg)` : verdict === "nope" ? `translate(${-w}px, 0) rotate(-24deg)` : `translate(0, ${-Math.max(vh, 700)}px)`;
    }
    n.style.opacity = "0";
    deck.append(n);
    nodes.set(card.imdbId, n);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      n.style.transition = calm() ? "opacity 140ms linear" : "transform 320ms cubic-bezier(.2,.7,.3,1), opacity 220ms ease-out";
      n.style.transform = "";
      n.style.opacity = "";
      setTimeout(() => { n.style.transition = ""; }, 340);
    }));
    paint();
    n.focus({ preventScroll: true });
    // put the old answer back (null when it had none)
    // (serial: an Undo pressed before the answer's own reply runs after it,
    // when `was` is known)
    busy = busy.then(() => api.tasteAnswer(pid, { imdbId: card.imdbId, id: card.id, title: card.title, verdict: last.was }))
      .catch(() => toast("Couldn't undo that one", "⚠️"));
  };

  const keepGoing = () => {
    goal += more;
    paint();
    if (queue.length < 2) refill();
  };

  const refill = async () => {
    try {
      const r = await api.tasteDeck(pid, { n: KEEP - queue.length, queued: queue.map((c) => c.imdbId) });
      take(r.cards);
      if (!r.cards || !r.cards.length) exhausted = true;
      paint();
    } catch { toast("Couldn't load more titles", "⚠️"); }
  };

  // ---------- dragging (mouse and touch) ----------
  const bindDrag = (node, card) => {
    if (node._drag) return;
    node._drag = true;
    let start = null;
    let samples = [];
    const stamp = (cls, v) => { const s = node.querySelector(`.ts-stamp.${cls}`); if (s) s.style.opacity = String(Math.max(0, Math.min(1, v))); };
    node.addEventListener("pointerdown", (e) => {
      if (queue[0] !== card || e.button > 0) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      try { node.setPointerCapture(e.pointerId); } catch {}
      node.classList.add("dragging");
      node.style.transition = "none";
    });
    node.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
      if (samples.length > 6) samples.shift();
      node.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx * 0.05}deg)`;
      setPull(deck, pullOf(dx, dy, DIST_X, DIST_Y)); // the next card rises to meet the drag
      stamp("love", dx / DIST_X);
      stamp("nope", -dx / DIST_X);
      stamp("skip", Math.abs(dx) < 60 ? -dy / DIST_Y : 0);
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      node.classList.remove("dragging");
      const a = samples[0];
      const b = samples[samples.length - 1];
      const dt = Math.max(1, b.t - a.t);
      const vx = (b.x - a.x) / dt;
      const vy = (b.y - a.y) / dt;
      let verdict = null;
      if (e.type !== "pointercancel") {
        if ((dx > DIST_X || (vx > FLING && dx > 30)) && Math.abs(dx) >= Math.abs(dy) * 0.6) verdict = "love";
        else if ((dx < -DIST_X || (vx < -FLING && dx < -30)) && Math.abs(dx) >= Math.abs(dy) * 0.6) verdict = "nope";
        else if ((dy < -DIST_Y || (vy < -FLING && dy < -30)) && Math.abs(dy) > Math.abs(dx)) verdict = "skip";
      }
      if (verdict) {
        uiHit("taste.swipe"); // [analytics]
        answer(verdict, { dx, dy });
        return;
      }
      // not far enough: back to the middle
      setPull(deck, 0);
      node.style.transition = calm() ? "none" : "transform 260ms cubic-bezier(.2,.9,.3,1.2)";
      node.style.transform = "";
      for (const s of node.querySelectorAll(".ts-stamp")) s.style.opacity = "";
    };
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && queue[0] === card) { e.preventDefault(); uiHit("taste.key"); answer("love"); } // [analytics]
    });
  };

  // ---------- the keyboard (and a TV remote in a browser) ----------
  // Arrows answer whenever focus is on the deck — not when it is up in the
  // toolbar or the nav, where they move focus as everywhere else.
  const onKey = (e) => {
    if (!screen.isConnected) return;
    if (!currentScope().contains(screen)) return; // a sheet is open over the page
    const t = e.target;
    if (t && (t.closest?.("input, textarea, [contenteditable]") || t.closest?.(".ts-toolbar") || t.closest?.("#nav, nav, .nav"))) return;
    if (t && t.closest?.(".ts-end")) return;
    const k = e.key;
    const code = e.keyCode;
    let verdict = null;
    if (k === "ArrowRight" || code === 39) verdict = "love";
    else if (k === "ArrowLeft" || code === 37) verdict = "nope";
    else if (k === "ArrowDown" || code === 40) verdict = "skip";
    else if ((k === "z" || k === "Z" || k === "u" || k === "U") && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      undo();
      return;
    }
    if (!verdict || roundOver() || !queue.length) return;
    e.preventDefault();
    e.stopPropagation(); // (focus.js would move focus with it)
    uiHit("taste.key"); // [analytics]
    answer(verdict);
  };
  window.addEventListener("keydown", onKey, true);
  untilLeave(() => window.removeEventListener("keydown", onKey, true));

  // ---------- first cards ----------
  paint();
  try {
    const r = await api.tasteDeck(pid, { n: KEEP + 2 });
    goal = r.goal || goal;
    more = r.more || more;
    take(r.cards);
    if (!r.cards || !r.cards.length) exhausted = true;
  } catch {
    stage.replaceChildren(el("div", { class: "empty" }, "Couldn't load titles — try again in a moment."));
    answers.classList.add("off");
    return;
  }
  await play.ready; // (the card takes the focus: it has to be on show)
  if (!screen.isConnected) return;
  paint();
};

// ---------- Edit list: the poster grid ----------
// What the picker was before it learned to swipe: everything loved at once,
// tap to take one out (or put one in); plus the "Not for me" answers, each
// one tap from being taken back.
export const renderTasteList = async (root) => {
  const screen = el("div", { class: "screen taste page-pad" });
  root.append(screen);
  if (!state.profile) return noProfile(screen);

  let liked = [];
  let disliked = [];
  let pool = [];
  try {
    // Taste needs RANGE, not an inventory of what's already downloaded —
    // pull the wide catalog (top + trending, films + series) and mix a
    // modest slice of the library into it, everything shuffled together.
    const [lib, taste, ...cats] = await Promise.all([
      loadLibrary(),
      api.taste(state.profile.id),
      api.catalog({ type: "movie", category: "top" }).catch(() => null),
      api.catalog({ type: "movie", category: "trending" }).catch(() => null),
      api.catalog({ type: "show", category: "top" }).catch(() => null),
      api.catalog({ type: "show", category: "trending" }).catch(() => null),
    ]);
    liked = taste.liked || [];
    disliked = taste.disliked || [];
    const seen = new Set();
    const add = (t, requireCover = true) => {
      const k = keyOf(t);
      if (!k || seen.has(k) || (requireCover && !t.cover)) return;
      seen.add(k);
      pool.push(t);
    };
    const shuffle = (a) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const catalog = shuffle(cats.flatMap((c) => (c && c.items) || [])).map((i) => ({
      imdbId: i.imdbId, title: i.title, cover: i.cover || i.poster, year: i.year,
    }));
    const library = shuffle([...(lib.movies || []), ...(lib.shows || [])]).slice(0, 15).map((i) => ({
      id: i.id, title: i.title, cover: i.cover, year: i.year,
    }));
    // the picks first — this is where they are seen and taken out — then the
    // catalogue, a familiar face every few tiles
    for (const t of liked) add({ ...t, cover: t.cover || t.poster }, false);
    let li = 0;
    catalog.forEach((c, i) => {
      add(c);
      if (i % 5 === 4 && li < library.length) add(library[li++]);
    });
    while (li < library.length) add(library[li++]);
    pool = pool.slice(0, 120);
  } catch {
    screen.append(el("div", { class: "empty" }, "Couldn't load titles — try again in a moment."));
    return;
  }

  const picked = new Map(liked.map((t) => [keyOf(t), t]));
  const count = el("span", { class: "count" });
  const paintCount = () => { count.textContent = picked.size ? `${picked.size} loved` : "tap everything you love"; };
  paintCount();

  const save = debounce(async () => {
    try { await api.setTaste(state.profile.id, [...picked.values()]); }
    catch { toast("Couldn't save your picks", "⚠️"); }
  }, 600);
  untilLeave(() => save.flush && save.flush());

  const grid = el("div", { class: "grid", style: { paddingLeft: 0, paddingRight: 0 } });
  let tileNo = 0;
  for (const t of pool) {
    const k = keyOf(t);
    const tile = el("button", {
      class: "taste-tile focusable" + (picked.has(k) ? " on" : ""),
      "aria-label": t.title,
      "aria-pressed": picked.has(k) ? "true" : "false",
      onclick: () => {
        if (picked.has(k)) picked.delete(k);
        else picked.set(k, { id: t.id, imdbId: t.imdbId, title: t.title });
        tile.classList.toggle("on", picked.has(k));
        tile.setAttribute("aria-pressed", picked.has(k) ? "true" : "false");
        paintCount();
        save();
      },
    },
      posterImg(t.cover, t.title, "taste-poster", "card-fallback"),
      el("span", { class: "taste-check" }, "♥"),
    );
    // the first two rows are on screen at once — no lazy gap there
    if (tileNo++ < 16) { const im = tile.querySelector("img"); if (im) im.loading = "eager"; }
    grid.append(tile);
  }

  // "Not for me": each one a chip; × takes the answer back
  const nopes = disliked.length
    ? el("div", { class: "taste-nopes" },
      el("h2", {}, "Not for you"),
      el("div", { class: "taste-nope-chips" }, disliked.slice().reverse().map((t) => {
        const chip = el("button", {
          "data-ui": "taste.unnope", class: "taste-nope-chip focusable", "aria-label": `Take back “not for me” on ${t.title}`,
          onclick: async () => {
            try {
              await api.tasteAnswer(state.profile.id, { imdbId: t.imdbId, title: t.title, verdict: null });
              chip.remove();
            } catch { toast("Couldn't change that", "⚠️"); }
          },
        }, t.title, el("span", { "aria-hidden": "true" }, " ✕"));
        return chip;
      })))
    : null;

  screen.append(
    el("div", { class: "browse-head", style: { paddingLeft: 0, paddingRight: 0 } },
      el("h1", {}, "What do you love?"), count),
    el("p", { class: "pref-note", style: { paddingLeft: 0 } },
      "Tap the ones you'd defend in an argument. Home learns from these — you can come back and change them anytime."),
    el("button", { "data-ui": "taste.back", class: "btn small focusable taste-back-swipe", onclick: () => navigate("#/taste") }, "← Back to swiping"),
    grid,
    // (no "not for me" answers: nothing — a bare null here was printed as "null")
    ...(nopes ? [nopes] : []),
    // Done floats — no scrolling a 120-poster grid just to leave
    el("div", { class: "taste-done" },
      el("button", { class: "btn btn-primary focusable", html: "<span>Done</span>", onclick: () => { save.flush && save.flush(); navigate("#/preferences"); } })),
    el("div", { style: { height: "90px" } }), // the floating bar's landing pad
  );
};
