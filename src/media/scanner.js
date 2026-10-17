// Library scanner: walks the configured media folders and builds the
// in-memory index the whole app serves from.
//
// Two phases:
//   1. scan()   - fast filesystem pass, no probing. Instant library.
//   2. enrich() - background ffprobe queue filling duration/resolution and
//                 embedded subtitle tracks, emitting "updated" when it lands.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const config = require("../config");
const metadata = require("./metadata");
const online = require("./online");

const events = new EventEmitter();

// id -> { path, kind } used by streaming/image endpoints
const registry = new Map();

const index = {
  movies: [],
  shows: [],
  scannedAt: null,
  enriched: false,
};

// An id is a pure function of (kind, path), and a scan asks for the same
// ones every ten minutes: remembered, so a rescan hashes only what is new.
// (Bounded: forgotten wholesale long before it could matter.)
const idMemo = new Map();
const ID_MEMO_MAX = 200000;
const makeId = (kind, relPath) => {
  const key = `${kind}|${relPath}`;
  let id = idMemo.get(key);
  if (id === undefined) {
    id = crypto.createHash("md5").update(key).digest("hex").slice(0, 12);
    if (idMemo.size >= ID_MEMO_MAX) idMemo.clear();
    idMemo.set(key, id);
  }
  return id;
};

const byPath = new Map(); // absPath -> id (the downloads queue asks "what did my file become?")
const register = (kind, absPath, relPath) => {
  const id = makeId(kind, relPath);
  registry.set(id, { path: absPath, kind });
  byPath.set(absPath, id);
  return id;
};

// The library id a file on disk was indexed under, or null. Paths compare
// exactly, so callers pass the same absolute path the scanner walked.
const idForPath = (absPath) => byPath.get(absPath) || null;

// movie id -> the other video files in its folder, which are not indexed
// (absolute paths, as the last scan saw them). Only movies with more than one.
const siblingVideos = new Map();
const otherVideosOf = (movieId) => siblingVideos.get(movieId) || [];

// (One collator for every comparison: a.localeCompare(b, undefined, options)
// is defined as exactly this compare, minus setting the collator up per call.)
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const naturalCompare = (a, b) => naturalCollator.compare(a, b);

// A multi-dub file's audio streams, for the player's audio menu — only when
// there is a choice to make (one track = nothing to list).
const audioTracksOf = (meta) => {
  const list = (meta && meta.audioStreams) || [];
  if (list.length < 2) return undefined;
  return list.map((a, i) => ({
    index: a.index != null ? a.index : i,
    language: a.language || null,
    title: a.title || null,
    codec: a.codec || null,
    channels: a.channels || 2,
  }));
};

// ---------- name parsing ----------

const LANGUAGE_NAMES = {
  eng: "English",
  en: "English",
  heb: "Hebrew",
  he: "Hebrew",
  iw: "Hebrew",
  spa: "Spanish",
  es: "Spanish",
  fre: "French",
  fra: "French",
  fr: "French",
  ger: "German",
  deu: "German",
  de: "German",
  ita: "Italian",
  it: "Italian",
  por: "Portuguese",
  pt: "Portuguese",
  rus: "Russian",
  ru: "Russian",
  ara: "Arabic",
  ar: "Arabic",
  jpn: "Japanese",
  ja: "Japanese",
  kor: "Korean",
  ko: "Korean",
  chi: "Chinese",
  zho: "Chinese",
  zh: "Chinese",
  dut: "Dutch",
  nld: "Dutch",
  nl: "Dutch",
  pol: "Polish",
  pl: "Polish",
  tur: "Turkish",
  tr: "Turkish",
  hin: "Hindi",
  hi: "Hindi",
};

const languageName = (code) =>
  code ? LANGUAGE_NAMES[code.toLowerCase()] || null : null;

const extractYear = (name) => {
  const m = name.match(/\((19|20)\d{2}\)/) || name.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0].replace(/[()]/g, ""), 10) : null;
};

const cleanTitle = (name) =>
  name
    .replace(/\((19|20)\d{2}\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

// "Show S01E02", "Show (1x11)", "Show 1x11"
const parseEpisode = (fileName) => {
  const base = path.basename(fileName, path.extname(fileName));
  const m =
    base.match(/S(\d{1,2})[\s._-]*E(\d{1,3})/i) ||
    base.match(/\(?(\d{1,2})x(\d{1,3})\)?/);
  if (m) {
    return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  }
  return { season: null, episode: null };
};

const cleanEpisodeTitle = (fileName) => {
  const base = path.basename(fileName, path.extname(fileName));
  const cleaned = base
    .replace(/S\d{1,2}[\s._-]*E\d{1,3}/gi, "")
    .replace(/\(?\d{1,2}x\d{1,3}\)?/g, "")
    .replace(/[\s._-]+/g, " ")
    .trim();
  return cleaned;
};

const seasonFromFolder = (relDir) => {
  const m = relDir.match(/season[\s._-]*(\d{1,2})/i);
  return m ? parseInt(m[1], 10) : null;
};

// ---------- folder helpers ----------

// One listing per folder per scan. A scan asked for the same folder again
// and again: a film's folder three times (its videos, its cover, its
// subtitles), a season's folder once per EPISODE (each episode lists the
// folder to find its own subtitle files) and the show's folder once per
// episode on top — 5,042 directory reads for 1,800 files where 1,382 folders
// exist (measured, docs/qa/backend-efficiency). While scan() runs, the first
// listing of a folder is kept and handed out again; nobody changes the array
// they are given. Outside a scan nothing is remembered.
let scanListings = null;
const readDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const listDir = (dir) => {
  if (!scanListings) return readDir(dir);
  let hit = scanListings.get(dir);
  if (!hit) {
    hit = readDir(dir);
    scanListings.set(dir, hit);
  }
  return hit;
};

const statSafe = (p) => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};

const hasExt = (file, exts) => exts.includes(path.extname(file).toLowerCase());

const findCover = (dir) => {
  const entries = listDir(dir).filter((e) => e.isFile());
  const preferred = entries.find((e) =>
    /^(cover|poster|folder)\./i.test(e.name),
  );
  const any =
    preferred || entries.find((e) => hasExt(e.name, config.IMAGE_EXTENSIONS));
  return any && hasExt(any.name, config.IMAGE_EXTENSIONS) ? any.name : null;
};

// ---------- external subtitles (same rules battle-tested in the old app) ----------

const subtitleBelongsTo = (subBase, videoBase) => {
  if (subBase === videoBase) return true;
  return (
    subBase.startsWith(videoBase) &&
    /[^a-z0-9]/i.test(subBase.charAt(videoBase.length))
  );
};

const externalSubtitleLabel = (subFile, videoFile) => {
  const base = path.basename(subFile, path.extname(subFile));
  const videoBase = path.basename(videoFile, path.extname(videoFile));
  if (base === videoBase) return "Subtitles";

  const known = new Set(
    Object.values(LANGUAGE_NAMES).map((n) => n.toLowerCase()),
  );

  // "<video>.Hebrew 2.srt" — a numbered track of one language. Several
  // alternatives per language are normal (a downloaded title keeps every track
  // the stream offered), so the number has to survive into the label or they
  // all read "Hebrew" in the player.
  if (base.startsWith(videoBase)) {
    const suffix = base.slice(videoBase.length).replace(/^[ ._\-()[\]]+/, "");
    const m = suffix.match(/^([A-Za-z]{2,})[ ._-]*(\d{1,2})$/);
    if (m) {
      const lang =
        languageName(m[1]) ||
        (known.has(m[1].toLowerCase())
          ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
          : null);
      if (lang) return `${lang} ${m[2]}`;
    }
  }
  for (const token of base.toLowerCase().split(/[^a-z]+/)) {
    if (known.has(token)) return token.charAt(0).toUpperCase() + token.slice(1);
  }

  let label = base;
  if (base.startsWith(videoBase)) {
    const suffix = base.slice(videoBase.length).replace(/^[ ._\-()[\]]+/, "");
    if (suffix) label = suffix;
  }
  return languageName(label) || label;
};

// Find subtitle files for a video. Subs named after a different video in the
// folder are excluded; a folder-wide fallback applies only to single-video
// folders (movies). extraDirs contribute name-matched subs only.
const findSubtitleFiles = (dir, videoFile, extraDirs = []) => {
  const found = [];
  const seen = new Set();
  const videoBase = path.basename(videoFile, path.extname(videoFile));

  const collect = (folder, matchedOnly) => {
    const entries = listDir(folder).filter((e) => e.isFile());
    const subs = entries
      .map((e) => e.name)
      .filter((f) => hasExt(f, config.SUBTITLE_EXTENSIONS));
    const otherVideos = entries
      .map((e) => e.name)
      .filter((f) => hasExt(f, config.VIDEO_EXTENSIONS) && f !== videoFile)
      .map((f) => path.basename(f, path.extname(f)));

    const matched = subs.filter((f) =>
      subtitleBelongsTo(path.basename(f, path.extname(f)), videoBase),
    );

    let result;
    if (matched.length > 0) result = matched;
    else if (!matchedOnly && otherVideos.length === 0) result = subs;
    else result = [];

    result.sort(
      (a, b) =>
        (path.basename(a, path.extname(a)) === videoBase ? 0 : 1) -
          (path.basename(b, path.extname(b)) === videoBase ? 0 : 1) ||
        naturalCompare(a, b),
    );

    for (const f of result) {
      const abs = path.join(folder, f);
      if (!seen.has(abs)) {
        seen.add(abs);
        found.push({ dir: folder, file: f });
      }
    }
  };

  collect(dir, false);
  for (const extra of extraDirs) collect(extra, true);
  return found;
};

const embeddedSubtitleLabel = (stream, idx) => {
  const lang = languageName(stream.language);
  if (stream.title && lang && !stream.title.includes(lang)) {
    return `${lang} - ${stream.title}`;
  }
  return stream.title || lang || `Track ${idx + 1}`;
};

// Build the subtitle track list for a video (external + embedded-from-cache).
// Two different tracks can arrive with the same name — a sidecar called
// "English" next to an embedded stream whose language is also English. Both are
// real and both should stay, but a menu with two identical entries is a coin
// toss, so later collisions get numbered the way extra sidecars already are.
const uniqueLabels = (tracks) => {
  const taken = new Set();
  for (const t of tracks) {
    if (!taken.has(t.label)) {
      taken.add(t.label);
      continue;
    }
    let n = 2;
    while (taken.has(`${t.label} ${n}`)) n++;
    t.label = `${t.label} ${n}`;
    taken.add(t.label);
  }
  return tracks;
};

// The name a sidecar takes when it is downloaded to a viewer's machine. Desktop
// players only pick a sidecar up automatically when it sits beside the video
// under the same base name, which a folder-wide sub ("2_English.srt", shared by
// a single-video movie folder) does not — so those are renamed on the way out.
const subtitleDownloadName = (videoAbs, subAbs) => {
  const videoFile = path.basename(videoAbs);
  const subFile = path.basename(subAbs);
  const videoBase = path.basename(videoFile, path.extname(videoFile));
  if (
    subtitleBelongsTo(path.basename(subFile, path.extname(subFile)), videoBase)
  ) {
    return subFile;
  }
  const label = externalSubtitleLabel(subFile, videoFile).replace(
    /[\\/:*?"<>|]/g,
    "_",
  );
  return `${videoBase}.${label}${path.extname(subFile)}`;
};

const buildSubtitleTracks = (videoAbs, videoRel, videoFile, dir, extraDirs) => {
  const tracks = [];
  const videoId = makeId("video", videoRel);

  for (const sub of findSubtitleFiles(dir, videoFile, extraDirs)) {
    const subAbs = path.join(sub.dir, sub.file);
    const subId = register(
      "subtitle",
      subAbs,
      path.relative(config.ROOT, subAbs),
    );
    tracks.push({
      label: externalSubtitleLabel(sub.file, videoFile),
      url: `/stream/subtitle/${subId}`,
      // A sidecar is a real file, so it can be handed to a browser as-is. The
      // embedded tracks below only exist as an ffmpeg extraction and carry no
      // downloadUrl — that is how the client knows what it can offer.
      downloadUrl: `/stream/download/${videoId}/sub/${subId}`,
    });
  }

  const meta = metadata.getCached(videoAbs);
  if (meta) {
    for (const s of meta.subtitleStreams) {
      if (!s.text) continue;
      tracks.push({
        label: embeddedSubtitleLabel(s, s.index),
        url: `/stream/embedded/${videoId}/${s.index}`,
        embedded: true,
      });
    }
  }

  return uniqueLabels(tracks);
};

// ---------- scan ----------

const scanMovies = () => {
  const movies = [];
  for (const root of config.LIBRARIES.movies) {
    for (const entry of listDir(root)) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue; // skip hidden/staging folders
      const dir = path.join(root, entry.name);
      const videos = listDir(dir)
        .filter((e) => e.isFile() && hasExt(e.name, config.VIDEO_EXTENSIONS))
        .map((e) => e.name)
        .sort(naturalCompare);
      if (videos.length === 0) continue;

      const videoFile = videos[0];
      const videoAbs = path.join(dir, videoFile);
      const videoRel = path.relative(root, videoAbs);
      const id = register("video", videoAbs, videoRel);
      // A second video in a movie's folder (a 720p beside the 1080p, two
      // releases) is not indexed — the first one is the film — but the admin
      // is shown it as another copy (media/copies.js).
      if (videos.length > 1) siblingVideos.set(id, videos.slice(1).map((v) => path.join(dir, v)));
      const stat = statSafe(videoAbs);
      const cover = findCover(dir);
      const coverId = cover
        ? register(
            "image",
            path.join(dir, cover),
            path.relative(root, path.join(dir, cover)),
          )
        : null;
      const meta = metadata.getCached(videoAbs);

      const title = cleanTitle(entry.name);
      const web = online.get("movie", title);

      movies.push({
        id,
        type: "movie",
        title,
        year: extractYear(entry.name) || (web && web.year) || null,
        // The year above is the folder's own when it has one; otherwise it is
        // whatever the by-name metadata match said — a GUESS (and sometimes
        // another film's). Marked, so identity.js doesn't key on it.
        ...(!extractYear(entry.name) && web && web.year ? { yearGuessed: true } : {}),
        cover: coverId
          ? `/img/${coverId}`
          : web && web.poster
            ? `/img/meta/${web.poster}`
            : null,
        genres: (web && web.genres) || [],
        synopsis: (web && web.synopsis) || "",
        rating: (web && web.rating) || null,
        certificate: (web && web.certificate) || null,
        backdrop: `/img/still/${id}`,
        videoUrl: `/stream/video/${id}`,
        hlsUrl: `/stream/hls/${id}/index.m3u8`,
        transcodeBase: `/stream/transcode/${id}`,
        downloadUrl: `/stream/download/${id}`,
        // Container matters independently of codec: iOS hardware-decodes HEVC
        // but cannot demux MKV at all — the client needs both to decide.
        container: path.extname(videoFile).slice(1).toLowerCase(),
        duration: meta ? meta.duration : 0,
        width: meta ? meta.width : 0,
        height: meta ? meta.height : 0,
        container: path.extname(videoFile).slice(1).toLowerCase(),
        video: (meta && meta.video) || null,
        audio:
          meta && meta.audioStreams && meta.audioStreams[0]
            ? meta.audioStreams[0]
            : null,
        audioTracks: audioTracksOf(meta),
        sizeBytes: stat ? stat.size : 0,
        addedAt: stat ? stat.mtimeMs : 0,
        subtitles: buildSubtitleTracks(videoAbs, videoRel, videoFile, dir, []),
      });
    }
  }
  movies.sort((a, b) => naturalCompare(a.title, b.title));
  return movies;
};

const scanShows = () => {
  const shows = [];
  for (const root of config.LIBRARIES.shows) {
    for (const entry of listDir(root)) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue; // skip hidden/staging folders
      const showDir = path.join(root, entry.name);
      const episodes = [];
      const extras = [];

      const walk = (dir) => {
        for (const e of listDir(dir)) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(abs);
          } else if (hasExt(e.name, config.VIDEO_EXTENSIONS)) {
            const rel = path.relative(root, abs);
            const id = register("video", abs, rel);
            const stat = statSafe(abs);
            const parsed = parseEpisode(e.name);
            const relDir = path.relative(showDir, dir);
            const season =
              parsed.season !== null
                ? parsed.season
                : seasonFromFolder(relDir) || 1;
            const extraDirs = dir !== showDir ? [showDir] : [];
            const meta = metadata.getCached(abs);

            episodes.push({
              id,
              season,
              episode: parsed.episode,
              title: cleanEpisodeTitle(e.name) || e.name,
              fileName: e.name,
              videoUrl: `/stream/video/${id}`,
              hlsUrl: `/stream/hls/${id}/index.m3u8`,
              transcodeBase: `/stream/transcode/${id}`,
              downloadUrl: `/stream/download/${id}`,
              container: path.extname(e.name).slice(1).toLowerCase(),
              duration: meta ? meta.duration : 0,
              width: meta ? meta.width : 0,
              height: meta ? meta.height : 0,
              video: (meta && meta.video) || null,
              audio:
                meta && meta.audioStreams && meta.audioStreams[0]
                  ? meta.audioStreams[0]
                  : null,
              audioTracks: audioTracksOf(meta),
              sizeBytes: stat ? stat.size : 0,
              addedAt: stat ? stat.mtimeMs : 0,
              subtitles: buildSubtitleTracks(abs, rel, e.name, dir, extraDirs),
            });
          } else if (hasExt(e.name, config.EXTRA_EXTENSIONS)) {
            const rel = path.relative(root, abs);
            const id = register("extra", abs, rel);
            const stat = statSafe(abs);
            extras.push({
              name: e.name,
              sizeBytes: stat ? stat.size : 0,
              url: `/stream/download/${id}`,
            });
          }
        }
      };
      walk(showDir);

      if (episodes.length === 0 && extras.length === 0) continue;

      episodes.sort(
        (a, b) =>
          a.season - b.season ||
          (a.episode || 0) - (b.episode || 0) ||
          naturalCompare(a.fileName, b.fileName),
      );
      // Number unnumbered episodes by their position within the season
      const counters = {};
      const showTitle = cleanTitle(entry.name).toLowerCase();
      for (const ep of episodes) {
        counters[ep.season] = (counters[ep.season] || 0) + 1;
        if (ep.episode === null) ep.episode = counters[ep.season];
        // "Show S01E01.mp4" cleans to just the show name - not a real title
        if (!ep.title || ep.title.toLowerCase() === showTitle) {
          ep.title = `Episode ${ep.episode}`;
        }
      }

      const seasons = [];
      for (const ep of episodes) {
        let s = seasons.find((x) => x.number === ep.season);
        if (!s) {
          s = { number: ep.season, episodes: [] };
          seasons.push(s);
        }
        s.episodes.push(ep);
      }
      seasons.sort((a, b) => a.number - b.number);

      const cover = findCover(showDir);
      const coverId = cover
        ? register(
            "image",
            path.join(showDir, cover),
            path.relative(root, path.join(showDir, cover)),
          )
        : null;
      const showId = makeId("show", path.relative(root, showDir));
      const title = cleanTitle(entry.name);
      const web = online.get("show", title);

      shows.push({
        id: showId,
        type: "show",
        title,
        year: extractYear(entry.name) || (web && web.year) || null,
        // The year above is the folder's own when it has one; otherwise it is
        // whatever the by-name metadata match said — a GUESS (and sometimes
        // another film's). Marked, so identity.js doesn't key on it.
        ...(!extractYear(entry.name) && web && web.year ? { yearGuessed: true } : {}),
        cover: coverId
          ? `/img/${coverId}`
          : web && web.poster
            ? `/img/meta/${web.poster}`
            : null,
        genres: (web && web.genres) || [],
        synopsis: (web && web.synopsis) || "",
        rating: (web && web.rating) || null,
        certificate: (web && web.certificate) || null,
        backdrop: episodes.length > 0 ? `/img/still/${episodes[0].id}` : null,
        episodeCount: episodes.length,
        seasons,
        extras: extras.sort((a, b) => naturalCompare(a.name, b.name)),
        addedAt: episodes.reduce((m, e) => Math.max(m, e.addedAt), 0),
        duration: 0,
      });
    }
  }
  shows.sort((a, b) => naturalCompare(a.title, b.title));
  return mergeDuplicateShows(shows);
};

// Fold folders that are the same series into one library entry.
//
// Downloads name their folders "<Title> (<Year>)" while a library built by hand
// usually says just "<Title>", so one show could appear twice — seasons 1-4 in
// one entry, the downloaded season 6 in another. This merges the INDEX only: no
// file is moved and no episode id changes, so watch progress and watchlists
// survive untouched (ids are derived from the file's path). The entry with the
// most episodes keeps its id, since that's the one people have been opening.
const mergeDuplicateShows = (shows) => {
  const key = (s) =>
    `${(s.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "")}|${s.year || ""}`;
  const byKey = new Map();
  for (const show of shows) {
    const k = key(show);
    const seen = byKey.get(k);
    if (!seen) {
      byKey.set(k, show);
      continue;
    }

    // Keep the bigger one; fold the smaller one's seasons into it.
    const [keep, extra] =
      seen.episodeCount >= show.episodeCount ? [seen, show] : [show, seen];
    for (const season of extra.seasons) {
      const target = keep.seasons.find((x) => x.number === season.number);
      if (target) {
        target.episodes = [...target.episodes, ...season.episodes].sort(
          (a, b) => (a.episode || 0) - (b.episode || 0),
        );
      } else {
        keep.seasons.push(season);
      }
    }
    keep.seasons.sort((a, b) => a.number - b.number);
    keep.extras = [...(keep.extras || []), ...(extra.extras || [])];
    keep.episodeCount = keep.seasons.reduce((n, s) => n + s.episodes.length, 0);
    keep.addedAt = Math.max(keep.addedAt || 0, extra.addedAt || 0);
    // Take anything the kept entry is missing from the other folder.
    for (const field of [
      "cover",
      "backdrop",
      "synopsis",
      "rating",
      "certificate",
    ]) {
      if (!keep[field] && extra[field]) keep[field] = extra[field];
    }
    if ((!keep.genres || !keep.genres.length) && extra.genres)
      keep.genres = extra.genres;
    byKey.set(k, keep);
  }
  const merged = [...byKey.values()];
  if (merged.length !== shows.length) {
    console.log(
      `[scan] merged ${shows.length - merged.length} duplicate show folder(s) into existing entries`,
    );
  }
  return merged.sort((a, b) => naturalCompare(a.title, b.title));
};

const scan = () => {
  registry.clear();
  byPath.clear();
  siblingVideos.clear();
  scanListings = new Map();
  try {
    index.movies = scanMovies();
    index.shows = scanShows();
  } finally {
    scanListings = null;
  }
  index.scannedAt = Date.now();
  events.emit("scanned");
  return index;
};

// ---------- background enrichment (ffprobe queue) ----------

let enriching = false;

const allVideoPaths = () => {
  const paths = [];
  for (const m of index.movies) {
    const entry = registry.get(m.id);
    if (entry) paths.push(entry.path);
  }
  for (const s of index.shows) {
    for (const season of s.seasons) {
      for (const ep of season.episodes) {
        const entry = registry.get(ep.id);
        if (entry) paths.push(entry.path);
      }
    }
  }
  return paths;
};

const enrich = () => {
  if (enriching || !config.ffmpegAvailable) return;
  enriching = true;

  const paths = allVideoPaths().filter((p) => metadata.needsProbe(p));
  let i = 0;

  const step = () => {
    if (i >= paths.length) {
      enriching = false;
      if (paths.length > 0) {
        scan(); // rebuild index with the new metadata
        events.emit("updated");
      }
      // "enriched" says what this pass found: how many files it probed, and
      // whether this is the first pass to finish since the server started.
      // A pass with neither changed nothing anybody is looking at — and one
      // runs every ten minutes (server.js): listeners that make every device
      // ask again (enrichedChanged below) must not do so for it.
      const first = !index.enriched;
      index.enriched = true;
      events.emit("enriched", { probed: paths.length, first });
      return;
    }
    const p = paths[i++];
    // One file at a time, as before — but waited for, not blocked on
    // (metadata.probeAsync): requests are answered while ffprobe runs.
    metadata
      .probeAsync(p)
      .catch(() => {})
      .then(() => setImmediate(step));
  };
  step();
};

// Videos that need OCR: bitmap embedded subs, no usable subtitles
const bitmapOnlyVideos = () => {
  const result = [];
  const check = (item) => {
    const entry = registry.get(item.id);
    if (!entry) return;
    const meta = metadata.getCached(entry.path);
    if (!meta) return;
    const hasBitmap = meta.subtitleStreams.some((s) => !s.text);
    if (hasBitmap && item.subtitles.length === 0) {
      result.push({ path: entry.path, name: path.basename(entry.path) });
    }
  };
  index.movies.forEach(check);
  for (const s of index.shows) {
    for (const season of s.seasons) season.episodes.forEach(check);
  }
  return result;
};

// Did an "enriched" pass change what clients have? (No info at all — an
// emitter from before the info existed — counts as yes.)
const enrichedChanged = (info) => !info || info.probed > 0 || !!info.first;

const allItems = () => [...index.movies, ...index.shows];

// id -> the film, the show, or the episode with its show. findById used to
// walk the whole library for every id: every film, then every show and each
// of its episodes — and an id that is not in the library at all (a streamed
// title's `torrent|…` key, which is what most of a watch history is made of)
// walked ALL of it before answering null. Home asks about every row of a
// profile's history, so one Home request made about 3,000 of those walks over
// 1,860 entries (measured, docs/qa/backend-efficiency: 575 ms of CPU a
// request on a two-core box). The map is built on first use after a scan
// and answers what the walk answered: the first match in the same order
// (films, then each show followed by its own episodes).
let lookup = null;
let lookupOf = { movies: null, shows: null, nMovies: -1, nShows: -1 };
const lookupMap = () => {
  if (
    lookup && lookupOf.movies === index.movies && lookupOf.shows === index.shows &&
    lookupOf.nMovies === index.movies.length && lookupOf.nShows === index.shows.length
  ) return lookup;
  const map = new Map();
  for (const m of index.movies) if (m && !map.has(m.id)) map.set(m.id, { item: m });
  for (const s of index.shows) {
    if (!s) continue;
    if (!map.has(s.id)) map.set(s.id, { item: s });
    for (const season of s.seasons || []) {
      for (const ep of (season && season.episodes) || []) {
        if (ep && !map.has(ep.id)) map.set(ep.id, { ep, show: s });
      }
    }
  }
  lookup = map;
  lookupOf = { movies: index.movies, shows: index.shows, nMovies: index.movies.length, nShows: index.shows.length };
  return map;
};

const findById = (id) => {
  const hit = lookupMap().get(id);
  if (!hit) return null;
  if (hit.item) return hit.item;
  // an episode: a fresh object every time, as before (callers add to it)
  const s = hit.show;
  return { ...hit.ep, showId: s.id, showTitle: s.title, cover: s.cover };
};

const resolve = (id) => registry.get(id) || null;

module.exports = {
  index,
  events,
  scan,
  enrich,
  isEnriching: () => enriching,
  enrichedChanged,
  resolve,
  idForPath,
  otherVideosOf,
  findById,
  allItems,
  bitmapOnlyVideos,
  makeId,
  subtitleDownloadName,
  // Test-only: folding "<Title>" and "<Title> (<Year>)" folders into one entry
  // must never drop an episode or renumber a season.
  _internals: { mergeDuplicateShows, uniqueLabels, naturalCompare },
};
