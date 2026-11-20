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
  // + the full glass (2026-11-20): a glass button in the page (not floating over a picture) wears the
  // nav's look as border colours - the rim's dim top (no violet line along it any more), the split
  // down its two ends, the rim's lit foot - and keeps its dark outside line (the one shadow it always
  // had); one that stands alone adds the nav's shadows and GlassRim on top of this (ui/Buttons.tsx)
  borderTopColor: 'rgba(255,255,255,0.05)',
  borderLeftColor: 'rgba(232,121,249,0.36)',
  borderRightColor: 'rgba(94,234,212,0.36)',
  borderBottomColor: 'rgba(190,180,255,0.45)',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.38)',
} as const;
/** The player's menu: the same even rim, the outside line 0.4. (The TV app's shared player wears this one: it stays as it was.) */
export const E_EDGE_THICK = {
  borderWidth: 1,
  borderColor: 'rgba(176,164,255,0.26)',
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
  borderWidth: 1,
  borderColor: 'rgba(176,164,255,0.26)',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.38), 0 6px 18px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.3)',
} as const;
/** The chosen tab / a lit control: Aurora's violet capsule with its own line (4.8:1 over white). */
export const E_WELL = {
  backgroundColor: 'rgba(120,104,240,0.2)',
  borderWidth: 1,
  borderColor: 'rgba(170,158,255,0.4)',
} as const;
/* ---- Real glass on the same chrome (2026-11-19, second pass) ---------------
   elia: "a look of real looking glass with chromatic aberration for the btns
   … for the nav and every glass btn across the board". The website's is at the
   end of public/css/glass.css ("Real glass"); these are its numbers in dp —
   its DRAWN half: React Native has no live backdrop, so nothing is bent and
   no colour is split here. The surfaces are E's (the list above) and so are
   the bodies (E.chrome, E.bar); what changes is the EDGE — a pane reads as a
   THICK piece of glass:
   - no light along the top (the ruling above stands). Thick glass lit from
     above is dark just under its top edge and gathers light along its foot:
     a soft violet pool inside the bottom rim, within 7 dp of it;
   - the rim itself, 1 dp: dim on top, brighter down its sides, lit along its
     foot (RG_FRESNEL), and one small glint on the left shoulder with a
     fainter answer on the right foot, tinted in Aurora's violet-magenta and
     mint (RG_ARCS; RG_ARCS_S on small round things, where nothing is lit
     above the middle) — drawn by ui/GlassRim.tsx, so these surfaces carry
     no border;
   - the colour split a lens leaves on an edge, standing still (RG_SPLIT): one
     sharp dp of violet inside the left end of a pane and of mint inside the
     right, their other halves just outside, swapped. Only sideways, so they
     are crescents — widest at 9 and 3 o'clock, nothing at the top or the
     foot, a hair on a bar's straight run;
   - the body is not flat (RG_BODY): darker towards its top, a little of the
     light it gathers towards its foot — two still gradients over the pane's
     own colour;
   - depth: a tight contact shadow, the soft one, a little violet light let
     through below, and the dark hairline outside.
   All of it is still: box shadows and one small drawing per surface, sized
   from what is known at the first layout — nothing per frame, nothing that
   arrives a frame late. Inset shadows need Android 10+; an older phone shows
   the rim, the glint, the outside line and the depth, without the pool. */
export const RG = {
  /** Aurora's own two: the violet-magenta of its accent and the mint of its sky */
  warm: '232,121,249',
  cool: '94,234,212',
  pool: '168,150,255',
} as const;
/** The bezel's glow, the dark under the top edge, the light gathered along the foot (--rg-rim, less its hairline: the ring carries it). */
export const RG_RIM =
  'inset 0 0 7px 0 rgba(255,255,255,0.07), inset 0 3px 4px -2px rgba(0,0,0,0.42), inset 0 -1px 0 0 rgba(168,150,255,0.18), inset 0 -7px 9px -7px rgba(168,150,255,0.45)';
/** The depth under what floats (--ge-shadow): a tight contact shadow, the soft one, violet light let through below. */
export const RG_DEPTH = '0 1px 1.5px rgba(0,0,0,0.5), 0 10px 24px rgba(0,0,0,0.3), 0 8px 16px -8px rgba(168,150,255,0.22)';
/** The still colour split (--rg-split): sideways only — violet inside the left end, mint inside the right, their other halves outside, swapped. */
export const RG_SPLIT =
  'inset 1px 0 0 0 rgba(232,121,249,0.36), inset -1px 0 0 0 rgba(94,234,212,0.36), -1px 0 0 0 rgba(94,234,212,0.22), 1px 0 0 0 rgba(232,121,249,0.22)';
/** The same, calmer (--rg-split-calm): where many sit side by side (a title's action circles). */
export const RG_SPLIT_CALM =
  'inset 1px 0 0 0 rgba(232,121,249,0.3), inset -1px 0 0 0 rgba(94,234,212,0.3), -1px 0 0 0 rgba(94,234,212,0.18), 1px 0 0 0 rgba(232,121,249,0.18)';
/** A small round button (--rg-split-s): the inside crescents stronger — there is little else on it. */
export const RG_SPLIT_S =
  'inset 1px 0 0 0 rgba(232,121,249,0.5), inset -1px 0 0 0 rgba(94,234,212,0.5), -1px 0 0 0 rgba(94,234,212,0.22), 1px 0 0 0 rgba(232,121,249,0.22)';
/** The convex body (--rg-body), laid over the pane's own colour: a shade under the top edge, a little violet light from below the foot. No light from the top.
 *  (The website's shade is centred above the pane, at 50% -20%. Android drops a negative centre and paints the shade in the pane's middle — seen on the
 *  Pixel 9 emulator — so here it hangs from the top edge itself: the same cap of shade, a touch deeper since the app has no lens to give the pane thickness.) */
export const RG_BODY =
  'radial-gradient(ellipse 70% 38% at 50% 0%, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0) 100%), radial-gradient(ellipse 120% 60% at 50% 118%, rgba(168,150,255,0.16) 0%, rgba(168,150,255,0) 60%)';
/** The tab bar's body (.nav-items' own --rg-body): it gathers a little more light along its foot. */
export const RG_BODY_BAR =
  'radial-gradient(ellipse 70% 38% at 50% 0%, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0) 100%), radial-gradient(ellipse 120% 60% at 50% 118%, rgba(168,150,255,0.22) 0%, rgba(168,150,255,0) 60%)';
/** Real glass's edge (--ge-edge) and body: the split, the rim, the dark hairline outside. No border: GlassRim draws the ring. */
export const RG_EDGE = {
  boxShadow: `${RG_SPLIT}, ${RG_RIM}, 0 0 0 1px rgba(0,0,0,0.36)`,
  experimental_backgroundImage: RG_BODY,
} as const;
/** The title page's action circles: the calmer split, the outside line a touch fainter, as E's. */
export const RG_EDGE_THIN = {
  boxShadow: `${RG_SPLIT_CALM}, ${RG_RIM}, 0 0 0 1px rgba(0,0,0,0.3)`,
  experimental_backgroundImage: RG_BODY,
} as const;
/** The player's small round buttons: the small button's split, the outside line a touch fainter, as E's. */
export const RG_EDGE_SMALL = {
  boxShadow: `${RG_SPLIT_S}, ${RG_RIM}, 0 0 0 1px rgba(0,0,0,0.3)`,
  experimental_backgroundImage: RG_BODY,
} as const;
/** The edge with the depth under it (--ge-edge + --ge-shadow), for what floats: the hero's glass pill. */
export const RG_EDGE_FLOAT = {
  boxShadow: `${RG_SPLIT}, ${RG_RIM}, 0 0 0 1px rgba(0,0,0,0.36), ${RG_DEPTH}`,
  experimental_backgroundImage: RG_BODY,
} as const;
/** The same for the round top buttons (logo, settings, profile, TVs, Back): the small button's split. */
export const RG_EDGE_FLOAT_S = {
  boxShadow: `${RG_SPLIT_S}, ${RG_RIM}, 0 0 0 1px rgba(0,0,0,0.36), ${RG_DEPTH}`,
  experimental_backgroundImage: RG_BODY,
} as const;
/** The same for the tab bar: its own body. */
export const RG_EDGE_BAR = {
  boxShadow: RG_EDGE_FLOAT.boxShadow,
  experimental_backgroundImage: RG_BODY_BAR,
} as const;
/** The rim itself (--rg-fresnel), top to foot: [how far down, colour, how strong]. */
export const RG_FRESNEL = [
  [0, '255,255,255', 0.05],
  [0.45, '255,255,255', 0.13],
  [1, '190,180,255', 0.45],
] as const;
/** The glint (--rg-arc, 1:1): round lights, each fading to nothing at `r`. A light sits at
 *  (fx * width + dx, fy * height) of the pane — so they stay on the two ends whatever the width,
 *  and a wide bar's top edge is never lit. First = drawn on top. */
export const RG_ARCS = [
  {fx: 0, dx: 1, fy: 0.4, r: 13, c: '255,255,255', a: 0.66},
  {fx: 0, dx: 3, fy: 0.16, r: 15, c: RG.warm, a: 0.42},
  {fx: 0, dx: 2, fy: 0.74, r: 15, c: RG.cool, a: 0.42},
  {fx: 1, dx: -1, fy: 0.66, r: 12, c: '255,255,255', a: 0.42},
  {fx: 1, dx: -3, fy: 0.9, r: 14, c: RG.cool, a: 0.34},
] as const;
/** On a small round button (--rg-arc-s, 1:1) nothing is lit above its middle: the glint at the left
 *  shoulder, violet and mint below it, an answer on the right foot — strong enough to be seen at the
 *  button's real size. */
export const RG_ARCS_S = [
  {fx: 0, dx: 0, fy: 0.46, r: 10, c: '255,255,255', a: 0.8},
  {fx: 0.04, dx: 0, fy: 0.66, r: 9, c: RG.warm, a: 0.4},
  {fx: 0.15, dx: 0, fy: 0.88, r: 11, c: RG.cool, a: 0.46},
  {fx: 1, dx: 0, fy: 0.7, r: 9, c: '255,255,255', a: 0.42},
  {fx: 0.88, dx: 0, fy: 0.9, r: 10, c: RG.warm, a: 0.34},
] as const;
/** A title's page has six of these side by side: the group is calmed, as the website's (its ring at 0.7). */
export const RG_CALM = 0.7;
/** Words on the clearest glass carry a soft shadow of their own (0 1px 3px rgba(0,0,0,.6)). */
export const E_WORDS = {
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowOffset: {width: 0, height: 1},
  textShadowRadius: 3,
} as const;

/* ---- Real glass, everywhere, at FULL strength (2026-11-20) -------------------
   elia, about the calm glass the panes wore first: "don't let it keep the old
   look, it should look like the nav and the rest of the btns". So every other
   glass surface (a panel, a row, a card, a chip, a sheet, a menu, a toast, a
   text field, the Remote's panes) wears the nav's own numbers (the "real
   glass" section below: RG_SPLIT, RG_RIM, RG_BODY, RG_FRESNEL, RG_ARCS):
   - no light along the top: the top of the border is the rim's dim top
     (RG_FRESNEL's first stop, 0.05); nothing changes size - every border keeps
     its width, only colours, shadows and bodies change;
   - the violet / mint split at the two ends at the nav's strength (0.36);
   - the lit foot at the nav's rim colour (RG_FRESNEL's foot, 190,180,255 at 0.45);
   - the nav's body (RG_BODY) where a pane had a body gradient.
   Two ways to draw it, by how many come to a screen (measured on the Pixel 9
   emulator, 2026-11-20: a list of rows wearing the rim as blurred inset box
   shadows drew a frame in 300-350 ms where today's drew one in 57):
   - what comes MANY to a screen (a row, a card, a chip, a glass button in a
     row, a day of the Calendar) draws the look with its BORDER: the dim top,
     the split as the left (violet-pink) and right (mint) border colours, the
     lit foot as the bottom one; no shadow, and a list row has no body
     gradient (RG_ROW). A chosen / owned state that recolours the edge sets all
     four sides: edgeAll(colour) (borderColor alone does not override a side's
     own colour);
   - what stands ALONE (the search field, a sheet, a toast, the profile menu,
     the Remote's panes, a pane in the page) wears the nav's edge whole
     (RG_RINGED: the split and the rim as shadows, the dark hairline outside)
     and GlassRim's ring and glint drawn ON its border (the border made
     transparent, its width kept). Inset shadows need Android 10+. */
/** The rim's dim top (RG_FRESNEL's first stop) as a border colour: the top side, and all round where nothing else is lit. */
export const RG_HAIR = 'rgba(255,255,255,0.05)';
/** The split and the lit foot as plain colours (the border sides of anything that comes many to a screen): RG_SPLIT's inside halves, RG_FRESNEL's foot. */
export const RG_SPLIT_L = 'rgba(232,121,249,0.36)';
export const RG_SPLIT_R = 'rgba(94,234,212,0.36)';
export const RG_FOOT = 'rgba(190,180,255,0.45)';
/** One colour on all four sides of an edge: how a chosen / owned state recolours a pane that wears RG_LINES. */
export const edgeAll = (c: string) => ({borderTopColor: c, borderLeftColor: c, borderRightColor: c, borderBottomColor: c}) as const;
/** The look as border colours: the dim top, the split down the two ends, the lit foot. A row, a card, a chip, a glass button in the page. */
export const RG_LINES = {
  borderWidth: 1,
  borderTopColor: RG_HAIR,
  borderLeftColor: RG_SPLIT_L,
  borderRightColor: RG_SPLIT_R,
  borderBottomColor: RG_FOOT,
} as const;
/** A text field (a TextInput): Android's text field draws ONE border colour on all four sides (it took the right side's
 *  mint for all of them on the Pixel 9 emulator), so its border is the even dim top colour and the split and the lit foot
 *  are sharp inset lines (no blur) just inside it. A focused field recolours its border and drops them (RG_FIELD_ON). */
export const RG_FIELD = {
  borderWidth: 1,
  ...edgeAll(RG_HAIR),
  borderColor: RG_HAIR,
  boxShadow: `inset 1px 0 0 0 ${RG_SPLIT_L}, inset -1px 0 0 0 ${RG_SPLIT_R}, inset 0 -1px 0 0 ${RG_FOOT}`,
} as const;
export const RG_FIELD_ON = (c: string) => ({...edgeAll(c), borderColor: c, boxShadow: 'none'}) as const;
/** A row of a list (Downloads, the Calendar's list, sources, saved titles): the lines alone, no body gradient - as light to draw as today's. */
export const RG_ROW = RG_LINES;
/** A pane in the page that comes a few to a screen (a card of words, a group, a note): the lines and the nav's body. */
export const RG_PANE = {
  ...RG_LINES,
  experimental_backgroundImage: RG_BODY,
} as const;
/** A surface that stands alone, with GlassRim drawn on its (kept, now transparent) border: the nav's split and rim as
 *  shadows, the dark hairline outside it (RG_EDGE's). */
export const RG_RINGED = {
  borderWidth: 1,
  ...edgeAll('transparent'),
  boxShadow: RG_EDGE.boxShadow,
} as const;
/** The same for a small round button standing alone (the Remote's round keys): the small button's split (RG_EDGE_SMALL's). */
export const RG_RINGED_S = {
  borderWidth: 1,
  ...edgeAll('transparent'),
  boxShadow: RG_EDGE_SMALL.boxShadow,
} as const;
/** A sheet rising from the foot of the screen: the same less the lit foot (its foot is the screen's edge, not glass),
 *  the sheet keeps its own border widths (no bottom side). */
export const RG_SHEET = {
  ...edgeAll('transparent'),
  boxShadow: `${RG_SPLIT}, inset 0 0 7px 0 rgba(255,255,255,0.07), inset 0 3px 4px -2px rgba(0,0,0,0.42), 0 0 0 1px rgba(0,0,0,0.36)`,
} as const;
/** A day of the Calendar's month: a plain one carries the lit foot on its border; one that carries something wears the
 *  split and the lit foot over its picture (.calg-day / .calg-day.has). */
export const RG_DAY_HAS = `${RG_SPLIT}, inset 0 0 0 1px ${RG_HAIR}, inset 0 -1px 0 0 ${RG_FOOT}`;

/** What every glass pane lays over its own colour. It was the site's white sheen from the top-left (0.09 / 0.025 / 0.06);
 *  now the nav's body, over one even veil of the sheen's mean lightness - so the panes are as dark as they were. */
export const G_FILL = `${RG_BODY}, linear-gradient(rgba(255,255,255,0.05), rgba(255,255,255,0.05))`;
/** The pane's edge. It was the site's old --g-edge as border colours (a bright top edge, 0.38); now the look's lines. */
export const G_EDGE = RG_LINES;

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
