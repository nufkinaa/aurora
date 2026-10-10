// What can be known, and made ready, about a library file BEFORE it is
// played — asked for when its record is (GET /api/item/:id: the title page
// was opened, or a card was dwelt on).
//
//  • indexInfo: for an MP4, where its index (the moov box) sits and how big
//    it is. A browser cannot show a frame of an MP4 until it has that whole
//    box — megabytes for a film — so the player uses the figure to decide
//    whether a thin line is better served the film as a stream (see
//    public/js/screens/player.js, "a long index on a thin line"). A few
//    16-byte reads, remembered per file.
//
//  • warm: for a file the jit stream can serve from its own keyframe index
//    (MKV), the two things its first playlist otherwise waits for — the
//    index read into a segment table, and one ffprobe of the video stream
//    (size, frame rate, level: the quality ladder's facts) — are done now.
//    Measured 2026-10-10: 60–190 ms of a cold start's first request. One at
//    a time, each file once in a while, never queued: if the server is
//    already warming something, this one is simply skipped — the playlist
//    request does the same work as it always did.
"use strict";
const fs = require("fs");
const path = require("path");

const MP4_LIKE = new Set([".mp4", ".m4v", ".mov"]);

// ---------- where an MP4's index is ----------
const places = new Map(); // `${path}:${mtimeMs}` -> { bytes, front } | null
const indexInfo = (filePath) => {
  try {
    if (!MP4_LIKE.has(path.extname(filePath).toLowerCase())) return null;
    const st = fs.statSync(filePath);
    const key = `${filePath}:${Math.floor(st.mtimeMs)}`;
    if (places.has(key)) return places.get(key);
    let out = null;
    const fd = fs.openSync(filePath, "r");
    try {
      const h = Buffer.alloc(16);
      let pos = 0;
      let moov = null;
      let mdatAt = -1;
      let first = null;
      let fragmented = false;
      for (let n = 0; n < 64 && pos + 8 <= st.size; n++) {
        if (fs.readSync(fd, h, 0, 16, pos) < 8) break;
        let size = h.readUInt32BE(0);
        const type = h.toString("latin1", 4, 8);
        if (size === 1) size = Number(h.readBigUInt64BE(8));
        else if (size === 0) size = st.size - pos;
        if (!(size >= 8)) break;
        if (first == null) first = type;
        if (type === "moov" && !moov) moov = { at: pos, size };
        if (type === "mdat" && mdatAt < 0) mdatAt = pos;
        if (type === "moof") fragmented = true;
        pos += size;
      }
      if (first === "ftyp" && moov && !fragmented) out = { bytes: moov.size, front: mdatAt < 0 || moov.at < mdatAt };
    } finally {
      fs.closeSync(fd);
    }
    if (places.size > 2000) places.clear();
    places.set(key, out);
    return out;
  } catch {
    return null;
  }
};

// ---------- the start, warmed ----------
const WARM_AGAIN_MS = 10 * 60 * 1000;
const warmedAt = new Map(); // key -> when
let warming = false;
// seams for the tests
let deps = {
  resolve: (id) => require("../media/scanner").resolve(id),
  jit: () => require("../media/jit"),
  ladder: () => require("../media/ladder"),
  ffmpeg: () => require("../config").ffmpegAvailable,
};

// Resolves "started" | "skipped: <why>" at once; the work itself is not waited for
// (`done`, when given, is called when it finishes — the tests use it).
const warm = (id, done = null) => {
  const skip = (why) => { if (done) done(`skipped: ${why}`); return `skipped: ${why}`; };
  try {
    if (!deps.ffmpeg()) return skip("no ffmpeg");
    if (warming) return skip("busy");
    const entry = deps.resolve(id);
    if (!entry || entry.kind !== "video") return skip("not a video");
    // an MP4's own index is megabytes: it is read when a player asks for the stream, not on a hunch
    if (MP4_LIKE.has(path.extname(entry.path).toLowerCase())) return skip("mp4");
    const st = fs.statSync(entry.path);
    const key = `${id}-${Math.floor(st.mtimeMs)}`;
    const now = Date.now();
    if (now - (warmedAt.get(key) || 0) < WARM_AGAIN_MS) return skip("fresh");
    if (warmedAt.size > 500) warmedAt.clear();
    warmedAt.set(key, now);
    warming = true;
    (async () => {
      const jit = deps.jit();
      const fd = fs.openSync(entry.path, "r");
      try {
        const readRange = async (start, len) => {
          const b = Buffer.alloc(len);
          fs.readSync(fd, b, 0, len, start);
          return b;
        };
        const table = await jit.tableFor(key, readRange, st.size);
        // (no table: jit will not serve this file — nothing more to make ready)
        if (table) await deps.ladder().probe(key, entry.path);
      } finally {
        try { fs.closeSync(fd); } catch {}
      }
    })()
      .catch(() => {})
      .finally(() => { warming = false; if (done) done("done"); });
    return "started";
  } catch {
    return skip("error");
  }
};

module.exports = {
  indexInfo,
  warm,
  _internals: { setDeps: (d) => { deps = { ...deps, ...d }; }, reset: () => { warmedAt.clear(); places.clear(); warming = false; } },
};
