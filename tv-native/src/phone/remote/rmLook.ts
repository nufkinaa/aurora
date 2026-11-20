// The remote's surfaces — the website's glass remote (public/css/remote.css, html[data-look="glass"]):
// a pane is a deep body (14,14,22 at half), held by the light on its rim; a thing ON a pane (OK, the
// chosen tab) is the lighter "lift".
// Full glass (2026-11-20, elia: "it should look like the nav and the rest of the btns"): no light from
// the top any more (the top-lit sheen and the bright top rim are gone) - a pane wears the nav's look:
// its body (RG_BODY) over one even veil of the old sheen's mean lightness, the rim's dim top, the
// violet / mint split down its two ends and the lit foot as its border colours, and (screens/Remote.tsx)
// the nav's shadows and GlassRim's ring and glint on the panes that stand alone.
import {RG_BODY, RG_LINES} from '../theme';

export const RM = {
  accent: '#8b7bff',
  teal: 'rgba(64,196,186,1)',
  live: '#3ddc97',
  amber: '#f0b44a',
  off: '#ff5d5d',
  body: 'rgba(14,14,22,0.5)',
  // (were a white sheen from the top, 0.07 / 0.012 / 0.028 and 0.18 / 0.09: now the nav's body over their mean)
  slab: `${RG_BODY}, linear-gradient(rgba(255,255,255,0.03), rgba(255,255,255,0.03))`,
  lift: `${RG_BODY}, linear-gradient(rgba(255,255,255,0.13), rgba(255,255,255,0.13))`,
  segOff: '#dce0ea',
  /** the sheet (glass.css --g-fill-thick, the aurora hue the website keeps) */
  sheet: 'rgba(22,24,38,0.97)',
} as const;

/** the rim: the nav's look as border colours — the dim top, the split down the two ends, the lit foot */
export const RIM = RG_LINES;

/** a pane: body + sheen + rim */
export const PANE = {backgroundColor: RM.body, experimental_backgroundImage: RM.slab, ...RIM} as const;
/** a lifted pane (the picker, a chosen tab, OK) */
export const LIFT = {backgroundColor: RM.body, experimental_backgroundImage: RM.lift, ...RIM} as const;
