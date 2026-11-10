// The pictures further down the page, before the scroll gets there.
//
// A poster below the screen is asked for by the browser's own lazy-load, when
// its shelf comes within ~1250 px of the screen. A wheel spun briskly covers
// that in a third of a second, a real line needs 100–250 ms a picture, and a
// shelf's cards past its right edge are not asked for at all until they are
// paged into view — so a quick scroll on a desktop met empty tiles and a
// screenful of posters sharpening at once (measured 2026-11-10, 70 ms away:
// at 3000 px/s only 64 % of the posters were in when they came into view, at
// 6000 px/s 24 were blank at once; with the pictures already here, none).
//
// So once the pictures on screen are in (ui.js `afterPictures`) and the
// browser is idle, the posters the page has built are asked for a few at a
// time, in the order the page built them: each is switched from lazy to
// eager, which is the browser's own request for that very <img> — the same
// address, the same cache, nothing drawn differently. What then arrives
// while its card is out of sight is simply there when the card comes into
// view (ui.js posterImg `reveal`).
//
// Only where it costs nothing a person would miss: a desktop (a mouse, a
// wide window — a phone's lazy-load already reaches two screens ahead, and
// its data is not ours to spend), a line that is not slow, not under Data
// Saver, a tab in front, online, no film playing. A few at a time, so the
// pictures a scroll brings into view never queue behind them; and no more
// than a page's worth per screen.
import { lite, fastNet } from "./net.js";

export const WARM_FLIGHT = 4; // asked for at once
// …and while the page is being scrolled. (Measured 70 ms away, a scroll begun
// 1.5 s after a cold load, 3000 px/s, six runs each: none 99 % of the posters
// in on arrival, two 100 %, four 99 % — against 51 % before; begun 0.6 s
// after the load the three are alike.)
export const WARM_FLIGHT_SCROLL = 2;
export const WARM_MAX = 240; // per screen
export const WARM_SLOT_MS = 8000; // one that never answers gives its place back
export const SCROLL_QUIET_MS = 200; // no scroll for this long: the page is at rest

// A poster that still waits for the browser's lazy-load (it has its address,
// it is on the page, nothing has arrived).
const waiting = (img) =>
  !!img && img.isConnected && img.loading === "lazy" && !!img.getAttribute("src") && !(img.complete && img.naturalWidth > 0);

// The queue, with its rules handed in (so it can be tested without a page):
//   ok()        may pictures be asked for ahead right now?
//   idle(fn)    run fn when the browser has nothing to do
//   timer/clear setTimeout / clearTimeout
//   room()      how many may be on their way at once right now (default `flight`)
export const makeWarmer = ({ ok, idle, timer = setTimeout, clear = clearTimeout, flight = WARM_FLIGHT, room = null, max = WARM_MAX, slotMs = WARM_SLOT_MS }) => {
  let queue = [];
  let flying = 0;
  let asked = 0; // on this screen
  let open = false; // the pictures on screen are in
  let planned = false;
  let gen = 0; // (a screen left behind: its pictures no longer count)
  const pump = () => {
    planned = false;
    if (!open) return;
    while (flying < (room ? room() : flight) && queue.length && asked < max) {
      if (!ok()) return; // (asked again by `nudge`, and by the next poster offered)
      const img = queue.shift();
      if (!waiting(img)) continue;
      flying++;
      asked++;
      const mine = gen;
      let settled = false;
      let slot = 0;
      const done = () => {
        if (settled) return;
        settled = true;
        clear(slot);
        img.removeEventListener("load", done);
        img.removeEventListener("error", done);
        if (mine !== gen) return;
        flying = Math.max(0, flying - 1);
        pump();
      };
      img.addEventListener("load", done);
      img.addEventListener("error", done);
      slot = timer(done, slotMs);
      img.loading = "eager";
    }
    if (asked >= max) queue = [];
  };
  const plan = () => {
    if (planned || !open || !queue.length || asked >= max) return;
    planned = true;
    idle(pump);
  };
  return {
    // a poster the page has just built (in the order the page builds them)
    offer(img) {
      if (asked >= max) return;
      queue.push(img);
      plan();
    },
    // posters the person is about to reach (a shelf's next page): before the rest
    first(imgs) {
      if (asked >= max) return;
      const set = new Set(imgs);
      queue = [...imgs, ...queue.filter((im) => !set.has(im))];
      plan();
    },
    // a screen is being opened: what the last one still wanted is dropped
    reset() {
      gen++;
      queue = [];
      flying = 0;
      asked = 0;
      open = false;
      planned = false;
    },
    // the pictures on screen are in: start
    go() {
      open = true;
      plan();
    },
    // something that held the queue back has passed (the tab is in front
    // again, the line is back): carry on, if it had started
    nudge() {
      plan();
    },
    get size() { return queue.length; },
    get flying() { return flying; },
    get asked() { return asked; },
  };
};

// ---------- the page's own ----------
let wide = null;
const desktop = () => {
  if (wide == null) {
    try {
      const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
      wide = mq.matches;
      const on = (e) => { wide = e.matches; };
      if (mq.addEventListener) mq.addEventListener("change", on);
    } catch { wide = false; }
  }
  return wide && window.innerWidth >= 900;
};
// (the same rules as the quiet prefetching of pages and art — prefetch.js)
export const warmAllowed = () => {
  if (typeof document === "undefined" || typeof navigator === "undefined") return false;
  if (document.hidden || navigator.onLine === false) return false;
  if (lite()) return false; // a slow line, measured, hinted, or chosen (Data use → Data saver)
  const c = navigator.connection;
  if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ""))) return false;
  if (!fastNet() && c && c.effectiveType && c.effectiveType !== "4g") return false;
  if (document.querySelector(".player")) return false; // the film owns the line
  return desktop();
};

const idle = (fn) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 1500 });
  else setTimeout(fn, 200);
};

// While the page is being scrolled, the browser's own lazy-load is asking for
// the shelves coming into reach: those go first.
let scrolled = -1e9;
let watch = 0;
const scrolling = () => performance.now() - scrolled < SCROLL_QUIET_MS;
export const warmScrolling = scrolling;
const warmer = makeWarmer({ ok: warmAllowed, idle, room: () => (scrolling() ? WARM_FLIGHT_SCROLL : WARM_FLIGHT) });
export const warmOffer = (img) => warmer.offer(img);
export const warmFirst = (imgs) => warmer.first(imgs);
export const warmReset = () => warmer.reset();
export const warmGo = () => warmer.go();

if (typeof document !== "undefined" && document.addEventListener) {
  const settle = () => {
    watch = 0;
    if (scrolling()) watch = setTimeout(settle, SCROLL_QUIET_MS);
    else warmer.nudge();
  };
  window.addEventListener("scroll", () => {
    scrolled = performance.now();
    if (!watch) watch = setTimeout(settle, SCROLL_QUIET_MS);
  }, { passive: true, capture: true });
  // back in front, back online: what was waiting carries on
  document.addEventListener("visibilitychange", () => { if (!document.hidden) warmer.nudge(); });
  window.addEventListener("online", () => warmer.nudge());
}
