// The title page's pure helpers, shared by the TV's title page
// (screens/Detail.tsx) and the phone's (phone/screens/Detail.tsx): how a
// length, a size, a resolution and an air date read, how a library title is
// matched to its IMDb id and a catalogue title to a library copy, and what the
// Play button says about a download. Moved out of screens/Detail.tsx as they
// were (docs/android-phone/PLAN.md).
import {api, DownloadJob, MyDownload} from './api';

/** Which of the site's three states an episode is in (ui.js resolveAirStates). */
export type Air = 'aired' | 'upcoming' | 'tba';

// ui.js fmtDuration, ported.
export const fmtDuration = (seconds?: number) => {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};
// ui.js fmtBytes / resBadge, ported — the site puts both on the detail page and
// they are exactly the two facts that tell you what you actually have on disk.
export const fmtBytes = (b?: number) => {
  if (!b) return '';
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
};
// By width OR height (the site's resTier): a 2.40:1 film is 1920x800, and by
// height alone it read as 720p — which is why nearly every film said 720p.
export const resBadge = (height?: number, width?: number) => {
  if (!height) return null;
  const w = width || 0;
  if (w >= 3200 || height >= 2000) return '4K';
  if (w >= 1600 || height >= 1000) return 'HD';
  if (w >= 1100 || height >= 700) return '720p';
  return 'SD';
};
// Cinemeta hands back HTML-escaped text — "Josh O&apos;Connor" rendered
// literally on the page. A browser decodes entities for free when it sets
// textContent; RN's <Text> does not, so the five that actually occur are decoded
// here. (A general decoder would be a parser for a problem this isn't.)
export const unescapeHtml = (t?: string) =>
  (t || '')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

export const fmtClock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
};

// Resolve a library title to its IMDb id, RETRYING WITHOUT THE YEAR.
//
// The year is a disambiguator, and when it disagrees with the catalogue's it
// excludes the only right answer instead of narrowing the field. Measured on the
// live server: `Disclosure Day` resolves to tt15047880 with no year and to
// nothing at all with &year=2020 — which is why Sources came up empty for it.
export const resolveImdb = async (
  kind: 'movie' | 'show',
  title: string,
  year?: number,
): Promise<string | null> => {
  try {
    if (year) {
      const withYear = await api.imdbFor(kind, title, year);
      if (withYear.imdbId) return withYear.imdbId;
    }
    const plain = await api.imdbFor(kind, title);
    return plain.imdbId || null;
  } catch {
    return null;
  }
};

// Find a library item for a STREAMED title — the site's libMatch/findInLibrary
// (discover-detail.js), ported verbatim. Exact normalized title first, then a
// prefix match with the year agreeing: folder names carry extra words, and a
// copy of Avatar (2009) sitting in a folder called "Avatar Movie" is still your
// copy. This is what lets a Discover card's page say "Play" instead of sending
// you to stream a film the server already holds on disk.
export const libNorm = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export const libMatch = <T extends {title: string; year?: number}>(
  pool: T[],
  title: string,
  year?: number | null,
): T | null => {
  const want = libNorm(title);
  if (!want) return null;
  const exact = pool.find(i => libNorm(i.title) === want);
  if (exact) return exact;
  return (
    pool.find(i => {
      const have = libNorm(i.title);
      // STRICTER than the site's version, deliberately: on the site a wrong
      // prefix match only mislabels a button, but here it decides what the hero
      // Play button and the sources redirect actually PLAY. So the fuzzy branch
      // requires both years present and agreeing — "alien" must not bind to an
      // unyeared "Alien Resurrection" folder. A library folder without a year
      // can still exact-match above; it just doesn't get the fuzzy benefit.
      if (!year || !i.year || Math.abs(i.year - year) > 1) return false;
      if (Math.min(have.length, want.length) < 4) return false;
      return have.startsWith(want) || want.startsWith(have);
    }) || null
  );
};

// A download that is still on its way (anything else has ended).
export const ACTIVE_JOB = ['pending', 'approved', 'downloading'];
// With the socket open, the jobs list is still read this often while a card
// shows a job — the net under a missed download_update.
export const SLOW_READ_MS = 10000;
export function dropKey<T>(o: Record<string, T>, key: string): Record<string, T> {
  const next = {...o};
  delete next[key];
  return next;
}
// `id` and `mine`: a person can cancel their own from the title's page.
// `phase`: the server's stage of a running job (finding / starting / copying…),
// which is what tells "Starting download…" and "Almost there…" apart.
export type JobMark = {status: string; progress: number; id?: string; mine?: boolean; phase?: string | null};
/** A job from the list or the socket, as the title page keeps it. */
export const jobMark = (j: {status: string; progress?: number; id?: string; mine?: boolean; phase?: string | null}): JobMark => ({
  status: j.status,
  progress: j.progress || 0,
  id: j.id,
  mine: !!j.mine,
  phase: j.phase || null,
});
// "The same" as far as a card can show: its status, its stage and a whole percent (and the job).
export const sameJob = (a: JobMark | null | undefined, b: JobMark | null | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.id === b.id &&
    !!a.mine === !!b.mine &&
    a.status === b.status &&
    (a.phase || null) === (b.phase || null) &&
    Math.round((a.progress || 0) * 100) === Math.round((b.progress || 0) * 100));
export const sameJobs = (a: Record<string, JobMark>, b: Record<string, JobMark>) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!b[k] || !sameJob(a[k], b[k])) return false;
  return true;
};
// THE WEBSITE'S WORDS while a title downloads, word for word (its Save & watch
// button, saveState in public/js/screens/discover-detail.js; the root test
// test/download-words-parity.test.js holds the two together). The TV's and the
// phone's Play button say these, and nothing under it while the download runs
// (the website has no line there either: its button fills as it goes, as the
// strip under the TV's and the phone's does).
export const SAVE_WORDS = {
  pending: 'Waiting for approval',
  approved: 'Queued to download',
  finishing: 'Almost there…',
  starting: 'Starting download…',
  downloading: (pct: number) => `Downloading · ${pct}%`,
};
/** The Play button's words for a download on its way (the website's saveState). */
export const saveText = (job: {status: string; progress?: number; phase?: string | null}) => {
  if (job.status === 'pending') return SAVE_WORDS.pending;
  if (job.status === 'approved') return SAVE_WORDS.approved;
  if (job.phase === 'copying') return SAVE_WORDS.finishing;
  if (job.phase === 'finding' || job.phase === 'starting' || !((job.progress || 0) > 0)) return SAVE_WORDS.starting;
  return SAVE_WORDS.downloading(Math.round((job.progress || 0) * 100));
};
// An episode card's word for its download — the website's (epJobText in
// discover-detail.js): Requested / Starting / Downloading 34%. The TV's
// card prints it in capitals, as the rest of its line.
export const CARD_WORDS = {
  pending: 'Requested',
  starting: 'Starting',
  downloading: (pct: number) => `Downloading ${pct}%`,
};
export const dlText = (dl: {status: string; progress: number}) => {
  if (dl.status === 'pending') return CARD_WORDS.pending;
  const pct = Math.round((dl.progress || 0) * 100);
  if (dl.status !== 'downloading' || !(pct > 0)) return CARD_WORDS.starting;
  return CARD_WORDS.downloading(pct);
};
// The Play button's download story, past what a job carries (see dlNote):
//   finding — pressed, the best source is being looked up / requested
//   already — pressed again while it was on its way
//   ended   — the job left the list; ready once the copy shows up
//   ready   — on disk: "Ready — press Play"
//   failed  — `text` says why
export type DlNote = {key: string; kind: 'finding' | 'already' | 'ended' | 'ready' | 'failed'; text?: string};
// "S1 E1" for an episode key, the title for the film.
export const dlName = (key: string, title: string) => {
  const m = /^(\d+)x(\d+)$/.exec(key);
  return m ? `S${m[1]} E${m[2]}` : unescapeHtml(title);
};
// A "Get another version" download (MyDownload.replaces): the title's copy is
// owned and stays playable, so it is never the Play button's job.
export const isReplacement = (j: DownloadJob) => !!(j as MyDownload).replaces;
// How a job that ended badly reads on the status line.
export const endedText = (name: string, status: string) =>
  status === 'declined'
    ? `${name} was declined  ·  hold Play for other sources`
    : status === 'canceled' || status === 'cancelled'
      ? `${name}'s download was cancelled  ·  press Play to try again`
      : status === 'removed' || status === 'dismissed'
      ? `${name}'s download was removed  ·  press Play to try again`
      : `Couldn't get ${name}  ·  hold Play for other sources`;
// Everything the Play button and the line under it say, from the job, the
// note and whether the copy is on disk. `label`: the button's words while it
// saves (the website's, SAVE_WORDS — null: the button says what it always
// does); `line`: the one muted sentence under it, only when the download is
// NOT running (no copy to pick, failed, ready, the hint) — while it runs the
// button says it all and `pct` fills the strip under it. `busy` puts the
// spinner on the button.
export type DlStatus = {busy: boolean; label: string | null; line: string | null; pct: number | null; tone: 'hint' | 'live' | 'ok' | 'warn'};
export const dlStatus = (
  name: string,
  job: JobMark | null | undefined,
  note: DlNote | null,
  owned: boolean,
  live: {phase: string | null} | null,
): DlStatus => {
  if (job) {
    const label = saveText({...job, phase: job.phase || live?.phase || null});
    return {busy: true, label, line: null, pct: job.status === 'pending' ? null : job.progress || 0, tone: 'live'};
  }
  if (note) {
    // pressed: the best source is being looked up and asked for
    if (note.kind === 'finding' || note.kind === 'already') return {busy: true, label: SAVE_WORDS.starting, line: null, pct: null, tone: 'live'};
    if (note.kind === 'ended' || note.kind === 'ready') {
      return owned
        ? {busy: false, label: null, line: 'Ready — press Play', pct: null, tone: 'ok'}
        : {busy: true, label: SAVE_WORDS.finishing, line: null, pct: 1, tone: 'live'};
    }
    if (note.kind === 'failed') return {busy: false, label: null, line: note.text || `Couldn't get ${name}  ·  hold Play for other sources`, pct: null, tone: 'warn'};
  }
  if (!owned) return {busy: false, label: null, line: 'Press Play to save the best source  ·  hold for the list', pct: null, tone: 'hint'};
  return {busy: false, label: null, line: null, pct: null, tone: 'hint'};
};
// ui.js fmtAirDate, ported — by hand rather than toLocaleDateString, so it does
// not depend on the TV's Intl data. Same-year dates drop the year.
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const airTime = (released?: string | null) => (released ? Date.parse(released) : NaN);
export const fmtAirDate = (released?: string | null) => {
  const t = airTime(released);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
};
// "49 min" / "1h 2min" / 49 → whole minutes, or undefined when the catalogue
// has no runtime for the show.
export const parseRuntimeMin = (rt?: string | number | null): number | undefined => {
  if (typeof rt === 'number') return rt > 0 ? Math.round(rt) : undefined;
  if (!rt) return undefined;
  const h = /(\d+)\s*h/i.exec(rt);
  const m = /(\d+)\s*m/i.exec(rt);
  const mins = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  if (mins > 0) return mins;
  const n = parseInt(rt, 10);
  return n > 0 ? n : undefined;
};
// ui.js resolveAirStates, ported. Cinemeta lists episodes as soon as they are
// ANNOUNCED: a dated future episode is "upcoming", and a date-less one past the
// last dated episode of its season is "tba". A date-less episode in a season
// with no dates at all is simply aired — old shows carry no dates anywhere.
export const resolveAirStates = (eps: {episode: number; released?: string | null; local?: boolean}[]) => {
  const now = Date.now();
  let lastDated: number | null = null;
  for (const ep of eps) {
    if (Number.isFinite(airTime(ep.released))) lastDated = Math.max(lastDated ?? -Infinity, ep.episode || 0);
  }
  return eps.map((ep): Air => {
    if (ep.local) return 'aired';
    const t = airTime(ep.released);
    if (Number.isFinite(t)) return t > now ? 'upcoming' : 'aired';
    if (lastDated === null) return 'aired';
    return (ep.episode || 0) > lastDated ? 'tba' : 'aired';
  });
};

