// "Has it really come out, and is this a good copy?" — the TV side. Pure: no
// React, no network, so __tests__/logic/release-words.test.ts holds it to the
// website's words (public/js/releaseWords.js EARLY_CONFIRM,
// screens/discover-detail.js releaseNote) to the letter.
//
// The server reads every release name (src/media/releasekind.js) and sends,
// per source: `cam` (any copy made before the film is out at home — CAM, TS,
// TC, screener, HC), `prerelease` (which), `hardsub` (subtitles burned into
// the picture), and the words a row shows: `badge` ("CAM") and `warning`
// ("CAM — filmed in a cinema"). For a film it also sends `release`
// (src/media/releasestatus.js): one sentence for the title page, e.g. "Not out
// in good quality yet — only cinema recordings so far". Both apps print those
// as they are — one wording on both products.

export type ReleaseStatus = {
  state: 'good' | 'early-only' | 'not-out';
  line: string | null;
  note: string | null;
};

type SourceLike = {
  cam?: boolean | null;
  prerelease?: string | null;
  hardsub?: boolean | null;
  dubbed?: boolean | null;
  badge?: string | null;
  warning?: string | null;
};

/** A copy made before the film is out at home. */
export const isEarly = (s: SourceLike | null | undefined): boolean => !!s && (!!s.cam || !!s.prerelease);

/** May this source be picked FOR someone (the one press on Play, an episode
 *  card's download)? Never a pre-release copy, never a dub (the server's
 *  releasekind.pickable). */
export const pickable = (s: SourceLike | null | undefined): boolean => !!s && !isEarly(s) && !s.dubbed;

/** The row's warning badge ("CAM", "TS", "HC", "BURNED-IN SUBS"), or null. */
export const sourceBadge = (s: SourceLike): string | null =>
  isEarly(s) || s.hardsub ? s.badge || (isEarly(s) ? 'Cam' : null) : null;

/** Asked before a pre-release copy is downloaded or played — the site's words. */
export const EARLY_CONFIRM = {
  title: 'This is not the real release',
  text: (s: SourceLike) =>
    `${s.warning || 'A cinema recording'}. Picture and sound are usually poor — a good copy normally follows once the film is out to stream or buy.`,
  download: 'Download it anyway',
  play: 'Play it anyway',
  cancel: 'Cancel',
};

/** The title page's line, when there is one worth saying (not "good"). */
export const heroRelease = (r: ReleaseStatus | null | undefined): ReleaseStatus | null =>
  r && r.line && r.state !== 'good' ? r : null;
