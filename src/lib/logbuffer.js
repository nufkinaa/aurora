// In-memory ring buffer of the server's own console output, so the admin panel
// can show the log without anyone SSHing in to tail pm2's files.
//
// Why capture in-process instead of reading pm2's log files: pm2 splits by
// STREAM, not by level — console.warn and console.error both land in
// aurora-error.log, and telling them apart afterwards would be pattern-matching
// guesswork. Patching console keeps the real level, which is the whole point of
// a "warnings vs errors" filter.
//
// Requiring this module installs the patch. It must be required before anything
// that logs at boot, i.e. first thing in server.js.
const { inspect } = require("util");

const MAX = 1500; // ~1500 lines is a few hundred KB and covers a long session
const MAX_LEN = 2000; // one pathological line must not eat the buffer

const buf = [];
let seq = 0;
let dropped = 0; // lines evicted since boot, so the UI can say "showing the last N"

// Formatting must never throw and never re-enter console (a throw inside a
// console patch turns one bad log line into a crash loop).
const fmt = (args) => {
  const parts = [];
  for (const a of args) {
    try {
      if (typeof a === "string") parts.push(a);
      else if (a instanceof Error) parts.push(a.stack || `${a.name}: ${a.message}`);
      else if (a === null || a === undefined || typeof a !== "object") parts.push(String(a));
      // util.inspect is what console itself uses: it handles circular refs
      // (real here — webtorrent objects, express req) and depth-limits instead
      // of throwing the way JSON.stringify does.
      else parts.push(inspect(a, { depth: 2, breakLength: Infinity, colors: false }));
    } catch {
      parts.push(Object.prototype.toString.call(a));
    }
  }
  const s = parts.join(" ");
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) + " …[truncated]" : s;
};

const push = (level, args) => {
  let msg;
  try {
    msg = fmt(args);
  } catch {
    return; // give up on this one line rather than break the caller
  }
  // The boot banner prints blank console.log()s for spacing; in a log table
  // those are just empty rows.
  if (!msg.trim()) return;
  buf.push({ id: ++seq, t: Date.now(), level, msg });
  if (buf.length > MAX) {
    buf.shift();
    dropped++;
  }
};

// Patch, don't replace: the original still runs, so pm2's files (and a plain
// `node server.js` terminal) keep everything exactly as before.
const install = () => {
  for (const [method, level] of [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      push(level, args);
      original(...args);
    };
  }
};

// `sinceId` lets the UI poll for just what's new instead of refetching the lot.
const read = ({ level, q, sinceId = 0, limit = 500 } = {}) => {
  const needle = (q || "").trim().toLowerCase();
  let rows = buf;
  if (sinceId) rows = rows.filter((e) => e.id > sinceId);
  if (level && level !== "all") {
    // "warn" means "warnings AND errors" — when you're hunting a problem you
    // want everything at or above that level, not warnings in isolation.
    rows = level === "warn"
      ? rows.filter((e) => e.level === "warn" || e.level === "error")
      : rows.filter((e) => e.level === level);
  }
  if (needle) rows = rows.filter((e) => e.msg.toLowerCase().includes(needle));
  // Newest first, capped — the admin table only ever renders a screenful.
  return rows.slice(-limit).reverse();
};

// Level tallies for the filter chips, always over the WHOLE buffer so the counts
// don't change as you filter.
const counts = () => {
  const c = { all: buf.length, info: 0, warn: 0, error: 0 };
  for (const e of buf) c[e.level]++;
  return c;
};

const clear = () => {
  buf.length = 0;
  dropped = 0;
};

const stats = () => ({ kept: buf.length, dropped, max: MAX, latestId: seq });

install();

module.exports = { read, counts, clear, stats };
