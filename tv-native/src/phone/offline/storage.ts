// Where saved copies live and how much room they may take — the phone's storage
// choices (Settings → Saved on this phone), PURE (no React Native), tested.
//
//   Save to                  this phone, or its SD card when it has one
//   Space limit              "use at most N GB"; when full, offer to remove the oldest
//                            copy you have watched
//   Tidy up after watching   a saved episode leaves the phone a day after you finish it
//                            (OFF unless turned on)
//   Keep the next episodes   while you watch a show, its next 2 episodes are kept saved
//                            on the phone, on Wi-Fi only (OFF unless turned on). The
//                            phone's own saves of what the server already has — never a
//                            download on the server (elia removed those, 2026-10-26).

export type StoragePrefs = {
  /** the folder of the chosen volume (getExternalFilesDirs); null: the phone's own storage */
  volume: string | null;
  /** 0: no limit */
  limitGb: number;
  tidyAfter: boolean;
  keepNext: boolean;
};
export const STORAGE_DEFAULTS: StoragePrefs = {volume: null, limitGb: 0, tidyAfter: false, keepNext: false};

// ---- Save to ----
export type Volume = {path: string; free: number; total: number; removable: boolean; primary: boolean; mounted: boolean};

export const volumeName = (v: Pick<Volume, 'primary' | 'removable'>, i = 0) => (v.primary ? 'This phone' : v.removable ? (i > 1 ? `SD card ${i}` : 'SD card') : 'Other storage');

/** The volume saves go to: the chosen one while it is there, else the phone's own. */
export function currentVolume(vols: Volume[], chosen: string | null): Volume | null {
  const ok = vols.filter(v => v.mounted);
  return (chosen && ok.find(v => v.path === chosen)) || ok.find(v => v.primary) || ok[0] || null;
}
/** The picker is offered only when there is somewhere else to save to. */
export const hasChoice = (vols: Volume[]) => vols.filter(v => v.mounted).length > 1;

// ---- Space limit ----
export const LIMIT_CHOICES = [0, 2, 5, 10, 20, 50];
export const GB = 1024 ** 3;
export const limitLabel = (gb: number) => (gb > 0 ? `At most ${gb} GB` : 'No limit');

export type Copy = {
  id: string;
  profileId: string;
  title: string;
  showId?: string | null;
  showTitle?: string | null;
  season?: number | null;
  episode?: number | null;
  state: 'queued' | 'preparing' | 'saving' | 'done' | 'failed';
  sizeBytes: number;
  duration: number;
  position?: number;
  finishedAt?: number | null;
  savedAt?: number;
  at: number;
};

/** What the copies on this phone take, or will once they are down (every profile's: the limit
 *  is the phone's). A failed one takes nothing. */
export const usedBytes = (all: Copy[]) => all.filter(c => c.state !== 'failed').reduce((n, c) => n + (c.sizeBytes || 0), 0);

/** The server's own rule for "finished" (src/profiles.js): past 95 %. */
export const FINISHED_AT = 0.95;
export const isWatched = (c: Pick<Copy, 'finishedAt' | 'position' | 'duration'>) => !!c.finishedAt || (c.duration > 0 && (c.position || 0) / c.duration > FINISHED_AT);

export const overLimit = (used: number, adding: number, limitGb: number) => limitGb > 0 && used + adding > limitGb * GB;

/**
 * The copies to remove so `adding` more bytes fit under the limit: watched ones, oldest
 * watched first, as few as it takes. [] when it fits already; null when even every watched
 * copy would not make enough room (then nothing is offered). Only the profile's own copies are
 * offered (a profile never removes another's). `keep`: never offered (the one being saved).
 */
export function makeRoom(all: Copy[], profileId: string, adding: number, limitGb: number, keep?: string): Copy[] | null {
  const used = usedBytes(all);
  if (!overLimit(used, adding, limitGb)) return [];
  const cand = all
    .filter(c => c.profileId === profileId && c.state === 'done' && c.id !== keep && isWatched(c))
    .sort((a, b) => (a.finishedAt || a.savedAt || a.at) - (b.finishedAt || b.savedAt || b.at));
  const out: Copy[] = [];
  let left = used;
  for (const c of cand) {
    out.push(c);
    left -= c.sizeBytes || 0;
    if (!overLimit(left, adding, limitGb)) return out;
  }
  return null;
}

// ---- Tidy up after watching ----
export const TIDY_AFTER_MS = 24 * 60 * 60 * 1000;
/** The saved EPISODES due to go: finished a day ago or more. Films are never tidied (one
 *  saved for a flight is watched again); the one playing now is never touched. */
export const dueForTidy = (all: Copy[], now: number, playing?: string | null): Copy[] =>
  all.filter(c => c.state === 'done' && c.showId && c.finishedAt && now - c.finishedAt >= TIDY_AFTER_MS && c.id !== playing);

/** When a copy was finished, from what the server says of the profile's progress (watched on
 *  the TV, the website or streamed here counts as much as the saved copy played here). */
export function finishedFrom(p: {position?: number; duration?: number; finished?: boolean; updatedAt?: number} | null | undefined, now: number): number | null {
  if (!p) return null;
  const done = p.finished === true || (!!p.duration && p.duration > 0 && (p.position || 0) / p.duration > FINISHED_AT);
  return done ? Math.min(p.updatedAt || now, now) : null;
}

// ---- Keep the next episodes ready ----
export const KEEP_NEXT = 2;
export type Ep = {id: string; season: number; episode: number};

/**
 * The episodes to save so the next `n` after the one being watched are on the phone: the
 * next `n` in order (specials — season 0 — only when the one watched is a special), minus
 * those already saved or on their way (`have`).
 */
export function nextToKeep<E extends Ep>(episodes: E[], cur: {season: number; episode: number}, have: Set<string>, n = KEEP_NEXT): E[] {
  const pool = episodes.filter(e => e && e.id && (cur.season === 0 ? true : e.season > 0));
  const later = pool
    .filter(e => e.season > cur.season || (e.season === cur.season && e.episode > cur.episode))
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .slice(0, n);
  return later.filter(e => !have.has(e.id));
}

/** Keep-next works only when it is on and the phone is on Wi-Fi (never mobile data). */
export const keepNextNow = (on: boolean, net: string) => on && net === 'wifi';

/** The quality keep-next saves at: the person's choice, or 720p when it is "Ask each time"
 *  (nothing can be asked in the background). */
export const keepNextQuality = (q: string) => (q === 'ask' ? '720' : q);
