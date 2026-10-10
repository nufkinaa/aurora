// Telemetry hygiene (docs/analytics.md): what a message, an address or a
// stack frame is reduced to before it is counted, and the test of "does this
// string still look like something personal or secret". All pure.
//
// The clients already do this (public/js/telemetry-core.js, tv-native/src/
// telemetryCore.ts). It is done AGAIN here because a server must never trust
// a client to have removed a secret — and so that an older or a buggy build
// cannot put a token, an address or a title on this disk.
"use strict";
const crypto = require("crypto");
const { SEGMENTS, QUERY_KEEP } = require("./vocab");

const MSG_MAX = 160;
const LOC_MAX = 80;

// ---- the detectors: each names one kind of thing that must never be stored
const RE = {
  url: /\b(?:https?|wss?|file|blob|data|content|rtsp|magnet):[^\s"'<>)\]]+/gi,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  ipv4: /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/g,
  ipv6: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{0,4}\b/gi,
  jwt: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g,
  bearer: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  // "token=abc", "session: abc", "password abc", cookie pairs …
  secretPair: /\b(token|session|sessionid|sid|password|passwd|pwd|secret|auth|authorization|cookie|api[_-]?key|key|pin|x-session|x-profile-token|x-admin-password)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,)]+)/gi,
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  imdb: /\btt\d{5,}\b/gi,
  hex: /\b[0-9a-f]{8,}\b/gi,
  // a long run of mixed letters and digits is an id, a key or a hash
  blob: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/g,
  // a Windows or UNC path, folders and file names with spaces included (it
  // runs to the extension, or to the end of the line when there is none)
  winPath: /(?:[A-Za-z]:|\\\\[\w.$-]+)\\(?:[^\\/:"'*?<>|\r\n]+\\)*(?:[^\\/:"'*?<>|\r\n]*?\.[A-Za-z0-9]{2,5}(?![\w.])|[^\\/\s:"'*?<>|]*)/g,
  posixPath: /(^|[\s("'=:,])~?\/(?:[^/:"'<>|\r\n]+\/)+(?:[^\\/:"'*?<>|\r\n]*?\.[A-Za-z0-9]{2,5}(?![\w.])|[^\\/\s:"'*?<>|]*)/g,
  // an episode tag drags a show's name along with it
  episode: /\bS\d{1,2}\s?E\d{1,3}\b/gi,
};

// Quoted text: a quoted NAME in an error is nearly always code ("reading
// 'duration'"), a quoted PHRASE nearly always content ("Could not open
// 'Some Film'"). Only a single lower-case-initial identifier is kept.
const IDENT = /^[a-z_$][A-Za-z0-9_$.]{0,31}$/;
const QUOTED = /(["'`‘’“”])([^"'`‘’“”]{0,200})(["'`‘’“”])/g;
const quoted = (s) => s.replace(QUOTED, (m, a, inner) => (IDENT.test(inner) ? `'${inner}'` : "'…'"));

// ---- the household's own words. The server knows what is in its library
// and what its profiles are called; a client message that carries one of
// those (a title logged by mistake, a name in an error text) has it replaced
// here. Defence in depth, not the defence: the clients never hand telemetry a
// title in the first place (test/tel-contract.test.js checks every call).
// Short single words are left alone — a film called "Lost" or "Up" must not
// eat every "lost connection" — as are words that are an app's own vocabulary.
const GENERIC = new Set(("undefined function property document playback transcode download downloads subtitle subtitles settings response timeout manifest fragment internal " +
  "connection exception rejection promise network request failed loading buffering resolution fullscreen background foreground navigation component " +
  "guest kids home admin user test player movies shows search profile family everyone living bedroom kitchen").split(/\s+/));
let phrases = [];
let names = [];
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const setDictionary = ({ titles = [], people = [] } = {}) => {
  const seen = new Set();
  phrases = [];
  for (const t of titles) {
    const p = String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!p || seen.has(p) || p.length > 80) continue;
    const words = p.split(" ").length;
    if (!((words >= 2 && p.length >= 6) || (words === 1 && p.length >= 8 && !GENERIC.has(p)))) continue;
    seen.add(p);
    phrases.push(p);
    if (phrases.length >= 5000) break;
  }
  phrases.sort((a, b) => b.length - a.length); // the longest first: "Some Show Returns" before "Some Show"
  names = [...new Set(people.map((n) => String(n || "").trim()).filter((n) => n.length >= 3 && n.length <= 40 && !GENERIC.has(n.toLowerCase())))].slice(0, 500);
};
const withoutHouseholdWords = (s) => {
  if (!phrases.length && !names.length) return s;
  const low = s.toLowerCase();
  for (const p of phrases) if (low.includes(p)) s = s.replace(new RegExp(`(^|[^A-Za-z0-9])${reEsc(p)}(?![A-Za-z0-9])`, "gi"), "$1<title>");
  for (const n of names) if (s.includes(n)) s = s.replace(new RegExp(`(^|[^A-Za-z0-9])${reEsc(n)}(?![A-Za-z0-9])`, "g"), "$1<name>");
  return s;
};

// A message → what is stored and grouped by. First line only; everything
// variable or personal is replaced by a placeholder, so two reports of one
// fault from two homes are the same string.
const normMessage = (msg) => {
  let s = String(msg == null ? "" : msg).split(/\r?\n/)[0].slice(0, 600);
  s = s.replace(/[\x00-\x1f\x7f]/g, " ");
  s = s
    .replace(RE.url, "<url>")
    .replace(RE.email, "<email>")
    .replace(RE.jwt, "<token>")
    .replace(RE.bearer, "<token>")
    .replace(RE.secretPair, "$1=<redacted>")
    .replace(RE.winPath, "<path>")
    .replace(RE.posixPath, "$1<path>")
    .replace(RE.ipv4, "<ip>")
    .replace(RE.uuid, "<id>")
    .replace(RE.imdb, "<id>")
    .replace(RE.episode, "<ep>")
    .replace(RE.ipv6, "<ip>");
  s = quoted(s);
  s = withoutHouseholdWords(s);
  s = s
    .replace(RE.hex, "<hex>")
    .replace(RE.blob, "<id>")
    .replace(/[^\x20-\x7e]+/g, "…") // anything not plain ASCII: a title in another script, an emoji
    .replace(/\d+(?:[.,]\d+)*/g, "N")
    .replace(/(?:…\s*){2,}/g, "… ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, MSG_MAX);
};

// A request address → its SHAPE: "/img/:id?w=256", "/api/item/:id?profile".
// Path words are kept only when the server has a route segment of that name
// (vocab.SEGMENTS); everything else is ":id" (or ":file.ext"). Query values
// are dropped, except a small number on a key that is a size ("w", "h").
const urlPattern = (u) => {
  let s = String(u == null ? "" : u).slice(0, 600).replace(/[\x00-\x1f\x7f\s]/g, "");
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/#.*$/, "");
  const qi = s.indexOf("?");
  const pathPart = qi < 0 ? s : s.slice(0, qi);
  const query = qi < 0 ? "" : s.slice(qi + 1);
  const segs = pathPart.split("/").filter(Boolean).slice(0, 8).map((seg, i, all) => {
    const low = seg.toLowerCase();
    if (low === ":id") return low;
    if (SEGMENTS.has(low)) return low;
    const ext = i === all.length - 1 ? /\.([A-Za-z0-9]{2,5})$/.exec(seg) : null;
    if (ext && SEGMENTS.has("." + ext[1].toLowerCase())) return `:file.${ext[1].toLowerCase()}`;
    return ":id";
  });
  const keys = [];
  for (const part of query.split("&")) {
    if (!part || keys.length >= 5) continue;
    const [k, v = ""] = part.split("=");
    const key = k.toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,15}$/.test(key) || !SEGMENTS.has("?" + key)) continue;
    keys.push(QUERY_KEEP.has(key) && /^\d{1,5}$/.test(v) ? `${key}=${v}` : key);
  }
  return ("/" + segs.join("/") + (keys.length ? "?" + keys.join("&") : "")).slice(0, LOC_MAX);
};

// Where it happened, coarse: "screens/player.js:onStall" from the site (its
// modules are served as written, so a function name means something), a
// bare source tag from the TV (Hermes stacks are byte offsets — noise).
// Line and column numbers never survive: they change with every release and
// would make every release's errors "new".
const normLocation = (loc) => {
  const s = String(loc == null ? "" : loc).slice(0, 300);
  const out = [];
  for (const raw of s.split(/\s*[<|]\s*/).slice(0, 3)) {
    const part = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/\?[^:]*/, "").replace(/(?::\d+){1,2}$/, "");
    const m = /^([A-Za-z0-9_./-]{0,60}?)(?::([A-Za-z_$][\w$.]{0,40}))?$/.exec(part);
    if (!m) continue;
    // the file: its last two path parts — never a hash, never a bare number
    const file = m[1].split("/").filter(Boolean).slice(-2).filter((p) => /^[A-Za-z][A-Za-z0-9_.-]{0,30}$/.test(p) && !/[0-9a-f]{8,}/i.test(p) && !/\d{4,}/.test(p)).join("/").replace(/^js\//, "");
    const fn = m[2] && !/^(anonymous|Object\.anonymous)$/.test(m[2]) ? m[2] : "";
    if (!file && !fn) continue;
    out.push(file + (fn ? `:${fn}` : ""));
  }
  return out.join(" < ").slice(0, LOC_MAX);
};

// The id an error is known by: the same fault on any device, in any home, in
// any week gives the same ten characters.
const fingerprint = (app, kind, msg, loc) =>
  crypto.createHash("sha1").update(`${app}|${kind}|${msg}|${loc || ""}`).digest("hex").slice(0, 10);

// Does a stored string still carry something it must not? Used by the
// contract test over everything the stores hold, and as a last gate before a
// string is kept: a value that trips it is replaced by "<scrubbed>".
const SENSITIVE = [
  ["url", /\b(?:https?|wss?|file|magnet):\/\//i],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ["ip", /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ["imdb", /\btt\d{5,}\b/i],
  ["jwt", /\beyJ[A-Za-z0-9_-]{6,}\./],
  ["hex", /\b[0-9a-f]{12,}\b/i],
  ["blob", /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/],
  ["path", /(?:[A-Za-z]:\\|\\\\[\w.-]+\\|\/(?:home|Users|mnt|media|srv|var|volume\d?)\/)/],
  ["non-ascii", /[^\x20-\x7e]/],
  ["secret", /\b(?:password|passwd|token|session|cookie|secret|bearer)\s*[=:]\s*(?!<redacted>)\S/i],
];
const sensitive = (s) => {
  const str = String(s == null ? "" : s).replace(/[…→]/g, ""); // the two marks the scrubber itself writes
  for (const [name, re] of SENSITIVE) if (re.test(str)) return name;
  return null;
};
const safe = (s) => (sensitive(s) ? "<scrubbed>" : s);

// A short, harmless label (a model name, a version, a flag): plain
// characters only, capped, and never anything the detectors object to.
const label = (v, max = 24, strip = /[^A-Za-z0-9 ._+/()-]/g) => {
  const raw = String(v == null ? "" : v).slice(0, 200);
  if (sensitive(raw.replace(/[^ -~]/g, ""))) return ""; // judged BEFORE the stripping could disguise it
  if (withoutHouseholdWords(raw) !== raw) return ""; // a "model" that is a title or somebody's name
  const s = raw.replace(strip, "").replace(/\s+/g, " ").trim().slice(0, max);
  return s && !sensitive(s) ? s : "";
};

module.exports = { normMessage, urlPattern, normLocation, fingerprint, sensitive, safe, label, setDictionary, MSG_MAX, LOC_MAX };
