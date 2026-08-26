// MKV index reader (S7): the exact total duration and the keyframe map of a
// Matroska file, read from its own bytes — the head (EBML header, SeekHead,
// Info) plus the Cues the SeekHead points at (usually the file's tail).
// This is what lets a still-downloading stream declare a COMPLETE, truthful
// VOD playlist up front: duration from Info, segment boundaries from Cues.
//
// The reader is deliberately paranoid: any structural surprise returns null
// and the caller falls back to today's event-playlist behavior — failure
// can only ever mean "no better than before".
//
// I/O is abstracted as `readRange(start, length) -> Promise<Buffer>` so the
// same parser serves fs files (library) and webtorrent files (streams).

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEKHEAD = 0x114d9b74;
const INFO = 0x1549a966;
const CUES = 0x1c53bb6b;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const SEEK_POSITION = 0x53ac;
const TIMESTAMP_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_CLUSTER_POSITION = 0xf1;

// EBML varint. IDs keep their marker bit; sizes strip it.
const readVint = (buf, pos, keepMarker) => {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first === 0) return null;
  let len = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) {
    len++;
    if (len > 8) return null;
  }
  if (pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  return { value, length: len };
};

// Walk children of a master element in `buf`, calling visit(id, start, size).
// visit returns false to stop early.
const walk = (buf, from, to, visit) => {
  let pos = from;
  while (pos < to) {
    const id = readVint(buf, pos, true);
    if (!id) return;
    const size = readVint(buf, pos + id.length, false);
    if (!size) return;
    const dataStart = pos + id.length + size.length;
    if (visit(id.value, dataStart, size.value) === false) return;
    pos = dataStart + size.value;
  }
};

const readFloat = (buf, start, size) =>
  size === 4 ? buf.readFloatBE(start) : size === 8 ? buf.readDoubleBE(start) : null;
const readUint = (buf, start, size) => {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[start + i];
  return v;
};

const HEAD_BYTES = 64 * 1024;
const MAX_CUES_BYTES = 8 * 1024 * 1024; // Cues run ~0.1-2MB even on long films

const parseMkvIndex = async (readRange, fileSize) => {
  try {
    const head = await readRange(0, Math.min(HEAD_BYTES, fileSize));

    // EBML header, then the Segment.
    const ebml = readVint(head, 0, true);
    if (!ebml || ebml.value !== EBML_HEADER) return null;
    const ebmlSize = readVint(head, ebml.length, false);
    if (!ebmlSize) return null;
    let pos = ebml.length + ebmlSize.length + ebmlSize.value;
    const seg = readVint(head, pos, true);
    if (!seg || seg.value !== SEGMENT) return null;
    const segSize = readVint(head, pos + seg.length, false);
    if (!segSize) return null;
    // All SeekPosition values are relative to the segment DATA start.
    const segStart = pos + seg.length + segSize.length;

    let timescale = 1_000_000; // MKV default: timestamps in ms
    let durationTicks = null;
    let cuesOffset = null; // absolute file offset of the Cues element

    walk(head, segStart, head.length, (id, start, size) => {
      if (id === SEEKHEAD && start + size <= head.length) {
        walk(head, start, start + size, (sid, sstart, ssize) => {
          if (sid !== SEEK) return;
          let targetId = null;
          let targetPos = null;
          walk(head, sstart, sstart + ssize, (eid, estart, esize) => {
            if (eid === SEEK_ID) targetId = readUint(head, estart, esize);
            if (eid === SEEK_POSITION) targetPos = readUint(head, estart, esize);
          });
          if (targetId === CUES && targetPos != null) cuesOffset = segStart + targetPos;
        });
      } else if (id === INFO && start + size <= head.length) {
        walk(head, start, start + size, (iid, istart, isize) => {
          if (iid === TIMESTAMP_SCALE) timescale = readUint(head, istart, isize);
          if (iid === DURATION) durationTicks = readFloat(head, istart, isize) ?? readUint(head, istart, isize);
        });
      }
      // Clusters begin: nothing else useful lives in the head past them.
      return id !== 0x1f43b675;
    });

    if (durationTicks == null || cuesOffset == null || cuesOffset >= fileSize) return null;
    const durationSec = (durationTicks * timescale) / 1e9;
    if (!(durationSec > 0)) return null;

    // The Cues element: ID + size live at cuesOffset.
    const cuesHead = await readRange(cuesOffset, Math.min(64, fileSize - cuesOffset));
    const cid = readVint(cuesHead, 0, true);
    if (!cid || cid.value !== CUES) return null;
    const csize = readVint(cuesHead, cid.length, false);
    if (!csize || csize.value > MAX_CUES_BYTES) return null;
    const cuesDataStart = cuesOffset + cid.length + csize.length;
    const cues = await readRange(cuesDataStart, csize.value);

    const points = [];
    walk(cues, 0, cues.length, (id, start, size) => {
      if (id !== CUE_POINT) return;
      let t = null;
      let cluster = null;
      walk(cues, start, start + size, (pid, pstart, psize) => {
        if (pid === CUE_TIME) t = readUint(cues, pstart, psize);
        if (pid === CUE_TRACK_POSITIONS) {
          walk(cues, pstart, pstart + psize, (tid, tstart, tsize) => {
            if (tid === CUE_CLUSTER_POSITION) cluster = readUint(cues, tstart, tsize);
          });
        }
      });
      if (t != null && cluster != null) {
        points.push({ t: (t * timescale) / 1e9, offset: segStart + cluster });
      }
    });
    if (points.length < 2) return null;
    points.sort((a, b) => a.t - b.t);
    return { durationSec, cues: points };
  } catch {
    return null;
  }
};

module.exports = { parseMkvIndex };
