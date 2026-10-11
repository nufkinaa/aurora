// "Faststart", without touching the file: an MP4 whose index (the moov box)
// sits at the END is SERVED as if it sat at the front.
//
// WHY. A player cannot show a frame of an MP4 without its index. When the
// index is at the end — as on half the owner's MP4s (2026-10-10) — a browser
// asks for the start of the file, finds the film's data where it hoped for
// the index, gives that request up, asks for the END of the file, reads the
// index there, and then asks a third time for the data: two extra round
// trips and two fresh connections before anything can play (measured on a
// 180 ms line: 1.84 s to the first frame against 1.32 s for the same film
// with its index in front). ExoPlayer on the TV does the same dance.
//
// What qt-faststart and `ffmpeg -movflags +faststart` do to the file on
// disk — move the moov before the data and add its size to every chunk
// offset inside it — is done here to the BYTES ON THE WIRE instead:
//
//   on disk     ftyp | (free) | mdat ............ | moov
//   as served   ftyp | moov' | (free) | mdat ............
//
// moov' is the file's own moov with each chunk offset (stco / co64) moved
// by the moov's size; everything else is the file's bytes, read from where
// they are. The length is the same, ranges work, nothing is written
// anywhere. The patched index is kept in memory for a few titles at a time.
//
// Refused — the file is then served exactly as it is on disk — when
// anything is not this simple: no moov, moov not the last box, a fragmented
// file, an index over MAX_MOOV_BYTES, a 32-bit offset that the move would
// overflow, or a box that holds file offsets this code does not rewrite.
"use strict";
const fs = require("fs");

const MAX_MOOV_BYTES = 48 * 1024 * 1024;
const KEEP = 6; // patched indexes held at once
const IDLE_MS = 15 * 60 * 1000;

const type4 = (buf, at) => buf.toString("latin1", at, at + 4);

// The path down to the sample tables: only these boxes are opened. (Others —
// user data, metadata — are carried as they are; some writers' are not even
// well-formed boxes inside, and none of the usual ones hold file offsets.)
const CONTAINERS = new Set(["trak", "mdia", "minf", "stbl"]);
// Seen on that path, the file is left alone: boxes that hold absolute file
// offsets this code does not rewrite, and the mark of a fragmented file.
const OFFSET_BOXES = new Set(["saio", "iloc", "tfra", "sidx", "mvex"]);

// Patch every stco / co64 under `buf[from..to)` by `shift`. Returns false when
// the file must be refused.
const patch = (buf, from, to, shift, depth = 0) => {
  let pos = from;
  while (pos + 8 <= to) {
    let size = buf.readUInt32BE(pos);
    const type = type4(buf, pos + 4);
    let head = 8;
    if (size === 1) {
      if (pos + 16 > to) return false;
      const big = buf.readBigUInt64BE(pos + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(big);
      head = 16;
    } else if (size === 0) size = to - pos;
    if (size < head || pos + size > to) return false;
    if (OFFSET_BOXES.has(type)) return false;
    if (type === "stco") {
      const n = buf.readUInt32BE(pos + head + 4);
      if (pos + head + 8 + n * 4 > pos + size) return false;
      for (let i = 0; i < n; i++) {
        const at = pos + head + 8 + i * 4;
        const v = buf.readUInt32BE(at) + shift;
        if (v > 0xffffffff) return false; // would need a 64-bit table: not rewritten here
        buf.writeUInt32BE(v, at);
      }
    } else if (type === "co64") {
      const n = buf.readUInt32BE(pos + head + 4);
      if (pos + head + 8 + n * 8 > pos + size) return false;
      for (let i = 0; i < n; i++) {
        const at = pos + head + 8 + i * 8;
        buf.writeBigUInt64BE(buf.readBigUInt64BE(at) + BigInt(shift), at);
      }
    } else if (CONTAINERS.has(type) && depth < 8) {
      if (!patch(buf, pos + head, pos + size, shift, depth + 1)) return false;
    }
    pos += size;
  }
  return true;
};

// The plan for one file, or null (serve it as it is). SYNC: a few small
// reads and one read of the index, once per file while it is kept.
//   { size, head, moov (Buffer, patched), moovAt (where it sits on disk) }
// The served layout is [0, head) from disk · moov · disk [head, moovAt).
const build = (filePath, fileSize) => {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const h = Buffer.alloc(16);
    let pos = 0;
    const tops = [];
    while (pos + 8 <= fileSize && tops.length < 64) {
      if (fs.readSync(fd, h, 0, 16, pos) < 8) return null;
      let size = h.readUInt32BE(0);
      const type = type4(h, 4);
      if (size === 1) {
        const big = h.readBigUInt64BE(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(big);
      } else if (size === 0) size = fileSize - pos;
      if (size < 8 || pos + size > fileSize) return null;
      tops.push({ type, at: pos, size });
      pos += size;
    }
    if (pos !== fileSize) return null; // trailing bytes that are not a box
    if (!tops.length || tops[0].type !== "ftyp") return null;
    if (tops.some((b) => b.type === "moof" || b.type === "sidx" || b.type === "mfra")) return null;
    const moovs = tops.filter((b) => b.type === "moov");
    const mdats = tops.filter((b) => b.type === "mdat");
    if (moovs.length !== 1 || !mdats.length) return null;
    const mv = moovs[0];
    // already in front: nothing to do. Not the LAST box: not the simple case.
    if (mv.at < mdats[0].at) return null;
    if (tops[tops.length - 1] !== mv) return null;
    if (mv.size > MAX_MOOV_BYTES) return null;
    const head = tops[0].size; // the moov goes right after ftyp
    const moov = Buffer.alloc(mv.size);
    if (fs.readSync(fd, moov, 0, mv.size, mv.at) !== mv.size) return null;
    if (type4(moov, 4) !== "moov") return null;
    if (!patch(moov, 8, moov.length, mv.size)) return null;
    return { size: fileSize, head, moov, moovAt: mv.at };
  } catch {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
};

// ---------- the few that are kept ----------
const plans = new Map(); // `${path}:${mtimeMs}:${size}` -> { plan | null, at }
const planFor = (filePath, stat) => {
  if (!/\.(mp4|m4v|mov)$/i.test(filePath)) return null;
  const key = `${filePath}:${Math.floor(stat.mtimeMs)}:${stat.size}`;
  const now = Date.now();
  const hit = plans.get(key);
  if (hit) {
    hit.at = now;
    return hit.plan;
  }
  const plan = build(filePath, stat.size);
  plans.set(key, { plan, at: now });
  // the oldest patched indexes go first; a "no" costs nothing to keep
  const held = [...plans].filter(([, v]) => v.plan).sort((a, b) => a[1].at - b[1].at);
  while (held.length > KEEP) plans.delete(held.shift()[0]);
  if (plans.size > 500) for (const [k, v] of plans) if (!v.plan) plans.delete(k);
  return plan;
};
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of plans) if (v.plan && now - v.at > IDLE_MS) plans.delete(k);
}, 60000).unref?.();

// The pieces that make up served bytes [start, end] (inclusive) of a plan:
// [{ buf, from, to }] (a slice of the patched index) or
// [{ file: true, from, to }] (bytes of the file on disk, inclusive). PURE.
const pieces = (plan, start, end) => {
  const out = [];
  const M = plan.moov.length;
  const add = (a, b, make) => { if (a <= b) out.push(make(a, b)); };
  // [0, head): the file's own start
  add(Math.max(start, 0), Math.min(end, plan.head - 1), (a, b) => ({ file: true, from: a, to: b }));
  // [head, head + M): the patched index
  add(Math.max(start, plan.head), Math.min(end, plan.head + M - 1), (a, b) => ({ buf: plan.moov, from: a - plan.head, to: b - plan.head }));
  // [head + M, size): the file from `head` up to where its index was
  add(Math.max(start, plan.head + M), Math.min(end, plan.size - 1), (a, b) => ({ file: true, from: a - M, to: b - M }));
  return out;
};

// Write served bytes [start, end] of a plan to `res`, in order; honours
// back-pressure and a client that goes away. `onError`: a read failed.
const pipe = (filePath, plan, start, end, res, onError) => {
  const list = pieces(plan, start, end);
  let current = null;
  let closed = false;
  res.on("close", () => {
    closed = true;
    if (current) current.destroy();
  });
  const next = () => {
    if (closed) return;
    const p = list.shift();
    if (!p) return res.end();
    if (p.buf) {
      const ok = res.write(p.buf.subarray(p.from, p.to + 1));
      return ok ? next() : res.once("drain", next);
    }
    current = fs.createReadStream(filePath, { start: p.from, end: p.to });
    current.on("error", (e) => { if (!closed) onError(e); });
    current.on("end", () => { current = null; next(); });
    current.pipe(res, { end: false });
  };
  next();
};

module.exports = { planFor, pieces, pipe, _internals: { build, patch, plans, MAX_MOOV_BYTES, KEEP } };
