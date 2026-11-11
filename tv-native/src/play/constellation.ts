// Aurora Play — a small constellation: one star for each thing counted
// (Taste: a title loved this sitting). Pure; a port of
// public/js/play/constellation.js — the same seed draws the same sky on the
// website and here.
const rng = (seed: number) => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// A number from a string (ids), for the seed.
export const seedOf = (text: string | null | undefined) => {
  let h = 2166136261;
  for (const ch of String(text || '')) h = Math.imul(h ^ (ch.codePointAt(0) as number), 16777619) >>> 0;
  return h || 1;
};

export const MAX_STARS = 12;

export type SkyPoint = {x: number; y: number; r: number};
export type Sky = {points: SkyPoint[]; lines: [number, number][]};

// n stars (1..12) wandering left to right across the box, each joined to the
// next, with one side branch from seven up.
export const constellation = (n: number, seed = 1, {w = 320, h = 110}: {w?: number; h?: number} = {}): Sky => {
  const count = Math.max(0, Math.min(MAX_STARS, Math.floor(Number(n) || 0)));
  if (!count) return {points: [], lines: []};
  const rand = rng(seed);
  const padX = 18;
  const padY = 16;
  const main = count >= 7 ? count - 1 : count; // from seven up, one star hangs off the line
  const step = main > 1 ? (w - padX * 2) / (main - 1) : 0;
  const points: SkyPoint[] = [];
  let y = padY + rand() * (h - padY * 2);
  for (let i = 0; i < main; i++) {
    // each star steps up or down from the one before: a wandering line, never flat
    const span = (h - padY * 2) * (0.28 + rand() * 0.34);
    const dir = y > h * 0.62 ? -1 : y < h * 0.38 ? 1 : rand() < 0.5 ? -1 : 1;
    if (i) y = Math.max(padY, Math.min(h - padY, y + dir * span));
    const x = main > 1 ? padX + i * step + (i && i < main - 1 ? (rand() - 0.5) * step * 0.36 : 0) : w / 2;
    points.push({x: +x.toFixed(1), y: +(main > 1 ? y : h / 2).toFixed(1), r: +(2.4 + rand() * 2.4).toFixed(1)});
  }
  const lines: [number, number][] = [];
  for (let i = 1; i < main; i++) lines.push([i - 1, i]);
  if (main < count) {
    const at = 1 + Math.floor(rand() * (main - 2));
    const from = points[at];
    const up = from.y > h / 2;
    const y2 = up ? Math.max(padY - 6, from.y - 34 - rand() * 14) : Math.min(h - padY + 6, from.y + 34 + rand() * 14);
    points.push({x: +(from.x + (rand() - 0.5) * 26).toFixed(1), y: +y2.toFixed(1), r: +(2.2 + rand() * 1.6).toFixed(1)});
    lines.push([at, points.length - 1]);
  }
  return {points, lines};
};

// One line of a sky as a thin bar: where its middle is, how long it is and how
// far it is turned — what a View needs (a line here is a View, not a path).
export const lineBox = (a: {x: number; y: number}, b: {x: number; y: number}) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    len: Math.hypot(dx, dy),
    deg: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
};
