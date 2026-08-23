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
const RAMP_H = 64;

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

// Cross-section: faint blue whisper above, bright core just above the
// middle, then a LONG diffuse green veil below — the reference's bands have
// real body under the core, not a hard edge.
const makeBandRamp = (strength) =>
  makeRamp([
    [0, "rgba(120, 160, 255, 0)"],
    [0.12, `rgba(110, 160, 255, ${0.08 * strength})`],
    [0.3, `rgba(60, 235, 150, ${0.4 * strength})`],
    [0.44, `rgba(140, 255, 190, ${0.9 * strength})`], // the bright core
    [0.62, `rgba(60, 225, 150, ${0.5 * strength})`],
    [0.82, `rgba(35, 180, 130, ${0.24 * strength})`], // the veil below
    [1, "rgba(20, 150, 115, 0)"],
  ]);

// Each band gets its own random personality at page load.
const makeBand = () => ({
  ramp: makeBandRamp(rand(0.8, 1.05)),
  speed: rand(0.24, 0.4) * (Math.random() < 0.5 ? -1 : 1),
  meander: rand(0.0022, 0.0038), // centerline wander frequency
  mAmp: rand(0.18, 0.28),
  curlF: rand(0.008, 0.013), // the tighter random curls
  thick: rand(0.55, 0.8), // of the strip's height
  yOff: rand(-0.08, 0.08),
  phase: rand(0, Math.PI * 2),
  presF: rand(0.045, 0.085), // how often it appears/disappears
  presOff: rand(0, Math.PI * 2),
  lenF: rand(0.03, 0.06), // how its span drifts and stretches
  lenOff: rand(0, Math.PI * 2),
  alpha: rand(1.4, 1.8), // compensates the stack of ≤1 envelopes below
});

export const initAurora = (canvas) => {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const nav = canvas.closest(".nav");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");

  const BANDS = [makeBand(), makeBand(), makeBand()];

  let raf = null;
  let last = 0;
  // Half resolution: enough interpolation to glow, crisp enough to read as
  // light rather than blur (1/3 looked low-res per elia).
  const DOWN = 2;
  const size = () => {
    const w = Math.max(1, Math.round(canvas.clientWidth / DOWN));
    const h = Math.max(1, Math.round(canvas.clientHeight / DOWN));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  const paint = (t, still = false) => {
    size();
    const W = canvas.width;
    const H = canvas.height;
    const cw = W * DOWN; // strip width in CSS pixels (the wave math's unit)
    ctx.clearRect(0, 0, W, H);
    // Presence: each band fades in, lives a while, fades away on its own
    // slow clock — the sky holds one to three at any moment, and the
    // brightest is lifted so it never goes completely empty (elia: 1–3).
    const presences = BANDS.map((b) =>
      Math.min(1, Math.max(0, 1.6 * Math.sin(t * b.presF + b.presOff) + 0.35)),
    );
    const top = Math.max(...presences);
    if (top < 0.45) presences[presences.indexOf(top)] = 0.45;
    for (let bi = 0; bi < BANDS.length; bi++) {
      const b = BANDS[bi];
      let presence = presences[bi];
      if (still && bi === 0) presence = Math.max(presence, 0.8);
      if (presence < 0.04) continue;

      // Dynamic span: the band's center and length both drift, so it
      // stretches across the sky, shrinks to a short arc, wanders sideways.
      const center = cw * (0.5 + 0.3 * Math.sin(t * b.lenF + b.lenOff));
      const halfLen =
        cw * (0.3 + 0.18 * Math.sin(t * b.lenF * 0.73 + b.lenOff * 1.9));

      const s = t * b.speed;
      // Curls flare up and die down over time — the tight kinks real bands
      // throw when they're active.
      const curlAmp =
        0.12 * Math.max(0, Math.sin(t * 0.19 + b.phase * 2.3));

      for (let x = 0; x < W; x++) {
        const cx = x * DOWN;
        const u = (cx - center) / halfLen;
        if (u < -1 || u > 1) continue;
        // flat through the middle, soft only at the actual ends
        const endTaper = Math.sqrt(1 - u * u);

        // Centerline: slow meander (phase itself waved, so arcs never
        // repeat) + the occasional tighter curl riding on top.
        const yC =
          H *
          (0.5 +
            b.yOff +
            b.mAmp *
              Math.sin(
                cx * b.meander + s * 0.9 + b.phase + 1.8 * Math.sin(cx * b.meander * 0.31 + s * 0.3),
              ) +
            curlAmp * Math.sin(cx * b.curlF + s * 1.6 + b.phase * 3));

        const swell = 0.6 + 0.4 * Math.sin(cx * 0.0017 + s * 0.7 + b.phase * 1.6);
        const th = H * b.thick * swell * (0.5 + 0.5 * endTaper);
        if (th < 1) continue;

        const flow = 0.7 + 0.3 * Math.sin(cx * 0.0023 + s + b.phase);
        const streak = 0.9 + 0.1 * Math.sin(cx * 0.05 + s * 1.8);
        const bright = flow * swell * streak * endTaper * presence;
        if (bright < 0.04) continue;
        ctx.globalAlpha = Math.min(1, Math.pow(bright, 1.25) * b.alpha + 0.03);
        ctx.drawImage(b.ramp, 0, 0, 1, RAMP_H, x, yC - th / 2, 1, th);
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
