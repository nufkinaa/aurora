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

  // Ramps read top→bottom: faint violet fringe, teal body, bright green
  // base — the way the real thing stacks its emission colors.
  const CURTAINS = [
    {
      ramp: makeRamp([
        [0, "rgba(150, 110, 255, 0)"],
        [0.2, "rgba(150, 110, 255, 0.22)"],
        [0.58, "rgba(64, 224, 180, 0.45)"],
        [0.95, "rgba(84, 255, 172, 0.8)"],
        [1, "rgba(170, 255, 215, 0.9)"],
      ]),
      speed: 0.2,
      xf: 0.012,
      amp: 0.62,
      alpha: 1.25,
      rayF: 0.3, // fine striations inside the folds
      phase: 0,
    },
    {
      ramp: makeRamp([
        [0, "rgba(110, 120, 255, 0)"],
        [0.3, "rgba(96, 140, 255, 0.16)"],
        [0.72, "rgba(61, 220, 180, 0.32)"],
        [1, "rgba(96, 240, 190, 0.6)"],
      ]),
      speed: -0.12,
      xf: 0.0062,
      amp: 0.48,
      alpha: 1,
      rayF: 0.18,
      phase: 2.4, // its ribbon flows offset from the green curtain's
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
    for (const cur of CURTAINS) {
      const s = t * cur.speed;
      for (let x = 0; x < W; x++) {
        const cx = x * DOWN; // the wave math lives in CSS pixels
        // THE aurora signature: the curtain hangs from a flowing RIBBON —
        // its bright lower edge undulates slowly across the strip (a flat
        // baseline is what made earlier attempts read as a bar chart).
        const ribbon =
          0.5 +
          0.5 *
            Math.sin(
              cx * 0.004 + s * 0.7 + cur.phase + 1.4 * Math.sin(cx * 0.0013 + s * 0.31),
            );
        const edgeY = H * (0.95 - 0.3 * ribbon);
        // Broad folds: the curtain swells and parts but stays continuous.
        const fold = Math.sin(
          cx * cur.xf + s + 2.1 * Math.sin(cx * cur.xf * 0.23 + s * 0.6),
        );
        const f = Math.max(0, fold);
        if (f < 0.03) continue;
        // Gentle striations ride inside as brightness variation, spacing
        // itself phase-warped so they never look metronomic.
        const warp = 1.7 * Math.sin(cx * cur.rayF * 0.13 + s * 0.9);
        const rays = 0.75 + 0.25 * Math.sin(cx * cur.rayF + warp + s * 2.2);
        const shimmer = 0.85 + 0.15 * Math.sin(s * 3.1 + cx * 0.045);
        const rayH = Math.min(edgeY, (0.25 + cur.amp * f) * edgeY * (0.9 + 0.1 * rays));
        const bright = f * rays * shimmer;
        ctx.globalAlpha = Math.min(1, Math.pow(bright, 1.35) * cur.alpha + 0.04);
        ctx.drawImage(cur.ramp, 0, 0, 1, RAMP_H, x, edgeY - rayH, 1, rayH);
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
