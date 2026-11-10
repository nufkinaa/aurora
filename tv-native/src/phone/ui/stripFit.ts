// How wide each button of a sideways strip is (a title page's round actions) — PURE, tested.
//
// elia 2026-11-10, of the title page's round buttons: "It's also not clear enough that this
// has more elements and can be scrolled horizontally". At 411 dp five 76 dp buttons ended
// flush with the screen's edge and the sixth showed 1 dp. So when the strip holds more than
// fits, the buttons are sized (as close to their own width as can be) for the last one in
// sight to be cut about in half: a strip that plainly runs on. When all fit, nothing changes.

export type StripFit = {
  /** the strip's width: the screen's (the strip runs edge to edge) */
  room: number;
  /** how many buttons */
  count: number;
  /** the room before the first button */
  lead: number;
  /** between two buttons */
  gap: number;
  /** a button's own width */
  base: number;
  /** the narrowest and widest a button may be made */
  min: number;
  max: number;
};

/** A button's width: `base` if all fit; otherwise the width nearest `base` within [min, max]
 *  that shows k whole buttons and half of the next; `base` if no such width exists. */
export function stripItemWidth({room, count, lead, gap, base, min, max}: StripFit): number {
  if (count <= 0 || room <= 0) return base;
  const all = lead + count * base + (count - 1) * gap;
  if (all <= room) return base;
  let best = base;
  let off = Infinity;
  for (let k = 1; k < count; k++) {
    // k slots (button + gap) and half a button after them fill what is left after the lead
    const w = (room - lead - k * gap) / (k + 0.5);
    if (w < min || w > max) continue;
    const d = Math.abs(w - base);
    if (d < off) {
      off = d;
      best = Math.floor(w * 10) / 10;
    }
  }
  return best;
}
