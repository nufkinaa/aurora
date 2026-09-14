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

const router = express.Router();
const LANG = { he: { code: "heb", name: /hebrew/i }, en: { code: "eng", name: /english/i } };
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
  const tracks = (await websubs.list(isEpisode ? "series" : "movie", imdbId, item.season, item.episode))
    .filter((t) => t.lang === LANG[lang].code)
    .slice(0, PER_FETCH * 2);
  if (!tracks.length) return { tracks: [] };
  const before = new Set((item.subtitles || []).map((t) => t.url));
  const { written } = await websubs.writeSidecars(tracks.slice(0, PER_FETCH), entry.path);
  if (!written.length) return { tracks: [] };
  await rescanSoon(); // sidecars get their ids here — one walk for every caller in the same moment
  const fresh = scanner.findById(id);
  const added = ((fresh && fresh.subtitles) || []).filter((t) => !before.has(t.url) && !t.embedded);
  return { tracks: added.map((t) => ({ ...t, lang })) };
};

router.post("/api/subtitles/fetch", async (req, res) => {
  const id = String((req.body || {}).id || "");
  const lang = String((req.body || {}).lang || "");
  if (!Object.hasOwn(LANG, lang)) return res.status(400).json({ error: "lang must be he or en" });
  if (!id) return res.status(400).json({ error: "id required" });
  const key = `${id}|${lang}`;
  let p = inflight.get(key);
  if (!p) {
    p = fetchFor(id, lang).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    const r = await p;
    if (r.error) return res.status(404).json(r);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message || "subtitle providers unreachable" });
  }
});

module.exports = router;
