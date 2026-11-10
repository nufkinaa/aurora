// Aurora Play on the TV — the look's own colours and times.
// The same values as the website's `--play-*` tokens (public/css/play.css), so
// a game looks like one thing on every screen.
//
// The one rule of the palette: GOLD IS FOR A WIN. The prize of a draw, the
// number at the end of a round, the pick of the room, the viewer type. Never a
// label, never a key that is only "next".
export const PLAY = {
  // the room
  night0: '#03040c',
  night1: '#080a1d',
  night2: '#120e34',
  night3: '#04141c',
  // a card back / a plate / a tile, all opaque (nothing in the kit blurs or blends big areas)
  tile: '#17143a',
  tileHi: '#221d52',
  plate: '#211d50',
  plateLow: '#171439',
  pill: '#1d1947',
  panel: '#0d0c24',
  // ink
  ink: '#f7f5ff',
  inkDim: 'rgba(232,228,255,0.72)',
  inkFaint: 'rgba(232,228,255,0.62)',
  // the aurora (the ribbon runs green -> teal -> violet)
  green: '#5cf5b8',
  teal: '#3ad3e6',
  violet: '#a083ff',
  rose: '#ff86d0',
  // the one warm accent
  gold: '#ffd166',
  goldHi: '#fff2c2',
  goldDeep: '#f0a23a',
  goldInk: '#2b1900',
  // dark ink on the aurora key
  auroraInk: '#04221c',
  // glass
  glass: 'rgba(255,255,255,0.07)',
  glassHi: 'rgba(255,255,255,0.12)',
  line: 'rgba(255,255,255,0.13)',
  // answers (Taste and Pick together use the same three)
  yes: '#5cf5b8',
  no: '#ff86d0',
  maybe: '#cfd5ff',
} as const;

// the meteor burst's colours (burst.js)
export const BURST_COLORS = ['#ffe08a', '#7ef7c9', '#b9a6ff', '#ffffff'] as const;

// The star of the kit, the website's own path (stage.js), 24 x 24.
export const STAR_PATH = 'M12 1.8l2.95 6.6 7.2.75-5.4 4.85 1.55 7.1L12 17.4l-6.3 3.7 1.55-7.1-5.4-4.85 7.2-.75z';

// How long things take (ms). The website's numbers, except where a remote
// needs it otherwise (said at each one).
export const T = {
  slam: 170, // the stamp hits the card
  throw: 300, // the card leaves
  rise: 300, // the next card comes up
  ribbon: 500,
  pip: 420,
  pillIn: 300,
  pillHold: 2300,
  pillOut: 300,
  starStep: 70, // one star of a constellation after the other
  burst: 1700,
  words: 300, // a line of the prize rising
  wordsStep: 60,
} as const;
