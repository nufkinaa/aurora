// How the tab bar's words fit its width — PURE, tested (docs/android-phone/NAV.md §1).
//
// The bar holds Home · Movies · Shows · My List · More and the Search icon. On a
// 320–360 dp phone, or with the phone's font turned up, the words at their full
// size do not fit; a cut-off "My Li…" is what the 2026-11-06 audit found. So,
// in this order, until they fit:
//   1. the words at their size (the phone's font size counts, up to x1.2);
//   2. less room each side of a word (10 → 4 dp);
//   3. smaller words, down to 10.5 dp as drawn;
//   4. "More" becomes the three-dots icon (its name stays "More").
// The widths come MEASURED from the real text (TabBar.tsx), so a phone's own
// font or a language with longer words is fitted too.

export const BASE_FONT = 12.16; // the site's .nav-item, 0.76rem
export const MIN_FONT = 10.5; // as drawn (after the phone's font scale)
export const PAD_MAX = 10;
export const PAD_MIN = 4;
export const ICON_W = 40; // the Search icon's slot, and More's when it is an icon
export const GAP = 2; // .nav-items gap
export const BAR_PAD = 6; // .nav-items padding

export type TabFit = {
  /** the fontSize to give the words (before the phone's font scale) */
  font: number;
  /** dp each side of a word */
  pad: number;
  /** "More" drawn as the dots icon */
  moreIcon: boolean;
  /** false only when nothing fits even at the smallest (the best try is returned) */
  fits: boolean;
};

/**
 * @param barW     the bar's width (dp)
 * @param words    each word's measured width at BASE_FONT as drawn (dp); the LAST is "More"
 * @param scale    the phone's font scale as Text applies it (min(fontScale, 1.2))
 * @param icons    icon slots besides More (Search: 1)
 */
export function fitTabs(barW: number, words: number[], scale = 1, icons = 1): TabFit {
  const inner = barW - 2 * BAR_PAD;
  const n = words.length;
  const minK = Math.min(1, MIN_FONT / (BASE_FONT * Math.max(scale, 0.5)));
  const need = (k: number, pad: number, moreIcon: boolean) => {
    const shown = moreIcon ? words.slice(0, -1) : words;
    const text = shown.reduce((sum, w) => sum + w * k + 2 * pad, 0);
    const iconSlots = icons + (moreIcon ? 1 : 0);
    return text + iconSlots * ICON_W + (n + icons - 1) * GAP;
  };
  for (const moreIcon of [false, true]) {
    // 1, 2: full size, the room each side shrinking
    for (let pad = PAD_MAX; pad >= PAD_MIN; pad -= 2) if (need(1, pad, moreIcon) <= inner) return {font: BASE_FONT, pad, moreIcon, fits: true};
    // 3: the words themselves, as much smaller as it takes (never under MIN_FONT)
    const shown = moreIcon ? words.slice(0, -1) : words;
    const sum = shown.reduce((a, w) => a + w, 0);
    const fixed = need(0, PAD_MIN, moreIcon);
    const k = sum > 0 ? (inner - fixed) / sum : 1;
    if (k >= minK) return {font: round(BASE_FONT * Math.min(1, k)), pad: PAD_MIN, moreIcon, fits: true};
  }
  return {font: round(BASE_FONT * minK), pad: PAD_MIN, moreIcon: true, fits: false};
}

/**
 * Each slot's width: equal shares (the site's `flex: 1`), but never under what a slot
 * needs (CSS flex's min-content) — a slot that needs more takes it, the rest share
 * what is left. `needs` are the slots' widths with their padding; gaps are outside.
 */
export function slotWidths(room: number, needs: number[]): number[] {
  const out = needs.map(() => 0);
  let left = needs.map((_, i) => i);
  let free = room;
  for (;;) {
    const share = left.length ? free / left.length : 0;
    const big = left.filter(i => needs[i] > share);
    if (!big.length) {
      for (const i of left) out[i] = share;
      return out;
    }
    for (const i of big) {
      out[i] = needs[i];
      free -= needs[i];
    }
    left = left.filter(i => !big.includes(i));
  }
}

/** The slots of a fitted bar, in order: the words (More last of them, unless it is an icon), then
 *  the icon slots. Widths in dp; the sum is `barW - 2 * BAR_PAD - gaps`. */
export function tabSlots(barW: number, words: number[], fit: TabFit, icons = 1): number[] {
  const k = fit.font / BASE_FONT;
  const shown = fit.moreIcon ? words.slice(0, -1) : words;
  const needs = [...shown.map(w => w * k + 2 * fit.pad), ...(fit.moreIcon ? [ICON_W] : []), ...Array(icons).fill(ICON_W)];
  const room = barW - 2 * BAR_PAD - (needs.length - 1) * GAP;
  return slotWidths(room, needs);
}

// a hair under, so a rounding in the text layout never tips a word over
const round = (f: number) => Math.floor(f * 100) / 100 - 0.01;

/** A first guess before the words are measured (bold Roboto ~0.6 em a letter). */
export const guessWidth = (word: string, scale = 1) => Math.ceil(word.length * 0.6 * BASE_FONT * scale) + 1;
