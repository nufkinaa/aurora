// Full-screen aurora for the sign-in sky — the nav aurora's big sibling.
// Same band language (bright core, long veil below, meandering centerline,
// curls that come and go) tuned for a whole viewport: slower, taller, one
// violet band in the mix, and a sparse starfield behind. Painted at 1/3
// resolution and browser-upscaled — the blur IS the glow. 24fps, and the
// loop stops the moment the canvas leaves the DOM or the tab hides.
// Reduced motion: one still frame, no drift.
// Kept close to the height a column is actually drawn at (~55-80px here), so
// the cross-section is interpolated UP rather than aliased down — the same
// fix the nav painter needed (see js/aurora.js).
const RAMP_H = 32;

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
const CORE_AT = 0.36;

// Two cross-sections: the signature green and a violet one (the login mood —
// it echoes the app's accent without shouting).
const greenRamp = (s) =>
  makeRamp([
    [0, "rgba(120, 160, 255, 0)"],
    [0.1, `rgba(110, 160, 255, ${0.08 * s})`],
    [0.24, `rgba(60, 235, 150, ${0.4 * s})`],
    [CORE_AT, `rgba(140, 255, 190, ${0.85 * s})`],
    [0.55, `rgba(60, 225, 150, ${0.46 * s})`],
    [0.78, `rgba(35, 180, 130, ${0.24 * s})`],
    [1, "rgba(20, 150, 115, 0)"],
  ]);
const violetRamp = (s) =>
  makeRamp([
    [0, "rgba(150, 130, 255, 0)"],
    [0.1, `rgba(150, 130, 255, ${0.07 * s})`],
    [0.24, `rgba(150, 120, 255, ${0.32 * s})`],
    [CORE_AT, `rgba(190, 160, 255, ${0.66 * s})`],
    [0.58, `rgba(130, 100, 235, ${0.34 * s})`],
    [1, "rgba(90, 70, 190, 0)"],
  ]);

const makeBand = ({ hero = false, violet = false, y = 0.3 } = {}) => ({
  hero,
  violet,
  ramp: violet ? violetRamp(rand(0.75, 0.9)) : greenRamp(hero ? rand(0.9, 1.05) : rand(0.7, 0.9)),
  speed: rand(0.1, 0.2) * (Math.random() < 0.5 ? -1 : 1), // half the nav's pace — a sky, not a strip
  meander: rand(0.0012, 0.002),
  mAmp: rand(0.05, 0.09), // of the CANVAS height
  curlF: rand(0.004, 0.007),
  thick: rand(0.2, 0.3), // of the canvas height — tall, hanging curtains
  sMin: hero ? 0.72 : 0.6,
  sVar: hero ? 0.28 : 0.4,
  yBase: y,
  phase: rand(0, Math.PI * 2),
  presF: rand(0.02, 0.045),
  presOff: rand(0, Math.PI * 2),
  lenF: rand(0.015, 0.03),
  lenOff: rand(0, Math.PI * 2),
  alpha: hero ? rand(1.45, 1.7) : rand(1.2, 1.5),
});

// `pace` scales every band's drift: 1 is the sign-in sky, ~0.45 the glass
// look's page sky (elia: "a bit slower" — a sky behind everything must
// breathe, not drift). `stars` toggles the starfield.
export const initAuroraSky = (canvas, { pace = 1, stars = true } = {}) => {
  if (!canvas) return () => {};
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  // Phones (and anything else with a finger, or a small screen) paint at a
  // quarter of the resolution and 12fps instead of a third and 20: the
  // curtains are as soft either way — the blur IS the upscale — and the
  // per-frame column loop costs less than half as much on a weak CPU.
  const mobile = matchMedia("(pointer: coarse)").matches || innerWidth < 900;
  const FRAME_MS = mobile ? 83 : 50;
  // A genuinely weak device (2 GB, two cores, or data saver on) gets one still
  // frame of the sky, like reduced-motion does — the look, without the loop.
  const weak =
    (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) ||
    !!(navigator.connection && navigator.connection.saveData);
  const still = () => calm.matches || weak;

  // Four curtains spread over the WHOLE height (the page sky sits behind
  // every screen, not just the top of one), thicker and a touch brighter
  // than the sign-in sky.
  const BANDS = [
    makeBand({ hero: true, y: rand(0.18, 0.26) }),
    makeBand({ violet: true, y: rand(0.38, 0.46) }),
    makeBand({ y: rand(0.06, 0.12) }),
    makeBand({ violet: true, y: rand(0.58, 0.66) }),
    makeBand({ y: rand(0.78, 0.88) }),
  ];
  for (const b of BANDS) {
    b.thick *= 1.3;
    b.alpha *= 1.25;
  }
  for (const b of BANDS) b.speed *= pace;
  // A sparse, fixed starfield (twinkle via alpha wave — no reshuffling).
  // A fuller field, twinkling the way stars do: most flicker faintly, a few
  // bright ones swell and dim with a soft halo, each on its own slow clock.
  const STARS = Array.from({ length: mobile ? 110 : 170 }, () => {
    const bright = Math.random() < 0.12;
    return {
      x: Math.random(),
      y: Math.random(),
      r: bright ? rand(1.1, 1.7) : rand(0.3, 1.0),
      tw: bright ? rand(0.25, 0.7) : rand(0.4, 1.6),
      off: rand(0, Math.PI * 2),
      bright,
    };
  });

  let raf = null;
  let last = 0;
  const DOWN = mobile ? 4 : 3;
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
    const cw = W * DOWN;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "rgba(230, 238, 255, 1)";
    for (const s of stars ? STARS : []) {
      // a slow swell with a sharper glint on top — real twinkle isn't a sine
      const w = Math.sin(t * s.tw + s.off);
      const glint = Math.max(0, Math.sin(t * s.tw * 3.1 + s.off * 1.7)) ** 6;
      const a = still ? 0.55 : Math.max(0, 0.22 + 0.45 * w + 0.35 * glint);
      if (a <= 0.05) continue;
      const x = s.x * W, y = s.y * H;
      if (s.bright) {
        // a soft halo that grows with the glow
        ctx.globalAlpha = a * 0.18;
        ctx.fillRect(x - 1.5, y - 1.5, s.r + 3, s.r + 3);
      }
      ctx.globalAlpha = Math.min(1, a * (s.bright ? 1 : 0.75));
      ctx.fillRect(x, y, s.r, s.r);
    }

    for (const b of BANDS) {
      let presence = Math.min(1, Math.max(0, 1.6 * Math.sin(t * b.presF + b.presOff) + 0.35));
      if (b.hero) presence = Math.max(presence, 0.85);
      presence = Math.max(presence, b.violet ? 0.55 : 0.3); // nothing vanishes for long
      if (still) presence = Math.max(presence, 0.7);
      if (presence < 0.04) continue;

      const center = cw * (0.5 + 0.3 * Math.sin(t * b.lenF + b.lenOff));
      const halfLen = cw * (0.72 + 0.28 * Math.sin(t * b.lenF * 0.73 + b.lenOff * 1.9));
      const s = t * b.speed;
      const curlAmp = 0.04 * Math.max(0, Math.sin(t * 0.11 + b.phase * 2.3));

      for (let x = 0; x < W; x++) {
        const cx = x * DOWN;
        const u = (cx - center) / halfLen;
        if (u < -1 || u > 1) continue;
        // same feathered ends as the nav painter — sqrt alone cuts a clean
        // vertical edge at the tips (see aurora.js)
        const dome = Math.sqrt(1 - u * u);
        const a = Math.abs(u);
        let feather = 1;
        if (a > 0.85) {
          const t = (1 - a) / 0.15;
          feather = t * t * (3 - 2 * t);
        }
        const endTaper = dome * feather;
        const yC =
          H *
          (b.yBase +
            b.mAmp *
              Math.sin(cx * b.meander + s * 0.9 + b.phase + 2.6 * Math.sin(cx * b.meander * 0.31 + s * 0.3)) +
            curlAmp * Math.sin(cx * b.curlF + s * 1.6 + b.phase * 3));
        const swell = b.sMin + b.sVar * Math.sin(cx * 0.0009 + s * 0.7 + b.phase * 1.6);
        const th = H * b.thick * swell * (0.3 + 0.7 * endTaper);
        if (th < 1) continue;
        const flow = 0.7 + 0.3 * Math.sin(cx * 0.0012 + s + b.phase);
        const streak = 0.9 + 0.1 * Math.sin(cx * 0.03 + s * 1.8);
        const bright = flow * swell * streak * endTaper * presence;
        if (bright < 0.02) continue;
        ctx.globalAlpha = Math.min(1, Math.pow(bright, 1.25) * b.alpha + 0.02 * feather);
        ctx.drawImage(b.ramp, 0, 0, 1, RAMP_H, x, yC - th * CORE_AT, 1, th);
      }
    }
    ctx.globalAlpha = 1;
  };

  const alive = () => canvas.isConnected && !document.hidden;
  // The player covers the whole viewport with black — a sky animating under
  // it is pure battery. While one is open the loop sleeps and checks back
  // once a second (a full-screen overlay, not a page, so no route event).
  const covered = () => !!document.querySelector(".player");
  let napTimer = null;
  const loop = (now) => {
    raf = null;
    if (!alive() || still()) return;
    if (covered()) {
      clearTimeout(napTimer);
      napTimer = setTimeout(kick, 1000);
      return;
    }
    if (now - last >= FRAME_MS) {
      last = now;
      paint(now / 1000);
    }
    raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    if (!alive()) return;
    if (still()) {
      paint(6, true);
      return;
    }
    if (raf == null) raf = requestAnimationFrame(loop);
  };
  document.addEventListener("visibilitychange", kick);
  window.addEventListener("resize", kick);
  kick();

  // teardown for when the overlay is removed
  return () => {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
    clearTimeout(napTimer);
    document.removeEventListener("visibilitychange", kick);
    window.removeEventListener("resize", kick);
  };
};
