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
// Cost: borders and CSS gradients are drawn into the view's own background once;
// nothing here animates and nothing is added per frame. There is no blurred
// boxShadow in the glass: the box blurs it again on every frame it draws, even
// on a pane that stands still (three layers on the player's menu took opening
// it from 14 ms to 23 ms a frame on the Mi TV). The soft shadow is baked
// pictures (tools/gen_glass_shadow.py): one whole picture for a pane of a known
// size (the rail, the filter panel: assets/glass-pane-shadow*.png), nine pieces
// round a pane of any size (components/GlassShadow.tsx).
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

const SHEEN = 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 48%)';

// The light on a pane of the CHROME (the rail, the filter panel), three layers
// in one background (dp stops):
//   the glow under the top hairline   white 18 % -> 0 over 9 dp
//   the glow over the foot line       white  8 % -> 0 over 8 dp
//   the sheen                         white  5 % -> 0 at 48 % of the height
const LIGHT =
  'linear-gradient(180deg, rgba(255,255,255,0.18) 0px, rgba(255,255,255,0) 9px), ' +
  'linear-gradient(0deg, rgba(255,255,255,0.08) 0px, rgba(255,255,255,0) 8px), ' +
  SHEEN;
// The light on a MENU or a SHEET - a thicker rim, as the website's second pass
// gave them: it is what tells the pane from the page now that nothing shows
// through it.
//   the glow under the top line       white 22 % -> 0 over 15 dp
//   a faint glow down each side       white  7 % -> 0 over 12 dp
//   the glow over the foot line       white 10 % -> 0 over 13 dp   (not on a sheet that stands on the screen's foot)
//   the sheen
const GLOW_TOP = 'linear-gradient(180deg, rgba(255,255,255,0.22) 0px, rgba(255,255,255,0) 15px)';
const GLOW_SIDES =
  'linear-gradient(90deg, rgba(255,255,255,0.07) 0px, rgba(255,255,255,0) 12px), ' +
  'linear-gradient(270deg, rgba(255,255,255,0.07) 0px, rgba(255,255,255,0) 12px)';
const GLOW_FOOT = 'linear-gradient(0deg, rgba(255,255,255,0.10) 0px, rgba(255,255,255,0) 13px)';
const LIGHT_MENU = GLOW_TOP + ', ' + GLOW_SIDES + ', ' + GLOW_FOOT + ', ' + SHEEN;
const LIGHT_FOOT_SHEET = GLOW_TOP + ', ' + GLOW_SIDES + ', ' + SHEEN;
// A toast: the sheen only - it is 40 dp tall, a 15 dp glow would fill it.
const LIGHT_SMALL = 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 60%)';

/** The rim of the chrome: a bright hairline on top, a dimmer one at the foot, barely a line at the sides. */
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
 * the rim - baked into pictures, see the head of this file. This is the
 * hairline alone, for a pane too small for the pictures (a toast): no blur in
 * it, so it costs a rounded line.
 */
export const HAIRLINE = '0 0 0 0.5px rgba(0,0,0,0.30)';

/** A pane of the chrome over the bare page (the rail, the filter panel). Add a radius; its shadow is a baked picture. */
export const glassPane = {
  backgroundColor: BODY,
  ...rim,
  experimental_backgroundImage: LIGHT,
} as const;
/** A menu or a sheet (the player's menus, Sheet). Add a radius, and <GlassShadow> as its first child. */
export const glassMenu = {
  backgroundColor: BODY,
  ...rimMenu,
  experimental_backgroundImage: LIGHT_MENU,
} as const;
/** A menu that opens on another pane (the genre popup): the raised body. */
export const glassRaised = {
  backgroundColor: BODY_RAISED,
  ...rimMenu,
  experimental_backgroundImage: LIGHT_MENU,
} as const;
/** A sheet that stands on the screen's foot (X-Ray, a person's page): no foot line, no foot glow. */
export const glassFootSheet = {
  backgroundColor: BODY,
  ...rimMenu,
  borderBottomWidth: 0,
  experimental_backgroundImage: LIGHT_FOOT_SHEET,
} as const;
/** A toast: the menu's lines and the sheen. Add HAIRLINE as its boxShadow. */
export const glassToast = {
  backgroundColor: BODY,
  ...rimMenu,
  experimental_backgroundImage: LIGHT_SMALL,
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
