// What the server compresses on the way out (src/lib/compressible.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const zlib = require("zlib");
const express = require("express");
const compression = require("compression");
const { filter, byType } = require("../src/lib/compressible");

test("text answers are compressed: JSON, code, styles, HLS playlists", () => {
  for (const t of [
    "application/json; charset=utf-8", "application/javascript; charset=UTF-8", "text/css", "text/html", "text/vtt",
    "image/svg+xml", "application/manifest+json",
    "application/vnd.apple.mpegurl", "application/x-mpegURL", "Application/VND.APPLE.MPEGURL",
  ]) assert.equal(byType(t), true, t);
});

test("media is never compressed: segments, films, pictures, the TV build", () => {
  for (const t of [
    "video/mp2t", "video/mp4", "video/x-matroska", "audio/mp4", "image/jpeg", "image/webp", "image/png",
    "application/vnd.android.package-archive", "application/octet-stream", "", null, undefined,
  ]) assert.equal(byType(t), false, String(t));
});

test("a range answer (206) and a client that opts out are left alone", () => {
  const res = (status, type) => ({ statusCode: status, getHeader: () => type });
  assert.equal(filter({ headers: {} }, res(200, "application/vnd.apple.mpegurl")), true);
  assert.equal(filter({ headers: {} }, res(206, "application/vnd.apple.mpegurl")), false);
  assert.equal(filter({ headers: { "x-no-compression": "1" } }, res(200, "application/json")), false);
  assert.equal(filter({ headers: {} }, res(200, "video/mp2t")), false);
});

// End to end with the middleware configured as server.js configures it: a
// full-timeline playlist goes out gzipped to a client that asks, as it is to
// one that does not, and a segment is never touched.
test("a playlist is gzipped for a client that accepts it — and only then; a segment never", async () => {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:10", "#EXT-X-PLAYLIST-TYPE:VOD"];
  for (let i = 0; i < 720; i++) lines.push("#EXTINF:10.010000,", `seg${String(i).padStart(5, "0")}.ts?v=copy`);
  lines.push("#EXT-X-ENDLIST");
  const playlist = lines.join("\n") + "\n";
  const segment = Buffer.alloc(200000, 0x47);
  const app = express();
  app.use(compression({ threshold: 1024, filter }));
  app.get("/index.m3u8", (req, res) => { res.setHeader("Content-Type", "application/vnd.apple.mpegurl"); res.send(playlist); });
  app.get("/seg.ts", (req, res) => { res.setHeader("Content-Type", "video/mp2t"); res.send(segment); });
  const server = await new Promise((r) => { const s = http.createServer(app).listen(0, "127.0.0.1", () => r(s)); });
  const get = (path, headers) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
  try {
    const gz = await get("/index.m3u8", { "Accept-Encoding": "gzip" });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.ok(gz.body.length < playlist.length / 5, `${gz.body.length} bytes on the wire for ${playlist.length}`);
    assert.equal(zlib.gunzipSync(gz.body).toString(), playlist, "the same playlist once unpacked");

    const plain = await get("/index.m3u8", {});
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.body.toString(), playlist);

    const seg = await get("/seg.ts", { "Accept-Encoding": "gzip, br" });
    assert.equal(seg.headers["content-encoding"], undefined, "a segment is sent as it is");
    assert.equal(seg.body.length, segment.length);
  } finally {
    server.close();
  }
});
