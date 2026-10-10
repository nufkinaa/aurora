// The pure half of the app's telemetry (docs/analytics.md): how a message is
// reduced before it leaves the device, the book that counts repeats instead
// of sending them, the control counter and the timer table. No DOM in here —
// it runs under node's test runner as it is — and the TV app carries the
// same logic in tv-native/src/telemetryCore.ts.
//
// The server scrubs everything again (src/lib/tel/scrub.js). This side exists
// so that what must never leave the device does not leave it at all.

export const LIMITS = {
  MSG: 160,
  KINDS_PER_SESSION: 40, // distinct kinds of error a session reports; the rest are only counted as "more"
  KINDS_PER_DAY: 120, // …and a device in a day (kept in localStorage, read once, written at send time)
  REPORTS_PER_BATCH: 20,
  TIMINGS_PER_BATCH: 40,
  TIMINGS_HELD: 120,
  CONTROLS_PER_BATCH: 80,
};

const IDENT = /^[a-z_$][A-Za-z0-9_$.]{0,31}$/;

// A message → what is sent: first line, no address, path, id, number, quoted
// phrase or non-Latin text (a title in Hebrew is still a title).
export const normMessage = (msg) =>
  String(msg == null ? "" : msg)
    .split(/\r?\n/)[0]
    .slice(0, 600)
    .replace(/\b(?:https?|wss?|file|blob|data|magnet):[^\s"'<>)\]]+/gi, "<url>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "<email>")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_.-]{6,}/g, "<token>")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "<token>")
    .replace(/\b(token|session|sid|password|secret|auth|authorization|cookie|key|pin)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,)]+)/gi, "$1=<redacted>")
    .replace(/(?:[A-Za-z]:|\\\\[\w.$-]+)\\(?:[^\\/:"'*?<>|\r\n]+\\)*(?:[^\\/:"'*?<>|\r\n]*?\.[A-Za-z0-9]{2,5}(?![\w.])|[^\\/\s:"'*?<>|]*)/g, "<path>")
    .replace(/(^|[\s("'=:,])~?\/(?:[^/:"'<>|\r\n]+\/)+(?:[^\\/:"'*?<>|\r\n]*?\.[A-Za-z0-9]{2,5}(?![\w.])|[^\\/\s:"'*?<>|]*)/g, "$1<path>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/g, "<ip>")
    .replace(/\btt\d{5,}\b/gi, "<id>")
    .replace(/\bS\d{1,2}\s?E\d{1,3}\b/gi, "<ep>")
    .replace(/(["'`‘’“”])([^"'`‘’“”]{0,200})(["'`‘’“”])/g, (m, a, inner) => (IDENT.test(inner) ? `'${inner}'` : "'…'"))
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/g, "<id>")
    .replace(/[^\x20-\x7e]+/g, "…")
    .replace(/\d+(?:[.,]\d+)*/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.MSG);

// A request address → its shape. Lower-case words stay (the server keeps only
// the ones that are its own route names), anything else is ":id"; a query
// keeps its key names and a size's value: "/img/:id?w=256".
export const urlPattern = (u) => {
  let s = String(u == null ? "" : u).slice(0, 600);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/#.*$/, "");
  const qi = s.indexOf("?");
  const segs = (qi < 0 ? s : s.slice(0, qi)).split("/").filter(Boolean).slice(0, 8).map((seg, i, all) => {
    if (/^[a-z][a-z-]{0,23}$/.test(seg)) return seg;
    const ext = i === all.length - 1 ? /\.([A-Za-z0-9]{2,5})$/.exec(seg) : null;
    return ext ? `:file.${ext[1].toLowerCase()}` : ":id";
  });
  const keys = [];
  if (qi >= 0) {
    for (const part of s.slice(qi + 1).split("&")) {
      if (!part || keys.length >= 5) continue;
      const [k, v = ""] = part.split("=");
      if (!/^[a-z][a-z0-9_]{0,15}$/i.test(k)) continue;
      keys.push((k === "w" || k === "h") && /^\d{1,5}$/.test(v) ? `${k}=${v}` : k.toLowerCase());
    }
  }
  return "/" + segs.join("/") + (keys.length ? "?" + keys.join("&") : "");
};

// Where an error came from, from its stack: the first two frames inside the
// app's own files, as "screens/player.js:onStall" — no line, no column, no
// host, no version stamp. Frames from vendor code or the browser are skipped.
export const locOf = (stack, own = /\/js\/(?!vendor\/)/) => {
  const out = [];
  for (const line of String(stack || "").split("\n").slice(0, 12)) {
    // "    at fn (http://h/js/x.js?v=1:10:5)" (Chromium) · "fn@http://h/js/x.js:10:5" (Safari, Firefox)
    const m = /^\s*at (?:async )?(?:(.*?) \()?((?:https?|file):\/\/[^\s)]+)\)?$/.exec(line) || /^(.*?)@((?:https?|file):\/\/\S+)$/.exec(line.trim());
    if (!m || !own.test(m[2])) continue;
    const file = m[2].replace(/^[a-z]+:\/\/[^/]*/i, "").replace(/[?#].*$/, "").replace(/(?::\d+){1,2}$/, "").split("/").filter(Boolean).slice(-2).join("/").replace(/^js\//, "");
    const fn = String(m[1] || "").replace(/^(?:Object|Module|HTML\w+|Window)\./, "").replace(/[^A-Za-z0-9_$.]/g, "").slice(0, 40);
    out.push(file + (fn && !/^(anonymous|eval)$/.test(fn) ? `:${fn}` : ""));
    if (out.length >= 2) break;
  }
  return out.join(" < ").slice(0, 80);
};

// The browser, coarse: family and major version, and the system's family.
// Nothing here tells two phones of the same kind apart.
export const uaClass = (ua) => {
  const s = String(ua || "");
  const pick = (re, name) => { const m = re.exec(s); return m ? `${name} ${m[1]}` : null; };
  const browser = pick(/Edg(?:e|A|iOS)?\/(\d+)/, "edge") || pick(/OPR\/(\d+)/, "opera") || pick(/SamsungBrowser\/(\d+)/, "samsung") || pick(/Firefox\/(\d+)/, "firefox") || pick(/FxiOS\/(\d+)/, "firefox") ||
    pick(/CriOS\/(\d+)/, "chrome") || pick(/Chrome\/(\d+)/, "chrome") || pick(/Version\/(\d+)[.\d]* (?:Mobile\/\w+ )?Safari/, "safari") || "other";
  const os = /Android/.test(s) ? "android" : /iPhone|iPad|iPod/.test(s) ? "ios" : /Windows/.test(s) ? "windows" : /Mac OS X/.test(s) ? "macos" : /CrOS/.test(s) ? "chromeos" : /Linux/.test(s) ? "linux" : "other";
  return { browser, os };
};

// ---- the error book: one line per KIND of thing that went wrong, with a
// count — forty failed pictures are one line that says 40.
export class ErrorBook {
  constructor({ perSession = LIMITS.KINDS_PER_SESSION, perDay = LIMITS.KINDS_PER_DAY, sentToday = 0 } = {}) {
    this.items = new Map(); // key -> report (waiting to be sent)
    this.seen = new Set(); // every key this session has reported
    this.perSession = perSession;
    this.perDay = perDay;
    this.sentToday = sentToday;
    this.dropped = 0;
  }
  // kind: "js" | "promise" | "console" | "http" | "img" | "media" | "sw" | "stall" | "crash" | "mem" | "ws" | "update"
  add(kind, level, message, { loc = "", screen = "", ctx = null, raw = false, now = Date.now() } = {}) {
    const msg = raw ? String(message).slice(0, LIMITS.MSG) : normMessage(message);
    if (!msg) return false;
    const key = `${kind}|${msg}|${loc}|${ctx && ctx.status != null ? ctx.status : ""}`;
    let it = this.items.get(key);
    if (it) { it.n++; it.t1 = now; return true; }
    if (!this.seen.has(key)) {
      if (this.seen.size >= this.perSession || this.sentToday + this.seen.size >= this.perDay) { this.dropped++; return false; }
      this.seen.add(key);
    }
    it = { k: kind, l: level === "warn" ? "warn" : "error", m: msg, n: 1, t0: now, t1: now };
    if (loc) it.s = loc;
    if (screen) it.r = screen;
    if (ctx) it.c = ctx;
    this.items.set(key, it);
    return true;
  }
  get size() { return this.items.size; }
  // What goes into the next batch (at most REPORTS_PER_BATCH; the rest wait).
  drain(max = LIMITS.REPORTS_PER_BATCH) {
    const out = [];
    for (const [key, it] of this.items) {
      if (out.length >= max) break;
      out.push(it);
      this.items.delete(key);
    }
    return out;
  }
  // a batch that could not be sent goes back (counts merge)
  restore(list) {
    for (const it of list) {
      const key = `${it.k}|${it.m}|${it.s || ""}|${it.c && it.c.status != null ? it.c.status : ""}`;
      const cur = this.items.get(key);
      if (cur) { cur.n += it.n; cur.t0 = Math.min(cur.t0, it.t0); } else this.items.set(key, it);
    }
  }
}

// ---- controls: a press is two property reads and `c[input]++`. Nothing is
// allocated after a control's first press on a screen (no key string is
// built per press), so a held key costs what a counter costs.
export class ControlCounter {
  constructor() {
    this.screens = Object.create(null); // screen -> id -> { remote, touch, mouse, keyboard, pen }
    this.used = new Set(); // ids already reported once this session
    this.any = false;
  }
  hit(screen, id, input) {
    let s = this.screens[screen];
    if (s === undefined) s = this.screens[screen] = Object.create(null);
    let c = s[id];
    if (c === undefined) c = s[id] = { remote: 0, touch: 0, mouse: 0, keyboard: 0, pen: 0 };
    c[input]++;
    this.any = true;
  }
  drain(max = LIMITS.CONTROLS_PER_BATCH) {
    const out = [];
    if (!this.any) return out;
    let left = false;
    for (const screen of Object.keys(this.screens)) {
      const s = this.screens[screen];
      for (const id of Object.keys(s)) {
        const c = s[id];
        for (const input of Object.keys(c)) {
          const n = c[input];
          if (!(n > 0)) continue;
          if (out.length >= max) { left = true; continue; }
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
  clear() { this.screens = Object.create(null); this.any = false; }
}

// ---- timers: start(name) … end(name, dim) → [name, ms, dim]
export class Timers {
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.open = new Map();
    this.done = [];
  }
  start(name, at) { this.open.set(name, at == null ? this.clock() : at); }
  cancel(name) { this.open.delete(name); }
  running(name) { return this.open.has(name); }
  end(name, dim) {
    const t0 = this.open.get(name);
    if (t0 == null) return null;
    this.open.delete(name);
    return this.value(name, this.clock() - t0, dim);
  }
  value(name, ms, dim) {
    if (!(ms >= 0) || !Number.isFinite(ms)) return null;
    if (this.done.length >= LIMITS.TIMINGS_HELD) this.done.shift();
    const row = dim ? [name, Math.round(ms), dim] : [name, Math.round(ms)];
    this.done.push(row);
    return row;
  }
  drain(max = LIMITS.TIMINGS_PER_BATCH) { return this.done.splice(0, max); }
}

// The play path, in the four words both apps use.
export const playPath = ({ torrent, offline, remux, transcode }) =>
  torrent ? "torrent" : offline ? "offline" : remux ? "remux" : transcode ? "transcode" : "direct";

// May a batch go out now? Not while someone is moving about, and not while a
// play is starting. `sinceInputMs`: how long since the last key, tap or wheel.
export const IDLE_MS = 2500;
export const idleNow = ({ sinceInputMs, playStarting }) => sinceInputMs >= IDLE_MS && !playStarting;
