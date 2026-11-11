// Saving to the phone — the rules, PURE (no React Native), tested.
//
// The website's offline copies (public/js/offline.js) are the model: the
// server lays out what it can make for this file and this device, the person
// picks (or their saved choice is used), the server prepares it, the phone
// fetches it. The words are the site's (docs/offline-look.md, public/js/devicejobs.js):
// one place "On this device", one action "Save to this device".
export type OfflineQuality = 'ask' | 'original' | '1080' | '720' | '480';
export const OFFLINE_QUALITIES: {id: OfflineQuality; label: string}[] = [
  {id: 'ask', label: 'Ask each time'},
  {id: 'original', label: 'Original'},
  {id: '1080', label: '1080p'},
  {id: '720', label: '720p'},
  {id: '480', label: '480p'},
];

// ---- the words (docs/offline-look.md §1 — always these) ----
export const PLACE = 'On this device';
export const SAVE = 'Save to this device';
export const SAVED = 'Saved on this device';
export const REMOVE = 'Remove from this device';
export const WAITING = "Waiting for the server's copy";

export type Option = {quality: string; label: string; sizeBytes: number; instant?: boolean; estimated?: boolean; detail?: string; note?: string; ready?: boolean};
export type Sound = {index: number; language?: string | null; title?: string | null; codec?: string | null; channels?: number; commentary?: boolean};

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

/** The website's qualityLike: the size asked for, else the next one down, else the first there is. */
export function qualityLike(want: string, options: Pick<Option, 'quality'>[]): string | null {
  if (options.some(o => o.quality === want)) return want;
  const order = ['original', '1080', '720', '480'];
  const from = Math.max(0, order.indexOf(want));
  return order.slice(from).find(q => options.some(o => o.quality === q)) || options[0]?.quality || null;
}

export const fmtSize = (b: number): string => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
/** "≈ 1.2 GB" for an estimate (the site's sign), the plain size otherwise. */
export const sizeText = (o: Pick<Option, 'sizeBytes' | 'estimated' | 'instant'>) => (o.sizeBytes ? `${o.estimated && !o.instant ? '≈ ' : ''}${fmtSize(o.sizeBytes)}` : '');

/** Is there room? The site's rule: the copy's size and 5% to spare. */
export const roomFor = (sizeBytes: number, freeBytes: number): boolean => !(sizeBytes > 0 && freeBytes > 0 && sizeBytes * 1.05 > freeBytes);
export const noRoomText = (sizeBytes: number, freeBytes: number) =>
  `not enough room on this device — this copy needs about ${fmtSize(sizeBytes)} and ${fmtSize(freeBytes)} is free. Try a smaller size.`;

// ---- the sound (one copy, one sound — docs/offline-wishes.md round 2) ----
const LANG2: Record<string, string> = {eng: 'en', heb: 'he', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', rus: 'ru', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', por: 'pt', ara: 'ar', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', tur: 'tr', hin: 'hi', tha: 'th', ukr: 'uk', gre: 'el', ell: 'el', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro', ron: 'ro'};
const NAMES: Record<string, string> = {en: 'English', he: 'Hebrew', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', pt: 'Portuguese', ar: 'Arabic', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', pl: 'Polish', tr: 'Turkish', hi: 'Hindi', th: 'Thai', uk: 'Ukrainian', el: 'Greek', cs: 'Czech', hu: 'Hungarian', ro: 'Romanian'};
/** "eng", "en", "en-US", "iw" → "en" / "he" (the site's sameAudio, by the base language). */
export const langBase = (l?: string | null) => {
  const x = String(l || '').toLowerCase().split(/[-_]/)[0];
  if (x === 'iw') return 'he';
  return LANG2[x] || x;
};
export const sameLang = (a?: string | null, b?: string | null) => !!a && !!b && a !== 'und' && b !== 'und' && langBase(a) === langBase(b);
/** "English", "Hebrew · 5.1", "English · commentary" — a sound, in words (the site's soundLabel). */
export function soundLabel(t: Sound | null | undefined): string {
  if (!t) return '';
  const base = langBase(t.language);
  let name = t.language && t.language !== 'und' ? NAMES[base] || '' : '';
  if (!name) name = t.title || (t.language && t.language !== 'und' ? String(t.language).toUpperCase() : `Sound ${Number(t.index || 0) + 1}`);
  const ch = t.channels || 0;
  const extra = [t.commentary ? 'commentary' : null, ch > 2 ? (ch === 6 ? '5.1' : ch === 8 ? '7.1' : `${ch} ch`) : null].filter(Boolean);
  return [name, ...extra].join(' · ');
}
/** The sound a copy is made with when the person does not choose: their own language (the
 *  dub the player remembers), else the film's original language, else the first. */
export function defaultSound(sounds: Sound[], liked?: string | null, original?: string | null): number {
  const fit = (t: Sound) => t && !t.commentary;
  if (liked) {
    const i = sounds.findIndex(t => fit(t) && sameLang(t.language, liked));
    if (i >= 0) return i;
  }
  if (original) {
    const i = sounds.findIndex(t => fit(t) && sameLang(t.language, original));
    if (i >= 0) return i;
  }
  return 0;
}

// ---- where a save stands ----
//   queued      waiting for its turn (one lands at a time)
//   preparing   the server is making the copy (or waits to)
//   saving      the bytes are coming onto the phone (waitingWifi: Wi-Fi only, on mobile data)
//   retrying    the line dropped — it carries on by itself
//   paused      what is saved stays; `why` 'user' waits for Resume, 'offline' carries on by itself
//   done        on this device
//   failed      didn't save — Retry, or Dismiss
export type JobState = 'queued' | 'preparing' | 'saving' | 'retrying' | 'paused' | 'done' | 'failed';
export const ACTIVE_STATES: JobState[] = ['queued', 'preparing', 'saving', 'retrying'];
/** On its way or resting part-way (a paused save keeps its place in "Saving now"). */
export const MOVING_STATES: JobState[] = ['queued', 'preparing', 'saving', 'retrying', 'paused'];

export const pctOf = (p?: number) => Math.max(0, Math.min(100, Math.round((Number(p) || 0) * 100)));
export const timeLeft = (secs: number) => {
  if (!(secs > 0)) return '';
  if (secs < 60) return 'under a minute left';
  if (secs < 3600) return `about ${Math.round(secs / 60)} min left`;
  return `about ${(secs / 3600).toFixed(1)} h left`;
};
export const speedText = (bps: number) => (bps > 0 ? `${bps >= 1024 ** 2 ? (bps / 1024 ** 2).toFixed(1) + ' MB' : Math.max(1, Math.round(bps / 1024)) + ' KB'}/s` : '');

export type Tone = 'busy' | 'wait' | 'bad' | 'ok';
export type JobLook = {tone: Tone; head: string; line: string; bar: boolean; idle?: boolean};
type JobLike = {state: JobState; pct?: number; note?: string | null; error?: string | null; sizeBytes?: number; waitingWifi?: boolean; waiting?: boolean; why?: 'user' | 'offline' | null; speed?: number; eta?: number};

/** A save's row: its head (in the row's tone), the line under it, and whether it has a bar —
 *  the website's devicejobs.js statusOf, word for word (plus the phone's Wi-Fi only). */
export function jobLook(j: JobLike): JobLook {
  const p = pctOf(j.pct);
  switch (j.state) {
    case 'queued':
      return {tone: 'wait', head: 'Waiting for its turn', line: j.note && j.note !== 'waiting for the server' ? j.note : '', bar: false};
    case 'preparing':
      return j.waiting
        ? {tone: 'wait', head: p > 0 ? `Waiting for the server · ${p}%` : 'Waiting for the server', line: String(j.note || '').replace(/^waiting for the server(?: — )?/, ''), bar: true, idle: true}
        : {tone: 'busy', head: `Preparing on the server · ${p}%`, line: j.note && j.note !== 'converting on the server' ? j.note : '', bar: true};
    case 'saving':
      if (j.waitingWifi) return {tone: 'wait', head: `Waiting for Wi-Fi · ${p}%`, line: 'it carries on by itself on Wi-Fi (Settings → On this device)', bar: true, idle: true};
      return {tone: 'busy', head: `Saving to this device · ${p}%`, line: [speedText(j.speed || 0), timeLeft(j.eta || 0)].filter(Boolean).join(' · '), bar: true};
    case 'retrying':
      return {tone: 'wait', head: `Waiting for the connection · ${p}%`, line: j.note || 'it carries on by itself', bar: true, idle: true};
    case 'paused':
      return j.why === 'user'
        ? {tone: 'wait', head: p > 0 ? `Paused at ${p}%` : 'Paused', line: 'What is saved stays here — press Resume to carry on', bar: p > 0, idle: true}
        : {tone: 'wait', head: p > 0 ? `Paused at ${p}%` : 'Paused', line: 'What is saved stays here — it carries on by itself the next time Aurora is open with a connection, or press Resume', bar: p > 0, idle: true};
    case 'failed':
      return {tone: 'bad', head: "Didn't save", line: j.error || '', bar: false};
    case 'done':
      return {tone: 'ok', head: SAVED, line: j.sizeBytes ? fmtSize(j.sizeBytes) : '', bar: false};
  }
}
/** One line for a toast or a sheet's subtitle. */
export const stateLine = (j: JobLike) => {
  const l = jobLook(j);
  return l.line ? `${l.head} — ${l.line}` : l.head;
};

/** The mark's state for a copy or a save (docs/offline-look.md §3). */
export type MarkState = 'none' | 'queued' | 'preparing' | 'saving' | 'retrying' | 'paused' | 'waiting' | 'failed' | 'saved';
export const markOf = (j: {state: JobState; waitingWifi?: boolean} | null | undefined): MarkState => {
  if (!j) return 'none';
  if (j.state === 'done') return 'saved';
  if (j.state === 'saving' && j.waitingWifi) return 'retrying';
  return j.state;
};
/** The button's words for that state (the site's offlineUi words()). */
export function markWords(st: MarkState, pct = 0, waitingServer = false): string {
  switch (st) {
    case 'saved':
      return SAVED;
    case 'saving':
      return `Saving ${pctOf(pct)}%`;
    case 'preparing':
      return waitingServer ? 'Waiting for the server' : 'Getting ready';
    case 'queued':
      return 'Waiting for its turn';
    case 'retrying':
      return 'Waiting for the connection';
    case 'paused':
      return 'Paused';
    case 'failed':
      return "Didn't save";
    case 'waiting':
      return WAITING;
    default:
      return SAVE;
  }
}

// ---- the native saver's word → this app's ----
/** OfflineSaver.kt's state for one save. */
export type SaverStatus = {key: string; state: string; bytes?: number; total?: number; speed?: number; pausedBy?: string | null; error?: string | null; part?: number; whole?: boolean};
export function fromSaver(s: SaverStatus): {state: JobState | 'gone'; pct: number; waitingWifi: boolean; why?: 'user' | 'offline'; error?: string; speed: number; eta: number} {
  const total = s.total || 0;
  const pct = total > 0 ? Math.min(1, (s.bytes || 0) / total) : 0;
  const speed = s.speed || 0;
  const eta = speed > 0 && total > 0 ? Math.max(0, (total - (s.bytes || 0)) / speed) : 0;
  switch (s.state) {
    case 'done':
      return {state: 'done', pct: 1, waitingWifi: false, speed: 0, eta: 0};
    case 'failed':
      return {state: 'failed', pct, waitingWifi: false, error: s.error || 'the save stopped', speed: 0, eta: 0};
    case 'paused':
      return {state: 'paused', pct, waitingWifi: false, why: s.pausedBy === 'you' ? 'user' : 'offline', speed: 0, eta: 0};
    case 'retrying':
      return {state: 'retrying', pct, waitingWifi: false, speed: 0, eta: 0};
    case 'wifi':
      return {state: 'saving', pct, waitingWifi: true, speed: 0, eta: 0};
    case 'gone':
      return {state: 'gone', pct, waitingWifi: false, speed: 0, eta: 0};
    case 'queued':
      return {state: pct > 0 ? 'saving' : 'queued', pct, waitingWifi: false, speed: 0, eta: 0};
    default:
      return {state: 'saving', pct, waitingWifi: false, speed, eta};
  }
}

/** DownloadManager's word for where a save stands → this app's (saves begun by 1.1.2 and older). */
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
      return {state: s.reason === 3 ? 'saving' : 'retrying', pct, waitingWifi: s.reason === 3};
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

/** "Show · S1 E2" for an episode, the title for a film. */
export const copyName = (it: {title: string; showTitle?: string | null; season?: number | null; episode?: number | null}) =>
  it.showTitle && it.season != null && it.episode != null ? `${it.showTitle} · S${it.season} E${it.episode}` : it.title;
