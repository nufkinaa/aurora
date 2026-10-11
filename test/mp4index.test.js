// The MP4 index reader (src/media/mp4index.js): the keyframe map of an MP4,
// read from its moov box, for the jit full-timeline stream.
//  • what it refuses (junk, a truncated file, a fragmented file, an edit list
//    that is more than a start offset) — always null, never a throw;
//  • the real thing, when ffmpeg is on the machine: for MP4s written every
//    way ffmpeg writes them (B-frames with an edit list, without one, with
//    negative composition offsets, no B-frames, the index at the front or at
//    the end, a 64-bit offset table) the keyframe TIMES are the ones ffprobe
//    reports, to the millisecond, and the OFFSETS are where those packets are;
//  • and jit itself: an MP4's stream is made segment for segment with every
//    boundary on a real keyframe (jit's own check), from the top and from a seek.
//      node --test test/mp4index.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const config = require("../src/config");
const { parseMp4Index, moovPlace } = require("../src/media/mp4index");
const jit = require("../src/media/jit");
const J = jit._internals;

const bufferRange = (buf) => async (start, len) => buf.subarray(start, Math.min(buf.length, start + len));

// ---------- what it refuses ----------
test("not an MP4: null (junk, empty, a Matroska file's first bytes)", async () => {
  const junk = Buffer.alloc(4096, 0x41);
  assert.equal(await parseMp4Index(bufferRange(junk), junk.length), null);
  assert.equal(await parseMp4Index(bufferRange(Buffer.alloc(0)), 0), null);
  const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200)]);
  assert.equal(await parseMp4Index(bufferRange(mkv), mkv.length), null);
  assert.equal(await moovPlace(bufferRange(junk), junk.length), null);
});

test("a reader that throws, or hands back less than was asked: null", async () => {
  const boom = async () => { throw new Error("disk gone"); };
  assert.equal(await parseMp4Index(boom, 12345), null);
  const short = async () => Buffer.alloc(3);
  assert.equal(await parseMp4Index(short, 12345), null);
});

const box = (type, ...payload) => {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};

test("an MP4 with no moov, or with nothing in it: null", async () => {
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isom"));
  const a = Buffer.concat([ftyp, box("mdat", Buffer.alloc(64))]);
  assert.equal(await parseMp4Index(bufferRange(a), a.length), null);
  const b = Buffer.concat([ftyp, box("moov", box("mvhd", Buffer.alloc(100)))]);
  assert.equal(await parseMp4Index(bufferRange(b), b.length), null);
  // a moov that claims to run past the end of the file
  const lie = Buffer.concat([ftyp, box("moov", Buffer.alloc(16))]);
  lie.writeUInt32BE(1 << 20, ftyp.length);
  assert.equal(await parseMp4Index(bufferRange(lie), lie.length), null);
});

test("moovPlace: where the index is and how big, without reading it", async () => {
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isom"));
  const moov = box("moov", Buffer.alloc(300));
  const mdat = box("mdat", Buffer.alloc(1000));
  const front = Buffer.concat([ftyp, moov, mdat]);
  const tail = Buffer.concat([ftyp, box("free"), mdat, moov]);
  assert.deepEqual(await moovPlace(bufferRange(front), front.length), { size: 308, front: true, fragmented: false });
  assert.deepEqual(await moovPlace(bufferRange(tail), tail.length), { size: 308, front: false, fragmented: false });
  const frag = Buffer.concat([ftyp, moov, box("moof", Buffer.alloc(40)), mdat]);
  assert.equal((await moovPlace(bufferRange(frag), frag.length)).fragmented, true);
  assert.equal(await parseMp4Index(bufferRange(frag), frag.length), null, "a fragmented file is not this reader's");
});

// ---------- a hand-made index: the tables, one at a time ----------
const u32 = (...n) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n), 0); return b; };
const fullBox = (type, version, ...payload) => box(type, Buffer.from([version, 0, 0, 0]), ...payload);
// A film of `n` video samples of `delta` ticks each at `scale` ticks a second.
//   sync      the keyframes (0-based sample numbers)
//   ctts      [[count, offset], …] or null
//   elst      [[duration (movie ticks), media time, rate], …] or null
//   sizes     one number (every sample that size) or a list
//   chunks    [[first chunk (1-based), samples per chunk], …]
//   offsets   where each chunk starts
//   wide      64-bit chunk offsets (co64)
const mkFilm = ({ n = 240, delta = 1000, scale = 24000, movieScale = 1000, sync = [0, 48, 96, 144, 192], ctts = null, elst = null, sizes = 100, chunks = [[1, 24]], offsets = null, wide = false, handler = "vide", extraTrakFirst = null, mvex = false } = {}) => {
  const perChunk = chunks[0][1];
  const nChunks = Math.ceil(n / perChunk);
  const offs = offsets || Array.from({ length: nChunks }, (_, k) => 5000 + k * 10000);
  const stbl = box("stbl",
    fullBox("stts", 0, u32(1, n, delta)),
    ...(ctts ? [fullBox("ctts", 0, u32(ctts.length), ...ctts.map(([c, o]) => Buffer.concat([u32(c), i32(o)])))] : []),
    ...(sync ? [fullBox("stss", 0, u32(sync.length, ...sync.map((s) => s + 1)))] : []),
    fullBox("stsc", 0, u32(chunks.length), ...chunks.map(([first, per]) => u32(first, per, 1))),
    Array.isArray(sizes) ? fullBox("stsz", 0, u32(0, n, ...sizes)) : fullBox("stsz", 0, u32(sizes, n)),
    wide ? fullBox("co64", 0, u32(offs.length), ...offs.map(u64)) : fullBox("stco", 0, u32(offs.length, ...offs)),
  );
  const trak = (h) => box("trak",
    fullBox("tkhd", 0, Buffer.alloc(80)),
    ...(elst && h === handler ? [box("edts", fullBox("elst", 0, u32(elst.length), ...elst.map(([d, t, r]) => Buffer.concat([u32(d), i32(t), Buffer.from([0, r, 0, 0])]))))] : []),
    box("mdia",
      fullBox("mdhd", 0, u32(0, 0, scale, n * delta), Buffer.alloc(4)),
      fullBox("hdlr", 0, u32(0), Buffer.from(h, "latin1"), Buffer.alloc(12)),
      box("minf", stbl)));
  const moov = box("moov",
    fullBox("mvhd", 0, u32(0, 0, movieScale, Math.round((n * delta * movieScale) / scale)), Buffer.alloc(80)),
    ...(extraTrakFirst ? [trak(extraTrakFirst)] : []),
    trak(handler),
    ...(mvex ? [box("mvex", Buffer.alloc(8))] : []));
  const buf = Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), moov, box("mdat", Buffer.alloc(64))]);
  return { buf, offs };
};
const read = (film) => parseMp4Index(bufferRange(film.buf), film.buf.length);

test("a hand-made film: the keyframes' times and places come out of the tables", async () => {
  const index = await read(mkFilm());
  assert.ok(index);
  // 240 samples of 1000 ticks at 24000: a keyframe every 48 samples = every 2 s
  assert.deepEqual(index.cues.map((c) => c.t), [0, 2, 4, 6, 8]);
  // 24 samples of 100 bytes a chunk, chunks 10000 apart from 5000: sample 48 opens chunk 2
  assert.deepEqual(index.cues.map((c) => c.offset), [5000, 25000, 45000, 65000, 85000]);
  assert.equal(index.durationSec, 10);
  assert.equal(index.samples, 240);
  assert.equal(index.moov.front, true);
});

test("a keyframe in the middle of a chunk is found by the sizes before it; sizes may be a table", async () => {
  const sizes = Array.from({ length: 240 }, (_, i) => 50 + (i % 7));
  const film = mkFilm({ sync: [0, 5, 30, 239], sizes });
  const index = await read(film);
  const within = (i) => sizes.slice(Math.floor(i / 24) * 24, i).reduce((a, b) => a + b, 0);
  assert.deepEqual(index.cues.map((c) => c.offset), [0, 5, 30, 239].map((i) => film.offs[Math.floor(i / 24)] + within(i)));
});

test("chunks of different lengths (several stsc runs), and 64-bit offsets", async () => {
  // chunks 1–2 hold 10 samples each, chunk 3 onward 55 each: 20 + 4×55 = 240
  const offs = [1000, 9000, 6_000_000_000, 6_000_100_000, 6_000_200_000, 6_000_300_000];
  const index = await read(mkFilm({ sync: [0, 10, 20, 75, 239], chunks: [[1, 10], [3, 55]], offsets: offs, wide: true }));
  assert.ok(index);
  assert.deepEqual(index.cues.map((c) => c.offset), [1000, 9000, 6_000_000_000, 6_000_100_000, 6_000_300_000 + 54 * 100]);
});

test("composition offsets and the edit list that undoes them: the first keyframe is at 0, as a player shows it", async () => {
  // every sample shown 2 frames after it is decoded; the edit list starts the film there
  const index = await read(mkFilm({ ctts: [[240, 2000]], elst: [[10000, 2000, 1]] }));
  assert.deepEqual(index.cues.map((c) => c.t), [0, 2, 4, 6, 8]);
  // without the edit list the same file starts 2 frames late
  const late = await read(mkFilm({ ctts: [[240, 2000]] }));
  assert.ok(Math.abs(late.cues[0].t - 2000 / 24000) < 1e-9);
  // negative offsets (version-1 ctts, or signed values in version 0)
  const neg = await read(mkFilm({ ctts: [[1, 0], [239, -1000]], sync: [0, 48] }));
  assert.ok(Math.abs(neg.cues[1].t - (48000 - 1000) / 24000) < 1e-9);
});

test("an empty edit first (the picture starts late): every time moves by it", async () => {
  // 500 ms of nothing (movie timescale 1000), then the track from its start
  const index = await read(mkFilm({ elst: [[500, -1, 1], [10000, 0, 1]] }));
  assert.deepEqual(index.cues.map((c) => c.t), [0.5, 2.5, 4.5, 6.5, 8.5]);
});

test("an edit list that is more than a start offset is another film: null", async () => {
  assert.equal(await read(mkFilm({ elst: [[4000, 0, 1], [4000, 96000, 1]] })), null, "two pieces");
  assert.equal(await read(mkFilm({ elst: [[10000, 0, 2]] })), null, "played at another speed");
});

test("a keyframe before the start the edit list names is not part of the film", async () => {
  // the film starts at media time 48000 (2 s in): sample 0 is cut away
  const index = await read(mkFilm({ elst: [[8000, 48000, 1]] }));
  assert.deepEqual(index.cues.map((c) => c.t), [0, 2, 4, 6]);
});

test("no sync table: every sample is a keyframe", async () => {
  const index = await read(mkFilm({ n: 48, sync: null }));
  assert.equal(index.cues.length, 48);
  assert.ok(Math.abs(index.cues[47].t - 47 / 24) < 1e-9);
});

test("the first VIDEO track is the one read; a file with none, or a fragmented one, is refused", async () => {
  const withAudioFirst = await read(mkFilm({ extraTrakFirst: "soun" }));
  assert.deepEqual(withAudioFirst.cues.map((c) => c.t), [0, 2, 4, 6, 8]);
  assert.equal(await read(mkFilm({ handler: "soun" })), null);
  assert.equal(await read(mkFilm({ mvex: true })), null);
});

test("tables that do not add up are refused, not guessed at", async () => {
  // more samples than the chunk table holds
  assert.equal(await read(mkFilm({ offsets: [5000, 15000] })), null);
  // one keyframe is no index
  assert.equal(await read(mkFilm({ sync: [0] })), null);
  // a truncated file: the moov is cut short
  const film = mkFilm();
  const cut = film.buf.subarray(0, film.buf.length - 200);
  assert.equal(await parseMp4Index(bufferRange(cut), cut.length), null);
});

// ---------- the real thing ----------
const haveX264 = () => {
  if (!config.ffmpegAvailable) return false;
  try {
    return /libx264/.test(execFileSync(config.FFMPEG, ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch { return false; }
};
const SRC = (sec, rate = "24000/1001") => [
  "-f", "lavfi", "-i", `testsrc=duration=${sec}:size=160x90:rate=${rate}`,
  "-f", "lavfi", "-i", `sine=frequency=440:duration=${sec}:sample_rate=48000`,
  "-map", "0:v", "-map", "1:a",
];
const X264 = (gop, bf) => ["-c:v", "libx264", "-preset", "ultrafast", "-bf", String(bf), "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", "-pix_fmt", "yuv420p"];
const AAC = ["-c:a", "aac", "-b:a", "64k"];
const ff = (args) => execFileSync(config.FFMPEG, ["-v", "error", "-y", ...args]);
// the keyframes ffprobe sees: [{ t, pos }]
const keyframes = (file) =>
  execFileSync(config.FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,pos,flags", "-of", "csv=p=0", file], { maxBuffer: 1 << 26 })
    .toString().split(/\r?\n/).filter((l) => /K/.test(l.split(",")[2] || ""))
    .map((l) => { const [t, pos] = l.split(","); return { t: parseFloat(t), pos: parseInt(pos, 10) }; })
    .sort((a, b) => a.t - b.t);
const duration = (file) => parseFloat(execFileSync(config.FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());

const SHAPES = [
  ["B-frames, an edit list, the index at the end (ffmpeg's default)", [...X264(48, 2), ...AAC]],
  ["B-frames, the index at the front (faststart)", [...X264(48, 3), ...AAC, "-movflags", "+faststart"]],
  ["no B-frames", [...X264(60, 0), ...AAC]],
  ["B-frames, negative composition offsets, no edit list", [...X264(48, 2), ...AAC, "-movflags", "+negative_cts_offsets"]],
  ["B-frames, no edit list at all", [...X264(48, 2), ...AAC, "-use_editlist", "0"]],
  ["a keyframe every 10 s, 25 fps", [...X264(250, 3), ...AAC], 40, "25"],
  ["video only", [...X264(48, 2), "-an"]],
];

test("real ffmpeg: every keyframe's time and place, as ffprobe reports them, for MP4s written every way", async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mp4idx-"));
  try {
    let n = 0;
    for (const [name, args, sec = 24, rate] of SHAPES) {
      const file = path.join(dir, `shape${n++}.mp4`);
      ff([...SRC(sec, rate), ...args, file]);
      const buf = fs.readFileSync(file);
      const index = await parseMp4Index(bufferRange(buf), buf.length);
      assert.ok(index, `${name}: read`);
      const truth = keyframes(file);
      assert.ok(truth.length >= 2, `${name}: ffprobe sees keyframes`);
      assert.equal(index.cues.length, truth.length, `${name}: ${index.cues.length} keyframes, ffprobe says ${truth.length}`);
      for (let i = 0; i < truth.length; i++) {
        assert.ok(Math.abs(index.cues[i].t - truth[i].t) <= 0.001, `${name}: keyframe ${i} at ${index.cues[i].t}, ffprobe says ${truth[i].t}`);
        assert.equal(index.cues[i].offset, truth[i].pos, `${name}: keyframe ${i} is at byte ${truth[i].pos}`);
      }
      assert.ok(Math.abs(index.durationSec - duration(file)) < 0.15, `${name}: ${index.durationSec}s long, ffprobe says ${duration(file)}`);
      const place = await moovPlace(bufferRange(buf), buf.length);
      assert.equal(place.front, args.includes("+faststart"), `${name}: where the index sits`);
      assert.equal(index.moov.size, place.size);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("real ffmpeg: jit serves an MP4 — every segment on its declared keyframes, from the top and from a seek", async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mp4jit-"));
  J.setDeclinedFile(path.join(dir, "declined.json"));
  const dirs = [];
  try {
    // 90 s, a keyframe every 3 s, B-frames: 15 segments of 6 s
    const file = path.join(dir, "film.mp4");
    ff([...SRC(90), ...X264(72, 2), ...AAC, file]);
    const buf = fs.readFileSync(file);
    const key = `mp4-${Date.now()}`;
    const entry = await jit.tableFor(key, bufferRange(buf), buf.length, { mp4: true });
    assert.ok(entry && entry.table.length >= 12, "an MP4 has a table when the caller allows it");
    assert.ok(entry.rate && entry.rate.avg > 0 && entry.rate.peak >= entry.rate.avg, "…and a bitrate read off its sample table");
    const N = entry.table.length;
    const input = { url: file, extra: [], fmt: null, vtagHvc1: false };
    for (const [tag, order] of [["top", [...Array(N).keys()]], ["seek", [N - 4, N - 3, 5, 6, N - 1, 0]]]) {
      const d = path.join(dir, tag);
      dirs.push(d);
      const job = jit.jobFor(d, entry);
      for (const k of order) assert.ok(await jit.ensureSegment(d, job, input, k), `${tag}: segment ${k} (${job.broken || "ok"})`);
      assert.equal(job.broken, null, `${tag}: no boundary was off`);
    }
    assert.equal(jit.declinedReason(key), null);
    // the same segment from either producer holds the same video packets
    const sig = (seg) => execFileSync(config.FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,size,flags", "-of", "csv=p=0", seg]).toString().split(/\r?\n/).filter(Boolean).join("|");
    for (const k of [0, 5, N - 1]) {
      const name = `seg${String(k).padStart(5, "0")}.ts`;
      assert.equal(sig(path.join(dir, "seek", name)), sig(path.join(dir, "top", name)), `segment ${k} is the same whichever producer made it`);
    }
    // fMP4 segments (an iPhone's) too
    const d4 = path.join(dir, "f4");
    dirs.push(d4);
    const j4 = jit.jobFor(d4, entry);
    const in4 = { ...input, fmt: "fmp4" };
    assert.ok(await jit.ensureInit(d4, j4, in4));
    for (const k of [0, 1, 7]) assert.ok(await jit.ensureSegment(d4, j4, in4, k), `fmp4 segment ${k} (${j4.broken || "ok"})`);
    assert.equal(j4.broken, null);
  } finally {
    for (const d of dirs) J.dropJob(d);
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    J.setDeclinedFile(path.join(os.tmpdir(), "aurora-jit-declined-test.json"));
  }
});

test("an MP4 has no table unless the caller asks for one (a torrent's playlist route does not)", async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mp4off-"));
  try {
    const file = path.join(dir, "film.mp4");
    ff([...SRC(30), ...X264(72, 2), ...AAC, file]);
    const buf = fs.readFileSync(file);
    assert.equal(await jit.tableFor(`mp4off-${Date.now()}`, bufferRange(buf), buf.length), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
