// Aurora borealis for the nav's empty stretch, matched to elia's reference
// footage (an Iceland timelapse): flowing BANDS of saturated green — bright
// core, soft feathered edges, a diffuse veil hanging below, thickness and
// length that swell and taper, curls that come and go. One to three bands
// share the sky, each on its own randomized schedule, so no two sessions
// (or minutes) look alike.
//
// Cost discipline: painted at half resolution (~300×34) and browser-upscaled
// for the glow, capped at 30fps, and the loop runs ONLY while the lights are
// visible (nav solid, tab in front) — a MutationObserver on the nav's class
// starts/stops it. Reduced motion gets a single still frame. No assets.
// Height of the cross-section bitmap. Deliberately CLOSE to the height a
// column actually gets drawn at (~15-45 device px): canvas2d downscaling is
// bilinear, so squashing a 64px ramp into a 20px column threw away the soft
// top fringe and left a hard, stair-stepped edge — the "pixelation" that
// survived every resolution increase, because resolution was never the
// problem. At 24 the ramp is a mild up/down scale either way, which
// interpolates cleanly.
const RAMP_H = 24;

// One 1px-wide vertical color ramp per band (its cross-section, top→bottom).
// Columns are drawn by scaling this strip with drawImage, so no gradient
// objects are allocated per frame.
const makeRamp = (stops) => {
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = RAMP_H;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, RAMP_H);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1, RAMP_H);
  return c;
};

const rand = (a, b) => a + Math.random() * (b - a);

// Cross-section: a short blue-green fringe ABOVE the bright core and a
// LONG diffuse veil below it — asymmetric like the reference (the glow
// hangs under the band, it doesn't halo evenly). Core sits at 36% of the
// section; the draw offset below keeps it on the centerline.
const CORE_AT = 0.36;
const makeBandRamp = (strength) =>
  makeRamp([
    [0, "rgba(120, 160, 255, 0)"],
    [0.1, `rgba(110, 160, 255, ${0.08 * strength})`],
    [0.24, `rgba(60, 235, 150, ${0.42 * strength})`],
    [CORE_AT, `rgba(140, 255, 190, ${0.9 * strength})`], // the bright core
    [0.55, `rgba(60, 225, 150, ${0.5 * strength})`],
    [0.78, `rgba(35, 180, 130, ${0.26 * strength})`], // the long veil
    [1, "rgba(20, 150, 115, 0)"],
  ]);

// Each band gets its own random personality at page load. The HERO band
// never fades out and keeps a healthy minimum thickness/brightness — the
// sky always has one aurora at decent intensity; the other two come and
// go freely (so the count reads as 1–3).
const makeBand = (hero = false) => ({
  hero,
  ramp: makeBandRamp(hero ? rand(0.95, 1.1) : rand(0.8, 1.05)),
  speed: rand(0.24, 0.4) * (Math.random() < 0.5 ? -1 : 1),
  meander: rand(0.0026, 0.0044), // centerline wander frequency
  mAmp: rand(0.24, 0.32), // deeper slalom
  curlF: rand(0.008, 0.013), // the tighter random curls
  thick: rand(0.55, 0.8), // of the strip's height
  sMin: hero ? 0.72 : 0.6, // thickness-swell floor
  sVar: hero ? 0.28 : 0.4,
  yOff: rand(-0.06, 0.06),
  phase: rand(0, Math.PI * 2),
  presF: rand(0.045, 0.085), // how often it appears/disappears
  presOff: rand(0, Math.PI * 2),
  lenF: rand(0.03, 0.06), // how its span drifts and stretches
  lenOff: rand(0, Math.PI * 2),
  alpha: hero ? rand(1.6, 1.9) : rand(1.4, 1.8),
});

export const initAurora = (canvas) => {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const nav = canvas.closest(".nav");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");

  const BANDS = [makeBand(true), makeBand(), makeBand()];

  let raf = null;
  let last = 0;
  // RESOLUTION + GLOW, and why they are two separate jobs.
  //
  // v1 painted at half size and let the browser upscale: the upscale WAS the
  // glow, but it also read as stair-stepped edges on a sharp screen. v2 went
  // to device pixels and asked CSS for a 0.5px blur — which traded one
  // artifact for a worse one, because the columns overlapped by 0.7px and
  // every seam got composited TWICE, laying a faint vertical comb under the
  // band that the blur then smeared into a "weird filter" look.
  //
  // v3 added a real Gaussian on top — and that was the "weird filter" look:
  // once the painter runs at device resolution the glow is ALREADY in the
  // cross-section (measured: a column fades 0→190 alpha over ~8 rows), so any
  // extra blur is just smear over an image that was already soft where it
  // should be soft and crisp where it should be crisp. v4 paints sharp and
  // adds nothing: the ramp is the glow.
  let ss = 1; // device-pixel scale of the backing store
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const size = () => {
    ss = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * ss));
    const h = Math.max(1, Math.round(canvas.clientHeight * ss));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  const paint = (t, still = false) => {
    size();
    const W = canvas.width;                                   // backing px (columns)
    const H = canvas.height;                                  // backing px
    const cw = Math.max(1, canvas.clientWidth);               // CSS px — the wave math's unit
    ctx.clearRect(0, 0, W, H);
    for (let bi = 0; bi < BANDS.length; bi++) {
      const b = BANDS[bi];
      // Presence: each band fades in, lives a while, fades away on its own
      // slow clock — the hero band never drops below a healthy glow, so the
      // sky always holds at least one real aurora (elia: 1–3, one decent).
      let presence = Math.min(
        1,
        Math.max(0, 1.6 * Math.sin(t * b.presF + b.presOff) + 0.35),
      );
      if (b.hero) presence = Math.max(presence, 0.85);
      if (still && b.hero) presence = 1;
      if (presence < 0.04) continue;

      // Dynamic span: the band's center and length both drift, so it
      // stretches across the sky, shrinks to a short arc, wanders sideways.
      const center = cw * (0.5 + 0.26 * Math.sin(t * b.lenF + b.lenOff));
      // longer by default — from a generous arc up to a full sky-crosser
      const halfLen =
        cw * (0.5 + 0.2 * Math.sin(t * b.lenF * 0.73 + b.lenOff * 1.9));

      const s = t * b.speed;
      // Curls flare up and die down over time — the tight kinks real bands
      // throw when they're active.
      const curlAmp =
        0.12 * Math.max(0, Math.sin(t * 0.19 + b.phase * 2.3));

      // ONE COLUMN PER DEVICE PIXEL. Looping CSS pixels and placing them at
      // round(cx * dpr) looked fine at dpr 1 and drew a literal barcode at
      // 1.25 or 1.5 (Windows display scaling): fractional spacing with an
      // integral width leaves every fourth device pixel unpainted. Iterating
      // the backing store instead means every column is exactly one pixel
      // wide on an integer boundary — no gaps, no overlap, at any dpr.
      for (let x = 0; x < W; x++) {
        const cx = x / ss; // back to CSS px, which is what the waves are tuned in
        const u = (cx - center) / halfLen;
        if (u < -1 || u > 1) continue;
        // The dome shades the band toward its ends — but sqrt alone has
        // infinite slope AT the tips, so the last columns fell off a cliff
        // and every band ended on a clean vertical cut. A smoothstep feather
        // over the outer 15% takes the tail to zero with zero slope; the
        // middle 85% is untouched, so the approved look stays identical.
        const dome = Math.sqrt(1 - u * u);
        const a = Math.abs(u);
        let feather = 1;
        if (a > 0.85) {
          const t = (1 - a) / 0.15;
          feather = t * t * (3 - 2 * t);
        }
        const endTaper = dome * feather;

        // Centerline: slow meander (phase itself waved, so arcs never
        // repeat) + the occasional tighter curl riding on top.
        const yC =
          H *
          (0.5 +
            b.yOff +
            b.mAmp *
              Math.sin(
                cx * b.meander + s * 0.9 + b.phase + 2.6 * Math.sin(cx * b.meander * 0.31 + s * 0.3),
              ) +
            curlAmp * Math.sin(cx * b.curlF + s * 1.6 + b.phase * 3));

        const swell = b.sMin + b.sVar * Math.sin(cx * 0.0017 + s * 0.7 + b.phase * 1.6);
        // ends PINCH (real bands thin out) instead of stopping at half height
        const th = H * b.thick * swell * (0.3 + 0.7 * endTaper);
        if (th < 1) continue;

        const flow = 0.7 + 0.3 * Math.sin(cx * 0.0023 + s + b.phase);
        const streak = 0.9 + 0.1 * Math.sin(cx * 0.05 + s * 1.8);
        const bright = flow * swell * streak * endTaper * presence;
        if (bright < 0.02) continue;
        // the visibility floor dies with the feather, or it re-draws the cut
        ctx.globalAlpha = Math.min(1, Math.pow(bright, 1.25) * b.alpha + 0.03 * feather);
        // asymmetric: the core rides the centerline, the long veil below
        // exactly one device pixel wide, on an integer boundary: adjacent
        // columns tile instead of overlapping, so nothing composites twice
        ctx.drawImage(b.ramp, 0, 0, 1, RAMP_H, x, yC - th * CORE_AT, 1, th);
      }
    }
    ctx.globalAlpha = 1;
  };

  const visible = () => nav.classList.contains("solid") && !document.hidden;
  const loop = (now) => {
    raf = null;
    if (!visible() || calm.matches) return;
    if (now - last >= 33) {
      // ~30fps is plenty for something this slow
      last = now;
      paint(now / 1000);
    }
    raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    if (!visible()) return; // opacity fade hides the last frame anyway
    if (calm.matches) {
      paint(4, true); // one still frame, at least one band guaranteed
      return;
    }
    if (raf == null) raf = requestAnimationFrame(loop);
  };
  new MutationObserver(kick).observe(nav, {
    attributes: true,
    attributeFilter: ["class"],
  });
  document.addEventListener("visibilitychange", kick);
  window.addEventListener("resize", kick);
  kick();
};
