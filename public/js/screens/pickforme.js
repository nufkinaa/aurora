// The AI tab — describe the mood, get titles back with a line on why each one
// fits.
//
// The server does the thinking (src/media/ai.js). This screen is the ask: a text
// box, a Movies/Shows switch, two taste dials, and then normal cards. The cards
// are the same component the rest of the app uses and they sit in the same
// `.grid`, so anything picked here looks, opens and plays exactly like a title
// found any other way.
//
// The router rebuilds every screen from scratch on each navigation, which meant
// opening one of the results and pressing Back threw the whole answer away — for
// a list that costs real money and ten seconds to produce. So the last answer
// lives at module scope and is painted straight back on return, scroll position
// included. A full page refresh starts clean, which is fine: the server caches an
// identical request for a day, so asking again is instant and free.
//
// The look is a draw (2026-11-10; the design: docs/play/pickforme.md, the
// styles: the PICK FOR ME section of css/play.css). What is asked and what
// comes back are as they were; the answer is now DRAWN: while Aurora thinks a
// reel of card backs goes round, the answer's posters slow and land on the
// first pick, and that one is presented as the prize — with "Another one" to
// walk the rest in the server's order. Every pick is still listed underneath
// ("The whole hand"), the same cards with the same reasons.
import { el, toast, artUrl, backupPosterUrl, haptic } from "../ui.js";
import { card, openItem } from "../components.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { navigate } from "../router.js";
import { WORDS as GROUP } from "../groupwords.js";
import { mountPlay, star } from "../play/stage.js";
import { pressable } from "../play/press.js";
import { meteorBurst } from "../play/burst.js";
import { tween, reduced as calm } from "../play/motion.js";
import { landingStrip, respinStrip, reelPos, cellAt, nextDraw, stripShift, handCols, nudge, LAND_MS, RESPIN_MS, HOLD_MS } from "../play/reel.js";

const EXAMPLES = [
  "something dumb and loud, I've had a long day",
  "slow and beautiful, nothing scary",
  "a clever thriller that respects my time",
  "makes me cry in a good way",
  "comfort food, seen it a hundred times energy",
];

// Movies or Shows, nothing in between: the server takes a 0..100 mix, and these
// are its two ends. 0 = films only, 100 = series only.
const KINDS = [
  { id: "movie", label: "Movies", mix: 0 },
  { id: "show", label: "Shows", mix: 100 },
];

// The taste dials. Ids have to match the ones src/media/ai.js knows; the labels
// are plain English on purpose — "Not too old" is clearer than "2010 onwards"
// when you're picking something to watch, and the server owns what the boundary
// actually is.
const ERAS = [
  { id: "any", label: "Any era" },
  { id: "fresh", label: "Recent" },
  { id: "modern", label: "Not too old" },
  { id: "classic", label: "A classic" },
];

// Length means different things for a film and a series, so the row swaps with
// the switch rather than pretending one set of options fits both.
const LENGTHS = {
  movie: [
    { id: "any", label: "Any length" },
    { id: "short", label: "Under 100 min" },
    { id: "standard", label: "Under 2 hours" },
    { id: "epic", label: "Something long" },
  ],
  show: [
    { id: "any", label: "Any length" },
    { id: "limited", label: "One or two seasons" },
    { id: "meaty", label: "Many seasons" },
  ],
};

// It takes several seconds, so the wait narrates itself rather than sitting on
// one word long enough to look broken. The last one is the honest truth about
// what the server is doing by then.
const STAGES = [
  "Reading the room…",
  "Ransacking the archives…",
  "Arguing with itself about your taste…",
  "Checking which of these Aurora can actually play…",
];
const STAGE_MS = 2600;

// the draw's own words (the website only, for now)
const DRAW = {
  kicker: "Tonight's pick",
  of: (n, of) => `${n} of ${of}`,
  said: (title) => `Tonight's pick: ${title}`,
  open: "Open",
  another: "Another one",
  hand: "The whole hand",
};

// The last answer, kept for the life of the page:
// { vibe, kindId, era, length, items, status, scrollY, owner, draw }
let last = null;
// ...for the profile it was given to, and nobody else. It used to have no
// owner: the next profile on the same tab — a kids one included — opened the
// AI page onto the previous person's question and picks. Stamped the way
// search.js stamps its memory (a kids limit changing on the same profile is a
// different audience too), dropped on a switch, and checked again on the way
// in, because an answer can land after the switch.
const whose = () =>
  state.profile ? `${state.profile.id}${state.profile.kids ? `~k${state.profile.kids.maxAge}` : ""}` : "";
window.addEventListener("aurora-profile", (e) => {
  if (e.detail && e.detail.relist) last = null;
});

export const renderPickForMe = async (root) => {
  if (last && last.owner !== whose()) last = null;
  const screen = el("div", { class: "screen pfm pg-pick" });
  const play = mountPlay(screen, { seed: 23 });

  // ---- state. These four are the whole request. Seeded from the last answer so
  // coming back shows the controls exactly as they were left. ----
  let kind = KINDS.find((k) => k.id === (last && last.kindId)) || KINDS[0];
  let era = (last && last.era) || "any";
  let length = (last && last.length) || "any";
  let busy = false;
  // Asked with the keys (a keyboard, a TV remote): the focus goes on to the
  // prize's Open when it lands. Asked with a finger or a mouse: it stays put.
  let byKeys = false;
  // Set by the router's cleanup, so a reply that lands after the viewer has
  // navigated away is still remembered but doesn't touch a detached screen.
  let gone = false;
  let ticker = null;

  const input = el("input", {
    type: "text",
    class: "pfm-input focusable",
    placeholder: "What are you in the mood for?",
    maxlength: "300",
  });

  // ---- the switch: one click anywhere on it flips to the other option ----
  const thumb = el("span", { class: "pfm-switch-thumb" });
  const opts = KINDS.map((k) => el("span", { class: "pfm-switch-opt" }, k.label));
  const paintSwitch = () => {
    const shows = kind.id === "show";
    switcher.setAttribute("aria-checked", shows ? "true" : "false");
    opts[0].classList.toggle("on", !shows);
    opts[1].classList.toggle("on", shows);
  };
  const flip = () => {
    kind = kind.id === "movie" ? KINDS[1] : KINDS[0];
    // The length ids are per-kind, so a live selection can't survive the flip.
    length = "any";
    paintSwitch();
    lengthRow.repaint();
  };
  const switcher = el(
    "button",
    {
      type: "button",
      class: "pfm-switch focusable",
      role: "switch",
      "aria-checked": "false",
      "aria-label": "Recommend movies or shows",
      onclick: flip,
    },
    thumb,
    ...opts
  );

  // ---- taste pills ----
  // getOptions is a function, not an array, because the length row's options
  // change when the switch flips.
  const pillRow = (label, getOptions, getValue, setValue) => {
    const row = el("div", { class: "pfm-tune-group" });
    const repaint = () => {
      row.innerHTML = "";
      row.append(el("span", { class: "pfm-tune-label" }, label));
      for (const o of getOptions()) {
        const on = o.id === getValue();
        row.append(
          el("button", { "data-ui": "pick.option",
            type: "button",
            class: `pfm-pill pg-chip focusable ${on ? "on" : ""}`,
            "aria-pressed": on ? "true" : "false",
            onclick: () => { setValue(o.id); repaint(); },
          }, o.label)
        );
      }
    };
    repaint();
    return { row, repaint };
  };

  const eraRow = pillRow("Era", () => ERAS, () => era, (v) => { era = v; });
  const lengthRow = pillRow(
    "Length",
    () => LENGTHS[kind.id],
    () => length,
    (v) => { length = v; }
  );

  const goBtn = el("button", { "data-ui": "pick.go", type: "button", class: "pfm-go play-btn play-btn--aurora focusable" }, "Find me something");
  pressable(goBtn);
  const status = el("div", { class: "pfm-status" });
  const results = el("div", { class: "pfm-results grid" });
  const handTitle = el("div", { class: "pg-hand-title play-eyebrow", hidden: "" }, star(), DRAW.hand);

  // ---- the stage: the reel's window, and beside it the wait, then the prize ----
  let items = [];      // the answer on the stage
  let draw = 0;        // which of them is drawn
  let run = 0;         // every ask and every draw gets a number; an old one's steps stop
  let stopTween = null;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

  const strip = el("div", { class: "pg-reel-strip" });
  const flash = el("i", { class: "pg-reel-flash" });
  const reelWin = el("div", { class: "pg-reel", "aria-hidden": "true" }, strip, flash);
  const waitMsg = el("div", { class: "pfm-wait-msg in" });
  const waitBox = el("div", { class: "pfm-wait" },
    el("div", { class: "pg-dots", "aria-hidden": "true" }, star(), star(), star()),
    waitMsg,
    el("div", { class: "pfm-wait-hint" }, "Asking for actual opinions, not running a database query — give it a few seconds."));
  const wonCount = el("span", { class: "pg-won-count" });
  const wonTitle = el("h2", { class: "pg-won-title", dir: "auto" });
  const wonMeta = el("div", { class: "pg-won-meta" });
  const wonWhy = el("p", { class: "pg-won-why", dir: "auto" });
  const openBtn = el("button", { "data-ui": "pick.open", type: "button", class: "play-btn play-btn--gold focusable", onclick: () => { if (items[draw]) openItem(items[draw]); } }, DRAW.open);
  const againBtn = el("button", { "data-ui": "pick.another", type: "button", class: "play-btn focusable", onclick: () => another() },
    DRAW.another, el("span", { class: "pg-again-glyph", "aria-hidden": "true" }, "↻"));
  pressable(openBtn);
  pressable(againBtn);
  const pips = el("div", { class: "pg-pips", "aria-hidden": "true" });
  const wonBox = el("div", { class: "pg-won" },
    el("div", { class: "pg-won-kicker" }, star(), el("span", {}, DRAW.kicker), wonCount),
    wonTitle, wonMeta, wonWhy,
    el("div", { class: "pg-won-actions" }, openBtn, againBtn),
    pips);
  const said = el("div", { class: "play-sr", role: "status" }); // what the motion says, in words
  const stage = el("div", { class: "pg-draw", hidden: "", "data-state": "waiting" },
    reelWin,
    el("div", { class: "pg-draw-side" }, waitBox, wonBox),
    said);

  // The free band of the window: under the top bar and over a phone's tab
  // bar, both measured where they stand (their heights differ by look and size).
  const band = () => {
    let top = 0;
    let bottom = window.innerHeight;
    for (const n of document.querySelectorAll("#nav, #nav > *, #nav .nav-items")) {
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.top >= window.innerHeight / 2) bottom = Math.min(bottom, r.top);
      else if (r.bottom <= window.innerHeight / 2) top = Math.max(top, r.bottom);
    }
    return { top: top + 12, bottom: bottom - 12 };
  };
  const bring = (node, centre = false) => {
    const { top, bottom } = band();
    const r = node.getBoundingClientRect();
    const dy = nudge(top, bottom, r.top, r.bottom, centre);
    if (Math.abs(dy) > 2) window.scrollBy({ top: dy, behavior: calm() ? "auto" : "smooth" });
  };
  // The prize can be taller than the wait was: the whole stage in view when it
  // fits, else the words and their keys (never under a bar).
  const settle = () => {
    const s = stage.getBoundingClientRect();
    if (s.bottom < 0 || s.top > window.innerHeight) return; // (scrolled away to read something else: left alone)
    const { top, bottom } = band();
    bring(s.height <= bottom - top ? stage : wonBox);
  };
  // The hand's rows come out even: six cards where five fit are dealt 3 + 3.
  const dealCols = () => {
    const room = handTitle.clientWidth; // (the page between its own gutters)
    if (!items.length || !room) return;
    results.style.setProperty("--cols", String(handCols(items.length, room)));
  };
  const handWatch = typeof ResizeObserver === "function" ? new ResizeObserver(dealCols) : null;
  if (handWatch) handWatch.observe(results);

  const back = () => el("div", { class: "pg-reel-cell pg-reel-back" }, star());
  // One poster on the reel: its title on a tile at once, the picture over it
  // when it is in hand (the cover, else the backup poster, else the tile stays).
  const face = (item) => {
    const cell = el("div", { class: "pg-reel-cell" },
      el("div", { class: "pg-reel-img pg-reel-fallback", dir: "auto" }, item.title || ""));
    const tries = [...new Set([item.cover, backupPosterUrl(item)].filter(Boolean))];
    cell.ready = new Promise((ok) => {
      const next = () => {
        const src = tries.shift();
        if (!src) { ok(); return; }
        const img = el("img", { class: "pg-reel-img", alt: "", decoding: "async" });
        img.onload = () => { cell.replaceChildren(img); ok(); };
        img.onerror = next;
        img.src = artUrl(src, 360);
      };
      next();
    });
    return cell;
  };
  const place = (pos) => { strip.style.transform = `translate3d(0, ${stripShift(pos, strip.children.length).toFixed(3)}%, 0)`; };
  const setStrip = (cells, spinning = false) => {
    strip.classList.toggle("is-spinning", spinning);
    strip.replaceChildren(...cells);
    place(0);
  };
  // pictures in hand before the reel shows them (a poster popping in half-way
  // down the strip would spoil the landing); never waits long
  const pictures = (cells) => Promise.race([
    Promise.all(cells.map((c) => c.ready)),
    new Promise((ok) => later(ok, 1200)),
  ]);
  const halt = () => {
    run++;
    if (stopTween) { stopTween(); stopTween = null; }
    timers.forEach(clearTimeout);
    timers.clear();
  };
  // one strip rolling to its last cell: a tick for every poster that passes
  const roll = (cells, ms, then) => {
    const lastCell = cells.length - 1;
    setStrip([...cells, back()]); // (the cell after the last: the reel runs a hair past it and back)
    let at = 0;
    stopTween = tween({
      ms,
      ease: (t) => t,
      onUpdate: (t) => {
        const pos = reelPos(t, lastCell);
        place(pos);
        const c = cellAt(pos);
        if (c !== at) { at = c; haptic(3); }
      },
      onDone: () => { stopTween = null; place(lastCell); then(); },
    });
  };

  const paintPrize = () => {
    const item = items[draw];
    if (!item) return;
    wonCount.textContent = items.length > 1 ? ` · ${DRAW.of(draw + 1, items.length)}` : "";
    wonTitle.textContent = item.title;
    wonMeta.textContent = [item.year, item.type === "show" ? "Series" : "Film"].filter(Boolean).join(" · ");
    wonWhy.textContent = item.why || "";
    wonWhy.hidden = !item.why;
    againBtn.hidden = items.length < 2;
    pips.hidden = items.length < 2 || items.length > 12;
    pips.replaceChildren(...items.map((_, i) => el("i", { class: i === draw ? "on" : "" })));
    [...results.children].forEach((n, i) => n.classList.toggle("is-drawn", i === draw));
  };
  // the prize: `fresh` is the first landing of an answer — the flow's one reward
  const win = (fresh, { still = false, focus = true } = {}) => {
    paintPrize();
    stage.dataset.state = "won";
    reelWin.classList.add("is-won");
    said.textContent = DRAW.said(items[draw] ? items[draw].title : "");
    if (still) return;
    wonBox.classList.remove("is-in");
    flash.classList.remove("on");
    void wonBox.offsetWidth; // (the words rise again for the next draw)
    wonBox.classList.toggle("is-fresh", !!fresh); // (its top line was already up while the reel slowed)
    wonBox.classList.add("is-in");
    flash.classList.add("on");
    settle();
    if (focus && !openBtn.contains(document.activeElement) && !againBtn.contains(document.activeElement)) openBtn.focus({ preventScroll: true });
    if (!fresh) { haptic(10); return; }
    haptic(18);
    const a = reelWin.getBoundingClientRect();
    const b = screen.getBoundingClientRect();
    meteorBurst(screen, { x: (a.left + a.width / 2 - b.left) / (b.width || 1), y: (a.top + a.height / 2 - b.top) / (b.height || 1), count: 44, seed: 5 + items.length });
  };

  // The whole hand: every pick with its reason, as the page always listed them.
  const paintHand = (statusText) => {
    status.textContent = statusText;
    handTitle.hidden = false;
    // Each card keeps its own reason directly beneath it, so the link between
    // pick and justification survives any wrapping of the grid.
    results.replaceChildren(
      ...items.map((item) =>
        el("div", { class: "pfm-pick" },
          card(item),
          // title so a reason that overruns the three-line clamp is still
          // readable on hover rather than lost.
          item.why ? el("div", { class: "pfm-why", title: item.why }, item.why) : ""
        )
      )
    );
    dealCols();
  };
  const clearAnswer = () => {
    status.textContent = "";
    results.replaceChildren();
    handTitle.hidden = true;
  };
  const fold = () => { halt(); stage.hidden = true; setStrip([]); };

  // ---- the wait ----
  const startWaiting = () => {
    halt();
    stage.hidden = false;
    stage.dataset.state = "waiting";
    stage.classList.remove("is-still");
    reelWin.classList.remove("is-won");
    flash.classList.remove("on");
    said.textContent = "";
    setStrip([back(), back()], true); // card backs going round until there is an answer
    waitMsg.textContent = STAGES[0];
    // The stage is under the question; on a phone that is under the fold, and
    // pressing the button used to look like nothing had happened.
    if (matchMedia("(pointer: coarse)").matches) input.blur(); // (and the keyboard is over it)
    requestAnimationFrame(() => { if (!gone) bring(stage, true); });

    let stageNo = 0;
    return setInterval(() => {
      stageNo = Math.min(stageNo + 1, STAGES.length - 1);
      waitMsg.textContent = STAGES[stageNo];
      // Restart the fade so each new message animates in. Reading offsetWidth
      // forces the reflow that makes removing and re-adding the class count as
      // two separate states.
      waitMsg.classList.remove("in");
      void waitMsg.offsetWidth;
      waitMsg.classList.add("in");
    }, STAGE_MS);
  };

  // The answer is in: the reel takes the real posters, slows and lands on the
  // first pick; a beat; the prize. (Less motion asked for: the prize, at once.)
  const land = async (statusText) => {
    const mine = ++run;
    if (calm()) {
      setStrip([face(items[draw])]);
      paintHand(statusText);
      win(false, { still: true });
      if (byKeys) openBtn.focus({ preventScroll: true });
      settle();
      return;
    }
    const cells = landingStrip(items.length, draw).map((i) => face(items[i]));
    await pictures(cells);
    if (gone || mine !== run) return;
    // The prize's words take their place now, unseen but for the top line —
    // "Tonight's pick" — so nothing moves when the reel stops.
    paintPrize();
    stage.dataset.state = "landing";
    settle();
    roll([back(), ...cells], LAND_MS, () => later(() => {
      if (gone || mine !== run) return;
      paintHand(statusText);
      win(true, { focus: byKeys });
    }, HOLD_MS));
  };

  // "Another one": the next pick in the server's order, round to the first.
  const another = async () => {
    if (items.length < 2 || stage.dataset.state !== "won" || stopTween) return;
    const from = draw;
    draw = nextDraw(draw, items.length);
    if (last && last.items === items) last.draw = draw;
    const mine = ++run;
    if (calm()) {
      setStrip([face(items[draw])]);
      win(false, { still: true });
      return;
    }
    const cells = respinStrip(items.length, from, draw).map((i) => face(items[i]));
    wonBox.classList.remove("is-in");
    wonBox.classList.add("is-out");
    await pictures(cells);
    if (gone || mine !== run) return;
    roll(cells, RESPIN_MS, () => {
      wonBox.classList.remove("is-out");
      if (gone || mine !== run) return;
      win(false);
    });
  };

  // A remembered answer, back on the page as it was left: no spin, no reward.
  const restore = (statusText) => {
    halt();
    stage.hidden = false;
    stage.classList.add("is-still");
    setStrip([face(items[draw])]);
    paintHand(statusText);
    win(false, { still: true });
  };

  const ask = async () => {
    const vibe = input.value.trim();
    if (vibe.length < 3) { input.focus(); return; }
    if (busy) return;
    busy = true;
    goBtn.disabled = true;
    clearAnswer();
    ticker = startWaiting();
    const asker = whose(); // an answer belongs to whoever asked

    try {
      const res = await api.aiRecommend(vibe, kind.mix, era, length);
      if (asker !== whose()) return; // the profile changed while it was thinking: not theirs to see
      const got = res.items || [];
      if (!got.length) {
        if (!gone) {
          fold();
          clearAnswer();
          status.textContent = "Nothing came back for that. Try describing it differently.";
        }
        return;
      }
      const noun = kind.id === "show"
        ? (got.length === 1 ? "show" : "shows")
        : (got.length === 1 ? "film" : "films");
      const statusText =
        `${got.length} ${noun} for “${vibe}”` +
        (res.cached ? " · from earlier" : "") +
        // The taste chips can genuinely strangle a request — "recent" plus "many
        // seasons" leaves almost nothing standing. Say so, rather than letting a
        // three-title page read as the recommender being useless.
        (got.length < 5 && (era !== "any" || length !== "any")
          ? " · not much fits those filters, try loosening one"
          : "");
      // Remember it before painting, so an answer that arrives while the viewer
      // is elsewhere is waiting for them when they come back.
      last = { vibe, kindId: kind.id, era, length, items: got, status: statusText, scrollY: 0, owner: asker, draw: 0 };
      if (!gone) {
        items = got;
        draw = 0;
        land(statusText);
      }
    } catch (err) {
      if (gone) return;
      fold();
      clearAnswer();
      toast((err && err.message) || "The recommender didn't answer.", "🤖");
    } finally {
      clearInterval(ticker);
      ticker = null;
      busy = false;
      goBtn.disabled = false;
    }
  };

  // (a click with no pointer behind it — detail 0 — is Enter, Space or a remote's OK)
  goBtn.addEventListener("click", (e) => { byKeys = e.detail === 0; ask(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { byKeys = true; ask(); } });
  paintSwitch();

  screen.append(
    el("div", { class: "pfm-head" },
      el("h1", { class: "play-h1 play-aurora-text" }, "AI"),
      el("p", { class: "pfm-sub" },
        "Describe the mood in your own words. It searches everything Aurora can play — not just what's already downloaded.")
    ),
    // a few people deciding together (screens/group.js) — the TV's Pick screen has the same card
    el("button", { "data-ui": "group.open", class: "gp-entry focusable", onclick: () => navigate("#/group") },
      el("span", { class: "gp-entry-title" }, GROUP.entry),
      el("span", { class: "gp-entry-line" }, GROUP.entryLine)),
    el("div", { class: "pfm-box" },
      el("div", { class: "pfm-ask" }, input, goBtn),
      el("div", { class: "pfm-tune" },
        el("div", { class: "pfm-tune-group" }, switcher),
        eraRow.row,
        lengthRow.row
      )
    ),
    el("div", { class: "pfm-examples" },
      el("span", { class: "pfm-examples-label" }, "Try:"),
      ...EXAMPLES.map((ex) =>
        el("button", { "data-ui": "pick.example",
          type: "button",
          class: "pfm-example pg-chip focusable",
          onclick: (e) => { input.value = ex; byKeys = e.detail === 0; ask(); },
        }, ex))
    ),
    stage,
    handTitle,
    status,
    results
  );

  root.append(screen);
  if (!last) screen.classList.add("is-fresh"); // (the page comes in once; an answer come back to is simply there)

  if (last) {
    // Coming back to an answer we already have: put it up, restore where they
    // were reading, and leave the box alone rather than stealing focus.
    input.value = last.vibe;
    items = last.items;
    draw = Math.min(items.length - 1, Math.max(0, last.draw || 0));
    restore(last.status);
    // The router scrolls to the top before calling us, so the restore has to
    // happen after this frame's layout — the posters have a fixed aspect ratio,
    // so the page is already its full height without waiting on any image.
    if (last.scrollY) requestAnimationFrame(() => window.scrollTo(0, last.scrollY));
  } else {
    // (the screen is unseen until the play sheet is on the page; a field that
    // cannot be seen cannot take the focus)
    play.ready.then(() => { if (!gone) setTimeout(() => { if (!gone) input.focus(); }, 60); });
  }

  // The router calls this before tearing the screen down.
  return () => {
    gone = true;
    if (ticker) clearInterval(ticker);
    halt(); // (the reel, the beat before the prize: nothing goes on after the page)
    if (handWatch) handWatch.disconnect();
    play.destroy();
    if (last) last.scrollY = window.scrollY;
  };
};
