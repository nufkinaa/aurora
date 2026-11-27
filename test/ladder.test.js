// The quality ladder (src/media/ladder.js + the encoded renditions in
// jit.js): which rungs a title gets, what each one says of itself in the
// master playlist, how many encoders may run — and, with ffmpeg on the
// machine, that an ENCODED rendition is cut on exactly the copy's segment
// boundaries, frame for frame, whatever segment its producer started at.
//   node --test test/ladder.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const config = require("../src/config");
const jit = require("../src/media/jit");
const ladder = require("../src/media/ladder");
const L = ladder._internals;
const J = jit._internals;

const HEVC_1080 = { codec: "hevc", profile: "Main", level: 120, width: 1920, height: 1036, fps: 23.976 };
const H264_800 = { codec: "h264", profile: "High", level: 42, width: 1920, height: 800, fps: 60 };
const RATE = { avg: 2_000_000, peak: 9_000_000 };

// ---------- which rungs ----------
test("rungs: the top, then only heights BELOW it — never an upscale", () => {
  assert.deepEqual(L.rungNames({ width: 1920, height: 1036 }), ["copy", "h264-720", "h264-480"]);
  assert.deepEqual(L.rungNames({ width: 1280, height: 720 }), ["copy", "h264-480"], "a 720p file has no 720p rung under it");
  assert.deepEqual(L.rungNames({ width: 1280, height: 536 }), ["copy", "h264-480"]);
  assert.deepEqual(L.rungNames({ width: 854, height: 480 }), ["copy"], "nothing below 480");
  assert.deepEqual(L.rungNames({ width: 1920, height: 1036, top: "h264" }), ["h264", "h264-720", "h264-480"]);
  // a 4K file re-encoded folds to 1920 wide: its top rung is 1080 high
  assert.deepEqual(L.dimsFor("h264", 3840, 2160), { w: 1920, h: 1080 });
  assert.deepEqual(L.rungNames({ width: 0, height: 0 }), ["copy"], "size unknown: no lower rung can be named");
});

test("rungs: ?max= keeps what fits, and the smallest when nothing does", () => {
  assert.deepEqual(L.rungNames({ width: 1920, height: 1036, maxHeight: 720 }), ["h264-720", "h264-480"]);
  assert.deepEqual(L.rungNames({ width: 1920, height: 1036, maxHeight: 480 }), ["h264-480"]);
  assert.deepEqual(L.rungNames({ width: 1920, height: 1036, maxHeight: 240 }), ["h264-480"]);
  assert.deepEqual(L.rungNames({ width: 1280, height: 536, maxHeight: 720 }), ["copy", "h264-480"], "the file itself fits");
});

test("picture sizes are what the scale filters produce (even, aspect kept)", () => {
  assert.deepEqual(L.dimsFor("copy", 1920, 1036), { w: 1920, h: 1036 });
  assert.deepEqual(L.dimsFor("h264-720", 1920, 1036), { w: 1334, h: 720 });
  assert.deepEqual(L.dimsFor("h264-480", 1920, 1036), { w: 890, h: 480 });
  assert.deepEqual(L.dimsFor("h264-720", 1920, 800), { w: 1728, h: 720 });
  assert.deepEqual(L.dimsFor("h264", 1920, 1036), { w: 1920, h: 1036 });
  assert.equal(L.dimsFor("h264-720", 0, 0), null);
  // the very expressions remux.js uses for its capped jobs
  const remux = require("../src/media/remux")._internals;
  assert.equal(L.scaleFor("h264-720"), remux.scaleFor(remux.CAPS["h264-720"]));
  assert.equal(L.scaleFor("h264"), remux.scaleFor(null));
  for (const n of ["h264-720", "h264-480"]) {
    assert.equal(`${L.CAPS[n].maxrate}k`, remux.CAPS[n].maxrate, "same ceiling as the single-rendition capped stream");
    assert.equal(`${L.CAPS[n].bufsize}k`, remux.CAPS[n].bufsize);
    assert.equal(`${L.CAPS[n].audio}k`, remux.CAPS[n].audio);
    assert.equal(L.CAPS[n].h, remux.CAPS[n].h);
  }
});

// ---------- what a rung says of itself ----------
test("BANDWIDTH: an encode states its rate control's bound, a copy what the file weighs", () => {
  // 720p: 2200k ceiling, 4400k buffer, 128k audio → peak over a 6s segment
  // is 2200 + 4400/6, plus audio, plus the container
  const e = L.encBandwidth(L.rateFor("h264-720", 720));
  assert.equal(e.peak, Math.ceil((2200 + 4400 / 6 + 128) * 1000 * L.ENC_OVERHEAD));
  assert.equal(e.avg, Math.ceil((2200 + 128) * 1000 * L.ENC_OVERHEAD));
  assert.ok(L.ENC_OVERHEAD >= 1.15, "measured: the 480p rung averaged up to 14.5% over its nominal rate");
  assert.ok(e.peak > e.avg);
  const c = L.copyBandwidth(RATE);
  assert.equal(c.peak, Math.ceil((9_000_000 + 192_000) * L.MUX_OVERHEAD));
  assert.equal(c.avg, Math.ceil((2_000_000 + 192_000) * L.MUX_OVERHEAD));
  assert.equal(L.copyBandwidth(null), null);
  assert.equal(L.copyBandwidth({ avg: 0, peak: 0 }), null);
  // the full encode's ceiling goes by its height
  assert.deepEqual(L.rateFor("h264", 1036), { maxrate: 10000, bufsize: 20000, audio: 192 });
  assert.equal(L.rateFor("h264", 720).maxrate, 5000);
  assert.equal(L.rateFor("h264", 480).maxrate, 2500);
});

test("CODECS: the encode's level is the lowest that holds the picture; the copy's is the file's own", () => {
  assert.equal(L.h264Level(1920, 1036, 23.976, 10000), 40);
  assert.equal(L.h264Level(1334, 720, 23.976, 2200), 32, "1334x720 is over level 3.1's frame size");
  assert.equal(L.h264Level(1280, 720, 25, 2200), 31);
  assert.equal(L.h264Level(890, 480, 23.976, 1000), 31);
  assert.equal(L.h264Level(854, 480, 25, 1000), 30);
  assert.equal(L.h264Level(1728, 720, 60, 2200), 42, "60 fps needs the macroblock rate of 4.2");
  assert.equal(L.h264Level(1152, 480, 60, 1000), 32);
  assert.equal(L.encCodecs(40), "avc1.640028,mp4a.40.2");
  assert.equal(L.encCodecs(31), "avc1.64001f,mp4a.40.2");
  assert.equal(L.copyCodecs(HEVC_1080), "hvc1.1.6.L120.B0,mp4a.40.2");
  assert.equal(L.copyCodecs({ codec: "hevc", profile: "Main 10", level: 150 }), "hvc1.2.4.L150.B0,mp4a.40.2");
  assert.equal(L.copyCodecs(H264_800), "avc1.64002a,mp4a.40.2");
  assert.equal(L.copyCodecs({ codec: "h264", profile: "Main", level: 31 }), "avc1.4d001f,mp4a.40.2");
  // not known for certain → not stated
  assert.equal(L.copyCodecs({ codec: "av1", profile: "Main", level: 8 }), null);
  assert.equal(L.copyCodecs({ codec: "hevc", profile: "Rext", level: 120 }), null);
  assert.equal(L.copyCodecs({ codec: "h264", profile: "High", level: null }), null);
  assert.equal(L.copyCodecs(null), null);
});

test("describe: one entry per rung, top first, honest numbers or no rung", () => {
  const rungs = ladder.describe({ facts: HEVC_1080, rate: RATE });
  assert.deepEqual(rungs.map((r) => r.name), ["copy", "h264-720", "h264-480"]);
  assert.deepEqual(rungs.map((r) => `${r.w}x${r.h}`), ["1920x1036", "1334x720", "890x480"]);
  assert.ok(rungs[0].bandwidth > rungs[1].bandwidth && rungs[1].bandwidth > rungs[2].bandwidth, "BANDWIDTH falls with size");
  assert.equal(rungs[1].codecs, "avc1.640020,mp4a.40.2");
  // the device cannot decode the file: the top is the full encode
  const enc = ladder.describe({ facts: HEVC_1080, rate: RATE, top: "h264" });
  assert.deepEqual(enc.map((r) => r.name), ["h264", "h264-720", "h264-480"]);
  assert.equal(enc[0].codecs, "avc1.640028,mp4a.40.2");
  // no encoder to spare: the top alone
  assert.deepEqual(ladder.describe({ facts: HEVC_1080, rate: RATE, lower: false }).map((r) => r.name), ["copy"]);
  assert.deepEqual(ladder.describe({ facts: HEVC_1080, rate: RATE, top: "h264", lower: false }).map((r) => r.name), ["h264"]);
  // the index gave no rate for the copy: an ABR player would choose blind — no ladder
  assert.deepEqual(ladder.describe({ facts: HEVC_1080, rate: null }), []);
  // the probe failed: the copy can still be named, encodes cannot
  assert.deepEqual(ladder.describe({ facts: null, rate: RATE }).map((r) => r.name), ["copy"]);
  assert.deepEqual(ladder.describe({ facts: null, rate: RATE, top: "h264" }), []);
});

test("describe: a smaller picture that costs more than the file is not a rung", () => {
  // a lean 1080p file: its busiest segment is under the 720p encode's bound
  const lean = ladder.describe({ facts: HEVC_1080, rate: { avg: 1_200_000, peak: 2_500_000 } });
  assert.deepEqual(lean.map((r) => r.name), ["copy", "h264-480"]);
  const leaner = ladder.describe({ facts: HEVC_1080, rate: { avg: 600_000, peak: 1_100_000 } });
  assert.deepEqual(leaner.map((r) => r.name), ["copy"]);
});

test("master playlist: STREAM-INF per rung with BANDWIDTH, RESOLUTION, CODECS; variant URIs carry the rendition", () => {
  const rungs = ladder.describe({ facts: H264_800, rate: RATE });
  const text = ladder.masterText(rungs, (n) => `?v=${n}&a=2`, null);
  const lines = text.trim().split("\n");
  assert.equal(lines[0], "#EXTM3U");
  assert.equal(lines[1], "#EXT-X-VERSION:3");
  assert.equal(lines[2], "#EXT-X-INDEPENDENT-SEGMENTS");
  assert.equal(lines.length, 3 + rungs.length * 2);
  assert.equal(lines[3], `#EXT-X-STREAM-INF:BANDWIDTH=${rungs[0].bandwidth},AVERAGE-BANDWIDTH=${rungs[0].average},RESOLUTION=1920x800,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2"`);
  assert.equal(lines[4], "index.m3u8?v=copy&a=2");
  assert.match(lines[5], /RESOLUTION=1728x720,FRAME-RATE=60\.000,CODECS="avc1\.64002a,mp4a\.40\.2"$/);
  assert.equal(lines[6], "index.m3u8?v=h264-720&a=2");
  assert.equal(lines[8], "index.m3u8?v=h264-480&a=2");
  assert.match(ladder.masterText(rungs, () => "", "fmp4"), /#EXT-X-VERSION:7\n/);
  // attributes that are not known are left out, not invented
  const bare = ladder.masterText([{ name: "copy", w: 0, h: 0, bandwidth: 5, average: 4, codecs: null, fps: 0 }], () => "?v=copy", null);
  assert.match(bare, /#EXT-X-STREAM-INF:BANDWIDTH=5,AVERAGE-BANDWIDTH=4\nindex\.m3u8\?v=copy\n$/);
});

test("master(): parameters, and what it answers when a ladder cannot be had", async (t) => {
  if (!config.ffmpegAvailable) return t.skip("no ffmpeg on this machine");
  // a source whose facts are already known (the probe is not run)
  const key = `unit-${Date.now()}`;
  const fakeJit = (over = {}) => ({ encodeDeclined: () => null, encodeRoom: () => true, ...over });
  const entry = { rate: RATE };
  // seed the probe cache through a real (failing) path: no ffprobe run for a
  // key that failed a moment ago — so facts are null and the copy stands alone
  const m0 = await ladder.master(entry, { key, input: path.join(os.tmpdir(), "no-such-file.mkv"), query: {}, jit: fakeJit() });
  assert.match(m0.text, /index\.m3u8\?v=copy\n$/);
  assert.equal(m0.rungs.length, 1);
  const top = await ladder.master(entry, { key, input: "x", query: { top: "h264" }, jit: fakeJit() });
  assert.equal(top.status, 404, "no size known: the full encode cannot be described");
  const busy = await ladder.master(entry, { key, input: "x", query: { top: "h264" }, jit: fakeJit({ encodeRoom: () => false }) });
  assert.equal(busy.status, 503);
  const declined = await ladder.master(entry, { key, input: "x", query: { top: "h264" }, jit: fakeJit({ encodeDeclined: () => "segment 3: …" }) });
  assert.equal(declined.status, 404);
  const q = await ladder.master(entry, { key, input: "x", query: { seg: "fmp4", vtag: "hvc1", a: "3" }, jit: fakeJit() });
  assert.match(q.text, /#EXT-X-VERSION:7/);
  assert.match(q.text, /index\.m3u8\?v=copy&seg=fmp4&vtag=hvc1&a=3\n/);
});

test("the encoder's arguments: the source's keyframes and timestamps, a stated level, a ceiling", () => {
  const rung = ladder.describe({ facts: HEVC_1080, rate: RATE }).find((r) => r.name === "h264-720");
  const a = L.encVideoArgs(rung);
  const val = (k) => a[a.indexOf(k) + 1];
  assert.equal(val("-c:v"), "libx264");
  assert.equal(val("-force_key_frames"), "source", "a keyframe wherever the source has one — the table's boundaries");
  assert.equal(val("-fps_mode"), "passthrough", "no frame dropped or duplicated");
  assert.equal(val("-enc_time_base"), "-1", "the source's own timestamps");
  assert.equal(val("-level:v"), "3.2");
  assert.equal(val("-profile:v"), "high");
  assert.equal(val("-vf"), "scale=-2:min(720\\,ih)");
  assert.equal(val("-maxrate"), "2200k");
  assert.equal(val("-bufsize"), "4400k");
  assert.equal(val("-crf"), "18");
  assert.equal(val("-threads"), String(L.ENC_THREADS));
  assert.ok(L.ENC_THREADS <= Math.max(2, os.cpus().length / 2), "two encoders must not take the whole machine");
  assert.ok(!a.includes("-bsf:v") && !a.includes("-flags:v"), "MPEG-TS needs neither");
  // a tone-mapped HDR source: the chain replaces the scale, nothing else changes
  const hdr = L.encVideoArgs(rung, { vf: "scale=-2:min(720\\,ih),zscale=…" });
  assert.equal(hdr[hdr.indexOf("-vf") + 1], "scale=-2:min(720\\,ih),zscale=…");
  assert.equal(hdr.length, a.length);
  // fMP4: parameter sets in the header, exact packet durations
  const f4 = L.encVideoArgs(rung, { fmt: "fmp4" });
  assert.equal(f4[f4.indexOf("-flags:v") + 1], "+global_header");
  assert.match(f4[f4.indexOf("-bsf:v") + 1], /^setts=pts=PTS:dts=DTS:duration=/);
});

test("encFor: audio rate per rung, essential only for the full encode", async () => {
  const rungs = ladder.describe({ facts: HEVC_1080, rate: RATE, top: "h264" });
  const top = await ladder.encFor(rungs[0], HEVC_1080);
  const low = await ladder.encFor(rungs[2], HEVC_1080);
  assert.equal(top.essential, true);
  assert.equal(top.audioRate, "192k");
  assert.equal(low.essential, false);
  assert.equal(low.audioRate, "96k");
  assert.equal(low.onExit, null, "an SDR source has no tone-map veto to arm");
});

test("names: the copy keeps its cache dir, every other rendition and audio track gets its own", () => {
  assert.equal(ladder.dirName("abc-1", "copy", null, 0), "abc-1");
  assert.equal(ladder.dirName("abc-1", "copy", "fmp4", 0), "abc-1-f4");
  assert.equal(ladder.dirName("abc-1", "h264-720", null, 0), "abc-1-h264-720");
  assert.equal(ladder.dirName("abc-1", "h264", "fmp4", 2), "abc-1-h264-f4-a2");
  assert.equal(ladder.dirName("abc-1", "copy", null, 1), "abc-1-a1");
  assert.equal(ladder.renditionFromQuery(undefined), "copy");
  assert.equal(ladder.renditionFromQuery("copy"), "copy");
  assert.equal(ladder.renditionFromQuery("h264-720"), "h264-720");
  assert.equal(ladder.renditionFromQuery("h264"), "h264");
  assert.equal(ladder.renditionFromQuery("h264-1080"), "copy", "an unknown name is the copy, as before");
  assert.equal(ladder.audioFromQuery("2"), 2);
  assert.equal(ladder.audioFromQuery("x"), 0);
  assert.equal(ladder.audioFromQuery("99"), 31);
});

// ---------- jit: what the ladder added to it ----------
test("the copy producer's command line is what it always was", () => {
  const run = { fmt: null, pdir: "P" };
  const args = J.producerArgs(run, { url: "in.mkv", extra: [], fmt: null, vtagHvc1: false }, 100);
  assert.deepEqual(args.slice(0, 20), [
    "-v", "verbose", "-nostats", "-ss", "99.000", "-i", "in.mkv",
    "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy",
    "-c:a", "aac", "-ac", "2", "-b:a", "192k", "-af",
  ]);
  // …and with the fields the ladder's routes now pass for a copy
  assert.deepEqual(J.producerArgs(run, { url: "in.mkv", extra: [], fmt: null, vtagHvc1: false, audio: 0 }, 100), args);
  const hv = J.producerArgs({ fmt: "fmp4", pdir: "P" }, { url: "in.mkv", extra: [], fmt: "fmp4", vtagHvc1: true }, null);
  assert.deepEqual(hv.slice(hv.indexOf("-c:v"), hv.indexOf("-c:a")), ["-c:v", "copy", "-tag:v", "hvc1"]);
});

test("an encoded rendition and a chosen audio track ride the same producer", () => {
  const run = { fmt: null, pdir: "P" };
  const enc = { videoArgs: ["-c:v", "libx264", "-X"], audioRate: "96k" };
  const args = J.producerArgs(run, { url: "in.mkv", extra: [], fmt: null, enc, audio: 2 }, null);
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-af")), [
    "-map", "0:v:0", "-map", "0:a:2?", "-c:v", "libx264", "-X", "-c:a", "aac", "-ac", "2", "-b:a", "96k",
  ]);
  // everything after the audio is the copy's: same clock, same one-file-per-GOP muxing
  const copy = J.producerArgs(run, { url: "in.mkv", extra: [], fmt: null }, null);
  assert.deepEqual(args.slice(args.indexOf("-af")), copy.slice(copy.indexOf("-af")));
});

test("the file's own bitrate comes from the keyframe index", () => {
  // keyframes every 2s; 1 MB per 2s, except one busy stretch at 4 MB per 2s
  const cues = [];
  let off = 1000;
  for (let i = 0; i < 30; i++) {
    cues.push({ t: i * 2, offset: off });
    off += i >= 12 && i < 15 ? 4_000_000 : 1_000_000;
  }
  const index = { durationSec: 60, cues };
  const table = J.buildTable(index);
  const r = J.sourceRate(index, table);
  assert.equal(r.peak, (12_000_000 * 8) / 6, "the busiest 6s segment");
  // the last segment has no end offset: the average is over the rest
  const last = table.length - 1;
  assert.equal(r.avg, Math.round(((cues.find((c) => c.t === table[last].start).offset - 1000) * 8) / table[last].start));
  // boundaries that share a cluster are measured together, never as 0 bytes
  const flat = { durationSec: 60, cues: cues.map((c, i) => ({ t: c.t, offset: 1000 + Math.floor(i / 6) * 6_000_000 })) };
  assert.equal(J.sourceRate(flat, J.buildTable(flat)).peak, (6_000_000 * 8) / 12);
  // offsets that make no sense give no figure
  assert.equal(J.sourceRate({ durationSec: 60, cues: cues.map((c) => ({ t: c.t, offset: 5 })) }, table), null);
});

test("encoder cap: a lower rung never takes the last slot; a sibling nobody waits on is parked", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-ladcap-"));
  const table = [{ start: 0, dur: 6 }, { start: 6, dur: 6 }];
  const dirs = [];
  let outside = 0;
  J.setOutsideEncodes(() => outside);
  const mk = (name, title, running) => {
    const d = path.join(tmp, name);
    dirs.push(d);
    const job = jit.jobFor(d, { key: title, table }, { enc: true });
    if (running) job.producers.push({ fromSeg: 0, nextSeg: 0, proc: { kill() {} } }); // a live producer, as jit keeps them
    return job;
  };
  try {
    assert.equal(J.MAX_ENCODES, 2);
    // nothing running: a courtesy rung may start
    const a720 = mk("a-720", "A", false);
    assert.equal(J.admitEncode(a720, false), true);
    assert.equal(jit.encodeRoom("A", false), true);
    // an encode elsewhere (remux / a torrent) holds a slot: the courtesy
    // rung is refused, the essential one still fits
    outside = 1;
    assert.equal(J.admitEncode(a720, false), false);
    assert.equal(jit.refusedJustNow(a720), true);
    assert.equal(jit.encodeRoom("A", false), false);
    assert.equal(J.admitEncode(a720, true), true);
    assert.equal(jit.encodeRoom("A", true), true);
    outside = 2;
    assert.equal(J.admitEncode(a720, true), false, "two encoders is the whole budget");
    outside = 0;
    // the viewer of title A switches 720 → 480: the 720 encoder (nobody is
    // waiting on it) is parked and its slot used
    const a720run = mk("a-720b", "A", true);
    const a480 = mk("a-480", "A", false);
    assert.equal(jit.encodeCount(), 1);
    assert.equal(jit.encodeRoom("A", false), true, "a sibling that would be parked does not count");
    assert.equal(J.admitEncode(a480, false), true);
    assert.equal(a720run.producers.length, 0, "parked");
    assert.equal(jit.encodeCount(), 0);
    // one that someone is still waiting on is let finish — the new level
    // starts beside it (the title holds both slots for a moment)…
    const b720 = mk("b-720", "A", true);
    b720.waiting = 1;
    assert.equal(jit.encodeRoom("A", false), true);
    assert.equal(J.admitEncode(a480, false), true);
    assert.equal(b720.producers.length, 1, "left running");
    // …but never a third: two renditions being waited on is the whole budget
    const b480 = mk("b-480", "A", true);
    b480.waiting = 1;
    assert.equal(jit.encodeRoom("A", false), false);
    assert.equal(J.admitEncode(a480, false), false);
    assert.equal(J.admitEncode(a480, true), false);
    b480.producers.length = 0;
    b720.waiting = 0;
    // another TITLE's encoder is never parked for us
    const c720 = mk("c-720", "C", false);
    assert.equal(J.admitEncode(c720, false), false);
    assert.equal(b720.producers.length, 1);
    assert.equal(J.admitEncode(c720, true), true, "the essential rung takes the second slot");
    // an encoded rendition is declined under its own key, never the copy's
    assert.equal(b720.key, "A|enc");
    assert.equal(jit.jobFor(path.join(tmp, "copy"), { key: "A", table }).key, "A");
    dirs.push(path.join(tmp, "copy"));
  } finally {
    for (const d of dirs) { const j = J.jobs.get(d); if (j) j.producers.length = 0; J.dropJob(d); }
    J.setOutsideEncodes(() => 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- the real thing ----------
const haveX264 = () => {
  if (!config.ffmpegAvailable) return false;
  try {
    return /libx264/.test(execFileSync(config.FFMPEG, ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch { return false; }
};
// 44s, 24 fps, B-frames, irregular forced keyframes, tall enough (512) to
// have a 480p rung under it, AC-3 audio in two tracks of different pitch.
const KEYS = [0, 1.5, 2.75, 7, 8.25, 9.5, 13, 20.5, 22, 23.25, 27, 28.5, 33, 34.25, 35.5, 40, 41.25];
const makeFixture = (dir) => {
  const file = path.join(dir, "fixture.mkv");
  execFileSync(config.FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=44:size=256x512:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=44:sample_rate=48000",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=44:sample_rate=48000",
    "-map", "0:v", "-map", "1:a", "-map", "2:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-bf", "2", "-g", "9999", "-keyint_min", "9999", "-sc_threshold", "0",
    "-force_key_frames", KEYS.join(","), "-pix_fmt", "yuv420p",
    "-c:a", "ac3", "-b:a", "96k", file,
  ]);
  return file;
};
const TS_OFFSET = J.TS_OFFSET_SEC;
const probePackets = (dir, seg, fmt) => {
  const input = fmt ? `concat:init.mp4|${seg}` : seg;
  return execFileSync(config.FFPROBE, ["-v", "error", "-show_entries", "packet=codec_type,pts_time,size,flags", "-of", "csv=p=0", input], { cwd: dir })
    .toString().split(/\r?\n/).filter((l) => /^(video|audio),/.test(l)).map((l) => {
      const [type, pts, size, flags] = l.split(",");
      return { type, pts: parseFloat(pts) - TS_OFFSET, size: +size, key: /K/.test(flags || "") };
    });
};
const probeStream = (dir, seg, fmt) =>
  JSON.parse(execFileSync(config.FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,level,width,height", "-of", "json", fmt ? `concat:init.mp4|${seg}` : seg], { cwd: dir }).toString()).streams[0];

for (const fmt of [null, "fmp4"]) {
  test(`real ffmpeg, ${fmt || "mpegts"}: an encoded rendition holds the copy's frames, segment for segment`, async (t) => {
    if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-ladx-"));
    J.setDeclinedFile(path.join(dir, "declined.json"));
    J.setOutsideEncodes(() => 0);
    const dirs = [];
    try {
      const file = makeFixture(dir);
      const buf = fs.readFileSync(file);
      const key = `ladfix-${fmt || "ts"}-${Date.now()}`;
      const entry = await jit.tableFor(key, async (s, l) => buf.subarray(s, s + l), buf.length);
      assert.ok(entry && entry.rate && entry.rate.peak >= entry.rate.avg, "the index gave a table and a bitrate");
      const T = entry.table;
      const facts = await ladder.probe(key, file);
      assert.equal(facts.height, 512);
      const rungs = ladder.describe({ facts, rate: entry.rate, top: "h264" });
      assert.deepEqual(rungs.map((r) => r.name), ["h264", "h264-480"]);
      const low = rungs[1];
      assert.deepEqual([low.w, low.h], [240, 480]);

      const base = { url: file, extra: [], fmt, vtagHvc1: false, audio: 0 };
      const produce = async (tag, input, enc, order) => {
        const d = path.join(dir, tag);
        dirs.push(d);
        const job = jit.jobFor(d, entry, { enc });
        if (fmt) assert.ok(await jit.ensureInit(d, job, input), `${tag}: init.mp4 (${job.broken || "ok"})`);
        for (const k of order) assert.ok(await jit.ensureSegment(d, job, input, k), `${tag}: segment ${k} (${job.broken || "ok"})`);
        return { d, job };
      };
      const all = T.map((_, k) => k);
      const copy = await produce("copy", base, false, all);
      const encInput = await ladder.encInput(base, { key, name: "h264-480", fmt, audio: 0, jit });
      assert.ok(encInput && encInput.enc && !encInput.enc.essential);
      const enc = await produce("enc", encInput, true, all); // from the top to the end
      // the same rendition started cold in the middle, and at the last segment
      const mid = await produce("enc-mid", encInput, true, [3, 4]);
      const late = await produce("enc-late", encInput, true, [T.length - 1]);

      const sig = (d, k) => {
        const pk = probePackets(d, path.basename(jit.segPath(d, k, fmt)), fmt);
        const v = pk.filter((p) => p.type === "video");
        return { v, a: pk.filter((p) => p.type === "audio"), times: v.map((p) => p.pts).sort((x, y) => x - y) };
      };
      // the same frames: as many, each within 2 ms (fMP4 moves a fragment's
      // first timestamp by up to a millisecond, see ladder.js)
      const sameFrames = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 0.002);
      let frames = 0;
      for (const k of all) {
        const c = sig(copy.d, k);
        const e = sig(enc.d, k);
        frames += e.v.length;
        assert.ok(e.v[0].key, `segment ${k}: the encode opens on a keyframe`);
        assert.ok(Math.abs(e.v[0].pts - T[k].start) <= 0.002, `segment ${k}: the encode starts at ${e.v[0].pts}, the playlist says ${T[k].start}`);
        assert.ok(sameFrames(e.times, c.times), `segment ${k}: the encode (${e.times.length} frames from ${e.times[0]}) and the copy (${c.times.length} from ${c.times[0]}) hold different frames`);
        assert.ok(e.a.length > 0, `segment ${k}: the encode carries audio`);
      }
      assert.equal(frames, 44 * 24, "every frame of the film is in exactly one segment of the encode");
      for (const [h, ks] of [[mid, [3, 4]], [late, [T.length - 1]]]) {
        for (const k of ks) assert.ok(sameFrames(sig(h.d, k).times, sig(enc.d, k).times), `segment ${k} differs when its producer started there`);
      }
      // the stream is what the master playlist says it is
      const st = probeStream(enc.d, path.basename(jit.segPath(enc.d, 2, fmt)), fmt);
      assert.equal(`${st.width}x${st.height}`, `${low.w}x${low.h}`);
      assert.equal(st.codec_name, "h264");
      assert.equal(st.profile, "High");
      assert.equal(st.level, low.level);
      // …and under its stated BANDWIDTH
      for (const k of all.slice(0, -1)) {
        const bits = fs.statSync(jit.segPath(enc.d, k, fmt)).size * 8;
        assert.ok(bits / T[k].dur <= low.bandwidth, `segment ${k}: ${Math.round(bits / T[k].dur)} bit/s over the stated ${low.bandwidth}`);
      }
      assert.equal(jit.encodeDeclined(key), null);
      assert.equal(jit.declinedReason(key), null);
    } finally {
      for (const d of dirs) J.dropJob(d);
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      J.setDeclinedFile(path.join(os.tmpdir(), "aurora-jit-declined-test.json"));
    }
  });
}

test("real ffmpeg: ?a= picks the file's other audio track, in a copy and in an encode", async (t) => {
  if (!haveX264()) return t.skip("no ffmpeg with libx264 on this machine");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-lada-"));
  J.setDeclinedFile(path.join(dir, "declined.json"));
  J.setOutsideEncodes(() => 0);
  const dirs = [];
  try {
    const file = makeFixture(dir);
    const buf = fs.readFileSync(file);
    const key = `ladaud-${Date.now()}`;
    const entry = await jit.tableFor(key, async (s, l) => buf.subarray(s, s + l), buf.length);
    // the dominant frequency of a segment's audio, by counting zero crossings
    const pitch = (seg) => {
      const pcm = execFileSync(config.FFMPEG, ["-v", "error", "-i", seg, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 24 });
      let crossings = 0;
      for (let i = 2; i + 1 < pcm.length; i += 2) if ((pcm.readInt16LE(i - 2) < 0) !== (pcm.readInt16LE(i) < 0)) crossings++;
      return crossings / 2 / (pcm.length / 2 / 8000);
    };
    const one = async (tag, input, enc) => {
      const d = path.join(dir, tag);
      dirs.push(d);
      const job = jit.jobFor(d, entry, { enc });
      const seg = await jit.ensureSegment(d, job, input, 1);
      assert.ok(seg, `${tag} (${job.broken || "ok"})`);
      return pitch(seg);
    };
    const base = (audio) => ({ url: file, extra: [], fmt: null, vtagHvc1: false, audio });
    assert.ok(Math.abs((await one("c0", base(0), false)) - 440) < 30, "track 0 is the 440 Hz one");
    assert.ok(Math.abs((await one("c1", base(1), false)) - 880) < 60, "track 1 is the 880 Hz one");
    const e1 = await ladder.encInput(base(1), { key, name: "h264-480", fmt: null, audio: 1, jit });
    assert.ok(Math.abs((await one("e1", e1, true)) - 880) < 60, "the encoded rendition carries the chosen track too");
  } finally {
    for (const d of dirs) J.dropJob(d);
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    J.setDeclinedFile(path.join(os.tmpdir(), "aurora-jit-declined-test.json"));
  }
});
