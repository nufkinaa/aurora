// The library enricher probes files WITHOUT blocking the event loop
// (media/metadata.js probeAsync, media/scanner.js enrich). The probe asks
// ffprobe the same question and must file the same answer as the blocking
// one always did; the enricher must still end with the same events, the same
// index and the same cache — it just may not hold the loop while it waits.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const config = require("../src/config");
const metadata = require("../src/media/metadata");
const scanner = require("../src/media/scanner");

const HAVE = config.ffmpegAvailable;
const skip = HAVE ? false : "ffmpeg/ffprobe not on PATH";

let root, movies, savedLibraries, clip;
const ff = (args) => cp.execFileSync(config.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
// (two copies of a file never share an mtime to the fraction of a millisecond: everything BUT the mtime must match)
const noTime = (r) => ({ ...r, mtime: 0 });

before(() => {
  if (!HAVE) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-probe-"));
  movies = path.join(root, "movies");
  fs.mkdirSync(movies, { recursive: true });
  // two seconds of H.264 + two audio tracks (one AC-3) + an embedded text subtitle
  const srt = path.join(root, "s.srt");
  fs.writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhello\n\n");
  clip = path.join(root, "clip.mkv");
  ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=2", "-i", srt,
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a:0", "aac", "-c:a:1", "ac3", "-c:s", "srt", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=heb", "-metadata:s:a:1", "title=Hebrew dub",
    "-metadata:s:s:0", "language=eng", "-shortest", clip]);
  savedLibraries = { movies: config.LIBRARIES.movies, shows: config.LIBRARIES.shows };
});

after(() => {
  if (!HAVE) return;
  config.LIBRARIES.movies = savedLibraries.movies;
  config.LIBRARIES.shows = savedLibraries.shows;
  scanner.scan();
  // forget what this test filed in the shared probe cache
  for (const k of Object.keys(metadata._store.data)) if (k.startsWith(root)) delete metadata._store.data[k];
  fs.rmSync(root, { recursive: true, force: true });
});

test("the waited-for probe files exactly what the blocking probe files", { skip }, async () => {
  const a = path.join(root, "blocking.mkv");
  const b = path.join(root, "waited.mkv");
  fs.copyFileSync(clip, a);
  fs.copyFileSync(clip, b);
  const blocking = metadata.probe(a);
  const waited = await metadata.probeAsync(b);
  assert.deepEqual(noTime(waited), noTime(blocking));
  assert.equal(waited.mtime, fs.statSync(b).mtimeMs, "filed with the file's own mtime");
  // and it is a real answer, not two empty ones
  assert.ok(waited.duration > 0.5 && waited.duration < 3);
  assert.deepEqual([waited.width, waited.height, waited.video.codec], [320, 180, "h264"]);
  assert.deepEqual(waited.audioStreams.map((s) => [s.codec, s.language, s.title, s.compatible]), [["aac", "eng", null, true], ["ac3", "heb", "Hebrew dub", false]]);
  assert.deepEqual(waited.subtitleStreams.map((s) => [s.codec, s.text, s.language]), [["subrip", true, "eng"]]);
  // filed under the path, and answered from the cache from then on (no second ffprobe)
  assert.equal(metadata.getCached(b), waited);
  const real = cp.execFile;
  cp.execFile = () => { throw new Error("a cached file must not be probed again"); };
  try { assert.equal(await metadata.probeAsync(b), waited); } finally { cp.execFile = real; }
});

test("a file ffprobe cannot read gets the same empty entry, and a missing file gets null", { skip }, async () => {
  const a = path.join(root, "junk-blocking.mkv");
  const b = path.join(root, "junk-waited.mkv");
  fs.writeFileSync(a, "this is not a video");
  fs.copyFileSync(a, b);
  const waited = await metadata.probeAsync(b);
  assert.deepEqual(noTime(waited), noTime(metadata.probe(a)));
  assert.deepEqual([waited.duration, waited.video, waited.audioStreams, waited.subtitleStreams], [0, null, [], []]);
  assert.equal(metadata.needsProbe(b), false, "cached, so it is not asked about again on every scan");
  assert.equal(await metadata.probeAsync(path.join(root, "nope.mkv")), null);
  assert.equal(metadata.probe(path.join(root, "nope.mkv")), null);
});

test("enrich: every new file probed, in order, without one blocking probe — then the same events and index", { skip }, async () => {
  const names = ["Alpha (2001)", "Beta (2002)", "Gamma (2003)"];
  for (const n of names) {
    fs.mkdirSync(path.join(movies, n), { recursive: true });
    fs.copyFileSync(clip, path.join(movies, n, `${n}.mkv`));
  }
  config.LIBRARIES.movies = [movies];
  config.LIBRARIES.shows = [];
  scanner.scan();
  assert.deepEqual(scanner.index.movies.map((m) => m.duration), [0, 0, 0], "not probed yet");

  const events = [];
  const onUpdated = () => events.push("updated");
  const infos = [];
  const onEnriched = (info) => { events.push("enriched"); infos.push(info); };
  scanner.events.on("updated", onUpdated);
  scanner.events.on("enriched", onEnriched);
  // the old enricher called the blocking probe (metadata.probe) once per file; this one must never
  const realProbe = metadata.probe;
  let blocking = 0;
  metadata.probe = (...a) => { blocking++; return realProbe(...a); };
  // while it runs, the loop must turn: a timer keeps firing between and DURING probes
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 1);
  const done = new Promise((resolve) => scanner.events.once("enriched", resolve));
  try {
    scanner.enrich();
    assert.equal(scanner.isEnriching(), true);
    scanner.enrich(); // a second call while one runs is ignored, as before
    await done;
  } finally {
    clearInterval(ticker);
    metadata.probe = realProbe;
    scanner.events.off("updated", onUpdated);
    scanner.events.off("enriched", onEnriched);
  }
  assert.equal(blocking, 0, "no blocking probe");
  assert.ok(ticks >= 3, `the event loop kept turning while ffprobe ran (${ticks} timer ticks)`);
  assert.deepEqual(events, ["updated", "enriched"], "one rebuild announced, then done");
  assert.equal(infos[0].probed, 3, "the event says how many files were probed");
  assert.equal(scanner.enrichedChanged(infos[0]), true);
  assert.equal(scanner.isEnriching(), false);
  assert.equal(scanner.index.enriched, true);
  for (const m of scanner.index.movies) {
    assert.ok(m.duration > 0.5, `${m.title} carries its duration`);
    assert.deepEqual([m.width, m.height, m.video.codec, m.audio.codec], [320, 180, "h264", "aac"]);
    assert.equal(m.audioTracks.length, 2);
    assert.deepEqual(m.subtitles.map((t) => t.embedded), [true]);
    assert.equal(metadata.needsProbe(scanner.resolve(m.id).path), false);
  }

  // nothing new: finishes at once (in the caller's turn, as it always did) and announces only "enriched"
  const again = [];
  const u2 = () => again.push("updated");
  let quiet = null;
  const e2 = (info) => { again.push("enriched"); quiet = info; };
  scanner.events.on("updated", u2);
  scanner.events.on("enriched", e2);
  try { scanner.enrich(); } finally { scanner.events.off("updated", u2); scanner.events.off("enriched", e2); }
  assert.deepEqual(again, ["enriched"]);
  // …and says it found nothing: the listeners that make every device ask again stay silent
  assert.deepEqual(quiet, { probed: 0, first: false });
  assert.equal(scanner.enrichedChanged(quiet), false);
  assert.equal(scanner.enrichedChanged({ probed: 0, first: true }), true, "the first pass since boot always counts");
  assert.equal(scanner.enrichedChanged(undefined), true, "an event with no info is treated as a change");
});
