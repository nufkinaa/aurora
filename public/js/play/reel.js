// Aurora Play — the draw's reel (pure; the screen is js/screens/pickforme.js,
// the look is the PICK FOR ME section of css/play.css).
//
// The reel is one strip of poster-sized cells moving up behind a window; the
// cell at the window is "at the payline". Positions are counted in cells:
// 0 = the first cell is in the window, 1 = the second, and so on.
//
//   landingStrip(n, winner, len)  -> the picks' indices to put on the strip,
//       in the server's order, going round as often as it takes, the last
//       one `winner` (so the reel passes the others and stops on it).
//   respinStrip(n, from, to)  -> the short strip for "Another one": from the
//       pick that was showing to the next, one other in between when there is
//       one.
//   reelPos(t, last)  t in 0..1 -> where the strip is (in cells) on the way
//       to cell `last`: fast, slowing, a hair past the payline and back.
//   cellAt(pos)  -> the cell at the payline (for the tick as each one passes).
//   nextDraw(i, n)  -> the pick after i, round to the first again.
//   stripShift(pos, cells)  -> the strip's translateY in % of its own height.
//   handCols(n, room, min, gap)  -> how many of the hand's n cards go in one
//       row of `room` px so the rows come out even (six cards where five fit
//       are dealt 3 + 3, never 5 + 1).
//   nudge(top, bottom, a, b, centre)  -> how far to scroll (px, + is down) so
//       the block a..b sits in the free band top..bottom of the window: its
//       head under the bar when it is taller than the band, the middle when
//       `centre` is asked, else only as far as it takes to show all of it.
export const LAND_MS = 1900;
export const RESPIN_MS = 700;
export const HOLD_MS = 260;

const whole = (v) => Math.max(0, Math.floor(Number(v) || 0));
const mod = (a, n) => ((a % n) + n) % n;

export const landingStrip = (n, winner = 0, len = 9) => {
  n = whole(n);
  if (!n) return [];
  const w = mod(whole(winner), n);
  if (n === 1) return [0];
  const size = Math.max(2, whole(len));
  return Array.from({ length: size }, (_, k) => mod(w - (size - 1 - k), n));
};

export const respinStrip = (n, from, to) => {
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
export const reelPos = (t, last) => {
  t = Math.max(0, Math.min(1, Number(t) || 0));
  const end = Math.max(0, Number(last) || 0);
  if (t >= 1 || !end) return end;
  const base = end * (1 - Math.pow(1 - t, 3));
  const u = Math.max(0, (t - 0.68) / 0.32);
  return base + OVER * Math.sin(Math.PI * u);
};

export const cellAt = (pos) => Math.max(0, Math.round(Number(pos) || 0));

export const nextDraw = (i, n) => {
  n = whole(n);
  return n ? mod(whole(i) + 1, n) : 0;
};

export const stripShift = (pos, cells) => {
  const c = Math.max(1, whole(cells));
  return -((Number(pos) || 0) / c) * 100;
};

export const handCols = (n, room, min = 168, gap = 20) => {
  n = whole(n);
  if (!n) return 1;
  const most = Math.max(1, Math.floor(((Number(room) || 0) + gap) / (min + gap)));
  return Math.ceil(n / Math.ceil(n / most));
};

export const nudge = (top, bottom, a, b, centre = false) => {
  const room = bottom - top;
  const h = b - a;
  if (!(room > 0) || h >= room) return a - top;
  if (centre) return a - (top + (room - h) / 2);
  if (a < top) return a - top;
  if (b > bottom) return b - bottom;
  return 0;
};
