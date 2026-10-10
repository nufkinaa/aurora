// The recycling shelf and grid: which SLOT shows which ITEM.
//
// A shelf (components/Row.tsx, `exp pool`) or a grid (components/NativeGrid.tsx,
// `impl.grid`) mounts a fixed pool of card slots ONCE and never unmounts them
// while it scrolls. When the mounted window moves, the slots that fell out of it
// are handed the items that came in — a commit that changes props only, so
// Fabric creates and deletes no views (docs/qa/native-bench/POOL-PLAN.md).
//
// The whole scheme is one line: item `i` lives in slot `i mod pool`. A window is
// at most `pool` consecutive indices, so no two of its items share a slot; and
// an item that is in the window before AND after a move keeps its slot, so only
// the slots whose item left are touched — never the focused one, which is in
// every window the anchor rule can produce.
//
// Pure functions, no imports: tools/gen-pool-fixtures.js executes this file on
// plain node, proves the invariants over every focus walk it can think of, and
// writes the fixtures the Kotlin twin (android/.../ui/pool/PoolMath.kt) is held to.

/** How many slots a window of `behind` + the anchor + `ahead` needs. */
export const poolSize = (behind: number, ahead: number): number => behind + ahead + 1;

/** The slot item `index` lives in. */
export const slotOf = (index: number, pool: number): number => ((index % pool) + pool) % pool;

/** Slot → the item it shows for the window `[from, to)`, or -1 for a slot the
 *  window does not fill (the window is shorter than the pool at either end of a
 *  shelf). `to - from` must not exceed `pool`. */
export const slotItems = (from: number, to: number, pool: number): number[] => {
  const out: number[] = [];
  for (let s = 0; s < pool; s++) out.push(-1);
  for (let i = from; i < to; i++) out[slotOf(i, pool)] = i;
  return out;
};

/** The shelf's anchor after focus lands on `index` — Row.tsx's rule
 *  (`|index - prev| >= slack ? index : prev`) with one guard the reference does
 *  not need: the move is refused when `latest`, the newest focus JS has heard
 *  of, would fall outside the window it produces. That can only happen when
 *  this thread is several presses behind a reversal; the reference would
 *  unmount the focused card there, the pool would hand its slot to another
 *  item. Holding the old window does neither, and the later events (which
 *  carry `latest`) settle it. */
export const poolAnchor = (
  prev: number,
  index: number,
  latest: number,
  count: number,
  slack: number,
  behind: number,
  ahead: number,
): number => {
  const next = Math.abs(index - prev) >= slack ? index : prev;
  if (next === prev) return prev;
  const from = Math.max(0, next - behind);
  const to = Math.min(count, next + ahead + 1);
  return latest >= from && latest < to ? next : prev;
};

// ---- the grid ---------------------------------------------------------------
//
// Rows of `cols` cards. The pool is whole rows: row `r` lives in row-slot
// `r mod poolRows`, card (r, c) in slot `(r mod poolRows) * cols + c`.
//
// Unlike a shelf, the grid's window is ALWAYS `poolRows` rows long (or the whole
// grid when it is shorter): rows that are mounted outside the viewport are
// clipped by the scroll view, so mounting them changes nothing on screen, and a
// window of constant length means the pool never grows or shrinks while moving.

/** Rows mounted above / below the anchor row, and how far focus may drift from
 *  the anchor before it follows. The viewport shows ~2.4 rows and the scroll
 *  view brings the focused row in by the smallest move, so up to two rows on
 *  either side of the focused one can be on screen; the anchor lags focus by at
 *  most `slack - 1` rows, hence 3 behind. One more ahead, the way you travel. */
export const GRID_BEHIND = 3;
export const GRID_AHEAD = 4;
export const GRID_SLACK = 2;

export const gridRows = (count: number, cols: number): number => (cols > 0 ? Math.ceil(count / cols) : 0);

/** The mounted rows `[from, to)` around `anchorRow`: `behind` above it, slid
 *  back from the end so the window stays full length. */
export const gridWindow = (
  anchorRow: number,
  rows: number,
  behind: number = GRID_BEHIND,
  ahead: number = GRID_AHEAD,
): {from: number; to: number} => {
  const pool = poolSize(behind, ahead);
  const from = Math.max(0, Math.min(anchorRow - behind, rows - pool));
  return {from, to: Math.min(rows, from + pool)};
};

/** The grid's anchor row after focus lands in `row` — the shelf's rule and
 *  guard, in rows, against the grid's own window. */
export const gridAnchor = (
  prev: number,
  row: number,
  latestRow: number,
  rows: number,
  slack: number = GRID_SLACK,
  behind: number = GRID_BEHIND,
  ahead: number = GRID_AHEAD,
): number => {
  const next = Math.abs(row - prev) >= slack ? row : prev;
  if (next === prev) return prev;
  const w = gridWindow(next, rows, behind, ahead);
  return latestRow >= w.from && latestRow < w.to ? next : prev;
};

/** Slot → item for the rows `[fromRow, toRow)` of a grid of `count` items, -1
 *  where the slot's row is not mounted or the last row ends before its column. */
export const gridSlotItems = (
  fromRow: number,
  toRow: number,
  cols: number,
  count: number,
  poolRows: number,
): number[] => {
  const out: number[] = [];
  for (let s = 0; s < poolRows * cols; s++) out.push(-1);
  for (let r = fromRow; r < toRow; r++) {
    const base = slotOf(r, poolRows) * cols;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i < count) out[base + c] = i;
    }
  }
  return out;
};

/** Which item a direct child of the grid is, from its laid-out left / top edge
 *  in dp (cells sit at `col * colPitch`, `row * rowPitch`). Rounded, clamped. */
export const gridIndexOf = (
  left: number,
  top: number,
  colPitch: number,
  rowPitch: number,
  cols: number,
  count: number,
): number => {
  if (!(colPitch > 0) || !(rowPitch > 0) || !(cols > 0)) return 0;
  const col = Math.min(cols - 1, Math.max(0, Math.floor(left / colPitch + 0.5)));
  const row = Math.max(0, Math.floor(top / rowPitch + 0.5));
  const i = row * cols + col;
  const hi = count > 0 ? count - 1 : Number.MAX_SAFE_INTEGER;
  return Math.min(hi, Math.max(0, i));
};

/** The order a container paints its slots in: by top, then left — the order the
 *  items would have as ordinary children. Returns child indices. (A focused
 *  card's shadow falls on the neighbours painted before it and under the ones
 *  painted after, so the paint order is part of the picture.) */
export const paintOrder = (tops: number[], lefts: number[]): number[] => {
  const n = tops.length;
  const p: number[] = [];
  for (let i = 0; i < n; i++) p.push(i);
  // insertion sort: stable, and the input is nearly sorted
  for (let i = 1; i < n; i++) {
    const v = p[i];
    let j = i - 1;
    while (j >= 0 && (tops[p[j]] > tops[v] || (tops[p[j]] === tops[v] && lefts[p[j]] > lefts[v]))) {
      p[j + 1] = p[j];
      j--;
    }
    p[j + 1] = v;
  }
  return p;
};
