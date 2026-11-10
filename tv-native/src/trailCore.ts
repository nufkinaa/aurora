// The trail a problem report carries (docs/report-trail.md) — the PURE half,
// the same rules and the same words as the site's public/js/trail-core.js
// (test/report-trail.test.js runs both over the same cases). No React Native
// in here: it type-checks and runs anywhere.
//
// An entry, as it leaves the device:  {t, k, ...a few short fields}
//   t   milliseconds BEFORE the report was sent (0 = the moment of sending)
//   k   nav · tap · key · sheet · toast · err · req · search · play · net · app · feat
//   n   how many times in a row, when it repeated (an arrow held, a poll)
//
// Never in it: anything typed into a field, tokens, codes and keys from
// addresses, query strings, other profiles' names. The one thing typed that
// is: the search the viewer ran.

export const TRAIL = {
  MAX: 60,
  WINDOW_MS: 10 * 60 * 1000,
  STR: 160,
  LABEL: 40,
  BYTES: 12000,
  MERGE_MS: 5000,
  SLOW_MS: 2000,
  REQS: 10,
};
export type Kind = 'nav' | 'tap' | 'key' | 'sheet' | 'toast' | 'err' | 'req' | 'search' | 'play' | 'net' | 'app' | 'feat';
export const KINDS: Kind[] = ['nav', 'tap', 'key', 'sheet', 'toast', 'err', 'req', 'search', 'play', 'net', 'app', 'feat'];
const MERGEABLE = new Set<string>(['key', 'req', 'err', 'tap', 'feat', 'toast', 'net']);

export type Value = string | number | boolean;
export type Fields = Record<string, Value | null | undefined>;
export type Held = {at: number; k: Kind; n?: number; [key: string]: Value | undefined};
export type Entry = {t: number; k: Kind; n?: number; [key: string]: Value | undefined};

export const short = (v: unknown, n = TRAIL.STR) =>
  String(v == null ? '' : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>]/g, c => (c === '<' ? '‹' : '›'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);

export const redact = (text: string) =>
  String(text)
    .replace(/\b(?:https?|wss?):\/\/[^\s"'‹›)]+/gi, u => trailPath(u))
    .replace(/\b(token|session|sid|password|passwd|secret|auth|authorization|cookie|key|pin|code)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,)]+)/gi, '$1=…')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '‹email›');

const val = (v: unknown): Value | null => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  const s = short(redact(short(v, 400)));
  return s || null;
};

const same = (a: Held, b: Held) => {
  for (const key of Object.keys(a)) if (key !== 'at' && key !== 'n' && a[key] !== b[key]) return false;
  for (const key of Object.keys(b)) if (key !== 'at' && key !== 'n' && !(key in a)) return false;
  return true;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const scrubNames = (text: string, names: string[]) => {
  let out = String(text);
  for (const name of names || []) {
    const n = String(name || '').trim();
    if (n.length < 2) continue;
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1someone');
  }
  return out;
};

export class Trail {
  max: number;
  windowMs: number;
  now: () => number;
  items: Held[] = [];
  constructor(o: {max?: number; windowMs?: number; now?: () => number} = {}) {
    this.max = o.max ?? TRAIL.MAX;
    this.windowMs = o.windowMs ?? TRAIL.WINDOW_MS;
    this.now = o.now ?? (() => Date.now());
  }

  add(k: Kind, fields: Fields = {}): Held | null {
    if (!KINDS.includes(k)) return null;
    const at = this.now();
    const e: Held = {at, k};
    for (const key of Object.keys(fields || {})) {
      if (key === 'at' || key === 'k' || key === 't' || key === 'n') continue;
      const v = val(fields[key]);
      if (v !== null) e[key] = v;
    }
    const last = this.items[this.items.length - 1];
    if (last && at - last.at < TRAIL.MERGE_MS) {
      if (MERGEABLE.has(k) && last.k === k && same(last, e)) {
        last.n = (last.n || 1) + 1;
        last.at = at;
        return last;
      }
      if (k === 'search' && last.k === 'search') {
        last.q = e.q;
        last.at = at;
        return last;
      }
    }
    this.items.push(e);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    return e;
  }

  clear() {
    this.items.length = 0;
  }

  take(o: {sentAt?: number; names?: string[]; maxBytes?: number} = {}): Entry[] {
    const sentAt = o.sentAt ?? this.now();
    const names = o.names || [];
    const maxBytes = o.maxBytes ?? TRAIL.BYTES;
    const from = sentAt - this.windowMs;
    const out: Entry[] = [];
    for (const e of this.items) {
      if (e.at < from) continue;
      const x: Entry = {t: Math.max(0, Math.round(sentAt - e.at)), k: e.k};
      for (const key of Object.keys(e)) {
        if (key === 'at' || key === 'k') continue;
        const v = e[key];
        x[key] = typeof v === 'string' && names.length ? scrubNames(v, names) : v;
      }
      out.push(x);
    }
    let size = JSON.stringify(out).length;
    while (out.length && size > maxBytes) size -= JSON.stringify(out.shift()).length + 1;
    return out;
  }
}

// ---------- keys ----------
// The remote's keys by NAME (react-native's TVEventHandler event types). Focus
// moves and anything else it reports are not keys.
const TV_KEYS = new Set([
  'up', 'down', 'left', 'right', 'select', 'longSelect', 'longUp', 'longDown', 'longLeft', 'longRight',
  'playPause', 'play', 'pause', 'stop', 'rewind', 'fastForward', 'next', 'previous', 'menu', 'back', 'info',
  'channelUp', 'channelDown', 'search', 'voice', 'mic',
]);
export const tvKeyName = (eventType: unknown) => {
  const k = String(eventType == null ? '' : eventType);
  return TV_KEYS.has(k) ? k : null;
};
// (the site's rule, for a keyboard: in a field only the keys that end or
// leave it; elsewhere keys by name, never a character but Space)
const NAMED = /^(Arrow(Up|Down|Left|Right)|Enter|Escape|Esc|Tab|Backspace|Delete|Home|End|PageUp|PageDown|F\d{1,2}|Media[A-Za-z]+|Audio[A-Za-z]+|Browser[A-Za-z]+|GoBack|ContextMenu|Color[A-Za-z0-9]+|Channel(Up|Down)|Info|Guide|Exit|Settings|Subtitle|Close|Select|ZoomToggle|TV|XF86[A-Za-z0-9]+|Unidentified)$/;
export const keyName = (key: unknown, inField = false) => {
  const k = String(key == null ? '' : key);
  if (inField) return k === 'Enter' || k === 'Escape' || k === 'Tab' ? k : null;
  if (k === ' ' || k === 'Spacebar') return 'Space';
  return k.length > 1 && NAMED.test(k) ? k : null;
};

// ---------- addresses ----------
const GUARDS = new Set(['auth', 'sessions', 'session', 'token', 'tokens', 'describe', 'pair', 'pairing', 'reset', 'claim', 'unlock', 'code', 'codes', 'invite', 'pin', 'kids-pin', 'password', 'google', 'airtoken', 'link']);
const WORD = /^[a-z][a-z-]{0,23}$/;
const ID = /^[A-Za-z0-9._:~-]{1,48}$/;
export const trailPath = (u: unknown) => {
  const s = String(u == null ? '' : u)
    .slice(0, 800)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
    .replace(/[?#].*$/, '');
  let guarded = false;
  const segs = s
    .split('/')
    .filter(Boolean)
    .slice(0, 8)
    .map(seg => {
      let d = seg;
      try {
        d = decodeURIComponent(seg);
      } catch {}
      if (WORD.test(d) && !(guarded && d.length >= 8 && /^[a-f-]+$/.test(d))) {
        if (GUARDS.has(d)) guarded = true;
        return d;
      }
      if (!guarded && ID.test(d)) return d;
      return '…';
    });
  return '/' + segs.join('/');
};

export const searchOf = (u: unknown) => {
  const s = String(u == null ? '' : u);
  const path = trailPath(s);
  if (!/^\/api\/(search|discover\/search)$/.test(path)) return null;
  const qi = s.indexOf('?');
  if (qi < 0) return null;
  for (const part of s.slice(qi + 1).replace(/#.*$/, '').split('&')) {
    const [k, v = ''] = part.split('=');
    if (k !== 'q') continue;
    let q = v;
    try {
      q = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {}
    q = short(q, 100);
    return q || null;
  }
  return null;
};

// ---------- the trail in plain words (the site's words, exactly) ----------
type E = Entry | Record<string, Value | undefined>;
const clock = (s: unknown) => {
  if (s == null || !Number.isFinite(Number(s))) return '?';
  const v = Math.max(0, Math.round(Number(s)));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const ss = String(v % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const dur = (ms: unknown) => {
  if (ms == null) return '?';
  const n = Number(ms);
  return n >= 10000 ? `${Math.round(n / 1000)} s` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
};
export const trailAgo = (t: unknown) => `−${clock((Number(t) || 0) / 1000)}`;
const extra = (e: E, skip: string[]) =>
  Object.keys(e)
    .filter(k => !skip.includes(k) && e[k] != null && e[k] !== '')
    .map(k => `${k} ${e[k]}`)
    .join(', ');
const PLAY: Record<string, (e: E) => string> = {
  start: e => `first picture after ${dur(e.ms)}${e.path ? ` (${e.path})` : ''}`,
  play: e => `play at ${clock(e.at)}`,
  pause: e => `pause at ${clock(e.at)}`,
  seek: e => `seek ${clock(e.from)} → ${clock(e.to)}`,
  seeked: e => `playing again ${dur(e.ms)} after the seek`,
  stall: e => `stalled ${dur(e.ms)}${e.at != null ? ` at ${clock(e.at)}` : ''}`,
  buffering: e => `buffering${e.at != null ? ` at ${clock(e.at)}` : ''}`,
  ended: e => `reached the end${e.at != null ? ` (${clock(e.at)})` : ''}`,
  rate: e => `speed ×${e.v}`,
  picture: e => `picture now ${e.w ? `${e.w}×` : ''}${e.h}`,
  error: e => `video error${e.code != null ? ` code ${e.code}` : ''}${e.m ? `: ${e.m}` : ''}`,
  audio: e => `audio → ${e.v}`,
  subtitles: e => `subtitles → ${e.v}`,
  quality: e => `quality → ${e.v}${e.auto ? ' (by itself)' : ''}`,
  next: e => `next episode${e.to ? ` (${e.to})` : ''}`,
  mark: e => {
    const x = extra(e, ['t', 'k', 'e', 'mk', 'n']);
    return `player mark ${e.mk}${x ? ` (${x})` : ''}`;
  },
};
const APP: Record<string, string> = {
  start: 'the app started',
  profile: 'a profile came in',
  hidden: 'left the app (out of sight)',
  shown: 'came back to the app',
  background: 'the app went to the background',
  foreground: 'the app came to the front',
  'fullscreen-on': 'full screen on',
  'fullscreen-off': 'full screen off',
  'pip-on': 'picture in picture on',
  'pip-off': 'picture in picture off',
};
export const trailLine = (e: E | null | undefined): string => {
  if (!e || typeof e !== 'object') return '';
  let s: string;
  switch (e.k) {
    case 'nav':
      s = `opened ${e.s || '?'}${e.id ? ` (${e.id})` : ''}`;
      break;
    case 'tap':
      s = e.ui
        ? `pressed ${e.ui}`
        : `pressed ${e.r || 'control'}${e.l ? ` “${e.l}”` : ''}${e.on === true ? ' (on)' : e.on === false ? ' (off)' : ''}${e.v ? ` → ${e.v}` : ''}`;
      break;
    case 'key':
      s = `key ${e.key}`;
      break;
    case 'sheet':
      s = `${e.on === false ? 'closed' : 'opened'} “${e.s || 'sheet'}”`;
      break;
    case 'toast':
      s = `was shown: “${e.m || ''}”`;
      break;
    case 'err':
      s = `${e.lv === 'warn' ? 'warning' : 'error'}${e.w ? ` (${e.w})` : ''}: ${e.m || '?'}${e.st ? ` [${e.st}]` : ''}${e.code != null ? ` code ${e.code}` : ''}`;
      break;
    case 'req':
      s = `${e.m || 'GET'} ${e.p || '?'} → ${e.s === 0 ? 'no answer' : e.s}${e.ms != null ? ` in ${dur(e.ms)}` : ''}`;
      break;
    case 'search':
      s = `searched “${e.q || ''}”`;
      break;
    case 'play': {
      const f = PLAY[String(e.e)];
      if (f) s = f(e);
      else {
        const x = extra(e, ['t', 'k', 'e', 'n']);
        s = `player ${e.e || '?'}${x ? ` (${x})` : ''}`;
      }
      break;
    }
    case 'net':
      s =
        e.on === true
          ? 'back online'
          : e.on === false
          ? 'went offline'
          : e.ws
          ? `live connection ${e.ws}`
          : `connection now ${[e.type, e.mbps != null ? `${e.mbps} Mbit/s` : '', e.rtt != null ? `${e.rtt} ms` : ''].filter(Boolean).join(', ')}`;
      break;
    case 'app':
      s = APP[String(e.e)] || `app ${e.e || '?'}`;
      break;
    case 'feat':
      s = `used ${e.f}`;
      break;
    default:
      s = `${e.k} ${extra(e, ['t', 'k', 'n'])}`;
  }
  return Number(e.n) > 1 ? `${s} ×${e.n}` : s;
};
export const trailLevel = (e: E | null | undefined): '' | 'warn' | 'bad' => {
  if (!e) return '';
  if (e.k === 'err') return e.lv === 'warn' ? 'warn' : 'bad';
  if (e.k === 'play' && (e.e === 'error' || e.e === 'stall')) return 'bad';
  if (e.k === 'play' && e.e === 'mark' && /error|stall/.test(String(e.mk))) return 'warn';
  if (e.k === 'req') {
    const st = Number(e.s);
    return st === 0 || st >= 500 ? 'bad' : st >= 400 || Number(e.ms) >= TRAIL.SLOW_MS ? 'warn' : '';
  }
  if (e.k === 'net' && (e.on === false || e.ws === 'down')) return 'bad';
  return '';
};

const FACTS: [string, string][] = [
  ['app', 'app'], ['v', 'version'], ['build', 'build'], ['os', 'system'], ['model', 'device'], ['device', 'device kind'], ['browser', 'browser'],
  ['screen', 'screen'], ['viewport', 'window'], ['lang', 'language'], ['tz', 'time zone'], ['installed', 'installed as an app'],
  ['sw', 'service worker'], ['cache', 'offline cache'], ['storage', 'storage'], ['free', 'free space'], ['mem', 'memory'], ['cores', 'cores'],
  ['lowRam', 'low on memory'], ['saveData', 'data saver'], ['dataMode', 'data mode'], ['motion', 'reduced motion'], ['look', 'look'],
  ['quality', 'quality'], ['subLang', 'subtitle language'], ['subsDefault', 'subtitles on by themselves'], ['audioLang', 'audio language'],
  ['autoplayNext', 'play the next episode'], ['kids', 'kids profile'], ['auth', 'sign-in mode'], ['signedIn', 'signed in'],
  ['server', 'server'], ['conn', 'connection'], ['online', 'online'], ['socket', 'live connection'], ['client', 'client id'], ['up', 'this session'],
];
const PLAYER: [string, string][] = [
  ['id', 'title id'], ['pos', 'position'], ['dur', 'length'], ['ahead', 'buffered ahead'], ['ready', 'ready state'], ['net', 'network state'],
  ['state', 'player state'], ['paused', 'paused'], ['ended', 'ended'], ['seeking', 'seeking'], ['waiting', 'waiting for'], ['rate', 'speed'],
  ['picture', 'picture'], ['dropped', 'dropped frames'], ['path', 'path'], ['v', 'video'], ['cap', 'capped at'], ['level', 'level'],
  ['audio', 'audio'], ['subtitles', 'subtitles'], ['src', 'stream'], ['error', 'error'], ['client', 'client id'], ['party', 'watch party'], ['airplay', 'AirPlay'],
];
type Flat = Record<string, unknown> | null | undefined;
const rowsOf = (o: Flat, table: [string, string][], fmt: Record<string, (v: unknown) => string>): [string, string][] => {
  if (!o || typeof o !== 'object') return [];
  const known = new Set(table.map(([k]) => k));
  const show = (k: string, v: unknown) => (fmt[k] ? fmt[k](v) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
  const rows: [string, string][] = table.filter(([k]) => o[k] != null && o[k] !== '').map(([k, label]) => [label, show(k, o[k])]);
  for (const k of Object.keys(o)) if (!known.has(k) && o[k] != null && o[k] !== '' && typeof o[k] !== 'object') rows.push([k, String(o[k])]);
  return rows;
};
export const factRows = (env: Flat) => rowsOf(env, FACTS, {up: v => clock(v), mem: v => (typeof v === 'number' ? `${v} GB` : String(v))});
export const playerRows = (p: Flat) => rowsOf(p, PLAYER, {pos: clock, dur: clock, ahead: v => `${v} s`, waiting: v => dur(v)});
export type Req = {t: number; m: string; p: string; s: number; ms: number};
export const reqLine = (r: Req) => `${trailAgo(r.t)}  ${r.m || 'GET'} ${r.p || '?'} → ${r.s === 0 ? 'no answer' : r.s} in ${dur(r.ms)}`;
export const trailText = (o: {trail?: E[]; env?: Flat; player?: Flat; reqs?: Req[]} = {}) => {
  const out: string[] = [];
  const trail = o.trail || [];
  if (trail.length) {
    out.push('Last steps (oldest first; time before the report was sent):');
    for (const e of trail) {
      const lv = trailLevel(e);
      out.push(`  ${trailAgo(e.t)}  ${lv === 'bad' ? '!! ' : lv === 'warn' ? '!  ' : ''}${trailLine(e)}`);
    }
  }
  const f = factRows(o.env);
  if (f.length) out.push('Device and app:', ...f.map(([k, v]) => `  ${k}: ${v}`));
  const p = playerRows(o.player);
  if (p.length) out.push('The player at the time:', ...p.map(([k, v]) => `  ${k}: ${v}`));
  if (o.reqs && o.reqs.length) out.push('Last requests:', ...o.reqs.map(r => `  ${reqLine(r)}`));
  return out.join('\n');
};
