// "Choose episodes" — the rules, PURE (no React Native), tested. The website's
// public/js/offlineChoose.js, word for word (elia, 2026-11-11: "save next 3 is confusing, why
// not just give the user the ability to choose which episodes to download?").
import {fmtSize} from './rules';

// the server's own rates for a re-encoded copy (src/media/offline.js KBPS), video + sound
const KBPS: Record<string, number> = {1080: 4328, 720: 2228, 480: 1078};
export const CHOOSE_SIZES = [
  {quality: 'original', label: 'Original'},
  {quality: '1080', label: '1080p'},
  {quality: '720', label: '720p'},
  {quality: '480', label: '480p'},
];
export const PRETICK = 3;

/** Where one episode stands on this device. ready: on the server · later: not yet — a wish. */
export type Standing = 'saved' | 'saving' | 'wished' | 'ready' | 'later';
export type ChooseEp = {
  season: number;
  episode: number;
  title: string;
  /** the library episode, when the server has it */
  libId?: string | null;
  duration?: number;
  sizeBytes?: number;
  aired?: boolean;
};
export type ChooseRow = ChooseEp & {key: string; st: Standing; pct?: number; paused?: boolean};

export const standing = (o: {here: boolean; job: boolean; wish: boolean; onServer: boolean}): Standing =>
  o.here ? 'saved' : o.job ? 'saving' : o.wish ? 'wished' : o.onServer ? 'ready' : 'later';
export const tickable = (st: Standing) => st === 'ready' || st === 'later';

/** What one episode would take at a size: Original is the file itself (unknown before the
 *  server has it — 1080p's rate stands in, estimated); the others by the running time. */
export function sizeAt(r: Pick<ChooseEp, 'duration' | 'sizeBytes'>, quality: string, fallbackSecs = 0): {bytes: number; estimated: boolean} {
  const secs = r.duration && r.duration > 0 ? r.duration : fallbackSecs;
  if (quality === 'original') {
    if (r.sizeBytes && r.sizeBytes > 0) return {bytes: r.sizeBytes, estimated: false};
    return {bytes: secs ? Math.round(((KBPS[1080] * 1000) / 8) * secs) : 0, estimated: true};
  }
  return {bytes: secs ? Math.round((((KBPS[quality] || KBPS[720]) * 1000) / 8) * secs) : 0, estimated: true};
}

/** The ones ticked to begin with: from the next episode to watch, the next `n` that can be
 *  ticked and are not finished. */
export function preTicked(rows: ChooseRow[], o: {from?: {season: number; episode: number} | null; n?: number; finished?: (r: ChooseRow) => boolean} = {}): string[] {
  const from = o.from;
  const start = from ? Math.max(0, rows.findIndex(r => r.season === from.season && r.episode === from.episode)) : 0;
  const out: string[] = [];
  for (const r of rows.slice(start)) {
    if (out.length >= (o.n ?? PRETICK)) break;
    if (tickable(r.st) && !(o.finished && o.finished(r))) out.push(r.key);
  }
  return out;
}

/** "4 episodes · ≈ 3.2 GB · 2 when they arrive" */
export function totalLine(picked: ChooseRow[], quality: string, fallbackSecs = 0): string {
  if (!picked.length) return 'No episodes ticked';
  let bytes = 0;
  let est = false;
  for (const r of picked) {
    const s = sizeAt(r, quality, fallbackSecs);
    bytes += s.bytes;
    est = est || s.estimated;
  }
  const later = picked.filter(r => r.st === 'later').length;
  return [`${picked.length} episode${picked.length === 1 ? '' : 's'}`, bytes ? `${est ? '≈ ' : ''}${fmtSize(bytes)}` : null, later ? `${later} when ${later === 1 ? 'it arrives' : 'they arrive'}` : null]
    .filter(Boolean)
    .join(' · ');
}
export const saveWords = (n: number) => (n ? `Save ${n} episode${n === 1 ? '' : 's'}` : 'Save');

/** What a row says under its name (none for a plain one on the server). */
export function rowWhat(r: ChooseRow): string | null {
  switch (r.st) {
    case 'saved':
      return 'Saved on this device';
    case 'saving':
      return r.paused ? 'Paused' : `Saving ${Math.round((r.pct || 0) * 100)}%`;
    case 'wished':
      return 'Will be saved when it arrives';
    case 'later':
      return r.aired === false ? 'Not out yet — saves here when it arrives' : 'Not on the server yet — saves here when it arrives';
    default:
      return null;
  }
}

/** The running time most episodes have (an estimate for the ones the server does not have yet). */
export const typicalSecs = (eps: Pick<ChooseEp, 'duration'>[]) => {
  const d = eps.map(e => e.duration || 0).filter(x => x > 0).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 0;
};

/** The size to start on: the standing one, else the last one picked, else 720p. */
export const firstSize = (pref: string, last: string | null) => (pref && pref !== 'ask' ? pref : last && CHOOSE_SIZES.some(z => z.quality === last) ? last : '720');
