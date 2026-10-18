// config.json, checked at boot.
//
// Every key the server reads is listed here with what it must be and what
// happens without it. At boot (src/config.js):
//   - an UNKNOWN key is a warning ("did you mean …?") — a typo used to be a
//     setting that silently did nothing;
//   - a key with a BAD VALUE is refused: it is taken out before the rest of
//     the server reads it, so the default applies, and the log says which
//     key, what was wrong and what the default is. The server still starts —
//     a typo in a setting must never become a crash loop.
// The problems are kept for the admin's Health card and /api/admin/metrics.
// A value is never repeated back for a key that holds a secret.
//
// PURE apart from the one log line per problem (check() returns them).
"use strict";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const numeric = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : NaN);

// type checkers: return null when fine, else what is wrong
const T = {
  bool: (v) => (typeof v === "boolean" ? null : "must be true or false (without quotes)"),
  str: (v) => (typeof v === "string" ? null : "must be text in quotes"),
  strOrNull: (v) => (v == null || typeof v === "string" ? null : "must be text in quotes"),
  int: (min, max) => (v) => { const n = numeric(v); return Number.isInteger(n) && n >= min && n <= max ? (typeof v === "string" ? "soft:write it as a number, without quotes" : null) : `must be a whole number from ${min} to ${max}`; },
  num: (min, max) => (v) => { const n = numeric(v); return Number.isFinite(n) && n >= min && n <= max ? (typeof v === "string" ? "soft:write it as a number, without quotes" : null) : `must be a number from ${min} to ${max}`; },
  obj: (v) => (isObj(v) ? null : "must be an object { … }"),
  objOrNull: (v) => (v == null || isObj(v) ? null : "must be an object { … }"),
  falseOrObj: (v) => (v === false || isObj(v) ? null : "must be false or an object { … }"),
  strList: (v) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? null : 'must be a list of texts: ["…", "…"]'),
  oneOf: (...opts) => (v) => (opts.includes(v) ? null : `must be one of ${opts.map((o) => JSON.stringify(o)).join(", ")}`),
};

// key -> [check, what happens without it, secret?]
const SCHEMA = {
  port: [T.int(1, 65535), "4000"],
  adminName: [T.str, '"the admin"'],
  adminPassword: [T.str, "none: the admin page stays locked (or AURORA_ADMIN_PASSWORD in .env)", true],
  libraries: [(v) => {
    if (!isObj(v)) return 'must be { "movies": ["…"], "shows": ["…"] }';
    for (const k of Object.keys(v)) if (!["movies", "shows"].includes(k)) return `has "${k}": only "movies" and "shows" are read`;
    for (const k of ["movies", "shows"]) if (v[k] != null && !(Array.isArray(v[k]) && v[k].every((x) => typeof x === "string"))) return `"${k}" must be a list of folders: ["D:\\\\Movies"]`;
    return null;
  }, "no library folders"],
  scanIntervalMinutes: [T.num(1, 1440), "10"],
  autoOcrSubtitles: [T.bool, "true"],
  onlineMetadata: [T.bool, "true"],
  skipDatabases: [T.bool, "true"],
  tmdbApiKey: [T.str, "none (or TMDB_API_KEY in .env)", true],
  openrouterApiKey: [T.str, "none: AI picks stay off (or OPENROUTER_API_KEY in .env)", true],
  aiModel: [T.str, '"google/gemini-2.5-flash"'],
  torrents: [T.bool, "true"],
  preconvert: [T.bool, "true"],
  offlineCacheGb: [T.num(0.1, 100000), "8"],
  pushContact: [T.str, "none"],
  prewarmStreams: [T.bool, "true"],
  downloadMinFreePercent: [T.num(0, 100), "10"],
  downloadRace: [(v) => (v === false || v === true || isObj(v) ? null : "must be false or an object { … }"), "on, with its defaults"],
  notifications: [(v) => {
    if (!isObj(v)) return "must be an object { … }";
    for (const k of Object.keys(v)) if (!["ntfy", "telegram"].includes(k)) return `has "${k}": only "ntfy" and "telegram" are read`;
    if (v.ntfy != null && !(isObj(v.ntfy) && typeof v.ntfy.topic === "string")) return 'ntfy must be { "topic": "…" }';
    if (v.telegram != null && !(isObj(v.telegram) && typeof v.telegram.botToken === "string" && (typeof v.telegram.chatId === "string" || typeof v.telegram.chatId === "number"))) return 'telegram must be { "botToken": "…", "chatId": "…" }';
    return null;
  }, "no alerts are sent anywhere", true],
  backupDir: [T.str, "data/backups"],
  backupMirrorDir: [T.str, "no second copy"],
  backups: [T.bool, "true"],
  backupKeep: [T.obj, '{ "daily": 7, "weekly": 4, "monthly": 3 }'],
  health: [T.falseOrObj, "alerts on, default thresholds"],
  healer: [T.obj, "automatic repairs on"],
  healthPingUrl: [(v) => (typeof v === "string" && /^https?:\/\//.test(v) ? null : "must be an http(s) address in quotes"), "no ping", true],
  pushHosts: [T.strList, "the built-in push services only"],
  authMode: [T.oneOf("open", "transition", "closed", "hybrid", "required"), '"open" (the admin page\'s setting wins once saved)'],
  serveFaststart: [T.bool, "true"],
  tvPlayer: [T.objOrNull, "the TV app's own values"],
  tvRender: [T.objOrNull, "all off"],
  aria2Path: [T.str, "found on PATH / winget"],
  aria2Port: [T.int(1, 65535), "6801"],
  // ---- srv-resilience ----
  rateLimits: [(v) => {
    if (["log", "enforce", "off"].includes(v)) return null;
    if (!isObj(v)) return 'must be "log", "enforce", "off" or { "mode": …, "groups": { … } }';
    if (v.mode != null && !["log", "enforce", "off"].includes(v.mode)) return 'mode must be "log", "enforce" or "off"';
    if (v.groups != null && !isObj(v.groups)) return "groups must be an object { … }";
    const known = Object.keys(require("./ratelimit").GROUPS);
    for (const [g, o] of Object.entries(v.groups || {})) {
      if (!known.includes(g)) return `groups has "${g}": the groups are ${known.join(", ")}`;
      if (!isObj(o)) return `groups.${g} must be { "rate", "burst", "mode" }`;
    }
    return null;
  }, '"enforce" (the owner decided, 2026-10-18; "log" counts and refuses nothing)'],
  upstream: [(v) => (isObj(v) && (v.hosts == null || isObj(v.hosts)) ? null : 'must be { "hosts": { "<host>": { … } } }'), "the built-in limits per host"],
  http: [(v) => {
    if (!isObj(v)) return "must be an object { … }";
    for (const [k, [lo, hi]] of Object.entries({ headersTimeoutSec: [1, 600], requestTimeoutSec: [1, 3600], keepAliveTimeoutSec: [1, 3600] })) {
      if (v[k] != null && !(Number.isFinite(numeric(v[k])) && numeric(v[k]) >= lo && numeric(v[k]) <= hi)) return `${k} must be a number of seconds from ${lo} to ${hi}`;
    }
    return null;
  }, "headers 20 s, request 120 s, keep-alive 75 s"],
  trustProxy: [(v) => (Array.isArray(v) && v.every((x) => typeof x === "string" && (/^[0-9a-f:.]+$/i.test(x) || /^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(x))) ? null : 'must be a list of addresses or IPv4 ranges: ["172.17.0.1", "10.0.0.0/8"]'), "only this machine (a proxy on the same box)"],
  // ---- srv-eventloop / srv-streaming (added at the integration) ----
  powerProfile: [(v) => (typeof v === "string" && ["auto", "low", "normal"].includes(v.toLowerCase()) ? null : 'must be "auto", "low" or "normal"'), '"auto" (chosen from the cores, memory and heap)'],
  diskTypes: [(v) => (isObj(v) ? null : 'must be { "<folder>": "hdd" | "ssd" | "network" | "unknown" }'), "what the OS says each disk is"],
  hwEncode: [(v) => (typeof v === "boolean" || (typeof v === "string" && ["auto", "on", "off", "true", "false", "force"].includes(v.toLowerCase())) ? null : 'must be "auto", "on" or "off"'), '"auto" (the graphics card only where it was measured as good as the CPU)'],
  hwEncodeSessions: [T.int(1, 32), "what the card's probe found"],
  torrentUploadKBps: [T.num(-1, 1000000), "-1: no upload cap (the owner: no cap on downloads unless the admin sets one)"],
  jitCacheGB: [T.num(0.1, 100000), "20"],
  ws: [(v) => (isObj(v) && (v.mode == null || ["log", "enforce", "off"].includes(v.mode)) ? null : 'must be { "maxPerAddress", "maxMessageKb", "mode" }'), "64 kB messages, 64 sockets per address (LAN 4x), the rate-limit mode"],
};

// Edit distance, for "did you mean".
const lev = (a, b) => {
  a = a.toLowerCase(); b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const suggest = (key) => {
  let best = null;
  for (const k of Object.keys(SCHEMA)) { const s = lev(key, k); if (s <= Math.max(2, Math.floor(k.length / 4)) && (!best || s < best.s)) best = { k, s }; }
  return best ? best.k : null;
};

const show = (v) => { try { const s = JSON.stringify(v); return s.length > 60 ? s.slice(0, 57) + "…" : s; } catch { return String(v); } };

// check(userConfig) -> { problems: [{ key, level: "warn"|"refused", message }], refused: [keys] }
// With `apply`, refused keys are deleted from the object (their defaults apply).
const check = (cfg, { apply = false, log = true } = {}) => {
  const problems = [];
  const refused = [];
  if (!isObj(cfg)) return { problems, refused };
  for (const key of Object.keys(cfg)) {
    if (key.startsWith("_") || key.startsWith("$") || key.startsWith("//")) continue; // comments
    const spec = SCHEMA[key];
    if (!spec) {
      const s = suggest(key);
      problems.push({ key, level: "warn", message: `"${key}" is not a setting this server reads — it does nothing${s ? ` (did you mean "${s}"?)` : ""}` });
      continue;
    }
    const [fn, dflt, secret] = spec;
    let why = null;
    try { why = fn(cfg[key]); } catch (e) { why = "could not be checked"; }
    if (!why) continue;
    if (why.startsWith("soft:")) {
      problems.push({ key, level: "warn", message: `"${key}": ${why.slice(5)} (it is used as it is)` });
      continue;
    }
    refused.push(key);
    problems.push({ key, level: "refused", message: `"${key}" ${secret ? "" : `is ${show(cfg[key])}, which `}${why} — refused, using the default: ${dflt}` });
  }
  if (apply) for (const k of refused) delete cfg[k];
  if (log) for (const p of problems) {
    try { (p.level === "refused" ? console.error : console.warn)(`[config] ${p.message}`); } catch {}
  }
  return { problems, refused };
};

let lastResult = { problems: [], refused: [], at: null };
const remember = (r) => { lastResult = { ...r, at: new Date().toISOString() }; return r; };
const last = () => lastResult;

module.exports = { check, remember, last, SCHEMA, _internals: { suggest, lev } };
