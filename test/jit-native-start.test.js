// An iPhone's own player (native HLS) resuming a jit copy (2026-10-28, elia:
// "it took way too long to load", 7.6 s, iPhone, a cold copy).
//
// The element begins at the TOP of the film; the player's seek to the
// resume point lands only at loadedmetadata, after the first segment(s) of
// the top have been asked for, made and fetched (Chrome's own HLS: segment 0
// AND segment 1 whole, 3.9 s against 0.9 s from the top — tools/ttff/vps.js
// iphone-jit-resume), and on the server the resume point's warm-up was taken
// over for segment 0 and a third producer started back at the resume point
// (tools/ttff/ioscold.js: 3 producer starts). Now the player's address says
// where it begins (?start=&until=, playstart.js nativeStartUrl) and the
// playlist says so in HLS's own words (EXT-X-START). And the server keeps
// its own side of every start (lib/starttrace.js) for the start-up line —
// an iPhone's player shows the page none of its requests.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const express = require("express");

const config = require("../src/config");
const scanner = require("../src/media/scanner");
const jit = require("../src/media/jit");
const starttrace = require("../src/lib/starttrace");
const playmarks = require("../src/lib/playmarks");

const now = () => Math.floor(Date.now() / 1000);

// ---------- the playlist's start point (pure) ----------
test("playlistStart: a start the player named, while its `until` holds — never for an Apple TV, never past the end", () => {
  const ok = { start: "1240", until: String(now() + 300) };
  assert.equal(jit.playlistStart(ok, { durationSec: 3108 }), 1240);
  assert.equal(jit.playlistStart({ ...ok, start: "12.5" }, { durationSec: 3108 }), 12.5);
  // no start, the top, junk
  assert.equal(jit.playlistStart({}, { durationSec: 3108 }), null);
  assert.equal(jit.playlistStart({ ...ok, start: "0" }, { durationSec: 3108 }), null);
  assert.equal(jit.playlistStart({ ...ok, start: "-5" }, { durationSec: 3108 }), null);
  assert.equal(jit.playlistStart({ ...ok, start: "1e3" }, { durationSec: 3108 }), null);
  assert.equal(jit.playlistStart({ ...ok, start: ["1", "2"] }, { durationSec: 3108 }), null);
  // at (or past) the end of the film
  assert.equal(jit.playlistStart({ ...ok, start: "3108" }, { durationSec: 3108 }), null);
  // an address handed on later (AirPlay's twin) no longer carries it
  assert.equal(jit.playlistStart({ ...ok, until: String(now() - 1) }, { durationSec: 3108 }), null);
  assert.equal(jit.playlistStart({ start: "1240" }, { durationSec: 3108 }), null);
  // an `until` far off is not believed
  assert.equal(jit.playlistStart({ ...ok, until: String(now() + 24 * 3600) }, { durationSec: 3108 }), null);
  // the AirPlay receiver is put at the phone's position by AirPlay itself
  assert.equal(jit.playlistStart(ok, { durationSec: 3108, ua: "AppleCoreMedia/1.0.0.21J354 (Apple TV; U; CPU OS 17_0 like Mac OS X; en_us)" }), null);
  assert.equal(jit.playlistStart(ok, { durationSec: 3108, ua: "AppleCoreMedia/1.0.0.22H20 (iPhone; U; CPU OS 18_7 like Mac OS X; en_us)" }), 1240);
});

test("playlistText: EXT-X-START when there is a start point, and the very same playlist without one", () => {
  const entry = { table: [{ start: 0, dur: 7.007 }, { start: 7.007, dur: 10 }, { start: 17.007, dur: 9 }], durationSec: 26.007 };
  const plain = jit.playlistText(entry, "?v=copy&seg=fmp4", "fmp4");
  assert.equal(jit.playlistText(entry, "?v=copy&seg=fmp4", "fmp4", { start: null }), plain);
  assert.ok(!plain.includes("EXT-X-START"));
  const started = jit.playlistText(entry, "?v=copy&seg=fmp4", "fmp4", { start: 12 });
  const lines = started.split("\n");
  assert.equal(lines[lines.indexOf("#EXT-X-INDEPENDENT-SEGMENTS") + 1], "#EXT-X-START:TIME-OFFSET=12.000,PRECISE=YES");
  // nothing else changes: the same segments, the same names
  assert.equal(started.replace("#EXT-X-START:TIME-OFFSET=12.000,PRECISE=YES\n", ""), plain);
  // a start past the end is left out
  assert.ok(!jit.playlistText(entry, "", "fmp4", { start: 40 }).includes("EXT-X-START"));
});

test("nativeStartUrl: a jit playlist that begins further in says where, until a few minutes from now; anything else is untouched", async () => {
  const { nativeStartUrl } = await import("../public/js/playstart.js");
  const t = 1_800_000_000_000;
  assert.equal(nativeStartUrl("/stream/transcode/abc/jit/index.m3u8?seg=fmp4&vtag=hvc1", 1240.7, t), `/stream/transcode/abc/jit/index.m3u8?seg=fmp4&vtag=hvc1&start=1240&until=${t / 1000 + 300}`);
  assert.equal(nativeStartUrl("/stream/transcode/abc/jit/index.m3u8", 30, t), `/stream/transcode/abc/jit/index.m3u8?start=30&until=${t / 1000 + 300}`);
  // from the top: as it was
  assert.equal(nativeStartUrl("/stream/transcode/abc/jit/index.m3u8?seg=fmp4", 0, t), "/stream/transcode/abc/jit/index.m3u8?seg=fmp4");
  // a master, an offset job, a file: as they were
  assert.equal(nativeStartUrl("/stream/transcode/abc/jit/master.m3u8?seg=fmp4", 30, t), "/stream/transcode/abc/jit/master.m3u8?seg=fmp4");
  assert.equal(nativeStartUrl("/stream/transcode/abc/120/index.m3u8?v=copy", 30, t), "/stream/transcode/abc/120/index.m3u8?v=copy");
  assert.equal(nativeStartUrl("/stream/video/abc", 30, t), "/stream/video/abc");
});

// ---------- the server's side of a start (pure) ----------
test("starttrace: the first playlist begins a start; the first segment out, how long after and how long it waited; the top-first detour", () => {
  starttrace._reset();
  const table = [{ start: 0 }, { start: 7 }, { start: 17 }, { start: 1236 }, { start: 1244 }];
  const t0 = 1_000_000;
  starttrace.playlist({ ip: "1.2.3.4", id: "ep8", ms: 41, start: 1240, now: t0 });
  starttrace.playlist({ ip: "1.2.3.4", id: "ep8", ms: 3, now: t0 + 120 }); // the twin: the same start
  starttrace.init({ ip: "1.2.3.4", id: "ep8", now: t0 + 400 });
  starttrace.segment({ ip: "1.2.3.4", id: "ep8", k: 0, waitMs: 1500, made: true, table, now: t0 + 2100 });
  starttrace.segment({ ip: "1.2.3.4", id: "ep8", k: 3, waitMs: 300, made: false, table, now: t0 + 2600 });
  const s = starttrace.of("1.2.3.4", "ep8", { now: t0 + 5000 });
  assert.equal(s.pl, 41);
  assert.equal(s.init, 400);
  assert.equal(s.k, 0);
  assert.equal(s.segAt, 2100);
  assert.equal(s.seg, 1500);
  assert.equal(s.made, true);
  assert.equal(s.top, true);
  assert.equal(s.n, 2);
  assert.equal(s.slow, 1);
  assert.deepEqual(s.recent.map((r) => r[0]), [0, 3]);
  assert.equal(starttrace.text(s), "pl:41,init:400,seg0:2100@1500,made,top-first,n:2,slow:1");
  // another address, another title: nothing
  assert.equal(starttrace.of("5.6.7.8", "ep8", { now: t0 + 5000 }), null);
  assert.equal(starttrace.of("1.2.3.4", "ep9", { now: t0 + 5000 }), null);
  // a playlist well after: a new start (a seek's playlist within it is not)
  starttrace.playlist({ ip: "1.2.3.4", id: "ep8", ms: 2, now: t0 + starttrace.NEW_START_MS + 1 });
  const s2 = starttrace.of("1.2.3.4", "ep8", { now: t0 + starttrace.NEW_START_MS + 2 });
  assert.equal(s2.k, undefined);
  assert.equal(s2.n, 0);
  // from the top on purpose: not a detour
  starttrace._reset();
  starttrace.playlist({ ip: "1.2.3.4", id: "ep9", ms: 2, now: t0 });
  starttrace.segment({ ip: "1.2.3.4", id: "ep9", k: 0, waitMs: 200, made: true, table, now: t0 + 500 });
  assert.equal(starttrace.of("1.2.3.4", "ep9", { now: t0 + 600 }).top, undefined);
  // an old start is not handed out
  assert.equal(starttrace.of("1.2.3.4", "ep9", { now: t0 + 11 * 60 * 1000 }), null);
});

test("playmarks: a start-up keeps the server's side of it, and the admin's list hands it on", () => {
  playmarks._reset();
  playmarks.recordStart({ id: "ep8", ip: "1.2.3.4", ua: "iPhone", extra: { steps: "open:0,item:200,mount:200,decide:300,ask:300,byte:700,frame:7600", path: "jit" }, srvSide: { pl: 41, init: 400, k: 0, segAt: 2100, seg: 1500, made: true, top: true, n: 2, slow: 1, recent: [[0, 1500, 1, 3]], text: "x" } });
  const sum = playmarks.startSummary();
  assert.equal(sum.recent.length, 1);
  assert.deepEqual(sum.recent[0].srvSide, { pl: 41, init: 400, k: 0, segAt: 2100, seg: 1500, n: 2, slow: 1, made: true, top: true });
  playmarks.recordStart({ id: "ep9", ip: "1.2.3.4", extra: { steps: "ask:10,frame:7000" } });
  assert.equal(playmarks.startSummary().recent[0].srvSide, null);
  playmarks._reset();
});

// ---------- through the real route, with a real ffmpeg ----------
const HAVE_FFMPEG = !!config.FFMPEG && config.ffmpegAvailable;
let tmp, film, server, base;
const realResolve = scanner.resolve;
const realCache = config.CACHE_DIR;

before(async () => {
  if (!HAVE_FFMPEG) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-nativestart-"));
  config.CACHE_DIR = path.join(tmp, "cache");
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
  film = path.join(tmp, "film.mkv");
  execFileSync(config.FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000",
    "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-keyint_min", "48", "-c:a", "aac", "-shortest", film], { windowsHide: true });
  scanner.resolve = (id) => (id === "film" ? { kind: "video", path: film } : null);
  const app = express();
  app.use(require("../src/routes/stream"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (!HAVE_FFMPEG) return;
  scanner.resolve = realResolve;
  for (const d of [...jit._internals.jobs.keys()]) jit._internals.dropJob(d);
  await new Promise((r) => server.close(r));
  config.CACHE_DIR = realCache;
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const get = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get(base + p, { headers }, (res) => {
    const parts = [];
    res.on("data", (d) => parts.push(d));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  }).on("error", reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("route: the native player's playlist carries EXT-X-START, the server begins that segment at once, and keeps the start's server side", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async () => {
  starttrace._reset();
  const q = `seg=fmp4&start=30&until=${now() + 300}`;
  // as an Apple TV is handed it: no start point
  const tv = await get(`/stream/transcode/film/jit/index.m3u8?${q}`, { "User-Agent": "AppleCoreMedia/1.0.0.21J354 (Apple TV; U; CPU OS 17_0 like Mac OS X; en_us)" });
  assert.equal(tv.status, 200);
  assert.ok(!tv.body.toString().includes("EXT-X-START"));
  starttrace._reset();
  const pl = await get(`/stream/transcode/film/jit/index.m3u8?${q}`, { "User-Agent": "AppleCoreMedia/1.0.0.22H20 (iPhone; U; CPU OS 18_7 like Mac OS X; en_us)" });
  assert.equal(pl.status, 200);
  const text = pl.body.toString();
  assert.match(text, /^#EXT-X-START:TIME-OFFSET=30\.000,PRECISE=YES$/m);
  // the segment that holds second 30 — which the playlist's own start hint
  // (a native player sends no header) has the server making already
  const names = text.split("\n").filter((l) => /^seg\d{5}\.m4s/.test(l));
  const durs = text.split("\n").filter((l) => l.startsWith("#EXTINF:")).map((l) => parseFloat(l.slice(8)));
  let k = 0;
  for (let at = 0; k + 1 < durs.length && at + durs[k] <= 30; k++) at += durs[k];
  const warm = await get(`/stream/transcode/film/jit/${names[k].replace(/\?.*/, "")}?v=copy&seg=fmp4&warm=1`);
  assert.ok(["ready", "coming"].includes(warm.headers["x-aurora-warm"]), `the start segment is on its way (${warm.headers["x-aurora-warm"]})`);
  // the native player's own requests: init, then the start segment
  const init = await get(`/stream/transcode/film/jit/init.mp4?v=copy&seg=fmp4`);
  assert.equal(init.status, 200);
  const seg = await get(`/stream/transcode/film/jit/${names[k]}`);
  assert.equal(seg.status, 200);
  await sleep(50);
  const s = starttrace.of("127.0.0.1", "film");
  assert.ok(s, "the server kept this start");
  assert.equal(s.k, k);
  assert.ok(s.segAt >= 0 && s.init >= 0 && s.n === 1);
  assert.equal(s.top, undefined);
  // without a start point: the playlist the hls.js players have always had
  const plain = await get("/stream/transcode/film/jit/index.m3u8?seg=fmp4");
  assert.equal(plain.body.toString(), text.replace(/#EXT-X-START:[^\n]*\n/, ""));
  // an expired one: as without
  const old = await get(`/stream/transcode/film/jit/index.m3u8?seg=fmp4&start=30&until=${now() - 5}`);
  assert.ok(!old.body.toString().includes("EXT-X-START"));
});
