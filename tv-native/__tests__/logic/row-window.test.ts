// The shelf's mounted window (src/rowWindow.ts): a card exists before any
// part of it can be on screen, one card is mounted per press, and the count
// stays bounded.
import {aheadOf, restWindow, rowWindow, visibleRange, Dir, MARGINS, MARGINS_LOW, RowGeom} from '../../src/rowWindow';

const POSTER: RowGeom = {step: 138, cardW: 124, contentLeft: 84, viewportW: 960, lead: 1};
const FRAME: RowGeom = {step: 238, cardW: 224, contentLeft: 84, viewportW: 960, lead: 1};
const SHAPES: [string, RowGeom, number, number][] = [
  // name, geometry, most cards mounted (full margins), most (low memory)
  ['poster', POSTER, 11, 9],
  ['frame', FRAME, 8, 6],
];
const LENGTHS = [1, 2, 5, 7, 8, 12, 24, 40];
const DIRS: Dir[] = [1, -1];

// What is on screen, worked out the long way: card i spans
// [contentLeft + i*step - slide, + cardW) and the viewport is [0, viewportW).
const onScreen = (f: number, n: number, g: RowGeom) => {
  const slide = Math.max(0, f - g.lead) * g.step;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const left = g.contentLeft + i * g.step - slide;
    if (left < g.viewportW && left + g.cardW > 0) out.push(i);
  }
  return out;
};

test('the numbers the design quotes: posters show f-2 … f+5, frames f-2 … f+2', () => {
  expect(visibleRange(0, 40, POSTER)).toEqual({first: 0, last: 6});
  expect(visibleRange(1, 40, POSTER)).toEqual({first: 0, last: 6});
  expect(visibleRange(10, 40, POSTER)).toEqual({first: 8, last: 15});
  expect(visibleRange(0, 40, FRAME)).toEqual({first: 0, last: 3});
  expect(visibleRange(10, 40, FRAME)).toEqual({first: 8, last: 12});
  expect(rowWindow(10, 1, 40, POSTER)).toEqual({from: 7, to: 18}); // f-3 … f+7
  expect(rowWindow(10, -1, 40, POSTER)).toEqual({from: 6, to: 17}); // f-4 … f+6
  expect(rowWindow(10, 1, 40, FRAME)).toEqual({from: 7, to: 15}); // f-3 … f+4
  expect(restWindow(40, POSTER)).toEqual({from: 0, to: 7});
  expect(restWindow(40, FRAME)).toEqual({from: 0, to: 4});
});

describe.each(SHAPES)('%s shelf', (_name, g, maxFull, maxLow) => {
  test('visibleRange is exactly the cards that intersect the viewport', () => {
    for (const n of LENGTHS)
      for (let f = 0; f < n; f++) {
        const v = visibleRange(f, n, g);
        const want = onScreen(f, n, g);
        expect([v.first, v.last]).toEqual([want[0], want[want.length - 1]]);
      }
  });

  test.each([
    ['full', MARGINS, maxFull],
    ['low memory', MARGINS_LOW, maxLow],
  ] as const)('%s margins: every card on screen is mounted, with the margin beyond it, and the count is bounded', (_t, m, max) => {
    for (const n of LENGTHS)
      for (const dir of DIRS)
        for (let f = 0; f < n; f++) {
          const w = rowWindow(f, dir, n, g, m);
          const vis = onScreen(f, n, g);
          for (const i of vis) expect(i >= w.from && i < w.to).toBe(true);
          const first = vis[0];
          const last = vis[vis.length - 1];
          // the margin, clamped to the shelf
          expect(w.to - 1).toBe(Math.min(n - 1, last + (dir > 0 ? m.lead : m.trail)));
          expect(w.from).toBe(Math.max(0, first - (dir > 0 ? m.trail : m.lead)));
          expect(w.to - w.from).toBeLessThanOrEqual(max);
          // the focused card and its neighbours (the next press's target) exist
          for (const i of [f - 1, f, f + 1]) if (i >= 0 && i < n) expect(i >= w.from && i < w.to).toBe(true);
        }
  });

  test('a commit running LATE by as many presses as the margin still shows no hole', () => {
    // The window is set in a transition. If the commits for the last `lag`
    // presses have not landed, what is mounted is the window of focus f∓lag.
    for (const [m, lagMax] of [[MARGINS, 2], [MARGINS_LOW, 1]] as const)
      for (const n of LENGTHS)
        for (const dir of DIRS)
          for (let f = 0; f < n; f++)
            for (let lag = 0; lag <= lagMax; lag++) {
              const was = f - dir * lag;
              if (was < 0 || was >= n) continue;
              const w = rowWindow(was, dir, n, g, m);
              for (const i of onScreen(f, n, g)) {
                // (behind the direction of travel only the trail margin is kept:
                // those cards have already been seen and are sliding away)
                const leading = dir > 0 ? i >= was : i <= was;
                if (leading) expect(i >= w.from && i < w.to).toBe(true);
              }
            }
  });

  test('a steady run mounts at most ONE card per press, in both directions', () => {
    for (const m of [MARGINS, MARGINS_LOW])
      for (const n of LENGTHS)
        for (const dir of DIRS) {
          let f = dir > 0 ? 0 : n - 1;
          let prev = rowWindow(f, dir, n, g, m);
          for (f += dir; f >= 0 && f < n; f += dir) {
            const w = rowWindow(f, dir, n, g, m);
            let mounted = 0;
            for (let i = w.from; i < w.to; i++) if (i < prev.from || i >= prev.to) mounted++;
            expect(mounted).toBeLessThanOrEqual(1);
            prev = w;
          }
        }
  });

  test('turning round: the first press back lands on cards that are already there', () => {
    for (const n of LENGTHS)
      for (const dir of DIRS)
        for (let f = 0; f < n; f++) {
          const back = f - dir;
          if (back < 0 || back >= n) continue;
          const w = rowWindow(f, dir, n, g, MARGINS);
          for (const i of onScreen(back, n, g)) expect(i >= w.from && i < w.to).toBe(true);
        }
  });

  test('a shelf nobody has focused holds exactly what shows', () => {
    for (const n of LENGTHS) {
      const w = restWindow(n, g);
      const vis = onScreen(0, n, g);
      expect(w).toEqual({from: 0, to: vis.length});
    }
    expect(restWindow(0, g)).toEqual({from: 0, to: 0});
  });
});

test('the old rule, for the record: [anchor-3, anchor+5] with the anchor up to 2 behind left on-screen cards unmounted', () => {
  const old = (anchor: number, n: number) => ({from: Math.max(0, anchor - 3), to: Math.min(n, anchor + 6)});
  const missing = (f: number, anchor: number) => {
    const w = old(anchor, 40);
    return onScreen(f, 40, POSTER).filter(i => i < w.from || i >= w.to);
  };
  expect(missing(0, 0)).toEqual([6]); // at rest, first card: the 7th poster's 48dp
  expect(missing(2, 0)).toEqual([6, 7]);
  expect(missing(3, 0)).toEqual([6, 7, 8]); // until the deferred move to anchor 3 commits
  expect(missing(3, 3)).toEqual([]);
  expect(missing(5, 3)).toEqual([9, 10]);
  expect(missing(10, 12)).toEqual([8]); // moving left: the card under the rail's edge
  expect(missing(10, 13)).toEqual([8, 9]); // … and the LEAD card itself, until the move commits
});

test('aheadOf: the next cards beyond the window, the way focus is travelling, clamped', () => {
  expect(aheadOf({from: 7, to: 18}, 1, 40, 6)).toEqual([18, 19, 20, 21, 22, 23]);
  expect(aheadOf({from: 7, to: 18}, 1, 20, 6)).toEqual([18, 19]);
  expect(aheadOf({from: 7, to: 18}, -1, 40, 4)).toEqual([6, 5, 4, 3]);
  expect(aheadOf({from: 2, to: 13}, -1, 40, 4)).toEqual([1, 0]);
  expect(aheadOf({from: 0, to: 9}, -1, 40, 4)).toEqual([]);
  expect(aheadOf({from: 7, to: 18}, 1, 40, 0)).toEqual([]);
});
