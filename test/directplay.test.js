// Direct play (/stream/video/:id) as an HTTP byte server: ranges, 416,
// validators, If-Range, HEAD, conditional GET — and the reads behind it
// (lib/diskread.js: 1 MB reads, turns per disk, fair between streams).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");

const rangeserve = require("../src/lib/rangeserve");
const diskread = require("../src/lib/diskread");
const scanner = require("../src/media/scanner");

let dir, file, mp4, server, base;
const BYTES = Buffer.alloc(3 * 1024 * 1024 + 123);
for (let i = 0; i < BYTES.length; i++) BYTES[i] = (i * 7 + (i >> 11)) & 255;
const realResolve = scanner.resolve;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-directplay-"));
  file = path.join(dir, "film.mkv");
  fs.writeFileSync(file, BYTES);
  mp4 = path.join(dir, "small.mp4"); // not a real MP4: faststart says "as it is"
  fs.writeFileSync(mp4, BYTES.subarray(0, 5000));
  scanner.resolve = (id) => (id === "film" ? { kind: "video", path: file } : id === "mp4" ? { kind: "video", path: mp4 } : id === "gone" ? { kind: "video", path: path.join(dir, "nope.mkv") } : null);
  const app = express();
  app.use(require("../src/routes/stream"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  scanner.resolve = realResolve;
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (p, headers = {}, method = "GET") => new Promise((resolve, reject) => {
  const req = http.request(base + p, { method, headers }, (res) => {
    const parts = [];
    res.on("data", (d) => parts.push(d));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  });
  req.on("error", reject);
  req.end();
});

test("parseRange: the forms a player sends, and what is ignored", () => {
  const p = rangeserve.parseRange;
  assert.deepEqual(p("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(p("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(p("bytes=900-5000", 1000), { start: 900, end: 999 });
  assert.deepEqual(p("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(p("bytes=-5000", 1000), { start: 0, end: 999 });
  assert.deepEqual(p("bytes=0-1,5-9", 1000), { start: 0, end: 1 }); // the first of several
  assert.deepEqual(p("bytes=1000-", 1000), { unsatisfiable: true });
  assert.deepEqual(p("bytes=-0", 1000), { unsatisfiable: true });
  for (const bad of [undefined, "", "bytes=", "bytes=abc", "items=0-1", "bytes=5-3", "bytes=-"]) {
    assert.deepEqual(p(bad, 1000), { none: true }, String(bad));
  }
});

test("a range is the exact bytes, with its Content-Range and validators", async () => {
  const r = await get("/stream/video/film", { Range: "bytes=1000-1048575" });
  assert.equal(r.status, 206);
  assert.equal(r.headers["content-range"], `bytes 1000-1048575/${BYTES.length}`);
  assert.equal(Number(r.headers["content-length"]), 1048576 - 1000);
  assert.ok(r.body.equals(BYTES.subarray(1000, 1048576)));
  assert.equal(r.headers["accept-ranges"], "bytes");
  assert.match(r.headers.etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
  assert.ok(r.headers["last-modified"]);
  assert.match(r.headers["cache-control"], /private/);
});

test("open-ended and whole-file reads cross many 1 MB reads intact", async () => {
  const a = await get("/stream/video/film", { Range: "bytes=7-" });
  assert.equal(a.status, 206);
  assert.ok(a.body.equals(BYTES.subarray(7)));
  const b = await get("/stream/video/film");
  assert.equal(b.status, 200);
  assert.equal(Number(b.headers["content-length"]), BYTES.length);
  assert.ok(b.body.equals(BYTES));
  const c = await get("/stream/video/film", { Range: "bytes=-10" });
  assert.ok(c.body.equals(BYTES.subarray(BYTES.length - 10)));
});

test("416 past the end; a malformed Range is ignored (200, the whole file)", async () => {
  const r = await get("/stream/video/film", { Range: `bytes=${BYTES.length}-` });
  assert.equal(r.status, 416);
  assert.equal(r.headers["content-range"], `bytes */${BYTES.length}`);
  const bad = await get("/stream/video/film", { Range: "bytes=zz" });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.length, BYTES.length);
});

test("If-Range: the same file honours the range, a changed one gets it all", async () => {
  const first = await get("/stream/video/film", { Range: "bytes=0-9" });
  const same = await get("/stream/video/film", { Range: "bytes=0-9", "If-Range": first.headers.etag });
  assert.equal(same.status, 206);
  const byDate = await get("/stream/video/film", { Range: "bytes=0-9", "If-Range": first.headers["last-modified"] });
  assert.equal(byDate.status, 206);
  const other = await get("/stream/video/film", { Range: "bytes=0-9", "If-Range": '"1-1"' });
  assert.equal(other.status, 200);
  assert.equal(other.body.length, BYTES.length);
  const weak = await get("/stream/video/film", { Range: "bytes=0-9", "If-Range": `W/${first.headers.etag}` });
  assert.equal(weak.status, 200, "a weak validator never matches If-Range");
});

test("conditional GET: 304 for the copy the client already has", async () => {
  const first = await get("/stream/video/film", { Range: "bytes=0-9" });
  const r = await get("/stream/video/film", { "If-None-Match": first.headers.etag });
  assert.equal(r.status, 304);
  assert.equal(r.body.length, 0);
  const ims = await get("/stream/video/film", { "If-Modified-Since": first.headers["last-modified"] });
  assert.equal(ims.status, 304);
});

test("HEAD answers the headers and reads nothing", async () => {
  const before = diskread.stats();
  const reads = Object.values(before).reduce((a, g) => a + g.reads, 0);
  const r = await get("/stream/video/film", { Range: "bytes=0-99" }, "HEAD");
  assert.equal(r.status, 206);
  assert.equal(Number(r.headers["content-length"]), 100);
  assert.equal(r.body.length, 0);
  const after = Object.values(diskread.stats()).reduce((a, g) => a + g.reads, 0);
  assert.equal(after, reads);
});

test("a missing file or id is 404; an MP4 goes through faststart's path", async () => {
  assert.equal((await get("/stream/video/gone")).status, 404);
  assert.equal((await get("/stream/video/none")).status, 404);
  const r = await get("/stream/video/mp4", { Range: "bytes=10-19" });
  assert.equal(r.status, 206);
  assert.ok(r.body.equals(BYTES.subarray(10, 20)));
  assert.equal(r.headers["content-type"], "video/mp4");
});

test("diskread: reads of one disk take turns, at most `limit` at once, and nobody starves", async () => {
  const dev = `test-${Date.now()}`;
  const N = 6;
  let inFlight = 0;
  let peak = 0;
  const realRead = fs.read;
  fs.read = function (fd, buf, off, len, pos, cb) {
    inFlight++;
    peak = Math.max(peak, inFlight);
    return realRead.call(fs, fd, buf, off, len, pos, (...a) => { inFlight--; cb(...a); });
  };
  try {
    const got = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
      const parts = [];
      const s = diskread.createReadStream(file, { start: i * 1000, end: i * 1000 + 2 * 1048576, highWaterMark: 256 * 1024, limit: 2, dev });
      s.on("data", (d) => parts.push(d));
      s.on("end", () => resolve(Buffer.concat(parts)));
      s.on("error", reject);
    })));
    got.forEach((b, i) => assert.ok(b.equals(BYTES.subarray(i * 1000, i * 1000 + 2 * 1048576 + 1)), `stream ${i}`));
    assert.ok(peak <= 2, `peak reads in flight ${peak}`);
    assert.ok(diskread.stats()[dev].waits > 0, "readers queued for their turn");
  } finally {
    fs.read = realRead;
  }
});

test("diskread: an early destroy closes the file; a missing file is an error", async () => {
  const s = diskread.createReadStream(file, { start: 0, end: BYTES.length - 1 });
  await new Promise((r) => s.once("data", r));
  s.destroy();
  await new Promise((r) => s.once("close", r));
  assert.equal(s.fd, null);
  const e = await new Promise((resolve) => {
    const m = diskread.createReadStream(path.join(dir, "missing.bin"), { start: 0, end: 10 });
    m.on("error", resolve);
    m.resume();
  });
  assert.equal(e.code, "ENOENT");
});

test("a client that stopped reading is let go after the stall time", async () => {
  const fakeSock = { bytesWritten: 5, destroyed: false, destroy() { this.destroyed = true; } };
  const fakeRes = { socket: fakeSock, writableEnded: false, on() {} };
  rangeserve.watch(fakeRes);
  const t = Date.now();
  rangeserve._internals.sweep(t, 1000); // first look: notes the count
  assert.equal(rangeserve._internals.sweep(t + 500, 1000), 0);
  fakeSock.bytesWritten = 10; // it read something: the clock starts again
  rangeserve._internals.sweep(t + 900, 1000);
  assert.equal(fakeSock.destroyed, false);
  assert.equal(rangeserve._internals.sweep(t + 2000, 1000), 1);
  assert.equal(fakeSock.destroyed, true);
});
