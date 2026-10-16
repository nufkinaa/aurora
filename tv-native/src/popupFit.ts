// HOW TALL A POPUP MAY BE — pure numbers, so the two panel sizes this app
// meets (the Mi TV and the Streamer lay out at 960x540 dp, plenty of sets at
// 1280x720) are checked by a test (__tests__/logic/popup-fit.test.ts) rather
// than found on a sofa.
//
// "On tv settings popup in playback is overflowing and not contained with
// scroll" (owner, 2026-10-17): the player's gear menu had no scroller at all,
// so on a film with several dubs and an intro to mark its foot stood on the
// transport bar and its head went past the top of the screen. Every popup now
// has a ceiling from here AND scrolls inside it; Android's ScrollView brings
// the focused row into view by itself (ReactScrollView.requestChildFocus), so
// the ceiling is the only number the layouts need.
//
// The TV safe area: a set may crop up to 5% of each edge (overscan), so
// nothing that must be read is drawn there.
export const SAFE_FRACTION = 0.05;
export const safeInset = (winH: number) => Math.round(winH * SAFE_FRACTION);

// The player's menus stand on the transport bar: `bottom` dp from the foot.
export const MENU_BOTTOM = 124;
// …and never take more than this much of the screen, so the title line above
// stays readable (the 62% the menu style always had).
export const MENU_SHARE = 0.62;
// A ceiling that leaves at least three rows, whatever the screen.
export const MENU_MIN = 140;

/** The tallest a player menu may be, in dp, on a screen `winH` dp tall. */
export const menuMaxHeight = (winH: number, bottom: number = MENU_BOTTOM): number =>
  Math.max(MENU_MIN, Math.min(Math.round(winH * MENU_SHARE), winH - bottom - safeInset(winH)));

/** A centred sheet (Sheet.tsx) inside a backdrop padded `pad` dp all round. */
export const sheetMaxHeight = (winH: number, pad: number): number =>
  Math.max(MENU_MIN, winH - 2 * Math.max(pad, safeInset(winH)));

/** A sheet that rises from the foot of the screen (X-Ray, a person): what it
 *  wants, but never past the safe area at the top. */
export const bottomSheetMaxHeight = (winH: number, want: number): number =>
  Math.max(MENU_MIN, Math.min(want, winH - safeInset(winH)));
