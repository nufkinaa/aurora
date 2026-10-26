// "Problem with this copy? → Get another version" — the words and the small
// decisions, PURE (no imports): components/ReplaceSheet.tsx draws them, the
// player, the title page and My downloads ask them, and the logic test runs
// this file as it is. The rules themselves are the server's
// (src/media/replace.js); the words are the website's, letter for letter.

export type ReplaceReason = {id: string; label: string};

/** The five reasons, as the server lists them (badreleases.REASONS) — used
 *  until the server's own list has arrived, so the sheet opens on them at once. */
export const REASONS: ReplaceReason[] = [
  {id: 'burned', label: 'Burned-in subtitles'},
  {id: 'picture', label: 'Bad picture'},
  {id: 'sound', label: 'Bad sound'},
  {id: 'language', label: 'Wrong language'},
  {id: 'other', label: 'Other'},
];

export const WORDS = {
  entry: 'Problem with this copy?',
  entrySub: 'Get another version',
  step1: "What's wrong with this copy?",
  step1Body: 'Pick one. Another version replaces it — your place, My List and ratings stay.',
  step2: 'Get another version',
  step2Body: 'Your copy stays playable until the new one is in.',
  best: '★ BEST',
  none: 'No other versions found.',
  noProvider: "Couldn't reach the source provider.",
  started: "Getting another version — your copy stays playable until it's in.",
  activeHeading: 'Another version is on its way',
  cancel: 'Cancel — keep this copy',
  cancelled: 'Cancelled — your copy stays as it was.',
  waitingJob: 'Ready — waiting for nobody to be playing the old copy',
} as const;

/** A replacement on its way, as GET /api/replace/:id says (publicOf). */
export type ReplacementLike = {
  status?: string | null;
  phase?: string | null;
  progress?: number | null;
  waiting?: boolean | null;
  reasonLabel?: string | null;
  mine?: boolean | null;
  by?: string | null;
};

/** The status line of a replacement — the website's replaceStatusText
 *  (public/js/replaceCopy.js), word for word. */
export const replaceStatusText = (r: ReplacementLike | null | undefined): string => {
  if (!r) return '';
  if (r.waiting) return 'Ready — it takes over once nobody is playing this copy.';
  if (r.status === 'done') return 'The new version is in.';
  if (r.status === 'pending') return 'Waiting for approval';
  if (r.status === 'approved') return 'Queued to download';
  if (r.status === 'downloading') {
    if (r.phase === 'copying') return 'Almost there…';
    const pct = Math.round((r.progress || 0) * 100);
    return pct > 0 ? `Downloading · ${pct}%` : 'Starting download…';
  }
  if (r.status === 'error') return 'The download failed — your copy stays as it was.';
  if (r.status === 'canceled' || r.status === 'declined') return 'Cancelled — your copy stays as it was.';
  return '';
};

/** "Reason: Burned-in subtitles". */
export const replaceReasonText = (r: ReplacementLike | null | undefined): string =>
  r && r.reasonLabel ? `Reason: ${r.reasonLabel}` : '';

/** The line under the status: a Cancel button for the one who asked, else who did. */
export const replaceWho = (r: ReplacementLike | null | undefined): {cancel: boolean; line: string | null} => {
  if (!r) return {cancel: false, line: null};
  if (r.mine) return {cancel: true, line: null};
  const by = typeof r.by === 'string' ? r.by.trim() : '';
  return {cancel: false, line: by ? `Asked for by ${by}` : null};
};

export type ReplaceView = {
  can?: boolean;
  why?: string | null;
  code?: string | null;
  active?: ReplacementLike | null;
  reasons?: ReplaceReason[] | null;
};

/** Which face the sheet shows for what GET /api/replace/:id answered:
 *  'active' (a replacement on its way), 'refused' (the server says no, and why),
 *  'reasons' (step 1). Before the answer arrives: 'reasons' (it opens on them). */
export const replaceFace = (v: ReplaceView | null | undefined): 'active' | 'refused' | 'reasons' => {
  if (!v) return 'reasons';
  if (v.active) return 'active';
  if (v.can === false) return 'refused';
  return 'reasons';
};

/** The server's reasons when it sent a usable list, else the five above. */
export const reasonsOf = (v: ReplaceView | null | undefined): ReplaceReason[] => {
  const list = v && Array.isArray(v.reasons) ? v.reasons.filter(r => r && typeof r.id === 'string' && typeof r.label === 'string') : [];
  return list.length ? list : REASONS;
};

const fmtSize = (b?: number | null): string | null => {
  if (!b || b <= 0) return null;
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
};

export type ReplaceStreamLike = {
  quality?: string | null;
  qualityLabel?: string | null;
  sizeString?: string | null;
  sizeBytes?: number | null;
  seeders?: number | null;
  release?: string | null;
  filename?: string | null;
  recommended?: boolean | null;
  cam?: boolean | null;
  dubbed?: boolean | null;
  badHere?: {reason?: string; label?: string | null} | null;
};

/** One source row: quality, size, seeders, the release name; ★ BEST; a
 *  "Reported here" warning for a release somebody here already replaced. */
export const replaceRowText = (
  s: ReplaceStreamLike,
): {quality: string; name: string; meta: string; best: string | null; warn: string | null; tags: string[]} => {
  const quality = s.quality || s.qualityLabel || 'SD';
  const size = s.sizeString || fmtSize(s.sizeBytes);
  const seeds = typeof s.seeders === 'number' ? `${s.seeders} seeder${s.seeders === 1 ? '' : 's'}` : null;
  const tags = [s.cam ? 'Cam' : null, s.dubbed ? 'Dub' : null].filter(Boolean) as string[];
  return {
    quality,
    name: s.release || s.filename || '',
    meta: [quality, size, seeds].filter(Boolean).join(' · '),
    best: s.recommended ? WORDS.best : null,
    warn: s.badHere ? `Reported here: ${s.badHere.label || 'a problem'}` : null,
    tags,
  };
};

/** The failure line of the source list: the server's own words, else the fallback. */
export const sourcesError = (e: unknown): string => {
  const m = e && typeof e === 'object' && typeof (e as {message?: unknown}).message === 'string' ? (e as {message: string}).message : '';
  // a bare status line ("502 /api/replace/…") is not words for a person
  return m && !/^\d{3} \//.test(m) ? m : WORDS.noProvider;
};

/** Where the entry is offered — the website's rule: only on a copy that IS
 *  in the library (never a stream from a torrent, never a title or an episode
 *  that is not on disk), never to a kids profile (the profile's `kids` set),
 *  and not while the admin has torrents switched off. The server still
 *  decides who may; the sheet shows its "why not" if it refuses anyway. */
export const replaceOffered = (o: {
  libraryId?: string | null;
  isTorrent?: boolean;
  kids?: {maxAge?: number} | boolean | null;
  torrentsOff?: boolean;
}): boolean =>
  !!o.libraryId && !o.isTorrent && !String(o.libraryId).startsWith('torrent|') && !o.kids && !o.torrentsOff;

/** A download that is a replacement, finished and waiting for the old copy to
 *  be free: its line on My downloads instead of the usual phase text. */
export const replaceJobLine = (j: {status?: string; replaceWait?: boolean | null}): string | null =>
  j.replaceWait && !['done', 'error', 'declined', 'canceled', 'removed'].includes(j.status || '') ? WORDS.waitingJob : null;
