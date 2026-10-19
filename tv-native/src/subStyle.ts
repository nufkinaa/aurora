// HOW SUBTITLES LOOK — one set of choices for the TV and the website, kept on
// the PERSON (their profile's `prefs`, synced to every device; personPrefs.ts
// carries them). PURE — no imports. The website's copy of this table is
// public/js/subStyle.js and the server's src/profiles.js PLAYER_OPTIONS;
// test/player-options.test.js (the root suite) holds the three together.
//
//   subSize     S | M | L | XL                          default M
//   subColor    white | yellow | cyan | green           default white
//   subBg       none | shadow | outline | box           default box
//   subOpacity  25 | 50 | 75 | 100  (the box only)      default 75
//   subWeight   normal | bold                           default bold
//   subPos      lower | raised                          default lower
//
// The subtitle DELAY is not one of these: it stays per title and track on
// this box (playback/subDelay.ts) — the delay that fixes one file is wrong for
// the next.
//
// Until 2026-10-19 this box kept `cueSize` (S/M/L) and `cueBackground`
// (on/off) for everyone (storage.ts). styleFromDevice turns those into a
// person's choices the first time that person is seen after the update.
export type SubSize = 'S' | 'M' | 'L' | 'XL';
export type SubColor = 'white' | 'yellow' | 'cyan' | 'green';
export type SubBg = 'none' | 'shadow' | 'outline' | 'box';
export type SubOpacity = 25 | 50 | 75 | 100;
export type SubWeight = 'normal' | 'bold';
export type SubPos = 'lower' | 'raised';
export type SubStyle = {
  subSize: SubSize;
  subColor: SubColor;
  subBg: SubBg;
  subOpacity: SubOpacity;
  subWeight: SubWeight;
  subPos: SubPos;
};
export type SubStyleKey = keyof SubStyle;

export const SUB_STYLE_DEFAULTS: SubStyle = {
  subSize: 'M',
  subColor: 'white',
  subBg: 'box',
  subOpacity: 75,
  subWeight: 'bold',
  subPos: 'lower',
};
export const SUB_STYLE_KEYS = Object.keys(SUB_STYLE_DEFAULTS) as SubStyleKey[];
export const SUB_STYLE_CHOICES: {[K in SubStyleKey]: SubStyle[K][]} = {
  subSize: ['S', 'M', 'L', 'XL'],
  subColor: ['white', 'yellow', 'cyan', 'green'],
  subBg: ['none', 'shadow', 'outline', 'box'],
  subOpacity: [25, 50, 75, 100],
  subWeight: ['normal', 'bold'],
  subPos: ['lower', 'raised'],
};
// The words — the website's, word for word.
export const SUB_STYLE_NAMES: Record<SubStyleKey, string> = {
  subSize: 'Size',
  subColor: 'Text colour',
  subBg: 'Background',
  subOpacity: 'Box opacity',
  subWeight: 'Text weight',
  subPos: 'Position',
};
export const SUB_STYLE_LABELS: {[K in SubStyleKey]: Record<string, string>} = {
  subSize: {S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra large'},
  subColor: {white: 'White', yellow: 'Yellow', cyan: 'Cyan', green: 'Green'},
  subBg: {none: 'None', shadow: 'Shadow', outline: 'Outline', box: 'Box'},
  subOpacity: {25: '25%', 50: '50%', 75: '75%', 100: '100%'},
  subWeight: {normal: 'Regular', bold: 'Bold'},
  subPos: {lower: 'Lower', raised: 'Raised'},
};
// Settings' rows (the player's menu uses SUB_STYLE_NAMES): label and note.
export const SUB_STYLE_SETTINGS: Record<SubStyleKey, [string, string | null]> = {
  subSize: ['Subtitle size', null],
  subColor: ['Text colour', null],
  subBg: ['Background', 'Shadow and outline keep the text readable without a box.'],
  subOpacity: ['Box opacity', 'How dark the box is.'],
  subWeight: ['Text weight', null],
  subPos: ['Position', 'Raised keeps them clear of words burnt into the picture.'],
};
export const SUB_COLORS: Record<SubColor, string> = {white: '#ffffff', yellow: '#ffe14d', cyan: '#5ee7ff', green: '#7dff8f'};

export const validStyle = (k: SubStyleKey, v: unknown): boolean => (SUB_STYLE_CHOICES[k] as unknown[]).includes(v);

/** The full style out of anything: every key present, each a real choice. */
export const readStyle = (from: unknown): SubStyle => {
  const src = (from && typeof from === 'object' ? from : {}) as Record<string, unknown>;
  const out = {} as Record<string, unknown>;
  for (const k of SUB_STYLE_KEYS) out[k] = validStyle(k, src[k]) ? src[k] : SUB_STYLE_DEFAULTS[k];
  return out as SubStyle;
};

export const nextChoice = <K extends SubStyleKey>(key: K, cur: SubStyle[K]): SubStyle[K] => {
  const list = SUB_STYLE_CHOICES[key];
  return list[(list.indexOf(cur) + 1) % list.length];
};
export const styleLabel = (key: SubStyleKey, style: Partial<SubStyle>): string =>
  SUB_STYLE_LABELS[key][String(readStyle(style)[key])] || '';

/** THE ONE-TIME MOVE of this box's old choices — real choices only (what
 *  differed from the default). The TV's old "background off" was a drop
 *  shadow (the site's was bare text: platform 'web'). */
export const styleFromDevice = (box: unknown, platform: 'tv' | 'web' = 'tv'): Partial<SubStyle> => {
  const out: Partial<SubStyle> = {};
  if (!box || typeof box !== 'object') return out;
  const b = box as Record<string, unknown>;
  if (b.cueSize === 'S' || b.cueSize === 'L') out.subSize = b.cueSize;
  if (b.cueBackground === false) out.subBg = platform === 'tv' ? 'shadow' : 'none';
  return out;
};

// ---- drawing (the cue layer in Player.tsx, and the previews) ----
// The site's S/M/L/XL ::cue sizes, scaled up for a 10-foot view.
export const CUE_PX: Record<SubSize, number> = {S: 18, M: 24, L: 32, XL: 40};
// The outline: the text drawn this many dp out in black, in eight directions,
// under the coloured text (Android draws one shadow per Text, so an outline is
// eight dark copies — the cue layer only re-renders when the cue changes).
export const OUTLINE_DP = 2;
export const OUTLINE_OFFSETS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
].map(([x, y]) => [x * OUTLINE_DP, y * OUTLINE_DP] as [number, number]);

export type CueLook = {
  color: string;
  fontWeight: '400' | '700';
  backgroundColor?: string;
  shadow: boolean; // textShadow under the text
  outline: boolean; // the eight dark copies
};
export const cueLook = (style: Partial<SubStyle>): CueLook => {
  const s = readStyle(style);
  return {
    color: SUB_COLORS[s.subColor],
    fontWeight: s.subWeight === 'bold' ? '700' : '400',
    backgroundColor: s.subBg === 'box' ? `rgba(0,0,0,${s.subOpacity / 100})` : undefined,
    shadow: s.subBg === 'shadow',
    outline: s.subBg === 'outline',
  };
};

// ---- where the cue sits ----
// "lower": the cue's bottom 48 dp above the screen's foot (cues.ts
// CUE_BOTTOM_PLAIN), lifted above the bottom bar while it shows. "raised": at
// least RAISED_SHARE of the screen's height up, whichever is higher — the
// site's raised cue sits at 80 % of the picture, i.e. 20 % up from its foot.
export const RAISED_SHARE = 0.2;
export const cueBottomFor = (pos: SubPos, lowerBottom: number, screenH: number): number =>
  pos === 'raised' && screenH > 0 ? Math.max(lowerBottom, Math.round(screenH * RAISED_SHARE)) : lowerBottom;
