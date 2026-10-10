// The pure half of the TV app's telemetry — the same logic, line for line, as
// the site's public/js/telemetry-core.js (docs/analytics.md): how a message
// is reduced before it leaves the box, the book that counts repeats instead
// of sending them, the control counter and the timer table. No React Native
// in here, so it type-checks and runs anywhere (test/tel-clients.test.js runs
// it under node when the TV's TypeScript is installed).
//
// The server scrubs everything again (src/lib/tel/scrub.js). This side exists
// so that what must never leave the device does not leave it at all.
//
// Hermes stacks in a release build are byte offsets into the bundle, so the
// TV sends no stack location: a report is its message and a coarse source.

export type Level = 'error' | 'warn';
export type Kind =
  | 'js'
  | 'promise'
  | 'console'
  | 'http'
  | 'img'
  | 'media'
  | 'sw'
  | 'stall'
  | 'crash'
  | 'mem'
  | 'ws'
  | 'update';
export type Input = 'remote' | 'touch' | 'mouse' | 'keyboard' | 'pen';
export type Ctx = Record<string, number>;
export type Report = {
  k: Kind;
  l: Level;
  m: string;
  n: number;
  t0: number;
  t1: number;
  s?: string;
  r?: string;
  c?: Ctx;
};
export type ControlRow =
  | [string, string, string, number]
  | [string, string, string, number, 1];
export type TimingRow = [string, number] | [string, number, string];

export const LIMITS = {
  MSG: 160,
  KINDS_PER_SESSION: 40, // distinct kinds of error a session reports; the rest are only counted as "more"
  KINDS_PER_DAY: 120, // …and a box in a day (kept in AsyncStorage, read once, written at send time)
  REPORTS_PER_BATCH: 20,
  TIMINGS_PER_BATCH: 40,
  TIMINGS_HELD: 120,
  CONTROLS_PER_BATCH: 80,
};

const IDENT = /^[a-z_$][A-Za-z0-9_$.]{0,31}$/;

// A message → what is sent: first line, no address, path, id, number, quoted
// phrase or non-Latin text (a title in Hebrew is still a title).
export const normMessage = (msg: unknown): string =>
  String(msg == null ? '' : msg)
    .split(/\r?\n/)[0]
    .slice(0, 600)
    .replace(/\b(?:https?|wss?|file|blob|data|magnet):[^\s"'<>)\]]+/gi, '<url>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_.-]{6,}/g, '<token>')
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '<token>')
    .replace(
      /\b(token|session|sid|password|secret|auth|authorization|cookie|key|pin)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,)]+)/gi,
      '$1=<redacted>',
    )
    .replace(
      /(?:[A-Za-z]:|\\\\[\w.$-]+)\\(?:[^\\/:"'*?<>|\r\n]+\\)*(?:[^\\/:"'*?<>|\r\n]*?\.[A-Za-z0-9]{2,5}(?![\w.])|[^\\/\s:"'*?<>|]*)/g,
      '<path>',
    )
    .replace(
      /(^|[\s("'=:,])~?\/(?:[^/:"'<>|\r\n]+\/)+(?:[^\\/:"'*?<>|\r\n]*?\.[A-Za-z0-9]{2,5}(?![\w.])|[^\\/\s:"'*?<>|]*)/g,
      '$1<path>',
    )
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/g, '<ip>')
    .replace(/\btt\d{5,}\b/gi, '<id>')
    .replace(/\bS\d{1,2}\s?E\d{1,3}\b/gi, '<ep>')
    .replace(
      /(["'`‘’“”])([^"'`‘’“”]{0,200})(["'`‘’“”])/g,
      (_m: string, _a: string, inner: string) =>
        IDENT.test(inner) ? `'${inner}'` : "'…'",
    )
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(
      /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/g,
      '<id>',
    )
    .replace(/[^\x20-\x7e]+/g, '…')
    .replace(/\d+(?:[.,]\d+)*/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.MSG);

// A request address → its shape. Lower-case words stay (the server keeps only
// the ones that are its own route names), anything else is ":id"; a query
// keeps its key names and a size's value: "/img/:id?w=256".
export const urlPattern = (u: unknown): string => {
  let s = String(u == null ? '' : u).slice(0, 600);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/#.*$/, '');
  const qi = s.indexOf('?');
  const segs = (qi < 0 ? s : s.slice(0, qi))
    .split('/')
    .filter(Boolean)
    .slice(0, 8)
    .map((seg, i, all) => {
      if (/^[a-z][a-z-]{0,23}$/.test(seg)) return seg;
      const ext =
        i === all.length - 1 ? /\.([A-Za-z0-9]{2,5})$/.exec(seg) : null;
      return ext ? `:file.${ext[1].toLowerCase()}` : ':id';
    });
  const keys: string[] = [];
  if (qi >= 0) {
    for (const part of s.slice(qi + 1).split('&')) {
      if (!part || keys.length >= 5) continue;
      const [k, v = ''] = part.split('=');
      if (!/^[a-z][a-z0-9_]{0,15}$/i.test(k)) continue;
      keys.push(
        (k === 'w' || k === 'h') && /^\d{1,5}$/.test(v)
          ? `${k}=${v}`
          : k.toLowerCase(),
      );
    }
  }
  return '/' + segs.join('/') + (keys.length ? '?' + keys.join('&') : '');
};

// ---- the error book: one line per KIND of thing that went wrong, with a
// count — forty failed pictures are one line that says 40.
export class ErrorBook {
  items: Map<string, Report>; // key -> report (waiting to be sent)
  seen: Set<string>; // every key this session has reported
  perSession: number;
  perDay: number;
  sentToday: number;
  dropped: number;
  constructor({
    perSession = LIMITS.KINDS_PER_SESSION,
    perDay = LIMITS.KINDS_PER_DAY,
    sentToday = 0,
  } = {}) {
    this.items = new Map();
    this.seen = new Set();
    this.perSession = perSession;
    this.perDay = perDay;
    this.sentToday = sentToday;
    this.dropped = 0;
  }
  // kind: "js" | "promise" | "console" | "http" | "img" | "media" | "sw" | "stall" | "crash" | "mem" | "ws" | "update"
  add(
    kind: Kind,
    level: Level,
    message: unknown,
    {
      loc = '',
      screen = '',
      ctx = null,
      raw = false,
      now = Date.now(),
    }: {
      loc?: string;
      screen?: string;
      ctx?: Ctx | null;
      raw?: boolean;
      now?: number;
    } = {},
  ): boolean {
    const msg = raw
      ? String(message).slice(0, LIMITS.MSG)
      : normMessage(message);
    if (!msg) return false;
    const key = `${kind}|${msg}|${loc}|${
      ctx && ctx.status != null ? ctx.status : ''
    }`;
    let it = this.items.get(key);
    if (it) {
      it.n++;
      it.t1 = now;
      return true;
    }
    if (!this.seen.has(key)) {
      if (
        this.seen.size >= this.perSession ||
        this.sentToday + this.seen.size >= this.perDay
      ) {
        this.dropped++;
        return false;
      }
      this.seen.add(key);
    }
    it = {
      k: kind,
      l: level === 'warn' ? 'warn' : 'error',
      m: msg,
      n: 1,
      t0: now,
      t1: now,
    } as Report;
    if (loc) it.s = loc;
    if (screen) it.r = screen;
    if (ctx) it.c = ctx;
    this.items.set(key, it);
    return true;
  }
  get size() {
    return this.items.size;
  }
  // What goes into the next batch (at most REPORTS_PER_BATCH; the rest wait).
  drain(max = LIMITS.REPORTS_PER_BATCH): Report[] {
    const out: Report[] = [];
    for (const [key, it] of this.items) {
      if (out.length >= max) break;
      out.push(it);
      this.items.delete(key);
    }
    return out;
  }
  // a batch that could not be sent goes back (counts merge)
  restore(list: Report[]) {
    for (const it of list) {
      const key = `${it.k}|${it.m}|${it.s || ''}|${
        it.c && it.c.status != null ? it.c.status : ''
      }`;
      const cur = this.items.get(key);
      if (cur) {
        cur.n += it.n;
        cur.t0 = Math.min(cur.t0, it.t0);
      } else this.items.set(key, it);
    }
  }
}

// ---- controls: a press is two property reads and `c[input]++`. Nothing is
// allocated after a control's first press on a screen (no key string is
// built per press), so a held key costs what a counter costs.
export class ControlCounter {
  screens: Record<string, Record<string, Record<Input, number>>>; // screen -> id -> { remote, touch, mouse, keyboard, pen }
  used: Set<string>; // ids already reported once this session
  any: boolean;
  constructor() {
    this.screens = Object.create(null);
    this.used = new Set();
    this.any = false;
  }
  hit(screen: string, id: string, input: Input) {
    let s = this.screens[screen];
    if (s === undefined) s = this.screens[screen] = Object.create(null);
    let c = s[id];
    if (c === undefined)
      c = s[id] = { remote: 0, touch: 0, mouse: 0, keyboard: 0, pen: 0 };
    c[input]++;
    this.any = true;
  }
  drain(max = LIMITS.CONTROLS_PER_BATCH): ControlRow[] {
    const out: ControlRow[] = [];
    if (!this.any) return out;
    let left = false;
    for (const screen of Object.keys(this.screens)) {
      const s = this.screens[screen];
      for (const id of Object.keys(s)) {
        const c = s[id];
        for (const input of Object.keys(c) as Input[]) {
          const n = c[input];
          if (!(n > 0)) continue;
          if (out.length >= max) {
            left = true;
            continue;
          }
          const first = this.used.has(id) ? 0 : 1;
          this.used.add(id);
          out.push(first ? [screen, id, input, n, 1] : [screen, id, input, n]);
          c[input] = 0;
        }
      }
    }
    this.any = left;
    return out;
  }
  clear() {
    this.screens = Object.create(null);
    this.any = false;
  }
}

// ---- timers: start(name) … end(name, dim) → [name, ms, dim]
export class Timers {
  clock: () => number;
  open: Map<string, number>;
  done: TimingRow[];
  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
    this.open = new Map();
    this.done = [];
  }
  start(name: string, at?: number) {
    this.open.set(name, at == null ? this.clock() : at);
  }
  cancel(name: string) {
    this.open.delete(name);
  }
  running(name: string) {
    return this.open.has(name);
  }
  end(name: string, dim?: string): TimingRow | null {
    const t0 = this.open.get(name);
    if (t0 == null) return null;
    this.open.delete(name);
    return this.value(name, this.clock() - t0, dim);
  }
  value(name: string, ms: number, dim?: string): TimingRow | null {
    if (!(ms >= 0) || !Number.isFinite(ms)) return null;
    if (this.done.length >= LIMITS.TIMINGS_HELD) this.done.shift();
    const row: TimingRow = dim
      ? [name, Math.round(ms), dim]
      : [name, Math.round(ms)];
    this.done.push(row);
    return row;
  }
  drain(max = LIMITS.TIMINGS_PER_BATCH): TimingRow[] {
    return this.done.splice(0, max);
  }
}

// The play path, in the four words both apps use.
export const playPath = ({
  torrent,
  offline,
  remux,
  transcode,
}: {
  torrent?: boolean;
  offline?: boolean;
  remux?: boolean;
  transcode?: boolean;
}): string =>
  torrent
    ? 'torrent'
    : offline
    ? 'offline'
    : remux
    ? 'remux'
    : transcode
    ? 'transcode'
    : 'direct';

// May a batch go out now? Not while someone is moving about, and not while a
// play is starting. `sinceInputMs`: how long since the last key, tap or wheel.
export const IDLE_MS = 3000; // a little longer than the site: a held remote key repeats, pauses, repeats
export const idleNow = ({
  sinceInputMs,
  playStarting,
}: {
  sinceInputMs: number;
  playStarting: boolean;
}): boolean => sinceInputMs >= IDLE_MS && !playStarting;
