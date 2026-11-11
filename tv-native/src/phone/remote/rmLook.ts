// The remote's surfaces — the website's glass remote (public/css/remote.css, html[data-look="glass"]):
// a pane is a deep body (14,14,22 at half) under a faint top-lit sheen, held by the light on its
// rim; a thing ON a pane (OK, the chosen tab) is the lighter "lift".
export const RM = {
  accent: '#8b7bff',
  teal: 'rgba(64,196,186,1)',
  live: '#3ddc97',
  amber: '#f0b44a',
  off: '#ff5d5d',
  body: 'rgba(14,14,22,0.5)',
  slab: 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.012) 55%, rgba(255,255,255,0.028) 100%)',
  lift: 'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.09) 100%)',
  segOff: '#dce0ea',
  /** the sheet (glass.css --g-fill-thick, the aurora hue the website keeps) */
  sheet: 'rgba(22,24,38,0.97)',
} as const;

/** the rim: the thick pane's light — bright on top, a lit lower edge, a faint ring */
export const RIM = {
  borderWidth: 1,
  borderTopColor: 'rgba(255,255,255,0.36)',
  borderBottomColor: 'rgba(255,255,255,0.16)',
  borderLeftColor: 'rgba(255,255,255,0.075)',
  borderRightColor: 'rgba(255,255,255,0.075)',
} as const;

/** a pane: body + sheen + rim */
export const PANE = {backgroundColor: RM.body, experimental_backgroundImage: RM.slab, ...RIM} as const;
/** a lifted pane (the picker, a chosen tab, OK) */
export const LIFT = {backgroundColor: RM.body, experimental_backgroundImage: RM.lift, ...RIM} as const;
