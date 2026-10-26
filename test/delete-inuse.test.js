// No deletion pulls a file out from under a viewer — through the REAL routes,
// in a private copy of the server with real files in a temp library (the
// same trick as test/mylistdl-queue.test.js):
//
//   * a file's bytes are asked for through the real stream route
//     (/stream/video/:id, /stream/download/:id), which stamps it "in use"
//     (lib/inuse.js) — exactly what a playing player does every few seconds;
//   * the admin's per-file delete and the movie / show folder delete then
//     answer 409 with a sentence the admin page shows, and the file stays;
//   * smart cleanup (media/smartclean.js) postpones: not cleaned while it is
//     being read, cleaned on a later check once nobody is;
//   * the library tree marks it, so "Suggest what to delete" greys it out (and its delete skips it).
// The tidy-up of what My List downloads left behind has the same rule, pinned in test/mylistdl.test.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..");
const ADMIN = "private-test-admin";
let root, server, base;
let S, config, scanner, inuse, downloads, profiles, smartclean;
const realFetch = global.fetch;
const admin = { "X-Admin-Password": ADMIN };

const call = async (method, url, { body, headers = {} } = {}) => {
  const r = await realFetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json };
};
// What a player does: ask for some of the file's bytes.
const play = async (id, route = "video") => {
  const r = await realFetch(`${base}/stream/${route}/${id}`, { headers: { Range: "bytes=0-1023" } });
  await r.arrayBuffer();
  assert.ok(r.status === 206 || r.status === 200, `the stream route served ${id}: ${r.status}`);
};
// The stamp is older than the window: the player stopped minutes ago.
const stopPlaying = (id) => inuse.touch(id, Date.now() - inuse.WINDOW_MS - 1000);

let movies, shows;
const writeVideo = (p, fill) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(40000, fill)); return p; };

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-delinuse-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  movies = path.join(root, "media", "movies");
  shows = path.join(root, "media", "shows");
  fs.mkdirSync(movies, { recursive: true });
  fs.mkdirSync(shows, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [movies], shows: [shows] }, adminPassword: ADMIN,
    onlineMetadata: false, skipDatabases: false, prewarmStreams: false, autoOcrSubtitles: false,
    preconvert: false, notifications: {}, downloadMinFreePercent: 0, authMode: "open",
  }));
  global.fetch = async (url, ...rest) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, ...rest);
    throw new Error("network is not allowed in this test");
  };

  S = (p) => require(path.join(root, "src", p));
  config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  scanner = S("media/scanner");
  inuse = S("lib/inuse");
  downloads = S("media/downloads");
  profiles = S("profiles");
  smartclean = S("media/smartclean");

  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/stream"));
  app.use(S("routes/admin"));
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

const epIds = (title) => {
  const show = scanner.index.shows.find((s) => s.title === title);
  return { show, eps: show.seasons.flatMap((se) => se.episodes) };
};

test("the per-file delete refuses an episode someone is playing (409, a sentence), keeps the file, and deletes it once they stopped", async () => {
  const e1 = writeVideo(path.join(shows, "Busy Show", "Season 01", "Busy Show S01E01.mkv"), 1);
  const e2 = writeVideo(path.join(shows, "Busy Show", "Season 01", "Busy Show S01E02.mkv"), 2);
  fs.writeFileSync(path.join(shows, "Busy Show", "Season 01", "Busy Show S01E01.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
  scanner.scan();
  const id1 = scanner.idForPath(e1);
  const id2 = scanner.idForPath(e2);
  assert.ok(id1 && id2);

  await play(id1);
  assert.equal(inuse.streamingNow(id1), true, "the stream route stamped it");
  const refused = await call("DELETE", `/api/admin/library/file/${id1}`, { headers: admin });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "streaming");
  assert.match(refused.body.error, /^Someone is playing this right now — try again when they have stopped\.$/);
  assert.equal(fs.existsSync(e1), true, "the file stays");
  assert.equal(fs.existsSync(e1.replace(/\.mkv$/, ".en.srt")), true, "…with its subtitles");

  // the episode beside it, which nobody is playing, deletes as before
  const ok = await call("DELETE", `/api/admin/library/file/${id2}`, { headers: admin });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(fs.existsSync(e2), false);

  // the tree says who is busy, for "Suggest what to delete"
  const tree = await call("GET", "/api/admin/library/tree", { headers: admin });
  const row = tree.body.shows.find((s) => s.title === "Busy Show").seasons[0].episodes.find((e) => e.id === id1);
  assert.equal(row.streaming, true);

  // the whole show's folder: refused while a file in it is played
  const { show } = epIds("Busy Show");
  const folder = await call("DELETE", `/api/admin/library/show/${show.id}`, { headers: admin });
  assert.equal(folder.status, 409);
  assert.equal(folder.body.code, "streaming");
  assert.match(folder.body.error, /Someone is playing a file in this folder right now/);
  assert.equal(fs.existsSync(e1), true);

  // they stopped (the stamp is older than the window): it goes
  stopPlaying(id1);
  assert.equal((await call("GET", "/api/admin/library/tree", { headers: admin })).body.shows.find((s) => s.title === "Busy Show").seasons[0].episodes[0].streaming, false);
  const later = await call("DELETE", `/api/admin/library/file/${id1}`, { headers: admin });
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.equal(fs.existsSync(e1), false);
});

test("a film being saved for offline (/stream/download) counts as in use: its folder delete is refused, then allowed", async () => {
  const f = writeVideo(path.join(movies, "Busy Film (2020)", "Busy Film (2020).mkv"), 3);
  scanner.scan();
  const id = scanner.idForPath(f);
  assert.ok(id);
  await play(id, "download");
  const tree = await call("GET", "/api/admin/library/tree", { headers: admin });
  assert.equal(tree.body.movies.find((m) => m.id === id).streaming, true);
  const refused = await call("DELETE", `/api/admin/library/movie/${id}`, { headers: admin });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "streaming");
  assert.equal(fs.existsSync(f), true);
  stopPlaying(id);
  const ok = await call("DELETE", `/api/admin/library/movie/${id}`, { headers: admin });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(fs.existsSync(path.dirname(f)), false, "the folder is gone");
});

test("the in-use check finds a file by any spelling of its path (case on Windows), and only files inside a folder count for it", () => {
  const fileinuse = S("lib/fileinuse");
  const f = writeVideo(path.join(movies, "Spelled Film (2021)", "Spelled Film (2021).mkv"), 4);
  scanner.scan();
  const id = scanner.idForPath(f);
  inuse.touch(id);
  assert.equal(fileinuse.fileInUse(f), true);
  if (process.platform === "win32") assert.equal(fileinuse.fileInUse(f.toUpperCase()), true, "case-blind, like the file system");
  assert.equal(fileinuse.folderInUse(path.dirname(f)), true);
  assert.equal(fileinuse.folderInUse(movies), true, "the library root holds it too");
  assert.equal(fileinuse.folderInUse(path.join(movies, "Spelled Film (2021) Extras")), false, "a sibling folder with a longer name is not its folder");
  assert.equal(fileinuse.fileInUse(path.join(path.dirname(f), "Other.mkv")), false);
  stopPlaying(id);
  assert.equal(fileinuse.fileInUse(f), false);
  assert.equal(fileinuse.folderInUse(path.dirname(f)), false);
});

test("smart cleanup postpones a watched episode someone is playing, and cleans it on a later check", async () => {
  const dir = path.join(shows, "Smart Show", "Season 01");
  const ep3 = writeVideo(path.join(dir, "Smart Show S01E03.mkv"), 5);
  scanner.scan();
  const id3 = scanner.idForPath(ep3);
  assert.ok(id3);
  const dstore = downloads._internals.store;
  dstore.data.push({ id: "smart3aaaaaa", smart: true, status: "done", destPath: ep3, profile: "p-alice", imdbId: "tt0903799", season: 1, episode: 3, label: "Smart Show · S1 E3" });
  const pstore = profiles._internals.store;
  pstore.data.profiles.push({ id: "p-alice", name: "Alice", prefs: {} });
  pstore.data.state = pstore.data.state || {};
  pstore.data.state["p-alice"] = {
    progress: { "torrent|bbb|0": { position: 2650, duration: 2700, finished: true, updatedAt: 2 } },
    streamItems: { "torrent|bbb|0": { imdbId: "tt0903799", season: 1, episode: 3 } },
  };
  // Alice finished E3 and is well into E4 — but somebody (another device,
  // signed in as nobody) is playing E3 right now.
  await play(id3);
  smartclean._internals.lastRun.clear();
  let r = await smartclean.onProgress("p-alice", "torrent|ccc|0", 300, 2700, { imdbId: "tt0903799", season: 1, episode: 4 });
  assert.deepEqual(r.cleaned, []);
  assert.equal(fs.existsSync(ep3), true, "not from under a viewer");

  // later: nobody on it any more, the next check (after the throttle) cleans it
  stopPlaying(id3);
  smartclean._internals.lastRun.clear();
  r = await smartclean.onProgress("p-alice", "torrent|ccc|0", 330, 2700, { imdbId: "tt0903799", season: 1, episode: 4 });
  assert.equal(r.cleaned.length, 1);
  assert.equal(fs.existsSync(ep3), false);
});
