// The TV's second look for what floats over the page - a neutral glass - and
// the switch that turns it on, surface by surface. It is OFF everywhere.
//
// The story (docs/glass-tv.md, the last section): the app was moved to this
// glass in one round, two judges went over it twice, and then elia saw the nav
// rail and the player's menus on the Mi TV and ruled (2026-11-10): "We don't
// need to copy, we want to be our own ... before it looked better." So the
// rail and every player menu are Aurora's own look again, as released in
// 5.9.2, and nothing of this file touches them. The surfaces he had not seen
// yet keep both looks, and GLASS_NEW below says which one is drawn:
//
//     false   Aurora's own look, as 5.9.2 drew it (the code beside each switch
//             is the released code)
//     true    the neutral glass described here
//
// The glass: a dark NEUTRAL pane (no violet or green in it), white words that
// read whatever is behind, a rim of light (a bright hairline on top with a soft
// glow under it, a dimmer line at the foot), a quiet sheen in the upper half, a
// soft shadow. Not see-through: a TV panel has no blur behind it, and without
// a blur any see-through shows the page as SHARP ghost letters under the words
// (photographed on the Mi TV at the recipe's 94 %), so every pane is opaque.
//
// Cost. The box draws a pane's blurred boxShadow and every CSS gradient of its
// background again on each frame the screen draws while the pane is up. So the
// glass has no blurred boxShadow, at most ONE gradient on a pane (the sheen),
// and everything along a pane's edge - the soft shadow outside it, the glow of
// light inside its rim - is pictures (tools/gen_glass_edge.py), which the box
// only composites:
//   * a pane of any size (a sheet, the genre menu, X-Ray): eight pieces round
//     it, components/GlassEdge.tsx;
//   * a pane of a known size that slides (Browse's filter pane): ONE picture
//     over the whole pane, with its rim and its sheen in it too, and the pane
//     under the picture a plain round box.
//
// Consts only: no state lives here (profile-scope.test.ts).
import theme from './theme';

const {colors} = theme;

/**
 * Old look or new, per surface. One line each: `false` is Aurora's own look as
 * released in 5.9.2, `true` the neutral glass. All false until elia says
 * otherwise (the pairs he judges from are in docs/qa/glass-tv/elia/).
 */
export const GLASS_NEW: {
  readonly sheets: boolean;
  readonly xray: boolean;
  readonly filter: boolean;
  readonly toast: boolean;
} = {
  /**
   * Sheet.tsx and all it carries: the title sheet (hold OK on a poster), "What's
   * wrong with this copy?", Recommend, report a problem, join by code, Pick
   * together's sheets - and, inside them, a focused button without its drop shadow.
   */
  sheets: false,
  /** X-Ray and a person's sheet: the two that stand on the screen's foot (and their focus, as above). */
  xray: false,
  /** Browse's filter pane, the chips on it, and the genre menu (Picker, also on My List). */
  filter: false,
  /** Toasts. */
  toast: false,
};

/** The pane's body: rgb(40,40,46). */
export const BODY = 'rgb(40,40,46)';
/**
 * A pane that opens ON another pane (the genre menu over the filter pane): one
 * step lighter, or the two bodies run into each other. White is 12.4:1 on it.
 */
const BODY_RAISED = 'rgb(52,52,58)';

/** What is written on glass. */
export const ink = {
  /** every word and icon */
  text: '#FFFFFF',
  /** the second voice: a description, a value */
  second: '#D0D5E2',
  /** the third voice: a label, a hint - 7.3:1 on the body (the page's faint grey is 2.7:1 there) */
  third: '#B2B8CA',
  /** the SET word (a chip, a menu row) and a kicker: the accent mixed 60 % with white */
  on: '#B9B0FF',
} as const;

// The same four voices in Aurora's own look: the page's colours (theme.ts).
const PAGE_INK = {
  text: colors.text,
  second: colors.textDim,
  third: colors.textFaint,
  on: colors.accent,
} as const;

/** The four voices on a Sheet, on X-Ray / a person's sheet, on the filter pane: the glass's or the page's, by the switch. */
export const sheetInk = GLASS_NEW.sheets ? ink : PAGE_INK;
export const xrayInk = GLASS_NEW.xray ? ink : PAGE_INK;
export const filterInk = GLASS_NEW.filter ? ink : PAGE_INK;

/**
 * No drop shadow under a focus ring: what a Focusable inside an opaque glass
 * sheet asks for (components/Focusable.tsx FlatFocus). The shadow is there to
 * lift a focused element off a PICTURE; on a flat grey sheet it did nothing but
 * show where the sheet's scroll boxes cut it - a square dark box round a round
 * button (Mi TV, the title sheet's Play and X-Ray's first face).
 */
export const NO_SHADOW = '0 0 0 rgba(0,0,0,0)';

// The sheen: white 5 % at the top -> 0 at 48 % of the pane's height. The one
// gradient a pane carries.
const SHEEN = 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 48%)';
// A toast is 40 dp tall: a little more of it, over a little more of the pill.
const SHEEN_SMALL = 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 60%)';

// The light inside the rim is baked into the edge pictures (gen_glass_edge.py):
//   a menu, a sheet       top  white 22 % -> 0 over 15 dp
//                         side white  7 % -> 0 over 12 dp
//                         foot white 10 % -> 0 over 13 dp  (not on a sheet that stands on the screen's foot)
//   the filter pane       top  white 18 % -> 0 over 9 dp
//                         foot white  8 % -> 0 over 8 dp
// The filter pane's own rim is in its picture too: a 1 dp line, white 28 % on
// top, 12 % at the foot, 5.5 % down the sides.

/** The rim of a menu, a sheet, a toast: a bright hairline on top, a dimmer one at the foot, barely a line at the sides. */
const rimMenu = {
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
 * The filter pane over the bare page: the body alone. Add a radius, and lay
 * the pane's edge picture (assets/glass-pane-edge-wide.png) OVER it - the
 * picture holds the shadow, the rim, the glow, the sheen, and the ground: under
 * the pane's foot (it floats 11 dp above the screen's) the picture is opaque in
 * the page's dark, so no scrap of the page shows there.
 */
export const glassPane = {
  backgroundColor: BODY,
} as const;
/** A menu or a sheet (Sheet, the genre menu). Add a radius, and <GlassEdge> as its first child. */
export const glassMenu = {
  backgroundColor: BODY,
  ...rimMenu,
  experimental_backgroundImage: SHEEN,
} as const;
/** A menu that opens on another pane (the genre menu over the filter pane): the raised body. */
export const glassRaised = {
  backgroundColor: BODY_RAISED,
  ...rimMenu,
  experimental_backgroundImage: SHEEN,
} as const;
/** A sheet that stands on the screen's foot (X-Ray, a person's sheet): no foot line. <GlassEdge radius={24}> first inside it. */
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
 * "Chosen" on glass (a chip on the filter pane): a darker well pressed into the
 * pane - black 40 %, a shadow falling in from its top edge, a light line at its
 * foot - with the word in `ink.on`. Laid as an absolutely-positioned child UNDER
 * the label (a border on a Focusable itself eats the 3 dp its ring is drawn
 * in). The well is never the focus cue: focus stays the white ring.
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
