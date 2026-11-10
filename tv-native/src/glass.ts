// The TV's glass: one material for everything that floats over the page - the
// nav rail, Browse's filter panel, sheets, the player's menus, the X-Ray sheet,
// the genre popup, toasts. The website's recipe (docs/glass-apple.md §8) in the
// TV's own terms; the reasons and the measurements are in docs/glass-tv.md.
//
// What it is: a dark NEUTRAL pane (no violet or green in it - the page and the
// pictures bring the colour), white words that read whatever is behind, a rim
// of light (a bright hairline on top with a soft glow under it, a dimmer line
// at the foot), a quiet sheen in the upper half, a soft shadow.
//
// What it is not: see-through. A TV panel has no blur behind it, and without a
// blur any see-through shows the page as SHARP ghost letters and posters under
// the words. Photographed on the Mi TV: the old rail at 97 %, and this body at
// the recipe's 94 % on a sheet over its 72 % wash - the title page's own words
// ("written and directed by ...") stood readable inside the sheet. So every
// pane here is OPAQUE; the glass is in the rim, the sheen and the shadow.
//
// Cost. The box draws a pane's blurred boxShadow and every CSS gradient of its
// background again on each frame the screen draws while the pane is up - it is
// not drawn once and kept. Measured on the Mi TV, opening and closing the
// player's menu (median frame, share of late frames):
//
//     before the glass (one gradient, no shadow)          15 ms   2.3 %
//     three blurred shadow layers + five gradients        23 ms   6.5 %
//     the shadow as pictures + five gradients             20 ms   5.0 %
//     the shadow as pictures + ONE gradient               16 ms   3.1 %   (15.5 ms / 2.8 % with no pictures at all)
//
// So: no blurred boxShadow anywhere in the glass, and at most ONE gradient on a
// pane (the sheen, which is as tall as half the pane and so cannot be a fixed
// picture). Everything along a pane's edge - the soft shadow outside it, the
// glow of light inside its rim - is still pictures (tools/gen_glass_edge.py),
// which the box only composites:
//   * a pane of any size (a sheet, a menu, the genre popup, X-Ray): eight
//     pieces round it, components/GlassEdge.tsx;
//   * a pane of a known size (the rail, the filter panel): ONE picture over the
//     whole pane, with its rim and its sheen in it too - those two slide in
//     over the page, and the pane under the picture is a plain round box.
//
// Consts only: no state lives here (profile-scope.test.ts).

/** The pane's body: rgb(40,40,46). */
export const BODY = 'rgb(40,40,46)';
/**
 * A pane that opens ON another pane (the genre popup over the filter panel): one
 * step lighter, or the two bodies run into each other. White is 12.4:1 on it.
 */
export const BODY_RAISED = 'rgb(52,52,58)';

/** What is written on glass. */
export const ink = {
  /** every word and icon */
  text: '#FFFFFF',
  /** the second voice: a description, a value */
  second: '#D0D5E2',
  /** the third voice: a label, a hint - 7.3:1 on the body (the page's faint grey is 2.7:1 there) */
  third: '#B2B8CA',
  /** the CHOSEN word and icon: the accent mixed 60 % with white */
  on: '#B9B0FF',
} as const;

// The sheen: white 5 % at the top -> 0 at 48 % of the pane's height. The one
// gradient a pane carries.
const SHEEN = 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 48%)';
// A toast is 40 dp tall: a little more of it, over a little more of the pill.
const SHEEN_SMALL = 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 60%)';

// The light inside the rim is baked into the edge pictures (gen_glass_edge.py):
//   a menu, a sheet       top  white 22 % -> 0 over 15 dp
//                         side white  7 % -> 0 over 12 dp
//                         foot white 10 % -> 0 over 13 dp  (not on a sheet that stands on the screen's foot)
//   the rail, the         top  white 18 % -> 0 over 9 dp
//   filter panel          foot white  8 % -> 0 over 8 dp
// A menu's is thicker, as the website's second pass gave it: it is what tells
// the pane from the page now that nothing shows through it.

/**
 * The rim of the chrome (the rail, the filter panel): a bright hairline on top,
 * a dimmer one at the foot, barely a line at the sides. These panes do not draw
 * it themselves - it is in their edge picture (gen_glass_edge.py reads the same
 * three numbers); kept here as the one place the values are written.
 */
export const rim = {
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.055)',
  borderTopColor: 'rgba(255,255,255,0.28)',
  borderBottomColor: 'rgba(255,255,255,0.12)',
} as const;
/** The rim of a menu, a sheet, a toast: the same lines, brighter. */
export const rimMenu = {
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.075)',
  borderTopColor: 'rgba(255,255,255,0.36)',
  borderBottomColor: 'rgba(255,255,255,0.16)',
} as const;

/**
 * The glass's shadow is a soft one (0 14 34, black 34 %), a near one (0 3 8,
 * black 22 %), a tight one (0 1 2, black 22 %) and a dark hairline just outside
 * the rim - baked into the edge pictures, see the head of this file. This is
 * the hairline alone, for a pane too small for the pictures (a toast): no blur
 * in it, so it costs a rounded line.
 */
export const HAIRLINE = '0 0 0 0.5px rgba(0,0,0,0.30)';

/**
 * A pane of the chrome over the bare page (the rail, the filter panel): the
 * body alone. Add a radius, and lay the pane's edge picture
 * (assets/glass-pane-edge*.png) OVER it - the picture holds the shadow, the
 * rim, the glow and the sheen.
 */
export const glassPane = {
  backgroundColor: BODY,
} as const;
/** A menu or a sheet (the player's menus, Sheet). Add a radius, and <GlassEdge> as its first child. */
export const glassMenu = {
  backgroundColor: BODY,
  ...rimMenu,
  experimental_backgroundImage: SHEEN,
} as const;
/** A menu that opens on another pane (the genre popup): the raised body. */
export const glassRaised = {
  backgroundColor: BODY_RAISED,
  ...rimMenu,
  experimental_backgroundImage: SHEEN,
} as const;
/** A sheet that stands on the screen's foot (X-Ray, a person's page): no foot line. <GlassEdge radius={24}> first inside it. */
export const glassFootSheet = {
  backgroundColor: BODY,
  ...rimMenu,
  borderBottomWidth: 0,
  experimental_backgroundImage: SHEEN,
} as const;
/** A toast: the menu's lines and the sheen. Add HAIRLINE as its boxShadow. */
export const glassToast = {
  backgroundColor: BODY,
  ...rimMenu,
  experimental_backgroundImage: SHEEN_SMALL,
} as const;

/**
 * "Chosen" on glass: a darker well pressed into the pane - black 40 %, a shadow
 * falling in from its top edge, a light line at its foot - with the word in
 * `ink.on`. Laid as an absolutely-positioned child UNDER the label (a border on
 * a Focusable itself eats the 3 dp its ring is drawn in). The well is never the
 * focus cue: focus stays the white fill / white ring it always was.
 */
export const well = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  borderRadius: 999,
  backgroundColor: 'rgba(0,0,0,0.40)',
  borderTopWidth: 2,
  borderTopColor: 'rgba(0,0,0,0.40)',
  borderBottomWidth: 1,
  borderBottomColor: 'rgba(255,255,255,0.09)',
} as const;
