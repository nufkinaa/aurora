// Aurora Play — the draw's reel (pure). A port of public/js/play/reel.js, rule
// for rule; the tests hold the two to the same answers
// (__tests__/logic/play-rules.test.ts).
//
// The reel is one strip of poster-sized cells moving up behind a window; the
// cell at the window is "at the payline". Positions are counted in cells:
// 0 = the first cell is in the window, 1 = the second, and so on.
export const LAND_MS = 1900;
export const RESPIN_MS = 700;
export const HOLD_MS = 260;

const whole = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
const mod = (a: number, n: number) => ((a % n) + n) % n;

// The picks' indices to put on the strip, in the server's order, going round
// as often as it takes, the last one `winner`.
export const landingStrip = (n: number, winner = 0, len = 9): number[] => {
  n = whole(n);
  if (!n) return [];
  const w = mod(whole(winner), n);
  if (n === 1) return [0];
  const size = Math.max(2, whole(len));
  return Array.from({length: size}, (_, k) => mod(w - (size - 1 - k), n));
};

// The short strip for "Another one": from the pick that was showing to the
// next, one other in between when there is one.
export const respinStrip = (n: number, from: number, to: number): number[] => {
  n = whole(n);
  if (!n) return [];
  const a = mod(whole(from), n);
  const b = mod(whole(to), n);
  if (n < 3) return a === b ? [b] : [a, b];
  let mid = mod(b + 1, n);
  if (mid === a) mid = mod(b + 2, n);
  return [a, mid, b];
};

// Out-cubic to the cell, plus a small bump over the last third: the reel runs
// a few hundredths of a cell past the payline and settles back onto it.
const OVER = 0.07;
export const reelPos = (t: number, last: number): number => {
  t = Math.max(0, Math.min(1, Number(t) || 0));
  const end = Math.max(0, Number(last) || 0);
  if (t >= 1 || !end) return end;
  const base = end * (1 - Math.pow(1 - t, 3));
  const u = Math.max(0, (t - 0.68) / 0.32);
  return base + OVER * Math.sin(Math.PI * u);
};

export const cellAt = (pos: number) => Math.max(0, Math.round(Number(pos) || 0));

// The pick after i, round to the first again.
export const nextDraw = (i: number, n: number) => {
  n = whole(n);
  return n ? mod(whole(i) + 1, n) : 0;
};

// Where the strip is at `samples` + 1 even moments of a roll to cell `last`,
// as the two lists an Animated interpolation takes: the animation runs 0 -> 1
// at a steady pace and the curve is in the stops, so the whole landing is one
// value on the native driver (no JS per frame). `cell` is one cell's height.
// `from`: where the strip stands when the roll begins (the waiting reel is
// somewhere between two card backs when the answer comes), 0 by default.
export const reelStops = (last: number, cell: number, samples = 48, from = 0) => {
  const n = Math.max(2, whole(samples));
  const end = Math.max(0, Number(last) || 0);
  const start = Math.max(0, Math.min(end, Number(from) || 0));
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    inputRange.push(t);
    outputRange.push(-(start + reelPos(t, end - start)) * cell);
  }
  return {inputRange, outputRange};
};
