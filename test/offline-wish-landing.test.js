// "Save it to this device too" end to end on the server, with REAL files:
// a wish made over HTTP (the profile routes) for a film and a whole season
// that are not in the library yet; the downloads land through the real
// downloads.js (the engine is an in-memory fake, the "torrent" files are
// short videos made by ffmpeg — the test/dl-landing.test.js rig); the wish
// turns ready, the device copy is prepared on the server with real ffmpeg (an
// MKV's Original is a repackaging), the profile's sockets are told and the
// ONE browser that asked gets its push — recorded, never sent. A cancelled
// download fails its wish. Nothing here touches the network.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const REPO = path.join(__dirname, "..");
let root, stagingRoot, S;
let downloads, D, config, wishes, offline, push, profiles;
let engine, server, base;
let T = Date.now();
const realFetch = global.fetch;
const sent = []; // what the sockets were told
const pushes = []; // what web push would have carried

const HASH = (c) => String(c).repeat(40).slice(0, 40);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, what, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const FFMPEG = (() => {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf-8" });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
  } catch { return null; }
})();
// A real, short video: H.264 + AC-3 in MKV (Original = a repackaging) or H.264 + AAC in MP4 (served as it is).
const makeVideo = (file, kind) => {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...(kind === "mkv" ? ["-c:a", "ac3", "-b:a", "96k"] : ["-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart"]), "-shortest", file];
  const r = spawnSync(FFMPEG, args, { encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
};

const makeEngine = () => {
  const torrents = new Map();
  const byGid = new Map();
  let seq = 0;
  return {
    define(infoHash, ext) {
      const dir = path.join(stagingRoot, infoHash);
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, `release.${ext}`);
      makeVideo(p, ext);
      torrents.set(infoHash, { infoHash, gid: null, state: "active", files: [{ index: 1, path: p, length: fs.statSync(p).size, completed: 0, selected: false }] });
      return fs.statSync(p).size;
    },
    finish(infoHash) { const t = torrents.get(infoHash); t.files[0].completed = t.files[0].length; },
    available: () => true,
    running: () => true,
    stagingDir: (h) => path.join(stagingRoot, h),
    fileProgress: null,
    add(magnet, infoHash, fileIndex) {
      const t = torrents.get(infoHash);
      if (!t) return Promise.reject(new Error(`unknown torrent ${infoHash}`));
      if (!t.gid) { t.gid = `gid${++seq}`; byGid.set(t.gid, t); }
      t.files.find((f) => f.index === fileIndex).selected = true;
      return Promise.resolve(t.gid);
    },
    async status(gid) {
      const t = byGid.get(gid);
      if (!t) throw new Error(`aria2.tellStatus: GID ${gid} is not found`);
      return { state: t.state, error: null, downloadSpeed: 1000, peers: 3, seeders: 3, connections: 3, infoHash: t.infoHash, files: t.files.map((f) => ({ ...f })) };
    },
    async select() { return true; },
    async remove(gid) { byGid.delete(gid); },
    async removeByInfoHash(h) { const t = torrents.get(h); if (t && t.gid) byGid.delete(t.gid); return 1; },
    async purge() {},
    applyEnginePlan: async () => ({ applied: true }),
  };
};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-wishland-"));
  stagingRoot = path.join(root, "staging");
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  const movies = path.join(root, "media", "movies");
  const shows = path.join(root, "media", "shows");
  fs.mkdirSync(movies, { recursive: true });
  fs.mkdirSync(shows, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [movies], shows: [shows] },
    onlineMetadata: false, skipDatabases: false, prewarmStreams: false, autoOcrSubtitles: false,
    preconvert: false, notifications: {}, downloadMinFreePercent: 0, authMode: "open",
  }));
  // nothing leaves this machine — a push would be a fetch to a push service
  global.fetch = async (url, opts) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, opts); // this test's own server
    throw new Error("network is not allowed in this test");
  };

  S = (p) => require(path.join(root, "src", p));
  config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  downloads = S("media/downloads");
  D = downloads._internals;
  engine = makeEngine();
  engine.fileProgress = S("media/aria2").fileProgress;
  D.setEngine(engine);
  D.seams.auto = false;
  D.seams.probe = async () => null;
  D.seams.clock = () => T;
  D.seams.load = () => ({ watching: 0, streams: 0 });
  D.seams.findSources = async () => { throw new Error("no second sources in this test"); };
  offline = S("media/offline");
  push = S("lib/push");
  push._internals.store.save = () => {};
  profiles = S("profiles");
  profiles._internals.store.data.profiles.push({ id: "p-wish", name: "Wisher", avatar: "🦊", color: "#fff" });
  wishes = S("media/offlinewish");
  // the real wiring, with the two ways out recorded instead of used
  const real = wishes._internals.realDeps();
  wishes._internals.setDeps({
    ...real,
    broadcast: (profileId, msg) => sent.push({ profileId, msg }),
    push: (profileId, key, msg) => { pushes.push({ profileId, key, msg }); return push.sendToKey(profileId, key, msg); },
  });
  // the routes, as the server mounts them
  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/profiles"));
  app.use(S("routes/api"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  global.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmdirSync(path.join(root, "node_modules")); } catch { try { fs.unlinkSync(path.join(root, "node_modules")); } catch {} }
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    for (let i = 0; i < 20 && fs.existsSync(root); i++) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      if (fs.existsSync(root)) await new Promise((r) => setTimeout(r, 150));
    }
  }
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

const call = async (method, url, body) => {
  const res = await realFetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const DEV = "web-wishlanding01";
const jobOf = (id) => downloads.rawJobs().find((j) => j.id === id);
const start = async (fields) => {
  const r = downloads.create(fields);
  assert.ok(r.job && !r.error && !r.alreadyAvailable, JSON.stringify(r));
  await flush();
  assert.ok(D.active.has(r.job.id), "the job is running");
  return r.job.id;
};
const land = async (hash, id) => {
  engine.finish(hash);
  T += 1000;
  await D.poll();
  await until(() => ["done", "error"].includes(jobOf(id).status), "the copy into the library");
  assert.equal(jobOf(id).status, "done", jobOf(id).error || "");
};
const mine = async () => (await call("GET", `/api/profiles/p-wish/offline-wishes?device=${DEV}`)).body.wishes;

test("the routes: add (checked), list per device, an unknown profile is refused, wish-options lays out the sizes before the file exists", { skip: !FFMPEG && "no ffmpeg" }, async () => {
  assert.equal((await call("POST", "/api/profiles/p-wish/offline-wishes", { deviceId: "bad", type: "movie", imdbId: "tt7700001", quality: "720" })).status, 400);
  assert.equal((await call("GET", "/api/profiles/nobody/offline-wishes")).status, 404);
  const opts = (await call("GET", "/api/offline/wish-options?type=movie&imdbId=tt7700001&duration=5400")).body;
  assert.deepEqual(opts.options.map((o) => o.quality), ["original", "1080", "720", "480"]);
  assert.ok(opts.options.every((o) => o.estimated));
  assert.ok(opts.options.find((o) => o.quality === "720").sizeBytes > 1e9, "a 90-minute film at 720p is over a gigabyte");
  const noDur = (await call("GET", "/api/offline/wish-options?type=movie&imdbId=tt7700001")).body;
  assert.match(noDur.options.find((o) => o.quality === "720").note, /GB an hour/);
});

test("a film: wish while it downloads → it lands → ready, the copy repackaged on the server, the socket told, ONE push", { skip: !FFMPEG && "no ffmpeg" }, async () => {
  const H = HASH("f");
  const size = engine.define(H, "mkv");
  const id = await start({ infoHash: H, fileIdx: 0, type: "movie", imdbId: "tt7700002", title: "Wish Film", year: 2020, quality: "1080p", sizeBytes: size, profile: "p-wish" });
  // the browser has push on: its subscription, and its key in the wish
  const EP = "https://fcm.googleapis.com/fcm/send/wish-landing-browser";
  push.subscribe("p-wish", EP, "ua");
  const key = push._internals.keyOf(EP);
  const opts = (await call("GET", "/api/offline/wish-options?type=movie&imdbId=tt7700002&duration=3")).body;
  assert.equal(opts.download.id, id, "the sheet knows the download");
  assert.equal(opts.options[0].sizeBytes, size, "Original is the download's size");
  const made = await call("POST", "/api/profiles/p-wish/offline-wishes", { deviceId: DEV, deviceName: "Test phone", type: "movie", imdbId: "tt7700002", jobId: id, title: "Wish Film", quality: "original", pushKey: key });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.wish.state, "waiting");
  assert.equal((await mine()).length, 1);
  assert.equal((await call("GET", "/api/profiles/p-wish/offline-wishes?device=web-someotherdevice")).body.wishes.length, 0);

  await land(H, id);
  // indexed, then probed: the wish turns ready by itself
  await until(async () => (await mine())[0].state === "ready", "the wish to be ready");
  const w = (await mine())[0];
  assert.ok(w.libraryId);
  assert.equal(w.readyQuality, "original");
  // the copy: an MKV with AC-3 — Original is a repackaging, made with real ffmpeg
  await until(() => offline.status(w.libraryId, "original").state === "ready", "the repackaged copy", 120000);
  const st = offline.status(w.libraryId, "original");
  assert.match(st.url, /^\/offline\/file\//);
  await until(async () => (await mine())[0].copy.state === "ready", "the wish to say its copy is ready");
  assert.ok(sent.some((s) => s.profileId === "p-wish" && s.msg.type === "offline_wish" && s.msg.wish.state === "ready"), "the profile's sockets were told");
  await until(() => pushes.length === 1, "the push");
  assert.equal(pushes[0].key, key);
  // (the download's own "ready to watch" is there too — same tag: on the phone the one replaces the other)
  const pend = push.takePending(key);
  const mineMsg = pend.find((m) => /Ready to save on this device/.test(m.body));
  assert.ok(mineMsg, JSON.stringify(pend));
  assert.equal(mineMsg.tag, `dl-${id}`);
  assert.equal(mineMsg.url, "/#/saved");
  const dl = pend.find((m) => /Downloaded and ready/.test(m.body));
  if (dl) assert.equal(dl.tag, mineMsg.tag);
  // the device saved it: the wish ends
  assert.equal((await call("POST", `/api/profiles/p-wish/offline-wishes/${w.id}/saved`)).status, 200);
  assert.equal((await mine()).length, 0);
  assert.ok(sent.some((s) => s.msg.type === "offline_wish_removed" && s.msg.id === w.id));
  // the old routes answer as they always did (the phone app 1.1.2)
  const old = (await call("GET", `/api/offline/status/${w.libraryId}?q=original`)).body;
  assert.equal(old.state, "ready");
  assert.ok(old.url && old.sizeBytes > 0);
});

test("a whole season: each episode that lands is its own ready wish; a cancelled download of a single-episode wish fails it with a sentence", { skip: !FFMPEG && "no ffmpeg" }, async () => {
  const season = (await call("POST", "/api/profiles/p-wish/offline-wishes", { deviceId: DEV, scope: "season", type: "show", imdbId: "tt7700003", season: 1, showTitle: "Wish Show", quality: "480" })).body.wish;
  assert.equal(season.state, "waiting");
  const H1 = HASH("1");
  const s1 = engine.define(H1, "mp4");
  const id1 = await start({ infoHash: H1, fileIdx: 0, type: "show", imdbId: "tt7700003", title: "Wish Show", season: 1, episode: 1, quality: "720p", sizeBytes: s1, profile: "p-wish" });
  await land(H1, id1);
  await until(async () => (await mine()).some((w) => w.parentId === season.id && w.state === "ready"), "episode 1's wish");
  const e1 = (await mine()).find((w) => w.parentId === season.id);
  assert.equal(e1.episode, 1);
  assert.equal(e1.quality, "480");
  assert.equal((await mine()).find((w) => w.id === season.id).state, "waiting", "the season wish keeps waiting");

  // an episode wished for on its own, whose download is cancelled
  const H2 = HASH("2");
  const s2 = engine.define(H2, "mp4");
  const id2 = await start({ infoHash: H2, fileIdx: 0, type: "show", imdbId: "tt7700004", title: "Other Show", season: 2, episode: 3, quality: "720p", sizeBytes: s2, profile: "p-wish" });
  const one = (await call("POST", "/api/profiles/p-wish/offline-wishes", { deviceId: DEV, type: "show", imdbId: "tt7700004", season: 2, episode: 3, quality: "720" })).body.wish;
  downloads.cancel(id2, "self");
  await flush();
  const failed = (await mine()).find((w) => w.id === one.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error, /cancelled — there is nothing to save/);
  // Dismiss
  assert.equal((await call("DELETE", `/api/profiles/p-wish/offline-wishes/${one.id}`)).status, 200);
  // Cancel the season wish: it and its unsaved episode go
  assert.equal((await call("DELETE", `/api/profiles/p-wish/offline-wishes/${season.id}`)).status, 200);
  assert.equal((await mine()).length, 0);
  // the store is on disk, in the instance's data folder
  wishes._internals.realDeps && (await new Promise((r) => setTimeout(r, 1700)));
  assert.ok(fs.existsSync(path.join(config.DATA_DIR, "offline-wishes.json")), "kept in data/offline-wishes.json");
});

test("lib/push sendToKey queues for that one browser of the profile and no other", { skip: !FFMPEG && "no ffmpeg" }, async () => {
  const A = "https://fcm.googleapis.com/fcm/send/wish-a";
  const B = "https://fcm.googleapis.com/fcm/send/wish-b";
  push.subscribe("p-wish", A, "ua");
  push.subscribe("p-wish", B, "ua");
  const ka = push._internals.keyOf(A);
  const kb = push._internals.keyOf(B);
  assert.equal(push.sendToKey("p-wish", ka, { title: "t", body: "only A" }), 1);
  assert.equal(push.sendToKey("p-other", kb, { title: "t", body: "not B's profile" }), 0);
  assert.deepEqual(push.takePending(ka).map((m) => m.body), ["only A"]);
  assert.deepEqual(push.takePending(kb), []);
});
