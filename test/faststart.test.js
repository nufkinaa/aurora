// An MP4 with its index at the end, SERVED with the index in front
// (src/media/faststart.js). Nothing on disk changes; what goes down the wire
// has to be a correct MP4 of the same film, byte range by byte range.
//  • the layout and the rewritten offsets, on hand-made files;
//  • every case that is refused (served as it is on disk);
//  • the real thing, when ffmpeg is on the machine: ffprobe and ffmpeg read
//    the served bytes as the same film, packet for packet;
//  • ranges: any slice of the served file is that slice.
//      node --test test/faststart.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");
const { execFileSync } = require("child_process");

const config = require("../src/config");
const faststart = require("../src/media/faststart");
const F = faststart._internals;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-faststart-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const u32 = (...n) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n), 0); return b; };
const box = (type, ...payload) => {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const full = (type, ...payload) => box(type, Buffer.from([0, 0, 0, 0]), ...payload);
const stbl = (...tables) => box("trak", box("mdia", box("minf", box("stbl", ...tables))));
const FTYP = box("ftyp", Buffer.from("isom\0\0\0\0isom"));
const write = (name, ...parts) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, Buffer.concat(parts));
  return f;
};
const plan = (file) => F.build(file, fs.statSync(file).size);
// the whole file as it is served
const served = (file, p) => {
  const disk = fs.readFileSync(file);
  return Buffer.concat(faststart.pieces(p, 0, p.size - 1).map((x) => (x.buf ? x.buf.subarray(x.from, x.to + 1) : disk.subarray(x.from, x.to + 1))));
};

test("the index moves in front of the film, and every chunk offset moves with the film", () => {
  const mdat = box("mdat", Buffer.alloc(5000, 7));
  const moov = box("moov", box("mvhd", Buffer.alloc(20)), stbl(full("stco", u32(3, 60, 1060, 2060))), stbl(full("co64", u32(2), u64(3060), u64(4060))));
  const file = write("tail.mp4", FTYP, box("free"), mdat, moov);
  const p = plan(file);
  assert.ok(p, "a file with its index at the end has a plan");
  const out = served(file, p);
  assert.equal(out.length, fs.statSync(file).size, "the same length");
  // ftyp, then the index, then what was between them
  assert.equal(out.toString("latin1", 4, 8), "ftyp");
  assert.equal(out.toString("latin1", FTYP.length + 4, FTYP.length + 8), "moov");
  assert.equal(out.toString("latin1", FTYP.length + moov.length + 4, FTYP.length + moov.length + 8), "free");
  assert.equal(out.toString("latin1", FTYP.length + moov.length + 8 + 4, FTYP.length + moov.length + 8 + 8), "mdat");
  // the film's bytes are the film's bytes, moved by the index's size
  const disk = fs.readFileSync(file);
  assert.ok(out.subarray(FTYP.length + moov.length).equals(disk.subarray(FTYP.length, disk.length - moov.length)));
  // every offset points at the same byte of film it pointed at before
  const servedMoov = out.subarray(FTYP.length, FTYP.length + moov.length);
  const at = servedMoov.indexOf(Buffer.from("stco")) + 4 + 4;
  assert.deepEqual([0, 1, 2].map((i) => servedMoov.readUInt32BE(at + 4 + i * 4)), [60, 1060, 2060].map((v) => v + moov.length));
  const at64 = servedMoov.indexOf(Buffer.from("co64")) + 4 + 4;
  assert.deepEqual([0, 1].map((i) => Number(servedMoov.readBigUInt64BE(at64 + 4 + i * 8))), [3060, 4060].map((v) => v + moov.length));
  // …and the file on disk was not touched
  assert.ok(fs.readFileSync(file).equals(disk));
});

test("refused (served as it is): the index already in front, not last, missing, too big to move, or a file that is not this simple", () => {
  const mdat = box("mdat", Buffer.alloc(300, 7));
  const moov = box("moov", stbl(full("stco", u32(1, 60))));
  assert.equal(plan(write("front.mp4", FTYP, moov, mdat)), null, "already in front");
  assert.equal(plan(write("middle.mp4", FTYP, mdat, moov, box("free"))), null, "something follows the index");
  assert.equal(plan(write("nomoov.mp4", FTYP, mdat)), null);
  assert.equal(plan(write("nomdat.mp4", FTYP, moov)), null);
  assert.equal(plan(write("twomoov.mp4", FTYP, mdat, moov, moov)), null);
  assert.equal(plan(write("noftyp.mp4", mdat, moov)), null);
  assert.equal(plan(write("frag.mp4", FTYP, box("moof", Buffer.alloc(8)), mdat, moov)), null, "fragmented");
  assert.equal(plan(write("mvex.mp4", FTYP, mdat, box("moov", box("mvex", Buffer.alloc(8)), stbl(full("stco", u32(1, 60)))))), null, "a fragmented file's index");
  assert.equal(plan(write("saio.mp4", FTYP, mdat, box("moov", stbl(full("stco", u32(1, 60)), full("saio", u32(1, 99)))))), null, "offsets this code does not rewrite");
  assert.equal(plan(write("junk.mp4", Buffer.alloc(4096, 0x41))), null);
  assert.equal(plan(write("trailing.mp4", FTYP, mdat, moov, Buffer.from([1, 2, 3]))), null, "bytes after the last box");
  assert.equal(plan(write("empty.mp4", Buffer.alloc(0))), null);
  assert.equal(F.build(path.join(tmp, "missing.mp4"), 1000), null);
  // a 32-bit offset that the move would push past 4 GB
  assert.equal(plan(write("edge.mp4", FTYP, mdat, box("moov", stbl(full("stco", u32(1, 0xfffffff0)))))), null);
  // a table that claims more entries than it holds
  assert.equal(plan(write("lie.mp4", FTYP, mdat, box("moov", stbl(full("stco", u32(500, 60)))))), null);
});

test("planFor: only MP4-like names; remembered per file, read again when the file changes", () => {
  F.plans.clear();
  const mdat = box("mdat", Buffer.alloc(300, 7));
  const moov = box("moov", stbl(full("stco", u32(1, 60))));
  const f = write("keep.mp4", FTYP, mdat, moov);
  const p1 = faststart.planFor(f, fs.statSync(f));
  assert.ok(p1);
  assert.equal(faststart.planFor(f, fs.statSync(f)), p1, "the same plan, not built twice");
  const mkv = write("film.mkv", FTYP, mdat, moov);
  assert.equal(faststart.planFor(mkv, fs.statSync(mkv)), null, "not by its name");
  // the file is replaced: its plan is rebuilt
  fs.writeFileSync(f, Buffer.concat([FTYP, moov, mdat]));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.equal(faststart.planFor(f, fs.statSync(f)), null, "now its index is in front");
});

test("planFor: no more than a handful of patched indexes are held at once", () => {
  F.plans.clear();
  const mdat = box("mdat", Buffer.alloc(100, 7));
  const moov = box("moov", stbl(full("stco", u32(1, 60))));
  for (let i = 0; i < F.KEEP + 4; i++) {
    const f = write(`many${i}.mp4`, FTYP, mdat, moov);
    assert.ok(faststart.planFor(f, fs.statSync(f)));
  }
  assert.equal([...F.plans.values()].filter((v) => v.plan).length, F.KEEP);
});

const collect = (file, p, start, end) =>
  new Promise((resolve, reject) => {
    const res = new PassThrough();
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks)));
    faststart.pipe(file, p, start, end, res, reject);
  });

test("ranges: any slice of the served file is that slice — across the seams too", async () => {
  const film = Buffer.alloc(40000);
  for (let i = 0; i < film.length; i++) film[i] = (i * 31 + 7) & 0xff;
  const moov = box("moov", box("mvhd", Buffer.alloc(300, 3)), stbl(full("stco", u32(2, 60, 20000))));
  const file = write("ranges.mp4", FTYP, box("free"), box("mdat", film), moov);
  const p = plan(file);
  const whole = served(file, p);
  const size = whole.length;
  assert.ok((await collect(file, p, 0, size - 1)).equals(whole), "the whole file");
  const seams = [FTYP.length, FTYP.length + moov.length];
  const cases = [[0, 0], [0, 15], [size - 1, size - 1], [size - 100, size - 1], [5, size - 6]];
  for (const s of seams) cases.push([s - 3, s + 3], [s, s], [s - 1, s - 1], [s, s + 50], [0, s - 1], [s, size - 1]);
  cases.push([FTYP.length + 10, FTYP.length + moov.length - 10], [FTYP.length + moov.length + 1000, FTYP.length + moov.length + 30000]);
  for (const [a, b] of cases) {
    const got = await collect(file, p, a, b);
    assert.equal(got.length, b - a + 1, `bytes ${a}-${b}: the length asked for`);
    assert.ok(got.equals(whole.subarray(a, b + 1)), `bytes ${a}-${b}`);
  }
});

test("a client that goes away stops the read", async () => {
  const moov = box("moov", stbl(full("stco", u32(1, 60))));
  const file = write("gone.mp4", FTYP, box("mdat", Buffer.alloc(4 * 1024 * 1024, 5)), moov);
  const p = plan(file);
  const res = new PassThrough({ highWaterMark: 1024 });
  let got = 0;
  res.on("data", (c) => { got += c.length; if (got > 100000) res.destroy(); });
  faststart.pipe(file, p, 0, p.size - 1, res, () => {});
  await new Promise((r) => res.on("close", r));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(got < p.size, "the rest was never read");
});

// ---------- the real thing ----------
const haveX264 = () => {
  if (!config.ffmpegAvailable) return false;
  try {
    return /libx264/.test(execFileSync(config.FFMPEG, ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch { return false; }
};
const packets = (file) =>
  execFileSync(config.FFPROBE, ["-v", "error", "-show_entries", "packet=stream_index,pts_time,dts_time,size,flags", "-of", "csv=p=0", file], { maxBuffer: 1 << 26 }).toString();
const streamHash = (file) => execFileSync(config.FFMPEG, ["-v", "error", "-i", file, "-map", "0", "-c", "copy", "-f", "md5", "-"], { maxBuffer: 1 << 20 }).toString().trim();
const topBoxes = (buf) => {
  const out = [];
  for (let pos = 0; pos + 8 <= buf.length && out.length < 8; ) {
    const size = buf.readUInt32BE(pos) === 1 ? Number(buf.readBigUInt64BE(pos + 8)) : buf.readUInt32BE(pos);
    out.push(buf.toString("latin1", pos + 4, pos + 8));
    if (size < 8) break;
    pos += size;
  }
  return out;
};

test("real ffmpeg: the served file is the same film — every packet, every byte of every stream — with its index in front", async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  const shapes = [
    ["B-frames, sound, a subtitle", ["-f", "lavfi", "-i", "testsrc=duration=20:size=160x90:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:duration=20:sample_rate=48000", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "2", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k"]],
    ["video only, no B-frames", ["-f", "lavfi", "-i", "testsrc=duration=12:size=160x90:rate=25", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "0", "-g", "25", "-pix_fmt", "yuv420p"]],
    ["two sound tracks", ["-f", "lavfi", "-i", "testsrc=duration=10:size=160x90:rate=24", "-f", "lavfi", "-i", "sine=frequency=330:duration=10", "-f", "lavfi", "-i", "sine=frequency=660:duration=10", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k"]],
  ];
  let n = 0;
  for (const [name, args] of shapes) {
    const file = path.join(tmp, `real${n}.mp4`);
    execFileSync(config.FFMPEG, ["-v", "error", "-y", ...args, file]);
    const disk = fs.readFileSync(file);
    assert.deepEqual(topBoxes(disk).slice(-1), ["moov"], `${name}: ffmpeg wrote the index at the end`);
    const p = plan(file);
    assert.ok(p, `${name}: a plan`);
    const out = path.join(tmp, `real${n++}-served.mp4`);
    fs.writeFileSync(out, served(file, p));
    assert.deepEqual(topBoxes(fs.readFileSync(out)).slice(0, 2), ["ftyp", "moov"], `${name}: the index is in front`);
    assert.equal(packets(out), packets(file), `${name}: the same packets at the same times`);
    assert.equal(streamHash(out), streamHash(file), `${name}: the same bytes in every stream`);
    // …and it is what ffmpeg's own faststart makes of the file, as a film
    const own = path.join(tmp, `real${n}-ffmpeg.mp4`);
    execFileSync(config.FFMPEG, ["-v", "error", "-y", "-i", file, "-map", "0", "-c", "copy", "-movflags", "+faststart", own]);
    assert.equal(streamHash(out), streamHash(own), `${name}: as ffmpeg's own faststart`);
  }
});
