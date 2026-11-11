// "Save it to this device as soon as it is on the server" — the rules, PURE (no React Native),
// tested. The contract is docs/offline-wishes.md; the website's half is public/js/offlineWish.js
// and devicejobs.js (the words below are its words).
import type {OfflineWish} from '../../api';
import type {Tone} from './rules';

export type WishTarget = {
  type: 'movie' | 'show';
  imdbId: string;
  scope?: 'title' | 'season' | 'show';
  jobId?: string | null;
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  showTitle?: string | null;
  poster?: string | null;
  /** the running time, when known (the size sheet estimates from it) */
  duration?: number | null;
};

/** The wish (or the season / show wish) that covers this title on this device, if any. */
export function wishFor(wishes: OfflineWish[], t: Pick<WishTarget, 'type' | 'imdbId' | 'season' | 'episode'> | null | undefined): OfflineWish | null {
  if (!t || !t.imdbId) return null;
  const type = t.type === 'show' ? 'show' : 'movie';
  const own = wishes.filter(w => !w.parentId && w.type === type && w.imdbId === t.imdbId);
  if (type === 'movie') return own[0] || null;
  return (
    own.find(w => w.scope === 'title' && Number(w.season) === Number(t.season) && Number(w.episode) === Number(t.episode)) ||
    own.find(w => w.scope === 'season' && Number(w.season) === Number(t.season)) ||
    own.find(w => w.scope === 'show') ||
    null
  );
}

/** A wish still standing (a failed one is offered again, like none). */
export const wishOn = (w: OfflineWish | null | undefined) => !!w && w.state !== 'failed';

/** The body POST /offline-wishes takes, from a target and the size picked. */
export function wishBody(t: WishTarget, quality: string, device: {id: string; name?: string | null}, hevc: boolean) {
  const scope: 'title' | 'season' | 'show' = t.scope === 'season' || t.scope === 'show' ? t.scope : 'title';
  return {
    deviceId: device.id,
    ...(device.name ? {deviceName: device.name} : {}),
    scope,
    type: t.type === 'show' ? ('show' as const) : ('movie' as const),
    ...(t.imdbId ? {imdbId: t.imdbId} : {}),
    ...(t.jobId ? {jobId: t.jobId} : {}),
    ...(scope !== 'show' && t.season != null ? {season: Number(t.season)} : {}),
    ...(scope === 'title' && t.episode != null ? {episode: Number(t.episode)} : {}),
    ...(t.title ? {title: t.title} : {}),
    ...(t.showTitle ? {showTitle: t.showTitle} : {}),
    ...(t.poster ? {poster: t.poster} : {}),
    quality,
    hevc,
  };
}

/** "Show · S2 E5", "Show · S2" (a season), the show (every new episode), the film. */
export const wishName = (w: Pick<OfflineWish, 'type' | 'scope' | 'title' | 'showTitle' | 'season' | 'episode'>) =>
  w.type === 'show'
    ? w.scope === 'show'
      ? `${w.showTitle || w.title || 'A show'}`
      : `${w.showTitle || w.title || 'Episode'} · S${w.season}${w.scope === 'season' ? '' : ` E${w.episode}`}`
    : w.title || 'A film';

/** A wish's row on On this device: its head, the line under it (devicejobs.js wishStatus). */
export function wishLook(w: OfflineWish): {tone: Tone; head: string; line: string} {
  if (w.state === 'failed') return {tone: 'bad', head: "Won't arrive", line: w.error || ''};
  if (w.scope === 'season') return {tone: 'wait', head: `Every new episode of season ${w.season}`, line: "Waiting for the server's copy — each one is saved here by itself as it arrives"};
  if (w.scope === 'show') return {tone: 'wait', head: 'Every new episode', line: "Waiting for the server's copy — each one is saved here by itself as it arrives"};
  if (w.state === 'ready') {
    const c = w.copy || null;
    return c && c.state && c.state !== 'ready'
      ? {tone: 'busy', head: 'Arrived — the server is preparing it', line: [w.note, 'it is saved here by itself'].filter(Boolean).join(' · ')}
      : {tone: 'busy', head: 'Arrived — saving here next', line: w.note || ''};
  }
  return {tone: 'wait', head: "Waiting for the server's copy", line: 'It is saved here by itself when it arrives'};
}

/** The size sheet's lead line for a title not on the server yet (offlineWish.js askWish). */
export function wishLead(t: WishTarget, label: string): string {
  if (t.scope === 'show') return `Every new episode of “${t.showTitle || label}” that arrives on the server is saved inside Aurora on this device — by itself, the next time Aurora is open here.`;
  if (t.scope === 'season') return `Every episode of season ${t.season} that arrives on the server is saved inside Aurora on this device — by itself, the next time Aurora is open here.`;
  return `“${label}” isn't on the server yet. It will be saved inside Aurora on this device as soon as it arrives — by itself, the next time Aurora is open here.`;
}
/** The toast once a wish is made. */
export function wishMadeText(t: WishTarget, label: string): string {
  if (t.scope === 'show') return `Every new episode of “${t.showTitle || label}” will be saved to this device as it arrives`;
  if (t.scope === 'season') return `Every new episode of season ${t.season} will be saved to this device as it arrives`;
  return `“${label}” will be saved to this device when it arrives`;
}
/** The two choices an episode's sheet adds, one at most (the site's chips). */
export const scopeChoices = (t: WishTarget) =>
  t.type === 'show' && t.season != null && t.episode != null && t.scope !== 'season' && t.scope !== 'show'
    ? [
        {scope: 'season' as const, label: `And every new episode of season ${t.season}`},
        {scope: 'show' as const, label: 'And every new episode of this show'},
      ]
    : [];

/** The ready wishes this device should save now: ready, with a library item, not saved here or on its way. */
export const wishesToSave = (wishes: OfflineWish[], here: (libraryId: string) => 'done' | 'moving' | null, busy: Set<string>) =>
  wishes.filter(w => w.state === 'ready' && !!w.libraryId && !busy.has(w.id) && here(w.libraryId!) !== 'moving');

/** A socket message for this device? (`offline_wish` carries the wish; `offline_wish_removed` its id.) */
export function wishMessage(msg: {type?: string; wish?: OfflineWish; id?: string; deviceId?: string} | null | undefined, me: string): {kind: 'upsert'; wish: OfflineWish} | {kind: 'remove'; id: string} | null {
  if (!msg) return null;
  if (msg.type === 'offline_wish_removed') {
    if (!msg.id || (msg.deviceId && msg.deviceId !== me)) return null;
    return {kind: 'remove', id: msg.id};
  }
  const w = msg.wish;
  if (!w || w.deviceId !== me) return null;
  return {kind: 'upsert', wish: w};
}
