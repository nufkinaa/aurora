// The Resync button against the film's AUDIO, and what the player does when
// the server says a title's subtitle timing changed. PURE — no React, no
// network of its own (the player hands in api calls and a clock), so the
// logic tests run it as it is.
//
// The server (src/routes/subtitles.js, src/media/subaudio.js) listens to the
// playing audio track, matches what is said to the track's lines and, when it
// finds a match, serves the corrected cues at the SAME track url from then on,
// to every device. The TV only asks, waits, reloads the file and says what
// happened in the server's own words.
//
//   resyncMode      which kind of Resync this track can have
//   resyncBody      the body all three routes take
//   progressLine    "Listening to the film… 40 %" / "Matching…"
//   outcomeOf       a job's answer → still running (null) or how it ended
//   errorOutcome    a failed request → how it ended
//   runResync       the whole flow: start, poll about once a second, settle
//   toastFor        what the viewer is told at the end
//   mergeSubInfo    a fresh item's ★ / timing into the tracks already listed
//   syncPlan        a `subtitle_sync` message → refetch? reload the cues?
//   reloadDue       one cue reload for one change, from either side
//   switchedToast   the auto pick moved to the ★ track: say why

// ---------------------------------------------------------------- types
export type TimingVerdict = 'in-time' | 'moved' | 'parts' | 'unmatched' | 'original';
export type SubTiming = {
  verdict: TimingVerdict | string;
  by?: 'audio' | 'track' | string;
  words?: string;
  r?: number;
  resync?: boolean;
};
export type JobState = 'listening' | 'matching' | 'done' | 'failed' | 'none';
// POST /api/subtitles/resync and /resync/status
export type ResyncAnswer = {
  state: JobState | string;
  progress?: number;
  verdict?: string | null;
  applied?: boolean;
  words?: string | null;
  parts?: number | null;
  ms?: number | null;
  error?: string | null;
  timing?: SubTiming | null;
};
export type ResyncBody = {id: string; track: string; audio: number};

export type Outcome =
  // the server moved the cues and serves them at the same url: reload, delay → 0
  | {kind: 'applied'; words: string}
  // the audio says the file is already in time: what is served is the file's
  // own timing — reload (an older correction may be gone), delay → 0
  | {kind: 'in-time'; words: string}
  // nothing matched: everything stays as it was, the delay too
  | {kind: 'unmatched'; words: string}
  | {kind: 'failed'; words: string}
  // a server from before the route: the old behaviour (re-download, delay → 0)
  | {kind: 'old-server'}
  // the server refused this track (its own words): nothing changes
  | {kind: 'refused'; words: string}
  // no answer any more (the line, a restart, too long): nothing changes here
  | {kind: 'lost'; words: string}
  // the player was left: nothing to say
  | {kind: 'cancelled'};

/** Whether this outcome means: load the cue file again and set this track's
 *  own delay back to 0 (the server's timing replaces it). */
export const takesServerTiming = (o: Outcome): boolean => o.kind === 'applied' || o.kind === 'in-time';

// ---------------------------------------------------------------- which kind
/** The address of a track as the title lists it — the routes look it up by
 *  exactly that, with no query (the player puts `?retry=` on its own fetch). */
export const trackPath = (url: string | null | undefined): string => String(url || '').replace(/[?#].*$/, '');

const SERVER_TRACK = /^\/stream\/(?:subtitle\/[^/?#]+|embedded\/[^/?#]+\/\d+)$/;

/** 'audio': a library title's own track (a sidecar or one inside the file) —
 *  the server can match it to the film's audio.
 *  'reload': a torrent stream's track, or one from elsewhere — the server has
 *  no file of its audio to listen to; the button re-downloads the track and
 *  drops the delay (the old behaviour, named as what it is: "Reload").
 *  'none': no track on. */
export const resyncMode = (o: {isTorrent: boolean; url: string | null | undefined}): 'audio' | 'reload' | 'none' => {
  if (!o.url) return 'none';
  if (o.isTorrent) return 'reload';
  return SERVER_TRACK.test(trackPath(o.url)) ? 'audio' : 'reload';
};

/** The routes' body. `audio` is the playing dub's place among the file's
 *  audio tracks (item.audioTracks), 0 when the file has one. */
export const resyncBody = (
  id: string,
  url: string,
  audioTracks: {index: number}[] | null | undefined,
  audioIdx: number,
): ResyncBody => {
  const list = audioTracks || [];
  const at = list.findIndex(t => t.index === audioIdx);
  return {id, track: trackPath(url), audio: at > 0 ? at : 0};
};

// ---------------------------------------------------------------- while it runs
/** The line shown while the server works: it listens first (the long part —
 *  the film's whole audio, cached afterwards), then matches. */
export const progressLine = (a: Pick<ResyncAnswer, 'state' | 'progress'>): string => {
  if (a.state === 'matching') return 'Matching…';
  const p = Math.max(0, Math.min(0.99, Number(a.progress) || 0));
  return `Listening to the film… ${Math.round(p * 100)} %`;
};

const MSG = {
  unmatched: "Couldn't match — kept as it was",
  inTime: 'Already in time — nothing to move',
  applied: 'Matched to the film',
  lost: "Lost touch with the server — kept as it was",
  gone: 'The resync was interrupted — kept as it was',
  slow: "Still matching on the server — the subtitles update by themselves when it's done",
};

/** A job's answer → null while it runs, else how it ended. The server's
 *  `words` are what the viewer reads ("Moved 1.8 s later", "Matched to this
 *  release in 3 parts"); the fallbacks only cover an answer without them. */
export const outcomeOf = (a: ResyncAnswer | null | undefined): Outcome | null => {
  if (!a || typeof a !== 'object') return {kind: 'lost', words: MSG.lost};
  const words = typeof a.words === 'string' && a.words.trim() ? a.words.trim() : '';
  if (a.state === 'listening' || a.state === 'matching') return null;
  if (a.state === 'failed') return {kind: 'failed', words: words || MSG.unmatched};
  if (a.state === 'done') {
    if (a.applied) return {kind: 'applied', words: words || MSG.applied};
    if (a.verdict === 'in-time') return {kind: 'in-time', words: words || MSG.inTime};
    return {kind: 'unmatched', words: words || MSG.unmatched};
  }
  // "none": the server holds no job for this track (it restarted, or the job
  // was forgotten) — nothing was changed by this press
  return {kind: 'lost', words: MSG.gone};
};

type ErrLike = {status?: number; message?: string} | null | undefined;

/** A request that failed → how the press ends. A 404 WITHOUT the server's own
 *  words (Express's "Cannot POST", or the catch-all "Not found") is a server
 *  from before the route; a 404 or 400 WITH them is this server refusing this
 *  track ("that subtitle is not one of this title's"). */
export const errorOutcome = (e: ErrLike, path = '/api/subtitles/resync'): Outcome => {
  const status = e && typeof e.status === 'number' ? e.status : 0;
  const msg = String((e && e.message) || '');
  if (status === 404 && (!msg || msg === 'Not found' || msg === `404 ${path}` || /^404 \//.test(msg))) return {kind: 'old-server'};
  if (status >= 400 && status < 500 && msg) return {kind: 'refused', words: `Couldn't resync: ${msg}`};
  return {kind: 'lost', words: MSG.lost};
};

// ---------------------------------------------------------------- the flow
export type ResyncDeps = {
  start: (b: ResyncBody) => Promise<ResyncAnswer>;
  status: (b: ResyncBody) => Promise<ResyncAnswer>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** false once the player is gone: the polling stops (the server's job does not) */
  live: () => boolean;
  /** each answer while it runs — the progress line */
  onProgress?: (line: string, a: ResyncAnswer) => void;
};
export const RESYNC_POLL_MS = 1000;
// The listening reads the whole film's audio once (cached after): minutes on
// a long film while other work runs. Past this the press stops waiting; the
// job goes on and `subtitle_sync` reloads the track when it lands.
export const RESYNC_MAX_MS = 15 * 60 * 1000;
// Polls in a row that may fail (a Wi-Fi blink) before the press gives up.
export const RESYNC_MAX_MISSES = 6;

/** Start (or join) the server's job for one track, poll it about once a
 *  second, and settle on how it ended. Never throws. */
export const runResync = async (
  deps: ResyncDeps,
  body: ResyncBody,
  opts: {pollMs?: number; maxMs?: number; maxMisses?: number} = {},
): Promise<Outcome> => {
  const pollMs = opts.pollMs ?? RESYNC_POLL_MS;
  const maxMs = opts.maxMs ?? RESYNC_MAX_MS;
  const maxMisses = opts.maxMisses ?? RESYNC_MAX_MISSES;
  const t0 = deps.now();
  let a: ResyncAnswer;
  try {
    a = await deps.start(body);
  } catch (e) {
    return deps.live() ? errorOutcome(e as ErrLike) : {kind: 'cancelled'};
  }
  let misses = 0;
  for (;;) {
    if (!deps.live()) return {kind: 'cancelled'};
    const end = outcomeOf(a);
    if (end) return end;
    deps.onProgress?.(progressLine(a), a);
    if (deps.now() - t0 >= maxMs) return {kind: 'lost', words: MSG.slow};
    await deps.sleep(pollMs);
    if (!deps.live()) return {kind: 'cancelled'};
    try {
      a = await deps.status(body);
      misses = 0;
    } catch (e) {
      const err = e as ErrLike;
      // the server answered and said no (a 404 now: the title left the
      // library mid-job) — no use asking again
      if (err && typeof err.status === 'number' && err.status >= 400) return {kind: 'lost', words: MSG.gone};
      if (++misses >= maxMisses) return {kind: 'lost', words: MSG.lost};
    }
  }
};

/** What the viewer is told at the end ('' for nothing). `delayWas`: this
 *  track's own ± delay before the press — when the server's timing replaces
 *  a delay that was not 0, the toast says so. */
export const toastFor = (o: Outcome, delayWas = 0): string => {
  const cleared = Math.abs(delayWas) >= 0.05 ? ` · your ${delayWas > 0 ? '+' : '−'}${Math.abs(delayWas).toFixed(1)}s delay is back to 0` : '';
  switch (o.kind) {
    case 'applied':
    case 'in-time':
      return `${o.words}${cleared}`;
    case 'unmatched':
    case 'failed':
    case 'refused':
    case 'lost':
      return o.words;
    case 'old-server':
      return "This server can't match subtitles to the audio yet — re-downloaded the track, delay reset to 0.0s";
    default:
      return '';
  }
};

// ---------------------------------------------------------------- subtitle_sync
type Sub = {url: string; star?: boolean; starWhy?: string; timing?: SubTiming | null};

/** A fresh copy of the title's tracks (after `subtitle_sync`) folded into the
 *  ones the player already lists: each listed track takes the server's new
 *  ★ / starWhy / timing (a track the fresh list does not carry keeps its
 *  timing but loses any ★ — the server decides the ★ over its own list), and
 *  tracks new to the list are added at the end (the menu's keys never move).
 *  The SAME array back when nothing changed, so nothing re-renders. */
export const mergeSubInfo = <T extends Sub>(prev: T[], fresh: T[] | null | undefined): T[] => {
  const byUrl = new Map<string, T>();
  for (const t of fresh || []) if (t && t.url && !byUrl.has(t.url)) byUrl.set(t.url, t);
  let changed = false;
  const have = new Set<string>();
  const out = prev.map(t => {
    have.add(t.url);
    const f = byUrl.get(t.url);
    const star = !!(f && f.star === true);
    const starWhy = star ? f!.starWhy || 'Matches this release' : undefined;
    const timing = f ? f.timing ?? undefined : t.timing;
    if (!!t.star === star && (t.starWhy || undefined) === starWhy && JSON.stringify(t.timing ?? null) === JSON.stringify(timing ?? null)) return t;
    changed = true;
    const next = {...t, timing} as T;
    if (star) Object.assign(next, {star: true, starWhy});
    else {
      delete (next as Sub).star;
      delete (next as Sub).starWhy;
    }
    if (timing === undefined) delete (next as Sub).timing;
    return next;
  });
  for (const t of byUrl.values()) {
    if (have.has(t.url)) continue;
    out.push(t);
    changed = true;
  }
  return changed ? out : prev;
};

/** What a `subtitle_sync` message means for this player: act only for the
 *  title on screen (a library title — a torrent stream has no such news),
 *  and then refetch the title (fresh, past the read cache). */
export const syncPlan = (o: {msgId: unknown; playingId: string | null | undefined; isTorrent: boolean}): {refetch: boolean} => ({
  refetch: !o.isTorrent && !!o.playingId && typeof o.msgId === 'string' && o.msgId === o.playingId,
});

/** After the refetch: reload the track on screen when the title still lists
 *  it AND its served timing changed. `prev` = the tracks as the player knew
 *  them before this message: the server sends `subtitle_sync` once per
 *  rescan for every track of the title it lined up, so after a restart (the
 *  background check going through a title's Hebrew tracks one by one) the
 *  player heard it two or three times and reloaded the track on screen each
 *  time though only another track had moved (Mi TV, 2026-10-18). Without
 *  `prev` (or a track it never knew), the old rule: reload. */
export const reloadAfterSync = (curUrl: string | null | undefined, fresh: Sub[] | null | undefined, prev?: Sub[] | null): boolean => {
  if (!curUrl) return false;
  const path = trackPath(curUrl);
  const now = (fresh || []).find(t => t && t.url === path);
  if (!now) return false;
  const was = prev ? prev.find(t => t && t.url === path) : undefined;
  if (!was) return true;
  return JSON.stringify(was.timing ?? null) !== JSON.stringify(now.timing ?? null);
};

// The Resync's own end and the `subtitle_sync` it causes arrive about a
// second apart, in either order; by the first of them the server already
// serves the new timing, so one reload covers both.
export const RELOAD_DEDUPE_MS = 4000;
export const reloadDue = (last: {url: string; at: number} | null, url: string, now: number, windowMs = RELOAD_DEDUPE_MS): boolean =>
  !last || last.url !== url || now - last.at >= windowMs;

/** The auto pick moved from one track to another of the SAME language, onto
 *  the ★ one: "Switched to Hebrew 2 — matches this release". null when the
 *  move was something else (a language that just arrived says its own
 *  thing). */
export const switchedToast = (
  from: {label: string; star?: boolean} | null | undefined,
  to: {label: string; star?: boolean} | null | undefined,
  sameLang: boolean,
): string | null => (from && to && sameLang && to.star === true && from.label !== to.label ? `Switched to ${to.label} — matches this release` : null);
