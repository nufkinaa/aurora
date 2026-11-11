// Film or series on a search suggestion chip — the TV's and the phone's, the
// website's suggest.js kind mark: the card tags' own glyph (Icon 'film' /
// 'series', the site's ui.js paths) in the same hue (colors.kindFilm /
// kindSeries). A person or a genre keeps its own treatment (null here).
//
// The icon alone, the word only in what a screen reader says — elia's pick of
// the two looks he was shown, 2026-11-11 ("A", docs/qa/search-icons/options).
export type SearchKind = 'film' | 'series';

export const suggestionKind = (s: {kind?: string; type?: string}): SearchKind | null =>
  s.kind === 'person' || s.kind === 'genre' ? null : s.type === 'show' || s.type === 'series' ? 'series' : 'film';

/** What a screen reader hears: the label, then the kind in words. */
export const kindSpoken = (label: string, k: SearchKind | null): string => (k ? `${label}, ${k}` : label);
