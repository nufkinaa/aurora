// S7 — the playlist and the produced segments must agree EXACTLY, whatever
// segment a producer was started at. Three layers:
//  • the index: only the VIDEO track's cue points are segment boundaries
//    (a hand-built Matroska file, no ffmpeg needed);
//  • the grouping rule (nextSegment): GOP files → playlist segments by their
//    measured start times, with every declared boundary checked — pure, from
//    fixture keyframe lists;
//  • the real thing, when ffmpeg is on the machine: a generated MKV with
//    irregular keyframes, B-frames, audio and a subtitle track is produced
//    from the top, from the middle and from near the end, in MPEG-TS and
//    fMP4, and every published segment is probed against the playlist. This
//    is also the check to run on a host whose ffmpeg is a different version:
//      node --test test/jit-exact.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const config = require("../src/config");
const { parseMkvIndex } = require("../src/media/mkvindex");
const jit = require("../src/media/jit");
const { buildTable, nextSegment, parseOpenLine, parseListLine, TS_OFFSET_SEC, BOUNDARY_TOL_SEC } = jit._internals;

// ---------- a hand-built Matroska file ----------
const vint = (n) => {
  // EBML size, 1..4 bytes
  if (n < 0x7f) return Buffer.from([0x80 | n]);
  if (n < 0x3fff) return Buffer.from([0x40 | (n >> 8), n & 0xff]);
  if (n < 0x1fffff) return Buffer.from([0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff]);
  return Buffer.from([0x10 | (n >> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
};
const idBytes = (id) => {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return Buffer.from(out);
};
const el = (id, payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
  return Buffer.concat([idBytes(id), vint(body.length), body]);
};
const uint = (n) => {
  const out = [];
  do { out.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0);
  return Buffer.from(out);
};
const f64 = (x) => { const b = Buffer.alloc(8); b.writeDoubleBE(x); return b; };

// points: [{ ms, tracks: [trackNumber…] }]; tracks: [{ number, type }]
const fakeMkv = ({ durationMs, tracks, points, tracksInHead = true }) => {
  const info = el(0x1549a966, [el(0x2ad7b1, uint(1000000)), el(0x4489, f64(durationMs))]);
  const tracksEl = el(0x1654ae6b, tracks.map((t) =>
    el(0xae, [el(0xd7, uint(t.number)), el(0x83, uint(t.type)), el(0x63a2, Buffer.alloc(t.pad || 0))])));
  const cues = el(0x1c53bb6b, points.map((p) =>
    el(0xbb, [el(0xb3, uint(p.ms)), ...p.tracks.map((n) => el(0xb7, [el(0xf7, uint(n)), el(0xf1, uint(1000 + p.ms))]))])));
  const cluster = el(0x1f43b675, Buffer.alloc(tracksInHead ? 64 : 70000));
  // SeekHead with fixed-width positions so its own size does not move them
  const pos4 = (n) => Buffer.from([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const seekHead = (cuesPos, tracksPos) => el(0x114d9b74, [
    el(0x4dbb, [el(0x53ab, idBytes(0x1c53bb6b)), el(0x53ac, pos4(cuesPos))]),
    el(0x4dbb, [el(0x53ab, idBytes(0x1654ae6b)), el(0x53ac, pos4(tracksPos))]),
  ]);
  const shLen = seekHead(0, 0).length;
  // layout inside the segment: SeekHead, Info, [Tracks], Cluster, [Tracks], Cues
  const before = tracksInHead ? [info, tracksEl, cluster] : [info, cluster, tracksEl];
  const tracksPos = shLen + (tracksInHead ? info.length : info.length + cluster.length);
  const cuesPos = shLen + before.reduce((n, b) => n + b.length, 0);
  const body = Buffer.concat([seekHead(cuesPos, tracksPos), ...before, cues]);
  const header = el(0x1a45dfa3, [el(0x4282, Buffer.from("matroska"))]);
  const n = body.length; // the Segment's size as a 4-byte vint
  const segSize = Buffer.from([0x10 | ((n >> 24) & 0x0f), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.concat([header, idBytes(0x18538067), segSize, body]);
};
const bufferRange = (buf) => async (start, len) => buf.subarray(start, start + len);

test("index: only the video track's cue points are returned", async () => {
  // track 1 = subtitles (type 17), track 2 = video (type 1), track 3 = audio.
  // Subtitle cues everywhere; video keyframes at 0, 4, 9.5, 14s.
  const points = [
    { ms: 0, tracks: [2, 3] }, { ms: 500, tracks: [1] }, { ms: 1800, tracks: [1] },
    { ms: 4000, tracks: [2] }, { ms: 4000, tracks: [1] }, { ms: 6100, tracks: [1, 3] },
    { ms: 9500, tracks: [1, 2] }, { ms: 12000, tracks: [3] }, { ms: 14000, tracks: [2] },
  ];
  const buf = fakeMkv({ durationMs: 20000, tracks: [{ number: 1, type: 17 }, { number: 2, type: 1 }, { number: 3, type: 2 }], points });
  const index = await parseMkvIndex(bufferRange(buf), buf.length);
  assert.ok(index, "the fixture parses");
  assert.equal(index.videoTrack, 2);
  assert.equal(index.cuePoints, points.length);
  assert.deepEqual(index.cues.map((c) => c.t), [0, 4, 9.5, 14]);
  assert.equal(index.durationSec, 20);
});

test("index: Tracks beyond the head read is fetched through the SeekHead", async () => {
  const points = [{ ms: 0, tracks: [1] }, { ms: 700, tracks: [2] }, { ms: 5000, tracks: [1] }, { ms: 9000, tracks: [1] }];
  const buf = fakeMkv({ durationMs: 12000, tracks: [{ number: 1, type: 1 }, { number: 2, type: 17 }], points, tracksInHead: false });
  assert.ok(buf.length > 64 * 1024 + 1000, "Tracks really sits past the head");
  const index = await parseMkvIndex(bufferRange(buf), buf.length);
  assert.ok(index);
  assert.deepEqual(index.cues.map((c) => c.t), [0, 5, 9]);
});

test("index: no video track, or no video cues → null (jit declines the file)", async () => {
  const onlySubs = fakeMkv({ durationMs: 9000, tracks: [{ number: 1, type: 17 }, { number: 2, type: 2 }], points: [{ ms: 0, tracks: [1] }, { ms: 3000, tracks: [2] }] });
  assert.equal(await parseMkvIndex(bufferRange(onlySubs), onlySubs.length), null);
  const videoUncued = fakeMkv({ durationMs: 9000, tracks: [{ number: 1, type: 1 }, { number: 2, type: 17 }], points: [{ ms: 0, tracks: [2] }, { ms: 3000, tracks: [2] }, { ms: 5000, tracks: [2] }] });
  assert.equal(await parseMkvIndex(bufferRange(videoUncued), videoUncued.length), null);
});

// ---------- the grouping rule ----------
// Simulate a producer over a list of true keyframe times: it lands on the
// keyframe before table[fromSeg] (the pre-roll), opens one file per GOP, and
// reports each file's start. Returns what gets published: { k: [gop starts] }.
const simulate = (table, keyframes, fromSeg, { reportFirst = false } = {}) => {
  const wanted = table[fromSeg].start;
  let first = 0;
  if (fromSeg > 0) {
    first = keyframes.findIndex((t) => t >= wanted - 1e-9) - 1; // the keyframe before
    if (first < 0) first = 0;
  }
  const run = { fromSeg, nextSeg: fromSeg, cursor: 0, gops: [], ended: false };
  const published = {};
  const drain = () => {
    for (;;) {
      const step = nextSegment(table, run);
      if (step.wait) return null;
      if (step.fail) return step.fail;
      published[step.seg] = step.members.map((i) => run.gops[i].start);
      run.cursor = step.members[step.members.length - 1] + 1;
      run.nextSeg = step.seg + 1;
    }
  };
  for (let i = first; i < keyframes.length; i++) {
    const idx = i - first;
    const known = idx > 0 || fromSeg === 0 || reportFirst;
    run.gops[idx] = { start: known ? keyframes[i] : null, closed: false };
    if (idx > 0) run.gops[idx - 1].closed = true;
    const fail = drain();
    if (fail) return { fail, published };
  }
  run.ended = true;
  const fail = drain();
  return { fail, published };
};

// Irregular keyframes, the way a real encode has them (Silo S3E1's opening).
const KF = [0, 7.007, 8.467, 9.801, 11.803, 13.889, 16.975, 20.103, 22.773, 24.608, 29.613, 33.867, 38.08, 39.665,
  41.416, 45.42, 51.635, 53.72, 59.31, 61.228, 71.655, 73.407, 75.2, 77.411, 83.667, 85.586, 90.59, 96.43];
const DUR = 100.5;
const tableOf = (kf, dur = DUR) => buildTable({ durationSec: dur, cues: kf.map((t) => ({ t, offset: 0 })) });

test("grouping: every start point publishes the same segments, on the playlist's boundaries", () => {
  const table = tableOf(KF);
  const full = simulate(table, KF, 0);
  assert.equal(full.fail, null);
  assert.equal(Object.keys(full.published).length, table.length, "one published segment per playlist entry");
  for (let k = 0; k < table.length; k++) {
    assert.ok(Math.abs(full.published[k][0] - table[k].start) < 1e-9, `segment ${k} opens on its declared keyframe`);
    const end = k + 1 < table.length ? full.published[k + 1][0] : DUR;
    assert.ok(Math.abs(end - full.published[k][0] - table[k].dur) < 1e-9, `segment ${k} lasts its EXTINF`);
  }
  // every keyframe is in exactly one segment
  assert.deepEqual(Object.values(full.published).flat(), KF);
  for (let from = 1; from < table.length; from++) {
    const part = simulate(table, KF, from);
    assert.equal(part.fail, null, `producer from ${from}`);
    assert.deepEqual(Object.keys(part.published).map(Number), table.map((_, k) => k).filter((k) => k >= from));
    for (let k = from; k < table.length; k++) {
      assert.deepEqual(part.published[k], full.published[k], `segment ${k} from a producer started at ${from}`);
    }
  }
});

test("grouping: the cumulative-target rule that broke the old producer cannot move a boundary", () => {
  // The old table said 7.0, 6.0(ish)…; ffmpeg's HLS muxer cut 7.007, 6.882,
  // 6.214, 4.505 from the top. Segment 1 here must end where the TABLE says.
  const table = tableOf(KF);
  assert.ok(Math.abs(table[0].dur - 7.007) < 1e-9);
  assert.ok(Math.abs(table[1].start - 7.007) < 1e-9 && Math.abs(table[1].dur - (13.889 - 7.007)) < 1e-9);
  const { published } = simulate(table, KF, 0);
  assert.deepEqual(published[1], [7.007, 8.467, 9.801, 11.803]);
});

test("grouping: a segment is not published until a later GOP has opened", () => {
  const table = tableOf(KF);
  const run = { fromSeg: 0, nextSeg: 0, cursor: 0, gops: [{ start: 0, closed: false }], ended: false };
  assert.deepEqual(nextSegment(table, run), { wait: true });
  run.gops.push({ start: 7.007, closed: false }); // segment 1's first GOP opens → segment 0 is whole
  assert.deepEqual(nextSegment(table, run), { seg: 0, members: [0], drop: [] });
  run.cursor = 1; run.nextSeg = 1;
  run.gops.push({ start: 8.467, closed: false }, { start: 9.801, closed: false }, { start: 11.803, closed: false });
  assert.deepEqual(nextSegment(table, run), { wait: true }, "segment 1 still open-ended");
  run.gops.push({ start: null, closed: false }); // opened, time not reported yet
  assert.deepEqual(nextSegment(table, run), { wait: true }, "an unreported start is waited for, not guessed");
  run.gops[5].start = 13.889;
  assert.deepEqual(nextSegment(table, run), { seg: 1, members: [1, 2, 3, 4], drop: [] });
});

test("grouping: pre-roll GOPs are dropped; a seek that lands exactly is used", () => {
  const table = tableOf(KF);
  const k = 3;
  const early = simulate(table, KF, k);
  const exact = simulate(table, KF.filter((t) => t >= table[k].start - 1e-9), 0);
  assert.equal(early.fail, null);
  // landed on the wanted keyframe itself and the muxer reported it
  const run = { fromSeg: k, nextSeg: k, cursor: 0, gops: [], ended: false };
  const tail = KF.filter((t) => t >= table[k].start - 1e-9);
  tail.forEach((t) => run.gops.push({ start: t, closed: true }));
  const step = nextSegment(table, run);
  assert.equal(step.seg, k);
  assert.deepEqual(step.drop, []);
  assert.deepEqual(step.members.map((i) => run.gops[i].start), early.published[k]);
  assert.ok(exact.published); // (shape only)
});

test("grouping: keyframes the index never listed are just GOPs inside their segment", () => {
  const table = tableOf(KF.filter((_, i) => i % 2 === 0)); // sparse cues: every other keyframe
  const { fail, published } = simulate(table, KF, 0);
  assert.equal(fail, null);
  assert.deepEqual(Object.values(published).flat(), KF);
  for (let k = 0; k < table.length; k++) assert.ok(Math.abs(published[k][0] - table[k].start) < 1e-9);
  for (const from of [1, 2, table.length - 1]) {
    const part = simulate(table, KF, from);
    assert.equal(part.fail, null);
    for (let k = from; k < table.length; k++) assert.deepEqual(part.published[k], published[k]);
  }
});

test("grouping: a cue that is not a keyframe fails the job instead of publishing a lie", () => {
  // the index claims a keyframe at 51.5 — there is none (damaged file / bad muxer)
  const cues = [...KF, 51.5].sort((a, b) => a - b);
  const table = tableOf(cues);
  const bad = table.findIndex((s) => Math.abs(s.start - 51.5) < 1e-9);
  assert.ok(bad > 0, "the bogus cue became a boundary");
  const top = simulate(table, KF, 0);
  assert.match(top.fail, new RegExp(`segment ${bad}: next keyframe at 51\\.635s, playlist says 51\\.500s`));
  assert.equal(top.published[bad - 1], undefined, "the segment that would have run long is not published");
  assert.ok(top.published[bad - 2], "everything before the lie was fine and stays served");
  const mid = simulate(table, KF, bad);
  assert.match(mid.fail, /first keyframe at 51\.635s, playlist says 51\.500s/);
  assert.deepEqual(mid.published, {});
});

test("grouping: a video that ends before the playlist does is a failure, not a short film", () => {
  const table = tableOf(KF);
  const { fail } = simulate(table, KF.filter((t) => t < 60), 0);
  assert.match(fail, /the video ends inside segment \d+; the playlist promised/);
});

test("grouping: tolerance is 2ms — the rounding between cue time and packet time, nothing more", () => {
  const table = tableOf(KF);
  const off = (ms) => KF.map((t, i) => (i === 5 ? t + ms / 1000 : t)); // 13.889 = table[2].start
  assert.equal(simulate(table, off(1), 0).fail, null);
  assert.equal(simulate(table, off(-1), 0).fail, null);
  assert.match(simulate(table, off(40), 0).fail, /segment 2/);
  assert.ok(BOUNDARY_TOL_SEC <= 0.002);
});

// ---------- ffmpeg's own words ----------
test("the muxer's 'file opened' line: index, and a start only when it can be trusted", () => {
  const line = (stream, pts, t) =>
    `[segment @ 000001] segment:'C:\\cache\\jit\\x-1\\p3\\g000042.ts' starts with packet stream:${stream} pts:${pts} pts_time:${t} frame:143`;
  const a = parseOpenLine(line(0, 222089670, "2467.66")); // 2467.663 + 10s offset, 6 significant digits
  assert.equal(a.idx, 42);
  assert.ok(Math.abs(a.start - 2457.663) < 1e-4);
  assert.deepEqual(parseOpenLine(line(1, 222089670, "2467.66")), { idx: 42, start: null }, "an audio packet opened the file");
  // a time base that is not 1/90000: the two renderings disagree → no start
  assert.deepEqual(parseOpenLine(line(0, 39482608, "2467.66")), { idx: 42, start: null });
  assert.equal(parseOpenLine("[segment @ 1] segment:'x/g000001.ts' count:1 ended"), null);
  const m4s = parseOpenLine("[segment @ 1] segment:'/var/cache/jit/k-f4/p1/g000007.m4s' starts with packet stream:0 pts:1530630 pts_time:17.007 frame:168");
  assert.equal(m4s.idx, 7);
  assert.ok(Math.abs(m4s.start - 7.007) < 1e-4);
});

test("the segment list line: file index and measured start, offset removed", () => {
  const a = parseListLine("g000012.ts,2467.663000,2471.041000");
  assert.equal(a.idx, 12);
  assert.ok(Math.abs(a.start - (2467.663 - TS_OFFSET_SEC)) < 1e-9);
  assert.equal(parseListLine("g000003.m4s,17.007000,18.466000").idx, 3);
  assert.equal(parseListLine("frame=  494 fps=0.0"), null);
});

// ---------- the real thing ----------
const haveX264 = () => {
  if (!config.ffmpegAvailable) return false;
  try {
    return /libx264/.test(execFileSync(config.FFMPEG, ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch { return false; }
};

// 44s, 24fps, B-frames, forced keyframes at irregular times (some GOPs far
// shorter than a segment, one longer), stereo audio, and a subtitle track
// whose lines fill the Cues with non-video cue points.
const KEYS = [0, 1.5, 2.75, 7, 8.25, 9.5, 13, 20.5, 22, 23.25, 27, 28.5, 33, 34.25, 35.5, 40, 41.25];
const makeFixture = (dir) => {
  const srt = path.join(dir, "s.srt");
  const stamp = (s) => `00:00:${String(Math.floor(s)).padStart(2, "0")},${String(Math.round((s % 1) * 1000)).padStart(3, "0")}`;
  fs.writeFileSync(srt, Array.from({ length: 40 }, (_, i) => `${i + 1}\n${stamp(i + 0.3)} --> ${stamp(i + 0.9)}\nline ${i + 1}\n`).join("\n"));
  const file = path.join(dir, "fixture.mkv");
  execFileSync(config.FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=44:size=160x90:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=44:sample_rate=48000",
    "-i", srt,
    "-map", "0:v", "-map", "1:a", "-map", "2:s",
    "-c:v", "libx264", "-preset", "ultrafast", "-bf", "2", "-g", "9999", "-keyint_min", "9999", "-sc_threshold", "0",
    "-force_key_frames", KEYS.join(","), "-pix_fmt", "yuv420p",
    "-c:a", "ac3", "-b:a", "96k", "-c:s", "srt", file,
  ]);
  return file;
};
const probePackets = (dir, seg, fmt) => {
  const input = fmt ? `concat:init.mp4|${seg}` : seg;
  return execFileSync(config.FFPROBE, ["-v", "error", "-show_entries", "packet=codec_type,pts_time,size,flags", "-of", "csv=p=0", input], { cwd: dir })
    .toString().split(/\r?\n/).filter(Boolean).map((l) => {
      const [type, pts, size, flags] = l.split(",");
      return { type, pts: parseFloat(pts) - TS_OFFSET_SEC, size: +size, key: /K/.test(flags || "") };
    });
};

for (const fmt of [null, "fmp4"]) {
  test(`real ffmpeg, ${fmt || "mpegts"}: produced segments match the playlist from every start point`, async (t) => {
    if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitx-"));
    jit._internals.setDeclinedFile(path.join(dir, "declined.json"));
    const dirs = [];
    try {
      const file = makeFixture(dir);
      const buf = fs.readFileSync(file);
      const key = `fixture-${fmt || "ts"}-${Date.now()}`;
      const entry = await jit.tableFor(key, bufferRange(buf), buf.length);
      assert.ok(entry, "the fixture has a usable index");
      const T = entry.table;
      // the table's boundaries are true video keyframes, not subtitle cues
      for (const s of T) assert.ok(KEYS.some((k) => Math.abs(k - s.start) < 0.0015), `boundary ${s.start} is a forced keyframe`);
      assert.deepEqual(T.map((s) => +s.start.toFixed(2)), [0, 7, 13, 20.5, 27, 33, 40]);
      const input = { url: file, extra: [], fmt, vtagHvc1: false };
      const produce = async (tag, order) => {
        const d = path.join(dir, tag);
        dirs.push(d);
        const job = jit.jobFor(d, entry);
        if (fmt) assert.ok(await jit.ensureInit(d, job, input), "init.mp4");
        for (const k of order) assert.ok(await jit.ensureSegment(d, job, input, k), `${tag}: segment ${k} (${job.broken || "ok"})`);
        return { d, job };
      };
      const all = T.map((_, k) => k);
      const top = await produce("top", all); // one producer, from the top to EOF
      assert.equal(top.job.gen, 1, "one producer made the whole film");
      const mid = await produce("mid", [3, 4, 5, 6]); // cold seek to the middle
      const late = await produce("late", [T.length - 1]); // straight to the last segment
      const back = await produce("back", [4, 5, 2, 3, 6]); // seek, then seek back and play through the junction

      const sig = (d, k) => {
        const pk = probePackets(d, path.basename(jit.segPath(d, k, fmt)), fmt);
        const v = pk.filter((p) => p.type === "video");
        return { v, a: pk.filter((p) => p.type === "audio"), id: v.map((p) => `${Math.round(p.pts * 1000)}:${p.size}`).join(",") };
      };
      let videoPackets = 0;
      for (const k of all) {
        const s = sig(top.d, k);
        videoPackets += s.v.length;
        assert.ok(s.v[0].key, `segment ${k} opens on a keyframe`);
        assert.ok(Math.abs(s.v[0].pts - T[k].start) <= 0.002, `segment ${k} starts at ${s.v[0].pts}, playlist says ${T[k].start}`);
        const min = Math.min(...s.v.map((p) => p.pts)), max = Math.max(...s.v.map((p) => p.pts));
        const end = k + 1 < T.length ? T[k + 1].start : entry.durationSec;
        assert.ok(min >= T[k].start - 0.002 && max < end, `segment ${k} holds only its own frames (${min}..${max})`);
        assert.ok(s.a.length > 0, `segment ${k} carries audio`);
      }
      assert.equal(videoPackets, 44 * 24, "every frame of the film is in exactly one segment");
      // a segment is the same video whoever produced it
      for (const [h, ks] of [[mid, [3, 4, 5, 6]], [late, [T.length - 1]], [back, [2, 3, 4, 5, 6]]]) {
        for (const k of ks) assert.equal(sig(h.d, k).id, sig(top.d, k).id, `segment ${k} differs between producers`);
      }
      assert.ok(back.job.gen >= 2, "the seek back really used a second producer");
      // nothing but the playlist's segments was ever published
      for (const h of [top, mid, late, back]) {
        const names = fs.readdirSync(h.d).filter((f) => /^seg/.test(f));
        assert.ok(names.every((f) => parseInt(f.slice(3, 8), 10) < T.length), `stray segment in ${names}`);
      }
      assert.equal(fs.readdirSync(top.d).filter((f) => /^seg\d{5}\.(ts|m4s)$/.test(f)).length, T.length);
      if (fmt) {
        const init = fs.readFileSync(path.join(top.d, "init.mp4"));
        for (const h of [mid, late, back]) assert.ok(init.equals(fs.readFileSync(path.join(h.d, "init.mp4"))), "init.mp4 is the same from every producer");
      }
      assert.equal(jit.declinedReason(key), null);
    } finally {
      for (const d of dirs) jit._internals.dropJob(d);
      await new Promise((r) => setTimeout(r, 300)); // let killed producers release their files
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

test("real ffmpeg: an index that lies is declined — fast, and remembered", async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitx-"));
  jit._internals.setDeclinedFile(path.join(dir, "declined.json"));
  const d = path.join(dir, "job");
  try {
    const file = makeFixture(dir);
    const buf = fs.readFileSync(file);
    const key = `liar-${Date.now()}`;
    const real = await jit.tableFor(key, bufferRange(buf), buf.length);
    // the same playlist, but its 3rd boundary moved to where no keyframe is
    const table = real.table.map((s) => ({ ...s }));
    table[1].dur += 1; table[2].start += 1; table[2].dur -= 1;
    const entry = { key, table, durationSec: real.durationSec };
    const job = jit.jobFor(d, entry);
    const input = { url: file, extra: [], fmt: null };
    assert.ok(await jit.ensureSegment(d, job, input, 0), "what is true is still served");
    const t0 = Date.now();
    assert.equal(await jit.ensureSegment(d, job, input, 1), null, "the segment with the false end is refused");
    assert.ok(Date.now() - t0 < 15000, "refused promptly, not at the 90s deadline");
    assert.match(job.broken, /segment 2/);
    assert.equal(fs.existsSync(jit.segPath(d, 1, null)), false);
    assert.match(jit.declinedReason(key), /segment 2/);
    assert.equal(await jit.tableFor(key, bufferRange(buf), buf.length), null, "its playlist is refused from now on");
    // …and the refusal survives a restart (re-read from disk)
    jit._internals.setDeclinedFile(path.join(dir, "declined.json"));
    assert.match(jit.declinedReason(key), /segment 2/);
  } finally {
    jit._internals.dropJob(d);
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jit._internals.setDeclinedFile(path.join(os.tmpdir(), "aurora-jit-declined-test.json"));
  }
});
