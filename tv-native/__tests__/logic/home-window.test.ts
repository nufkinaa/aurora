// Home's vertical window (src/homeWindow.ts): which shelves exist for a
// focus, and that nothing the viewer can see is ever a spacer — at rest, in a
// held run, with the commits late, in either direction and through reversals.
import {
  HOME_WINDOW,
  WINDOW,
  Layout,
  Win,
  layoutOf,
  needed,
  nextWindow,
  restOffset,
  sameWin,
  spacerHeight,
  stepToward,
  visibleBetween,
} from '../../src/homeWindow';

// The 960×540 canvas: hero 66% of the height, the focused shelf rests at 27,
// the safe inset under the last shelf.
const HERO = 356;
const VIEW = 540;
const PAGE_Y = 27;
const FOOT = 27;
const POSTER = 247;
const WIDE = 201;

const page = (heights: number[]): Layout => layoutOf(HERO, heights, FOOT, VIEW, PAGE_Y);
const posters = (n: number) => page(Array.from({length: n}, () => POSTER));
// Continue Watching first, then posters — and one shelf with no cards
const mixed = (n: number) => page(Array.from({length: n}, (_, i) => (i === 0 ? WIDE : i === 4 ? 0 : POSTER)));

const PAGES: [string, Layout][] = [
  ['11 poster shelves (Home today)', posters(11)],
  ['15 poster shelves', posters(15)],
  ['24 poster shelves', posters(24)],
  ['Continue Watching + posters, one empty shelf', mixed(16)],
  ['3 shelves', posters(3)],
  ['1 shelf', posters(1)],
];

const rest = (f: number, L: Layout) => restOffset(f < 0 ? undefined : L.tops[f], L.colH, L.viewportH, L.pageY);
const inWin = (w: Win, i: number) => i >= w.from && i <= w.to;
/** Run stepToward until it has nothing left to do; how many commits that took. */
const settle = (cur: Win, f: number, L: Layout): {win: Win; commits: number; mounts: number; drops: number} => {
  let commits = 0;
  let mounts = 0;
  let drops = 0;
  for (;;) {
    const next = stepToward(cur, nextWindow(cur, f, L), f);
    if (next === cur) return {win: cur, commits, mounts, drops};
    const m = (cur.from - next.from > 0 ? cur.from - next.from : 0) + (next.to - cur.to > 0 ? next.to - cur.to : 0);
    const d = (next.from - cur.from > 0 ? next.from - cur.from : 0) + (cur.to - next.to > 0 ? cur.to - next.to : 0);
    // ONE shelf per commit, each way
    expect(m).toBeLessThanOrEqual(1);
    expect(d).toBeLessThanOrEqual(1);
    mounts += m;
    drops += d;
    cur = next;
    if (++commits > 200) throw new Error('stepToward does not converge');
  }
};

test('the switch is OFF: Home mounts every shelf it has reached, as before', () => {
  expect(HOME_WINDOW).toBe(false);
});

test('the slide formula: the focused shelf at the top inset, clamped to the end of the column', () => {
  const L = posters(11);
  expect(rest(-1, L)).toBe(0);
  expect(rest(0, L)).toBe(HERO - PAGE_Y);
  expect(rest(3, L)).toBe(HERO + 3 * POSTER - PAGE_Y);
  // the last shelves cannot travel past the column's end
  expect(rest(10, L)).toBe(L.colH - VIEW);
  expect(rest(10, L)).toBeLessThan(L.tops[10] - PAGE_Y);
  expect(rest(9, L)).toBe(L.tops[9] - PAGE_Y);
});

test('what shows at rest on a poster shelf: the one above (its cards\' feet), it, the next, the heading after', () => {
  const L = posters(11);
  expect(visibleBetween(rest(5, L), rest(5, L), L)).toEqual({from: 4, to: 7});
  expect(visibleBetween(rest(-1, L), rest(-1, L), L)).toEqual({from: 0, to: 0}); // the hero and the first shelf's top
});

test('the numbers in the header: posters need f-3 … f+4', () => {
  const L = posters(15);
  expect(needed(5, L)).toEqual({from: 2, to: 9});
  expect(needed(-1, L)).toEqual({from: 0, to: 3}); // on the hero: the four Home has always mounted first
  expect(needed(0, L)).toEqual({from: 0, to: 4});
  // at the end the column stops travelling, so less comes into view
  expect(needed(14, L)).toEqual({from: 11, to: 14});
});

describe.each(PAGES)('%s', (_name, L) => {
  const n = L.tops.length;

  test('the focused shelf is always in the window', () => {
    for (let f = 0; f < n; f++) {
      expect(inWin(needed(f, L), f)).toBe(true);
      expect(inWin(nextWindow({from: 0, to: 0}, f, L), f)).toBe(true);
    }
  });

  test.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [2, 0],
    [0, 2],
  ])('a held run down to the last shelf and back up to the hero: nothing on screen is a spacer (commits %i presses late, the slide %i shelves behind)', (lag, trail) => {
    const path = [...Array.from({length: n + 1}, (_, i) => i - 1), ...Array.from({length: n}, (_, i) => n - 2 - i)];
    const wins: Win[] = [];
    let win: Win = {from: 0, to: 3};
    for (let k = 0; k < path.length; k++) {
      win = settle(win, path[k], L).win;
      wins.push(win);
      // what is committed when this press lands: the window of `lag` presses ago
      const shown = wins[Math.max(0, k - lag)];
      // where the column can be: anywhere between the rest of `trail` presses ago and this one's
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = Math.max(0, k - trail); j <= k; j++) {
        lo = Math.min(lo, rest(path[j], L));
        hi = Math.max(hi, rest(path[j], L));
      }
      const v = visibleBetween(lo, hi, L, WINDOW.pad);
      if (!v) continue;
      for (let i = v.from; i <= v.to; i++) {
        if (L.h[i] > 0 && !inWin(shown, i)) throw new Error(`press ${k} focus ${path[k]}: shelf ${i} on screen, window ${shown.from}..${shown.to}`);
      }
      if (path[k] >= 0) expect(inWin(shown, path[k]) || lag > 0).toBe(true);
    }
  });

  test('any walk, with reversals at any point (2 presses of lag, 2 of trail)', () => {
    // a fixed pseudo-random walk: runs of 1–9 presses one way, then the other
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const path: number[] = [];
    let f = -1;
    let dir = 1;
    while (path.length < 1500) {
      const run = 1 + Math.floor(rnd() * 9);
      for (let i = 0; i < run; i++) {
        f = Math.max(-1, Math.min(n - 1, f + dir));
        path.push(f);
      }
      dir = -dir;
    }
    const wins: Win[] = [];
    let win: Win = {from: 0, to: 3};
    for (let k = 0; k < path.length; k++) {
      win = settle(win, path[k], L).win;
      wins.push(win);
      const shown = wins[Math.max(0, k - 2)];
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = Math.max(0, k - 2); j <= k; j++) {
        lo = Math.min(lo, rest(path[j], L));
        hi = Math.max(hi, rest(path[j], L));
      }
      const v = visibleBetween(lo, hi, L, WINDOW.pad);
      if (!v) continue;
      for (let i = v.from; i <= v.to; i++) {
        if (L.h[i] > 0 && !inWin(shown, i)) throw new Error(`press ${k} focus ${path[k]}: shelf ${i} on screen, window ${shown.from}..${shown.to}`);
      }
    }
  });

  test('never more than 8 + 2·keep shelves mounted (the window is a window)', () => {
    let win: Win = {from: 0, to: 3};
    for (const f of [...Array.from({length: n}, (_, i) => i), ...Array.from({length: n}, (_, i) => n - 1 - i)]) {
      win = settle(win, f, L).win;
      // (a short Continue Watching shelf or an empty one lets one more into the span)
      expect(win.to - win.from + 1).toBeLessThanOrEqual(8 + 2 * WINDOW.keep + 1);
    }
  });
});

test('a steady hold on poster shelves: one shelf mounted and at most one dropped per press', () => {
  const L = posters(24);
  let win: Win = {from: 0, to: 3};
  win = settle(win, -1, L).win;
  for (let f = 0; f < 24; f++) {
    const s = settle(win, f, L);
    expect(s.mounts).toBeLessThanOrEqual(1);
    expect(s.drops).toBeLessThanOrEqual(1);
    win = s.win;
  }
  expect(win).toEqual({from: 19, to: 23});
  for (let f = 22; f >= -1; f--) {
    const s = settle(win, f, L);
    expect(s.mounts).toBeLessThanOrEqual(1);
    expect(s.drops).toBeLessThanOrEqual(1);
    win = s.win;
  }
  // back on the hero: the top of the page, and nothing below it kept
  expect(win).toEqual({from: 0, to: 4});
});

test('hysteresis: rocking between two shelves mounts and drops nothing after the first swing', () => {
  const L = posters(24);
  let win: Win = {from: 0, to: 3};
  for (let f = 0; f <= 11; f++) win = settle(win, f, L).win;
  win = settle(win, 10, L).win;
  for (let i = 0; i < 20; i++) {
    for (const f of [11, 10]) {
      const s = settle(win, f, L);
      expect(s.commits).toBe(0);
      win = s.win;
    }
  }
  // …and a fast reversal after a long run: the first presses back need nothing new
  win = settle({from: 0, to: 3}, 0, L).win;
  for (let f = 1; f <= 12; f++) win = settle(win, f, L).win;
  expect(settle(win, 11, L).mounts).toBe(0);
});

describe('stepToward', () => {
  test('mounts the missing shelf nearest focus first', () => {
    // focus 6, window 5..8, wanted 3..10: 9 is 3 away, 4 is 2 away
    expect(stepToward({from: 5, to: 8}, {from: 3, to: 10}, 6)).toEqual({from: 4, to: 8});
    expect(stepToward({from: 4, to: 8}, {from: 3, to: 10}, 6)).toEqual({from: 4, to: 9});
  });

  test('never drops the focused shelf, nor one that cannot be given a spacer', () => {
    // wanted 5..9 but focus is still reported on 3: 3 stays
    let w: Win = {from: 3, to: 9};
    w = stepToward(w, {from: 5, to: 9}, 3);
    expect(w).toEqual({from: 3, to: 9});
    // shelf 2 was never measured: it cannot be dropped, so nothing above it is either
    w = stepToward({from: 2, to: 9}, {from: 5, to: 9}, 7, i => i !== 2);
    expect(w).toEqual({from: 2, to: 9});
  });

  test('nothing to do: the same object (no state change, no commit)', () => {
    const w: Win = {from: 2, to: 9};
    expect(stepToward(w, {from: 2, to: 9}, 5)).toBe(w);
    expect(sameWin(w, {from: 2, to: 9})).toBe(true);
  });

  test('a jump (the rows were re-read): starts again at the shelf nearest focus', () => {
    expect(stepToward({from: 0, to: 3}, {from: 9, to: 14}, 12)).toEqual({from: 12, to: 12});
  });
});

describe('the spacer', () => {
  const win: Win = {from: 4, to: 11};
  test('is exactly as tall as the shelf was measured', () => {
    expect(spacerHeight(true, 2, win, 20, 246.857)).toBe(246.857);
    expect(spacerHeight(true, 12, win, 20, 201)).toBe(201);
  });
  test('a shelf in the window, one never measured, an empty one: the shelf itself', () => {
    expect(spacerHeight(true, 4, win, 20, 247)).toBeUndefined();
    expect(spacerHeight(true, 11, win, 20, 247)).toBeUndefined();
    expect(spacerHeight(true, 2, win, 20, undefined)).toBeUndefined();
    expect(spacerHeight(true, 2, win, 0, 247)).toBeUndefined();
  });
  test('the window off: never a spacer', () => {
    for (let i = 0; i < 20; i++) expect(spacerHeight(false, i, win, 20, 247)).toBeUndefined();
  });
  test('the column is the same height, and every shelf at the same y, whatever is mounted', () => {
    // (what Home lays out: a mounted shelf at its own height, a spacer at the measured one)
    const heights = [201, 247, 247, 0, 247, 247, 247];
    const all = layoutOf(HERO, heights, FOOT, VIEW, PAGE_Y);
    const w: Win = {from: 3, to: 5};
    const withSpacers = layoutOf(
      HERO,
      heights.map((h, i) => spacerHeight(true, i, w, h ? 20 : 0, h) ?? h),
      FOOT,
      VIEW,
      PAGE_Y,
    );
    expect(withSpacers).toEqual(all);
  });
});
