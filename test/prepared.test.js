// Prepared files (src/media/prepared.js) with the REAL ffmpeg on small
// self-made files: the copy (picture copied, sound AAC) and the 1080p H.264
// come out as MP4s that play directly where the source would not, the
// device's read gets them, a replaced source never plays the old copy, a
// pause holds the conversion and a stop leaves nothing behind.
// Nothing of the server's data is touched: the prepared folder and its index
// are a temp folder here; the library is two files the test makes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const config = require("../src/config");
const scanner = require("../src/media/scanner");
const prepared = require("../src/media/prepared");
const plan = require("../src/media/overnightplan");
const playpath = require("../src/media/playpath");
const avcaps = require("../src/media/avcaps");

const HAVE_FF = !!(config.FFMPEG && config.FFPROBE);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-prepared-"));
const lib = path.join(tmp, "lib");
fs.mkdirSync(lib, { recursive: true });
const files = {};
const ff = (args) => {
  const r = spawnSync(config.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
};
const probe = (file) => JSON.parse(execFileSync(config.FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,height,pix_fmt,channels:format=format_name,duration", "-of", "json", file], { encoding: "utf-8" }));

const CHROME = avcaps.normalize({
  client: "web", model: "Chrome",
  video: { h264: { profiles: ["baseline", "main", "high"] } },
  audio: { decode: ["aac", "mp3", "opus"] },
  containers: { mp4: ["h264"], webm: [] },
});
const TV = avcaps.normalize({
  client: "tv", model: "TV",
  video: { h264: { profiles: ["high"] }, hevc: { profiles: ["main", "main10"] } },
  audio: { decode: ["aac", "ac3", "eac3"], passthrough: ["ac3"] },
  containers: { mp4: true, mkv: true },
});

let saved;
test.before(() => {
  if (!HAVE_FF) return;
  // H.264 + AC-3 in MKV: Chrome needs the sound fixed (the copy)
  files.ac3 = path.join(lib, "ac3 film.mkv");
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "ac3", "-b:a", "128k", "-shortest", files.ac3]);
  // MPEG-2 in MKV: nothing copies its picture (the h264 one) — a 12 s one, long enough to pause
  files.mpeg2 = path.join(lib, "mpeg2 film.mkv");
  ff(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=12", "-f", "lavfi", "-i", "sine=frequency=330:duration=12",
    "-c:v", "mpeg2video", "-q:v", "4", "-c:a", "ac3", "-shortest", files.mpeg2]);
  saved = { resolve: scanner.resolve, walkedStat: scanner.walkedStat };
  const ids = { ac3film0001: files.ac3, mpeg2film001: files.mpeg2 };
  scanner.resolve = (id) => (ids[id] ? { kind: "video", path: ids[id] } : null);
  scanner.walkedStat = () => null;
  prepared._internals.setDir(path.join(tmp, "prepared"));
});
test.after(() => {
  if (saved) Object.assign(scanner, saved);
  try { prepared._internals.theStore().flush(); } catch {}
  for (let i = 0; i < 20; i++) { try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } }
});

const factsOf = (codec, over = {}) => ({
  container: "mkv", width: over.width || 640, height: over.height || 360,
  video: { codec, bitDepth: 8, hdr: null, fps: 25, profile: codec === "h264" ? "High" : "Main" },
  audio: [{ index: 0, codec: "ac3", channels: 1 }],
});

test("the ffmpeg arguments: the copy copies the picture (hvc1 for HEVC), the h264 one encodes with the scale/tone map", () => {
  const c = prepared._internals.argsFor({ src: "in.mkv", tmp: "out.part", kind: "copy", codec: "hevc", audioIndex: 1, threads: 4 });
  assert.ok(c.includes("copy") && c.includes("hvc1"));
  assert.ok(c.includes("0:a:1?"), "the person's track is the one mapped");
  assert.ok(c.includes("+faststart"));
  assert.equal(c[c.indexOf("-c:a") + 1], "aac");
  const h = prepared._internals.argsFor({ src: "in.mkv", tmp: "out.part", kind: "h264", vf: "scale=-2:720", threads: 4 });
  assert.equal(h[h.indexOf("-c:v") + 1], "libx264");
  assert.equal(h[h.indexOf("-vf") + 1], "scale=-2:720");
  assert.ok(h.includes("yuv420p"));
  assert.ok(h.includes("-threads"));
});

test("a copy: H.264 + AC-3 MKV → an MP4 with the picture as it was and AAC sound; Chrome gets it, the TV does not need it", { skip: !HAVE_FF && "no ffmpeg" }, async () => {
  const facts = factsOf("h264");
  const ctl = await prepared.start({ id: "ac3film0001", kind: "copy", label: "AC3 Film", reason: "landed", persons: ["p1"], facts, audioIndex: 0, duration: 4 });
  assert.ok(!ctl.error, ctl.error);
  const r = await ctl.done;
  assert.equal(r.ok, true, JSON.stringify(r));
  const file = prepared.fileFor("ac3film0001", "copy");
  assert.ok(file && fs.existsSync(file));
  const p = probe(file);
  assert.match(p.format.format_name, /mp4/);
  assert.equal(p.streams.find((s) => s.codec_type === "video").codec_name, "h264");
  assert.equal(p.streams.find((s) => s.codec_type === "audio").codec_name, "aac");
  // faststart: the index before the media (a browser shows a frame at once)
  const head = fs.readFileSync(file).subarray(0, 4096).toString("latin1");
  assert.ok(head.indexOf("moov") > 0 && (head.indexOf("mdat") < 0 || head.indexOf("moov") < head.indexOf("mdat")), "moov first");
  // the title read: Chrome would repackage live → it gets the copy
  const original = playpath.decide(facts, CHROME);
  assert.equal(original.mode, "remux");
  const got = prepared.forItem("ac3film0001", CHROME, original);
  assert.equal(got.kind, "copy");
  assert.equal(got.url, "/stream/prepared/ac3film0001?k=copy");
  assert.equal(got.play.mode, "direct");
  // the TV plays the MKV as it is: nothing is swapped
  assert.equal(prepared.forItem("ac3film0001", TV, playpath.decide(facts, TV)), null);
  assert.equal(prepared.list().length, 1);
  assert.ok(prepared.usedBytes() > 0);
});

test("an h264 one: MPEG-2 → a 720p (never upscaled) H.264 + AAC MP4; the decision for Chrome turns into a direct start", { skip: !HAVE_FF && "no ffmpeg" }, async () => {
  const facts = factsOf("mpeg2video", { width: 1280, height: 720 });
  const pf = playpath.factsOfItem({ container: "mkv", width: 1280, height: 720, video: { codec: "mpeg2video", bitDepth: 8 }, audio: { codec: "ac3", channels: 1 } });
  assert.equal(playpath.decide(pf, CHROME).mode, "transcode");
  const ctl = await prepared.start({ id: "mpeg2film001", kind: "h264", label: "MPEG-2 Film", reason: "next", persons: ["p1"], facts: pf, audioIndex: 0, duration: 12, episode: true });
  assert.ok(!ctl.error, ctl.error);
  const r = await ctl.done;
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = probe(prepared.fileFor("mpeg2film001", "h264"));
  const v = p.streams.find((s) => s.codec_type === "video");
  assert.equal(v.codec_name, "h264");
  assert.equal(v.height, 720);
  assert.equal(v.pix_fmt, "yuv420p");
  assert.equal(p.streams.find((s) => s.codec_type === "audio").codec_name, "aac");
  const got = prepared.forItem("mpeg2film001", CHROME, playpath.decide(pf, CHROME));
  assert.equal(got.kind, "h264");
  assert.equal(got.height, 720);
  void facts;
});

test("a replaced source never plays the old copy, and the clean-up rule says so", { skip: !HAVE_FF && "no ffmpeg" }, async () => {
  const before = prepared.sourceOf("ac3film0001");
  const future = new Date(Date.now() + 60 * 1000);
  fs.utimesSync(files.ac3, future, future);
  assert.equal(prepared.fileFor("ac3film0001", "copy"), null);
  assert.deepEqual(prepared.ready("ac3film0001"), []);
  const items = prepared.list();
  const out = plan.cleanup(items, { mtimeOf: (id) => (prepared.sourceOf(id) || {}).mtime ?? null, finished: () => false, partWay: () => false, playing: () => false, wanted: new Set() });
  assert.deepEqual(out.map((x) => x.key), ["ac3film0001|copy"]);
  const freed = prepared.remove("ac3film0001|copy", out[0].why);
  assert.ok(freed > 0);
  assert.equal(prepared.list().length, 1);
  fs.utimesSync(files.ac3, new Date(before.mtime), new Date(before.mtime));
});

test("pause holds the conversion, resume lets it finish; stop leaves no file behind", { skip: !HAVE_FF && "no ffmpeg" }, async () => {
  const pf = playpath.factsOfItem({ container: "mkv", width: 1280, height: 720, video: { codec: "mpeg2video", bitDepth: 8 }, audio: { codec: "ac3", channels: 1 } });
  prepared.remove("mpeg2film001|h264");
  // a slow encode: one thread, so there is time to pause it
  const ctl = await prepared.start({ id: "mpeg2film001", kind: "h264", label: "MPEG-2 Film", persons: ["p1"], facts: pf, duration: 12 }, { threads: 1 });
  assert.ok(!ctl.error, ctl.error);
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); } };
  await until(() => ctl.progress() > 0.02 || ctl.progress() >= 0.99);
  const paused = await ctl.pause();
  assert.equal(paused, true, "the process could be paused");
  const at = ctl.progress();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(ctl.progress(), at, "nothing moves while paused");
  assert.equal(ctl.paused(), true);
  await ctl.resume();
  const r = await ctl.done;
  assert.equal(r.ok, true, JSON.stringify(r));
  // …and a stop: nothing is kept, not even the .part
  prepared.remove("mpeg2film001|h264");
  const ctl2 = await prepared.start({ id: "mpeg2film001", kind: "h264", label: "MPEG-2 Film", persons: ["p1"], facts: pf, duration: 12 }, { threads: 1 });
  await until(() => ctl2.progress() > 0);
  ctl2.stop("someone started watching");
  const r2 = await ctl2.done;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopped, "someone started watching");
  assert.equal(prepared.fileFor("mpeg2film001", "h264"), null);
  assert.deepEqual(fs.readdirSync(prepared.DIR).filter((n) => n.endsWith(".mp4") || n.endsWith(".part")), []);
});

test("a title gone from the library cannot be made; a stray file in the folder is tidied", { skip: !HAVE_FF && "no ffmpeg" }, async () => {
  const r = await prepared.start({ id: "nosuchtitle1", kind: "copy", facts: factsOf("h264") });
  assert.match(r.error, /no longer in the library/);
  fs.writeFileSync(path.join(prepared.DIR, "stray-1-copy.mp4.part"), "x");
  fs.writeFileSync(path.join(prepared.DIR, "unknown-1-h264.mp4"), "x");
  const t = prepared.reconcile();
  assert.equal(t.removed, 2);
});

test("an HDR10 source: the h264 one is tone mapped to SDR (bt709), never a grey 10-bit fold", { skip: !HAVE_FF && "no ffmpeg" }, async () => {
  const hdr = path.join(lib, "hdr film.mkv");
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=500:duration=1",
    "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
    "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-c:a", "ac3", "-shortest", hdr]);
  const prevResolve = scanner.resolve;
  scanner.resolve = (id) => (id === "hdrfilm00001" ? { kind: "video", path: hdr } : prevResolve(id));
  try {
    const pf = playpath.factsOfItem({ container: "mkv", width: 640, height: 360, video: { codec: "hevc", bitDepth: 10, hdr: "hdr10", profile: "Main 10" }, audio: { codec: "ac3", channels: 1 } });
    // (the lowest priority there is: on a machine other work keeps busy this
    // waits for idle cores — kept tiny so the test does not wait long)
    const ctl = await prepared.start({ id: "hdrfilm00001", kind: "h264", label: "HDR Film", persons: ["p1"], facts: pf, duration: 1 });
    if (ctl.error && /tone map/.test(ctl.error)) return; // (an ffmpeg without zscale: refused, as it should be)
    assert.ok(!ctl.error, ctl.error);
    const r = await ctl.done;
    assert.equal(r.ok, true, JSON.stringify(r));
    const out = prepared.fileFor("hdrfilm00001", "h264");
    const j = JSON.parse(execFileSync(config.FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,color_transfer,color_primaries", "-of", "json", out], { encoding: "utf-8" })).streams[0];
    assert.equal(j.codec_name, "h264");
    assert.equal(j.pix_fmt, "yuv420p");
    assert.notEqual(j.color_transfer, "smpte2084", "no PQ tag left on an 8-bit picture");
  } finally {
    scanner.resolve = prevResolve;
  }
});
