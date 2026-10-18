// Serving a library file's bytes the way HTTP says to (RFC 9110 §13–14):
// the pieces /stream/video uses, kept pure where they can be.
//
//  • Range: one range of bytes (a-b, a-, -n). Anything the server cannot
//    read as a byte range is IGNORED (the whole file, 200) — it used to be a
//    206 of the whole file. A range that starts past the end is 416 with
//    Content-Range: bytes */size. Several ranges at once: the first is
//    served (no player asks for more; a multipart answer helps nobody).
//  • Validators: a strong ETag from the file's size and modification time
//    (and whether the index is served in front — media/faststart.js — since
//    that is different bytes), and Last-Modified. If-Range with either one
//    that no longer matches means "the file changed: send it all" (200).
//    If-None-Match / If-Modified-Since on a plain GET answer 304.
//  • The file's facts are looked up once per STAT_TTL_MS per file, not on
//    every request — a player asks for ranges many times a minute, and a
//    synchronous stat on the event loop is a disk seek on a sleeping disk.
//  • A response whose client has stopped taking bytes for STALL_MS (a dead
//    connection that TCP has not noticed, a device that went to sleep with
//    the film open) is closed: its file handle and buffers go back. A paused
//    player holds its connection for less than that, and a <video> element
//    asks again with a Range when it resumes.
"use strict";
const fs = require("fs");

// ---------- Range ----------
// → { none: true } | { unsatisfiable: true } | { start, end } (inclusive)
const parseRange = (header, total) => {
  if (header == null || header === "") return { none: true };
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(String(header));
  if (!m) return { none: true };
  const first = m[1].split(",")[0].trim();
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(first);
  if (!r || (r[1] === "" && r[2] === "")) return { none: true };
  if (r[1] === "") {
    // the last N bytes
    const n = parseInt(r[2], 10);
    if (!(n > 0) || total === 0) return { unsatisfiable: true };
    return { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = parseInt(r[1], 10);
  let end = r[2] === "" ? total - 1 : parseInt(r[2], 10);
  if (r[2] !== "" && end < start) return { none: true }; // invalid: ignored (RFC 9110 §14.1.1)
  if (start >= total) return { unsatisfiable: true };
  if (end >= total) end = total - 1;
  return { start, end };
};

// ---------- validators ----------
const etagOf = (st, variant = "") => `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${variant ? `-${variant}` : ""}"`;
const lastModifiedOf = (st) => new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();

// Does If-Range allow the Range to be honoured? (absent: yes)
const ifRangeOk = (headers, etag, lastModified) => {
  const v = headers["if-range"];
  if (!v) return true;
  const s = String(v).trim();
  if (s.startsWith('"') || s.startsWith("W/")) return s === etag; // strong comparison only
  return s === lastModified;
};

// A plain GET the client already holds: 304.
const notModified = (headers, etag, st) => {
  const inm = headers["if-none-match"];
  if (inm) {
    const tags = String(inm).split(",").map((t) => t.trim().replace(/^W\//, ""));
    return tags.includes("*") || tags.includes(etag);
  }
  const ims = headers["if-modified-since"];
  if (ims) {
    const t = Date.parse(ims);
    return Number.isFinite(t) && Math.floor(st.mtimeMs / 1000) * 1000 <= t;
  }
  return false;
};

// ---------- the file's facts, kept briefly ----------
const STAT_TTL_MS = 2000;
const STAT_MAX = 500;
const stats = new Map(); // path -> { st, at }
const statOf = (file, now = Date.now()) => {
  const hit = stats.get(file);
  if (hit && now - hit.at < STAT_TTL_MS) return hit.st;
  let st = null;
  try {
    st = fs.statSync(file);
    if (!st.isFile()) st = null;
  } catch {}
  if (!st) {
    stats.delete(file);
    return null;
  }
  if (stats.size >= STAT_MAX) stats.delete(stats.keys().next().value);
  stats.delete(file);
  stats.set(file, { st, at: now });
  return st;
};
const forgetStat = (file) => stats.delete(file);

// ---------- clients that stopped reading ----------
const STALL_MS = 10 * 60 * 1000;
const SWEEP_MS = 30 * 1000;
const watched = new Set(); // { res, written, at }
let sweeper = null;
let closedStalled = 0;
const sweep = (now = Date.now(), stallMs = STALL_MS) => {
  let n = 0;
  for (const w of watched) {
    const sock = w.res.socket;
    if (!sock || sock.destroyed || w.res.writableEnded) { watched.delete(w); continue; }
    const written = sock.bytesWritten;
    if (written !== w.written) { w.written = written; w.at = now; continue; }
    if (now - w.at >= stallMs) {
      watched.delete(w);
      closedStalled++;
      n++;
      try { sock.destroy(); } catch {}
    }
  }
  if (!watched.size && sweeper) { clearInterval(sweeper); sweeper = null; }
  return n;
};
const watch = (res) => {
  const w = { res, written: -1, at: Date.now() };
  watched.add(w);
  res.on("close", () => watched.delete(w));
  if (!sweeper) {
    sweeper = setInterval(() => sweep(), SWEEP_MS);
    if (sweeper.unref) sweeper.unref();
  }
};

const counters = () => ({ open: watched.size, closedStalled });

module.exports = {
  parseRange, etagOf, lastModifiedOf, ifRangeOk, notModified, statOf, forgetStat, watch, counters,
  STAT_TTL_MS, STALL_MS,
  _internals: { sweep, watched, stats },
};
