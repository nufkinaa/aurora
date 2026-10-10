// What can be done with one row of "My downloads" — PURE, no imports
// (screens/Downloads.tsx draws it; the logic test runs this as it is).
//
// The website's page (public/js/screens/downloads.js) gives a row a button per
// action. A TV row has ONE press, so: `press` is what OK does, `all` is what
// holding OK offers (in order), `label` is the word at the row's right edge.
//
//   ready to play            press Play          · hold: Play, Title page
//   on its way / waiting     press Cancel        · hold: Title page, Cancel
//     …downloading past 5%   press asks first    (cancelling throws it away)
//   didn't make it           press opens the list: Try again (not when the
//     (failed/declined/        admin declined it, nor without a source to
//      cancelled)              ask for again), Title page, Remove
//   finished, not indexed    nothing to press yet · hold: Title page
//   someone else's           nothing — it is theirs
// "Title page" needs the title's IMDb id; a row without one leaves it out.
export type DownloadAction = 'play' | 'title' | 'retry' | 'remove' | 'cancel' | 'confirmCancel';

type Job = {
  status: string;
  mine?: boolean;
  libraryId?: string | null;
  imdbId?: string | null;
  infoHash?: string | null;
  progress?: number;
};

export const DEAD = ['error', 'declined', 'canceled'];
const LIVE = ['pending', 'approved', 'downloading'];
/** Cancelling past this throws real work away: ask first (the site's 5%). */
export const CONFIRM_CANCEL_FROM = 0.05;

export const isReady = (j: Job) => j.status === 'done' && !!j.libraryId;

export const downloadActions = (
  j: Job,
  own: boolean,
): {press: DownloadAction | 'menu' | null; all: DownloadAction[]; label: string} => {
  if (!own) return {press: null, all: [], label: ''};
  const title: DownloadAction[] = j.imdbId ? ['title'] : [];
  if (isReady(j)) return {press: 'play', all: ['play', ...title], label: '▶  Play'};
  if (LIVE.includes(j.status)) {
    const cancel: DownloadAction =
      j.status === 'downloading' && (j.progress || 0) > CONFIRM_CANCEL_FROM ? 'confirmCancel' : 'cancel';
    return {press: cancel, all: [...title, cancel], label: 'Cancel'};
  }
  if (DEAD.includes(j.status)) {
    const retry: DownloadAction[] = j.infoHash && j.status !== 'declined' ? ['retry'] : [];
    return {press: 'menu', all: [...retry, ...title, 'remove'], label: 'Options'};
  }
  // finished, still being indexed (or a status this build does not know)
  return {press: null, all: title, label: ''};
};
