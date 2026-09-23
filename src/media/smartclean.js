// Smart cleanup: the other half of smart downloads (media/smartdl.js). An
// episode that smart downloads fetched FOR someone leaves the disk once that
// person has finished it and moved on to a later episode — so a binge doesn't
// quietly fill the drive with episodes nobody will play twice.
//
// Deliberately narrow. It only ever touches files smart downloads created
// (job.smart), never a hand-requested download or anything already in the
// library. And it refuses whenever keeping the file could still matter:
//   - the requester hasn't FINISHED that episode (by any means — library
//     file, torrent stream, or "mark watched"), or isn't actually past it;
//   - anyone else is part-way through that exact file (deleting it would pull
//     the rug from under a paused episode);
//   - someone ASKED for the same file by hand (a manual job shares the path);
//   - the requester switched the feature off (prefs.smartCleanup === false).
// Deletion goes through libfiles.deleteVideoFile, which refuses anything
// outside a library root and takes the episode's sidecar subtitles with it.
const path = require("path");
const fs = require("fs");
const config = require("../config");
const scanner = require("./scanner");
const downloads = require("./downloads");
const profiles = require("../profiles");
const libfiles = require("../lib/libfiles");
const realtime = require("../realtime");
const { watchedIndex, watchedEpisodesFor } = require("./watched");
const { episodeOf } = require("./smartdl");

// "Started the next episode" = genuinely into it, not an autoplay blip that
// was cancelled, and not a single seek past the credits.
const STARTED_S = 60;
// Mid-watch for someone else = real progress, not a two-second peek.
const OTHERS_MIDWAY_S = 30;
// Progress saves arrive every few seconds; the check only needs to run now
// and then per (profile, show).
const THROTTLE_MS = 60 * 1000;
const lastRun = new Map(); // "profile|imdbId" -> ts

const before = (a, b) => a.season < b.season || (a.season === b.season && a.episode < b.episode);

// The whole rulebook, pure: every input is handed in, so the tests can pin
// each refusal without a library, a store or a disk.
//
//   job          the smart download (raw job: smart, status, profile, imdbId,
//                season, episode, destPath)
//   requester    {id, name, prefs}
//   now          {imdbId, season, episode, position, duration} — the episode
//                the requester is watching right now
//   finished     Set of "s:e" the requester has finished for this show
//   others       [{ position, finished }] — every OTHER profile's progress on
//                this exact file
//   manualShare  true when a non-smart job points at the same file
const decide = ({ job, requester, now, finished, others = [], manualShare = false }) => {
  if (!job || !job.smart) return { clean: false, why: "not a smart download" };
  if (job.status !== "done" || !job.destPath) return { clean: false, why: "not finished downloading" };
  if (!requester || (job.profile !== requester.id && job.profile !== requester.name)) {
    return { clean: false, why: "fetched for someone else" };
  }
  if (requester.prefs && requester.prefs.smartCleanup === false) return { clean: false, why: "switched off" };
  if (!now || job.imdbId !== now.imdbId) return { clean: false, why: "different show" };
  const ep = { season: Number(job.season), episode: Number(job.episode) };
  if (!before(ep, now)) return { clean: false, why: "not behind the episode being watched" };
  if (!(now.position >= STARTED_S)) return { clean: false, why: "next episode barely started" };
  if (!finished || !finished.has(`${ep.season}:${ep.episode}`)) return { clean: false, why: "not finished" };
  if (manualShare) return { clean: false, why: "someone asked for it by hand" };
  const midway = others.find((o) => o && !o.finished && o.position >= OTHERS_MIDWAY_S);
  if (midway) return { clean: false, why: "someone else is part-way through it" };
  return { clean: true, why: "watched and moved on" };
};

// Fired from the progress route after the response (never on its critical
// path), alongside smartdl.onProgress.
const onProgress = async (profileId, itemId, position, duration, meta) => {
  const now = episodeOf(itemId, meta);
  if (!now) return { cleaned: [] };
  const throttleKey = `${profileId}|${now.imdbId}`;
  if (Date.now() - (lastRun.get(throttleKey) || 0) < THROTTLE_MS) return { cleaned: [] };
  lastRun.set(throttleKey, Date.now());

  const requester = profiles.list().find((p) => p.id === profileId);
  if (!requester) return { cleaned: [] };
  const candidates = downloads
    .smartOnDisk()
    .filter((j) => j.imdbId === now.imdbId && (j.profile === requester.id || j.profile === requester.name));
  if (!candidates.length) return { cleaned: [] };

  const watched = watchedIndex({
    progress: profiles.getProgress(profileId) || {},
    streamItems: profiles.getStreamItems(profileId) || {},
  });
  const finished = watchedEpisodesFor(watched, { imdbId: now.imdbId });
  const allJobs = downloads.rawJobs();
  const roots = [...config.LIBRARIES.movies, ...config.LIBRARIES.shows];
  const cleaned = [];

  for (const job of candidates) {
    const libraryId = scanner.idForPath(job.destPath);
    const others = profiles
      .list()
      .filter((p) => p.id !== profileId)
      .map((p) => (libraryId ? (profiles.getProgress(p.id) || {})[libraryId] : null))
      .filter(Boolean);
    const manualShare = allJobs.some((j) => j !== job && !j.smart && j.destPath === job.destPath);
    const verdict = decide({
      job,
      requester,
      now: { ...now, position, duration },
      finished,
      others,
      manualShare,
    });
    if (!verdict.clean) continue;
    try {
      const r = libfiles.deleteVideoFile(job.destPath, roots, config.SUBTITLE_EXTENSIONS);
      cleaned.push({ job: job.id, label: job.label, freedBytes: r.freedBytes });
      console.log(
        `[smart] cleaned ${job.label || path.basename(job.destPath)} for ${requester.name} ` +
          `(watched, now on S${now.season}E${now.episode}) — freed ${Math.round(r.freedBytes / 1e6)} MB`,
      );
    } catch (err) {
      // A file still open on Windows refuses to unlink. Nothing is lost: the
      // next progress save after the throttle simply tries again.
      if (fs.existsSync(job.destPath)) {
        console.warn(`[smart] could not clean ${job.label || job.destPath} yet: ${err.message}`);
      }
    }
  }

  if (cleaned.length) {
    scanner.scan();
    downloads.pruneGone(); // the finished jobs whose files just left drop off every downloads page
    realtime.broadcastAll({ type: "library_updated" });
  }
  return { cleaned };
};

module.exports = { onProgress, _internals: { decide, before, STARTED_S, OTHERS_MIDWAY_S, lastRun } };
