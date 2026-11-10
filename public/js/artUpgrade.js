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
// decodes it off-screen, and brings it in. The swap is the same picture,
// sharper: nothing moves.
//
// A job is dropped when its element is gone or already shows another picture
// (the billboard turned a slide), and it does nothing at all when the painted
// address already IS the full one — so every hero may register, cheaply.
//
// HOW IT COMES IN (elia, 2026-11-10: "can we make the transition to the higher
// res image smoother?"). Giving the element its new address at once looked
// like a blink: the browser stops drawing the old picture that moment and
// draws the new one only when it has decoded it for this size, so for a few
// frames the hero was EMPTY (measured: its brightness fell from 91 to 34 for
// two frames at full speed, longer on a slow phone — tools/webperf/artswap.js).
// So the sharp picture arrives on top of the one that is there:
//   1. a layer (`.art-up`, a child of whatever draws the picture) gets the
//      very same background with only the address changed, and stays unseen
//      for a moment (1 % of the same picture is nothing to the eye): a
//      picture the browser has not drawn before is drawn a few frames late,
//      and it has those frames here — started at once, the fade showed its
//      first half in a single frame;
//   2. it comes in over ~0.4 s (opacity only, the site's easing): old and new
//      are the same picture, so the eye sees it coming into focus;
//   3. under the full layer the element takes the new address, and a moment
//      later the layer is removed, in one step: nothing extra stays alive.
//      (Not faded out. Tried: while the layer is there Chrome draws the
//      element under it a little softer — the layer's being there changes how
//      the element is drawn — so a fade out let that softer picture show
//      through and the hero lost focus for a moment, 17.8 → 15.7 → 17.8.
//      Removed at once, the frame before and the frame after are the same to
//      the pixel.)
// The layer must be drawn exactly as the element it becomes, or its going
// shows as a second small step. Two things see to that, both measured: its
// unseen one-pixel shadow (glass.css ".art-up" — and the same on the cover a
// phone's title page paints), and, inside an element that is drawn enlarged,
// that it stops being kept ready the moment the fade is over (settle()).
// Never through an empty frame: whatever is slow, the old picture is under it.
// With reduced motion, or on the light graphics tier (<html data-fx="lite">),
// the same in one step, without the fade. Nothing of it happens where nobody
// would see it (a hidden tab, behind the player, out of view, a picture that
// is not drawn at this size): then the address is simply replaced, as before.
// A slide that turns while it runs takes the layer along (it is inside the
// slide), and an element given another picture drops it at once.
import { artUrl, pictureWait, picturesIn } from "./ui.js";
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
// `now`: do not wait for the viewer to be still — the picture on screen is
// plainly too small for it (a phone's hero drawn from a card-sized poster),
// so the sharp one is fetched at once whenever the line allows it at all.
export const upgradeArt = (node, prop, src, width, { now = false } = {}) => {
  if (!node || !src || typeof src !== "string") return;
  const painted = node.style.getPropertyValue(prop);
  if (!painted) return;
  const job = { node, prop, src, width, painted };
  // (the sharp hero is a picture on screen: what is out of view waits for it
  // — for its arrival, not for the fade that follows)
  if (now && clear()) { pictureWait(run(job, { wait: false }).catch(() => {})); return; }
  jobs.add(job);
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
  // (and not while the pictures on screen are still coming: ui.js)
  if (running || !clear() || !idle() || !picturesIn()) return arm();
  // one at a time, the oldest first, in an idle slot
  const job = jobs.values().next().value;
  running = true;
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => run(job).finally(() => { running = false; arm(); }), { timeout: 4000 });
};

// ---------- the swap ----------
const PRE_MS = 120;  // the layer is there this long, unseen, before it comes in
const FADE_MS = 420; // (the same figure is in the CSS: glass.css ".art-up")
const HOLD_MS = 260; // the layer stays this long over the element's own new picture
const plain = () => document.documentElement.dataset.fx === "lite" || matchMedia("(prefers-reduced-motion: reduce)").matches;
const absolute = (css) => {
  const m = /^url\("?(.*?)"?\)$/.exec(String(css).trim());
  if (!m) return null;
  try { return new URL(m[1], document.baseURI).href; } catch { return null; }
};
const inView = (el, cs) => {
  if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
  const b = el.getBoundingClientRect();
  return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
};
// What draws the picture, on screen, right now: the element itself (the
// billboard's slide), a backdrop inside it (a title page), or the cover a
// phone's title page paints behind its heading (`.detail-head::before` — the
// layer then sits beside it, with the same box: responsive.css, glass.css).
// Found by what is drawn, not by the screen's width: the computed background
// of each, with the old picture's address in it.
const drawnBy = (node, from) => {
  const out = [];
  const tryOne = (el, pseudo) => {
    const cs = getComputedStyle(el, pseudo);
    if (pseudo && (!cs.content || cs.content === "none")) return;
    const bg = cs.backgroundImage;
    if (!bg || !bg.includes(from)) return;
    if (!inView(el, getComputedStyle(el)) || Number(cs.opacity) === 0) return;
    out.push({ el, bg });
  };
  tryOne(node, null);
  for (const el of node.querySelectorAll(".hero-backdrop")) tryOne(el, null);
  for (const el of node.querySelectorAll(".detail-head")) tryOne(el, "::before");
  return out;
};

// The pictures of a background, top first, as its computed value lists them
// (a comma inside brackets or quotes is not a separator).
const stack = (bg) => {
  const out = [];
  let cur = "", depth = 0, quote = "";
  for (let i = 0; i < bg.length; i++) {
    const ch = bg[i];
    if (quote) {
      if (ch === "\\") { cur += ch + (bg[++i] || ""); continue; }
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && !depth) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
// What the layer draws: the background down to the picture that changes, that
// one with its new address — and nothing of what lies under it (the blurred
// stand-in, a second picture): the element is right there under the layer
// and draws those itself. Size and place are per picture, top first, so the
// ones kept keep theirs.
const upTo = (bg, from, next) => {
  const all = stack(bg);
  const i = all.findIndex((one) => one.includes(from));
  return (i < 0 ? all : all.slice(0, i + 1)).join(", ").split(from).join(next);
};

const fading = new WeakMap(); // element -> its running swap (one at a time on an element)

const cover = (job, to, where, from, next) => new Promise((resolve) => {
  const { node, prop, painted } = job;
  const soft = !plain();
  const layers = where.map(({ el, bg }) => {
    const l = document.createElement("div");
    l.className = "art-up";
    l.setAttribute("aria-hidden", "true");
    // the very same background, the one address changed (so its size and its
    // place are whatever this screen draws)
    l.style.backgroundImage = upTo(bg, from, next);
    l.style.opacity = "0.01"; // (not 0: a layer at 0 is not drawn at all, so nothing would be made ready)
    el.append(l);
    return l;
  });
  let stage = 0; // 0 the layer is coming in · 1 the element has the picture · 2 over
  const timers = [];
  const end = () => {
    if (stage === 2) return;
    stage = 2;
    watch.disconnect();
    removeEventListener("visibilitychange", away);
    for (const t of timers) clearTimeout(t);
    for (const l of layers) l.remove();
    resolve();
  };
  const settle = () => {
    if (stage) return;
    if (!node.isConnected) return end();
    stage = 1;
    node.style.setProperty(prop, to);
    // Inside an element that is drawn enlarged (the old look's backdrops,
    // scale(1.02-1.15)) a layer kept ready for a fade is drawn a little softer
    // than the element's own picture: measured on a phone's Home, old look,
    // 7.9 against 8.7 - which showed as a second small step when the layer
    // went. So there the layer stops being kept ready the moment the fade is
    // over: it is then drawn with the element, the same to the pixel, and the
    // last bit of focus arrives as the end of the fade.
    for (const l of layers) {
      if (l.parentElement && getComputedStyle(l.parentElement).transform !== "none") l.style.willChange = "auto";
    }
    timers.push(setTimeout(end, HOLD_MS));
  };
  // the element was given another picture (the billboard reused the slide):
  // the layer goes, nothing is swapped
  const watch = new MutationObserver(() => {
    if (node.style.getPropertyValue(prop) !== (stage ? to : painted)) end();
  });
  watch.observe(node, { attributes: true, attributeFilter: ["style"] });
  // nobody is looking any more: finish at once
  const away = () => { if (document.hidden) { settle(); end(); } };
  addEventListener("visibilitychange", away);
  const come = () => {
    if (stage) return;
    for (const l of layers) {
      if (soft) l.classList.add("in");
      l.style.opacity = "1";
    }
    timers.push(setTimeout(settle, soft ? FADE_MS + 30 : 90));
  };
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!stage) timers.push(setTimeout(come, PRE_MS)); }));
  // (whatever happens to frames and timers, the layer does not stay)
  timers.push(setTimeout(() => { settle(); end(); }, PRE_MS + FADE_MS + HOLD_MS + 2500));
});

const show = async (job, full) => {
  const { node, prop, painted } = job;
  const to = `url("${full}")`;
  // the picture may have moved on while we fetched (a slide turned, a page left)
  const live = () => node.isConnected && node.style.getPropertyValue(prop) === painted;
  while (fading.has(node)) await fading.get(node);
  if (!live()) return;
  const from = absolute(painted);
  const next = absolute(to);
  const seen = !document.hidden && !document.querySelector(".player");
  const where = seen && from && next ? drawnBy(node, from) : [];
  if (!where.length) { node.style.setProperty(prop, to); return; }
  const done = cover(job, to, where, from, next);
  fading.set(node, done);
  try { await done; } finally { fading.delete(node); }
};

// `painted` (url("…")) shows the same address as `full` but for its ?w=,
// at a width no smaller (no ?w= at all: the original, as wide as it comes)
const widthOf = (u) => { const m = /[?&]w=(\d+)/.exec(u); return m ? Number(m[1]) : Infinity; };
const alreadyWide = (painted, full) => {
  const m = /^url\("(.*)"\)$/.exec(painted || "");
  if (!m) return false;
  const bare = (u) => u.replace(/([?&])w=\d+&?/, "$1").replace(/[?&]$/, "");
  return bare(m[1]) === bare(full) && widthOf(m[1]) >= widthOf(full);
};

const run = async (job, { wait = true } = {}) => {
  jobs.delete(job);
  const full = artUrl(job.src, job.width(), { full: true });
  if (!full || `url("${full}")` === job.painted) return; // already the best there is
  // the same picture already painted at least as wide (a local cover drawn at
  // ?w=800 whose "full" size here is ?w=780): a second, smaller download of
  // what is on screen — nothing to do
  if (alreadyWide(job.painted, full)) return;
  try {
    const im = new Image();
    im.decoding = "async";
    im.fetchPriority = "low";
    im.src = full;
    await im.decode();
  } catch {
    return; // not available bigger — the small one stays
  }
  // (one at a time: the next job waits for this one's fade, except the
  // picture that was asked for at once — it does not hold the others back)
  const done = show(job, full);
  if (wait) await done;
  else done.catch(() => {});
};

// a line that recovers, a tab that comes back, a window made wider: try again
onNet(() => arm());
addEventListener("visibilitychange", arm);
addEventListener("resize", () => {
  // a wider window deserves a wider picture: re-arm every job (the target
  // width is read at run time)
  arm();
});
