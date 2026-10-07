// Following a show (elia, 2026-10-07): a profile follows a title, and a new
// episode downloads by itself when it airs — and says so (lib/push.js) —
// instead of waiting for someone to be 65% through the one before
// (smartdl.js).
//
// Checked every three hours. Conservative like smart downloads: only episodes
// that aired in the last ten days, one attempt per (profile, episode) per six
// hours, never one already on disk or in the queue, and the disk gate in
// downloads.js still applies. A follow started today does not back-fill the
// show's history — it is about what comes next.
"use strict";
const identity = require("./identity");
const discover = require("./discover");
const torrent = require("./torrent");
const downloads = require("./downloads");
const profiles = require("../profiles");
const { pickSource } = require("./smartdl")._internals;

const CHECK_MS = 3 * 3600 * 1000;
const FRESH_MS = 10 * 24 * 3600 * 1000;
const RETRY_MS = 6 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const tried = new Map(); // "profile|imdb|s|e" -> last attempt

// The episodes of `meta` that aired since the follow began (a day of slack for
// time zones) and within the fresh window.
const freshEpisodes = (meta, since, now = Date.now()) =>
  (meta.seasons || [])
    .filter((s) => s.number > 0)
    .flatMap((s) => s.episodes || [])
    .filter((e) => {
      const t = e.released ? new Date(e.released).getTime() : NaN;
      return Number.isFinite(t) && t <= now && now - t <= FRESH_MS && t >= since - DAY_MS;
    });

const checkOne = async (profile, follow) => {
  const m = await discover.meta("series", follow.imdbId).catch(() => null);
  if (!m) return 0;
  let queued = 0;
  for (const ep of freshEpisodes(m, follow.at || 0)) {
    const key = `${profile.id}|${follow.imdbId}|${ep.season}|${ep.episode}`;
    if (Date.now() - (tried.get(key) || 0) < RETRY_MS) continue;
    const want = { imdbId: follow.imdbId, type: "show", title: m.title, year: m.year, season: ep.season, episode: ep.episode };
    if (identity.findLibraryPlayable(want)) continue;
    const inQueue = downloads.list().some(
      (j) =>
        j.imdbId === follow.imdbId &&
        Number(j.season) === Number(ep.season) &&
        Number(j.episode) === Number(ep.episode) &&
        !["error", "declined", "canceled"].includes(j.status),
    );
    if (inQueue) continue;
    tried.set(key, Date.now());
    const { streams } = await torrent.getSources("series", follow.imdbId, m.year, ep.season, ep.episode).catch(() => ({ streams: [] }));
    const pick = pickSource(streams, null);
    if (!pick) continue;
    const r = downloads.create({
      infoHash: pick.infoHash,
      fileIdx: pick.fileIdx || 0,
      type: "show",
      imdbId: follow.imdbId,
      title: m.title,
      label: `${m.title} · S${ep.season} E${ep.episode}`,
      year: m.year,
      poster: m.poster,
      quality: pick.quality,
      sizeBytes: pick.sizeBytes,
      season: ep.season,
      episode: ep.episode,
      provider: pick.provider,
      seeders: pick.seeders,
      profile: profile.id,
      profileName: profile.name,
      smart: true,
    });
    if (r && r.error) {
      console.warn(`[follow] could not queue ${m.title} S${ep.season}E${ep.episode}: ${r.error}`);
      continue;
    }
    if (r && r.alreadyAvailable) continue;
    queued++;
    console.log(`[follow] queued ${m.title} S${ep.season}E${ep.episode} for ${profile.name}`);
  }
  return queued;
};

let running = false;
const checkAll = async () => {
  if (running) return 0;
  running = true;
  let queued = 0;
  try {
    for (const p of profiles.list()) {
      for (const f of profiles.followsOf(p.id)) {
        queued += await checkOne(p, f).catch((e) => {
          console.warn("[follow] check failed:", e && e.message);
          return 0;
        });
      }
    }
  } finally {
    running = false;
  }
  return queued;
};

let timer = null;
const start = () => {
  if (timer) return;
  setTimeout(() => checkAll().catch(() => {}), 4 * 60 * 1000).unref();
  timer = setInterval(() => checkAll().catch(() => {}), CHECK_MS);
  timer.unref();
};

module.exports = { start, checkAll, _internals: { freshEpisodes, checkOne, FRESH_MS } };
