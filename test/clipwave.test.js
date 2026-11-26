// The Clipwave Media Server API (routes/clipwave.js) on a real private
// server: the key wall, the admin's keys, search, the library, a show's
// episodes, an item in full, subtitles as SRT, the file with Range, the
// poster, and the two ffmpeg cuts. Skipped without ffmpeg (the test library
// is made with it).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const haveFfmpeg = () => {
  try {
    const win = process.platform === "win32";
    return spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch { return false; }
};

test("clipwave API, end to end", { skip: !haveFfmpeg() && "ffmpeg not found", timeout: 240000 }, async (t) => {
  const { start } = require("../scripts/ui-test-server");
  const { makeApi } = require("./ui/helpers");
  const srv = await start();
  const api = makeApi(srv);
  const B = `${srv.url}/clipwave/v1`;
  let key = null;
  let keyId = null;
  const H = () => ({ Authorization: `Bearer ${key}` });
  const get = async (p, headers = H()) => {
    const r = await fetch(B + p, { headers });
    const type = r.headers.get("content-type") || "";
    const body = type.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, body };
  };
  try {
    await t.test("no key, a wrong key, the admin password: 401 with the error shape", async () => {
      for (const headers of [{}, { Authorization: "Bearer cw_nope" }, { Authorization: `Bearer ${srv.adminPassword}` }, { "X-Admin-Password": srv.adminPassword }]) {
        const r = await get("/ping", headers);
        assert.equal(r.status, 401);
        assert.equal(r.body.error.code, "unauthorized");
        assert.ok(r.body.error.message);
      }
    });

    await t.test("only the admin makes, lists and removes keys; a key is shown once and never stored", async () => {
      assert.equal((await api.call("POST", "/api/admin/clipwave/tokens", { name: "x" })).status, 403);
      assert.equal((await api.call("GET", "/api/admin/clipwave/tokens")).status, 403);
      const made = await api.adminPost("/api/admin/clipwave/tokens", { name: "Laptop" });
      assert.match(made.token, /^cw_[A-Za-z0-9_-]{40,}$/);
      key = made.token;
      keyId = made.entry.id;
      const list = await api.adminGet("/api/admin/clipwave/tokens");
      assert.equal(list.path, "/clipwave");
      assert.equal(list.tokens.length, 1);
      assert.equal(list.tokens[0].name, "Laptop");
      assert.equal(list.tokens[0].start, key.slice(0, 7));
      assert.ok(!JSON.stringify(list).includes(key), "the list never carries the key");
      const file = require("fs").readFileSync(path.join(srv.dataDir, "clipwave-tokens.json"), "utf-8");
      assert.ok(!file.includes(key), "only its digest is kept");
    });

    await t.test("ping: name, version, the optional endpoints", async () => {
      const r = await get("/ping");
      assert.equal(r.status, 200);
      assert.equal(r.body.apiVersion, 1);
      assert.match(r.body.serverVersion, /^\d+\.\d+\.\d+/);
      assert.ok(r.body.capabilities.includes("clip"));
      assert.equal(r.headers.get("cache-control"), "private, no-store");
      const used = (await api.adminGet("/api/admin/clipwave/tokens")).tokens[0];
      assert.ok(used.lastUsedAt, "last used is noted");
    });

    let film1 = null;
    let film2 = null;
    let show = null;
    await t.test("search: case and accents, years, type filters, SxxEyy", async () => {
      let r = await get(`/search?q=${encodeURIComponent("TÉST fílm one")}`);
      assert.equal(r.status, 200);
      film1 = r.body.items.find((i) => i.title === "Test Film One");
      assert.ok(film1, JSON.stringify(r.body));
      assert.equal(r.body.items[0].id, film1.id, "the exact title comes first");
      assert.equal(film1.type, "movie");
      assert.equal(film1.year, 2020);
      assert.ok(film1.durationS > 0);
      assert.equal(film1.posterPath, `/v1/items/${film1.id}/poster`);
      assert.equal(film1.showId, null);
      assert.ok(!("video" in film1) && !("subtitles" in film1), "a summary has no file facts");
      r = await get("/search?q=test%202021&type=movie");
      film2 = r.body.items[0];
      assert.equal(film2.title, "Test Film Two");
      r = await get("/search?q=test%20show&type=show");
      assert.equal(r.body.total, 1);
      show = r.body.items[0];
      assert.equal(show.type, "show");
      assert.equal(show.durationS, null);
      assert.equal(show.seasonCount, 1);
      assert.equal(show.episodeCount, 3);
      r = await get("/search?q=test%20show%20s01e02&type=episode");
      assert.equal(r.body.total, 1);
      assert.equal(r.body.items[0].type, "episode");
      assert.equal(r.body.items[0].season, 1);
      assert.equal(r.body.items[0].episode, 2);
      assert.equal(r.body.items[0].showId, show.id);
      r = await get("/search?q=test%20show&type=episode&limit=2");
      assert.equal(r.body.total, 3);
      assert.equal(r.body.items.length, 2);
      r = await get("/search?q=test&limit=1&offset=1");
      assert.equal(r.body.items.length, 1);
      assert.equal((await get("/search?q=zzzz-nothing")).body.total, 0);
      assert.equal((await get("/search?q=x&type=album")).status, 400);
      assert.equal((await get("/search")).body.error.code, "bad_request");
    });

    await t.test("library: films and shows, sorted and paged", async () => {
      let r = await get("/library?type=movie&sort=title&order=asc");
      assert.ok(r.body.total >= 2);
      const titles = r.body.items.map((i) => i.title);
      assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })));
      assert.ok(r.body.items.every((i) => i.type === "movie"));
      r = await get("/library?type=show");
      assert.ok(r.body.items.every((i) => i.type === "show"));
      r = await get("/library?sort=year&order=desc&limit=1");
      assert.equal(r.body.items.length, 1);
      assert.ok(r.body.total >= 3);
      assert.equal((await get("/library?sort=rating")).status, 400);
    });

    let ep2 = null;
    await t.test("a show's episodes, all or one season", async () => {
      let r = await get(`/shows/${show.id}/episodes`);
      assert.equal(r.body.total, 3);
      assert.deepEqual(r.body.items.map((e) => e.episode), [1, 2, 3]);
      ep2 = r.body.items[1];
      assert.equal(ep2.showTitle, "Test Show");
      r = await get(`/shows/${show.id}/episodes?season=2`);
      assert.equal(r.body.total, 0);
      assert.equal((await get(`/shows/${film1.id}/episodes`)).status, 404);
      assert.equal((await get("/shows/nope/episodes")).body.error.code, "not_found");
    });

    await t.test("an item in full: file facts, audio tracks, subtitles; a show is not an item", async () => {
      let r = await get(`/items/${film2.id}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.video.container, "mkv");
      assert.equal(r.body.video.codec, "h264");
      assert.ok(r.body.video.width > 0 && r.body.video.height > 0 && r.body.video.sizeBytes > 0);
      assert.equal(r.body.video.fileName, "Test Film Two (2021).mkv");
      assert.deepEqual(r.body.audioTracks.map((a) => [a.index, a.language, a.default]), [[0, "en", true], [1, "he", false]]);
      assert.ok(r.body.audioTracks.every((a) => a.codec === "ac3"));
      const emb = r.body.subtitles.filter((s) => s.source === "embedded");
      assert.deepEqual(emb.map((s) => s.id).sort(), ["e_0", "e_1"]);
      assert.ok(emb.every((s) => s.format === "srt"));
      assert.deepEqual(r.body.chapters, []);
      assert.ok("overview" in r.body);
      r = await get(`/items/${film1.id}`);
      const ext = r.body.subtitles.filter((s) => s.source === "external");
      assert.equal(ext.length, 2);
      assert.ok(ext.every((s) => /^x_[A-Za-z0-9_-]+$/.test(s.id) && s.format === "srt"));
      assert.deepEqual(ext.map((s) => s.language).sort(), ["en", "he"]);
      r = await get(`/items/${ep2.id}`);
      assert.equal(r.body.type, "episode");
      assert.equal(r.body.episode, 2);
      assert.equal(r.body.video.container, "mp4");
      assert.equal((await get(`/items/${show.id}`)).status, 400);
      assert.equal((await get("/items/nope")).status, 404);
    });

    await t.test("subtitles: SRT, from a sidecar and from the file's own track", async () => {
      const item = (await get(`/items/${film1.id}`)).body;
      const en = item.subtitles.find((s) => s.language === "en");
      let r = await get(`/items/${film1.id}/subtitles/${en.id}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /^application\/x-subrip; charset=utf-8/);
      const srt = r.body.toString("utf-8");
      assert.match(srt, /^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/);
      assert.match(srt, /EN/);
      r = await get(`/items/${film2.id}/subtitles/e_1`);
      assert.equal(r.status, 200);
      assert.match(r.body.toString("utf-8"), /HE/);
      assert.equal((await get(`/items/${film1.id}/subtitles/e_9`)).status, 404);
    });

    await t.test("the file: Range → 206, no Range → 200, past the end → 416", async () => {
      const size = (await get(`/items/${film1.id}`)).body.video.sizeBytes;
      let r = await get(`/items/${film1.id}/file`, { ...H(), Range: "bytes=0-1023" });
      assert.equal(r.status, 206);
      assert.equal(r.body.length, 1024);
      assert.equal(r.headers.get("content-range"), `bytes 0-1023/${size}`);
      assert.equal(r.headers.get("accept-ranges"), "bytes");
      assert.equal(r.headers.get("content-type"), "video/mp4");
      assert.ok(r.headers.get("etag") && r.headers.get("last-modified"));
      assert.equal(r.body.subarray(4, 8).toString("latin1"), "ftyp", "the file as it is on disk");
      r = await get(`/items/${film1.id}/file`, { ...H(), Range: `bytes=${size - 10}-` });
      assert.equal(r.status, 206);
      assert.equal(r.body.length, 10);
      r = await get(`/items/${film1.id}/file`);
      assert.equal(r.status, 200);
      assert.equal(r.body.length, size);
      r = await get(`/items/${film1.id}/file`, { ...H(), Range: `bytes=${size + 5}-` });
      assert.equal(r.status, 416);
      assert.equal(r.body.error.code, "range_not_satisfiable");
      assert.equal(r.headers.get("content-range"), `bytes */${size}`);
      r = await get(`/items/${film2.id}/file`, { ...H(), Range: "bytes=0-3" });
      assert.equal(r.headers.get("content-type"), "video/x-matroska");
      assert.equal((await get(`/items/${show.id}/file`)).status, 404);
    });

    await t.test("the poster, whole or scaled", async () => {
      let r = await get(`/items/${film1.id}/poster`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /^image\/(jpeg|png|webp)/);
      assert.ok(r.body.length > 100);
      r = await get(`/items/${film1.id}/poster?w=120`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /^image\/(jpeg|png|webp)/);
      r = await get(`/items/${ep2.id}/poster`);
      assert.equal(r.status, 200, "an episode shows its show's poster");
    });

    await t.test("clip: an MP4 of the part asked for; too long or backwards is refused", async () => {
      let r = await get(`/items/${film2.id}/clip?start=1&end=4&audioTrack=1`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "video/mp4");
      assert.ok(r.body.length > 1000);
      assert.equal(r.body.subarray(4, 8).toString("latin1"), "ftyp");
      assert.equal((await get(`/items/${film2.id}/clip?start=0&end=601`)).status, 400);
      assert.equal((await get(`/items/${film2.id}/clip?start=5&end=2`)).status, 400);
      assert.equal((await get(`/items/${film2.id}/clip?start=1&end=2&audioTrack=7`)).body.error.code, "bad_request");
    });

    await t.test("audio: the whole track as Ogg Opus (when this ffmpeg can)", async () => {
      const caps = (await get("/ping")).body.capabilities;
      if (!caps.includes("audio")) return t.diagnostic("this ffmpeg has no libopus: audio not offered");
      const r = await get(`/items/${film1.id}/audio`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "audio/ogg");
      assert.equal(r.body.subarray(0, 4).toString("latin1"), "OggS");
    });

    await t.test("anything else under /clipwave: 404 in the same shape; a removed key stops at once", async () => {
      const r = await get("/nothing-here");
      assert.equal(r.status, 404);
      assert.equal(r.body.error.code, "not_found");
      assert.equal((await api.call("DELETE", `/api/admin/clipwave/tokens/${keyId}`)).status, 403);
      assert.equal((await api.call("DELETE", `/api/admin/clipwave/tokens/${keyId}`, undefined, api.admin)).status, 200);
      assert.equal((await get("/ping")).status, 401);
      assert.equal((await api.call("DELETE", `/api/admin/clipwave/tokens/${keyId}`, undefined, api.admin)).status, 404);
    });
  } finally {
    await srv.stop();
  }
});
