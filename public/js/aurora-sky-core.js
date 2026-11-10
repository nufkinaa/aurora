// The sky's painter and its clock, free of the page: no `document`, no
// `window` — so the same code paints on the page's own thread (phones, the
// sign-in sky, a browser without OffscreenCanvas) or inside a worker
// (aurora-sky-worker.js: the glass look's page sky on a computer, where one
// paint costs 12–30 ms and used to stand still for as long as the page was
// being scrolled). aurora-sky.js chooses, and says why.
//
// Kept close to the height a column is actually drawn at (~55-80px here), so
// the cross-section is interpolated UP rather than aliased down — the same
// fix the nav painter needed (see js/aurora.js).
const RAMP_H = 32;
const CORE_AT = 0.36;

// A small seeded generator (mulberry32) for `seed`: two painters given the
// same seed draw the same sky — how tools/webperf/skyproof.js shows that the
// worker's picture is the page thread's, pixel for pixel.
const seeded = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// `canvas`: an HTMLCanvasElement or an OffscreenCanvas. `makeCanvas(w, h)`:
// a scratch canvas of that kind. `mobile`: a phone's sky (see below).
// `pace` scales every band's drift: 1 is the sign-in sky, ~0.45 the glass
// look's page sky (elia: "a bit slower" — a sky behind everything must
// breathe, not drift). `stars` toggles the starfield.
//   -> { size(cssWidth, cssHeight, density), paint(seconds, still) }
export const makeSky = (canvas, { mobile = false, pace = 1, stars = true, seed = null, makeCanvas }) => {
  const random = seed == null ? Math.random : seeded(seed);
  const makeRamp = (stops) => {
    const c = makeCanvas(1, RAMP_H);
    const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, RAMP_H);
    for (const [at, color] of stops) g.addColorStop(at, color);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1, RAMP_H);
    return c;
  };

  const rand = (a, b) => a + random() * (b - a);

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
    speed: rand(0.1, 0.2) * (random() < 0.5 ? -1 : 1), // half the nav's pace — a sky, not a strip
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

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

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
    const bright = random() < (mobile ? 0.2 : 0.15);
    return {
      x: random(),
      y: random(),
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
  let nextMeteorAt = 5 + random() * 6;
  const spawnMeteor = (t) => {
    const dir = random() < 0.5 ? 1 : -1; // left→right or right→left
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

  const DOWN = mobile ? 4 : 3;
  // Two layers: the curtains at 1/3 (1/4 on a phone) on an OFFSCREEN canvas
  // (the blur IS the upscale, and the per-column loop stays cheap), blitted
  // onto a visible canvas at full resolution where the stars are drawn as
  // real points. One layer at 1/3 made every star a 3px block (elia: "I can
  // see the stars' pixels") — and on a phone, where that single low-res
  // canvas lasted longer, a 6px smudge, with the curtains' columns showing
  // as a grid. Phones paint the same two layers now: one extra blit a frame.
  const HI = true;
  const off = makeCanvas(300, 150);
  const bctx = off.getContext("2d");
  let PX = 1; // canvas pixels per CSS pixel on the visible layer
  // A height change alone of under a third is a browser toolbar coming or
  // going (iPhone Safari while scrolling), not a new viewport: the canvas
  // keeps its size rather than reallocating — which clears it — mid-scroll.
  let sizedW = 0, sizedH = 0;
  let cssW = 0, cssH = 0, dpr = 1; // the canvas's CSS box and the screen's density, as last told (size)
  const fit = () => {
    const cw0 = cssW, ch0 = cssH;
    if (sizedW === cw0 && sizedH && Math.abs(ch0 - sizedH) < sizedH * 0.34) return;
    sizedW = cw0; sizedH = ch0;
    const w = Math.max(1, Math.round(cssW / DOWN));
    const h = Math.max(1, Math.round(cssH / DOWN));
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
        ? Math.min(2, dpr)
        : Math.min(1, 1920 / Math.max(1, cssW));
      PX = scale;
      const fw = Math.max(1, Math.round(cssW * scale));
      const fh = Math.max(1, Math.round(cssH * scale));
      if (canvas.width !== fw || canvas.height !== fh) {
        canvas.width = fw;
        canvas.height = fh;
      }
    }
  };

  const paint = (t, still = false) => {
    fit();
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

  return {
    // (taken up by the next paint: reallocating a canvas clears it, and a
    // cleared canvas must not be shown for a frame)
    size: (w, h, density = 1) => {
      cssW = w;
      cssH = h;
      dpr = density;
    },
    paint,
  };
};

// A worker has requestAnimationFrame where it can have an OffscreenCanvas;
// the timer is for the odd one that does not.
const frame = globalThis.requestAnimationFrame
  ? (fn) => globalThis.requestAnimationFrame(fn)
  : (fn) => setTimeout(() => fn(performance.now()), 16);
const unframe = globalThis.cancelAnimationFrame ? (id) => globalThis.cancelAnimationFrame(id) : clearTimeout;

// The sky's clock: when `paint(seconds, still)` is called.
//   state() -> "stop" (not shown: paint nothing), "still" (one still frame —
//              reduced motion, a weak device), "nap" (covered by the player:
//              look again in a second) or "run"
//   hold(now, cost) -> 0, or the time until which the sky keeps its frame
//   report(ms, at) -> told what each paint cost and when, on this clock
//              (the measuring tools)
//   frames: [seconds…] -> paint exactly these and never run (the pixel proof)
//   -> { kick(), stop() }
export const makeLoop = (paint, { state, hold = null, report = null, frames = null }) => {
  if (frames) {
    for (const t of frames) paint(t);
    if (report) report(0, performance.now());
    return { kick() {}, stop() {} };
  }
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
  let raf = null;
  let last = 0;
  let napTimer = null;
  // The sky paints every FRAME_MS (33–83 ms), not every frame. Where the
  // wait is long (a paint that is dear here: 83 ms) the loop sleeps on a
  // timer between two paints and wakes three frames before the next one is
  // due, so it still paints on exactly the frame it always did (the first
  // one at or after the due time) — a margin wide enough that a busy main
  // thread delays the wake no more than it would delay the frame itself.
  // Asking for every frame kept the page producing 60 (or 120) frames a
  // second for a picture that changes 12 times.
  const WAKE_EARLY_MS = 50;
  let wakeTimer = 0;
  const next = (now) => {
    let due = last + FRAME_MS;
    const until = hold ? hold(now, cost) : 0;
    if (until) due = Math.max(due, until);
    // (from the clock as it is NOW: `now` is when this frame began, and the
    // paint just made in it may have used up a good part of the wait)
    const wait = due - performance.now() - WAKE_EARLY_MS;
    if (wait > 4) {
      wakeTimer = setTimeout(() => {
        wakeTimer = 0;
        if (raf == null) raf = frame(loop);
      }, wait);
    } else raf = frame(loop);
  };
  const loop = (now) => {
    raf = null;
    const s = state();
    if (s === "stop" || s === "still") return;
    if (s === "nap") {
      clearTimeout(napTimer);
      napTimer = setTimeout(kick, 1000);
      return;
    }
    if (now - last >= FRAME_MS && !(hold && hold(now, cost))) {
      last = now;
      const t0 = performance.now();
      paint(now / 1000);
      const ms = performance.now() - t0;
      retune(ms);
      if (report) report(ms, now);
    }
    next(now);
  };
  // (also the way back in: after a tab comes forward, a player closes, the
  // look or the motion setting changes)
  const kick = () => {
    const s = state();
    if (s === "stop") return;
    if (s === "still") {
      paint(6, true);
      if (report) report(0, performance.now());
      return;
    }
    if (raf == null && !wakeTimer) raf = frame(loop);
  };
  const stop = () => {
    if (raf != null) unframe(raf);
    raf = null;
    clearTimeout(wakeTimer);
    wakeTimer = 0;
    clearTimeout(napTimer);
  };
  return { kick, stop };
};
