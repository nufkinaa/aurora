// Which of Home's shelves exist — the vertical twin of rowWindow.ts.
//
// Home never unmounted a shelf it had passed: ~340 views at the top of the
// page became ~760 after one walk to the last shelf, each shelf holding 7–11
// decoded pictures. With the window ON a shelf is either MOUNTED or stands as
// a SPACER of its exact measured height, so the column's height and every
// shelf's y never change and the slide's targets (Home's rowY / toRow) do not
// move.
//
// THE SWITCH IS OFF (HOME_WINDOW below) and Home is then exactly what it was.
// Why, and what has to be seen on the TV before it is turned on, is written
// at the constant.
//
// THE RULE, AND WHERE ITS NUMBERS COME FROM (540dp canvas, poster shelf 247dp,
// the focused shelf rests at the 27dp top inset):
//  • At rest on shelf f the viewport shows f-1 (the feet of its cards), f,
//    f+1 and the heading of f+2.
//  • A held key moves focus one shelf per ~110 ms; the column is a spring and
//    TRAILS the target by one or two shelves. So what is on screen during a
//    run is the viewport of any focus up to 2 presses back.
//  • A mount is a transition: the commit for a press can land a press or two
//    LATE. So the window on screen may be the one computed up to 2 presses ago.
//  Both at once: the window computed for focus g must hold everything the
//  viewport shows for any focus from g-2 to g+2 (`steps`), i.e. every shelf
//  that intersects the span from rest(g-2) to rest(g+2) + the viewport,
//  widened by `pad` dp for ink that spills a shelf's box. For posters that is
//  g-3 … g+4: EIGHT shelves, in either direction of travel.
//  • HYSTERESIS: a shelf is mounted when it enters that span and dropped only
//    when it is `keep` shelves outside it, so a shelf at the edge is not
//    mounted and unmounted by a viewer rocking up and down: 8 to 10 mounted.
//  • ONE SHELF PER COMMIT (stepToward): a press that would change two shelves
//    (heights differ; a reversal) is spread over consecutive commits, nearest
//    the focus first. The focused shelf is never dropped.
//
// What that buys, honestly: Home today has 11 shelves, so in the middle of
// the page one or two are spacers; at the last shelf five or six (about 300
// views and 15–25 MB of pictures). A narrower window would save more and
// cannot be shown safe from here — see the constant.
//
// Pure — no React, no react-native — and tested on its own
// (__tests__/logic/home-window.test.ts).

/** Home builds only the shelves near focus. OFF: every shelf reached stays
 *  mounted, as before.
 *
 *  OFF because three things cannot be proved without the TV, and each is
 *  worse than the memory this saves if it goes wrong:
 *   1. THE REMOUNT'S COST AT HOLD SPEED. Today a held DOWN mounts a shelf per
 *      press only the first time through; with the window it does so on every
 *      pass, up and down (7–11 cards, ~50–110 views per commit). The lab's
 *      60–150 ms frames came from exactly such commits.
 *   2. THE PICTURES. A remounted card draws at once only if its bitmap is
 *      still in the image pipeline's memory cache (artPrefetch re-warms the
 *      shelves next to the window at rest, but a hold outruns a rest).
 *   3. FOCUS RESTORE. A remounted shelf is a new focus guide; it is pointed at
 *      the card focus was on by a native command (Row.tsx), which has to land
 *      before focus arrives — it has ≥ 3 shelves of time, measured nowhere.
 *  The device checklist is in the commit message and the report. */
export const HOME_WINDOW: boolean = false;

/** Shelves `from` … `to`, inclusive. Empty when to < from. */
export type Win = {from: number; to: number};

export type WindowCfg = {
  /** Presses of commit lag and of spring trail the window must absorb. */
  steps: number;
  /** Shelves beyond the needed span a mounted shelf may stay (hysteresis). */
  keep: number;
  /** dp around the viewport that count as "on screen" (focus halo, shadow). */
  pad: number;
};
export const WINDOW: WindowCfg = {steps: 2, keep: 1, pad: 24};

/** Shelf heights nobody has measured yet (a shelf below everything mounted so
 *  far): Row's pitch for a poster shelf and for Continue Watching. */
export const EST_SHELF_H = 247;
export const EST_WIDE_H = 201;

export type Layout = {
  /** Each shelf's top inside the column, dp. */
  tops: number[];
  /** Each shelf's height, dp. */
  h: number[];
  /** The column's full height (hero + shelves + foot). */
  colH: number;
  viewportH: number;
  /** Where a focused shelf comes to rest below the viewport's top. */
  pageY: number;
};

/** `top`: where shelf 0 starts (the hero's height). `foot`: what follows the
 *  last shelf (the safe inset). */
export function layoutOf(top: number, heights: number[], foot: number, viewportH: number, pageY: number): Layout {
  const tops: number[] = [];
  let y = top;
  for (const hh of heights) {
    tops.push(y);
    y += hh;
  }
  return {tops, h: heights, colH: y + foot, viewportH, pageY};
}

/** How far the column has travelled, at rest, with a shelf at `y` focused —
 *  THE formula Home's toRow slides to (it calls this), so the window and the
 *  slide cannot disagree. `y` undefined: the hero band (or a shelf not laid
 *  out yet) — the top. */
export function restOffset(y: number | undefined, colH: number, viewportH: number, pageY: number): number {
  if (y == null) return 0;
  return Math.min(Math.max(0, y - pageY), Math.max(0, colH - viewportH));
}

const restFor = (f: number, L: Layout) => restOffset(f < 0 ? undefined : L.tops[Math.min(f, L.tops.length - 1)], L.colH, L.viewportH, L.pageY);

/** The shelves any part of which lies within `pad` of the viewport when the
 *  column has travelled anywhere between `a` and `b`. Null: none. */
export function visibleBetween(a: number, b: number, L: Layout, pad = 0): Win | null {
  const lo = Math.min(a, b) - pad;
  const hi = Math.max(a, b) + L.viewportH + pad;
  let from = -1;
  let to = -1;
  for (let i = 0; i < L.tops.length; i++) {
    if (L.h[i] <= 0) continue; // an empty shelf draws nothing
    if (L.tops[i] < hi && L.tops[i] + L.h[i] > lo) {
      if (from < 0) from = i;
      to = i;
    }
  }
  return from < 0 ? null : {from, to};
}

/** What must be mounted with focus on shelf `f` (-1: the hero band). */
export function needed(f: number, L: Layout, cfg: WindowCfg = WINDOW): Win {
  const n = L.tops.length;
  if (!n) return {from: 0, to: -1};
  const g = Math.max(-1, Math.min(f, n - 1));
  const a = restFor(Math.max(-1, g - cfg.steps), L);
  const b = restFor(Math.min(n - 1, g + cfg.steps), L);
  const v = visibleBetween(a, b, L, cfg.pad) || {from: Math.max(0, g), to: Math.max(0, g)};
  // the focused shelf, whatever the geometry says
  return g < 0 ? v : {from: Math.min(v.from, g), to: Math.max(v.to, g)};
}

/** Where the window should be for focus on `f`, coming from `prev`: everything
 *  needed, plus what `prev` already had within `keep` shelves of it. */
export function nextWindow(prev: Win | null, f: number, L: Layout, cfg: WindowCfg = WINDOW): Win {
  const must = needed(f, L, cfg);
  if (!prev || prev.to < prev.from) return must;
  const n = L.tops.length;
  const keepFrom = Math.max(0, must.from - cfg.keep);
  const keepTo = Math.min(n - 1, must.to + cfg.keep);
  return {
    from: Math.min(must.from, Math.max(prev.from, keepFrom)),
    to: Math.max(must.to, Math.min(prev.to, keepTo)),
  };
}

/** One commit's worth of the way from `cur` to `target`: at most ONE shelf
 *  mounted (the missing one nearest focus) and at most ONE dropped (never one
 *  `canDrop` refuses — a shelf whose height is not known cannot be replaced
 *  by a spacer — and never the focused one). Returns `cur` itself when there
 *  is nothing to do. */
export function stepToward(cur: Win, target: Win, f: number, canDrop: (i: number) => boolean = () => true): Win {
  if (target.to < target.from) return cur;
  // Nothing mounted, or the two do not touch (a jump — a D-pad never makes
  // one, a re-read of the rows can): start again at the shelf nearest focus.
  if (cur.to < cur.from || cur.to < target.from - 1 || cur.from > target.to + 1) {
    const at = Math.max(target.from, Math.min(f, target.to));
    return {from: at, to: at};
  }
  let {from, to} = cur;
  // mount one
  const up = from - 1 >= target.from ? from - 1 : null;
  const down = to + 1 <= target.to ? to + 1 : null;
  if (up != null && down != null) {
    if (Math.abs(up - f) < Math.abs(down - f)) from = up;
    else to = down;
  } else if (up != null) from = up;
  else if (down != null) to = down;
  // drop one — the one farther from focus first
  const dropTop = from < target.from && from !== f && canDrop(from);
  const dropBottom = to > target.to && to !== f && canDrop(to);
  if (dropTop && dropBottom) {
    if (Math.abs(from - f) >= Math.abs(to - f)) from++;
    else to--;
  } else if (dropTop) from++;
  else if (dropBottom) to--;
  return from === cur.from && to === cur.to ? cur : {from, to};
}

export const sameWin = (a: Win, b: Win) => a.from === b.from && a.to === b.to;

/** The height of the spacer that stands in for shelf `i`, or undefined when
 *  the shelf itself is to be mounted: with the window off; inside the window;
 *  when it has never been measured (there is no height to give a spacer, so
 *  it stays); and when it has no cards (it draws nothing and is 0 tall). The
 *  spacer's height IS the measured height — that is the whole guarantee that
 *  nothing below it moves. */
export function spacerHeight(on: boolean, i: number, win: Win, cards: number, measured: number | undefined): number | undefined {
  if (!on || (i >= win.from && i <= win.to) || cards <= 0) return undefined;
  return measured;
}

