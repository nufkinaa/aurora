// Full-screen aurora for the sign-in sky — the nav aurora's big sibling.
// Same band language (bright core, long veil below, meandering centerline,
// curls that come and go) tuned for a whole viewport: slower, taller, one
// violet band in the mix, and a sparse starfield behind. The curtains are
// painted at 1/3 resolution and upscaled — the blur IS the glow — while on
// desktop the stars go on a full-resolution layer so they stay points. The
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
  // The cadence ADAPTS to what a frame costs here (2026-10-07 — elia, on an
  // iPhone 18 Pro: "the aurora effect looks choppy when scrolling"): the
  // fixed 12fps a phone used to get reads as a slideshow on a 120Hz screen
  // that can paint this in a millisecond. Start at 20fps; after a few frames
  // the measured cost picks 30fps (cheap), 20 (fine) or 12 (dear).
  let FRAME_MS = 50;
  let cost = 0; // smoothed ms per paint
  const retune = (ms) => {
    cost = cost ? cost * 0.8 + ms * 0.2 : ms;
    FRAME_MS = cost < 4 ? 33 : cost < 9 ? 50 : 83;
  };
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
  // A phone is a tall, narrow window: five thick curtains stacked down it read
  // as stripes, not a sky (elia: "the app background on mobile looks really
  // bad"). There it is three — one bright near the top, a violet behind the
  // middle, a faint one low — thinner and quieter, with dark sky between.
  if (mobile) {
    BANDS.splice(3, 2);
    BANDS[0].yBase = rand(0.12, 0.18);
    BANDS[1].yBase = rand(0.46, 0.56);
    BANDS[2].yBase = rand(0.84, 0.92);
    for (const b of BANDS) {
      b.thick *= 0.8;
      b.alpha *= 0.72;
      b.mAmp *= 0.7;
    }
  } else {
    for (const b of BANDS) {
      b.thick *= 1.3;
      b.alpha *= 1.25;
    }
  }
  for (const b of BANDS) b.speed *= pace;
  // A sparse, fixed starfield (twinkle via alpha wave — no reshuffling).
  // A fuller field, twinkling the way stars do: most flicker faintly, a few
  // bright ones swell and dim with a soft halo, each on its own slow clock.
  // On a phone the stars ARE the sky (no curtains there — see paint), so the
  // field is fuller, with more bright ones, and each star swings further
  // between dim and lit (elia, 2026-10-07: "more stars that get bright and dim").
  const STARS = Array.from({ length: mobile ? 210 : 260 }, () => {
    const bright = Math.random() < (mobile ? 0.2 : 0.15);
    return {
      x: Math.random(),
      y: Math.random(),
      r: bright ? rand(1.1, 1.7) : rand(0.3, 1.0),
      tw: bright ? rand(0.25, 0.7) : rand(0.4, 1.6),
      off: rand(0, Math.PI * 2),
      bright,
    };
  });

  // Shooting stars (elia, 2026-10-07: "maybe add more stars and shooting
  // stars"): one every 7–16 s, a bright head with a tail that fades to
  // nothing, crossing a tenth of the sky in under a second. Drawn on the
  // star layer, so they are crisp. None in the still sky.
  const METEORS = [];
  let nextMeteorAt = 5 + Math.random() * 6;
  const spawnMeteor = (t) => {
    const dir = Math.random() < 0.5 ? 1 : -1; // left→right or right→left
    const ang = rand(0.3, 0.6); // radians below horizontal
    const speed = rand(0.22, 0.34); // of the width per second
    METEORS.push({
      t0: t,
      life: rand(0.7, 1.1),
      x0: dir > 0 ? rand(-0.05, 0.55) : rand(0.45, 1.05),
      y0: rand(0.02, 0.5),
      vx: dir * speed * Math.cos(ang),
      vy: speed * Math.sin(ang),
      len: rand(0.07, 0.13), // tail, of the width
    });
  };

  let raf = null;
  let last = 0;
  const DOWN = mobile ? 4 : 3;
  // Two layers: the curtains at 1/3 (1/4 on a phone) on an OFFSCREEN canvas
  // (the blur IS the upscale, and the per-column loop stays cheap), blitted
  // onto a visible canvas at full resolution where the stars are drawn as
  // real points. One layer at 1/3 made every star a 3px block (elia: "I can
  // see the stars' pixels") — and on a phone, where that single low-res
  // canvas lasted longer, a 6px smudge, with the curtains' columns showing
  // as a grid. Phones paint the same two layers now: one extra blit a frame.
  const HI = true;
  const off = document.createElement("canvas");
  const bctx = off.getContext("2d");
  let PX = 1; // canvas pixels per CSS pixel on the visible layer
  // A height change alone of under a third is a browser toolbar coming or
  // going (iPhone Safari while scrolling), not a new viewport: the canvas
  // keeps its size rather than reallocating — which clears it — mid-scroll.
  let sizedW = 0, sizedH = 0;
  const size = () => {
    const cw0 = canvas.clientWidth, ch0 = canvas.clientHeight;
    if (sizedW === cw0 && sizedH && Math.abs(ch0 - sizedH) < sizedH * 0.34) return;
    sizedW = cw0; sizedH = ch0;
    const w = Math.max(1, Math.round(canvas.clientWidth / DOWN));
    const h = Math.max(1, Math.round(canvas.clientHeight / DOWN));
    const low = off || canvas;
    if (low.width !== w || low.height !== h) {
      low.width = w;
      low.height = h;
    }
    if (HI) {
      // full CSS resolution, capped — a 4K desktop needs no 4K sky. A phone
      // gets its real pixels (to 2x): it is a small canvas, and a star drawn
      // at CSS resolution on a 3x screen is a soft dot again.
      const scale = mobile
        ? Math.min(2, window.devicePixelRatio || 1)
        : Math.min(1, 1920 / Math.max(1, canvas.clientWidth));
      PX = scale;
      const fw = Math.max(1, Math.round(canvas.clientWidth * scale));
      const fh = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== fw || canvas.height !== fh) {
        canvas.width = fw;
        canvas.height = fh;
      }
    }
  };

  const paint = (t, still = false) => {
    size();
    const low = off || canvas;
    const W = low.width;
    const H = low.height;
    const cw = W * DOWN;
    bctx.clearRect(0, 0, W, H);
    if (HI) ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Stars on the visible layer — crisp points at full resolution on
    // desktop, the old blocks on the low-res phone canvas.
    const sctx = ctx;
    const SW = canvas.width;
    const SH = canvas.height;
    // star sizes were tuned at the desktop's low resolution (1/3); a phone
    // draws them a little smaller, in its own pixels
    const K = mobile ? 2 * PX * 0.62 : SW / W;
    sctx.fillStyle = "rgba(230, 238, 255, 1)";
    for (const s of stars ? STARS : []) {
      // a slow swell with a sharper glint on top — real twinkle isn't a sine
      const w = Math.sin(t * s.tw + s.off);
      const glint = Math.max(0, Math.sin(t * s.tw * 3.1 + s.off * 1.7)) ** 6;
      const a = still
        ? 0.55
        : mobile
          ? Math.max(0, 0.12 + 0.55 * w + 0.45 * glint) // deeper dips, brighter peaks
          : Math.max(0, 0.22 + 0.45 * w + 0.35 * glint);
      if (a <= 0.05) continue;
      const x = s.x * SW, y = s.y * SH;
      if (HI) {
        const r = Math.max(0.6, s.r * K * 0.5);
        if (s.bright) {
          // a soft round halo that grows with the glow
          // (tighter and fainter on a phone, where the full-size one reads
          // as a bubble around the star)
          sctx.globalAlpha = a * (mobile ? 0.1 : 0.18);
          sctx.beginPath();
          sctx.arc(x, y, r + (mobile ? 1.1 : 2.2) * K, 0, Math.PI * 2);
          sctx.fill();
        }
        sctx.globalAlpha = Math.min(1, a * (s.bright ? 1 : 0.75));
        sctx.beginPath();
        sctx.arc(x, y, r, 0, Math.PI * 2);
        sctx.fill();
        continue;
      }
      if (s.bright) {
        // a soft halo that grows with the glow
        sctx.globalAlpha = a * 0.18;
        sctx.fillRect(x - 1.5, y - 1.5, s.r + 3, s.r + 3);
      }
      sctx.globalAlpha = Math.min(1, a * (s.bright ? 1 : 0.75));
      sctx.fillRect(x, y, s.r, s.r);
    }
    sctx.globalAlpha = 1;

    if (stars && !still) {
      if (t >= nextMeteorAt) {
        spawnMeteor(t);
        nextMeteorAt = t + rand(7, 16);
      }
      for (let i = METEORS.length - 1; i >= 0; i--) {
        const m = METEORS[i];
        const p = (t - m.t0) / m.life;
        if (p >= 1 || p < 0) {
          METEORS.splice(i, 1);
          continue;
        }
        // in fast, out slow: a meteor flares at once and dies away
        const env = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
        const hx = (m.x0 + m.vx * p * m.life) * SW;
        const hy = (m.y0 + m.vy * p * m.life) * SH;
        const norm = Math.hypot(m.vx, m.vy) || 1;
        const tailLen = m.len * SW * (0.4 + 0.6 * Math.min(1, p / 0.3));
        const tx = hx - (m.vx / norm) * tailLen;
        const ty = hy - (m.vy / norm) * tailLen;
        const g = sctx.createLinearGradient(hx, hy, tx, ty);
        g.addColorStop(0, `rgba(255, 255, 255, ${(0.95 * env).toFixed(3)})`);
        g.addColorStop(0.25, `rgba(220, 230, 255, ${(0.5 * env).toFixed(3)})`);
        g.addColorStop(1, "rgba(200, 215, 255, 0)");
        sctx.strokeStyle = g;
        sctx.lineWidth = Math.max(1, K * 0.5);
        sctx.lineCap = "round";
        sctx.beginPath();
        sctx.moveTo(hx, hy);
        sctx.lineTo(tx, ty);
        sctx.stroke();
        // the head
        sctx.fillStyle = `rgba(255, 255, 255, ${(0.95 * env).toFixed(3)})`;
        sctx.beginPath();
        sctx.arc(hx, hy, Math.max(0.8, K * 0.6), 0, Math.PI * 2);
        sctx.fill();
      }
      sctx.fillStyle = "rgba(230, 238, 255, 1)";
    }

    // No curtains on a phone (2026-10-07). They are painted as 1px columns at
    // quarter resolution and rely on the upscale's smoothing to blend; iOS
    // Safari ignores imageSmoothingQuality, so on a real iPhone the columns
    // showed as vertical cuts across the band (elia's photo — not visible in
    // a desktop browser's phone emulation). A phone gets a faint, still wash
    // of the same colours so the glass keeps its tone, and the stars do the
    // living. Two gradients at low resolution: nothing to stutter.
    if (mobile) {
      const g1 = bctx.createRadialGradient(W * 0.25, H * 0.22, 0, W * 0.25, H * 0.22, Math.max(W, H) * 0.55);
      g1.addColorStop(0, "rgba(120, 80, 220, 0.22)");
      g1.addColorStop(1, "rgba(120, 80, 220, 0)");
      const g2 = bctx.createRadialGradient(W * 0.8, H * 0.45, 0, W * 0.8, H * 0.45, Math.max(W, H) * 0.5);
      g2.addColorStop(0, "rgba(60, 190, 140, 0.16)");
      g2.addColorStop(1, "rgba(60, 190, 140, 0)");
      bctx.globalAlpha = 1;
      bctx.fillStyle = g1;
      bctx.fillRect(0, 0, W, H);
      bctx.fillStyle = g2;
      bctx.fillRect(0, 0, W, H);
    }
    if (!mobile) for (const b of BANDS) {
      let presence = Math.min(1, Math.max(0, 1.6 * Math.sin(t * b.presF + b.presOff) + 0.35));
      if (b.hero) presence = Math.max(presence, 0.85);
      presence = Math.max(presence, b.violet ? 0.55 : 0.3); // nothing vanishes for long
      if (still) presence = Math.max(presence, 0.7);
      if (presence < 0.04) continue;

      const center = cw * (0.5 + 0.3 * Math.sin(t * b.lenF + b.lenOff));
      // On a phone a curtain always runs off both edges: one that ends inside
      // a 375px window is not a curtain, it is a glowing lozenge with a tip.
      const halfLen = cw * (mobile ? 1.25 + 0.2 * Math.sin(t * b.lenF * 0.73 + b.lenOff * 1.9) : 0.72 + 0.28 * Math.sin(t * b.lenF * 0.73 + b.lenOff * 1.9));
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
        bctx.globalAlpha = Math.min(1, Math.pow(bright, 1.25) * b.alpha + 0.02 * feather);
        bctx.drawImage(b.ramp, 0, 0, 1, RAMP_H, x, yC - th * CORE_AT, 1, th);
      }
    }
    bctx.globalAlpha = 1;
    // The curtains, upscaled over the stars: the same soft blur as before,
    // one blit per frame.
    if (HI) {
      ctx.globalAlpha = 1;
      ctx.drawImage(off, 0, 0, W, H, 0, 0, canvas.width, canvas.height);
    }
  };

  const alive = () => canvas.isConnected && !document.hidden;
  // While the page is being scrolled, the sky holds its frame. Every repaint
  // of the canvas re-blurs the glass above it (the nav island, the hero
  // slab), and on a phone that work landed in the same frames as the
  // scroll — so the sky waits until the finger has been still for a beat.
  // The curtains drift over tens of seconds; a 150ms hold is invisible.
  // The hold is for a device where a frame is DEAR (measured, not guessed
  // from the pointer): on a capable phone it made the aurora stand still
  // through every fling and jump afterwards — the choppiness elia saw on an
  // iPhone 18 Pro — while the surfaces that made re-blurring expensive (the
  // hero slab, the episode and source cards) no longer blur at all.
  let scrolledAt = 0;
  const onScroll = () => { scrolledAt = performance.now(); };
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });
  const scrolling = (now) => cost > 9 && now - scrolledAt < 150;
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
    if (now - last >= FRAME_MS && !scrolling(now)) {
      last = now;
      const t0 = performance.now();
      paint(now / 1000);
      retune(performance.now() - t0);
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
    document.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("resize", kick);
  };
};
