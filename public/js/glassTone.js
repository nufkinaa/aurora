// Glass that reads what is behind it.
//
// A glass surface is a light tint over a blur that also brightens — lovely
// over a dark scene, a pale smear under pale text over a bright one (a snowy
// frame behind the party panel, a white poster under the nav). Instead of
// one fixed tint for every backdrop, each surface carries a dark layer UNDER
// its sheen whose strength follows the brightness behind it: none over a
// dark picture, strong over a bright one, sliding between the two. The text
// stays the same light text; what changes is the floor under its contrast.
//
// The brightness is measured, not guessed: the picture behind (a video
// frame, a hero backdrop) is drawn to a tiny canvas and the region under the
// surface averaged. The result is the --g-under custom property (0–1) on
// the element; glass.css turns it into the layer and animates the change.
const W = 48;
const H = 27;
let canvas = null;
let ctx = null;
const context = () => {
  if (!ctx) {
    canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  return ctx;
};

// Brightness → how strong the dark layer should be. Dark scenes get none;
// from mid-grey up it grows, to a firm floor over white.
export const underFor = (luma, { min = 0, max = 0.72 } = {}) => {
  if (luma == null || Number.isNaN(luma)) return null;
  const v = (luma - 0.22) * 1.25;
  return Math.round(Math.max(min, Math.min(max, v)) * 100) / 100;
};

// Mean brightness (0–1) of a region of the canvas, in canvas fractions.
const regionLuma = (c, { x, y, w, h }) => {
  const px = Math.max(0, Math.min(W - 1, Math.floor(x * W)));
  const py = Math.max(0, Math.min(H - 1, Math.floor(y * H)));
  const pw = Math.max(1, Math.min(W - px, Math.ceil(w * W)));
  const ph = Math.max(1, Math.min(H - py, Math.ceil(h * H)));
  const d = c.getImageData(px, py, pw, ph).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / (d.length / 4) / 255;
};

// Draw `source` (a <video> or <img>) the way it is shown inside a box of
// boxW×boxH — "contain" (letterboxed, a player) or "cover" (a hero).
const paint = (source, srcW, srcH, boxW, boxH, fit) => {
  const c = context();
  c.fillStyle = "#000";
  c.fillRect(0, 0, W, H);
  if (!srcW || !srcH || !boxW || !boxH) return false;
  const scale = fit === "cover" ? Math.max(boxW / srcW, boxH / srcH) : Math.min(boxW / srcW, boxH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const dx = (boxW - dw) / 2;
  const dy = fit === "cover" ? 0 : (boxH - dh) / 2; // heroes anchor their art to the top
  c.drawImage(source, (dx / boxW) * W, (dy / boxH) * H, (dw / boxW) * W, (dh / boxH) * H);
  return true;
};

const setUnder = (node, value) => {
  if (value == null) node.style.removeProperty("--g-under");
  else node.style.setProperty("--g-under", String(value));
};

// ---- a video behind floating controls (the player) ----
// Every `everyMs` while `active()` says the controls are showing, each
// element matched by `selector` inside `box` gets the brightness of the
// frame under it. Returns the stop function.
export const followVideo = (video, box, selector, { everyMs = 700, active = () => true, floors = {} } = {}) => {
  let dead = false;
  let broken = false;
  let seen = false; // the box has been on the page at least once
  const tick = () => {
    if (box.isConnected) seen = true;
    else if (seen) { dead = true; clearInterval(timer); return; } // the player closed
    if (dead || broken || document.hidden || !active()) return;
    const targets = box.querySelectorAll(selector);
    if (!targets.length) return;
    const b = box.getBoundingClientRect();
    if (!b.width || !b.height) return;
    try {
      if (!paint(video, video.videoWidth, video.videoHeight, b.width, b.height, "contain")) return;
      const c = context();
      for (const node of targets) {
        const r = node.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const luma = regionLuma(c, { x: (r.left - b.left) / b.width, y: (r.top - b.top) / b.height, w: r.width / b.width, h: r.height / b.height });
        const floor = Object.entries(floors).find(([cls]) => node.classList.contains(cls));
        setUnder(node, underFor(luma, { min: floor ? floor[1] : 0 }));
      }
    } catch {
      // a frame the canvas may not read (a cross-origin stream): stop asking,
      // and leave every surface on a safe middle tint
      broken = true;
      for (const node of targets) setUnder(node, 0.5);
    }
  };
  const timer = setInterval(tick, everyMs);
  tick();
  return () => {
    dead = true;
    clearInterval(timer);
  };
};

// ---- a still picture behind the nav (Home's hero, a title's backdrop) ----
// The top band of the picture decides the nav's tint while the page is at
// the top; scrolled into the rows it goes back to plain glass.
const NAV_SELECTOR = ".nav-items, .nav-logo, .nav-profile, .nav-gear, .nav-dl";
let navUnder = null;
let navToken = 0;
const applyNav = () => {
  const on = navUnder != null && (window.scrollY || 0) < window.innerHeight * 0.35;
  for (const node of document.querySelectorAll(NAV_SELECTOR)) setUnder(node, on ? navUnder : null);
};
export const toneNavFromImage = (url) => {
  const token = ++navToken;
  if (!url) {
    navUnder = null;
    return applyNav();
  }
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    if (token !== navToken) return;
    try {
      // the hero is as wide as the window and its art covers it from the top
      if (!paint(img, img.naturalWidth, img.naturalHeight, window.innerWidth, Math.max(window.innerHeight * 0.7, 320), "cover")) return;
      navUnder = underFor(regionLuma(context(), { x: 0, y: 0, w: 1, h: 0.2 }));
    } catch {
      navUnder = null;
    }
    applyNav();
  };
  img.onerror = () => {};
  img.src = url;
};
export const clearNavTone = () => toneNavFromImage(null);

if (typeof window !== "undefined") {
  let raf = 0;
  window.addEventListener("scroll", () => {
    if (raf || navUnder == null) return;
    raf = setTimeout(() => { raf = 0; applyNav(); }, 120);
  }, { passive: true });
  // leaving a screen leaves its picture: the next one sets its own
  window.addEventListener("hashchange", clearNavTone);
}
