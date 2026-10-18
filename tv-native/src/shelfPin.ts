// The focused title keeps its place when its shelf is re-read.
//
// Home reads /api/home again whenever it comes back on screen and its last
// read is 15 s old or more (Home.tsx), and the server composes a fresh answer
// whenever its kept one is older than 30 s or anything it was built from
// changed (src/lib/answermemo.js). A fresh answer is NOT the same shelf: the
// billboard is drawn at random each time and the shelves leave out whatever
// the billboard shows, so the titles of a shelf shift by a place or more
// between two reads — and Continue Watching reorders after a film.
//
// Row knows focus only as an INDEX (its window, its slide, the pool's kept
// slot are all derived from it). So after a long visit to Home (more than
// 15 s, then a card, then BACK) the re-read moved the pressed title to
// another index while focus was on it; the window, still built around the
// old index, no longer held it; the card unmounted under the focus that
// Android had just given back to it, and focus.ts's rescue sent it to the
// billboard's Play button — "BACK takes me to the hero" (2026-10-18).
//
// The rule: on the shelf that last held a focused card, the title focus was
// on stays at the index focus was on; every other title keeps the server's
// order around it. A title that is gone from the new list is HELD there too
// when the pin carries it (`item`): the device pass found the recommendation
// shelves re-ranked by every write of the profile (a taste answer, a My List
// add on another screen), so the pressed title had often left its shelf
// altogether — its card unmounted under the focus and focus.ts sent focus to
// the billboard just the same. It stays until the next re-read with focus
// elsewhere. Without `item` (and after a ✕, which drops the pin: Row.tsx) a
// title that is gone is not brought back.
//
// Pure — tested in __tests__/logic/shelf-pin.test.tsx.

/** The title focus was on (by identity), where it stood (by index), and the
 *  title itself — what is held in place if the re-read no longer has it. */
export type Pin<T = unknown> = {key: string; index: number; item?: T};

/** `items` with the pinned title moved back to `pin.index` (clamped to the
 *  shelf). The SAME array when nothing has to move — a re-read that did not
 *  reorder must not hand the shelf a new list. */
export function pinFocused<T>(items: T[], keyOf: (item: T) => string, pin: Pin<T> | null): T[] {
  if (!pin || !items) return items;
  const at = items.findIndex(it => keyOf(it) === pin.key);
  if (at < 0) {
    // gone from the re-read: held where focus is, when the pin carries it
    if (pin.item === undefined || !items.length) return items;
    const out = items.slice();
    out.splice(Math.min(Math.max(0, pin.index), out.length), 0, pin.item);
    return out;
  }
  if (items.length < 2) return items;
  const to = Math.min(Math.max(0, pin.index), items.length - 1);
  if (at === to) return items;
  const out = items.slice();
  out.splice(at, 1);
  out.splice(to, 0, items[at]);
  return out;
}
