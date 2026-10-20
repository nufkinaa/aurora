// The subtitle Resync button and the background sync against the FILM'S
// AUDIO (media/subaudio.js) — through the REAL routes (/api/subtitles/resync,
// …/status, …/undo, /stream/subtitle/:id) in a private copy of the server
// with real files in a temp library (the trick of test/delete-inuse.test.js).
//
// The speech timeline is made here instead of by ffmpeg + the detector
// (media/speech.js is tested on its own, test/speech.test.js): "people talk"
// exactly where the RIGHT subtitle has its lines. The alignment itself is the
// real one (media/audiosync.js), run in-process.
//
// Pinned:
//   * Resync answers at once (202), reports progress, and ends with the
//     server's words; the corrected cues are served at the same address, for
//     every device, with X-Aurora-Subtitle-Repair — the file on disk never
//     changes;
//   * a subtitle that matches nothing is refused and left exactly as it was;
//   * undo gives the file's own timing back, for everyone;
//   * the background lines every sidecar up (applied only when confident),
//     and the library marks ONE ★ per language;
//   * once the audio has the last word, the older correction against the
//     video's own text track is not applied on top.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..");
let root, server, base;
let S, scanner, subaudio, audiosync, subsync;
const realFetch = global.fetch;

const call = async (method, url, body) => {
  const r = await realFetch(base + url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, headers: r.headers };
};

// a believable dialogue track, seeded: lines of 1-4 s, gaps of 0.3-5 s
const dialogue = (n, seed) => {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  let t = 8;
  for (let i = 0; i < n; i++) {
    const len = 1 + rnd() * 3;
    out.push({ start: Math.round(t * 1000) / 1000, end: Math.round((t + len) * 1000) / 1000, text: `line ${i}` });
    t += len + 0.3 + rnd() * 4.7;
  }
  return out;
};
const TRUTH = dialogue(260, 7);
const DUR = Math.ceil(TRUTH[TRUTH.length - 1].end + 30);
const shifted = (cues, d, k = 1) => cues.map((c) => ({ ...c, start: Math.round((c.start * k + d) * 1000) / 1000, end: Math.round((c.end * k + d) * 1000) / 1000 }));
const srtOf = (cues) => require(path.join(REPO, "src/media/subsync")).toSrt(cues);

// the film's speech: talk where the right lines are (a little noise around)
const speechOf = (cues) => {
  let x = 3;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const sp = new Uint8Array(DUR * 100);
  for (let i = 0; i < sp.length; i++) sp[i] = 20 + Math.floor(rnd() * 40);
  for (const c of cues) for (let i = Math.round(c.start * 100); i < Math.round(c.end * 100); i++) sp[i] = 200 + Math.floor(rnd() * 55);
  return sp;
};

let film, dir, files;
const speechCalls = [];

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-subaudio-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  const movies = path.join(root, "media", "movies");
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [movies], shows: [] }, onlineMetadata: false, prewarmStreams: false,
    autoOcrSubtitles: false, preconvert: false, notifications: {}, authMode: "open",
  }));
  global.fetch = async (url, ...rest) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, ...rest);
    throw new Error("network is not allowed in this test");
  };
  S = (p) => require(path.join(root, "src", p));
  const config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");

  dir = path.join(movies, "Talk Film (2030)");
  fs.mkdirSync(dir, { recursive: true });
  film = path.join(dir, "Talk Film (2030).mkv");
  fs.writeFileSync(film, Buffer.alloc(40000, 1));
  files = {
    heLate: path.join(dir, "Talk Film (2030).Hebrew.srt"), // 3.4 s late: Resync moves it
    heRight: path.join(dir, "Talk Film (2030).Hebrew 2.srt"), // right as it is
    hePal: path.join(dir, "Talk Film (2030).Hebrew 3.srt"), // timed for PAL, and 2 s early
    enWrong: path.join(dir, "Talk Film (2030).English.srt"), // another film's lines
  };
  fs.writeFileSync(files.heLate, srtOf(shifted(TRUTH, 3.4)));
  fs.writeFileSync(files.heRight, srtOf(TRUTH));
  fs.writeFileSync(files.hePal, srtOf(shifted(TRUTH, -2, 23.976 / 25)));
  fs.writeFileSync(files.enWrong, srtOf(dialogue(240, 99)));

  scanner = S("media/scanner");
  subaudio = S("media/subaudio");
  audiosync = S("media/audiosync");
  subsync = S("media/subsync");
  const speech = speechOf(TRUTH);
  subaudio._internals.deps.speech = () => ({
    timeline: async (videoPath, opts = {}) => {
      speechCalls.push({ videoPath, ...opts, onProgress: !!opts.onProgress });
      if (opts.onProgress) opts.onProgress(0.5);
      await new Promise((r) => setTimeout(r, 300)); // the player sees "listening"
      return { speech, cached: false, ms: 300 };
    },
    alignInWorker: async (sp, cues, opts) => audiosync.align(sp, cues, opts),
  });
  scanner.scan();
  // (server.js does this on "synced": the library learns the new verdicts)
  subaudio.events.on("synced", () => scanner.scan());

  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/subtitles"));
  app.use(S("routes/stream"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmdirSync(path.join(root, "node_modules")); } catch { try { fs.unlinkSync(path.join(root, "node_modules")); } catch {} }
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    for (let i = 0; i < 20 && fs.existsSync(root); i++) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      if (fs.existsSync(root)) await new Promise((r) => setTimeout(r, 150));
    }
  }
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

const item = () => scanner.findById(scanner.idForPath(film));
const trackOf = (file) => {
  const id = scanner.idForPath(file);
  return item().subtitles.find((t) => t.url === `/stream/subtitle/${id}`);
};
const served = async (file) => {
  const r = await realFetch(`${base}/stream/subtitle/${scanner.idForPath(file)}`);
  const text = await r.text();
  return { cues: subsync.parse(text), repair: r.headers.get("x-aurora-subtitle-repair"), cache: r.headers.get("cache-control") };
};
const until = async (body) => {
  for (let i = 0; i < 100; i++) {
    const r = await call("POST", "/api/subtitles/resync/status", body);
    if (r.body && (r.body.state === "done" || r.body.state === "failed")) return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("the resync never finished");
};
const errs = (cues) => {
  // each served cue against the right time of the same line
  const right = new Map(TRUTH.map((c) => [c.text, c.start]));
  return cues.map((c) => Math.abs(c.start - right.get(c.text))).sort((a, b) => a - b);
};

test("Resync refuses what is not this title's subtitle", async () => {
  const id = scanner.idForPath(film);
  assert.equal((await call("POST", "/api/subtitles/resync", { id: "nope", track: "/stream/subtitle/x" })).status, 404);
  const r = await call("POST", "/api/subtitles/resync", { id, track: "/stream/subtitle/notlisted" });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /not one of this title's/);
  assert.equal((await call("POST", "/api/subtitles/resync/status", { id: "nope", track: "x" })).status, 404);
});

// The same track however a player holds it (2026-10-20: a Resync during
// playback was refused for every track of a title): absolute, with a query,
// a trailing slash; a sidecar of this video even when the listing in hand
// lags behind the files; never another title's track.
test("Resync knows the title's track in every spelling a player may send, and still refuses another title's", async () => {
  const id = item().id;
  const t = trackOf(files.heRight);
  const ok = async (track) => (await call("POST", "/api/subtitles/resync/status", { id, track })).status;
  assert.equal(await ok(t.url), 200);
  assert.equal(await ok(`${base}${t.url}`), 200, "absolute, as the player loaded it");
  assert.equal(await ok(`${t.url}?profile=abc&v=3#x`), 200, "with a query");
  assert.equal(await ok(`${t.url}/`), 200, "a trailing slash");
  // the listing in hand lags behind the files (a rescan in between): a
  // sidecar of this very video is still this title's
  const it = item();
  const was = it.subtitles;
  it.subtitles = was.filter((x) => x.url !== t.url);
  try {
    assert.equal(await ok(t.url), 200);
  } finally {
    it.subtitles = was;
  }
  // another video's text track, a file that is no subtitle: refused
  const other = await call("POST", "/api/subtitles/resync/status", { id, track: "/stream/embedded/someoneelse/0" });
  assert.equal(other.status, 404);
  assert.match(other.body.error, /not one of this title's/);
  assert.equal((await call("POST", "/api/subtitles/resync/status", { id, track: `/stream/subtitle/${id}` })).status, 404, "the video itself is not a subtitle");
});

test("Resync: answers at once, says how far it is, then moves the lines to what is said — served for everyone, the file untouched", async () => {
  const before = fs.readFileSync(files.heLate);
  const t = trackOf(files.heLate);
  assert.ok(t, "the Hebrew sidecar is listed");
  const body = { id: item().id, track: t.url, audio: 0 };
  const start = await call("POST", "/api/subtitles/resync", body);
  assert.equal(start.status, 202);
  assert.equal(start.body.state, "listening");
  // a second press joins the same work
  const again = await call("POST", "/api/subtitles/resync", body);
  assert.equal(again.body.state, "listening");
  await new Promise((r) => setTimeout(r, 120));
  const mid = await call("POST", "/api/subtitles/resync/status", body);
  assert.ok(mid.body.progress > 0 && mid.body.progress < 1, `progress while listening: ${JSON.stringify(mid.body)}`);
  const done = await until(body);
  assert.equal(done.state, "done");
  assert.equal(done.verdict, "moved");
  assert.equal(done.applied, true);
  assert.match(done.words, /^Moved 3\.4 s earlier$/);
  assert.equal(speechCalls.filter((c) => c.urgent).length, 1, "one urgent listen for both presses");
  assert.equal(speechCalls[0].audio, 0);

  const s = await served(files.heLate);
  assert.match(s.repair, /^audio: Moved 3\.4 s earlier \(resync\)/);
  assert.equal(s.cache, "no-cache", "the other devices revalidate and get it");
  const e = errs(s.cues);
  assert.ok(e[Math.floor(e.length / 2)] < 0.05 && e[Math.floor(e.length * 0.9)] < 0.05, `median/p90 error ${e[Math.floor(e.length / 2)]} / ${e[Math.floor(e.length * 0.9)]}`);
  assert.deepEqual(fs.readFileSync(files.heLate), before, "the file on disk is never changed");

  const listed = trackOf(files.heLate);
  assert.equal(listed.timing.verdict, "moved");
  assert.equal(listed.timing.by, "audio");
  assert.equal(listed.timing.resync, true);
  assert.equal(done.timing.verdict, "moved");
});

test("Resync of a subtitle that matches nothing: refused, and served exactly as it was", async () => {
  const t = trackOf(files.enWrong);
  const raw = await served(files.enWrong);
  const body = { id: item().id, track: t.url };
  await call("POST", "/api/subtitles/resync", body);
  const done = await until(body);
  assert.equal(done.verdict, "unmatched");
  assert.equal(done.applied, false);
  assert.equal(done.words, "Couldn't match — kept as it was");
  const s = await served(files.enWrong);
  assert.equal(s.repair, null);
  assert.deepEqual(s.cues, raw.cues);
  assert.ok(!trackOf(files.enWrong).star, "a track that matches nothing never has the ★");
});

test("undo: the file's own timing again, for everyone", async () => {
  const t = trackOf(files.heLate);
  const r = await call("POST", "/api/subtitles/resync/undo", { id: item().id, track: t.url });
  assert.equal(r.status, 200);
  const s = await served(files.heLate);
  assert.equal(s.repair, null);
  assert.ok(Math.abs(s.cues[0].start - (TRUTH[0].start + 3.4)) < 0.01, "as the file has it");
  assert.equal(trackOf(files.heLate).timing.verdict, "original");
  // and the background leaves it so
  assert.equal(subaudio._internals.needsWork({ kind: "file", path: files.heLate }, film), false);
});

test("background: every sidecar lined up with the audio when confident, and ONE ★ per language", async () => {
  const jobs = scanner.audioSyncWork().filter((j) => j.video === film);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].hebrew, true);
  const kinds = jobs[0].subs.map((s) => path.basename(s.path)).sort();
  assert.deepEqual(kinds, ["Talk Film (2030).Hebrew 2.srt", "Talk Film (2030).Hebrew 3.srt"], "what a Resync (even a refusal) or an undo settled is left alone");
  subaudio.enqueue(jobs[0]);
  for (let i = 0; i < 100 && !subaudio.idle(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(subaudio.idle());
  scanner.scan();
  assert.equal(speechCalls.filter((c) => !c.urgent).length, 1, "one listen for the whole file");

  const right = trackOf(files.heRight);
  const pal = trackOf(files.hePal);
  assert.equal(right.timing.verdict, "in-time");
  assert.equal(pal.timing.verdict, "moved", JSON.stringify(pal.timing));
  const s = await served(files.hePal);
  assert.match(s.repair, /^audio: Matched the frame rate/);
  const e = errs(s.cues);
  assert.ok(e[Math.floor(e.length * 0.9)] < 0.06, `PAL file p90 error ${e[Math.floor(e.length * 0.9)]}`);
  const r2 = await served(files.heRight);
  assert.equal(r2.repair, null, "a file in time is served as it is");

  const he = item().subtitles.filter((t) => t.lang === "he");
  assert.deepEqual(he.filter((t) => t.star).map((t) => t.label), [right.label], "the one in time as it is has the ★");
  assert.equal(right.starWhy, "Matches this release");
  assert.equal(item().subtitles.filter((t) => t.lang === "en" && t.star).length, 0, "English matched nothing: no ★");
});

test("the audio has the last word over the older line-up against the video's own track", () => {
  const right = { kind: "file", path: files.heRight };
  assert.equal(subaudio.trackSyncAllowed(right), false, "found in time by the audio");
  assert.equal(subaudio.trackSyncAllowed({ kind: "file", path: files.heLate }), false, "undone: the file's own timing");
  assert.equal(subaudio.trackSyncAllowed({ kind: "file", path: files.enWrong }), true, "the audio could not tell");
});

test("an edited subtitle file is judged again (its result goes stale)", async () => {
  const sub = { kind: "file", path: files.hePal };
  assert.ok(subaudio.planFor(sub));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(files.hePal, later, later);
  assert.equal(subaudio.planFor(sub), null);
  assert.equal(subaudio._internals.needsWork(sub, film), true);
});
