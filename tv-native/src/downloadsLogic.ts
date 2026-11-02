// What can be done with one row of "My downloads" — PURE, no imports
// (screens/Downloads.tsx draws it; the logic test runs this as it is).
//
// The website's page (public/js/screens/downloads.js) gives a row a button per
// action. A TV row has ONE press, so: `press` is what OK does, `all` is what
// holding OK offers (in order), `label` is the word at the row's right edge.
//
//   ready to play            press Play          · hold: Play, Title page
//   on its way / waiting     press asks "Cancel it?" first, every time: a TV
//                            remote has one OK, and a row whose press cancelled
//                            at once (under 5%) was a stray press away from
//                            losing it · hold: Title page, Cancel
//   didn't make it           press opens the list: Try again (not when the
//     (failed/declined/        admin declined it, nor without a source to
//      cancelled)              ask for again), Title page, Remove
//     …another version       Pick another version instead of Try again: the same
//                            request again would only be a second copy, refused
//                            as "already yours" (the copy it was to replace is there)
//   finished, not indexed    nothing to press yet · hold: Title page
//   someone else's           nothing — it is theirs
// "Title page" needs the title's IMDb id; a row without one leaves it out.
export type DownloadAction = 'play' | 'title' | 'retry' | 'another' | 'remove' | 'confirmCancel';

type Job = {
  status: string;
  mine?: boolean;
  libraryId?: string | null;
  imdbId?: string | null;
  infoHash?: string | null;
  progress?: number;
  by?: string | null;
  replaces?: {libraryId?: string | null} | null;
};

export const DEAD = ['error', 'declined', 'canceled'];
const LIVE = ['pending', 'approved', 'downloading'];

export const isReady = (j: Job) => j.status === 'done' && !!j.libraryId;

export const downloadActions = (
  j: Job,
  own: boolean,
): {press: DownloadAction | 'menu' | null; all: DownloadAction[]; label: string} => {
  if (!own) return {press: null, all: [], label: ''};
  const title: DownloadAction[] = j.imdbId ? ['title'] : [];
  if (isReady(j)) return {press: 'play', all: ['play', ...title], label: '▶  Play'};
  if (LIVE.includes(j.status)) return {press: 'confirmCancel', all: [...title, 'confirmCancel'], label: 'Cancel'};
  if (DEAD.includes(j.status)) {
    const again: DownloadAction[] = j.replaces?.libraryId ? ['another'] : j.infoHash && j.status !== 'declined' ? ['retry'] : [];
    return {press: 'menu', all: [...again, ...title, 'remove'], label: 'Options'};
  }
  // finished, still being indexed (or a status this build does not know)
  return {press: null, all: title, label: ''};
};

/** The question before a download is cancelled — the site's words. */
export const cancelQuestion = (j: {label?: string | null; title?: string | null; status: string; progress?: number; replaces?: unknown}) => {
  const pct = j.status === 'downloading' ? Math.round((j.progress || 0) * 100) : 0;
  const kept = j.replaces ? ' Your copy stays as it was.' : '';
  return {
    title: `Cancel “${j.label || j.title}”?`,
    body: `${pct > 0 ? `It's ${pct}% down. Cancelling throws that away; you can always ask for it again.` : 'You can always ask for it again.'}${kept}`,
    keep: 'Keep going',
    yes: 'Cancel the download',
  };
};

/** How many of a profile's downloads are where. A count, nothing more: there is no
 *  limit on how many a person may have. `jobs` are that profile's own (`mine`). */
export type DownloadCounts = {downloading: number; queued: number; waiting: number; ready: number; failed: number};
export const downloadCounts = (jobs: Job[]): DownloadCounts => {
  const c: DownloadCounts = {downloading: 0, queued: 0, waiting: 0, ready: 0, failed: 0};
  for (const j of jobs) {
    if (isReady(j)) c.ready++;
    else if (j.status === 'downloading' || j.status === 'done') c.downloading++; // (done: being indexed)
    else if (j.status === 'approved') c.queued++;
    else if (j.status === 'pending') c.waiting++;
    else if (DEAD.includes(j.status)) c.failed++;
  }
  return c;
};
/** "3 downloading · 12 ready" — the same line on the TV, the phone and the site. */
export const countLine = (c: DownloadCounts): string =>
  [
    c.downloading ? `${c.downloading} downloading` : null,
    c.queued ? `${c.queued} queued` : null,
    c.waiting ? `${c.waiting} waiting for approval` : null,
    c.ready ? `${c.ready} ready` : null,
    c.failed ? `${c.failed} didn't make it` : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** Whose download it is, for a row that is NOT this profile's: "Started by
 *  Dor" — the website's words (public/js/screens/downloads.js). Nothing on
 *  your own rows, and nothing when the server did not say (an older server,
 *  a job whose requester is gone). */
export const startedBy = (j: Job, own: boolean): string | null => {
  if (own) return null;
  const name = typeof j.by === 'string' ? j.by.trim() : '';
  return name ? `Started by ${name}` : null;
};

/** A row's one status line. Whose download it is comes FIRST: the line is cut to one
 *  line, and at its end "Started by …" vanished behind a long status (a disk warning,
 *  an error — Mi TV, 2026-10-18). */
export const rowStatus = (p: {who: string | null; kind: string | null; status: string; size: string | null}): string =>
  [p.who, p.kind, p.status, p.size].filter(Boolean).join(' · ');
