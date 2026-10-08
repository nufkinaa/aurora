// `"torrents": false` in config.json must switch torrents OFF, not just say so
// on the admin page: no streaming client, no download engine, no source
// lookups, clear 403s from the routes, and no health alarm about an engine
// that is off by design. And unset/true must stay exactly as it was.
//
// config.TORRENTS is flipped for one case at a time and put back; every gate
// reads it at call time (src/lib/torrentgate.js).
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");

const config = require("../src/config");
const gate = require("../src/lib/torrentgate");
const torrent = require("../src/media/torrent");
const aria2 = require("../src/media/aria2");
const downloads = require("../src/media/downloads");

const MESSAGE = "Torrents are switched off on this server.";
const HASH = "a".repeat(40);

const withTorrents = async (value, fn) => {
  const was = config.TORRENTS;
  config.TORRENTS = value;
  try { return await fn(); } finally { config.TORRENTS = was; }
};

// Any outbound request while torrents are off is a failure of the gate.
const noNetwork = async (fn) => {
  const realFetch = global.fetch;
  const asked = [];
  global.fetch = async (url) => { asked.push(String(url)); throw new Error("network is not allowed in this test"); };
  try { await fn(); } finally { global.fetch = realFetch; }
  return asked;
};

// A throwaway app carrying only the two routers under test.
const serve = async (fn) => {
  const app = express();
  app.use(express.json());
  app.use(require("../src/routes/torrent"));
  app.use(require("../src/routes/downloads"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
};

test("the switch: only an explicit false is off", async () => {
  assert.equal(gate.MESSAGE, MESSAGE);
  await withTorrents(true, () => assert.equal(gate.enabled(), true));
  await withTorrents(undefined, () => assert.equal(gate.enabled(), true));
  await withTorrents(false, () => assert.equal(gate.enabled(), false));
});

test("off: the streaming client is never built, and nothing is asked of a source provider", () =>
  withTorrents(false, async () => {
    const asked = await noNetwork(async () => {
      await assert.rejects(torrent.getClient(), { message: MESSAGE, code: "TORRENTS_OFF" });
      await assert.rejects(torrent.readyTorrent(HASH), { code: "TORRENTS_OFF" });
      await assert.rejects(torrent.getSources("movie", "tt0111161"), { code: "TORRENTS_OFF" });
      await assert.rejects(torrent.getSources("movie", "Some Title", 2020), { code: "TORRENTS_OFF" });
      torrent.warmTorrent(HASH);
    });
    assert.deepEqual(asked, [], "no Cinemeta / Torrentio request");
    assert.equal(torrent.clientIfLoaded(), null, "no WebTorrent client exists");
  }));

test("off: the download engine is never spawned and no download is accepted", () =>
  withTorrents(false, async () => {
    await assert.rejects(aria2.ensure(), { code: "TORRENTS_OFF" });
    assert.equal(aria2.running(), false);
    const store = downloads._internals.store;
    const before = JSON.stringify(store.data);
    assert.deepEqual(downloads.create({ infoHash: HASH, type: "movie", title: "Anything" }), { error: MESSAGE });
    downloads.pumpNow();
    assert.equal(JSON.stringify(store.data), before, "the queue on disk is left as it was");
    assert.equal(aria2.running(), false);
  }));

test("off: smart downloads and follows do nothing", () =>
  withTorrents(false, async () => {
    const asked = await noNetwork(async () => {
      const smart = await require("../src/media/smartdl").onProgress("nobody", "torrent|x|0", 90, 100, { imdbId: "tt1", season: 1, episode: 1 });
      assert.equal(smart, undefined);
      assert.equal(await require("../src/media/follows").checkAll(), 0);
    });
    assert.deepEqual(asked, []);
  }));

test("off: torrent and download-creating routes answer 403 with the one message", () =>
  withTorrents(false, () =>
    serve(async (base) => {
      const refused = [
        ["GET", "/api/torrents/sources?type=movie&title=tt0111161"],
        ["GET", `/api/torrents/status/${HASH}`],
        ["GET", `/api/torrents/probe/${HASH}/0`],
        ["POST", `/api/torrents/perf-mark/${HASH}`],
        ["GET", `/stream/torrent/${HASH}/0`],
        ["GET", `/stream/torrent/sub/${HASH}/1`],
        ["GET", `/stream/torrent/hls/${HASH}/0/jit/master.m3u8`],
        ["GET", `/stream/torrent/hls/${HASH}/0/jit/index.m3u8`],
        ["GET", `/stream/torrent/hls/${HASH}/0/0/index.m3u8`],
        ["GET", "/api/admin/torrents"],
        ["POST", `/api/admin/torrents/${HASH}/remove`],
        ["POST", "/api/downloads"],
      ];
      for (const [method, url] of refused) {
        const post = method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ infoHash: HASH, type: "movie", title: "X" }) }
          : {};
        const r = await fetch(base + url, { method, ...post });
        assert.equal(r.status, 403, `${method} ${url}`);
        assert.deepEqual(await r.json(), { error: MESSAGE }, `${method} ${url}`);
      }
      // the queue can still be read (and so cleared) with torrents off
      const list = await fetch(base + "/api/downloads");
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(await list.json()));
    })));

test("on: the same routes reach their handlers", () =>
  withTorrents(true, () =>
    serve(async (base) => {
      // each is answered by the handler's own validation, before any engine is touched
      const probe = await fetch(base + "/api/torrents/probe/nothex/0");
      assert.equal(probe.status, 400);
      assert.deepEqual(await probe.json(), { error: "bad hash" });
      const empty = await fetch(base + "/api/torrents/sources?type=movie&title=");
      assert.deepEqual(await empty.json(), { streams: [] });
      const bad = await fetch(base + "/api/downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ infoHash: "nope" }),
      });
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { error: "bad infoHash" });
    })));

test("off: the health watch and the healer say off, never dead engine", () =>
  withTorrents(false, async () => {
    const { decideDownloader } = require("../src/lib/health")._internals;
    // jobs still in the queue from before the switch must not raise the alarm
    const off = decideDownloader({ off: true, available: false, running: false, answering: null, waiting: 4 });
    assert.equal(off.level, "ok");
    assert.match(off.message, /switched off/);
    const h = require("../src/lib/healer")._internals;
    for (const check of [h.checkAria2, h.checkDownloads, h.checkStreaming]) {
      const r = await check();
      assert.equal(r.status, "info");
      assert.match(r.summary, /switched off/);
      assert.ok(!r.healed, "nothing is healed on an engine that is off on purpose");
    }
  }));

test("on: the downloader verdicts are what they were", () => {
  const { decideDownloader } = require("../src/lib/health")._internals;
  assert.equal(decideDownloader({ available: true, running: false, waiting: 3 }).level, "critical");
  assert.equal(decideDownloader({ available: true, running: false, waiting: 0 }).message, "idle — nothing is downloading");
});

test("server-info carries torrents:false only when they are off", async () => {
  const router = require("../src/routes/api");
  const layer = router.stack.find((l) => l.route && l.route.path === "/api/server-info");
  const ask = () => {
    let out;
    layer.route.stack[0].handle({ headers: {}, query: {} }, { json: (o) => (out = o) });
    return out;
  };
  await withTorrents(false, () => assert.strictEqual(ask().torrents, false));
  await withTorrents(true, () => assert.ok(!("torrents" in ask()), "the default answer has no new field"));
});
