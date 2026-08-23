// Lightweight playback-timing recorder for the torrent pipeline.
// Emits grep-able "[perf]" log lines and appends one JSON line per finished
// torrent session to data/cache/perf/sessions.jsonl — nothing here may ever
// affect behavior: every write is fire-and-forget, every hook records the
// FIRST occurrence only and costs a Map lookup.
const fs = require("fs");
const path = require("path");
const config = require("../config");

const DIR = path.join(config.CACHE_DIR, "perf");
try {
  fs.mkdirSync(DIR, { recursive: true });
} catch {}

const recs = new Map(); // infoHash -> {t0, marks, meta}

// The two ways this recorder could stop being "zero-risk", closed off:
// a record whose torrent never gets evicted/removed (crash, restart) would
// leak — flush anything older than 6h; and the JSONL must never grow
// unbounded — rotate it when it passes ~2MB (one .old generation kept).
const MAX_REC_AGE_MS = 6 * 3600 * 1000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
setInterval(() => {
  const cutoff = Date.now() - MAX_REC_AGE_MS;
  for (const [hash, r] of recs) if (r.t0 < cutoff) flush(hash, "stale");
  fs.stat(path.join(DIR, "sessions.jsonl"), (err, st) => {
    if (err || st.size < MAX_LOG_BYTES) return;
    try {
      fs.renameSync(
        path.join(DIR, "sessions.jsonl"),
        path.join(DIR, "sessions.jsonl.old"),
      );
    } catch {}
  });
}, 3600000).unref?.();

const rec = (hash) => {
  let r = recs.get(hash);
  if (!r) {
    r = { t0: Date.now(), marks: {}, meta: {} };
    recs.set(hash, r);
  }
  return r;
};

// Record a named moment as milliseconds since the session's first mark.
// Repeat calls for the same name are ignored (first occurrence wins).
const mark = (hash, name, extra) => {
  if (!hash) return;
  const r = rec(hash);
  if (r.marks[name] !== undefined) return;
  r.marks[name] = Date.now() - r.t0;
  if (extra) Object.assign(r.meta, extra);
  console.log(
    `[perf] ${hash.slice(0, 8)} ${name}=+${r.marks[name]}ms` +
      (extra ? ` ${JSON.stringify(extra)}` : ""),
  );
};

// Attach a fact to the session without a timing mark.
const note = (hash, key, value) => {
  if (!hash) return;
  rec(hash).meta[key] = value;
};

// One-off duration events that aren't tied to the session timeline (seeks).
const event = (hash, name, ms, extra) => {
  if (!hash) return;
  console.log(
    `[perf] ${hash.slice(0, 8)} ${name} ${ms}ms` +
      (extra ? ` ${JSON.stringify(extra)}` : ""),
  );
  const r = rec(hash);
  (r.meta.events || (r.meta.events = [])).push({ name, ms, ...extra });
};

// Persist and forget a session (torrent removed/evicted).
const flush = (hash, reason) => {
  const r = recs.get(hash);
  if (!r) return;
  recs.delete(hash);
  const line = JSON.stringify({
    hash,
    at: new Date().toISOString(),
    reason,
    marks: r.marks,
    meta: r.meta,
  });
  fs.appendFile(path.join(DIR, "sessions.jsonl"), line + "\n", () => {});
};

module.exports = { mark, note, event, flush };
