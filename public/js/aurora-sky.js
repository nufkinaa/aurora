// Full-screen aurora for the sign-in sky — the nav aurora's big sibling.
// Same band language (bright core, long veil below, meandering centerline,
// curls that come and go) tuned for a whole viewport: slower, taller, one
// violet band in the mix, and a sparse starfield behind. The curtains are
// painted at 1/3 resolution and upscaled — the blur IS the glow — while on
// desktop the stars go on a full-resolution layer so they stay points. The
// loop stops the moment the canvas leaves the DOM or the tab hides.
// Reduced motion: one still frame, no drift.
//
// The painter and its clock live in aurora-sky-core.js; this file is the
// page's side of it — what the page knows (is the sky shown, is motion
// wanted, how big is the canvas) and WHERE the painting happens:
//   - on the page's own thread, as it always did (phones, the sign-in and
//     install skies, any browser without OffscreenCanvas), or
//   - in a worker (`offMain`: the glass look's page sky on a computer).
// Why a worker (2026-11-10 — elia: "when scrolling on desktop the background
// stops and then comes back… it looks not so good"): on a computer one paint
// of a full-window sky costs 12–30 ms, which is "dear", and a dear sky holds
// its frame for as long as the page is being scrolled (the hold below) — it
// has to, or its paint lands in the scroll's own frames. Measured, 1440 to
// 4K: no paint at all through a six-second scroll. In a worker the paint
// costs the page's thread nothing, so the sky never has to stop.
import { makeSky, makeLoop } from "./aurora-sky-core.js";

// What the page knows about one sky.
const look = (canvas) => {
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  // Phones (and anything else with a finger, or a small screen) paint at a
  // quarter of the resolution and 12fps instead of a third and 20: the
  // curtains are as soft either way — the blur IS the upscale — and the
  // per-frame column loop costs less than half as much on a weak CPU.
  const mobile = matchMedia("(pointer: coarse)").matches || innerWidth < 900;
  // A genuinely weak device (2 GB, two cores, or data saver on) gets one still
  // frame of the sky, like reduced-motion does — the look, without the loop.
  const weak =
    (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) ||
    !!(navigator.connection && navigator.connection.saveData);
  // The player covers the whole viewport with black — a sky animating under
  // it is pure battery. While one is open the loop sleeps and checks back
  // once a second (a full-screen overlay, not a page, so no route event).
  // (a live list: asking it is not a search of the whole page, as
  // querySelector was — and this is asked every frame)
  const players = document.getElementsByClassName("player");
  // A playing story (Wrapped) covers the viewport with a night of its own:
  // the same nap (2026-11-10: under it the sky cost the story its frames).
  const stories = document.getElementsByClassName("play-story");
  const state = () =>
    !canvas.isConnected || document.hidden
      ? "stop"
      : calm.matches || weak
        ? "still"
        : players.length > 0 || stories.length > 0
          ? "nap"
          : "run";
  const size = () => [canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1];
  return { calm, mobile, weak, state, size };
};

// tools/webperf/skywatch.js and the cadence test count the sky's paints (a
// canvas whose drawing went to a worker cannot be watched from the page).
const watching = () => !!window.__auroraSkyWatch;
// (`at`: when, on the painter's own clock — a worker's word reaches the page late when the page is busy)
const tell = (cost, at) => window.dispatchEvent(new CustomEvent("aurora-sky-paint", { detail: { cost, at } }));

// ---- on the page's own thread ---------------------------------------------
const onPage = (canvas, env, { pace, stars, seed, frames }) => {
  const sky = makeSky(canvas, {
    mobile: env.mobile,
    pace,
    stars,
    seed,
    makeCanvas: (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }),
  });
  const paint = (t, still) => {
    sky.size(...env.size());
    sky.paint(t, still);
  };
  // While the page is being scrolled, the sky holds its frame. Every repaint
  // of the canvas re-blurs the glass above it (the nav island, the hero
  // slab), and on a phone that work landed in the same frames as the
  // scroll — so the sky waits until the finger has been still for a beat.
  // The curtains drift over tens of seconds; a 150ms hold is invisible.
  // The hold is for a device where a frame is DEAR (measured, not guessed
  // from the pointer): on a capable phone it made the aurora stand still
  // through every fling and jump afterwards — the choppiness elia saw on an
  // iPhone 18 Pro — while the surfaces that made re-blurring expensive (the
  // hero slab, the episode and source cards) no longer blur at all.
  let scrolledAt = 0;
  const onScroll = () => { scrolledAt = performance.now(); };
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });
  const hold = (now, cost) => (cost > 9 && now - scrolledAt < 150 ? scrolledAt + 150 : 0);
  const loop = makeLoop(paint, { state: env.state, hold, report: watching() ? tell : null, frames });
  document.addEventListener("visibilitychange", loop.kick);
  window.addEventListener("resize", loop.kick);
  loop.kick();

  // teardown for when the overlay is removed
  return () => {
    loop.stop();
    document.removeEventListener("visibilitychange", loop.kick);
    document.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("resize", loop.kick);
  };
};

// ---- in a worker ------------------------------------------------------------
// A canvas hands its drawing to a worker once and for good, so the worker
// outlives a teardown: stopping the sky puts it to sleep, starting it again
// on the same canvas wakes it (the look switched away from glass and back).
const working = new WeakMap(); // canvas -> its worker's controller
const pageOnly = new WeakSet(); // canvases whose worker could not start: they paint here

// The versioned address the page itself loads a module from (the import map
// in the page's head) — a worker has no import map of its own.
const address = (file) => {
  try {
    return import.meta.resolve(file);
  } catch {
    return new URL(file, import.meta.url).href;
  }
};

const canWork = (canvas) =>
  !pageOnly.has(canvas) && typeof Worker === "function" && typeof canvas.transferControlToOffscreen === "function";

const HELLO_MS = 4000; // a worker that has not answered by now is not coming

const startWorker = (canvas, opts) => {
  const env = look(canvas);
  let on = false; // between an init and its teardown
  let ready = false; // the worker holds the canvas
  let sent = "";
  let pageStop = null; // the fallback's teardown, once the worker has failed
  let poll = 0;
  let hello = 0;
  let worker = null;
  let watcher = null;

  const sync = () => {
    if (!ready) return;
    const s = on ? env.state() : "stop";
    if (s === sent) return;
    sent = s;
    worker.postMessage({ state: s });
  };
  const listen = (yes) => {
    const f = yes ? "addEventListener" : "removeEventListener";
    document[f]("visibilitychange", sync);
    env.calm[f]("change", sync);
    clearInterval(poll);
    // (a player opening or closing, the canvas leaving the page: nothing
    // announces those — the page-thread loop asks every frame, this asks
    // once a second)
    poll = yes ? setInterval(sync, 1000) : 0;
  };

  // The worker failed: the sky paints here, as it would have without one.
  // A canvas already handed over cannot be drawn on again, so a fresh copy
  // takes its place in the page.
  const fail = () => {
    if (!worker) return;
    clearTimeout(hello);
    worker.terminate();
    worker = null;
    if (watcher) watcher.disconnect();
    listen(false);
    working.delete(canvas);
    let target = canvas;
    if (ready) {
      target = canvas.cloneNode(false);
      canvas.replaceWith(target);
    }
    ready = false;
    pageOnly.add(target);
    if (on) pageStop = onPage(target, look(target), opts);
  };

  try {
    worker = new Worker(address("./aurora-sky-worker.js"), { type: "module" });
  } catch {
    return null;
  }
  hello = setTimeout(fail, HELLO_MS);
  worker.addEventListener("error", fail);
  worker.addEventListener("messageerror", fail);
  worker.addEventListener("message", ({ data }) => {
    if (data.paint != null) return tell(data.paint, data.at);
    if (data.ready === false) return fail();
    if (data.ready !== true || ready) return;
    clearTimeout(hello);
    try {
      const off = canvas.transferControlToOffscreen();
      sent = on ? env.state() : "stop";
      worker.postMessage(
        {
          canvas: off,
          pace: opts.pace,
          stars: opts.stars,
          seed: opts.seed,
          frames: opts.frames,
          size: env.size(),
          state: sent,
          watch: watching(),
        },
        [off],
      );
      ready = true;
    } catch {
      return fail();
    }
    watcher = new ResizeObserver(() => {
      if (worker) worker.postMessage({ size: env.size() });
    });
    watcher.observe(canvas);
  });
  worker.postMessage({ hello: address("./aurora-sky-core.js") });

  return {
    start() {
      if (!worker) return onPage(canvas, look(canvas), opts); // (it failed while asleep)
      on = true;
      listen(true);
      sync();
      return () => {
        on = false;
        if (pageStop) pageStop();
        pageStop = null;
        listen(false);
        sync();
      };
    },
  };
};

// `pace` scales every band's drift: 1 is the sign-in sky, ~0.45 the glass
// look's page sky (elia: "a bit slower" — a sky behind everything must
// breathe, not drift). `stars` toggles the starfield. `offMain` asks for the
// worker where there is one (see the top of this file). `seed` and `frames`
// are for tools/webperf/skyproof.js: the same sky twice, at given moments.
export const initAuroraSky = (canvas, { pace = 1, stars = true, offMain = false, seed = null, frames = null } = {}) => {
  if (!canvas) return () => {};
  const opts = { pace, stars, seed, frames };
  const env = look(canvas);
  let ctl = working.get(canvas);
  // A phone keeps its sky on the page's thread: its paint is cheap enough to
  // run at 20–30 a second there, and a second thread is not free on one. A
  // weak device paints one still frame — no loop to move anywhere.
  if (!ctl && offMain && !env.mobile && !env.weak && canWork(canvas)) {
    ctl = startWorker(canvas, opts);
    if (ctl) working.set(canvas, ctl);
    else pageOnly.add(canvas);
  }
  return ctl ? ctl.start() : onPage(canvas, env, opts);
};
