// Saving to the phone — the rules, PURE (no React Native), tested.
//
// The website's offline copies (public/js/offline.js) are the model: the
// server lays out what it can make for this file and this device, the person
// picks (or their saved choice is used), the server prepares it, the phone
// fetches it. The words are the site's.
export type OfflineQuality = 'ask' | 'original' | '1080' | '720' | '480';
export const OFFLINE_QUALITIES: {id: OfflineQuality; label: string}[] = [
  {id: 'ask', label: 'Ask each time'},
  {id: 'original', label: 'Original'},
  {id: '1080', label: '1080p'},
  {id: '720', label: '720p'},
  {id: '480', label: '480p'},
];

export type Option = {quality: string; label: string; sizeBytes: number; instant?: boolean; detail?: string; note?: string; ready?: boolean};

/** The option a remembered choice stands for: that one, else the nearest smaller one, else
 *  the smallest there is (a 480p source has no 1080p; "original" may be unavailable). Null for
 *  'ask' (the sheet decides) or no options. */
export function pickOption(options: Option[], pref: OfflineQuality): Option | null {
  if (!options.length || pref === 'ask') return null;
  const exact = options.find(o => o.quality === pref);
  if (exact) return exact;
  const rank = (q: string) => (q === 'original' ? 9999 : Number(q) || 0);
  const want = rank(pref);
  const below = options.filter(o => rank(o.quality) <= want).sort((a, b) => rank(b.quality) - rank(a.quality));
  if (below.length) return below[0];
  return [...options].sort((a, b) => rank(a.quality) - rank(b.quality))[0];
}

export const fmtSize = (b: number): string => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

/** Is there room? The site's rule: the copy's size and 5% to spare. */
export const roomFor = (sizeBytes: number, freeBytes: number): boolean => !(sizeBytes > 0 && freeBytes > 0 && sizeBytes * 1.05 > freeBytes);
export const noRoomText = (sizeBytes: number, freeBytes: number) =>
  `not enough space on this phone — this copy needs about ${fmtSize(sizeBytes)} and ${fmtSize(freeBytes)} is free. Try a smaller size.`;

export type JobState = 'queued' | 'preparing' | 'saving' | 'done' | 'failed';
export const ACTIVE_STATES: JobState[] = ['queued', 'preparing', 'saving'];

/** The line a saved / saving copy shows (the site's words where it has them). */
export function stateLine(j: {state: JobState; pct?: number; note?: string | null; error?: string | null; sizeBytes?: number; waitingWifi?: boolean}): string {
  switch (j.state) {
    case 'queued':
      return 'Waiting for its turn';
    case 'preparing':
      return j.note ? `Preparing on the server — ${j.note}` : `Preparing on the server${j.pct ? ` · ${Math.round(j.pct * 100)}%` : ''}`;
    case 'saving':
      if (j.waitingWifi) return 'Waiting for Wi-Fi';
      return `Saving to this phone · ${Math.round((j.pct || 0) * 100)}%${j.sizeBytes ? ` of ${fmtSize(j.sizeBytes)}` : ''}`;
    case 'done':
      return j.sizeBytes ? `On this phone · ${fmtSize(j.sizeBytes)}` : 'On this phone';
    case 'failed':
      return `Couldn't save it — ${j.error || 'try again'}`;
  }
}

/** DownloadManager's word for where a save stands → this app's. */
export function fromNative(s: {status: string; bytes?: number; total?: number; reason?: number}): {state: JobState | 'gone'; pct: number; waitingWifi: boolean; error?: string} {
  const pct = s.total && s.total > 0 ? Math.min(1, (s.bytes || 0) / s.total) : 0;
  switch (s.status) {
    case 'done':
      return {state: 'done', pct: 1, waitingWifi: false};
    case 'failed':
      return {state: 'failed', pct, waitingWifi: false, error: `the download stopped (${s.reason ?? '?'})`};
    case 'gone':
      return {state: 'gone', pct, waitingWifi: false};
    case 'paused':
      // PAUSED_QUEUED_FOR_WIFI = 3, PAUSED_WAITING_FOR_NETWORK = 2
      return {state: 'saving', pct, waitingWifi: s.reason === 3};
    default:
      return {state: 'saving', pct, waitingWifi: false};
  }
}

/** The saved episode after this one, among this phone's copies (Up next with no server). */
export function nextSaved<T extends {showId?: string | null; season?: number | null; episode?: number | null; state: JobState}>(all: T[], cur: T): T | null {
  if (!cur.showId || cur.season == null || cur.episode == null) return null;
  const later = all
    .filter(x => x.state === 'done' && x.showId === cur.showId && x.season != null && x.episode != null)
    .filter(x => x.season! > cur.season! || (x.season === cur.season && x.episode! > cur.episode!))
    .sort((a, b) => a.season! - b.season! || a.episode! - b.episode!);
  return later[0] || null;
}
