// MP4 index reader: the exact total duration and the keyframe map of an
// MP4 / M4V / MOV file, read from its own `moov` box — the same thing
// mkvindex.js reads from a Matroska file's Cues, in the same shape, so the
// jit full-timeline stream (jit.js) can serve MP4s too.
//
// WHY. An MP4 plays in a browser as the file itself — after the browser has
// the WHOLE index: every sample's size, time and place, 2–5 MB for a film
// (measured 2026-10-10 on the owner's library: 2.5 MB for an hour). On a
// home LAN that is nothing. On a 3 Mbit/s line it is seven seconds of
// download before the first frame, and at the END of the file — as half of
// those MP4s have it — two more round trips to find it. The same film as an
// HLS stream starts on a playlist of a few kB and the first few hundred kB
// of a segment. So on a thin line an MP4 is better played through jit — and
// jit needs to know where its keyframes are.
//
// What is read: the first VIDEO track's sync-sample table (stss), its sample
// times (stts + ctts) and its edit list (elst) — the presentation time of
// every keyframe exactly as ffmpeg's demuxer will report it, which is what
// jit checks every segment boundary against — and the file offset of each
// of those samples (stsc + stsz + stco/co64), for the bitrate figures.
//
// Paranoid like its sibling: any structural surprise (a fragmented file, an
// edit list that is more than a start offset, a table that does not add up)
// returns null and the caller carries on without jit. And nothing read here
// is ever trusted on its own — jit publishes a segment only when a real
// keyframe sits on each of its declared boundaries (jit.js, "the contract").
//
// I/O is `readRange(start, length) -> Promise<Buffer>`, as in mkvindex.js.
"use strict";

const MAX_MOOV_BYTES = 96 * 1024 * 1024; // a 12-hour recording's index is ~40 MB
const MAX_TOP_BOXES = 64;
const MAX_SAMPLES = 4 * 1000 * 1000;

const type4 = (buf, at) => buf.toString("latin1", at, at + 4);

// The children of a box held in `buf` between `from` and `to`:
// [{ type, start (of the payload), end }].
const children = (buf, from, to) => {
  const out = [];
  let pos = from;
  while (pos + 8 <= to) {
    let size = buf.readUInt32BE(pos);
    const type = type4(buf, pos + 4);
    let head = 8;
    if (size === 1) {
      if (pos + 16 > to) break;
      const big = buf.readBigUInt64BE(pos + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      head = 16;
    } else if (size === 0) size = to - pos; // "to the end"
    if (size < head || pos + size > to) break;
    out.push({ type, start: pos + head, end: pos + size });
    pos += size;
  }
  return out;
};
const child = (buf, box, type) => children(buf, box.start, box.end).find((b) => b.type === type) || null;

// Where the top-level boxes are: [{ type, at, size }], read header by header.
const topBoxes = async (readRange, fileSize) => {
  const out = [];
  let pos = 0;
  while (pos + 8 <= fileSize && out.length < MAX_TOP_BOXES) {
    const h = await readRange(pos, Math.min(16, fileSize - pos));
    if (!h || h.length < 8) break;
    let size = h.readUInt32BE(0);
    const type = type4(h, 4);
    if (size === 1) {
      if (h.length < 16) break;
      const big = h.readBigUInt64BE(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
    } else if (size === 0) size = fileSize - pos;
    if (size < 8) break;
    out.push({ type, at: pos, size });
    pos += size;
  }
  return out;
};

// version + flags, then the fields: a "full box" payload reader.
const full = (buf, box) => ({ version: buf[box.start], at: box.start + 4 });

// One track's tables, or null when it is not a usable video track.
const readTrack = (moov, trak) => {
  const mdia = child(moov, trak, "mdia");
  if (!mdia) return null;
  const hdlr = child(moov, mdia, "hdlr");
  if (!hdlr || hdlr.end - hdlr.start < 12 || type4(moov, hdlr.start + 8) !== "vide") return null;
  const mdhd = child(moov, mdia, "mdhd");
  const minf = child(moov, mdia, "minf");
  const stbl = minf && child(moov, minf, "stbl");
  if (!mdhd || !stbl) return null;
  const h = full(moov, mdhd);
  const timescale = h.version === 1 ? moov.readUInt32BE(h.at + 16) : moov.readUInt32BE(h.at + 8);
  if (!(timescale > 0)) return null;
  const box = (t) => child(moov, stbl, t);
  const stts = box("stts");
  const stsc = box("stsc");
  const stsz = box("stsz");
  const stco = box("stco");
  const co64 = box("co64");
  if (!stts || !stsc || !stsz || !(stco || co64)) return null; // (stz2: compact sizes — not seen in the wild for video)
  // The edit list: only "start here" is understood — an optional empty edit
  // (a delay before the picture starts), then ONE edit that plays the track
  // from a media time to its end. Anything else is another film.
  let mediaStart = 0; // media time (track timescale) shown at presentation time `delay`
  let delay = 0; // seconds of empty edit before it
  const edts = child(moov, trak, "edts");
  const elst = edts && child(moov, edts, "elst");
  if (elst) {
    const e = full(moov, elst);
    const n = moov.readUInt32BE(e.at);
    const entries = [];
    let p = e.at + 4;
    for (let i = 0; i < n; i++) {
      if (e.version === 1) {
        if (p + 20 > elst.end) return null;
        entries.push({ dur: Number(moov.readBigUInt64BE(p)), time: Number(moov.readBigInt64BE(p + 8)), rate: moov.readInt16BE(p + 16) });
        p += 20;
      } else {
        if (p + 12 > elst.end) return null;
        entries.push({ dur: moov.readUInt32BE(p), time: moov.readInt32BE(p + 4), rate: moov.readInt16BE(p + 8) });
        p += 12;
      }
    }
    let list = entries;
    let empty = 0;
    if (list.length && list[0].time === -1) { empty = list[0].dur; list = list.slice(1); }
    if (list.length > 1) return null;
    if (list.length === 1) {
      if (list[0].time < 0 || list[0].rate !== 1) return null;
      mediaStart = list[0].time;
    }
    delay = empty; // in MOVIE timescale — scaled by the caller
  }
  return { timescale, stts, ctts: box("ctts"), stss: box("stss"), stsc, stsz, stco, co64, mediaStart, delayMovie: delay };
};

const parseMp4Index = async (readRange, fileSize) => {
  try {
    if (!(fileSize > 16)) return null;
    const tops = await topBoxes(readRange, fileSize);
    if (!tops.length || tops[0].type !== "ftyp") return null;
    const mv = tops.find((b) => b.type === "moov");
    if (!mv || mv.size > MAX_MOOV_BYTES || mv.at + mv.size > fileSize) return null;
    // fragmented files keep their samples in moof boxes: not this reader's
    if (tops.some((b) => b.type === "moof")) return null;
    const mdat = tops.find((b) => b.type === "mdat");
    const moov = await readRange(mv.at, mv.size);
    if (!moov || moov.length < mv.size) return null;
    const root = { start: 8, end: moov.length };
    const kids = children(moov, root.start, root.end);
    if (kids.some((b) => b.type === "mvex")) return null;
    const mvhd = kids.find((b) => b.type === "mvhd");
    if (!mvhd) return null;
    const mh = full(moov, mvhd);
    const movieScale = mh.version === 1 ? moov.readUInt32BE(mh.at + 16) : moov.readUInt32BE(mh.at + 8);
    const movieDur = mh.version === 1 ? Number(moov.readBigUInt64BE(mh.at + 20)) : moov.readUInt32BE(mh.at + 12);
    if (!(movieScale > 0)) return null;

    // the first video track, in the file's own order (ffmpeg's 0:v:0)
    let tr = null;
    for (const t of kids) {
      if (t.type !== "trak") continue;
      tr = readTrack(moov, t);
      if (tr) break;
    }
    if (!tr) return null;

    // ---- every sample's decode time, composition offset, size and place ----
    const u32 = (at) => moov.readUInt32BE(at);
    // stsz: one size for all, or a table
    const z = full(moov, tr.stsz);
    const uniform = u32(z.at);
    const count = u32(z.at + 4);
    if (!(count > 0) || count > MAX_SAMPLES) return null;
    if (!uniform && z.at + 8 + count * 4 > tr.stsz.end) return null;
    const sizeOf = (i) => (uniform ? uniform : u32(z.at + 8 + i * 4));
    // stss: the sync samples (1-based); none = every sample is one
    let sync = null;
    if (tr.stss) {
      const s = full(moov, tr.stss);
      const n = u32(s.at);
      if (s.at + 4 + n * 4 > tr.stss.end) return null;
      sync = new Array(n);
      for (let i = 0; i < n; i++) sync[i] = u32(s.at + 4 + i * 4) - 1;
    }
    // stts: (count, delta) runs → dts of each sample we care about
    const t = full(moov, tr.stts);
    const tRuns = u32(t.at);
    if (t.at + 4 + tRuns * 8 > tr.stts.end) return null;
    // ctts: (count, offset) runs; version 1 offsets are signed, and writers
    // put signed values in version 0 too (ffmpeg reads them as signed: so do we)
    let c = null;
    let cRuns = 0;
    if (tr.ctts) {
      c = full(moov, tr.ctts);
      cRuns = u32(c.at);
      if (c.at + 4 + cRuns * 8 > tr.ctts.end) return null;
    }
    // stsc: (first_chunk, samples_per_chunk, desc) runs; stco/co64: chunk offsets
    const sc = full(moov, tr.stsc);
    const scRuns = u32(sc.at);
    if (!(scRuns > 0) || sc.at + 4 + scRuns * 12 > tr.stsc.end) return null;
    const co = full(moov, tr.co64 || tr.stco);
    const chunks = u32(co.at);
    const wide = !!tr.co64;
    if (!(chunks > 0) || co.at + 4 + chunks * (wide ? 8 : 4) > (tr.co64 || tr.stco).end) return null;
    const chunkAt = (k) => (wide ? Number(moov.readBigUInt64BE(co.at + 4 + k * 8)) : u32(co.at + 4 + k * 4));

    // One pass over the samples, keeping what the sync samples need.
    const wanted = sync ? new Set(sync) : null;
    const keys = []; // { pts (track timescale), offset }
    let dts = 0;
    let ti = 0;
    let tLeft = tRuns ? u32(t.at + 4) : 0;
    let tDelta = tRuns ? u32(t.at + 8) : 0;
    let ci = 0;
    let cLeft = cRuns ? u32(c.at + 4) : 0;
    let cOff = cRuns ? moov.readInt32BE(c.at + 8) : 0;
    let si = 0; // stsc run
    let chunk = 0; // 0-based chunk index
    let inChunk = 0; // samples already taken from this chunk
    let perChunk = u32(sc.at + 4 + 4);
    let nextRunChunk = scRuns > 1 ? u32(sc.at + 4 + 12) - 1 : Infinity;
    let off = chunkAt(0);
    let lastEnd = 0; // dts + delta of the last sample
    for (let i = 0; i < count; i++) {
      if (!wanted || wanted.has(i)) keys.push({ pts: dts + cOff, offset: off });
      // advance time
      lastEnd = dts + tDelta;
      dts += tDelta;
      if (--tLeft <= 0 && i + 1 < count) {
        ti++;
        if (ti >= tRuns) return null; // the time table ends before the samples do
        tLeft = u32(t.at + 4 + ti * 8);
        tDelta = u32(t.at + 8 + ti * 8);
      }
      if (cRuns && --cLeft <= 0) {
        ci++;
        if (ci < cRuns) {
          cLeft = u32(c.at + 4 + ci * 8);
          cOff = moov.readInt32BE(c.at + 8 + ci * 8);
        } else {
          cLeft = Infinity; // (a short table: the rest have no offset)
          cOff = 0;
        }
      }
      // advance place
      off += sizeOf(i);
      if (++inChunk >= perChunk && i + 1 < count) {
        chunk++;
        inChunk = 0;
        if (chunk >= chunks) return null; // more samples than the chunks hold
        if (chunk >= nextRunChunk) {
          si++;
          perChunk = u32(sc.at + 4 + si * 12 + 4);
          nextRunChunk = si + 1 < scRuns ? u32(sc.at + 4 + (si + 1) * 12) - 1 : Infinity;
        }
        if (!(perChunk > 0)) return null;
        off = chunkAt(chunk);
      }
    }
    if (keys.length < 2) return null;

    // ---- presentation times, as ffmpeg's demuxer reports them ----
    // The edit list moves the track so that media time `mediaStart` is shown
    // at `delay`; with no edit list the times are the file's own.
    const delaySec = tr.delayMovie / movieScale;
    const cues = [];
    for (const k of keys) {
      const sec = (k.pts - tr.mediaStart) / tr.timescale + delaySec;
      // (a keyframe before the edit's start is not part of the film)
      if (sec < -0.0005) continue;
      cues.push({ t: Math.max(0, sec), offset: k.offset });
    }
    cues.sort((a, b) => a.t - b.t);
    const unique = cues.filter((p, i) => i === 0 || p.t > cues[i - 1].t);
    if (unique.length < 2) return null;
    // The film's length: the movie header's, never shorter than the video
    // track runs (some writers leave the header at 0).
    const trackEnd = (lastEnd - tr.mediaStart) / tr.timescale + delaySec;
    const durationSec = Math.max(movieDur / movieScale, trackEnd);
    if (!(durationSec > 0) || durationSec < unique[unique.length - 1].t) return null;
    return {
      durationSec,
      cues: unique,
      samples: count,
      // where the index sits, for whoever decides how the file is best played
      moov: { at: mv.at, size: mv.size, front: !mdat || mv.at < mdat.at },
    };
  } catch {
    return null;
  }
};

// Just "where is the index and how big": a few 16-byte reads, no parsing of
// the tables. For the library scan (the player decides by it whether a thin
// line is better served a stream than the file itself). null = not an MP4.
const moovPlace = async (readRange, fileSize) => {
  try {
    const tops = await topBoxes(readRange, fileSize);
    if (!tops.length || tops[0].type !== "ftyp") return null;
    const mv = tops.find((b) => b.type === "moov");
    if (!mv) return null;
    const mdat = tops.find((b) => b.type === "mdat");
    return { size: mv.size, front: !mdat || mv.at < mdat.at, fragmented: tops.some((b) => b.type === "moof") };
  } catch {
    return null;
  }
};

module.exports = { parseMp4Index, moovPlace };
