// Aurora Play — the reward: a meteor burst. Not paper confetti: a shower of
// shooting stars thrown out from one point, each a bright head with a fading
// tail, slowing and burning out — plus a few sparks that twinkle where they
// stop. One per flow, at the moment that earned it.
//
//   meteorBurst(host, { x, y, count, colors, ms }) -> Promise (resolves when
//       the last spark is gone). `host` is the element to burst over (a
//       canvas the size of it is laid on top and removed afterwards); x/y in
//       0..1 of the host (default: the middle). Under reduced motion, or with
//       the page hidden, nothing is drawn and it resolves at once.
//   meteors(count, seed)  pure: the shower's starting set — angle, speed,
//       length, size and colour index of each meteor, the same for the same
//       seed (tested)
//
// The canvas paints at most at 2x the CSS pixels, only while the burst runs.
import { reduced } from "./motion.js";

const rand = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const meteors = (count = 42, seed = 1) => {
  const r = rand(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    // spread evenly round the circle, then shaken, so there are no gaps
    const angle = (i / count) * Math.PI * 2 + (r() - 0.5) * 0.5;
    out.push({
      angle,
      speed: 0.55 + r() * 0.75, // in host-diagonals per second, at the start
      tail: 0.06 + r() * 0.1, // tail length, host-diagonals
      size: 1.2 + r() * 2.2, // head radius, CSS px
      color: Math.floor(r() * 4),
      delay: r() * 0.12, // s
      life: 0.9 + r() * 0.6, // s
    });
  }
  return out;
};

export const meteorBurst = (host, { x = 0.5, y = 0.5, count = 42, colors = ["#ffe08a", "#7ef7c9", "#b9a6ff", "#ffffff"], ms = 1700, seed = Date.now() % 9973 } = {}) =>
  new Promise((resolve) => {
    if (!host || reduced() || document.hidden) return resolve();
    const box = host.getBoundingClientRect();
    if (!box.width || !box.height) return resolve();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.className = "play-burst";
    canvas.setAttribute("aria-hidden", "true");
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    host.append(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) { canvas.remove(); return resolve(); }
    ctx.scale(dpr, dpr);
    const diag = Math.hypot(box.width, box.height);
    const ox = box.width * x;
    const oy = box.height * y;
    const set = meteors(count, seed);
    const sparks = set.filter((_, i) => i % 3 === 0);
    const t0 = performance.now();
    const end = ms / 1000;
    let raf = 0;
    const frame = (now) => {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, box.width, box.height);
      ctx.globalCompositeOperation = "lighter";
      for (const m of set) {
        const lt = t - m.delay;
        if (lt <= 0 || lt > m.life) continue;
        const k = lt / m.life;
        // travelled distance: fast out, slowing (ease-out), in px
        const d = diag * m.speed * m.life * (1 - Math.pow(1 - k, 2.4)) * 0.5;
        const hx = ox + Math.cos(m.angle) * d;
        const hy = oy + Math.sin(m.angle) * d;
        const tl = diag * m.tail * (1 - k * 0.6);
        const tx = hx - Math.cos(m.angle) * tl;
        const ty = hy - Math.sin(m.angle) * tl;
        const alpha = k < 0.15 ? k / 0.15 : 1 - Math.pow((k - 0.15) / 0.85, 1.6);
        const g = ctx.createLinearGradient(hx, hy, tx, ty);
        g.addColorStop(0, colors[m.color % colors.length]);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.strokeStyle = g;
        ctx.lineWidth = m.size * 1.1;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(hx, hy, m.size * (1 - k * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
      // sparks: where a third of the meteors burn out, a star blinks twice
      for (const m of sparks) {
        const st = t - m.delay - m.life * 0.85;
        if (st <= 0 || st > 0.7) continue;
        const d = diag * m.speed * m.life * 0.5 * (1 - Math.pow(0.15, 2.4));
        const sx = ox + Math.cos(m.angle) * d;
        const sy = oy + Math.sin(m.angle) * d;
        const a = Math.max(0, Math.sin((st / 0.7) * Math.PI * 2) * (1 - st / 0.7));
        ctx.globalAlpha = a;
        ctx.fillStyle = colors[m.color % colors.length];
        const s = m.size * 2.2;
        ctx.fillRect(sx - s / 2, sy - 0.6, s, 1.2);
        ctx.fillRect(sx - 0.6, sy - s / 2, 1.2, s);
      }
      ctx.globalAlpha = 1;
      if (t < end && document.body.contains(canvas) && !document.hidden) raf = requestAnimationFrame(frame);
      else { cancelAnimationFrame(raf); canvas.remove(); resolve(); }
    };
    raf = requestAnimationFrame(frame);
  });
