// Shared pieces of the streaming rig (tools/streamload): a private instance
// over a folder of real films, its in-process stats, cold byte regions, and
// simulated players.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..", "..");
const SCRATCH = process.env.STREAMLOAD_WORK || path.join(os.tmpdir(), "aurora-agents", "srv-streaming");
fs.mkdirSync(SCRATCH, { recursive: true });

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = a.filter((x) => x != null).slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// ---------- the instance ----------
// `movies`: a folder of films (read-only use: the server streams and probes
// them; nothing in the folder is written by the rig). `src`: which tree's
// code to run (default this one) — before/after runs point it at a copy of
// the base commit.
const startInstance = async ({ movies, shows = null, config = {}, env = {}, verbose = false, tree = REPO } = {}) => {
  const { start } = require(path.join(tree, "scripts", "ui-test-server"));
  const statsFile = path.join(SCRATCH, `stats-${process.pid}-${Date.now()}.jsonl`);
  const emptyShows = shows || path.join(SCRATCH, "empty-shows");
  fs.mkdirSync(emptyShows, { recursive: true });
  const srv = await start({
    waitForLibrary: false,
    verbose,
    preload: [path.join(__dirname, "stats-preload.js")],
    env: { STREAMLOAD_STATS: statsFile, ...env },
    config: { libraries: { movies: [movies], shows: [emptyShows] }, ...config },
  });
  // the library is real films on a real disk: wait for every probe
  const deadline = Date.now() + 180000;
  let lib = null;
  for (;;) {
    try {
      lib = await getJson(`${srv.url}/api/library`);
      if (lib && lib.enriched && lib.movies.length && lib.movies.every((m) => m.duration > 0)) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("library not ready");
    await sleep(500);
  }
  srv.statsFile = statsFile;
  srv.films = lib.movies.map((m) => ({ id: m.id, title: m.title, duration: m.duration, size: m.sizeBytes, video: m.video, audio: m.audio, container: m.container, width: m.width, height: m.height }));
  return srv;
};

// Server stats between two moments (stats-preload.js lines).
const readStats = (file, from, to) => {
  let rows = [];
  try { rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch {}
  const inWin = rows.filter((r) => r.at >= from && r.at <= to + 1500);
  const before = rows.filter((r) => r.at < from).pop() || inWin[0];
  const last = inWin[inWin.length - 1];
  if (!before || !last) return null;
  const secs = (last.at - before.at) / 1000;
  return {
    cpuCores: round((last.cpuUs - before.cpuUs) / 1e6 / secs, 3),
    rssMaxMb: round(Math.max(...inWin.map((r) => r.rss)) / 1048576, 0),
    abMaxMb: round(Math.max(...inWin.map((r) => r.ab)) / 1048576, 0),
    lagP50: round(pct(inWin.map((r) => r.lagP50), 50), 1),
    lagP99: round(pct(inWin.map((r) => r.lagP99), 50), 1),
    lagMax: round(Math.max(...inWin.map((r) => r.lagMax)), 1),
    handlesMax: Math.max(...inWin.map((r) => r.handles || 0)),
  };
};

const getJson = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => {
    let b = "";
    res.setEncoding("utf8");
    res.on("data", (d) => (b += d));
    res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on("error", reject);
});

// ---------- cold regions ----------
// Byte ranges of each film already read by any run (kept in a file), so a
// run reads what the OS cache has most likely never held.
const regionState = (name = "regions.json") => {
  const file = path.join(SCRATCH, name);
  let read = {};
  try { read = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const taken = [];
  return {
    pick(films, bytes, rand) {
      for (let tries = 0; tries < 2000; tries++) {
        const f = films[Math.floor(rand() * films.length)];
        const span = f.size - bytes - 64 * 1048576;
        if (span <= 0) continue;
        const start = 32 * 1048576 + Math.floor((rand() * span) / 1048576) * 1048576;
        const end = start + bytes;
        const seen = read[f.id] || [];
        if (seen.some(([a, b]) => start < b && end > a)) continue;
        if (taken.some((x) => x.id === f.id && start < x.end && end > x.start)) continue;
        taken.push({ id: f.id, start, end });
        return { film: f, start };
      }
      throw new Error("no unread region left");
    },
    note(id, start, end) { (read[id] = read[id] || []).push([start, end]); },
    save() { fs.writeFileSync(file, JSON.stringify(read)); },
  };
};

const rng = (seed = 1) => {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
};

// ---------- a direct-play viewer ----------
// What a <video> element does with a progressive file, simplified: one
// open-ended Range request; playback begins once START_SEC of film is in
// hand; the player reads ahead to AHEAD_SEC and then stops reading (TCP
// backpressure reaches the server), and goes on at LOW_SEC. A stall is the
// buffer running dry while playing; play resumes at START_SEC again.
const START_SEC = 2;
const AHEAD_SEC = 30;
const LOW_SEC = 25;
const directViewer = ({ base, id, start, bytesPerSec, secs, agent }) => new Promise((resolve) => {
  const r = { startupMs: null, stalls: 0, stallMs: 0, bytes: 0, status: 0, err: null, start, id };
  const t0 = Date.now();
  let buffered = 0; // bytes in hand, not yet played
  let playing = false;
  let stalledAt = 0;
  let res = null;
  let paused = false;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    if (playing) {
      buffered -= bytesPerSec * dt;
      if (buffered <= 0) {
        buffered = 0;
        playing = false;
        r.stalls++;
        stalledAt = now;
      }
    }
    if (!playing && buffered >= START_SEC * bytesPerSec) {
      playing = true;
      if (r.startupMs == null) r.startupMs = now - t0;
      if (stalledAt) { r.stallMs += now - stalledAt; stalledAt = 0; }
    }
    if (res) {
      if (!paused && buffered >= AHEAD_SEC * bytesPerSec) { res.pause(); paused = true; }
      else if (paused && buffered < LOW_SEC * bytesPerSec) { res.resume(); paused = false; }
    }
    if (now - t0 >= secs * 1000) finish();
  }, 50);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    if (stalledAt) r.stallMs += Date.now() - stalledAt;
    if (r.startupMs == null) r.stallMs += Date.now() - t0; // never started: all of it is a stall
    try { req.destroy(); } catch {}
    resolve(r);
  };
  const req = http.get(`${base}/stream/video/${id}`, { agent, headers: { Range: `bytes=${start}-` } }, (rs) => {
    res = rs;
    r.status = rs.statusCode;
    rs.on("data", (d) => { r.bytes += d.length; buffered += d.length; });
    rs.on("end", finish);
    rs.on("error", () => finish());
  });
  req.on("error", (e) => { r.err = e.code || e.message; finish(); });
});

module.exports = { REPO, SCRATCH, arg, sleep, pct, round, startInstance, readStats, getJson, regionState, rng, directViewer };
