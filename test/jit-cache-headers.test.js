// jit segments through the real route and a real ffmpeg: a copy segment named
// for this version of the file (&m=, which the playlist puts on every URL) is
// kept by the player's cache; an encoded rendition's segment, or one asked
// for without &m=, is revalidated as before. Skipped without ffmpeg (CI).
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

const HAVE_FFMPEG = !!config.FFMPEG && config.ffmpegAvailable;
let tmp, film, server, base;
const realResolve = scanner.resolve;
const realCache = config.CACHE_DIR;

before(async () => {
  if (!HAVE_FFMPEG) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-jitcache-"));
  config.CACHE_DIR = path.join(tmp, "cache");
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
  film = path.join(tmp, "film.mkv");
  execFileSync(config.FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000",
    "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-keyint_min", "48", "-c:a", "aac", "-shortest", film], { windowsHide: true });
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
  const jit = require("../src/media/jit");
  for (const d of [...jit._internals.jobs.keys()]) jit._internals.dropJob(d);
  await new Promise((r) => server.close(r));
  config.CACHE_DIR = realCache;
  await new Promise((r) => setTimeout(r, 500)); // let the producers let go of their files
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const get = (p) => new Promise((resolve, reject) => {
  http.get(base + p, (res) => {
    const parts = [];
    res.on("data", (d) => parts.push(d));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  }).on("error", reject);
});

test("a copy segment named for this version of the file is kept; others are revalidated", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async () => {
  const pl = await get("/stream/transcode/film/jit/index.m3u8");
  assert.equal(pl.status, 200);
  const segs = pl.body.toString().split("\n").filter((l) => /^seg\d{5}\.ts/.test(l));
  assert.ok(segs.length >= 2);
  const m = /[?&]m=([0-9a-z]+)/.exec(segs[0]);
  assert.ok(m, "every segment URL names the file's version");
  assert.equal(m[1], Math.floor(fs.statSync(film).mtimeMs).toString(36));
  const kept = await get(`/stream/transcode/film/jit/${segs[1]}`);
  assert.equal(kept.status, 200);
  assert.ok(kept.body.length > 1000);
  assert.equal(kept.headers["cache-control"], "private, max-age=86400, immutable");
  const bare = await get("/stream/transcode/film/jit/seg00001.ts?v=copy");
  assert.equal(bare.status, 200);
  assert.equal(bare.headers["cache-control"], "no-cache");
  assert.ok(bare.body.equals(kept.body), "the same bytes either way");
  const stale = await get("/stream/transcode/film/jit/seg00001.ts?v=copy&m=abc");
  assert.equal(stale.headers["cache-control"], "no-cache", "a URL from another version of the file");
});
