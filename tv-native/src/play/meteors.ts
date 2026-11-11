// Aurora Play — the reward: a meteor burst (pure part). The shower's starting
// set is the website's (public/js/play/burst.js `meteors`): angle, speed,
// length, size and colour index of each meteor, the same for the same seed.
//
// The website paints 42 of them on a canvas, frame by frame. A TV box cannot
// afford a canvas repainted every frame, so here a burst is a HANDFUL of small
// views (Burst.tsx), each one moved, shrunk and faded by ONE animated value on
// the native driver. `flight` turns a meteor's life into the stops of that
// value's interpolations.
const rand = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export type Meteor = {
  angle: number;
  speed: number;
  tail: number;
  size: number;
  color: number;
  delay: number;
  life: number;
};

export const meteors = (count = 42, seed = 1): Meteor[] => {
  const r = rand(seed);
  const out: Meteor[] = [];
  for (let i = 0; i < count; i++) {
    // spread evenly round the circle, then shaken, so there are no gaps
    const angle = (i / count) * Math.PI * 2 + (r() - 0.5) * 0.5;
    out.push({
      angle,
      speed: 0.55 + r() * 0.75, // in box-diagonals per second, at the start
      tail: 0.06 + r() * 0.1, // tail length, box-diagonals
      size: 1.2 + r() * 2.2, // head radius
      color: Math.floor(r() * 4),
      delay: r() * 0.12, // s
      life: 0.9 + r() * 0.6, // s
    });
  }
  return out;
};

// How far a meteor has gone at k (0..1) of its life, in box-diagonals: fast
// out, slowing (burst.js: `speed * life * (1 - (1 - k)^2.4) * 0.5`).
export const travelled = (m: Meteor, k: number) =>
  m.speed * m.life * (1 - Math.pow(1 - Math.max(0, Math.min(1, k)), 2.4)) * 0.5;

// How bright at k of its life: in over the first 15 %, then out.
export const glowAt = (k: number) =>
  k <= 0 || k >= 1 ? 0 : k < 0.15 ? k / 0.15 : 1 - Math.pow((k - 0.15) / 0.85, 1.6);

// One meteor's whole flight as interpolation stops over the burst's 0..1
// (`total` s): where it is (dx, dy in px from the centre, for a box whose
// diagonal is `diag`), how bright, how long its tail still is (1 -> 0.4).
// The stops start and end inside 0..1, flat outside, so one value drives a
// burst of meteors that leave at different moments.
export const flight = (m: Meteor, diag: number, total = 1.7, samples = 8) => {
  const t0 = Math.min(0.9, m.delay / total);
  const t1 = Math.max(t0 + 0.05, Math.min(1, (m.delay + m.life) / total));
  const input: number[] = [];
  const dx: number[] = [];
  const dy: number[] = [];
  const alpha: number[] = [];
  const tail: number[] = [];
  const push = (t: number, k: number) => {
    // (an interpolation's stops must go up: a hair apart is enough)
    const prev = input.length ? input[input.length - 1] : -1;
    const at = t <= prev ? prev + 0.0005 : t;
    const d = travelled(m, k) * diag;
    input.push(+at.toFixed(4));
    dx.push(+(Math.cos(m.angle) * d).toFixed(1));
    dy.push(+(Math.sin(m.angle) * d).toFixed(1));
    alpha.push(+glowAt(k).toFixed(3));
    tail.push(+(1 - k * 0.6).toFixed(3));
  };
  if (t0 > 0.001) push(0, 0);
  for (let i = 0; i <= samples; i++) {
    // more stops early, where the meteor is fast and the light comes up
    const k = Math.pow(i / samples, 1.5);
    push(t0 + (t1 - t0) * k, k);
  }
  if (input[input.length - 1] < 0.999) push(1, 1);
  return {input, dx, dy, alpha, tail};
};
