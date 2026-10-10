// Which cards of a shelf exist — derived from what can be ON SCREEN.
//
// The rule this replaces mounted [anchor-3, anchor+5] and moved `anchor` only
// when focus was 3 cards away from it. On a 960dp canvas a poster shelf shows
// cards f-2 … f+5 around the focused card f (the two outer ones in part), so
// with the anchor 1 or 2 behind, the right-most one or two cards ON SCREEN did
// not exist; every third press mounted three at once, inside the viewport —
// "I can see cards being filled when I scroll right" (elia, 2026-10-10).
//
// Now: the window is the cards that intersect the viewport for this focus,
// plus a MARGIN beyond each edge, and it follows focus one card per press. A
// card is therefore made (and its picture asked for) one or two presses
// before any part of it can be seen, and a press mounts ONE card, off screen,
// instead of three every third press.
//
// Pure — no React, no react-native — so the geometry is tested on its own
// (__tests__/logic/row-window.test.ts).

export type RowGeom = {
  /** A card plus the gap after it, dp. */
  step: number;
  /** The card's width, dp. */
  cardW: number;
  /** Where card 0's left edge sits when the shelf has not slid, dp. */
  contentLeft: number;
  /** The viewport's width, dp. */
  viewportW: number;
  /** How many cards stay to the left of the focused one once sliding. */
  lead: number;
};

export type Dir = 1 | -1;
/** Cards kept beyond the last visible one: `lead` in the direction of travel,
 *  `trail` behind it. */
export type Margins = {lead: number; trail: number};

// AHEAD two: a mount is deferred (a transition), so on a slow box the commit
// for a press can land a press or two late — two cards of margin is two
// presses of a held key (50–110 ms each) before a missing card could show.
// BEHIND one: the slide is a spring and trails a held key by 1–2 cards, so the
// card that has just left the resting viewport is still partly on screen.
export const MARGINS: Margins = {lead: 2, trail: 1};
// A box short of memory holds less: one ahead, none behind (9 posters, the
// count the old rule kept, but placed where the viewport is).
export const MARGINS_LOW: Margins = {lead: 1, trail: 0};

/** How far the shelf has slid, at rest, with card `f` focused. */
export const slideFor = (f: number, g: RowGeom) => Math.max(0, f - g.lead) * g.step;

/** The cards any part of which is inside the viewport at rest, focus on `f`
 *  — inclusive indices, clamped to the shelf. */
export function visibleRange(f: number, n: number, g: RowGeom): {first: number; last: number} {
  const tx = slideFor(f, g);
  // card i spans [contentLeft + i*step - tx, … + cardW); on screen when its
  // right edge is > 0 and its left edge is < viewportW
  const first = Math.floor((tx - g.contentLeft - g.cardW) / g.step) + 1;
  const last = Math.ceil((tx + g.viewportW - g.contentLeft) / g.step) - 1;
  return {first: Math.max(0, first), last: Math.min(n - 1, last)};
}

/** The mounted slice [from, to) for focus on `f`, travelling `dir`. */
export function rowWindow(f: number, dir: Dir, n: number, g: RowGeom, m: Margins = MARGINS): {from: number; to: number} {
  const v = visibleRange(f, n, g);
  const before = dir > 0 ? m.trail : m.lead;
  const after = dir > 0 ? m.lead : m.trail;
  return {from: Math.max(0, v.first - before), to: Math.min(n, v.last + after + 1)};
}

/** A shelf nobody has focused yet: exactly what shows, no margin (Home mounts
 *  several shelves at once and each card is 11–14 views). */
export function restWindow(n: number, g: RowGeom): {from: number; to: number} {
  const v = visibleRange(0, n, g);
  return {from: v.first, to: v.last + 1};
}

/** The cards whose pictures are worth fetching before they are mounted: the
 *  next `count` beyond the window in the direction of travel. */
export function aheadOf(win: {from: number; to: number}, dir: Dir, n: number, count: number): number[] {
  const out: number[] = [];
  if (dir > 0) for (let i = win.to; i < Math.min(n, win.to + count); i++) out.push(i);
  else for (let i = win.from - 1; i >= Math.max(0, win.from - count); i--) out.push(i);
  return out;
}
