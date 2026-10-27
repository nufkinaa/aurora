// Streams carry X-Accel-Buffering: no, so an nginx in front does not read a
// whole film into its own temp files (lib/nobuffer.js); nothing else does.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const { middleware } = require("../src/lib/nobuffer");

test("streams say don't buffer; data and pictures do not", async () => {
  const app = express();
  app.use(middleware);
  app.get("*", (req, res) => res.send("ok"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = async (p) => (await fetch(base + p)).headers.get("x-accel-buffering");
    assert.equal(await h("/stream/video/abc"), "no");
    assert.equal(await h("/stream/transcode/abc/jit/seg00001.ts?v=copy"), "no");
    assert.equal(await h("/stream/torrent/hash/0"), "no");
    assert.equal(await h("/offline/file/abc"), "no");
    assert.equal(await h("/api/item/abc"), null);
    assert.equal(await h("/img/still/abc"), null);
    assert.equal(await h("/"), null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
