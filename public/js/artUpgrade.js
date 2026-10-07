// Hero artwork upgrade (elia, 2026-10-07: "if initially we served a low-res
// image on the hero … have it replaced automatically with a higher-res image
// when we've got time and bandwidth, when the user does not do any demanding
// action").
//
// The billboard and the title pages ask for their picture at the size the
// moment allows: on a slow line (net.js `lite()`) that is 780px wide at 1×
// density, and a narrow window asks for less than a wide one. This module
// remembers every such picture and, later — when the viewer has been still
// for a few seconds, the tab is visible, nothing is playing, the line is not
// slow and not on data saver — fetches the full-size version at low priority,
// decodes it off-screen, and swaps it in. The swap is the same picture,
// sharper: no fade, nothing moves.
//
// A job is dropped when its element is gone or already shows another picture
// (the billboard turned a slide), and it does nothing at all when the painted
// address already IS the full one — so every hero may register, cheaply.
import { artUrl } from "./ui.js";
import { lite, onNet } from "./net.js";

const IDLE_MS = 2500; // no input for this long = the viewer is reading/watching
const TICK_MS = 1000;

let lastInput = performance.now();
const touched = () => { lastInput = performance.now(); };
for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"]) {
  addEventListener(ev, touched, { passive: true, capture: true });
}
const idle = () => performance.now() - lastInput > IDLE_MS;
// never behind a film (the player owns the bandwidth), never on a slow line
// or data saver, never in a hidden tab
const clear = () => {
  if (document.hidden || !navigator.onLine) return false;
  if (document.querySelector(".player")) return false;
  if (lite()) return false;
  const c = navigator.connection;
  if (c && c.saveData) return false;
  return true;
};

const jobs = new Set();
let timer = 0;
let running = false;

// `node`: the element whose custom property carries the picture;
// `prop`: "--hero-art" / "--hero-poster"; `src`: the picture's own address
// (before sizing); `width()`: how wide it deserves to be on THIS screen now.
export const upgradeArt = (node, prop, src, width) => {
  if (!node || !src || typeof src !== "string") return;
  const painted = node.style.getPropertyValue(prop);
  if (!painted) return;
  jobs.add({ node, prop, src, width, painted });
  arm();
};

const arm = () => {
  if (timer || !jobs.size) return;
  timer = setTimeout(tick, TICK_MS);
};

const tick = () => {
  timer = 0;
  // drop what no longer applies
  for (const j of jobs) {
    if (!j.node.isConnected || j.node.style.getPropertyValue(j.prop) !== j.painted) jobs.delete(j);
  }
  if (!jobs.size) return;
  if (running || !clear() || !idle()) return arm();
  // one at a time, the oldest first, in an idle slot
  const job = jobs.values().next().value;
  running = true;
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => run(job).finally(() => { running = false; arm(); }), { timeout: 4000 });
};

const run = async (job) => {
  jobs.delete(job);
  const full = artUrl(job.src, job.width(), { full: true });
  if (!full || `url("${full}")` === job.painted) return; // already the best there is
  try {
    const im = new Image();
    im.decoding = "async";
    im.fetchPriority = "low";
    im.src = full;
    await im.decode();
  } catch {
    return; // not available bigger — the small one stays
  }
  // the picture may have moved on while we fetched (a slide turned, a page left)
  if (!job.node.isConnected || job.node.style.getPropertyValue(job.prop) !== job.painted) return;
  job.node.style.setProperty(job.prop, `url("${full}")`);
};

// a line that recovers, a tab that comes back, a window made wider: try again
onNet(() => arm());
addEventListener("visibilitychange", arm);
addEventListener("resize", () => {
  // a wider window deserves a wider picture: re-arm every job (the target
  // width is read at run time)
  arm();
});
