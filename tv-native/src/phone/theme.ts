// The phone app's design tokens: the website's glass look at phone sizes.
//
// Colours are the shared ones (src/theme.ts, transcribed from public/css/
// tokens.css) — one Aurora. Sizes are the WEBSITE'S OWN at 412 css px, read
// off its phone screenshots (tools/mobile-perf shots.js, glass, phone-412):
// a css px on a phone is a dp, so they carry over 1:1.
import {colors as shared} from '../theme';

export const colors = {
  ...shared,
  // the glass: a light veil over the sky with a hairline edge (glass.css)
  glass: 'rgba(255,255,255,0.075)',
  glassStrong: 'rgba(255,255,255,0.12)',
  glassEdge: 'rgba(255,255,255,0.16)',
  glassDark: 'rgba(12,14,30,0.62)',
  // the tab bar's violet glass and its lit pill (glass.css .nav-glass)
  tabBar: 'rgba(78,52,168,0.55)',
  tabBarEdge: 'rgba(190,170,255,0.28)',
  tabPill: 'rgba(255,255,255,0.16)',
  kicker: 'rgba(255,255,255,0.10)',
  kickerFilm: '#f0c67e',
  kickerSeries: '#7fd1e8',
  owned: '#6fe0b0', // on this device / downloaded (the site's mint)
  danger: '#ff6b6b',
  scrim: 'rgba(5,6,12,0.55)',
};

export const space = {xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32};
// the page gutter (`--page-x` = 16px at 412)
export const GUTTER = 16;

export const radius = {s: 8, m: 12, l: 16, xl: 22, pill: 999};

export const font = {
  hero: 34, // the billboard title (site: ~34px at 412)
  title: 30, // a title page's name
  h1: 28, // a page heading ("Settings", "My List")
  row: 20, // a shelf's title
  body: 16,
  small: 14,
  tiny: 12,
};

// Cards (the site at 412: posters 113×170 with 8px gaps; Continue Watching 252×157)
export const POSTER_W = 116;
export const POSTER_H = 174;
export const FRAME_W = 256;
export const FRAME_H = 160;
export const EP_W = 272;
export const SHELF_GAP = 8;

// Hit targets: Android's 48dp minimum.
export const TAP = 48;
// The floating tab bar (site: 51px tall, 10px from the sides and the bottom)
export const TAB_H = 56;
export const TAB_INSET = 10;

export default {colors, space, radius, font, GUTTER, TAP};
