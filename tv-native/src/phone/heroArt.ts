// What a billboard or a title page's cover shows on a phone held upright: the
// POSTER, asked for at the catalogue's LARGE size (the website's ui.js
// heroCover / heroShowsPoster — its small poster stretched over a whole phone
// looked low-res, elia 2026-10-11).
export const heroCover = (u: string | null | undefined): string | null =>
  typeof u === 'string' && /^https:\/\/[a-z0-9.-]*metahub\.space\/poster\/(small|medium)\//.test(u)
    ? u.replace(/\/poster\/(small|medium)\//, '/poster/large/')
    : u || null;

/** The site's portrait rule: `(max-width: 900px) and (orientation: portrait)`. */
export const showsPoster = (width: number, height: number) => height > width && width <= 900;
