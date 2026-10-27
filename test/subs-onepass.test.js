// Embedded text tracks are extracted in ONE read of the file: the first
// request for any of them fills the cache for all of the file's text tracks,
// and requests for the others while that read runs wait on it instead of
// starting a read of their own (media/subtitles.js extractEmbedded). It used
// to be one whole-file ffmpeg per track — 43 at once for a series episode
// whose player fetched every track at its start. Real ffmpeg; skipped without.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const express = require("express");

const config = require("../src/config");
const HAVE_FFMPEG = !!config.FFMPEG && config.ffmpegAvailable;
const realCache = config.CACHE_DIR;
let tmp, film, server, base, subtitles, spawned;

const srt = (tag) => {
  let out = "";
  for (let i = 0, n = 1; i < 18; i += 3, n++) out += `${n}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i + 2).padStart(2, "0")},000\n${tag} line ${n}\n\n`;
  return out;
};

before(async () => {
  if (!HAVE_FFMPEG) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-subs1-"));
  config.CACHE_DIR = path.join(tmp, "cache");
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
  const subs = ["alpha", "bravo", "charlie"].map((t) => { const f = path.join(tmp, `${t}.srt`); fs.writeFileSync(f, srt(t)); return f; });
  film = path.join(tmp, "film.mkv");
  execFileSync(config.FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=10", ...subs.flatMap((s) => ["-i", s]), "-t", "20",
    "-map", "0:v", "-map", "1", "-map", "2", "-map", "3", "-c:v", "libx264", "-preset", "ultrafast", "-c:s", "srt", film], { windowsHide: true });
  subtitles = require("../src/media/subtitles");
  subtitles._deps.textTracks = () => [0, 1, 2];
  const realSpawn = subtitles._deps.spawn;
  spawned = [];
  subtitles._deps.spawn = (cmd, args, o) => { spawned.push(args.filter((a) => /^0:s:\d+$/.test(a))); return realSpawn(cmd, args, o); };
  const app = express();
  app.get("/e/:t", (req, res) => subtitles.serveEmbedded(film, parseInt(req.params.t, 10), res));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (!HAVE_FFMPEG) return;
  await new Promise((r) => server.close(r));
  config.CACHE_DIR = realCache;
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const get = (p) => new Promise((resolve, reject) => {
  http.get(base + p, (res) => {
    const parts = [];
    res.on("data", (d) => parts.push(d));
    res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString("utf8") }));
  }).on("error", reject);
});

test("three tracks asked for at once: one read of the file, each answered with its own cues", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async () => {
  spawned.length = 0;
  const [a, b, c] = await Promise.all([get("/e/0"), get("/e/1"), get("/e/2")]);
  assert.equal(spawned.length, 1, `ffmpeg runs: ${JSON.stringify(spawned)}`);
  assert.deepEqual(spawned[0], ["0:s:0", "0:s:1", "0:s:2"]);
  for (const [r, tag] of [[a, "alpha"], [b, "bravo"], [c, "charlie"]]) {
    assert.equal(r.status, 200);
    assert.match(r.text, /^WEBVTT/);
    assert.match(r.text, new RegExp(`${tag} line 1`));
    assert.doesNotMatch(r.text, /alpha|bravo|charlie/.test(tag) ? new RegExp(["alpha", "bravo", "charlie"].filter((t) => t !== tag).join("|")) : /x^/);
  }
});

test("a track of a file already read is served from the cache: no ffmpeg", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async () => {
  spawned.length = 0;
  const r = await get("/e/2");
  assert.equal(r.status, 200);
  assert.match(r.text, /charlie line 3/);
  assert.equal(spawned.length, 0);
});

test("a sibling that cannot be written (no such stream): the asked track alone, still served", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async () => {
  // a fresh cache: nothing of this file read yet
  for (const f of fs.readdirSync(path.join(config.CACHE_DIR, "vtt"))) fs.rmSync(path.join(config.CACHE_DIR, "vtt", f));
  subtitles._deps.textTracks = () => [0, 1, 7];
  spawned.length = 0;
  const r = await get("/e/1");
  assert.equal(r.status, 200);
  assert.match(r.text, /bravo line 2/);
  assert.equal(spawned.length, 2, "the combined read, then the asked track alone");
  assert.deepEqual(spawned[1], ["0:s:1"]);
  subtitles._deps.textTracks = () => [0, 1, 2];
});
