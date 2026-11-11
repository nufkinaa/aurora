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
  // the glass: the site's --g-fill (a light sheen over the sky) and its edge light
  glass: 'rgba(255,255,255,0.07)',
  glassStrong: 'rgba(255,255,255,0.12)',
  glassEdge: 'rgba(255,255,255,0.14)',
  glassTop: 'rgba(255,255,255,0.38)', // --g-edge: inset 0 1px 0 rgba(255,255,255,.38)
  glassDark: 'rgba(10,12,22,0.8)', // menus and the search suggestions
  // the tab bar's pill on the tab you are on (.nav-item.active)
  tabPill: 'rgba(255,255,255,0.14)',
  kicker: 'rgba(255,255,255,0.10)',
  kickerFilm: '#f0c67e',
  kickerSeries: '#7fd1e8',
  owned: '#6fe0b0', // on this device / downloaded (the site's mint)
  danger: '#ff6b6b',
  scrim: 'rgba(5,6,12,0.55)',
  // .chip / .cat-pill / .picker-btn off, and the lit one
  chip: 'rgba(255,255,255,0.07)',
  chipEdge: 'rgba(255,255,255,0.10)',
  chipOn: 'rgba(255,255,255,0.16)',
};

/** The site's --g-fill as a React Native gradient (glass.css): the sheen on every glass surface. */
export const G_FILL = 'linear-gradient(135deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.025) 55%, rgba(255,255,255,0.06) 100%)';
/** The site's --g-edge, as border colours: a bright top edge, a softer left one, a faint rest. */
export const G_EDGE = {
  borderWidth: 1,
  borderTopColor: 'rgba(255,255,255,0.38)',
  borderLeftColor: 'rgba(255,255,255,0.16)',
  borderRightColor: 'rgba(255,255,255,0.07)',
  borderBottomColor: 'rgba(255,255,255,0.06)',
} as const;

/* ---- Glass E ("Clear") on the chrome over pictures (2026-11-11) -----------
   elia chose E for the website ("I think E looks the best!!") and for the phone
   app, then narrowed it: "Not everything needs to change to this … make sure
   we are not losing too much color". So E is ONLY on what floats over a
   picture — the tab bar, the round top buttons, the logo pill, the glass
   buttons (the hero's Details, …), the title page's action circles, the
   player's controls and menu. Sheets, the More menu, the profile menu, toasts,
   panes and rows in the page keep the 1.1.2 look (the tokens above).

   The website dims what is behind its bars (backdrop brightness 0.48 under a
   fifth of black). React Native has no live backdrop, so the body does the
   dimming — and it is Aurora's deep navy-violet, not black, and a touch
   lighter (58 %): 42 % of the picture's light and colour comes through, with a
   violet cast instead of grey. Over a WHITE poster the Pixel 9 draws it
   (117,116,131): white words 4.58:1. The chosen tab is a violet capsule
   (Aurora's accent at 20 %) with its own line — 4.59:1 over white. The edge:
   a faint even violet rim and a dark hairline outside — no white line along
   the top (elia's ruling, below). Words carry a soft shadow. */
export const E = {
  /** what floats over pictures */
  chrome: 'rgba(10,8,34,0.58)',
  /** the tab bar: the same navy, fuller — it floats over whatever scrolls under it,
   *  words included (a shelf's name, a poster's fallback title), and at 58 % those
   *  read sharp through "Home · Movies" with no blur to soften them (Pixel 9, 1.1.3) */
  bar: 'rgba(10,8,34,0.86)',
  /** the player's menu: words in lines over a moving frame — near-solid (0.88 showed the frame's shapes sharp between the lines on the Pixel 9) */
  thick: 'rgba(4,4,10,0.94)',
} as const;

/** E's rim (elia, 2026-11-11: "glass looks better when there isn't hard white
 *  backdrop from the top of the glass"): NO bright line along the top and no
 *  sheen from the top — one faint EVEN rim all round in Aurora's violet, and
 *  the dark hairline outside it (it parts the glass from a white poster; a
 *  1 dp spread shadow, no blur; Android 9+). */
export const E_EDGE = {
  borderWidth: 1,
  borderColor: 'rgba(176,164,255,0.26)',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.38)',
} as const;
/** The player's menu: the same even rim, the outside line 0.4. */
export const E_EDGE_THICK = {
  ...E_EDGE,
  boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
} as const;
/** Small round things (the action circles, the player's buttons): fainter still. */
export const E_EDGE_THIN = {
  borderWidth: 1,
  borderColor: 'rgba(176,164,255,0.2)',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.3)',
} as const;
/** The edge with the depth under it (--g-edge + --g-shadow), for what floats (the tab bar, the round
 *  buttons): drawn around the shape only (RN clips it out under the body), unlike Android's
 *  elevation, which darkens a see-through body from below. */
export const E_EDGE_FLOAT = {
  ...E_EDGE,
  boxShadow: '0 0 0 1px rgba(0,0,0,0.38), 0 6px 18px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.3)',
} as const;
/** The chosen tab / a lit control: Aurora's violet capsule with its own line (4.8:1 over white). */
export const E_WELL = {
  backgroundColor: 'rgba(120,104,240,0.2)',
  borderWidth: 1,
  borderColor: 'rgba(170,158,255,0.4)',
} as const;
/** Words on the clearest glass carry a soft shadow of their own (0 1px 3px rgba(0,0,0,.6)). */
export const E_WORDS = {
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
// The floating tab bar (.nav-items: 12 from the sides, 10 from the bottom). 59 tall, as the site
// (was 53; elia 2026-11-10: "just a tiny bit taller" — the pill, 47, grows with it)
export const TAB_H = 59;
export const TAB_INSET = 10;
export const TAB_SIDE = 12;

export default {colors, space, radius, font, GUTTER, TAP};
