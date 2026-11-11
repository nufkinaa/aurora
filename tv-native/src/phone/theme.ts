// The phone app's design tokens: the website's glass look at phone sizes.
//
// 1.0.1 (2026-10-29, "closer to the mobile website, dimensions and all"):
// every number here was MEASURED from the website's computed styles in Chrome's
// mobile emulation at the Pixel 9's size (411 x 923 css px, scale 2.625, glass
// look) — docs/android-phone/WEB-PARITY.md has the table. A css px on a phone
// is a dp, so they carry over 1:1.
//
// Colours: the glass look's own (public/css/glass.css html[data-look="glass"]),
// which differ from the shared TV tokens (src/theme.ts) on purpose: the greys
// are "two steps brighter than the classic look" and the ground is #070811.
import {colors as shared} from '../theme';

export const colors = {
  ...shared,
  bg: '#070811', // glass.css --bg
  textDim: '#c2c7d6', // glass.css --text-dim
  textFaint: '#8c93a8', // glass.css --text-faint
  // the glass, "Clear" (glass E — elia's choice of five for the website,
  // 2026-11-11: docs/qa/glass-options/README.md on the website side). The
  // website dims what is behind its bars (backdrop brightness 0.48 under a
  // fifth of black): 0.8 x 0.48 lets 38 % of the picture's light through.
  // React Native has no live backdrop, so the app's body does the dimming
  // itself: 62 % of black lets the same 38 % through — the same picture
  // behind, the same words over it, without a blur (3 px on the website).
  glass: 'rgba(4,4,10,0.7)', // --g-fill-slab: a pane in the page (rows, cards)
  glassStrong: 'rgba(4,4,10,0.84)',
  glassEdge: 'rgba(255,255,255,0.3)', // the light line all round (--g-edge)
  glassTop: 'rgba(255,255,255,0.65)', // …brighter along the top (0.5 over the 0.3 line)
  glassDark: 'rgba(4,4,10,0.94)', // menus and the search suggestions
  /** --g-ink-quiet / --g-ink-dim: the quiet words ON a pane, lifted from the page's greys */
  inkQuiet: '#c0c5d2',
  inkDim: '#dde0e8',
  tabPill: 'rgba(255,255,255,0.1)', // --g-well
  kicker: 'rgba(255,255,255,0.10)',
  kickerFilm: '#f0c67e',
  kickerSeries: '#7fd1e8',
  owned: '#6fe0b0', // on this device / downloaded (the site's mint)
  danger: '#ff6b6b',
  scrim: 'rgba(5,6,12,0.55)',
  // .chip / .cat-pill / .picker-btn off, and the lit one
  chip: 'rgba(0,0,4,0.58)', // --g-fill-chip
  chipEdge: 'rgba(255,255,255,0.24)', // --g-edge-thin
  chipOn: 'rgba(255,255,255,0.1)', // --g-well over the chip
};

/** Glass E's bodies (theme of 2026-11-11). `chrome`: what floats over pictures
 *  (the tab bar, the round buttons, the title page's buttons, the player's
 *  pills) — the website's dim, done by the body (see colors.glass above).
 *  `thick`: what carries lines of words (sheets, menus, toasts, the player's
 *  menus) — the website frosts these 10 px; with no frost, sharp words behind
 *  would show between the lines, so the body is fuller (the website's own
 *  rule where it cannot blur: near-opaque). `slab`: panes in the page;
 *  `chip`: chips and pills in the page (no blur on the website either). */
export const E = {
  chrome: 'rgba(0,0,4,0.62)',
  // (0.88 / 0.82 were tried first on the Pixel 9: the page's words and the
  // player's frame showed sharp between the lines — "text on text"; the
  // website's own rule where it cannot frost is a near-opaque body)
  thick: 'rgba(4,4,10,0.94)',
  /** a sheet over the page's 55 % dim: a touch less body (the dim does part of it) */
  sheet: 'rgba(4,4,10,0.92)',
  slab: 'rgba(4,4,10,0.7)',
  chip: 'rgba(0,0,4,0.58)',
  /** the chosen tab / a lit chip: a lighter capsule with its own line (--g-well) */
  well: 'rgba(255,255,255,0.1)',
  /** a pressed step over any of them (--g-lift) */
  lift: 'rgba(255,255,255,0.1)',
} as const;

/** The site's --g-sheen: a faint light from the top over every glass body. */
export const G_FILL = 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 40%)';

/** --g-edge, glass E: a 1 px light line all round inside (0.3), brighter
 *  along the top (0.5 laid over it = 0.65), a little brighter along the foot
 *  (0.14 over it = 0.4), and a dark hairline OUTSIDE (it parts the glass from
 *  a white poster). Borders draw the inside lines (1 dp, the layout the old
 *  edge had); the outside line is a 1 dp spread shadow with no blur — a
 *  plain ring, no blur pass (Android 9+; older phones keep the light lines). */
export const G_EDGE = {
  borderWidth: 1,
  borderTopColor: 'rgba(255,255,255,0.65)',
  borderLeftColor: 'rgba(255,255,255,0.3)',
  borderRightColor: 'rgba(255,255,255,0.3)',
  borderBottomColor: 'rgba(255,255,255,0.4)',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.38)',
} as const;
/** --g-edge-thick (sheets, menus, toasts): the top line 0.52 over the 0.3 one, the outside line 0.4. */
export const G_EDGE_THICK = {
  ...G_EDGE,
  borderTopColor: 'rgba(255,255,255,0.66)',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
} as const;
/** --g-edge-thin (chips, small things in the page): 0.24 all round, 0.4 over it on top, outside 0.3. */
export const G_EDGE_THIN = {
  borderWidth: 1,
  borderTopColor: 'rgba(255,255,255,0.54)',
  borderLeftColor: 'rgba(255,255,255,0.24)',
  borderRightColor: 'rgba(255,255,255,0.24)',
  borderBottomColor: 'rgba(255,255,255,0.24)',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.3)',
} as const;
/** --g-well + --g-well-edge: the chosen tab, a lit chip — 0.3 all round, 0.36 over it on top. */
export const G_WELL = {
  backgroundColor: 'rgba(255,255,255,0.1)',
  borderWidth: 1,
  borderTopColor: 'rgba(255,255,255,0.55)',
  borderLeftColor: 'rgba(255,255,255,0.3)',
  borderRightColor: 'rgba(255,255,255,0.3)',
  borderBottomColor: 'rgba(255,255,255,0.3)',
} as const;
/** The edge with the depth under it (--g-edge + --g-shadow), for what floats:
 *  the tab bar, the round buttons. Drawn around the shape only (RN clips it
 *  out under the body), unlike Android's elevation, which darkens a
 *  see-through body from below. */
export const G_EDGE_FLOAT = {
  ...G_EDGE,
  boxShadow: '0 0 0 1px rgba(0,0,0,0.38), 0 6px 18px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.3)',
} as const;
/** --g-edge-thick + --g-shadow-menu: a menu or a sheet's depth. */
export const G_EDGE_MENU = {
  ...G_EDGE_THICK,
  boxShadow: '0 0 0 1px rgba(0,0,0,0.4), 0 14px 36px rgba(0,0,0,0.42), 0 2px 6px rgba(0,0,0,0.3)',
} as const;
/** Words on the clearest glass carry a soft shadow of their own (0 1px 3px rgba(0,0,0,.6)). */
export const G_WORDS = {
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowOffset: {width: 0, height: 1},
  textShadowRadius: 3,
} as const;

export const space = {xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32};
// the page gutter (`--page-x` = 16px at 411)
export const GUTTER = 16;

export const radius = {s: 8, m: 12, l: 16, xl: 20, hero: 24, pill: 999};

export const font = {
  hero: 33.6, // .hero-title
  title: 34.5, // .detail-title
  h1: 24, // .browse-head h1 ("Movies", "My List", "Settings")
  row: 17.6, // .row-title
  body: 15.68, // .detail-synopsis, .greet-sub
  small: 13.76, // cast lines, "More"
  tiny: 11.2, // the action row's words, the kicker
};

// Cards (.card.poster 114 x 171, .card.wide 254 x 158.8, 9 px apart in a row)
export const POSTER_W = 114;
export const POSTER_H = 171;
export const FRAME_W = 254;
export const FRAME_H = 159;
export const EP_W = 264; // .episode (still 264 x 148.5)
export const SHELF_GAP = 9;

// Hit targets: Android's 48dp minimum (the site's are 40–44; the app keeps a
// 48 dp touch area with hitSlop where the drawn control is smaller).
export const TAP = 48;
// The floating tab bar (.nav-items: 53 tall, 12 from the sides, 10 from the bottom)
export const TAB_H = 53;
export const TAB_INSET = 10;
export const TAB_SIDE = 12;

export default {colors, space, radius, font, GUTTER, TAP};
