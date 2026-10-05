// The nav's words read what is behind them.
//
// The glass nav floats over everything — a dark sky, a white poster, a bright
// frame of a trailer — and its glass is thin enough that what is behind shows
// through. White text is right over most of it and wrong over the rest. So
// each button (every tab, the logo, the gear, the profile) is given the
// brightness of what sits under IT, and flips between light and dark text on
// its own, with a fade (glass.css: [data-tone="light"]) — the way the system
// tab bar does on a phone.
//
// "What is behind" is read from the page itself: at a few points under each
// button the elements beneath are walked top-down, and the first one that is
// a picture (an <img>, a video frame, a CSS background image) or an opaque
// colour answers. Pictures are sampled from a 24px copy kept per image.
// Nothing here can read pixels the browser will not hand over (a cross-origin
// picture without permission): those are skipped and the next thing down
// answers — at worst, the dark page, which is white text, the old behaviour.
const SIZE = 24;
const TARGETS = ".nav-item, .nav-logo, .nav-profile, .nav-dl";
// hysteresis: goes dark-on-light above GO, back below BACK — no flicker at the edge
const GO = 0.6;
const BACK = 0.48;

const thumbs = new WeakMap(); // element → { key, data } | { key, data: null }
const urls = new Map(); // background url → { data } | "loading" | null
let scratch = null;

const grab = (source, w, h) => {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = SIZE;
    scratch.height = SIZE;
  }
  const c = scratch.getContext("2d", { willReadFrequently: true });
  try {
    c.clearRect(0, 0, SIZE, SIZE);
    c.drawImage(source, 0, 0, w, h, 0, 0, SIZE, SIZE);
    return c.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    return null; // not ours to read
  }
};

// Brightness (0–1) at fraction (u, v) of a sampled picture, or null off it.
const at = (data, u, v) => {
  if (!data || u < 0 || u > 1 || v < 0 || v > 1) return null;
  const x = Math.min(SIZE - 1, Math.floor(u * SIZE));
  const y = Math.min(SIZE - 1, Math.floor(v * SIZE));
  const i = (y * SIZE + x) * 4;
  if (data[i + 3] < 128) return null;
  return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
};

const pct = (s, fallback = 0.5) => {
  if (s == null) return fallback;
  if (s === "left" || s === "top") return 0;
  if (s === "right" || s === "bottom") return 1;
  if (s === "center") return 0.5;
  const n = parseFloat(s);
  return Number.isFinite(n) && String(s).includes("%") ? n / 100 : fallback;
};

// Where (x, y) on screen falls inside a picture of nw×nh drawn into `box`
// with object-fit / background-size `fit` and position (px, py).
const mapInto = (x, y, box, nw, nh, fit, px, py) => {
  if (!nw || !nh || !box.width || !box.height) return null;
  const scale =
    fit === "contain" ? Math.min(box.width / nw, box.height / nh)
    : fit === "fill" || fit === "100% 100%" ? null
    : Math.max(box.width / nw, box.height / nh); // cover (and the default for a hero)
  if (scale == null) return [(x - box.left) / box.width, (y - box.top) / box.height];
  const dw = nw * scale;
  const dh = nh * scale;
  const ox = box.left + (box.width - dw) * px;
  const oy = box.top + (box.height - dh) * py;
  return [(x - ox) / dw, (y - oy) / dh];
};

// A CSS colour → { l: brightness 0–1, a: alpha }, or null when it is not one
// this can read (a named colour, color-mix…).
const parseColor = (css) => {
  const t = String(css || "").trim();
  if (t === "transparent") return { l: 0, a: 0 };
  const m = /^rgba?\(([^)]+)\)$/.exec(t);
  if (!m) return null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some(Number.isNaN)) return null;
  return { l: (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255, a: p.length > 3 ? p[3] : 1 };
};

// "a, b(c, d), e" → ["a", "b(c, d)", "e"]
const splitTop = (str) => {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of str) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

// A fade laid over a picture — the scrim under a hero's words, the shade on a
// card — changes what is behind the nav as much as the picture does: a bright
// frame under a 90% black fade is a dark place. Straight linear fades (the
// only kind this app draws over art) are read here: colour and alpha at the
// point, to be laid over whatever is beneath. Anything else returns null and
// is treated as not there.
const gradients = new Map();
const parseGradient = (g) => {
  if (gradients.has(g)) return gradients.get(g);
  let out = null;
  const m = /^linear-gradient\((.*)\)$/s.exec(g);
  if (m) {
    const parts = splitTop(m[1]);
    let dir = "bottom";
    const first = parts[0] || "";
    if (/^to\s/.test(first)) {
      dir = /top/.test(first) ? "top" : /left/.test(first) ? "left" : /right/.test(first) ? "right" : "bottom";
      parts.shift();
    } else if (/deg$/.test(first)) {
      const d = ((parseFloat(first) % 360) + 360) % 360;
      dir = d < 45 || d >= 315 ? "top" : d < 135 ? "right" : d < 225 ? "bottom" : "left";
      parts.shift();
    }
    const stops = [];
    for (const part of parts) {
      const pm = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(part);
      const c = pm && parseColor(pm[1]);
      if (!c) { stops.length = 0; break; }
      stops.push({ ...c, at: pm[2] != null ? parseFloat(pm[2]) / 100 : null });
    }
    if (stops.length >= 2) {
      // unplaced stops spread evenly between their placed neighbours
      if (stops[0].at == null) stops[0].at = 0;
      if (stops[stops.length - 1].at == null) stops[stops.length - 1].at = 1;
      for (let a = 0; a < stops.length; a++) {
        if (stops[a].at != null) continue;
        let b = a;
        while (stops[b].at == null) b++;
        const from = stops[a - 1].at;
        for (let k = a; k < b; k++) stops[k].at = from + ((stops[b].at - from) * (k - a + 1)) / (b - a + 1);
      }
      out = { dir, stops };
    }
  }
  if (gradients.size > 200) gradients.clear();
  gradients.set(g, out);
  return out;
};
const gradientAt = (grad, u, v) => {
  const t = grad.dir === "bottom" ? v : grad.dir === "top" ? 1 - v : grad.dir === "right" ? u : 1 - u;
  const st = grad.stops;
  if (t <= st[0].at) return st[0];
  for (let k = 1; k < st.length; k++) {
    if (t <= st[k].at) {
      const span = st[k].at - st[k - 1].at || 1;
      const f = (t - st[k - 1].at) / span;
      const a = st[k - 1].a + (st[k].a - st[k - 1].a) * f;
      // a fade to "transparent" keeps the colour of its opaque end
      const l = st[k - 1].a === 0 ? st[k].l : st[k].a === 0 ? st[k - 1].l : st[k - 1].l + (st[k].l - st[k - 1].l) * f;
      return { l, a };
    }
  }
  return st[st.length - 1];
};

let again = null; // set by start(): re-measure once a background picture has loaded

const fromUrl = (url, x, y, box, size, position) => {
  let hit = urls.get(url);
  if (hit === undefined) {
    urls.set(url, "loading");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      const data = grab(img, img.naturalWidth, img.naturalHeight);
      urls.set(url, data ? { data, w: img.naturalWidth, h: img.naturalHeight } : null);
      if (urls.size > 60) urls.delete(urls.keys().next().value);
      if (again) again();
    };
    img.onerror = () => urls.set(url, null);
    img.src = url;
    return null;
  }
  if (!hit || hit === "loading") return null;
  const [px, py] = String(position || "50% 50%").split(/\s+/);
  const uv = mapInto(x, y, box, hit.w, hit.h, size === "contain" ? "contain" : size === "100% 100%" ? "fill" : "cover", pct(px), pct(py));
  return uv ? at(hit.data, uv[0], uv[1]) : null;
};

// What one element puts at (x, y), top layer first: a list of { l, a } —
// a = 1 is something solid (a picture, an opaque colour), less is a veil.
const layersOf = (el, x, y) => {
  const out = [];
  const tag = el.tagName;
  const box = el.getBoundingClientRect();
  if (!box.width || !box.height) return out;
  if (tag === "CANVAS" || tag === "IFRAME") return out;
  const own = getComputedStyle(el);
  const op = parseFloat(own.opacity);
  if (op < 0.08 || own.visibility === "hidden") return out;
  if (tag === "IMG" || tag === "VIDEO") {
    const nw = tag === "IMG" ? el.naturalWidth : el.videoWidth;
    const nh = tag === "IMG" ? el.naturalHeight : el.videoHeight;
    if (!nw || (tag === "IMG" && !el.complete) || (tag === "VIDEO" && el.readyState < 2)) return out;
    const key = tag === "IMG" ? el.currentSrc || el.src : null;
    let t = thumbs.get(el);
    // a still is sampled once; a video frame every time
    if (!t || t.key !== key || tag === "VIDEO") {
      t = { key, data: grab(el, nw, nh) };
      thumbs.set(el, t);
    }
    const [px, py] = String(own.objectPosition || "50% 50%").split(/\s+/);
    const uv = mapInto(x, y, box, nw, nh, own.objectFit === "contain" ? "contain" : own.objectFit === "fill" ? "fill" : "cover", pct(px), pct(py));
    const l = uv ? at(t.data, uv[0], uv[1]) : null;
    if (l != null) out.push({ l, a: op });
    return out;
  }
  const u = (x - box.left) / box.width;
  const v = (y - box.top) / box.height;
  // ::after sits over the element's own background, ::before under ::after
  for (const pseudo of ["::after", null, "::before"]) {
    const cs = pseudo ? getComputedStyle(el, pseudo) : own;
    if (pseudo && (cs.content === "none" || cs.content === "normal" || cs.display === "none")) continue;
    const mine = [];
    if (cs.backgroundImage && cs.backgroundImage !== "none") {
      for (const layer of splitTop(cs.backgroundImage)) {
        const um = /^url\(["']?([^"')]+)["']?\)$/.exec(layer);
        if (um) {
          const l = fromUrl(um[1], x, y, box, cs.backgroundSize.split(",")[0].trim(), cs.backgroundPosition.split(",")[0].trim());
          if (l != null) mine.push({ l, a: 1 });
        } else {
          const g = parseGradient(layer);
          if (g) {
            const c = gradientAt(g, u, v);
            if (c.a > 0.02) mine.push(c);
          }
        }
      }
    }
    const c = parseColor(cs.backgroundColor);
    if (c && c.a > 0.02) mine.push(c);
    for (const m of mine) out.push({ l: m.l, a: m.a * (pseudo ? parseFloat(cs.opacity) || 1 : 1) * op });
  }
  return out;
};

const behind = (x, y, skip) => {
  const veils = [];
  let base = 0.04; // the page itself: a night sky
  let cover = 0; // how much of the base is already hidden
  for (const el of document.elementsFromPoint(x, y)) {
    if (skip(el)) continue;
    for (const layer of layersOf(el, x, y)) {
      veils.push(layer);
      cover = cover + (1 - cover) * layer.a;
    }
    if (cover > 0.97) break;
  }
  // composite bottom-up
  let l = base;
  for (let k = veils.length - 1; k >= 0; k--) l = l * (1 - veils[k].a) + veils[k].l * veils[k].a;
  return l;
};

export const startNavTone = () => {
  const nav = document.getElementById("nav");
  if (!nav) return () => {};
  const skip = (el) => nav.contains(el) || el.id === "toasts" || (el.closest && !!el.closest("#toasts, #offline-banner"));
  const measure = () => {
    if (document.hidden) return;
    const glass = document.documentElement.dataset.look === "glass";
    const off = !glass || !!document.querySelector(".player");
    for (const b of nav.querySelectorAll(TARGETS)) {
      if (off) { if (b.dataset.tone) delete b.dataset.tone; continue; }
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const y = r.top + r.height / 2;
      const xs = r.width > 60 ? [0.25, 0.5, 0.75] : [0.5];
      let sum = 0;
      for (const f of xs) sum += behind(r.left + r.width * f, y, skip);
      const l = sum / xs.length;
      const light = b.dataset.tone === "light";
      const next = light ? l > BACK : l > GO;
      if (next !== light) {
        if (next) b.dataset.tone = "light";
        else delete b.dataset.tone;
      }
    }
  };
  let timer = 0;
  const soon = (ms = 90) => {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; measure(); }, ms);
  };
  again = () => soon(30);
  const onScroll = () => soon(90);
  const onRoute = () => { soon(60); setTimeout(measure, 500); setTimeout(measure, 1400); };
  // pictures arriving change what is behind (load does not bubble: capture)
  const onLoad = (e) => { if (e.target && (e.target.tagName === "IMG" || e.target.tagName === "VIDEO")) soon(120); };
  // capture: a shelf sliding sideways under the phone's tab bar scrolls too
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("resize", onScroll);
  window.addEventListener("hashchange", onRoute);
  window.addEventListener("aurora-look", onRoute);
  document.addEventListener("load", onLoad, true);
  // Home's billboard changes its picture on a timer, rows slide sideways under
  // the phone's tab bar: a slow heartbeat catches what no event announces
  const beat = setInterval(measure, 1200);
  onRoute();
  return () => {
    clearInterval(beat);
    clearTimeout(timer);
    again = null;
    document.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("resize", onScroll);
    window.removeEventListener("hashchange", onRoute);
    window.removeEventListener("aurora-look", onRoute);
    document.removeEventListener("load", onLoad, true);
  };
};
