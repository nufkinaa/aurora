// Film or series on a search suggestion chip — the TV's and the phone's, the
// website's suggest.js kind mark: the card tags' own glyph (Icon 'film' /
// 'series', the site's ui.js paths) in the same hue (colors.kindFilm /
// kindSeries). A person or a genre keeps its own treatment (null here).
//
// SHOW_KIND_WORD is the ONE switch between the two looks elia was shown
// (docs/qa/search-icons/options): false = the icon alone, the word only in
// what a screen reader says; true = the icon and " · series" / " · film"
// after the title, the way a person's chip says " · person".
export const SHOW_KIND_WORD = false;

export type SearchKind = 'film' | 'series';

export const suggestionKind = (s: {kind?: string; type?: string}): SearchKind | null =>
  s.kind === 'person' || s.kind === 'genre' ? null : s.type === 'show' || s.type === 'series' ? 'series' : 'film';

/** What the chip prints after its title: nothing, or " · series" (SHOW_KIND_WORD). */
export const kindSuffix = (k: SearchKind | null, word = SHOW_KIND_WORD): string => (k && word ? ` · ${k}` : '');

/** What a screen reader hears: the label, then the kind in words (always). */
export const kindSpoken = (label: string, k: SearchKind | null): string => (k && !label.endsWith(` · ${k}`) ? `${label}, ${k}` : label);
