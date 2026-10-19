// What the viewer can see on Home, in the terms the merge speaks
// (homeMerge.ts Look): which shelves are on screen and which of their cards,
// how many shelves lie above the viewport, the focused card, the billboard.
//
// Derived from the numbers Home already keeps — the column's offset, the
// measured layout (homeWindow.ts), where focus was last on each shelf — and
// from the cards Row keeps MOUNTED around that place (rowWindow.ts), which is
// a little more than what is on screen: holding a card the viewer could not
// quite see is the safe side to err on. Pure, so it is tested
// (__tests__/logic/home-merge.test.ts).
import type {Look} from './homeMerge';
import {Layout, visibleBetween} from './homeWindow';
import {restWindow, rowWindow, RowGeom} from './rowWindow';

export type LookInput = {
  rows: {id: string; items: unknown[]}[];
  layout: Layout;
  /** How far the column has slid up, dp (≥ 0). */
  rest: number;
  /** Where focus was last on each shelf, by row id. */
  lastCard: Map<string, number>;
  /** The shelf that holds focus (-1: the billboard's buttons). */
  focusRow: number;
  focusKey: string | null;
  geomOf: (rowId: string) => RowGeom;
  heroH: number;
  heroCount: number;
  heroIdx: number;
};

export function lookOf(a: LookInput): Look {
  const vis = visibleBetween(a.rest, a.rest, a.layout);
  const shelves: NonNullable<Look['rows']> = [];
  if (vis) {
    for (let i = vis.from; i <= vis.to; i++) {
      const r = a.rows[i];
      if (!r || !r.items.length) continue;
      const g = a.geomOf(r.id);
      const f = a.lastCard.get(r.id);
      const n = r.items.length;
      const w = f != null ? rowWindow(Math.max(0, Math.min(f, n - 1)), 1, n, g) : restWindow(n, g);
      shelves.push({id: r.id, from: w.from, to: w.to});
    }
  }
  const fr = a.focusRow >= 0 ? a.rows[a.focusRow] : undefined;
  const focus = fr && a.focusKey != null ? {rowId: fr.id, key: a.focusKey, index: a.lastCard.get(fr.id) ?? 0} : null;
  return {
    rows: shelves,
    // the shelves before the first one on screen lie wholly above it
    above: vis ? vis.from : a.rest > 0 ? a.rows.length : 0,
    focus,
    // the billboard's art fades out by 0.9 of its height (Home.tsx artFadeOpacity)
    heroVisible: a.rest < a.heroH * 0.9,
    heroIndex: a.heroIdx % Math.max(1, a.heroCount),
  };
}
