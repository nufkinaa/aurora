// Which trailer plays, and from where (elia, 2026-10-09: no WebView any more).
//
//   1. Apple's trailer, when the server finds one (src/media/trailers.js —
//      Apple's own HLS playlist, H.264 up to 1080p, no DRM).
//   2. A YouTube trailer, resolved HERE on the TV by the native AuroraTrailers
//      module (NewPipeExtractor, android/.../TrailersModule.kt) into a stream
//      ExoPlayer plays — YouTube binds those URLs to the address that asked, so
//      the server cannot do it for us.
//   3. Nothing. There is no embedded-player fallback.
//
// Every failure goes to the server (POST /api/trailer/report → a [trailer] log
// line and the healer's "TV trailers" check) and to the usage stats.
import {NativeModules} from 'react-native';
import {api} from './api';
import {track} from './usage';

export type TrailerSource = 'apple' | 'youtube';
export type ResolvedTrailer = {
  uri: string;
  // react-native-video's source.type: tells ExoPlayer the format outright
  type: 'm3u8' | 'mpd' | 'mp4';
  headers?: Record<string, string>;
  source: TrailerSource;
  kind: 'hls' | 'dash' | 'progressive';
  quality: number;
  imdbId: string | null;
  // the YouTube key this came from (for a fresh resolve and for reports)
  ytId?: string;
};

type NativeResolved = {url: string; mime: string; kind: 'hls' | 'dash' | 'progressive'; quality: number};
const native = NativeModules.AuroraTrailers as {resolve(id: string): Promise<NativeResolved>} | undefined;

// A YouTube key that would not resolve is not tried again for a while in this
// run of the app (and not reported again either); one that did is kept for a
// few minutes, so the billboard coming back round does not ask YouTube twice.
const FAIL_MS = 30 * 60000;
const KEEP_MS = 15 * 60000;
const failedAt = new Map<string, number>();
const resolved = new Map<string, {at: number; r: ResolvedTrailer}>();
const appleFailed = new Set<string>(); // Apple playlists that would not play, this run

const typeOf = (kind: NativeResolved['kind']): ResolvedTrailer['type'] =>
  kind === 'hls' ? 'm3u8' : kind === 'dash' ? 'mpd' : 'mp4';

export const reportTrailerFailure = (o: {
  imdbId?: string | null;
  source: TrailerSource;
  stage: 'resolve' | 'play';
  why: string;
  id?: string;
}) => {
  const why = String(o.why || 'unknown').slice(0, 120);
  console.log('[trailer] fail', o.source, o.stage, o.imdbId || '-', o.id || '', why);
  track('feat', {f: 'trailer_fail', s: o.source, st: o.stage, w: why.slice(0, 40)});
  api.trailerReport({imdbId: o.imdbId || null, source: o.source, stage: o.stage, why, id: o.id}).catch(() => {});
};

// One YouTube key → a playable stream, on this TV. Rejects with the native
// code (blocked / unavailable / parse / network / timeout).
const resolveYoutube = async (id: string, imdbId: string | null, fresh = false): Promise<ResolvedTrailer> => {
  const hit = resolved.get(id);
  if (!fresh && hit && Date.now() - hit.at < KEEP_MS) return hit.r;
  if (!native) throw Object.assign(new Error('the trailer module is missing from this build'), {code: 'unavailable'});
  const n = await native.resolve(id);
  const r: ResolvedTrailer = {uri: n.url, type: typeOf(n.kind), source: 'youtube', kind: n.kind, quality: n.quality, imdbId, ytId: id};
  resolved.set(id, {at: Date.now(), r});
  return r;
};

const why = (e: unknown) => {
  const x = e as {code?: string; message?: string};
  return `${x?.code || 'error'}: ${String(x?.message || e).slice(0, 100)}`;
};

// The trailer to play for one title, or null for "none". `youtubeIds` are the
// keys this screen already holds (Detail's streamMeta, the hero's meta): used
// when the server has none of its own or cannot be asked. `maxYoutube` caps how
// many keys are tried (each can take up to 15 s); `skip` are keys the caller
// already saw fail this visit. `title`/`year` are carried for the log only.
export async function resolveTrailer(o: {
  imdbId?: string | null;
  type: 'movie' | 'show';
  title?: string;
  year?: number | null;
  youtubeIds?: string[];
  maxYoutube?: number;
  skip?: Set<string>;
}): Promise<ResolvedTrailer | null> {
  const imdbId = o.imdbId && /^tt\d+$/.test(o.imdbId) ? o.imdbId : null;
  let answer: Awaited<ReturnType<typeof api.trailer>> | null = null;
  if (imdbId) {
    try {
      answer = await api.trailer(imdbId, o.type);
    } catch {
      answer = null; // the server could not be asked: the keys we hold still work
    }
  }
  if (answer?.source === 'apple' && answer.hls && !appleFailed.has(answer.hls)) {
    return {uri: answer.hls, type: 'm3u8', source: 'apple', kind: 'hls', quality: answer.quality || 1080, imdbId};
  }
  const ids = [...new Set([...(answer?.source === 'youtube' ? answer.ids : []), ...(o.youtubeIds || [])])].filter(
    id => /^[\w-]{6,20}$/.test(id) && !o.skip?.has(id) && !(Date.now() - (failedAt.get(id) || 0) < FAIL_MS),
  );
  for (const id of ids.slice(0, o.maxYoutube ?? 3)) {
    try {
      return await resolveYoutube(id, imdbId);
    } catch (e) {
      failedAt.set(id, Date.now());
      reportTrailerFailure({imdbId, source: 'youtube', stage: 'resolve', why: why(e), id});
    }
  }
  if (answer?.source === 'none') console.log('[trailer] none for', imdbId, o.title || '', answer.why || '');
  return null;
}

// The player gave up on a trailer: report it and keep it from being picked
// again this run.
// Resolved AHEAD of need (elia, 2026-10-09: resolving takes 1-2 s and the
// hero holds 4.5 s before a trailer plays — so resolve during the hold, and
// on a title page the moment it opens, and the trailer is ready when asked
// for). One promise per title for 45 min (YouTube's stream addresses last
// hours; Apple's playlist is stable); a miss or a play failure forgets it,
// so the next ask tries again.
const prepared = new Map<string, {at: number; p: Promise<ResolvedTrailer | null>}>();
const PREP_MS = 45 * 60 * 1000;
export function prepareTrailer(o: Parameters<typeof resolveTrailer>[0]): Promise<ResolvedTrailer | null> {
  const key = (o.imdbId && /^tt\d+$/.test(o.imdbId) ? o.imdbId : null) || (o.youtubeIds || [])[0] || '';
  if (!key) return resolveTrailer(o);
  const hit = prepared.get(key);
  if (hit && Date.now() - hit.at < PREP_MS) return hit.p;
  const p = resolveTrailer(o)
    .catch(() => null)
    .then(r => {
      if (!r && prepared.get(key)?.p === p) prepared.delete(key);
      return r;
    });
  prepared.set(key, {at: Date.now(), p});
  return p;
}

export const trailerPlayFailed = (t: ResolvedTrailer, reason: string) => {
  if (t.imdbId) prepared.delete(t.imdbId);
  if (t.source === 'apple') appleFailed.add(t.uri);
  if (t.ytId) {
    failedAt.set(t.ytId, Date.now());
    resolved.delete(t.ytId);
  }
  reportTrailerFailure({imdbId: t.imdbId, source: t.source, stage: 'play', why: reason, id: t.ytId});
};

// A YouTube stream refused part-way (the extractor's current client has its
// stream URLs turned away after about a minute on some videos, HTTP 403 —
// NewPipe issue #13824): the same key resolved again, fresh. Null for Apple
// or when YouTube will not answer again.
export const refreshTrailer = async (t: ResolvedTrailer): Promise<ResolvedTrailer | null> => {
  if (t.source !== 'youtube' || !t.ytId) return null;
  try {
    return await resolveYoutube(t.ytId, t.imdbId, true);
  } catch {
    return null;
  }
};
