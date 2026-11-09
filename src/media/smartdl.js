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
// Imports that have to stay inside functions (circular), asked for once
// instead of on every call — lib/lazy.js has the why.
const lazy = require("../lib/lazy");
const torrentgateLib = lazy(require, "../lib/torrentgate");
const identity = require("./identity");
const discover = require("./discover");
const torrent = require("./torrent");
const downloads = require("./downloads");
const profiles = require("../profiles");

const THRESHOLD = 0.65;
const RETRY_MS = 6 * 3600 * 1000;
const tried = new (require("../lib/caches").BoundedMap)({ max: 5000, name: "smart downloads: tried" }); // "profile|imdbId|s|e" -> last attempt (bounded)

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
// the ranked list's order otherwise (it is sorted by value already, ★ BEST
// first among them). Never a pre-release copy (CAM, TS, TC, screener, HC)
// and never a dub (media/releasekind.js pickable), never a release somebody
// here reported bad ("Get another version": media/badreleases.js); one with
// burned-in subtitles only when there is no clean copy at all. Null when
// nothing may be picked — then nothing starts by itself.
const pickSource = (streams, quality) => {
  const ok = (streams || []).filter((s) => s && s.infoHash && !s.badHere && require("./releasekind").pickable(s));
  if (!ok.length) return null;
  const clean = ok.filter((s) => !s.hardsub);
  const pool = clean.length ? clean : ok;
  return (quality && pool.find((s) => s.quality === quality)) || pool.find((s) => s.recommended) || pool[0];
};

// While an episode plays, its next episode — if it is already in the
// download queue (smart downloads, or the person asked for the season) —
// goes first: "watching now" (media/dlprio.js) until a while after this
// episode would end. Every progress report renews it, from the first minute;
// no catalogue lookup, the queue itself is asked.
const URGENT_TAIL_MS = 20 * 60 * 1000;
const urgentUntil = (position, duration) => Date.now() + Math.max(0, duration - position) * 1000 + URGENT_TAIL_MS;

const onProgress = async (profileId, itemId, position, duration, meta) => {
  if (!torrentgateLib().enabled()) return; // "torrents": false
  if (!(duration > 0)) return;
  const early = position / duration < THRESHOLD;
  // (an episode, being watched: the next one in the queue goes first)
  const playing = position > 0 && position / duration < 0.98 ? episodeOf(itemId, meta) : null;
  if (playing) {
    try { downloads.urgentAfter(playing, urgentUntil(position, duration)); } catch (e) { console.warn("[smart] could not mark the next episode:", e && e.message); }
  }
  if (early) return;
  const profile = profiles.list().find((p) => p.id === profileId);
  if (!profile || (profile.prefs && profile.prefs.smartDownloads === false)) return;
  const ep = playing || episodeOf(itemId, meta);
  if (!ep) return;
  const key = `${profileId}|${ep.imdbId}|${ep.season}|${ep.episode}`;
  const last = tried.get(key) || 0;
  if (Date.now() - last < RETRY_MS) return;
  tried.set(key, Date.now());

  const m = await discover.meta("series", ep.imdbId).catch(() => null);
  if (!m) return;
  const next = nextEpisode(m, ep.season, ep.episode);
  if (!next) return;
  const r = await queueEpisode({ profile, imdbId: ep.imdbId, meta: m, season: next.season, episode: next.episode, quality: ep.quality, auto: "next" });
  // (already in the queue before this: the urgency at the top of this
  // function has it; a create that joined another copy is marked below)
  if (r.state !== "queued" && !(r.state === "in-queue" && r.viaCreate)) return;
  // …and it is wanted NOW: this person is watching the episode before it
  if (r.job && position / duration < 0.98) {
    try { downloads.markUrgent({ imdbId: ep.imdbId, season: next.season, episode: next.episode }, urgentUntil(position, duration), "the episode before it is playing"); } catch {}
  }
  if (r.state === "queued") console.log(`[smart] queued ${m.title} S${next.season}E${next.episode} for ${profileId} (${r.pick.quality}, ${r.pick.seeders} seeders)`);
};

// ONE EPISODE, queued for a person when it is neither on disk nor on its way
// — the one path smart downloads (above) and the downloads ahead (below,
// media/overnight.js) both take. Never past what pickSource allows (no
// pre-release copy, no dub, nothing reported bad here); the disk gate in
// downloads.js still applies (a tight drive turns it into an approval
// request). `auto`: the queue's class — "next" (Next episode) or "ahead"
// (Background: the episode after next, nobody needs it tonight).
// → { state: "on-disk" | "in-queue" | "queued" | "no-source" | "error", job?, pick?, error? }
const queueEpisode = async ({ profile, imdbId, meta: m, season, episode, quality = null, auto = "next" }) => {
  const want = { imdbId, type: "show", title: m.title, year: m.year, season, episode };
  if (identity.findLibraryPlayable(want)) return { state: "on-disk" };
  const queued = downloads.list().find(
    (j) =>
      j.imdbId === imdbId &&
      Number(j.season) === Number(season) &&
      Number(j.episode) === Number(episode) &&
      !["error", "declined", "canceled"].includes(j.status),
  );
  if (queued) return { state: "in-queue", job: queued };
  const { streams } = await torrent.getSources("series", imdbId, m.year, season, episode).catch(() => ({ streams: [] }));
  const pick = pickSource(streams, quality);
  if (!pick) return { state: "no-source" };
  const r = downloads.create({
    infoHash: pick.infoHash,
    fileIdx: pick.fileIdx || 0,
    type: "show",
    imdbId,
    title: m.title,
    label: `${m.title} · S${season} E${episode}`,
    year: m.year,
    poster: m.poster,
    quality: pick.quality,
    sizeBytes: pick.sizeBytes,
    season,
    episode,
    provider: pick.provider,
    seeders: pick.seeders,
    profile: profile.id,
    profileName: profile.name,
    smart: true,
    auto,
  });
  if (r && r.error) {
    console.warn(`[smart] could not queue ${m.title} S${season}E${episode}: ${r.error}`);
    return { state: "error", error: r.error };
  }
  if (r && r.alreadyAvailable) return { state: "on-disk" };
  return { state: r && r.duplicate ? "in-queue" : "queued", job: r && r.job, pick, viaCreate: true };
};

// DOWNLOADS AHEAD (media/overnight.js, elia 2026-11-09: "We can even pre
// download"): for a person in the middle of a show, the episodes they play
// next — the anchor itself first when they have not finished it, then what
// follows, `depth` of them (media/overnightplan.js upcoming) — are made sure
// of: on disk, on their way, or queued now. The first is the "Next episode"
// class, the one after it "Background". The same per-person switch as smart
// downloads (prefs.smartDownloads), the same one try per episode per six
// hours, the same rules for the copy; no per-person cap ("No cap on downloads").
// → { title, episodes: [{ season, episode, nth, state }] } | { skipped: why }
const ahead = async (profile, { imdbId, anchor, depth = 2, now = Date.now() } = {}) => {
  if (!torrentgateLib().enabled()) return { skipped: "torrents are off" };
  if (!profile) return { skipped: "no such person" };
  if (profile.prefs && profile.prefs.smartDownloads === false) return { skipped: "smart downloads are off for this person" };
  if (!(depth > 0)) return { skipped: "nothing ahead" };
  const m = await discover.meta("series", imdbId).catch(() => null);
  if (!m) return { skipped: "the catalogue did not answer" };
  const out = [];
  for (const e of require("./overnightplan").upcoming(m.seasons, anchor, depth, now)) {
    const key = `${profile.id}|${imdbId}|${e.season}|${e.episode}`;
    const want = { imdbId, type: "show", title: m.title, year: m.year, season: e.season, episode: e.episode };
    if (identity.findLibraryPlayable(want)) { out.push({ ...e, state: "on-disk" }); continue; }
    if (now - (tried.get(key) || 0) < RETRY_MS) { out.push({ ...e, state: "tried-lately" }); continue; }
    const r = await queueEpisode({ profile, imdbId, meta: m, season: e.season, episode: e.episode, quality: anchor && anchor.quality, auto: e.nth === 0 ? "next" : "ahead" });
    if (r.state !== "on-disk" && r.state !== "in-queue") tried.set(key, now);
    if (r.state === "queued") console.log(`[ahead] queued ${m.title} S${e.season}E${e.episode} for ${profile.name || profile.id} (${e.nth === 0 ? "next episode" : "the one after"}; ${r.pick.quality}, ${r.pick.seeders} seeders)`);
    out.push({ ...e, state: r.state, jobId: r.job ? r.job.id : null, ...(r.error ? { error: r.error } : {}) });
  }
  return { title: m.title, episodes: out };
};

// episodeOf is shared with media/smartclean.js — one answer to "which
// episode is this progress about?" for both halves of the feature.
module.exports = { onProgress, episodeOf, ahead, queueEpisode, _internals: { nextEpisode, pickSource, episodeOf, THRESHOLD, tried } };
