// What an EMPTY Movies / Shows grid says — PURE, so the logic test holds it
// to its words (__tests__/logic/browse-copy.test.ts).
//
// It used to say "Nothing matches. Try fewer filters?" whatever the reason,
// and on a kids profile with no filter set at all (5.2.0 device pass) that
// was simply wrong: nothing was filtered by the viewer — the server holds
// back what is over the profile's age. Now the line names the real reason.
export type GridFilters = {
  kind: 'movie' | 'show';
  /** the category chip; 'all' is the unfiltered default */
  category: string;
  genre: string;
  unwatched: boolean;
  /** a kids profile's age limit (Profile.kids.maxAge); null for everyone else */
  kidsAge: number | null;
};

export const isFiltered = (f: GridFilters) => f.category !== 'all' || !!f.genre || f.unwatched;

export function emptyGridLine(f: GridFilters): {message: string; actionLabel: string} {
  // ("for this age": a kids profile sees what is rated up to its limit)
  const ages = f.kidsAge != null ? ' for this age' : '';
  if (f.genre) return {message: `Nothing in ${f.genre}${ages} here. Try another genre?`, actionLabel: 'Change filters'};
  if (isFiltered(f)) return {message: 'Nothing matches. Try fewer filters?', actionLabel: 'Change filters'};
  const what = f.kind === 'show' ? 'shows' : 'films';
  return f.kidsAge != null
    ? {message: `No ${what}${ages} here yet.`, actionLabel: 'Try another category'}
    : {message: `No ${what} here yet.`, actionLabel: 'Try another category'};
}

// What an EMPTY Home says (the server answered, with no titles at all). On a
// kids profile it said the server "may still be warming up after a restart"
// (Mi TV, 2026-10-18) — nothing was warming up: nothing in the library is
// rated for that age. The website's Home says the same (screens/home.js).
export function emptyHomeLine(kidsAge: number | null): {message: string; detail: string; kids: boolean} {
  if (kidsAge != null)
    return {
      kids: true,
      message: 'Nothing for this age here yet.',
      detail: `This profile shows titles rated ${kidsAge > 0 ? `for ages up to ${kidsAge}` : 'for all ages'} — none are in the library yet.`,
    };
  return {
    kids: false,
    message: 'Nothing to show yet.',
    detail: 'The server answered but had no titles for this profile — it may still be warming up after a restart.',
  };
}
