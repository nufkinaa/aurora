// Subtitles on demand for a library title: the player asks for a language
// its file doesn't carry, the providers (OpenSubtitles, Wizdom) are searched
// by IMDb id, the best few are written as sidecars next to the video — for
// everyone, for good — and the fresh tracks are answered so the player can
// switch one on without a reload. The library index is rebuilt so the new
// files have ids the stream route can serve.
const express = require("express");
const scanner = require("../media/scanner");
const websubs = require("../media/websubs");
const imdb = require("../media/imdb");

const metadata = require("../media/metadata");

const router = express.Router();

// The name of the release a library file came from: the torrent's own file
// name when Aurora downloaded it (downloads keep it as `release`), else the
// file's name, which for a file added by hand usually IS the release name.
const releaseOf = (videoPath) => {
  try {
    const job = require("../media/downloads").rawJobs().find((j) => j && j.destPath === videoPath && j.release);
    if (job) return job.release;
  } catch {}
  return require("path").basename(videoPath);
};
const LANG = {
  he: { code: "heb", name: /hebrew/i },
  en: { code: "eng", name: /english/i },
  ru: { code: "rus", name: /russian/i },
};
const PER_FETCH = 2; // distinct files per language, plenty for one request
const inflight = new Map(); // "<id>|<lang>" -> promise, so a double press is one fetch

// A library walk is synchronous and not free; every request that lands in
// the same 400 ms shares one, and no two ever run back to back.
let scanTimer = null;
let scanWaiters = [];
const rescanSoon = () =>
  new Promise((resolve) => {
    scanWaiters.push(resolve);
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const waiters = scanWaiters;
      scanWaiters = [];
      try { scanner.scan(); } catch {}
      for (const w of waiters) w();
    }, 400);
  });

const fetchFor = async (id, lang) => {
  const item = scanner.findById(id);
  const entry = scanner.resolve(id);
  if (!item || !entry || !entry.path) return { error: "not in the library" };
  const isEpisode = !!item.showId;
  const show = isEpisode ? scanner.findById(item.showId) : null;
  let imdbId = (show && show.imdbId) || item.imdbId || null;
  if (!imdbId) {
    try {
      imdbId = await imdb.resolve(show ? show.title : item.title, isEpisode ? "show" : "movie", (show || item).year);
    } catch {}
  }
  if (!imdbId) return { error: "no IMDb match for this title" };
  // What is being watched, so the files timed for it come first: the release
  // name the download had (its torrent's file name), else the file's own
  // name; its frame rate and length for the timing repairs.
  const facts = (await metadata.probeAsync(entry.path).catch(() => null)) || {};
  const release = releaseOf(entry.path);
  const tracks = (await websubs.list(isEpisode ? "series" : "movie", imdbId, item.season, item.episode, { release, fps: facts.video && facts.video.fps }))
    .filter((t) => t.lang === LANG[lang].code)
    .slice(0, PER_FETCH * 2);
  if (!tracks.length) return { tracks: [] };
  const before = new Set((item.subtitles || []).map((t) => t.url));
  const { written } = await websubs.writeSidecars(tracks.slice(0, PER_FETCH), entry.path, {
    facts: { fps: facts.video && facts.video.fps, duration: facts.duration },
  });
  if (!written.length) return { tracks: [] };
  await rescanSoon(); // sidecars get their ids here — one walk for every caller in the same moment
  // the fresh files are lined up against the video's own text track, if it
  // has one, in the background (media/sublang.js) — the next load of the
  // track is served in time
  try {
    const sublang = require("../media/sublang");
    for (const job of scanner.subtitleSyncWork()) if (job.path === entry.path) sublang.enqueue(job);
  } catch {}
  // …and with what is SAID in the film (media/subaudio.js), first in line:
  // somebody is about to watch it
  try {
    const subaudio = require("../media/subaudio");
    for (const job of scanner.audioSyncWork()) if (job.video === entry.path) subaudio.enqueue({ ...job, front: true });
  } catch {}
  const fresh = scanner.findById(id);
  const added = ((fresh && fresh.subtitles) || []).filter((t) => !before.has(t.url) && !t.embedded);
  return { tracks: added.map((t) => ({ ...t, lang })) };
};

router.post("/api/subtitles/fetch", async (req, res) => {
  const id = String((req.body || {}).id || "");
  const lang = String((req.body || {}).lang || "");
  if (!Object.hasOwn(LANG, lang)) return res.status(400).json({ error: "lang must be he, en or ru" });
  if (!id) return res.status(400).json({ error: "id required" });
  const key = `${id}|${lang}`;
  let p = inflight.get(key);
  if (!p) {
    p = fetchFor(id, lang).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    const r = await p;
    console.log(`[subs] fetch ${lang} for ${id.slice(0, 12)}: ${r.error ? r.error : `${(r.tracks || []).length} track(s)`}`);
    if (r.error) return res.status(404).json(r);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message || "subtitle providers unreachable" });
  }
});

// ---------- Resync: the subtitle on screen against what is said ----------
// media/subaudio.js. The player sends the title, the track's address (as the
// title lists it) and the audio track it is playing (0-based among the
// file's audio streams); this starts the alignment (or joins the one running
// for that subtitle) and answers at once. The player then asks
// /api/subtitles/resync/status with the same body until it is done, and
// reloads the track: the corrected timing is served from then on, to every
// device. /undo puts the file's own timing back, for everyone.
const subOf = (id, track) => {
  const item = scanner.findById(id);
  const entry = scanner.resolve(id);
  if (!item || !entry || !entry.path) return { error: "not in the library", status: 404 };
  const want = String(track || "").replace(/[?#].*$/, "");
  const listed = (item.subtitles || []).find((t) => t.url === want);
  if (!listed) return { error: "that subtitle is not one of this title's", status: 404 };
  const emb = /^\/stream\/embedded\/[^/]+\/(\d+)$/.exec(want);
  if (emb) return { videoPath: entry.path, sub: { kind: "emb", video: entry.path, index: Number(emb[1]) }, item, track: listed };
  const ext = /^\/stream\/subtitle\/([^/]+)$/.exec(want);
  const file = ext && scanner.resolve(ext[1]);
  if (!file || file.kind !== "subtitle" || !file.path) return { error: "that subtitle is not one of this title's", status: 404 };
  return { videoPath: entry.path, sub: { kind: "file", path: file.path }, item, track: listed };
};
const audioOf = (item, audio) => {
  const n = Number(audio);
  const count = (item.audioTracks || []).length || 1;
  return Number.isInteger(n) && n >= 0 && n < Math.max(1, count) ? n : 0;
};

router.post("/api/subtitles/resync", (req, res) => {
  const body = req.body || {};
  const r = subOf(String(body.id || ""), body.track);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const subaudio = require("../media/subaudio");
  const job = subaudio.resync({ videoPath: r.videoPath, sub: r.sub, audio: audioOf(r.item, body.audio) });
  res.status(202).json(subaudio.publicJob(job));
});

router.post("/api/subtitles/resync/status", (req, res) => {
  const body = req.body || {};
  const r = subOf(String(body.id || ""), body.track);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const subaudio = require("../media/subaudio");
  const job = subaudio.jobFor(r.sub);
  if (!job) return res.json({ state: "none", timing: subaudio.timingOf(r.sub) });
  res.json({ ...subaudio.publicJob(job), timing: subaudio.timingOf(r.sub) });
});

router.post("/api/subtitles/resync/undo", (req, res) => {
  const body = req.body || {};
  const r = subOf(String(body.id || ""), body.track);
  if (r.error) return res.status(r.status).json({ error: r.error });
  require("../media/subaudio").undo({ videoPath: r.videoPath, sub: r.sub });
  res.json({ ok: true });
});

module.exports = router;
