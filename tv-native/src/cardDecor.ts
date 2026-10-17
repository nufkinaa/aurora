// What the native single-view card draws besides its picture (render switch `cardtext`,
// docs/qa/native-deep/DEVICE-PLAN.md §cardtext): the words, the NEW and kind pills, the
// progress bar, the tile's title and the ✕ — Card.tsx's own StyleSheet entries, flattened
// and PROCESSED THE WAY REACT NATIVE PROCESSES THEM FOR ITS VIEWS (processColor,
// processBoxShadow, processBackgroundImage), so the Kotlin side (ui/card/CardDecor.kt)
// never holds a style value of its own. Built once per launch; the JSON is the card's
// `decor` prop, the same string on every card (AuroraCardView.kt parses it once).
//
// Pure — the processors are handed in — so the logic tests check the shape
// (__tests__/logic/card-decor.test.ts) without React Native.

export type Processors = {
  color: (c: unknown) => number | null | undefined;
  boxShadow: (s: unknown) => unknown;
  backgroundImage: (s: unknown) => unknown;
};

type Style = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);

/** A Text's attributes as TextAttributeProps reads them (dp, a weight string, a processed colour). */
export function textOf(s: Style, p: Processors) {
  const off = (s.textShadowOffset || {}) as {width?: number; height?: number};
  const sc = s.textShadowColor != null ? p.color(s.textShadowColor) : undefined;
  return {
    size: num(s.fontSize),
    weight: s.fontWeight != null ? String(s.fontWeight) : undefined,
    color: s.color != null ? p.color(s.color) ?? undefined : undefined,
    ls: num(s.letterSpacing),
    lh: num(s.lineHeight),
    align: typeof s.textAlign === 'string' ? s.textAlign : undefined,
    mt: num(s.marginTop),
    // RN adds the shadow span only when an offset or a radius is set and the colour is not clear
    shadow:
      sc != null && (num(off.width) || num(off.height) || num(s.textShadowRadius))
        ? {dx: num(off.width) ?? 0, dy: num(off.height) ?? 0, r: num(s.textShadowRadius) ?? 1, color: sc}
        : undefined,
  };
}

/** A View's box: Yoga's insets / size / padding / border, and what its background draws. */
export function boxOf(s: Style, p: Processors) {
  const pad = (side: 'Top' | 'Right' | 'Bottom' | 'Left') => {
    const axis = side === 'Top' || side === 'Bottom' ? s.paddingVertical : s.paddingHorizontal;
    return num(s[`padding${side}`]) ?? num(axis) ?? num(s.padding) ?? 0;
  };
  const shadow = s.boxShadow != null ? p.boxShadow(s.boxShadow) : undefined;
  const image = s.experimental_backgroundImage != null ? p.backgroundImage(s.experimental_backgroundImage) : undefined;
  return {
    left: num(s.left),
    right: num(s.right),
    top: num(s.top),
    bottom: num(s.bottom),
    width: num(s.width),
    height: num(s.height),
    maxWidth: num(s.maxWidth),
    pt: pad('Top'),
    pr: pad('Right'),
    pb: pad('Bottom'),
    pl: pad('Left'),
    bw: num(s.borderWidth) ?? 0,
    bc: s.borderColor != null ? p.color(s.borderColor) ?? undefined : undefined,
    br: num(s.borderRadius) ?? 0,
    bg: s.backgroundColor != null ? p.color(s.backgroundColor) ?? undefined : undefined,
    clip: s.overflow === 'hidden' ? true : undefined,
    shadow: Array.isArray(shadow) && shadow.length ? shadow : undefined,
    image: Array.isArray(image) && image.length ? image : undefined,
  };
}

export type CardStyles = Record<string, Style | undefined>;

/**
 * The decor, from Card.tsx's `styles` (each entry exactly as Card.tsx stacks them on its
 * views) and the kind icon's look (Icon.tsx: an 11 dp glyph in the kind's colour).
 */
export function buildDecor(
  styles: CardStyles,
  flatten: (s: unknown) => Style,
  p: Processors,
  icon: {size: number; film: string; series: string},
): string {
  const st = (...names: string[]) => flatten(names.map(n => styles[n]).filter(Boolean));
  const d = {
    v: 1,
    label: boxOf(st('label'), p),
    labelRaised: boxOf(st('label', 'labelRaised'), p),
    labelText: textOf(st('labelText'), p),
    labelSub: textOf(st('labelSub'), p),
    frameLabel: boxOf(st('frameLabel'), p),
    frameTitle: textOf(st('frameTitle'), p),
    frameSub: textOf(st('frameSub'), p),
    frameMeta: textOf(st('frameMeta'), p),
    fallbackCentre: boxOf(st('fallbackCentre'), p),
    fallbackText: textOf(st('fallbackText'), p),
    newPill: boxOf(st('tag', 'tagLeft', 'tagNew'), p),
    newText: textOf(st('tagText', 'tagNewText'), p),
    filmPill: boxOf(st('tag', 'tagKind', 'kindFilm'), p),
    seriesPill: boxOf(st('tag', 'tagKind', 'kindSeries'), p),
    progress: boxOf(st('progress'), p),
    progressFrame: boxOf(st('progress', 'progressFrame'), p),
    progressFill: boxOf(st('progressFill'), p),
    progressHead: boxOf(st('progressHead'), p),
    remove: boxOf(st('remove'), p),
    removeGlyph: textOf(st('removeGlyph'), p),
    icon: {size: icon.size, film: p.color(icon.film) ?? 0, series: p.color(icon.series) ?? 0},
  };
  return JSON.stringify(d);
}
