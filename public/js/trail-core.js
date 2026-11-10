// The trail a problem report carries (docs/report-trail.md): the last steps
// the viewer took, kept in memory only and sent only inside a report the
// viewer chose to send. This is the PURE half — no DOM, it runs under node's
// test runner as it is — and the TV and phone apps carry the same rules in
// tv-native/src/trailCore.ts (test/fixtures/trail-cases.json holds the cases
// both must agree on).
//
// An entry, as it leaves the device:  { t, k, ...a few short fields }
//   t   milliseconds BEFORE the report was sent (0 = the moment of sending)
//   k   nav · tap · key · sheet · toast · err · req · search · play · net · app · feat
//   n   how many times in a row, when it repeated (an arrow held, a poll)
//
// What is NEVER in it: anything typed into a field (only Enter, Escape and Tab
// are named there, never a character), tokens, codes and keys from addresses,
// query strings, other profiles' names. The one thing typed that is: the
// search the viewer ran (the server sees it anyway, and "search found
// nothing" needs it).

export const TRAIL = {
  MAX: 60, // entries held
  WINDOW_MS: 10 * 60 * 1000, // and only the last ten minutes of them are sent
  STR: 160, // longest string in an entry
  LABEL: 40, // a control's label
  BYTES: 12000, // the whole trail as sent
  MERGE_MS: 5000, // the same entry again within this: counted, not repeated
  SLOW_MS: 2000, // a request this slow is a step worth seeing
  REQS: 10, // request timings kept for the context
};
export const KINDS = ["nav", "tap", "key", "sheet", "toast", "err", "req", "search", "play", "net", "app", "feat"];
const MERGEABLE = new Set(["key", "req", "err", "tap", "feat", "toast", "net"]);

// One line, no control characters, no markup brackets, at most `n` long.
export const short = (v, n = TRAIL.STR) =>
  String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

// Whatever a string in the trail says, it never carries an address's query,
// a key or token written out, or an e-mail address.
export const redact = (text) =>
  String(text)
    .replace(/\b(?:https?|wss?):\/\/[^\s"'‹›)]+/gi, (u) => trailPath(u))
    .replace(/\b(token|session|sid|password|passwd|secret|auth|authorization|cookie|key|pin|code)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,)]+)/gi, "$1=…")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "‹email›");

const val = (v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  const s = short(redact(short(v, 400)));
  return s || null;
};

const same = (a, b) => {
  for (const key of Object.keys(a)) if (key !== "at" && key !== "n" && a[key] !== b[key]) return false;
  for (const key of Object.keys(b)) if (key !== "at" && key !== "n" && !(key in a)) return false;
  return true;
};

// Whole-word occurrences of other profiles' names → "someone".
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const scrubNames = (text, names) => {
  let out = String(text);
  for (const name of names || []) {
    const n = String(name || "").trim();
    if (n.length < 2) continue;
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1someone");
  }
  return out;
};

export class Trail {
  constructor({ max = TRAIL.MAX, windowMs = TRAIL.WINDOW_MS, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.items = [];
  }

  // add("req", { m: "GET", p: "/api/item/x", s: 500, ms: 3100 })
  add(k, fields = {}) {
    if (!KINDS.includes(k)) return null;
    const at = this.now();
    const e = { at, k };
    for (const key of Object.keys(fields || {})) {
      if (key === "at" || key === "k" || key === "t" || key === "n") continue;
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
      // a search refined as it is typed is one search: the last words
      if (k === "search" && last.k === "search") {
        last.q = e.q;
        last.at = at;
        return last;
      }
    }
    this.items.push(e);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    return e;
  }

  clear() { this.items.length = 0; }

  // The wire form: newest last, `t` = ms before `sentAt`, the window only,
  // other profiles' names taken out, the oldest dropped until it fits.
  take({ sentAt = this.now(), names = [], maxBytes = TRAIL.BYTES } = {}) {
    const from = sentAt - this.windowMs;
    const out = [];
    for (const e of this.items) {
      if (e.at < from) continue;
      const o = { t: Math.max(0, Math.round(sentAt - e.at)), k: e.k };
      for (const key of Object.keys(e)) {
        if (key === "at" || key === "k") continue;
        o[key] = typeof e[key] === "string" && names && names.length ? scrubNames(e[key], names) : e[key];
      }
      out.push(o);
    }
    let size = JSON.stringify(out).length;
    while (out.length && size > maxBytes) size -= JSON.stringify(out.shift()).length + 1;
    return out;
  }
}

// ---------- what may be said about a key ----------
// In a field: only the keys that end or leave it. Anywhere else: keys by
// NAME only — a single character is never kept (a TV browser types with the
// same keys), Space excepted.
const NAMED = /^(Arrow(Up|Down|Left|Right)|Enter|Escape|Esc|Tab|Backspace|Delete|Home|End|PageUp|PageDown|F\d{1,2}|Media[A-Za-z]+|Audio[A-Za-z]+|Browser[A-Za-z]+|GoBack|ContextMenu|Color[A-Za-z0-9]+|Channel(Up|Down)|Info|Guide|Exit|Settings|Subtitle|Close|Select|ZoomToggle|TV|XF86[A-Za-z0-9]+|Unidentified)$/;
export const keyName = (key, inField = false) => {
  const k = String(key == null ? "" : key);
  if (inField) return k === "Enter" || k === "Escape" || k === "Tab" ? k : null;
  if (k === " " || k === "Spacebar") return "Space";
  return k.length > 1 && NAMED.test(k) ? k : null;
};

// ---------- what may be said about an address ----------
// Its path, no origin, no query, no fragment. Ids stay (they are what makes a
// report reproducible); after a word that guards a secret (auth, sessions,
// token, a pairing or reset code…) only plain words stay, anything else is "…".
const GUARDS = new Set(["auth", "sessions", "session", "token", "tokens", "describe", "pair", "pairing", "reset", "claim", "unlock", "code", "codes", "invite", "pin", "kids-pin", "password", "google", "airtoken", "link"]);
const WORD = /^[a-z][a-z-]{0,23}$/;
const ID = /^[A-Za-z0-9._:~-]{1,48}$/;
export const trailPath = (u) => {
  const s = String(u == null ? "" : u)
    .slice(0, 800)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
    .replace(/[?#].*$/, "");
  let guarded = false;
  const segs = s.split("/").filter(Boolean).slice(0, 8).map((seg) => {
    let d = seg;
    try { d = decodeURIComponent(seg); } catch {}
    if (WORD.test(d) && !(guarded && d.length >= 8 && /^[a-f-]+$/.test(d))) {
      if (GUARDS.has(d)) guarded = true;
      return d;
    }
    if (!guarded && ID.test(d)) return d;
    return "…";
  });
  return "/" + segs.join("/");
};

// The search the viewer ran, from the address of the request that ran it
// (never the suggestions asked for while typing).
export const searchOf = (u) => {
  const s = String(u == null ? "" : u);
  const path = trailPath(s);
  if (!/^\/api\/(search|discover\/search)$/.test(path)) return null;
  const qi = s.indexOf("?");
  if (qi < 0) return null;
  for (const part of s.slice(qi + 1).replace(/#.*$/, "").split("&")) {
    const [k, v = ""] = part.split("=");
    if (k !== "q") continue;
    let q = v;
    try { q = decodeURIComponent(v.replace(/\+/g, " ")); } catch {}
    q = short(q, 100);
    return q || null;
  }
  return null;
};

// A screen of the website, from its route pattern and the address: the
// pattern, and the title id when the screen has one. A code in the address
// (a party's, a pairing's) and a search's words are not taken from here.
export const routeEntry = (pattern, hash) => {
  const out = { s: short(pattern, 60) };
  const names = String(pattern || "").split("/");
  const vals = String(hash || "").replace(/^#/, "").split("/");
  names.forEach((name, i) => {
    if (!name.startsWith(":") || vals[i] == null) return;
    let v = vals[i].replace(/\?.*$/, "");
    try { v = decodeURIComponent(v); } catch {}
    if (name === ":id" && ID.test(v)) out.id = v;
    else if (name === ":type" && WORD.test(v)) out.ty = v;
  });
  return out;
};

// The address the report itself names (context.route): the same rule — a
// code or token in it becomes "…".
export const safeRoute = (hash) => {
  const h = String(hash || "");
  return h.replace(/^(#\/(?:party|group|pair|reset|claim|invite)\/)[^/?]+/, "$1…");
};

// ---------- the trail in plain words ----------
// One line per step, the same words in the sheet's "See what will be sent",
// the admin's timeline and its Copy for Claude (and in the apps:
// tv-native/src/trailCore.ts says the same).
const clock = (s) => {
  if (s == null || !Number.isFinite(Number(s))) return "?";
  const v = Math.max(0, Math.round(Number(s)));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const ss = String(v % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
const dur = (ms) => (ms == null ? "?" : ms >= 10000 ? `${Math.round(ms / 1000)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
// "−2:05": how long before the report was sent
export const trailAgo = (t) => `−${clock((Number(t) || 0) / 1000)}`;
const extra = (e, skip) => Object.keys(e).filter((k) => !skip.includes(k) && e[k] != null && e[k] !== "").map((k) => `${k} ${e[k]}`).join(", ");
const PLAY = {
  start: (e) => `first picture after ${dur(e.ms)}${e.path ? ` (${e.path})` : ""}`,
  play: (e) => `play at ${clock(e.at)}`,
  pause: (e) => `pause at ${clock(e.at)}`,
  seek: (e) => `seek ${clock(e.from)} → ${clock(e.to)}`,
  seeked: (e) => `playing again ${dur(e.ms)} after the seek`,
  stall: (e) => `stalled ${dur(e.ms)}${e.at != null ? ` at ${clock(e.at)}` : ""}`,
  buffering: (e) => `buffering${e.at != null ? ` at ${clock(e.at)}` : ""}`,
  ended: (e) => `reached the end${e.at != null ? ` (${clock(e.at)})` : ""}`,
  rate: (e) => `speed ×${e.v}`,
  picture: (e) => `picture now ${e.w ? `${e.w}×` : ""}${e.h}`,
  error: (e) => `video error${e.code != null ? ` code ${e.code}` : ""}${e.m ? `: ${e.m}` : ""}`,
  audio: (e) => `audio → ${e.v}`,
  subtitles: (e) => `subtitles → ${e.v}`,
  quality: (e) => `quality → ${e.v}${e.auto ? " (by itself)" : ""}`,
  next: (e) => `next episode${e.to ? ` (${e.to})` : ""}`,
  mark: (e) => {
    const x = extra(e, ["t", "k", "e", "mk", "n"]);
    return `player mark ${e.mk}${x ? ` (${x})` : ""}`;
  },
};
const APP = {
  start: "the app started",
  profile: "a profile came in",
  hidden: "left the app (out of sight)",
  shown: "came back to the app",
  background: "the app went to the background",
  foreground: "the app came to the front",
  "fullscreen-on": "full screen on",
  "fullscreen-off": "full screen off",
  "pip-on": "picture in picture on",
  "pip-off": "picture in picture off",
};
export const trailLine = (e) => {
  if (!e || typeof e !== "object") return "";
  let s;
  switch (e.k) {
    case "nav": s = `opened ${e.s || "?"}${e.id ? ` (${e.id})` : ""}`; break;
    case "tap": s = e.ui ? `pressed ${e.ui}` : `pressed ${e.r || "control"}${e.l ? ` “${e.l}”` : ""}${e.on === true ? " (on)" : e.on === false ? " (off)" : ""}${e.v ? ` → ${e.v}` : ""}`; break;
    case "key": s = `key ${e.key}`; break;
    case "sheet": s = `${e.on === false ? "closed" : "opened"} “${e.s || "sheet"}”`; break;
    case "toast": s = `was shown: “${e.m || ""}”`; break;
    case "err": s = `${e.lv === "warn" ? "warning" : "error"}${e.w ? ` (${e.w})` : ""}: ${e.m || "?"}${e.st ? ` [${e.st}]` : ""}${e.code != null ? ` code ${e.code}` : ""}`; break;
    case "req": s = `${e.m || "GET"} ${e.p || "?"} → ${e.s === 0 ? "no answer" : e.s}${e.ms != null ? ` in ${dur(e.ms)}` : ""}`; break;
    case "search": s = `searched “${e.q || ""}”`; break;
    case "play": {
      if (PLAY[e.e]) s = PLAY[e.e](e);
      else {
        const x = extra(e, ["t", "k", "e", "n"]);
        s = `player ${e.e || "?"}${x ? ` (${x})` : ""}`;
      }
      break;
    }
    case "net": s = e.on === true ? "back online" : e.on === false ? "went offline" : e.ws ? `live connection ${e.ws}` : `connection now ${[e.type, e.mbps != null ? `${e.mbps} Mbit/s` : "", e.rtt != null ? `${e.rtt} ms` : ""].filter(Boolean).join(", ")}`; break;
    case "app": s = APP[e.e] || `app ${e.e || "?"}`; break;
    case "feat": s = `used ${e.f}`; break;
    default: s = `${e.k} ${extra(e, ["t", "k", "n"])}`;
  }
  return e.n > 1 ? `${s} ×${e.n}` : s;
};
// How a step should stand out: "bad" (an error, a stall, a request with no
// answer or a server fault, the line gone), "warn" (a refusal, a slow answer), "".
export const trailLevel = (e) => {
  if (!e) return "";
  if (e.k === "err") return e.lv === "warn" ? "warn" : "bad";
  if (e.k === "play" && (e.e === "error" || e.e === "stall")) return "bad";
  if (e.k === "play" && e.e === "mark" && /error|stall/.test(String(e.mk))) return "warn";
  if (e.k === "req") return e.s === 0 || e.s >= 500 ? "bad" : e.s >= 400 || e.ms >= TRAIL.SLOW_MS ? "warn" : "";
  if (e.k === "net" && (e.on === false || e.ws === "down")) return "bad";
  return "";
};

// The facts gathered at send time, in a fixed order with plain names; what
// this list does not know comes after, as it was sent.
const FACTS = [
  ["app", "app"], ["v", "version"], ["build", "build"], ["os", "system"], ["model", "device"], ["device", "device kind"], ["browser", "browser"],
  ["screen", "screen"], ["viewport", "window"], ["lang", "language"], ["tz", "time zone"], ["installed", "installed as an app"],
  ["sw", "service worker"], ["cache", "offline cache"], ["storage", "storage"], ["free", "free space"], ["mem", "memory"], ["cores", "cores"],
  ["lowRam", "low on memory"], ["saveData", "data saver"], ["dataMode", "data mode"], ["motion", "reduced motion"], ["look", "look"],
  ["quality", "quality"], ["subLang", "subtitle language"], ["subsDefault", "subtitles on by themselves"], ["audioLang", "audio language"],
  ["autoplayNext", "play the next episode"], ["kids", "kids profile"], ["auth", "sign-in mode"], ["signedIn", "signed in"],
  ["server", "server"], ["conn", "connection"], ["online", "online"], ["socket", "live connection"], ["client", "client id"], ["up", "this session"],
];
const PLAYER = [
  ["id", "title id"], ["pos", "position"], ["dur", "length"], ["ahead", "buffered ahead"], ["ready", "ready state"], ["net", "network state"],
  ["state", "player state"], ["paused", "paused"], ["ended", "ended"], ["seeking", "seeking"], ["waiting", "waiting for"], ["rate", "speed"],
  ["picture", "picture"], ["dropped", "dropped frames"], ["path", "path"], ["v", "video"], ["cap", "capped at"], ["level", "level"],
  ["audio", "audio"], ["subtitles", "subtitles"], ["src", "stream"], ["error", "error"], ["client", "client id"], ["party", "watch party"], ["airplay", "AirPlay"],
];
const rowsOf = (o, table, fmt) => {
  if (!o || typeof o !== "object") return [];
  const known = new Set(table.map(([k]) => k));
  const show = (k, v) => (fmt[k] ? fmt[k](v) : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
  const rows = table.filter(([k]) => o[k] != null && o[k] !== "").map(([k, label]) => [label, show(k, o[k])]);
  for (const k of Object.keys(o)) if (!known.has(k) && o[k] != null && o[k] !== "" && typeof o[k] !== "object") rows.push([k, String(o[k])]);
  return rows;
};
export const factRows = (env) => rowsOf(env, FACTS, { up: (v) => clock(v), mem: (v) => (typeof v === "number" ? `${v} GB` : String(v)) });
export const playerRows = (p) => rowsOf(p, PLAYER, { pos: clock, dur: clock, ahead: (v) => `${v} s`, waiting: (v) => dur(v) });
export const reqLine = (r) => `${trailAgo(r.t)}  ${r.m || "GET"} ${r.p || "?"} → ${r.s === 0 ? "no answer" : r.s} in ${dur(r.ms)}`;
// The whole of it as text (Copy for Claude, and the sheet's disclosure).
export const trailText = ({ trail = [], env = null, player = null, reqs = [] } = {}) => {
  const out = [];
  if (trail && trail.length) {
    out.push("Last steps (oldest first; time before the report was sent):");
    for (const e of trail) {
      const lv = trailLevel(e);
      out.push(`  ${trailAgo(e.t)}  ${lv === "bad" ? "!! " : lv === "warn" ? "!  " : ""}${trailLine(e)}`);
    }
  }
  const f = factRows(env);
  if (f.length) out.push("Device and app:", ...f.map(([k, v]) => `  ${k}: ${v}`));
  const p = playerRows(player);
  if (p.length) out.push("The player at the time:", ...p.map(([k, v]) => `  ${k}: ${v}`));
  if (reqs && reqs.length) out.push("Last requests:", ...reqs.map((r) => `  ${reqLine(r)}`));
  return out.join("\n");
};
