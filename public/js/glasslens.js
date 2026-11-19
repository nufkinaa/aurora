// Real glass: the lens at the rim of the chrome that floats over pictures
// (glass.css, "Real glass"). A thick piece of glass bends what is behind it
// where its edge turns away, and bends red a little more than blue — the
// colour fringe of a real lens. Chromium can draw that: an SVG displacement
// map inside `backdrop-filter`, once per colour channel with a slightly
// different strength. Safari and Firefox cannot (Safari drops the WHOLE
// backdrop filter when a url() is in it — WebKit bugs 245510, 317059), so
// they never see a url(): the stylesheet only uses the lens under
// html[data-lens], and only this file sets that, on Chromium alone. Everything
// else of the look (the rim's light, the drawn fringe, the depth) is plain
// CSS and the same everywhere.
//
// No per-frame work: a map is drawn once per SIZE of surface (a 44 px round
// button, the tab bar…), kept, and shared by every surface of that size. The
// browser's own ResizeObserver says when a size changes; a MutationObserver
// (coalesced to one idle pass) finds surfaces as screens come and go.

// what takes the lens: the same list as the "Real glass" section of glass.css
const SCOPE = [
  ".nav-items",
  ".nav-logo",
  ".nav-profile",
  ".nav-gear",
  ".nav-dl",
  ".nav-remote",
  ".hero-actions .btn:not(.btn-primary)",
  ".detail-actions .btn:not(.btn-primary)",
  ".player-bottom",
  ".player-top > div",
  ".player-top .pbtn",
  ".upnext",
  ".resume-card",
  ".quality-pill",
  ".party-pill",
].join(",");

const NS = "http://www.w3.org/2000/svg";
const MAX_FILTERS = 28;
// the face of the glass is softly frosted (Clear's 3 px); its bezel is clear
const SOFT = 3;

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

// The map for one size: for every pixel, where the glass makes it look.
// Inside the bezel (the last `bezel` px before the edge) the view is pulled
// from further inside, more and more steeply towards the rim — a convex
// edge. Red = across, green = down, 128 = straight through.
// thick: how wide the bezel is (1 = the look's own; glass.css --rg-thick)
export function lensGeometry(w, h, radius, thick = 1) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const bezel = Math.max(5, Math.min(13 * thick, Math.min(w, h) * 0.2 * thick));
  return { r, bezel, depth: bezel * 1.35 };
}
export function lensMap(w, h, radius, put, res = 1, thick = 1) {
  const { r, bezel } = lensGeometry(w, h, radius, thick);
  for (let py = 0; py < h * res; py++) {
    for (let px = 0; px < w * res; px++) {
      const x = (px + 0.5) / res, y = (py + 0.5) / res;
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
      // a bevel: the rim shows, turned over, the band just inside it — the
      // flipped picture at the edge of a thick piece of glass. (A curved
      // profile has a spot where the picture stands still and smears into
      // streaks; a straight one does not.)
      const m = t;
      // blue: how much of the pixel is the bezel's (1 at the rim, 0 inside)
      const k = Math.min(1, t * 1.25);
      put(px, py, 128 - 127 * nx * m, 128 - 127 * ny * m, 255 * k * k * (3 - 2 * k));
    }
  }
}

// the look's two numbers, read once from the stylesheet (glass.css
// --rg-thick, --rg-spread) so the design lives in one place
const look = { thick: 1, spread: 0.09 };
const readLook = () => {
  try {
    const cs = getComputedStyle(document.documentElement);
    const n = (name, def, lo, hi) => { const v = parseFloat(cs.getPropertyValue(name)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
    look.thick = n("--rg-thick", 1, 0.5, 2);
    look.spread = n("--rg-spread", 0.09, 0, 0.3);
  } catch {}
};

let defs = null;
const filters = new Map(); // key -> { id, used }
let serial = 0;
let tick = 0;

const ensureDefs = () => {
  if (defs && defs.isConnected) return defs;
  defs = document.createElementNS(NS, "svg");
  defs.id = "rg-defs";
  defs.setAttribute("aria-hidden", "true");
  defs.setAttribute("width", "0");
  defs.setAttribute("height", "0");
  defs.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  // what a surface uses until its own map is ready: straight through
  const f = document.createElementNS(NS, "filter");
  f.id = "rg-0";
  const o = document.createElementNS(NS, "feGaussianBlur");
  o.setAttribute("in", "SourceGraphic");
  o.setAttribute("stdDeviation", String(SOFT));
  f.append(o);
  defs.append(f);
  document.body.append(defs);
  filters.clear();
  return defs;
};

const fe = (name, attrs) => {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

const ONLY = {
  r: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
  g: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0",
  b: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0",
};

const filterFor = (w, h, radius) => {
  const key = `${w}x${h}r${Math.round(radius)}`;
  const had = filters.get(key);
  if (had) { had.used = ++tick; return had.id; }
  const svg = ensureDefs();
  const c = document.createElement("canvas");
  // a small round button's map is drawn twice as fine: its whole face is
  // rim. A bar's is not: the map is decoded again whenever the bar is
  // painted anew (a tab lighting up), and a big one made the More menu's
  // first frame late on a slow phone.
  const res = w * h <= 6000 ? 2 : 1;
  c.width = w * res; c.height = h * res;
  const ctx = c.getContext("2d");
  if (!ctx) return "rg-0";
  const im = ctx.createImageData(w * res, h * res);
  lensMap(w, h, radius, (px, py, rr, gg, bb) => {
    const o = (py * w * res + px) * 4;
    im.data[o] = rr; im.data[o + 1] = gg; im.data[o + 2] = bb; im.data[o + 3] = 255;
  }, res, look.thick);
  ctx.putImageData(im, 0, 0);
  const id = `rg-${++serial}`;
  const { depth } = lensGeometry(w, h, radius, look.thick);
  // the fringe: red bends most, blue least (a tenth either way)
  const spread = look.spread;
  const f = fe("filter", { id, x: "0", y: "0", width: "100%", height: "100%", "color-interpolation-filters": "sRGB" });
  f.append(fe("feImage", { href: c.toDataURL("image/png"), x: "0", y: "0", width: String(w), height: String(h), preserveAspectRatio: "none", result: "map" }));
  // (the bezel's picture a touch soft: a mirror-sharp one reads as noise)
  f.append(fe("feGaussianBlur", { in: "SourceGraphic", stdDeviation: "0.7", result: "crisp" }));
  for (const [ch, k] of [["r", 1 + spread], ["g", 1], ["b", 1 - spread]]) {
    f.append(fe("feDisplacementMap", { in: "crisp", in2: "map", scale: String(Math.round(depth * 2 * k * 100) / 100), xChannelSelector: "R", yChannelSelector: "G", result: `d${ch}` }));
    f.append(fe("feColorMatrix", { in: `d${ch}`, type: "matrix", values: ONLY[ch], result: ch }));
  }
  f.append(fe("feBlend", { in: "r", in2: "g", mode: "screen", result: "rg" }));
  f.append(fe("feBlend", { in: "rg", in2: "b", mode: "screen", result: "bent" }));
  // the bezel catches more light than the face
  const lift = fe("feComponentTransfer", { in: "bent", result: "lit" });
  for (const ch of ["R", "G", "B"]) lift.append(fe(`feFunc${ch}`, { type: "linear", slope: "1.15", intercept: "0.015" }));
  f.append(lift);
  // the face: softly frosted; the bezel (the map's blue) laid over it
  f.append(fe("feGaussianBlur", { in: "SourceGraphic", stdDeviation: String(SOFT), result: "soft" }));
  f.append(fe("feColorMatrix", { in: "map", type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0", result: "mask" }));
  f.append(fe("feComposite", { in: "lit", in2: "mask", operator: "in", result: "rim" }));
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

const apply = (el) => {
  if (!el.isConnected) return;
  const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
  if (w < 28 || h < 28 || w * h > 1400 * 220) { el.style.removeProperty("--rg-lens"); return; }
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  const want = `url(#${filterFor(w, h, radius)})`;
  if (el.style.getPropertyValue("--rg-lens") !== want) el.style.setProperty("--rg-lens", want);
};

let started = false;
let on = false;

export function initGlassLens() {
  if (started || typeof document === "undefined") return;
  started = true;
  if (!lensSupported() || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
  const root = document.documentElement;
  const seen = new WeakSet();
  const dirty = new Set();
  let raf = 0;
  const flush = () => { raf = 0; const all = [...dirty]; dirty.clear(); if (on) for (const el of all) apply(el); };
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) dirty.add(e.target);
    if (!raf) raf = requestAnimationFrame(flush);
  });
  const scan = () => {
    if (!on) return;
    for (const el of document.querySelectorAll(SCOPE)) {
      if (seen.has(el)) continue;
      seen.add(el);
      ro.observe(el);
    }
  };
  let pending = 0;
  const later = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = 0; scan(); }, 80);
  };
  // (reduced transparency, and a TV's browser — where glass.css drops the
  // blur — get no lens either)
  const reduce = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-transparency: reduce), (hover: none) and (pointer: coarse) and (min-width: 1200px)") : null;
  const decide = () => {
    const want = root.dataset.look === "glass" && root.dataset.fx !== "lite" && !(reduce && reduce.matches);
    if (want === on) return;
    on = want;
    if (on) { readLook(); ensureDefs(); root.dataset.lens = "1"; scan(); for (const el of document.querySelectorAll(SCOPE)) apply(el); }
    else delete root.dataset.lens;
  };
  new MutationObserver(decide).observe(root, { attributes: true, attributeFilter: ["data-look", "data-fx"] });
  if (reduce && reduce.addEventListener) reduce.addEventListener("change", decide);
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
  decide();
}
