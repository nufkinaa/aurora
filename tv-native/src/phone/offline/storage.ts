// Where saved copies live, what was watched, and "Keep the next episode ready" — the phone's
// storage rules, PURE (no React Native), tested.
//
//   Save to                       this phone, or its SD card when it has one
//   Remove watched                one press on On this device removes the copies watched to
//                                 the end, with Undo (the website's) — never by itself
//   Keep the next episode ready   when a saved episode is watched to the end, the next one is
//                                 saved by itself at the same size — or, when the server does
//                                 not have it yet, wished for (offline/wishes.ts). Off unless
//                                 turned on; it only ADDS.
//
// elia (2026-11-10/11): no cap on what is saved, and NOTHING leaves a device by itself — the
// space limit and the day-after tidy-up of phone 1.1.2 are gone.

export type StoragePrefs = {
  /** the folder of the chosen volume (getExternalFilesDirs); null: the phone's own storage */
  volume: string | null;
  /** "Keep the next episode ready" (off unless turned on) */
  keepNext: boolean;
  /** when it was last turned on: only episodes finished AFTER that count */
  keepNextAt: number;
};
export const STORAGE_DEFAULTS: StoragePrefs = {volume: null, keepNext: false, keepNextAt: 0};

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

export const GB = 1024 ** 3;

export type Copy = {
  id: string;
  profileId: string;
  title: string;
  showId?: string | null;
  showTitle?: string | null;
  season?: number | null;
  episode?: number | null;
  state: 'queued' | 'preparing' | 'saving' | 'retrying' | 'paused' | 'done' | 'failed';
  sizeBytes: number;
  duration: number;
  position?: number;
  finishedAt?: number | null;
  savedAt?: number;
  quality?: string;
  at: number;
};

/** What the copies on this phone take, or will once they are down. A failed one takes nothing. */
export const usedBytes = (all: Copy[]) => all.filter(c => c.state !== 'failed').reduce((n, c) => n + (c.sizeBytes || 0), 0);

/** The server's own rule for "finished" (src/profiles.js): past 95 %. */
export const FINISHED_AT = 0.95;
export const isWatched = (c: Pick<Copy, 'finishedAt' | 'position' | 'duration'>) => !!c.finishedAt || (c.duration > 0 && (c.position || 0) / c.duration > FINISHED_AT);

/** "Remove watched": the profile's saved copies watched to the end (here, or as the server says). */
export const watchedCopies = <C extends Copy>(all: C[], profileId: string): C[] => all.filter(c => c.profileId === profileId && c.state === 'done' && isWatched(c));

/** When a copy was finished, from what the server says of the profile's progress (watched on
 *  the TV, the website or streamed here counts as much as the saved copy played here). */
export function finishedFrom(p: {position?: number; duration?: number; finished?: boolean; updatedAt?: number} | null | undefined, now: number): number | null {
  if (!p) return null;
  const done = p.finished === true || (!!p.duration && p.duration > 0 && (p.position || 0) / p.duration > FINISHED_AT);
  return done ? Math.min(p.updatedAt || now, now) : null;
}

/** "6.2 GB saved here · room for ≈ 18 GB more" (On this device, under its heading). */
export const roomLine = (savedBytes: number, freeBytes: number, fmt: (b: number) => string) =>
  [savedBytes > 0 ? `${fmt(savedBytes)} saved here` : null, freeBytes > 0 ? `room for ≈ ${fmt(freeBytes)} more` : null].filter(Boolean).join(' · ');

// ---- Keep the next episode ready ----
/**
 * The saved episodes whose next one should be looked at now: an episode saved here, watched to
 * the end AFTER the switch was turned on (`since`), and not looked at before (`done`). Finished
 * = what this phone saw (the copy's own position / finishedAt) or the server's progress for it.
 */
export function smartCandidates<C extends Copy>(
  copies: C[],
  profileId: string,
  since: number,
  done: Set<string>,
  progress: Record<string, {position?: number; duration?: number; finished?: boolean; updatedAt?: number}> = {},
): C[] {
  const after = (at?: number | null) => !!at && at >= since;
  return copies.filter(c => {
    if (c.profileId !== profileId || c.state !== 'done' || !c.showId || c.season == null || c.episode == null) return false;
    if (done.has(c.id)) return false;
    if (c.finishedAt && after(c.finishedAt)) return true;
    const p = progress[c.id];
    return !!p && after(p.updatedAt) && (p.finished === true || (!!p.duration && p.duration > 0 && (p.position || 0) / p.duration > FINISHED_AT));
  });
}

/** What /api/next-episode answers, read: a library episode to save, or one on its way to wish for. */
export type NextAnswer = {kind: 'library'; id: string} | {kind: 'stream'; imdbId: string; season: number; episode: number; title?: string | null} | null;
export function readNext(r: unknown): NextAnswer {
  const n = (r as {next?: Record<string, unknown>} | null)?.next;
  if (!n || typeof n !== 'object') return null;
  if (n.kind === 'library' && typeof n.id === 'string' && n.id) return {kind: 'library', id: n.id};
  if (n.kind === 'stream' && typeof n.imdbId === 'string' && n.season != null && n.episode != null)
    return {kind: 'stream', imdbId: n.imdbId, season: Number(n.season), episode: Number(n.episode), title: (n.title as string) || null};
  return null;
}

// ---- the place: "Saved for offline" ----
export type Group<C extends Copy> = {kind: 'film'; copy: C} | {kind: 'show'; showId: string; showTitle: string; episodes: C[]; bytes: number; watched: number; next: C | null};
/** Films as rows, a show as one group with its episodes in order and the next one not finished. */
export function groupSaved<C extends Copy>(copies: C[]): Group<C>[] {
  const out: Group<C>[] = [];
  const shows = new Map<string, Group<C> & {kind: 'show'}>();
  const done = copies.filter(c => c.state === 'done').sort((a, b) => (b.savedAt || b.at) - (a.savedAt || a.at));
  for (const c of done) {
    if (!c.showId) {
      out.push({kind: 'film', copy: c});
      continue;
    }
    let g = shows.get(c.showId);
    if (!g) {
      g = {kind: 'show', showId: c.showId, showTitle: c.showTitle || c.title, episodes: [], bytes: 0, watched: 0, next: null};
      shows.set(c.showId, g);
      out.push(g);
    }
    g.episodes.push(c);
    g.bytes += c.sizeBytes || 0;
    if (isWatched(c)) g.watched++;
  }
  for (const g of shows.values()) {
    g.episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    g.next = g.episodes.find(e => !isWatched(e)) || null;
  }
  return out;
}
const hm = (secs: number) => {
  const m = Math.max(1, Math.round(secs / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`;
};
/** "1 h 12 min left · 1.2 GB · Original quality · English" (a film's line, the site's). */
export function copyLine(c: Copy & {audioLabel?: string | null}, fmt: (b: number) => string): string {
  const left = isWatched(c) ? 'Watched' : c.duration > 0 && (c.position || 0) > 10 ? `${hm(c.duration - (c.position || 0))} left` : c.duration > 0 ? hm(c.duration) : null;
  const q = c.quality ? (c.quality === 'original' ? 'Original quality' : `${c.quality}p`) : null;
  return [left, c.sizeBytes ? fmt(c.sizeBytes) : null, q, c.audioLabel || null].filter(Boolean).join(' · ');
}
/** "3 episodes · 2.1 GB · 1 watched" (a show's line). */
export const showLine = (g: {episodes: unknown[]; bytes: number; watched: number}, fmt: (b: number) => string) =>
  [`${g.episodes.length} episode${g.episodes.length === 1 ? '' : 's'}`, g.bytes ? fmt(g.bytes) : null, g.watched ? `${g.watched} watched` : null].filter(Boolean).join(' · ');
