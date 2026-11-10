// The soft dark fade from the TOP edge of Home's billboard, behind the greeting and its remark
// (elia 2026-11-10: "a shadow from the top that makes the text more visible, not a shadow that
// is right on the text") — PURE, tested.
//
// The picture keeps its own brightness everywhere else. The fade is darkest at the slab's top,
// holds enough under the words for them to read over white art (the greeting >= 4.5:1, the
// remark >= 4:1), then eases out over EASE dp below the remark with no band where it ends.

/** The page colour the fade is made of (#070811). */
export const INK = [7, 8, 17] as const;
export const TOP_ALPHA = 0.74;
/** what the fade still holds at the remark's last line (white art: ~4.6:1 for the remark) */
export const WORDS_ALPHA = 0.6;
export const EASE = 56;

export type GreetFade = {height: number; gradient: string};

/** @param wordsBottom how far below the slab's top the greeting's last line ends (dp) */
export function greetFade(wordsBottom: number): GreetFade {
  const height = Math.round(wordsBottom + EASE);
  const at = (y: number) => `${Math.round((y / height) * 1000) / 10}%`;
  const c = (a: number) => `rgba(${INK.join(',')},${a})`;
  // an eased tail (a smoothstep down from WORDS_ALPHA), so no edge shows where it stops
  const tail = [0.25, 0.5, 0.75].map(k => {
    const s = 1 - (3 * k * k - 2 * k * k * k);
    return `${c(Math.round(WORDS_ALPHA * s * 100) / 100)} ${at(wordsBottom + EASE * k)}`;
  });
  const gradient = `linear-gradient(180deg, ${c(TOP_ALPHA)} 0%, ${c(WORDS_ALPHA)} ${at(wordsBottom)}, ${tail.join(', ')}, ${c(0)} 100%)`;
  return {height, gradient};
}

// --- contrast (WCAG), for the tests and the record ---
const lin = (v: number) => {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
export const luminance = (rgb: readonly number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
export const contrast = (a: readonly number[], b: readonly number[]) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** the art's colour seen through the fade at `alpha` */
export const through = (art: readonly number[], alpha: number) => art.map((v, i) => Math.round(v * (1 - alpha) + INK[i] * alpha));
