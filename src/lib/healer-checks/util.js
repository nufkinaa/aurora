// Small things every healer check needs: sizes and ages as words, the shape a
// log line is reduced to so repeats group, and a few sums. All pure.
"use strict";

const fmtBytes = (b) => {
  if (!b && b !== 0) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtAge = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
};
const fmtMs = (v) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

// A file path, whole — folders and file names with spaces in them included
// ("D:\Movies\Some Film (2020)\Some Film.mkv"): the folders run to the last
// separator, the file name to its extension (or to the next space when it has
// none). Shared with the redaction in healer-checks/ai.js.
const PATH_TAIL = String.raw`(?:[^\\/:"'*?<>|\r\n]*?\.[A-Za-z0-9]{2,5}(?![\w.])|[^\\/\s:"'*?<>|]*)`;
const PATH_WIN = new RegExp(String.raw`(?:[A-Za-z]:|\\\\[\w.$-]+)\\(?:[^\\/:"'*?<>|\r\n]+\\)*` + PATH_TAIL, "g");
const PATH_POSIX = new RegExp(String.raw`(^|[\s("'=:,])~?/(?:[^/:"'<>|\r\n]+/)+` + PATH_TAIL, "g");

// Collapse the variable parts of a log line so repeats group: paths, ids,
// hashes, addresses, numbers, quoted names. Only the first line counts (an
// uncaught error drags its stack along). "[download] a1b2c3 re-queued: …"
// and its siblings become one bucket with a count — and the same string is
// the FINGERPRINT a never-seen-before error is remembered under.
const normalizeMessage = (msg) =>
  String(msg || "")
    .split(/\r?\n/)[0]
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(PATH_WIN, "<path>")
    .replace(PATH_POSIX, "$1<path>")
    .replace(/\b[0-9a-f]{6,40}\b/gi, "#")
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/(["'“”]).*?\1/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

// Top repeated messages in a set of log rows.
const topMessages = (rows, n = 3) => {
  const tally = new Map();
  for (const r of rows) {
    const k = normalizeMessage(r.msg);
    const cur = tally.get(k) || { key: k, n: 0, sample: r.msg.slice(0, 200) };
    cur.n++;
    tally.set(k, cur);
  }
  return [...tally.values()].sort((a, b) => b.n - a.n).slice(0, n);
};

const worst = (statuses) =>
  statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "ok";

const median = (arr) => pct(arr, 50);
const pct = (arr, p) => {
  if (!arr || !arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// Local calendar day and hour keys (the household's clock, like the charts).
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const hourKey = (t) => `${dayKey(t)}T${String(new Date(t).getHours()).padStart(2, "0")}`;

// Where a person is sent: the exact button, by the action's own title.
const pressFor = (actionId) => {
  let title = actionId;
  try {
    const a = require("../adminactions")._internals.ACTIONS.find((x) => x.id === actionId);
    if (a) title = a.title;
  } catch {}
  return { action: actionId, label: `Server → Actions → ${title}` };
};

module.exports = { PATH_WIN, PATH_POSIX, fmtBytes, fmtAge, fmtMs, plural, normalizeMessage, topMessages, worst, median, pct, dayKey, hourKey, pressFor };
