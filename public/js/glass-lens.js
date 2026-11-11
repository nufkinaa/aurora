// Glass version C ("Liquid") — the refraction at the rim, Chromium only.
// Review only: index.html loads this when ?glass=c chose version C
// (docs/qa/glass-options/README.md). Nothing imports it.
//
// What it does: each glass surface that floats over pictures (the bars, the
// round buttons, the buttons on a title, a menu, a toast) gets an SVG filter
// put in front of its backdrop blur — a displacement map that pulls what is
// behind the rim from further inside, the way the curved edge of a thick
// pane bends the light. The map has to be drawn at the surface's own size,
// so a ResizeObserver redraws it when the surface changes size (maps of the
// same size and radius are shared).
//
// Only Chromium draws an SVG filter in a backdrop-filter. Safari ignores it
// AND drops the whole backdrop filter it sits in (WebKit bugs 245510,
// 317059), Firefox ignores it — so the filter is added only where
// navigator.userAgentData says Chromium, and never with reduced
// transparency, a weak device (data-fx="lite") or a TV's browser.
//
// Also: on a desktop, the light on the nav island follows the pointer —
// --g-mx / --g-my set on the island alone (glass-opt-c.css draws it).
const root = document.documentElement;
const chromium = !!(navigator.userAgentData && navigator.userAgentData.brands &&
  navigator.userAgentData.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand)));
const calm = () =>
  root.dataset.fx === "lite" ||
  matchMedia("(prefers-reduced-transparency: reduce), (hover: none) and (pointer: coarse) and (min-width: 1200px)").matches;

const TARGETS = [
  ".nav-items", ".nav-logo", ".nav-profile", ".nav-gear", ".nav-dl",
  ".toast", ".nav-menu",
  ".hero-actions .btn:not(.btn-primary)", ".detail-actions .btn:not(.btn-primary)",
].join(",");

const NS = "http://www.w3.org/2000/svg";
let defs = null;
const filters = new Map(); // "w×h×r" -> filter id
let n = 0;

// The map: red = how far to look sideways, green = up or down (128 = not at
// all). Inside a band along the rim (zone) the pull grows toward the edge
// like the slope of a rounded bezel (a quarter circle: flat inside, steep
// at the very edge).
const drawMap = (w, h, rad, zone) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  const im = x.createImageData(w, h);
  const d8 = im.data;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const fx = px + 0.5, fy = py + 0.5;
      const cx = Math.min(Math.max(fx, rad), w - rad), cy = Math.min(Math.max(fy, rad), h - rad);
      let nx = fx - cx, ny = fy - cy, d;
      const len = Math.hypot(nx, ny);
      if (len > 1e-6) { d = rad - len; nx /= len; ny /= len; }
      else {
        const dl = fx, dr = w - fx, dt = fy, db = h - fy;
        d = Math.min(dl, dr, dt, db);
        nx = d === dl ? -1 : d === dr ? 1 : 0;
        ny = nx ? 0 : d === dt ? -1 : 1;
      }
      const u = d >= zone ? 0 : 1 - Math.max(0, d) / zone;
      const t = 1 - Math.sqrt(Math.max(0, 1 - u * u));
      const o = (py * w + px) * 4;
      d8[o] = Math.round(128 - 127 * nx * t);
      d8[o + 1] = Math.round(128 - 127 * ny * t);
      d8[o + 2] = 128;
      d8[o + 3] = 255;
    }
  }
  x.putImageData(im, 0, 0);
  return c.toDataURL("image/png");
};

const filterFor = (w, h, rad) => {
  const key = `${w}x${h}x${rad}`;
  if (filters.has(key)) return filters.get(key);
  if (!defs) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    defs = document.createElementNS(NS, "defs");
    svg.append(defs);
    document.body.append(svg);
  }
  const zone = Math.max(6, Math.min(h / 2, w / 2, 22));
  const id = `glass-lens-${++n}`;
  const f = document.createElementNS(NS, "filter");
  f.id = id;
  for (const [k, v] of Object.entries({ x: "0", y: "0", width: "100%", height: "100%", "color-interpolation-filters": "sRGB" })) f.setAttribute(k, v);
  const img = document.createElementNS(NS, "feImage");
  for (const [k, v] of Object.entries({ href: drawMap(w, h, rad, zone), x: "0", y: "0", width: String(w), height: String(h), preserveAspectRatio: "none", result: "map" })) img.setAttribute(k, v);
  const dm = document.createElementNS(NS, "feDisplacementMap");
  for (const [k, v] of Object.entries({ in: "SourceGraphic", in2: "map", scale: String(Math.round(zone * 1.6)), xChannelSelector: "R", yChannelSelector: "G" })) dm.setAttribute(k, v);
  f.append(img, dm);
  defs.append(f);
  filters.set(key, id);
  return id;
};

const fit = (el) => {
  const r = el.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  if (w < 12 || h < 12 || w > 1600 || h > 900) return;
  if (el.__glBase == null) el.__glBase = getComputedStyle(el).getPropertyValue("--g-blur").trim();
  if (!el.__glBase || calm()) { el.style.removeProperty("--g-blur"); return; }
  const rad = Math.round(Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, h / 2, w / 2));
  el.style.setProperty("--g-blur", `url(#${filterFor(w, h, rad)}) ${el.__glBase}`);
};

const ro = new ResizeObserver((entries) => { for (const e of entries) fit(e.target); });
const seen = new WeakSet();
let queued = false;
const scan = () => {
  queued = false;
  for (const el of document.querySelectorAll(TARGETS)) {
    if (seen.has(el)) continue;
    seen.add(el);
    ro.observe(el);
  }
};
const queue = () => { if (!queued) { queued = true; requestAnimationFrame(scan); } };

// the pointer's light on the island (desktop): one element restyles
const island = () => document.querySelector(".nav-items");
const onMove = (e) => {
  const el = island();
  if (!el) return;
  const r = el.getBoundingClientRect();
  const mx = ((e.clientX - r.left) / Math.max(1, r.width)) * 100;
  const my = ((e.clientY - r.top) / Math.max(1, r.height)) * 100;
  el.style.setProperty("--g-mx", `${Math.max(-10, Math.min(110, mx)).toFixed(1)}%`);
  el.style.setProperty("--g-my", `${Math.max(-40, Math.min(140, my)).toFixed(1)}%`);
};
let moveQueued = null;

const start = () => {
  if (root.dataset.glass !== "c") return;
  if (chromium) {
    scan();
    new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
  }
  if (matchMedia("(hover: hover) and (pointer: fine)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    addEventListener("pointermove", (e) => {
      if (moveQueued) { moveQueued = e; return; }
      moveQueued = e;
      requestAnimationFrame(() => { const ev = moveQueued; moveQueued = null; onMove(ev); });
    }, { passive: true });
  }
};
if (document.body) start();
else addEventListener("DOMContentLoaded", start, { once: true });
