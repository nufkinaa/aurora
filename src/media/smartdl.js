// Smart downloads: when someone is most of the way through an episode, the
// next one starts downloading for them — so by the time this one ends, the
// next plays from disk instead of hunting for peers.
//
// Fired from the progress route. Conservative on purpose: one attempt per
// (profile, episode) per six hours, never for a title the person didn't
// come from, never when the next episode is already on disk or already in
// the queue, never past the last aired episode, and the disk gate in
// downloads.js still applies (a tight drive turns it into an approval
// request rather than a download). Per-profile switch: prefs.smartDownloads
// (on unless turned off in Preferences).
const scanner = require("./scanner");
const identity = require("./identity");
const discover = require("./discover");
const torrent = require("./torrent");
const downloads = require("./downloads");
const profiles = require("../profiles");

const THRESHOLD = 0.65;
const RETRY_MS = 6 * 3600 * 1000;
const tried = new Map(); // "profile|imdbId|s|e" -> last attempt

const QUALITY_BY_HEIGHT = (h) => (h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : h >= 400 ? "480p" : null);

// Which episode is being watched, and at what quality — from a torrent
// play-item or a library file.
const episodeOf = (itemId, meta) => {
  if (String(itemId).startsWith("torrent|")) {
    if (!meta || !meta.imdbId || meta.season == null || meta.episode == null) return null;
    return { imdbId: meta.imdbId, season: Number(meta.season), episode: Number(meta.episode), quality: meta.quality || null };
  }
  const item = scanner.findById(itemId);
  if (!item || !item.showId || item.season == null || item.episode == null) return null;
  identity.ensureStamped();
  const show = scanner.findById(item.showId);
  if (!show || !show.imdbId) return null;
  return {
    imdbId: show.imdbId,
    season: Number(item.season),
    episode: Number(item.episode),
    quality: item.video && item.video.height ? QUALITY_BY_HEIGHT(item.video.height) : null,
  };
};

// The next AIRED episode after (season, episode): the next number in the
// same season, else the first of the next season.
const nextEpisode = (meta, season, episode) => {
  const seasons = (meta.seasons || []).filter((s) => s.number > 0);
  const flat = seasons.flatMap((s) => s.episodes || []);
  const i = flat.findIndex((e) => Number(e.season) === season && Number(e.episode) === episode);
  const next = i >= 0 ? flat[i + 1] : null;
  if (!next) return null;
  if (next.released && new Date(next.released) > new Date()) return null;
  return next;
};

// The source to fetch: same quality as what's playing when there is one,
// never CAM/dubbed/pack, the ranked list's order otherwise (it is sorted by
// value already, ★ BEST first among them).
const pickSource = (streams, quality) => {
  const ok = (streams || []).filter((s) => !s.cam && !s.dubbed && !s.pack && s.infoHash);
  if (!ok.length) return null;
  return (quality && ok.find((s) => s.quality === quality)) || ok.find((s) => s.recommended) || ok[0];
};

const onProgress = async (profileId, itemId, position, duration, meta) => {
  if (!(duration > 0) || position / duration < THRESHOLD) return;
  const profile = profiles.list().find((p) => p.id === profileId);
  if (!profile || (profile.prefs && profile.prefs.smartDownloads === false)) return;
  const ep = episodeOf(itemId, meta);
  if (!ep) return;
  const key = `${profileId}|${ep.imdbId}|${ep.season}|${ep.episode}`;
  const last = tried.get(key) || 0;
  if (Date.now() - last < RETRY_MS) return;
  tried.set(key, Date.now());

  const m = await discover.meta("series", ep.imdbId).catch(() => null);
  if (!m) return;
  const next = nextEpisode(m, ep.season, ep.episode);
  if (!next) return;
  const want = { imdbId: ep.imdbId, type: "show", title: m.title, year: m.year, season: next.season, episode: next.episode };
  if (identity.findLibraryPlayable(want)) return; // already on disk
  const queued = downloads.list().some(
    (j) =>
      j.imdbId === ep.imdbId &&
      Number(j.season) === Number(next.season) &&
      Number(j.episode) === Number(next.episode) &&
      !["error", "declined", "canceled"].includes(j.status),
  );
  if (queued) return;

  const { streams } = await torrent.getSources("series", ep.imdbId, m.year, next.season, next.episode).catch(() => ({ streams: [] }));
  const pick = pickSource(streams, ep.quality);
  if (!pick) return;
  const r = downloads.create({
    infoHash: pick.infoHash,
    fileIdx: pick.fileIdx || 0,
    type: "show",
    imdbId: ep.imdbId,
    title: m.title,
    label: `${m.title} · S${next.season} E${next.episode}`,
    year: m.year,
    poster: m.poster,
    quality: pick.quality,
    sizeBytes: pick.sizeBytes,
    season: next.season,
    episode: next.episode,
    provider: pick.provider,
    seeders: pick.seeders,
    profile: profileId,
    profileName: profile.name,
    smart: true,
  });
  if (r && r.error) return console.warn(`[smart] could not queue ${m.title} S${next.season}E${next.episode}: ${r.error}`);
  if (r && r.alreadyAvailable) return;
  console.log(`[smart] queued ${m.title} S${next.season}E${next.episode} for ${profileId} (${pick.quality}, ${pick.seeders} seeders)`);
};

module.exports = { onProgress, _internals: { nextEpisode, pickSource, episodeOf, THRESHOLD } };
