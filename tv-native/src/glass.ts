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
// blur a 6 % see-through shows the page as sharp ghost letters and posters
// under the words (photographed on the Mi TV for the old rail, simulated again
// for this body at 94 % and 97 %). So:
//   - a pane with NOTHING dimming the page behind it is OPAQUE  (glassPane);
//   - a sheet that sits on the 72 % wash takes the recipe's 94 % (glassSheet) -
//     through the wash the ghost is below what the eye sees.
//
// Cost: borders and CSS gradients are drawn into the view's own background once;
// nothing here animates and nothing is added per frame. A blurred boxShadow is
// only on surfaces that stand still (SHADOW) - a pane that SLIDES takes a baked
// picture instead (assets/glass-pane-shadow*.png, tools/gen_glass_shadow.py).
//
// Consts only: no state lives here (profile-scope.test.ts).

/** The pane's body: rgb(40,40,46). */
export const BODY = 'rgb(40,40,46)';
/** The same body over the sheet's wash: 94 %. */
export const BODY_OVER_WASH = 'rgba(40,40,46,0.94)';

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

// The light on the pane, three layers in one background (dp stops):
//   the glow under the top hairline   white 18 % -> 0 over 9 dp
//   the glow over the foot line       white  8 % -> 0 over 8 dp
//   the sheen                         white  5 % -> 0 at 48 % of the height
const LIGHT =
  'linear-gradient(180deg, rgba(255,255,255,0.18) 0px, rgba(255,255,255,0) 9px), ' +
  'linear-gradient(0deg, rgba(255,255,255,0.08) 0px, rgba(255,255,255,0) 8px), ' +
  'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 48%)';
// A small pane (a popup, a toast): the sheen only - a 9 dp glow would fill it.
const LIGHT_SMALL = 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 60%)';

/** The rim: a bright hairline on top, a dimmer one at the foot, barely a line at the sides. */
export const rim = {
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.055)',
  borderTopColor: 'rgba(255,255,255,0.28)',
  borderBottomColor: 'rgba(255,255,255,0.12)',
} as const;
/** The rim of a small thing: thinner light, no glow. */
export const rimThin = {
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.06)',
  borderTopColor: 'rgba(255,255,255,0.20)',
  borderBottomColor: 'rgba(255,255,255,0.07)',
} as const;

/** The shadow of a pane that STANDS STILL (never on one that slides or scales). */
export const SHADOW = '0 12px 32px rgba(0,0,0,0.32), 0 2px 6px rgba(0,0,0,0.20), 0 0 0 1px rgba(0,0,0,0.26)';

/** A pane over the bare page: opaque. Add a radius, and SHADOW if it stands still. */
export const glassPane = {
  backgroundColor: BODY,
  ...rim,
  experimental_backgroundImage: LIGHT,
} as const;
/** A small pane over the bare page (popup, toast, the player's menus): opaque, thin rim, sheen. */
export const glassSmall = {
  backgroundColor: BODY,
  ...rimThin,
  experimental_backgroundImage: LIGHT_SMALL,
} as const;
/** A sheet on the wash: the body at 94 %, the rim, the light, the shadow. */
export const glassSheet = {
  backgroundColor: BODY_OVER_WASH,
  ...rim,
  experimental_backgroundImage: LIGHT,
  boxShadow: SHADOW,
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
