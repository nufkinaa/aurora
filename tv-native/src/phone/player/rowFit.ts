// The phone player's bottom row (Subtitles · Audio & more · Speed · X-Ray · Watch together ·
// Fill / Fit · Rotate · Next) — how big its round buttons are drawn — PURE, tested.
//
// Held upright with a next episode the row asked for ~440 dp on a 411 dp phone and pushed
// "Next" off the screen's edge (ui-phone 2026-11-10). So: the buttons keep their 48 dp and
// "Next" its word while all fit; then the buttons give a little (down to 44); then "Next"
// becomes a round button like the others (its name stays) and the buttons share what is
// left, never under 36 (Tap's hitSlop keeps every target 48 dp).

export const BTN = 48;
export const BTN_SNUG = 44;
export const BTN_MIN = 36;
export const GAP = 2; // the row's gap
export const NEXT_WORD_W = 90; // the "▶▶ Next" pill (14 + 22 + 4 + the word + 14) and its 4 margin

export type RowFit = {size: number; nextWord: boolean};

/**
 * @param room     the row's width (the window less the side paddings), dp
 * @param buttons  how many round buttons (Next not counted)
 * @param next     a next episode (the Next button is there)
 */
export function playerRowFit(room: number, buttons: number, next: boolean): RowFit {
  const gaps = (n: number) => Math.max(0, n - 1) * GAP;
  if (!next) {
    const size = Math.floor((room - gaps(buttons)) / Math.max(1, buttons));
    return {size: Math.max(BTN_MIN, Math.min(BTN, size)), nextWord: false};
  }
  // with the word
  const withWord = Math.floor((room - NEXT_WORD_W - gaps(buttons + 1)) / Math.max(1, buttons));
  if (withWord >= BTN_SNUG) return {size: Math.min(BTN, withWord), nextWord: true};
  // Next as one more round button
  const round = Math.floor((room - gaps(buttons + 1) - 4) / (buttons + 1));
  return {size: Math.max(BTN_MIN, Math.min(BTN, round)), nextWord: false};
}
