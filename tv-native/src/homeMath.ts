// Home's column and billboard arithmetic, stated once as pure functions so three
// things can share it: Home.tsx's native path (impl.hero), the Kotlin twin
// (android/.../ui/home/HomeMath.kt) and the fixtures that hold the two together
// (tools/gen-home-fixtures.js → src/test/resources/home-fixtures.json).
//
// The JS reference (Home.tsx with impl.hero off) keeps these same expressions
// INLINE, untouched — the fixture generator re-states them from Home.tsx and
// refuses to write a fixture if this file ever disagrees with them.
//
// No imports: the generator executes this file on plain node.

/** The nativeIDs the native column reads to know where focus landed (HomeMath.kt markerOf). */
export const COL_TOP_ID = 'aurora-col-top';
export const colRowId = (index: number): string => `aurora-col-row-${index}`;

/** In `targets`: "this row has not been measured yet" — any value > 0; a real target is <= 0. */
export const NO_TARGET = 1;

/** Where the column rests with the row at `y` focused (Home.tsx toRow): the row's
 *  heading `pageY` from the top, clamped so the column never travels past its own
 *  bottom. dp, <= 0. */
export const rowTarget = (y: number, colH: number, height: number, pageY: number): number =>
  -Math.min(Math.max(0, y - pageY), Math.max(0, colH - height)) + 0;

/** The `targets` prop: one entry per row slot, NO_TARGET where `rowY` has a hole. */
export const columnTargets = (
  rowY: ReadonlyArray<number | undefined | null>,
  colH: number,
  height: number,
  pageY: number,
): number[] => {
  const out: number[] = [];
  for (let i = 0; i < rowY.length; i++) {
    const y = rowY[i];
    out.push(y == null ? NO_TARGET : rowTarget(y, colH, height, pageY));
  }
  return out;
};

/** The two column offsets the art fade runs between (Home.tsx artFade's inputRange):
 *  gone at `fadeOutAt`, whole from `fadeInAt` up to 0. */
export const artFadeStops = (heroH: number): {fadeOutAt: number; fadeInAt: number} => ({
  fadeOutAt: -Math.round(heroH * 0.9),
  fadeInAt: -Math.round(heroH * 0.3),
});

/** The art's opacity at a column offset: `[fadeOutAt, fadeInAt, 0] → [0, 1, 1]`, clamped —
 *  what the native interpolation node computes (the QA trace `hero.art` on the JS path). */
export const artFadeAt = (offset: number, heroH: number): number => {
  const {fadeOutAt, fadeInAt} = artFadeStops(heroH);
  if (offset >= fadeInAt) return 1;
  if (offset <= fadeOutAt) return 0;
  return 0 + (1 - 0) * (offset - fadeOutAt) / (fadeInAt - fadeOutAt);
};
