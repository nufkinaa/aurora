// The shelf's arithmetic, stated once as pure functions so three things can
// share it: the native row's JS wrapper (components/Row.tsx NativeRow), the
// Kotlin twin (android/.../ui/row/RowMath.kt) and the fixtures that hold the
// two together (tools/gen-row-fixtures.js → src/test/resources/row-fixtures.json).
//
// The JS reference row (JsRow) keeps these same expressions INLINE, untouched —
// the fixture generator re-states them from Row.tsx and refuses to write a
// fixture if this file ever disagrees with them.
//
// No imports: the generator executes this file on plain node.

/** Cards to the LEFT of the focused one once the shelf is sliding (Row.tsx LEAD). */
export const LEAD = 1;
/** The mounted window either side of its anchor (Row.tsx VISIBLE_AHEAD / _BEHIND). */
export const VISIBLE_AHEAD = 5;
export const VISIBLE_BEHIND = 3;
/** The anchor follows focus only once focus is this far from it (Row.tsx WINDOW_SLACK). */
export const WINDOW_SLACK = 3;

/** Where the shelf rests with card `index` focused, in dp: never right of 0, and
 *  NOT clamped at the far end — the last card rests one card in from the left
 *  margin like any other (Row.tsx focusCard). */
export const slideTarget = (index: number, step: number, lead: number = LEAD): number =>
  -Math.max(0, (index - lead) * step);

/** The window's anchor after focus lands on `index` (Row.tsx focusCard's setAnchor). */
export const nextAnchor = (prev: number, index: number, slack: number = WINDOW_SLACK): number =>
  Math.abs(index - prev) >= slack ? index : prev;

/** The mounted slice `[from, to)` of a shelf of `count` cards (Row.tsx from/to). */
export const windowRange = (
  anchor: number,
  count: number,
  behind: number = VISIBLE_BEHIND,
  ahead: number = VISIBLE_AHEAD,
): {from: number; to: number} => ({
  from: Math.max(0, anchor - behind),
  to: Math.min(count, anchor + ahead + 1),
});

/** Which card a direct child of the track is, from its laid-out left edge in dp
 *  (slots sit at `contentLeft + index * step`, Row.tsx). Rounded, so a child
 *  that is a few dp off its slot's edge (a flattened slot hands the row the
 *  card itself) still names its slot; clamped to the shelf. */
export const indexOfLeft = (left: number, contentLeft: number, step: number, count: number): number => {
  if (!(step > 0)) return 0;
  const i = Math.floor((left - contentLeft) / step + 0.5);
  const hi = count > 0 ? count - 1 : Number.MAX_SAFE_INTEGER;
  return Math.min(hi, Math.max(0, i));
};
