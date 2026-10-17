// THE RECYCLING SHELF (render switch `pool`; docs/qa/native-lab/7-card-recycling-and-grid.md).
//
// A shelf mounts the cards of its window (rowWindow.ts). With the switch off,
// each card is keyed by its TITLE: a card leaving the window is unmounted (its
// ~33 views deleted) and one entering is mounted (33 created) — measured in the
// lab as the long frames of a held key. With the switch on, the cards sit in
// SLOTS keyed by slot number, and a slot whose title left is handed the title
// that came in: new props on views that already exist, no Fabric mount at all.
// The native track (AuroraRowView + PoolHost.kt) paints the slots in shelf order,
// so the picture is the keyed shelf's.
//
// What this keeps of the keyed shelf, exactly:
//   - WHICH cards are mounted where: the window is rowWindow.ts's, unchanged;
//     a title stays in its slot for as long as it is in the window — also when
//     the shelf is re-read and reordered (Continue Watching: the slot's `left`
//     moves, the views stay, focus stays on the title);
//   - the focused title (the newest focus the shelf heard of) never loses its
//     slot, even if a late commit's window left it out.
// What it adds: up to SPARES cards that LEFT the window stay mounted where they
// were (off screen, beyond the window's margins — a card there is exactly what
// a wider window would show), so the next window move hands them on instead of
// mounting. The lab's pool held the same three (9 slots for a window of 6–9).
// The production window grows while a key is held and is cut back when the
// remote rests (rowWindow.ts heldWindow), so the spares are what the NEXT hold
// starts from; a move that drops and adds cards in one commit (a held window
// past HELD_MAX, a re-read) rebinds directly.
//
// Pure, no React: __tests__/logic/shelf-pool.test.ts.

/** Cards that left the window kept mounted as spares (each holds its decoded picture). */
export const SPARES = 3;

/** slot → the title key it holds, or null for an empty slot (nothing mounted there). */
export type Slots = ReadonlyArray<string | null>;

/**
 * The slots after the window became `want` (title keys, in shelf order).
 *   - a key already in a slot keeps it;
 *   - a new key takes, in this order: the spare FURTHEST from the window, an
 *     empty slot, a new slot at the end;
 *   - `keep` (the focused title) is treated as wanted when it holds a slot;
 *   - of the keys left over (out of the window), the `spares` nearest to it stay,
 *     the rest are emptied (unmounted).
 * `distance(key)` says how far a title that is out of the window is from it
 * (Infinity for one that is no longer on the shelf at all — never kept).
 */
export function assignSlots(
  prev: Slots,
  want: readonly string[],
  distance: (key: string) => number,
  keep: string | null = null,
  spares: number = SPARES,
): (string | null)[] {
  const next = prev.slice();
  const wanted = new Set(want);
  if (keep != null && next.includes(keep)) wanted.add(keep);
  const placed = new Set<string>();
  for (const k of next) if (k != null && wanted.has(k)) placed.add(k);
  // the spares, furthest first: the first to be handed on
  const spare = next
    .map((k, s) => ({k, s}))
    .filter((x): x is {k: string; s: number} => x.k != null && !wanted.has(x.k))
    .sort((a, b) => distance(b.k) - distance(a.k) || a.s - b.s);
  let si = 0;
  for (const k of want) {
    if (placed.has(k)) continue;
    placed.add(k);
    if (si < spare.length) {
      next[spare[si++].s] = k;
      continue;
    }
    const empty = next.indexOf(null);
    if (empty >= 0) next[empty] = k;
    else next.push(k);
  }
  // what is left of the spares: the nearest `spares` stay, if they are still on the shelf
  const left = spare.slice(si).sort((a, b) => distance(a.k) - distance(b.k) || a.s - b.s);
  left.forEach((x, i) => {
    if (i >= spares || !Number.isFinite(distance(x.k))) next[x.s] = null;
  });
  while (next.length && next[next.length - 1] == null) next.pop();
  return next;
}

/** How far shelf index `i` is from the window [from, to): 0 inside it. */
export const outside = (i: number, from: number, to: number): number => (i < from ? from - i : i >= to ? i - to + 1 : 0);
