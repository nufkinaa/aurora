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

// A HELD KEY LEADS FURTHER. Under a held key the deferred commits can fall
// more than the margin behind: on the Mi TV (5.2.0 device pass, 2026-10-11) a
// held LEFT logged `[row] behind … visible=0..7 mounted=1..11` — the window of
// a focus three presses back, so the left-edge card mounted a press late. The
// rule is the same both ways: while presses keep coming in one direction
// (each within HELD_GAP_MS of the last) the lead grows by one card a press, up
// to HELD_EXTRA more, so a commit running up to lead+HELD_EXTRA presses late
// still finds every card it needs. A turn, or a pause, starts again from the
// plain margin. Only the lead grows: the cards behind are already seen.
export const HELD_GAP_MS = 250;
export const HELD_EXTRA = 2;
/** Presses in one run: `prev` the run so far (n presses, last at `at`). */
export type Run = {dir: Dir; at: number; n: number};
export function nextRun(prev: Run | null, dir: Dir, at: number): Run {
  return prev && prev.dir === dir && at - prev.at <= HELD_GAP_MS ? {dir, at, n: prev.n + 1} : {dir, at, n: 1};
}
const heldCache = new Map<Margins, Margins[]>();
/** The margins for the `n`-th press of a run (the same object for the same
 *  answer, so a caller can compare them by identity). A low-memory box grows
 *  by one card at most. */
export function runMargins(m: Margins, n: number): Margins {
  const max = Math.min(HELD_EXTRA, m.lead);
  const extra = Math.max(0, Math.min(max, n - 1));
  if (!extra) return m;
  let list = heldCache.get(m);
  if (!list) heldCache.set(m, (list = []));
  return list[extra] || (list[extra] = {lead: m.lead + extra, trail: m.trail});
}

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

// WHILE THE SHELF IS STILL SLIDING. The window above is what shows once the
// slide has come to REST on the focused card. Under a held key it has not: the
// slide is a spring that is re-aimed on every press (and starts each time from
// no speed), so at 15-20 presses a second it runs five, six, seven cards
// behind focus. Measured on the Mi TV (2026-10-11): the cards still on screen
// had been unmounted behind it, and a held RIGHT showed an EMPTY shelf with
// one card at its right edge until the key was let go.
//
// So while focus keeps moving, nothing that was mounted is let go: the window
// only GROWS (the union of what was held and what the new focus needs), and it
// is cut back to the resting window once the remote has been still for
// SETTLE_MS, by which time the slide has arrived. HELD_MAX bounds it on a very
// long shelf: the cards furthest behind the direction of travel go first.
export const SETTLE_MS = 700;
export const HELD_MAX = 30;
export function heldWindow(
  prev: {from: number; to: number},
  next: {from: number; to: number},
  dir: Dir,
  max: number = HELD_MAX,
): {from: number; to: number} {
  let from = Math.min(prev.from, next.from);
  let to = Math.max(prev.to, next.to);
  if (to - from > max) {
    // never cut into what the new focus needs
    if (dir > 0) from = Math.min(next.from, to - max);
    else to = Math.max(next.to, from + max);
  }
  return {from, to};
}
