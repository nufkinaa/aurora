// Real glass: the lens at the rim of the chrome that floats over pictures
// (glass.css, "Real glass"). A thick piece of glass bends what is behind it
// where its edge turns away, and bends red a little more than blue — the
// colour fringe of a real lens. Chromium can draw that: an SVG displacement
// map inside `backdrop-filter`, once per colour with a slightly different
// strength. Safari and Firefox cannot (Safari drops the WHOLE backdrop
// filter when a url() is in it — WebKit bugs 245510, 317059), so they never
// see a url(): the stylesheet only uses the lens under html[data-lens], and
// only this file sets that, on Chromium alone. Everything else of the look
// (the rim, its glint, the depth) is plain CSS and the same everywhere.
//
// No per-frame work: a map is drawn once per SIZE of surface (a 42 px round
// button, the tab bar…), kept, and shared by every surface of that size. The
// browser's own ResizeObserver says when a size changes; a MutationObserver
// (coalesced to one pass) finds surfaces as screens come and go.

// What takes the lens: the same two as the "Real glass" section of glass.css
// — the bar (the desktop island, the phone tab bar) and the hero's glass
// button. Not the small buttons, and not the player's chrome: a lens is
// worked out again for every frame in which what is behind it moves, and
// with one on every surface that was measured — 12 % more processor time on
// a desktop Home at rest, nearly four times as much over a playing film
// (tools/real-glass/player-cost.js). They wear the rim over Clear's blur.
const SCOPE = [".nav-items", ".hero-actions .btn:not(.btn-primary)"].join(",");
// On a phone the stylesheet gives the lens to the tab bar alone (the More
// menu's first frame — glass.css, "Phones: the lens is the tab bar's
// alone"): no maps are drawn for the rest.
const PHONE = "(max-width: 720px)";
const PHONE_ONLY = ".nav-items";

const NS = "http://www.w3.org/2000/svg";
const MAX_FILTERS = 28;
// the face of the glass is softly frosted (Clear's 3 px); its bezel less so
const SOFT = 3;
const BEZEL_SOFT = 1.3;
// a size that keeps changing (a window being dragged) is fitted when it rests
const REST_MS = 160;

// Chromium, and only Chromium. Not a CSS.supports() question: Safari PARSES
// url() in backdrop-filter and then draws nothing. iOS browsers are all
// WebKit whatever their name (CriOS, FxiOS, EdgiOS carry no "Chrome/").
export function lensSupported(nav = typeof navigator !== "undefined" ? navigator : null, win = typeof window !== "undefined" ? window : null) {
  try {
    if (!nav || !win) return false;
    const ua = String(nav.userAgent || "");
    if (/iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
    const m = /Chrom(?:e|ium)\/(\d+)/.exec(ua);
    if (!m || Number(m[1]) < 113) return false;
    const brands = nav.userAgentData && nav.userAgentData.brands;
    if (Array.isArray(brands) && brands.length && !brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/.test(b.brand))) return false;
    const css = win.CSS;
    if (!css || !css.supports || !css.supports("backdrop-filter", "url(#a) blur(1px)")) return false;
    // a switch for a person (or a test) to turn it off: localStorage aurora-lens = "off"
    try { if (win.localStorage && win.localStorage.getItem("aurora-lens") === "off") return false; } catch {}
    return true;
  } catch {
    return false;
  }
}

// The shape of the bend. `bezel`: the last px before the edge that are the
// bevel. `depth`: how far inside the rim itself looks.
// thick: how wide the bezel is (1 = the look's own; glass.css --rg-thick)
export function lensGeometry(w, h, radius, thick = 1) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const bezel = Math.max(5, Math.min(13 * thick, Math.min(w, h) * 0.2 * thick));
  return { r, bezel, depth: bezel * 2.2 };
}
const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
// The map for one size: for every pixel, where the glass makes it look, and
// how much of the pixel is the bevel's.
// t runs from 0 where the bevel begins to 1 at the rim. The view is pulled
// inwards by depth * t²: gently at first, steeply at the rim — so the bevel
// shows a WIDE band of the picture, turned over and squeezed (up to 3.4
// times at the rim), the way a rounded edge does. A squeezed picture stays
// crisp; a stretched one (a straight, shallow bevel) smears into streaks.
// Near t = 0.23 the view stands still for a moment — a smear — so the bevel
// only fades in after it (0.2 … 0.6): what is seen is all squeezed.
// put(x, y, across, down, veil): 128 = straight through; veil 255 = all bevel.
export function lensMap(w, h, radius, put, res = 1, thick = 1) {
  const { r, bezel } = lensGeometry(w, h, radius, thick);
  const W = Math.max(2, Math.round(w * res)), H = Math.max(2, Math.round(h * res));
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const x = ((px + 0.5) * w) / W, y = ((py + 0.5) * h) / H;
      // the nearest point of the rounded box's spine, and the way out from it
      const cx = Math.min(Math.max(x, r), w - r), cy = Math.min(Math.max(y, r), h - r);
      let nx = x - cx, ny = y - cy;
      const len = Math.hypot(nx, ny);
      let d;
      if (len > 1e-6) { d = r - len; nx /= len; ny /= len; }
      else {
        const dl = x, dr = w - x, dt = y, db = h - y;
        d = Math.min(dl, dr, dt, db);
        nx = d === dl ? -1 : d === dr ? 1 : 0;
        ny = nx ? 0 : d === dt ? -1 : 1;
      }
      const t = d >= bezel ? 0 : 1 - Math.max(0, d) / bezel;
      const m = t * t;
      put(px, py, 128 - 127 * nx * m, 128 - 127 * ny * m, 255 * smooth(0.2, 0.6, t));
    }
  }
}

// How the colours are told apart: `taps` copies of the picture, each bent a
// little less than the one before, each giving its share of red, green and
// blue (every colour adds up to one). 3: red, green, blue. 5: a spectrum —
// red, yellow, green, cyan, blue — for a pane wide enough to show it.
export function lensTaps(taps, spread) {
  const share = taps >= 5
    ? [[0.5, 0, 0], [0.5, 0.25, 0], [0, 0.5, 0], [0, 0.25, 0.5], [0, 0, 0.5]]
    : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const n = share.length;
  return share.map((rgb, i) => ({ k: 1 + spread * (1 - (2 * i) / (n - 1)), rgb }));
}

let defs = null;
const filters = new Map(); // key -> { id, used }
let serial = 0;
let tick = 0;

const fe = (name, attrs) => {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

const ensureDefs = () => {
  if (defs && defs.isConnected) return defs;
  defs = fe("svg", { id: "rg-defs", "aria-hidden": "true", width: "0", height: "0" });
  defs.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  // what a surface uses until its own map is ready: frosted, straight through
  const f = fe("filter", { id: "rg-0" });
  f.append(fe("feGaussianBlur", { in: "SourceGraphic", stdDeviation: String(SOFT) }));
  defs.append(f);
  document.body.append(defs);
  filters.clear();
  return defs;
};

// the bevel catches a little more light than the face
const LIT = 1.04, LIFT = 0.01;

const filterFor = (w, h, radius, look) => {
  const key = `${w}x${h}r${Math.round(radius)}t${look.thick}s${look.spread}n${look.taps}`;
  const had = filters.get(key);
  if (had) { had.used = ++tick; return had.id; }
  const svg = ensureDefs();
  // The map is a small picture, stretched over the pane: half the pane's
  // size each way for a bar, the pane's own for a small round button. It is
  // smooth, so nothing is lost — and it matters: Chromium sends a filter's
  // picture along with EVERY frame it draws while what is behind the pane
  // moves (the living sky, a scroll), so a big map is paid for sixty times
  // a second (tools/real-glass/player-cost.js).
  const res = Number(window.__rgRes) || (w * h <= 2600 ? 1 : 0.5);
  const W = Math.max(2, Math.round(w * res)), H = Math.max(2, Math.round(h * res));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) return "rg-0";
  const im = ctx.createImageData(W, H);
  lensMap(w, h, radius, (px, py, rr, gg, veil) => {
    const o = (py * W + px) * 4;
    im.data[o] = rr; im.data[o + 1] = gg; im.data[o + 2] = veil; im.data[o + 3] = 255;
  }, res, look.thick);
  ctx.putImageData(im, 0, 0);
  const id = `rg-${++serial}`;
  const { depth } = lensGeometry(w, h, radius, look.thick);
  const f = fe("filter", { id, x: "0", y: "0", width: "100%", height: "100%", "color-interpolation-filters": "sRGB" });
  f.append(fe("feImage", { href: c.toDataURL("image/png"), x: "0", y: "0", width: String(w), height: String(h), preserveAspectRatio: "none", result: "map" }));
  // (the bevel's picture a touch soft: squeezed pixel-sharp, it speckles)
  f.append(fe("feGaussianBlur", { in: "SourceGraphic", stdDeviation: String(BEZEL_SOFT), result: "crisp" }));
  let sum = null;
  lensTaps(look.taps, look.spread).forEach((tap, i) => {
    f.append(fe("feDisplacementMap", { in: "crisp", in2: "map", scale: String(Math.round(depth * 2 * tap.k * 100) / 100), xChannelSelector: "R", yChannelSelector: "G", result: `bent${i}` }));
    const [r, g, b] = tap.rgb.map((v) => [Math.round(v * LIT * 1000) / 1000, v ? Math.round(v * LIFT * 1000) / 1000 : 0]);
    f.append(fe("feColorMatrix", { in: `bent${i}`, type: "matrix", values: `${r[0]} 0 0 0 ${r[1]}  0 ${g[0]} 0 0 ${g[1]}  0 0 ${b[0]} 0 ${b[1]}  0 0 0 1 0`, result: `part${i}` }));
    if (sum == null) sum = `part${i}`;
    else {
      f.append(fe("feComposite", { in: sum, in2: `part${i}`, operator: "arithmetic", k1: "0", k2: "1", k3: "1", k4: "0", result: `sum${i}` }));
      sum = `sum${i}`;
    }
  });
  // the face: softly frosted; the bevel (the map's third number) laid over it
  f.append(fe("feGaussianBlur", { in: "SourceGraphic", stdDeviation: String(SOFT), result: "soft" }));
  f.append(fe("feColorMatrix", { in: "map", type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0", result: "veil" }));
  f.append(fe("feComposite", { in: sum, in2: "veil", operator: "in", result: "rim" }));
  const merge = fe("feMerge", {});
  merge.append(fe("feMergeNode", { in: "soft" }), fe("feMergeNode", { in: "rim" }));
  f.append(merge);
  svg.append(f);
  filters.set(key, { id, used: ++tick });
  if (filters.size > MAX_FILTERS) prune();
  return id;
};

// drop the maps nothing uses any more (a window dragged through many widths)
const prune = () => {
  const inUse = new Set();
  for (const el of document.querySelectorAll(SCOPE)) {
    const m = /url\(#(rg-\d+)\)/.exec(el.style.getPropertyValue("--rg-lens"));
    if (m) inUse.add(m[1]);
  }
  const old = [...filters.entries()].filter(([, v]) => !inUse.has(v.id)).sort((a, b) => a[1].used - b[1].used);
  for (const [key, v] of old.slice(0, Math.max(0, filters.size - MAX_FILTERS + 6))) {
    document.getElementById(v.id)?.remove();
    filters.delete(key);
  }
};

const num = (cs, name, def, lo, hi) => { const v = parseFloat(cs.getPropertyValue(name)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };

let phone = null;
const plain = (el) => { if (el.style.getPropertyValue("--rg-lens")) el.style.removeProperty("--rg-lens"); };
// a surface's own lens (or none): its size, its corner, the look's numbers on it
const apply = (el) => {
  if (!el.isConnected) return;
  if (phone && phone.matches && !el.matches(PHONE_ONLY)) return plain(el);
  const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
  if (w < 28 || h < 28 || w * h > 1400 * 220) return plain(el);
  const cs = getComputedStyle(el);
  const look = { thick: num(cs, "--rg-thick", 1, 0.5, 2), spread: num(cs, "--rg-spread", 0.1, 0, 0.3), taps: num(cs, "--rg-taps", 3, 3, 5) >= 5 ? 5 : 3 };
  const want = `url(#${filterFor(w, h, parseFloat(cs.borderTopLeftRadius) || 0, look)})`;
  if (el.style.getPropertyValue("--rg-lens") !== want) el.style.setProperty("--rg-lens", want);
};

let started = false;
let on = false;

export function initGlassLens() {
  if (started || typeof document === "undefined") return;
  started = true;
  if (!lensSupported() || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
  const root = document.documentElement;
  const media = (q) => (typeof matchMedia === "function" ? matchMedia(q) : null);
  phone = media(PHONE);
  let seen = new WeakSet();
  const sized = new WeakMap(); // surface -> the size its lens was drawn for
  const dirty = new Set();
  let raf = 0, rest = 0;
  const flush = () => {
    raf = 0; rest = 0;
    const all = [...dirty];
    dirty.clear();
    for (const el of all) {
      // gone from the page (the player is built anew for every film): let go of it
      if (!el.isConnected) { ro.unobserve(el); seen.delete(el); sized.delete(el); continue; }
      if (!on) continue;
      apply(el);
      sized.set(el, `${el.offsetWidth}x${el.offsetHeight}`);
    }
  };
  const ro = new ResizeObserver((entries) => {
    let again = false;
    for (const e of entries) {
      const el = e.target;
      dirty.add(el);
      // a surface that already wears a lens and changed size (the window is
      // being dragged): plain frosted glass until the size rests, then its
      // new lens — not a new map for every width on the way
      if (on && el.isConnected && sized.has(el) && sized.get(el) !== `${el.offsetWidth}x${el.offsetHeight}` && el.style.getPropertyValue("--rg-lens")) {
        el.style.setProperty("--rg-lens", "url(#rg-0)");
        again = true;
      }
    }
    if (again) { clearTimeout(rest); rest = setTimeout(flush, REST_MS); if (raf) { cancelAnimationFrame(raf); raf = 0; } }
    else if (!raf && !rest) raf = requestAnimationFrame(flush);
  });
  const scan = () => {
    if (!on) return;
    for (const el of document.querySelectorAll(SCOPE)) {
      if (seen.has(el)) continue;
      seen.add(el);
      ro.observe(el);
    }
  };
  const all = () => { for (const el of document.querySelectorAll(SCOPE)) { apply(el); sized.set(el, `${el.offsetWidth}x${el.offsetHeight}`); } };
  let pending = 0;
  const later = () => {
    // The maps live in one hidden <svg>. If something takes it out of the
    // page, every lens points at nothing and Chromium then draws NO backdrop
    // filter at all — the dim that holds the words goes with it. Put back
    // at once, and every surface fitted again.
    if (on && defs && !defs.isConnected) { ensureDefs(); all(); }
    if (pending) return;
    pending = setTimeout(() => { pending = 0; scan(); }, 80);
  };
  // (reduced transparency, a TV's browser — where glass.css drops the blur —
  // and a person who asked for more contrast or their own colours: no lens)
  const quiet = media("(prefers-reduced-transparency: reduce), (hover: none) and (pointer: coarse) and (min-width: 1200px), (prefers-contrast: more), (forced-colors: active)");
  const decide = () => {
    const want = root.dataset.look === "glass" && root.dataset.fx !== "lite" && !(quiet && quiet.matches);
    if (want === on) return;
    on = want;
    if (on) { ensureDefs(); all(); root.dataset.lens = "1"; scan(); }
    else {
      // (another look, or no lens wanted any more: the maps go too)
      delete root.dataset.lens;
      for (const el of document.querySelectorAll(SCOPE)) plain(el);
      if (defs) { defs.remove(); defs = null; filters.clear(); }
    }
  };
  new MutationObserver(decide).observe(root, { attributes: true, attributeFilter: ["data-look", "data-fx"] });
  if (quiet && quiet.addEventListener) quiet.addEventListener("change", decide);
  // a phone turned on its side, a window made narrow: which surfaces take the lens changes
  if (phone && phone.addEventListener) phone.addEventListener("change", () => { if (on) all(); });
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
  decide();
}
