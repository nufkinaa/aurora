// When a copy will not download: which copy to try next, whether the file a
// torrent hands us is the right one (or a sample, or a fake), and what an
// engine error means. Pure functions; media/downloads.js does the I/O.
//
// elia, 2026-11-03: "we need to detect when a version just won't download
// and try and download the second best stream we can".
//
// THE NEXT COPY (chooseFallback), in this order:
//   1. never one this job already tried, one somebody reported bad here
//      (media/badreleases.js — dead copies are filed there too, for a few
//      days), a cinema recording or other pre-release copy, a dub unless the
//      copy it replaces was one, burned-in subtitles unless that was too, the
//      copy a "Get another version" is replacing, or a file another download
//      is already fetching;
//   2. the SAME resolution first, then one step down (1080p → 720p), then one
//      step up only when it is not much bigger — a person who asked for
//      1080p gets 1080p if any 1080p copy is alive;
//   3. inside a step: the best seeded first, by the order of magnitude of its
//      seeders (Sonarr's rule: 5 and 15 tie, 90 beats 9), then the list's own
//      ranking (quality, size, what this server learned) — and a season pack
//      that is ALREADY downloading for a sibling episode before everything,
//      because it costs nothing to add one more file to it;
//   4. at most MAX_SOURCES copies per job in all, then the job waits and
//      tries again later (media/downloads.js), and in the end says plainly
//      that no one is sharing it.
"use strict";
const path = require("path");

const MAX_SOURCES = 4;        // the original + three others

const lc = (s) => String(s || "").toLowerCase();

const resolutionOf = (q) => {
  const s = lc(q);
  if (/2160|4k|uhd/.test(s)) return "2160p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480|sd\b/.test(s)) return "480p";
  return null;
};
const LADDER = ["480p", "720p", "1080p", "2160p"];
// The resolutions to look at, best fit first.
const steps = (want) => {
  const i = LADDER.indexOf(want);
  if (i < 0) return [null];
  const out = [want];
  if (i > 0) out.push(LADDER[i - 1]);
  if (i < LADDER.length - 1) out.push(LADDER[i + 1]);
  return out;
};
const bucket = (seeders) => Math.round(Math.log10((Number(seeders) || 0) + 1));

// → { source, step, warm } or { source: null, reason }.
//   job       { infoHash, quality, sizeBytes, type, dubbed?, hardsub? }
//   streams   getSources' list (its order IS the ranking), with `badHere` marks
//   tried     Set of lower-case infoHashes this job has already used
//   exclude   Set of lower-case infoHashes never to pick (the copy being replaced)
//   live      [{ infoHash, fileIdx, running }] other live downloads' files
//   accept    optional (source) → bool, e.g. the "Wrong language" rule
//   original  the job's own source as listed (for dub / hardsub), if known
const chooseFallback = ({ job, streams, tried, exclude, live, accept, original }) => {
  const list = (streams || []).filter((s) => s && /^[a-z0-9]{32,40}$/i.test(String(s.infoHash || "")));
  const own = lc(job.infoHash);
  const me = original || list.find((s) => lc(s.infoHash) === own) || {};
  const size = Number(job.sizeBytes) || Number(me.sizeBytes) || 0;
  const triedSet = tried || new Set();
  const never = exclude || new Set();
  const liveFiles = new Set((live || []).map((l) => `${lc(l.infoHash)}|${l.fileIdx || 0}`));
  const runningHashes = new Set((live || []).filter((l) => l.running !== false).map((l) => lc(l.infoHash)));
  const reportsSeeders = list.some((s) => (s.seeders || 0) > 0);
  const skipped = { tried: 0, bad: 0, kind: 0, size: 0, dead: 0, busy: 0, lang: 0 };
  const ok = [];
  list.forEach((s, rank) => {
    const h = lc(s.infoHash);
    if (h === own || triedSet.has(h) || never.has(h)) { skipped.tried++; return; }
    if (s.badHere) { skipped.bad++; return; }
    if (s.cam || s.prerelease || (s.dubbed && !me.dubbed && !job.dubbed)) { skipped.kind++; return; }
    if (!(s.sizeBytes > 0)) { skipped.size++; return; }               // the disk gate could not count it
    if (size > 0 && (s.sizeBytes < size * 0.25 || s.sizeBytes > size * 3)) { skipped.size++; return; }
    if (reportsSeeders && !(s.seeders > 0)) { skipped.dead++; return; }
    if (liveFiles.has(`${h}|${s.fileIdx || 0}`)) { skipped.busy++; return; }
    if (accept && !accept(s)) { skipped.lang++; return; }
    ok.push({ s, rank });
  });
  const want = resolutionOf(job.quality || me.quality);
  for (const step of steps(want)) {
    let pool = ok.filter(({ s }) => step == null || resolutionOf(s.quality) === step);
    // one step UP only when it is not much bigger than what was asked for
    if (want && step && LADDER.indexOf(step) > LADDER.indexOf(want) && size > 0) pool = pool.filter(({ s }) => s.sizeBytes <= size * 1.5);
    // burned-in subtitles only when nothing clean is left at this step
    const clean = pool.filter(({ s }) => !s.hardsub || me.hardsub);
    if (clean.length) pool = clean;
    if (!pool.length) continue;
    const warm = pool.find(({ s }) => runningHashes.has(lc(s.infoHash)));
    if (warm) return { source: warm.s, step, warm: true };
    pool.sort((a, b) => bucket(b.s.seeders) - bucket(a.s.seeders) || a.rank - b.rank);
    return { source: pool[0].s, step, warm: false };
  }
  const bits = [
    skipped.tried && `${skipped.tried} already tried`,
    skipped.bad && `${skipped.bad} reported or found bad here`,
    skipped.dead && `${skipped.dead} with no seeders`,
    skipped.size && `${skipped.size} the wrong size`,
    skipped.kind && `${skipped.kind} cinema copies or dubs`,
    skipped.busy && `${skipped.busy} already downloading`,
    skipped.lang && `${skipped.lang} in the wrong language`,
  ].filter(Boolean).join(", ");
  return { source: null, reason: list.length ? `no other copy is usable${bits ? ` (${bits})` : ""}` : "there is no other copy of this title" };
};

// ---------- is this the right file? ----------
const VIDEO = [".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".ts", ".m2ts", ".wmv", ".mpg", ".mpeg"];
const DANGER = [".exe", ".scr", ".bat", ".cmd", ".com", ".lnk", ".msi", ".vbs", ".js", ".jar", ".apk", ".ps1"];
const ARCHIVE = /\.(zip|rar|7z|r\d\d|tar|gz)$/i;
const JUNK = /(^|[\s._\-\[(\\/])(sample|trailer|teaser|extras?|featurettes?|behind[\s._-]the[\s._-]scenes|deleted[\s._-]scenes|bonus)($|[\s._\-\])\\/])/i;
const MIN_FILM_BYTES = 150e6;   // a real film is never under this, even at 480p
const MIN_EPISODE_BYTES = 30e6; // …an episode, at 480p, half an hour

const isVideo = (f) => VIDEO.includes(path.extname(String(f.path || "")).toLowerCase());
const isJunk = (f) => JUNK.test(String(f.path || "").replace(/\.[a-z0-9]{2,4}$/i, ""));
// Does the name say which episode it is? true / false / null (it does not say).
const episodeMatch = (f, season, episode) => {
  const name = path.basename(String(f.path || ""));
  const s = Number(season);
  const e = Number(episode);
  if (!(s > 0) || !(e > 0)) return null;
  // (a double episode is "E03E04", "E03-E04" or "E03-04" — never the
  // ".1080" of "S01E02.1080p", which once read as episodes 2 to 108)
  const all = [...name.matchAll(/s(\d{1,2})[\s._-]*e(\d{1,3})(?:(?:-?e|-)(\d{1,3})(?![\dp]))?/gi)];
  const x = [...name.matchAll(/(?:^|[^0-9a-z])(\d{1,2})x(\d{2,3})(?:[^0-9]|$)/gi)];
  if (!all.length && !x.length) return null;
  for (const m of all) {
    const ms = Number(m[1]);
    const e1 = Number(m[2]);
    const e2 = m[3] ? Number(m[3]) : e1;   // S01E01E02 / S01E01-02: a double episode
    if (ms === s && e >= e1 && e <= Math.max(e1, e2)) return true;
  }
  for (const m of x) if (Number(m[1]) === s && Number(m[2]) === e) return true;
  return false;
};

// The files a torrent turned out to have → is the file we were told to fetch
// the right one?
//   files  [{ index (1-based), path, length }]
//   job    { type, season, episode, sizeBytes (listed), fileIndex (wanted) }
// → { verdict: "ok" | "switch" | "fake", fileIndex, why }
const checkFiles = (files, job) => {
  const list = (files || []).filter((f) => f && f.index > 0);
  if (!list.length) return { verdict: "ok", fileIndex: job.fileIndex, why: null };
  const show = job.type === "show";
  const floor = show ? MIN_EPISODE_BYTES : MIN_FILM_BYTES;
  // The size the source was LISTED with is the best yardstick: it is the
  // provider's size for that file. (A pack listed with the size of the WHOLE
  // pack says nothing about one file in it: then it is not used.)
  const total = list.reduce((n, f) => n + (Number(f.length) || 0), 0);
  const allVideos = list.filter(isVideo);
  const listed = Number(job.sizeBytes) > 0 && !(allVideos.length > 1 && Number(job.sizeBytes) >= total * 0.9) ? Number(job.sizeBytes) : 0;
  const bigEnough = (f) => (listed > 0 ? f.length >= listed * 0.25 : true);
  const videos = allVideos.filter((f) => !isJunk(f));
  const bySize = (a, b) => b.length - a.length;
  const wanted = list.find((f) => f.index === Number(job.fileIndex));
  const right = (f) => f && isVideo(f) && !isJunk(f) && bigEnough(f) && (!show || episodeMatch(f, job.season, job.episode) !== false);
  if (right(wanted)) return { verdict: "ok", fileIndex: wanted.index, why: null };

  // the right file is another one in the same torrent
  let pick = null;
  if (show) {
    pick = videos.filter((f) => episodeMatch(f, job.season, job.episode) === true && bigEnough(f)).sort(bySize)[0] || null;
    // a single-episode torrent that does not name its episode: its one real video
    if (!pick && videos.length === 1 && bigEnough(videos[0]) && episodeMatch(videos[0], job.season, job.episode) !== false) pick = videos[0];
  } else {
    // a film: the biggest real video — when it is clearly the feature
    // (over the floor no film is under, or the size it was listed with)
    pick = videos.filter((f) => bigEnough(f) && (listed > 0 || f.length >= floor)).sort(bySize)[0] || null;
  }
  if (pick && (!wanted || pick.index !== wanted.index)) {
    const why = !wanted ? "the file it was listed with is not in the torrent"
      : isJunk(wanted) && isVideo(wanted) ? "the listed file is a sample or an extra"
      : !isVideo(wanted) ? "the listed file is not a video"
      : !bigEnough(wanted) ? "the listed file is far smaller than it should be"
      : "the listed file is another episode";
    return { verdict: "switch", fileIndex: pick.index, why };
  }

  // nothing in it is the real thing: a fake
  const biggest = list.slice().sort(bySize)[0];
  const ext = path.extname(String(biggest.path || "")).toLowerCase();
  if (DANGER.includes(ext)) return { verdict: "fake", fileIndex: null, why: `it is a program (${ext}), not a video` };
  if (!allVideos.length) return { verdict: "fake", fileIndex: null, why: ARCHIVE.test(String(biggest.path || "")) ? "it is a packed archive, not a video" : "there is no video in it" };
  if (!videos.length) return { verdict: "fake", fileIndex: null, why: "its only video is a sample" };
  if (listed > 0 && !videos.some(bigEnough)) return { verdict: "fake", fileIndex: null, why: "its video is far smaller than the copy was listed as — a sample or a fake" };
  // a video, but not clearly this one: take what was listed (most packs name
  // their episodes; when this one does not, the listing is the best answer)
  if (show && !videos.some((f) => episodeMatch(f, job.season, job.episode) !== false)) return { verdict: "fake", fileIndex: null, why: "this episode is not in it" };
  if (wanted && isVideo(wanted) && !isJunk(wanted)) return { verdict: "ok", fileIndex: wanted.index, why: null };
  return { verdict: "switch", fileIndex: videos.sort(bySize)[0].index, why: "the listed file is not the video" };
};

// After the bytes are in: what the file itself says (ffprobe, as
// media/downloads.js seams.probe asks it: { video: bool, duration: s,
// invalid: bool }). → null when it is fine (or could not be asked — a probe
// that timed out is never held against a copy), else why it is not a film.
const checkProbe = (facts, job, sizeBytes = 0) => {
  if (!facts) return null;
  if (facts.invalid) return "the file is damaged or not a video at all";
  if (!facts.video) return "it has no picture";
  const d = Number(facts.duration) || 0;
  // a sample: short AND small (a real short episode is still a normal size)
  const floor = job.type === "show" ? 90 : 10 * 60;
  if (d > 0 && d < floor && (Number(sizeBytes) || 0) < 300e6) return `it is only ${Math.max(1, Math.round(d / 60))} min long — a sample, not the ${job.type === "show" ? "episode" : "film"}`;
  return null;
};

// ---------- what an engine error means ----------
// aria2's error codes (aria2c manual, "EXIT STATUS"): the download stops
// with one of these. → "disk" (wait for room, another copy will not help),
// "broken" (this copy's data or details are bad: blocklist it), "dup"
// (the torrent is already in the engine: join it), "source" (it simply did
// not work: try another copy).
const classifyError = (code, message = "") => {
  const c = Number(code);
  const m = String(message || "");
  if ([9, 16, 17, 18].includes(c) || /disk space|no space left|disk full|ENOSPC/i.test(m)) return "disk";
  if ([10, 25, 26, 27, 32].includes(c) || /checksum|bencode|malformed|corrupt/i.test(m)) return "broken";
  if ([11, 12].includes(c) || /already registered|same (file|infohash)/i.test(m)) return "dup";
  return "source";
};

module.exports = {
  MAX_SOURCES, resolutionOf, steps, bucket, chooseFallback, checkFiles, checkProbe, classifyError,
  _internals: { isVideo, isJunk, episodeMatch, MIN_FILM_BYTES, MIN_EPISODE_BYTES },
};
