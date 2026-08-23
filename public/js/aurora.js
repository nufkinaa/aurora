// Aurora borealis for the nav's empty stretch — the real structure, not
// stylized blobs (elia's ask): curtains with a bright green lower edge,
// rays thinning upward through teal into a violet fringe, slow folds
// rippling through. CSS gradients can't fold; this tiny canvas can.
//
// Cost discipline: the canvas is ~600×64, painting is capped at 30fps and
// runs ONLY while the lights are visible (nav solid, tab in front) — the
// MutationObserver on the nav's class starts/stops the loop. Reduced
// motion gets a single still frame. No assets, no network.
const RAMP_H = 64;

// One 1px-wide vertical color ramp per curtain. Columns are drawn by
// scaling this strip with drawImage, so no gradient objects are allocated
// per frame (that churn is what makes naive canvas effects slow).
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

export const initAurora = (canvas) => {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const nav = canvas.closest(".nav");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");

  // Matched to elia's reference footage (Iceland timelapse): the aurora
  // there is not vertical curtains but a BAND — a river of saturated green
  // flowing diagonally, bright core low in its cross-section, soft
  // feathered edges, thickness swelling and tapering along its length.
  // Each ramp is one band's vertical cross-section (top → bottom).
  const BANDS = [
    {
      ramp: makeRamp([
        [0, "rgba(120, 160, 255, 0)"],
        [0.16, "rgba(110, 160, 255, 0.08)"],
        [0.4, "rgba(60, 235, 150, 0.4)"],
        [0.62, "rgba(130, 255, 185, 0.85)"], // the bright core, below middle
        [0.78, "rgba(50, 215, 140, 0.42)"],
        [1, "rgba(20, 150, 115, 0)"],
      ]),
      speed: 0.14,
      meander: 0.003, // how the band's centerline wanders
      mAmp: 0.24,
      thick: 0.62, // of the strip's height
      tVar: 0.4, // thickness swell along the length
      phase: 0,
      alpha: 1.1,
    },
    {
      // a fainter, thinner echo band drifting the other way
      ramp: makeRamp([
        [0, "rgba(110, 150, 255, 0)"],
        [0.35, "rgba(50, 210, 150, 0.22)"],
        [0.6, "rgba(90, 245, 175, 0.42)"],
        [1, "rgba(25, 150, 120, 0)"],
      ]),
      speed: -0.09,
      meander: 0.0021,
      mAmp: 0.3,
      thick: 0.38,
      tVar: 0.5,
      phase: 2.2,
      alpha: 0.7,
    },
  ];

  let raf = null;
  let last = 0;
  // Painted at 1/3 resolution and upscaled by the browser's smoothing —
  // that interpolation IS the glow: hard 1px columns become soft 3px rays,
  // exactly the diffuse look photographs of the real thing have. (Crisp
  // full-res columns read as a bar chart.) Also a 9× cheaper frame.
  const DOWN = 3;
  const size = () => {
    const w = Math.max(1, Math.round(canvas.clientWidth / DOWN));
    const h = Math.max(1, Math.round(canvas.clientHeight / DOWN));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  const paint = (t) => {
    size();
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    for (const b of BANDS) {
      const s = t * b.speed;
      for (let x = 0; x < W; x++) {
        const cx = x * DOWN; // the wave math lives in CSS pixels
        // The band's centerline meanders across the strip — a slow wave
        // whose phase is itself waved, so the path arcs and doubles back
        // instead of repeating (this is the "river" of the footage).
        const yC =
          H *
          (0.5 +
            b.mAmp *
              Math.sin(cx * b.meander + s * 0.6 + b.phase + 1.8 * Math.sin(cx * b.meander * 0.31 + s * 0.2)));
        // Thickness swells and tapers along the length; where it pinches
        // toward zero the band fades into wisps like the reference's tails.
        const swell =
          0.62 + 0.38 * Math.sin(cx * 0.0017 + s * 0.45 + b.phase * 1.6);
        const th = H * b.thick * swell;
        if (th < 1) continue;
        // Brightness flows along the band independently of thickness, with
        // a whisper of fine streak texture riding on top.
        const flow = 0.55 + 0.45 * Math.sin(cx * 0.0023 + s * 0.7 + b.phase);
        const streak = 0.9 + 0.1 * Math.sin(cx * 0.05 + s * 1.3);
        const bright = flow * swell * streak;
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
      paint(4); // one still frame mid-sway
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
