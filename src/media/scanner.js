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
const subnames = require("./subnames");
const sublang = require("./sublang");
// (loaded with the scanner, as sublang is: its store is read once, at start —
// not in the middle of a scan)
const subaudio = require("./subaudio");
const online = require("./online");
const scanwalk = require("./scanwalk");
const scanworkerLib = require("../lib/lazy")(require, "./scanworker");
const statsnap = require("../lib/statsnap");

const events = new EventEmitter();

// The files whose size and date a walk keeps: what the index shows (videos,
// extras) and what the subtitle passes date (subtitles).
let statExts = null;
let statExtsOf = null;
const STAT_EXTS = () => {
  const key = `${config.VIDEO_EXTENSIONS}|${config.EXTRA_EXTENSIONS}|${config.SUBTITLE_EXTENSIONS}`;
  if (statExtsOf !== key) {
    statExts = new Set([...config.VIDEO_EXTENSIONS, ...config.EXTRA_EXTENSIONS, ...config.SUBTITLE_EXTENSIONS].map((e) => e.toLowerCase()));
    statExtsOf = key;
  }
  return statExts;
};

// id -> { path, kind } used by streaming/image endpoints
const registry = new Map();

const index = {
  movies: [],
  shows: [],
  // when the library folders were last looked at (every scan moves it)
  scannedAt: null,
  // what the library HOLDS, as a number: moves only when a scan found
  // something different. Everything that keeps work built from the library
  // keys it on this, so a rescan that found nothing new rebuilds nothing.
  version: 0,
  changedAt: null, // when the version last moved
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

// path.relative() normalises both sides on every call: 40 ms of a rebuild on
// a library of 1,800 files. A path made by path.join(root, …) begins with the
// root itself, and what is relative to it is the rest — the same string.
// Anything else (a root written with other separators, another drive, the
// app folder) goes through path.relative as before, remembered.
const relMemo = new Map();
const relTo = (from, to) => {
  if (to.length > from.length + 1 && to.startsWith(from) && to[from.length] === path.sep && !from.endsWith(path.sep)) {
    return to.slice(from.length + 1);
  }
  const k = `${from}\u0000${to}`;
  let r = relMemo.get(k);
  if (r === undefined) {
    r = path.relative(from, to);
    if (relMemo.size >= 200000) relMemo.clear();
    relMemo.set(k, r);
  }
  return r;
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
  return list.map((a, i) => {
    const name = subnames.audioName(a, i);
    return {
      index: a.index != null ? a.index : i,
      language: a.language || null,
      title: a.title || null,
      codec: a.codec || null,
      channels: a.channels || 2,
      // the menu's name for it, the same on the site and the TV
      // ("English", "English · Commentary"; "Track 2" only when the file says nothing)
      label: name.label,
      ...(name.lang ? { lang: name.lang } : {}),
    };
  });
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

// (every other tag or name subnames.js knows, too: "cat", "Catalan", "nob")
const languageName = (code) =>
  code ? LANGUAGE_NAMES[code.toLowerCase()] || (require("./subnames").normLang(code) || {}).name || null : null;

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
//
// Since the server round of 2026-10-18 a scan does not read the disk at all
// while it builds: media/scanwalk.js reads every listing and the size and
// date of every video, extra and subtitle first (in a worker thread for the
// ten-minute rescan, media/scanworker.js), and the build below takes them
// from that snapshot. `building` is the snapshot being built from.
let building = null; // { snap, lists: Map<dir, entries> }
const readDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
// An entry of a snapshot listing, shaped like the fs.Dirent the code below reads.
class SnapEntry {
  constructor(name, kind) { this.name = name; this.kind = kind; }
  isFile() { return this.kind === scanwalk.FILE; }
  isDirectory() { return this.kind === scanwalk.DIR; }
}
const listDir = (dir) => {
  if (!building) return readDir(dir);
  let hit = building.lists.get(dir);
  if (!hit) {
    const raw = building.snap.dirs[dir];
    hit = raw ? raw.map(([name, kind]) => new SnapEntry(name, kind)) : readDir(dir);
    building.lists.set(dir, hit);
  }
  return hit;
};

// What a snapshot knows of a path: { size, mtimeMs }, null (its folder was
// read and it is not there, or it could not be looked at), or undefined (the
// walk did not look: ask the disk).
const snapLookup = (snap) => (p) => {
  const f = snap.files[p];
  if (f) return { size: f[0], mtimeMs: f[1] };
  const list = snap.dirs[path.dirname(p)];
  if (!list) return undefined;
  const name = path.basename(p);
  const entry = list.find((e) => e[0] === name);
  if (!entry) return null;
  // listed, but of a kind the walk does not date (a cover, a folder — or,
  // for a walk on the main thread, a subtitle: those are dated when asked)
  const dated = snap.exts ? snap.exts.includes(path.extname(name).toLowerCase()) : STAT_EXTS().has(path.extname(name).toLowerCase());
  return entry[1] === scanwalk.FILE && dated ? null : undefined;
};

const statSafe = (p) => {
  if (building) {
    const hit = building.lookup(p);
    if (hit !== undefined) return hit;
  }
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

const KNOWN_LANGUAGE_WORDS = new Set(Object.values(LANGUAGE_NAMES).map((n) => n.toLowerCase()));
const externalSubtitleLabel = (subFile, videoFile) => {
  const base = path.basename(subFile, path.extname(subFile));
  const videoBase = path.basename(videoFile, path.extname(videoFile));
  if (base === videoBase) return "Subtitles";

  const known = KNOWN_LANGUAGE_WORDS;

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

// An embedded stream's name, language code and flags — media/subnames.js
// (the file's tag, its title, its dispositions; for a stream the file left
// untagged, the language read off its text by media/sublang.js).
const embeddedSubtitleTrack = (stream, detected) => subnames.subtitleName(stream, detected, stream.index);

// The language a sidecar's label names ("Hebrew 2" -> he), or null.
const labelLang = (label) => {
  const l = subnames.normLang(String(label || "").replace(/\s+\d+$/, "")) ||
    subnames.normLang(String(label || "").split(/[\s(]/)[0]);
  return l ? l.code : null;
};

// Build the subtitle track list for a video (external + embedded-from-cache).
// Two different tracks can arrive with the same name — a sidecar called
// "English" next to an embedded stream whose language is also English. Both are
// real and both should stay, but a menu with two identical entries is a coin
// toss, so later collisions get numbered the way extra sidecars already are.
const uniqueLabels = (tracks) => subnames.uniqueLabels(tracks);

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
  const sidecarPaths = new Map(); // track -> its file
  const videoId = makeId("video", videoRel);

  for (const sub of findSubtitleFiles(dir, videoFile, extraDirs)) {
    const subAbs = path.join(sub.dir, sub.file);
    const subId = register(
      "subtitle",
      subAbs,
      relTo(config.ROOT, subAbs),
    );
    let label = externalSubtitleLabel(sub.file, videoFile);
    let lang = labelLang(label);
    let sdh = /\b(?:sdh|cc)\b/i.test(sub.file);
    let forced = /\bforced\b/i.test(sub.file);
    if (!lang) {
      // a name that says no language ("Movie.srt", "2_Eng_track.srt" aside):
      // the text says it (media/sublang.js, read once in the background)
      const det = sublang.forFile(subAbs);
      if (det && det.lang) {
        const named = subnames.subtitleName({ language: det.lang, sdh: sdh || det.sdh, forced }, null);
        label = named.label;
        lang = named.lang;
        sdh = named.sdh;
      }
    }
    tracks.push({
      label,
      url: `/stream/subtitle/${subId}`,
      // A sidecar is a real file, so it can be handed to a browser as-is. The
      // embedded tracks below only exist as an ffmpeg extraction and carry no
      // downloadUrl — that is how the client knows what it can offer.
      downloadUrl: `/stream/download/${videoId}/sub/${subId}`,
      ...(lang ? { lang } : {}),
      ...(sdh ? { sdh: true } : {}),
      ...(forced ? { forced: true } : {}),
    });
    sidecarPaths.set(tracks[tracks.length - 1], subAbs);
    const timing = timingOfSidecar(subAbs);
    if (timing) tracks[tracks.length - 1].timing = timing;
  }
  // A sidecar the background check could NOT line up with the video's own
  // track (a different cut, a wrong file: media/sublang.js) goes after the
  // ones it could, so the automatic pick — the first full track in the
  // viewer's language (lang.js bestTrackIndex) — lands on one in time.
  // Stable: everything else keeps its order (and its name).
  const rank = (t) => (sublang.syncVerdict(sidecarPaths.get(t)) === "unmatched" ? 1 : 0);
  tracks.sort((a, b) => rank(a) - rank(b));

  const meta = metadata.getCached(videoAbs);
  if (meta) {
    const detected = sublang.forVideo(videoAbs, meta.mtime);
    for (const s of meta.subtitleStreams) {
      if (!s.text) continue;
      const named = embeddedSubtitleTrack(s, detected && detected[s.index]);
      const timing = timingOfEmbedded(videoAbs, s.index);
      tracks.push({
        label: named.label,
        url: `/stream/embedded/${videoId}/${s.index}`,
        embedded: true,
        ...(timing ? { timing } : {}),
        ...(named.lang ? { lang: named.lang } : {}),
        ...(named.forced ? { forced: true } : {}),
        ...(named.sdh ? { sdh: true } : {}),
        ...(named.commentary ? { commentary: true } : {}),
      });
    }
  }

  return starBest(uniqueLabels(tracks));
};

// ---------- which track matches THIS release (the menu's ★) ----------
// What is known about a track's timing against this file: from its audio
// (media/subaudio.js — the Resync button or the background) or, for a
// sidecar, from the file's own text track (media/sublang.js).
//   -> { verdict: "in-time"|"moved"|"parts"|"unmatched"|"original", by, words, r? } | undefined
const timingOfSidecar = (subAbs) => {
  let t = null;
  try { t = subaudio.timingOf({ kind: "file", path: subAbs }); } catch {}
  const v = sublang.syncVerdict(subAbs);
  const byTrack = v === "in-time" || v === "moved" || v === "unmatched" ? { verdict: v, by: "track" } : undefined;
  if (!t || t.verdict === "error") return byTrack;
  // the audio could not tell, but the video's own text track could: that
  // evidence stands (it is what the file is served with)
  if (t.verdict === "unmatched" && byTrack && byTrack.verdict !== "unmatched") return byTrack;
  return { verdict: t.verdict, by: "audio", words: t.words, ...(t.r != null ? { r: t.r } : {}), ...(t.source === "resync" ? { resync: true } : {}) };
};
const timingOfEmbedded = (videoAbs, index) => {
  let t = null;
  try { t = subaudio.timingOf({ kind: "emb", video: videoAbs, index }); } catch {}
  if (!t || t.verdict === "error") return undefined;
  return { verdict: t.verdict, by: "audio", words: t.words, ...(t.r != null ? { r: t.r } : {}), ...(t.cues != null ? { cues: t.cues } : {}), ...(t.source === "resync" ? { resync: true } : {}) };
};

// Within its language, how good a default a track is (the players' own rule,
// public/js/lang.js trackRank): 0 full, 1 SDH, 2 forced / signs / commentary.
const trackRankOf = (t) => {
  const l = String(t.label || "");
  if (t.forced === true || t.commentary === true || /forced|(?:^|[^a-z])signs?(?:[^a-z]|$)|songs|commentary/i.test(l)) return 2;
  if (t.sdh === true || /(?:^|[^a-z])(?:sdh|cc)(?:[^a-z]|$)|hearing|closed.?caption/i.test(l)) return 1;
  return 0;
};

// How well a track is known to match THIS release, as it is SERVED (lower
// is better; null: it may not have the star).
//   0  a track inside the file, nothing found against it: it was made for
//      this release (empty, broken or matching nothing loses that)
//   1  in time as it is (a sidecar the audio or the video's own track found
//      in time)
//   2  in time after one offset / frame-rate correction
//   3  in time after a correction in parts (another cut, adapted)
// A sidecar nothing has checked yet, one that matched nothing, and a track
// served with the file's own timing after the audio found it off never get
// it. (An embedded track the background found off is served as the file has
// it — only a Resync moves it — so it is not "matching" until then.)
const matchClass = (t) => {
  const tm = t.timing;
  if (t.embedded) {
    if (!tm || tm.verdict === "original") return 0;
    if (tm.cues != null && tm.cues < 20) return null;
    if (tm.verdict === "in-time") return 0;
    if (tm.resync && tm.verdict === "moved") return 2;
    if (tm.resync && tm.verdict === "parts") return 3;
    return null;
  }
  if (!tm) return null;
  return { "in-time": 1, moved: 2, parts: 3 }[tm.verdict] ?? null;
};

// ONE ★ per language, on the track that matches this release, only where
// the evidence says so (matchClass): a track inside the file wins its
// language unless something was found wrong with it; else the sidecar that
// needed the least correction, the better match (r, after correction)
// first. Only the language's best KIND of track competes — a forced / signs
// track never wins the star for full subtitles (and a language that has only
// those gets none). The players switch the ★ track on for the viewer's
// language (lang.js bestTrackIndex) — after a pick by hand they leave it
// alone.
const STAR_WHY = "Matches this release";
const starBest = (tracks) => {
  const byLang = new Map();
  tracks.forEach((t, i) => {
    if (!t.lang) return;
    if (!byLang.has(t.lang)) byLang.set(t.lang, []);
    byLang.get(t.lang).push(i);
  });
  for (const idx of byLang.values()) {
    const rank = Math.min(...idx.map((i) => trackRankOf(tracks[i])));
    if (rank >= 2) continue;
    let best = null;
    for (const i of idx) {
      if (trackRankOf(tracks[i]) !== rank) continue;
      const k = matchClass(tracks[i]);
      if (k == null) continue;
      const r = (tracks[i].timing && tracks[i].timing.r) || 0;
      if (!best || k < best.k || (k === best.k && r > best.r)) best = { i, k, r };
    }
    if (best) Object.assign(tracks[best.i], { star: true, starWhy: STAR_WHY });
  }
  return tracks;
};

// Library files whose subtitles have not been checked against the audio yet
// (media/subaudio.js background): every sidecar, and the embedded text
// tracks in the household's languages (scored only, never moved without a
// Resync). Files with a Hebrew sidecar first. -> jobs for subaudio.enqueue
const AUDIO_SCORE_LANGS = new Set(["he", "en", "ru"]);
const audioSyncWork = () => {
  const jobs = [];
  const check = (item) => {
    const entry = registry.get(item.id);
    if (!entry || !entry.path) return;
    const subs = [];
    let hebrew = false;
    for (const t of item.subtitles || []) {
      if (!t.url) continue;
      if (t.embedded) {
        if (!AUDIO_SCORE_LANGS.has(t.lang) || trackRankOf(t) >= 2) continue;
        const m = /\/(\d+)$/.exec(t.url);
        if (m) subs.push({ kind: "emb", video: entry.path, index: Number(m[1]) });
        continue;
      }
      const sub = registry.get(t.url.split("/").pop());
      if (!sub || !sub.path) continue;
      subs.push({ kind: "file", path: sub.path });
      if (t.lang === "he") hebrew = true;
    }
    // (a file whose sidecars are all settled is not listened to for its
    // embedded tracks alone: those are only scored beside a sidecar)
    const todo = subs.filter((s) => subaudio._internals.needsWork(s, entry.path));
    if (todo.some((s) => s.kind === "file")) jobs.push({ video: entry.path, subs: todo, hebrew });
  };
  index.movies.forEach(check);
  for (const s of index.shows) {
    for (const season of s.seasons) season.episodes.forEach(check);
  }
  return jobs;
};

// ---------- scan ----------

// A second download of a title already on disk is kept beside it as
// "<name> (2).mkv", "(3)"… (media/downloads.js never writes over a file).
// Such a copy sorts AFTER the files without that mark, so it never takes the
// original's place: in a film's folder the first video is the film (its
// library id, and everyone's progress, come from that file's path), and of
// two files of one episode the original is listed first.
const COPY_MARK = / \((\d{1,2})\)$/;
const isCopyName = (fileName) => {
  const m = COPY_MARK.exec(path.basename(fileName, path.extname(fileName)));
  return !!m && Number(m[1]) >= 2;
};
const copyLastCompare = (a, b) => (isCopyName(a) ? 1 : 0) - (isCopyName(b) ? 1 : 0) || naturalCompare(a, b);

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
        .sort(copyLastCompare);
      if (videos.length === 0) continue;

      const videoFile = videos[0];
      const videoAbs = path.join(dir, videoFile);
      const videoRel = relTo(root, videoAbs);
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
            relTo(root, path.join(dir, cover)),
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
            const rel = relTo(root, abs);
            const id = register("video", abs, rel);
            const stat = statSafe(abs);
            const parsed = parseEpisode(e.name);
            const relDir = relTo(showDir, dir);
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
            const rel = relTo(root, abs);
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
          copyLastCompare(a.fileName, b.fileName),
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
            relTo(root, path.join(showDir, cover)),
          )
        : null;
      const showId = makeId("show", relTo(root, showDir));
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

// ---------- scan: walk, then build ----------
//
// scan()       walks on THIS thread and builds: for a caller that needs the
//              index to show a change right now (a download landed, a file
//              was deleted, the admin's Rescan, the tests).
// scanAsync()  walks in a worker thread (media/scanworker.js) and builds
//              when the walk is back: the ten-minute rescan and the
//              background passes' "the library learned something". The
//              event loop is never held for the disk. Concurrent calls share
//              one run (and ask for one more after it when they came late).
//
// An UNCHANGED rescan keeps the index: when nothing the index is built from
// moved — the walk's digest, the probe cache, the subtitle-language and
// subtitle-timing stores, the online metadata — the build is skipped (a
// scanAsync; at least once an hour it builds anyway); and a build whose
// result is identical to the last one is thrown away. Either way the index
// arrays and `index.version` stay the same, and everything keyed on the
// version (identity stamps, the search index, title history, the kept
// library answer…) keeps its work. `scannedAt` moves on every scan, as it
// always did. "scanned" carries { changed }.
const FULL_WALK_EVERY = 6; // every sixth worker walk re-reads every file's date (scanwalk.js)
const REBUILD_MS = 60 * 60 * 1000;
let lastSnap = null;
let built = { inputs: null, hash: null, at: 0 };
const storeRevs = () => {
  let s = `${metadata._store.rev}`;
  try { s += `|${sublang.rev()}`; } catch {}
  try { s += `|${subaudio.rev()}`; } catch {}
  try { s += `|${online.rev()}`; } catch {}
  return s;
};
const walkOpts = (skipUnchanged) => ({
  movies: config.LIBRARIES.movies,
  shows: config.LIBRARIES.shows,
  statExts: [...STAT_EXTS()],
  skipUnchanged,
});
// A scan on the main thread (somebody is waiting for it) reads no more than
// scans always read: the listings and the size and date of every video and
// extra — not the folders' dates, nor the subtitles' (the subtitle passes
// date the few they look at when they look).
const syncWalkOpts = () => ({
  movies: config.LIBRARIES.movies,
  shows: config.LIBRARIES.shows,
  statExts: [...config.VIDEO_EXTENSIONS, ...config.EXTRA_EXTENSIONS].map((e) => e.toLowerCase()),
  dateFolders: false,
});

// The build: the index from a snapshot, no filesystem call (statsnap: the
// subtitle passes' dates come from it too). -> { movies, shows }
const build = (snap) => {
  registry.clear();
  byPath.clear();
  siblingVideos.clear();
  const lookup = snapLookup(snap);
  building = { snap, lists: new Map(), lookup };
  try {
    return statsnap.within(lookup, () => {
      const movies = scanMovies();
      const shows = scanShows();
      return { movies, shows };
    });
  } finally {
    building = null;
  }
};
const hashOf = (next) => crypto.createHash("sha1").update(JSON.stringify(next)).digest("base64");

let syncScans = 0; // a sync scan that lands while a worker walk is out makes that walk stale
const apply = (snap, { force = true } = {}) => {
  const now = Date.now();
  const inputs = `${snap.hash}|${storeRevs()}`;
  let changed = false;
  if (force || inputs !== built.inputs || now - built.at > REBUILD_MS || !index.scannedAt) {
    const next = build(snap);
    const hash = hashOf(next);
    if (hash !== built.hash || !index.scannedAt) {
      index.movies = next.movies;
      index.shows = next.shows;
      index.version++;
      index.changedAt = now;
      built.hash = hash;
      changed = true;
    }
    built.inputs = inputs;
    built.at = now;
    scanStats.builds++;
  } else scanStats.skipped++;
  lastSnap = snap;
  index.scannedAt = now;
  scanStats.last = { at: now, changed, calls: snap.calls, reused: snap.reused, hash: snap.hash };
  if (!snap.saved) {
    saveWalk(snap);
    if (changed) { try { pruneProbes(snap); } catch {} }
  }
  firstResolve();
  events.emit("scanned", { changed, version: index.version });
  return index;
};
const scanStats = { builds: 0, skipped: 0, async: 0, last: null, probesPruned: 0 };

// The probe cache (metadata-cache.json) keeps an entry for every file ever
// probed — a film deleted a year ago included. After a scan that changed
// the library, entries for files inside a library folder that the library no
// longer holds are dropped (never while a library folder cannot be read: an
// unplugged drive is not a deleted film; files outside the library folders
// are left alone).
const pruneProbes = (snap) => {
  let libroots;
  try { libroots = require("../lib/libroots"); } catch { return 0; }
  const dirs = [...config.LIBRARIES.movies, ...config.LIBRARIES.shows];
  if (!dirs.length) return 0;
  // a library folder the walk found empty may be an unplugged drive: nothing goes
  if (!snap || dirs.some((d) => !(snap.dirs[d] && snap.dirs[d].length))) return 0;
  const keep = new Set(byPath.keys());
  for (const list of siblingVideos.values()) for (const p of list) keep.add(p);
  const data = metadata._store.data;
  let n = 0;
  for (const p of Object.keys(data)) {
    if (keep.has(p) || !libroots.isUnder(p, dirs)) continue;
    delete data[p];
    n++;
  }
  if (n) { metadata._store.save(); scanStats.probesPruned += n; }
  return n;
};

const scan = () => {
  syncScans++;
  return apply(scanwalk.walk(syncWalkOpts()));
};

let asyncRun = null;
let asyncAgain = false;
let asyncForce = false;
let workerWalks = 0;
// force: build even if nothing it is built from moved; full: re-date every
// file (no folder-date skipping — scanwalk.js)
let asyncFull = false;
const scanAsync = ({ force = false, full = false } = {}) => {
  if (asyncRun) {
    asyncAgain = true;
    asyncForce = asyncForce || force;
    asyncFull = asyncFull || full;
    return asyncRun;
  }
  asyncForce = force;
  asyncFull = full;
  asyncRun = (async () => {
    try {
      do {
        asyncAgain = false;
        const f = asyncForce;
        asyncForce = false;
        const syncBefore = syncScans;
        const full = workerWalks++ % FULL_WALK_EVERY === 0 || asyncFull;
        asyncFull = false;
        const snap = await scanworkerLib().walk(walkOpts(!full));
        scanStats.async++;
        // a scan on the main thread landed while this walk was out: it saw
        // the disk later than this walk did, so this one is not applied
        if (syncScans !== syncBefore) continue;
        apply(snap, { force: f });
      } while (asyncAgain);
    } finally {
      asyncRun = null;
    }
    return index;
  })();
  return asyncRun;
};

// ---------- start-up: the last run's walk, at once ----------
// The walk that built the index is kept on disk (data/cache/library-walk.json,
// rewritten only when what is on disk changed — a cache: missing or damaged
// is a first start). At start-up the index is built from it before the port
// is listening — no folder is read, a restart serves the library it had at
// once — and the first worker walk (server.js, after listen) brings it up to
// date. With nothing saved, library requests wait for that walk (libraryReady).
const SAVED_V = 1;
const savedFile = () => path.join(config.CACHE_DIR, "library-walk.json");
let savedHash = null;
let saving = false;
let saveNext = null; // a newer walk that arrived while one was being written
const saveWalk = (snap) => {
  if (!snap) return;
  if (saving) { saveNext = snap; return; }
  if (snap.hash === savedHash) return;
  saving = true;
  const done = () => {
    saving = false;
    const next = saveNext;
    saveNext = null;
    if (next) saveWalk(next);
  };
  const file = savedFile();
  const roots = { movies: config.LIBRARIES.movies, shows: config.LIBRARIES.shows };
  let text;
  try {
    text = JSON.stringify({ v: SAVED_V, roots, dirs: snap.dirs, dirAt: snap.dirAt, files: snap.files, hash: snap.hash });
  } catch { done(); return; }
  const tmp = `${file}.tmp`;
  fs.writeFile(tmp, text, (err) => {
    if (err) return done();
    fs.rename(tmp, file, (err2) => {
      if (!err2) savedHash = snap.hash;
      done();
    });
  });
};
const readSavedWalk = () => {
  try {
    const d = JSON.parse(fs.readFileSync(savedFile(), "utf8"));
    if (!d || d.v !== SAVED_V || !d.dirs || !d.files || !d.dirAt) return null;
    const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
    if (!same(d.roots && d.roots.movies, config.LIBRARIES.movies) || !same(d.roots && d.roots.shows, config.LIBRARIES.shows)) return null;
    savedHash = d.hash;
    return { dirs: d.dirs, dirAt: d.dirAt, files: d.files, hash: d.hash, calls: { readdir: 0, stat: 0 }, reused: 0, saved: true };
  } catch {
    return null;
  }
};
let firstResolve;
const firstScan = new Promise((r) => { firstResolve = r; });
// -> true when the index came from the saved walk
const boot = () => {
  const snap = readSavedWalk();
  if (!snap) return false;
  try {
    apply(snap);
    console.log(`[scan] library from the last run: ${index.movies.length} movies, ${index.shows.length} shows (the folders are read again in the background)`);
    return true;
  } catch (e) {
    console.warn(`[scan] the saved walk could not be used (${(e && e.message) || e}); reading the folders`);
    return false;
  }
};

// Express middleware: until the library has been read once, a request that
// needs it waits for that (20 s at most). What does not need the library —
// the health check, who-am-I, sign-in, the app shell — never waits.
const READY_WAIT_MS = 20 * 1000;
const NEEDS_LIBRARY = /^\/(api|stream|img|offline)\//;
const NEVER_WAITS = /^\/api\/(ping|me|server-info|usage)$|^\/api\/auth\//;
const libraryReady = (req, res, next) => {
  if (index.scannedAt || !NEEDS_LIBRARY.test(req.path) || NEVER_WAITS.test(req.path)) return next();
  let done = false;
  const go = () => { if (!done) { done = true; clearTimeout(t); next(); } };
  const t = setTimeout(go, READY_WAIT_MS);
  firstScan.then(go);
};

// A library file's { size, mtimeMs } as the last walk saw it, or null when
// the walk did not date it (not a video / extra / subtitle, not in the library).
const walkedStat = (absPath) => {
  const f = lastSnap && lastSnap.files[absPath];
  return f ? { size: f[0], mtimeMs: f[1] } : null;
};

// Run fn with the last walk's dates standing in for the disk (the background
// work lists right after a scan: audioSyncWork etc. — see statsnap.js).
// knownOnly: answer only for files the walk dated (anything else: the disk) —
// for a request, where a file may have arrived since the walk.
const withLastWalk = (fn, { knownOnly = false } = {}) => {
  if (!lastSnap) return fn();
  const snap = lastSnap;
  return statsnap.within(knownOnly ? (p) => { const f = snap.files[p]; return f ? { size: f[0], mtimeMs: f[1] } : undefined; } : snapLookup(snap), fn);
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

  // (with the date the walk saw: a file replaced under its old name is probed again)
  const paths = allVideoPaths().filter((p) => { const w = walkedStat(p); return metadata.needsProbe(p, w ? w.mtimeMs : null); });
  let i = 0;

  const step = () => {
    if (i >= paths.length) {
      // "enriched" says what this pass found: how many files it probed, and
      // whether this is the first pass to finish since the server started.
      // A pass with neither changed nothing anybody is looking at — and one
      // runs every ten minutes (server.js): listeners that make every device
      // ask again (enrichedChanged below) must not do so for it.
      const finish = () => {
        enriching = false;
        const first = !index.enriched;
        index.enriched = true;
        events.emit("enriched", { probed: paths.length, first });
      };
      if (paths.length > 0) {
        // rebuild the index with the new metadata (the walk off the event loop)
        scanAsync()
          .catch((e) => { console.warn(`[scan] rescan after probing failed: ${(e && e.message) || e}`); scan(); })
          .then(() => events.emit("updated"))
          .finally(finish);
        return;
      }
      finish();
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

// Subtitle tracks nothing names — embedded text streams with no language tag
// or telling title, and sidecars whose file name says no language — that
// media/sublang.js has not read yet. -> jobs for sublang.enqueue
const unnamedSubtitleWork = () => {
  const jobs = [];
  const check = (item) => {
    const entry = registry.get(item.id);
    if (!entry) return;
    const meta = metadata.getCached(entry.path);
    const unnamed = sublang.unnamedTracks(meta);
    if (unnamed.length && !sublang.known(entry.path, meta.mtime)) {
      jobs.push({ kind: "video", path: entry.path, indices: unnamed.map((s) => s.index) });
    }
    for (const t of item.subtitles || []) {
      if (t.embedded || t.lang || !t.url) continue;
      const sub = registry.get(t.url.split("/").pop());
      if (sub && sub.path && !sublang.known(sub.path)) jobs.push({ kind: "file", path: sub.path });
    }
  };
  index.movies.forEach(check);
  for (const s of index.shows) {
    for (const season of s.seasons) season.episodes.forEach(check);
  }
  return jobs;
};

// Sidecars of videos that carry a text track of their own, not yet lined up
// against it (media/sublang.js "sync" jobs: media/subsync.js align). The
// reference is the file's own English track when it has one (not SDH, never
// a forced one), else its first full text track.
const subtitleSyncWork = () => {
  const jobs = [];
  const check = (item) => {
    const entry = registry.get(item.id);
    if (!entry) return;
    const meta = metadata.getCached(entry.path);
    const text = ((meta && meta.subtitleStreams) || []).filter((s) => s.text && !s.forced && !/forced/i.test(s.title || ""));
    if (!text.length) return;
    const detected = sublang.forVideo(entry.path, meta.mtime) || {};
    const english = (s) => (subnames.normLang(s.language) || {}).code === "en" || (detected[s.index] || {}).lang === "eng";
    const ref = (text.find((s) => english(s) && !s.sdh) || text.find(english) || text[0]).index;
    const subs = [];
    for (const t of item.subtitles || []) {
      if (t.embedded || !t.url) continue;
      const sub = registry.get(t.url.split("/").pop());
      if (sub && sub.path && !sublang.syncKnown(sub.path, entry.path)) subs.push(sub.path);
    }
    if (subs.length) jobs.push({ kind: "sync", path: entry.path, ref, subs });
  };
  index.movies.forEach(check);
  for (const s of index.shows) {
    for (const season of s.seasons) season.episodes.forEach(check);
  }
  return jobs;
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
  scanAsync,
  boot,
  libraryReady,
  walkedStat,
  withLastWalk,
  scanStats: () => ({ ...scanStats, version: index.version, worker: (() => { try { return require("./scanworker").stats(); } catch { return null; } })() }),
  enrich,
  isEnriching: () => enriching,
  enrichedChanged,
  resolve,
  idForPath,
  otherVideosOf,
  findById,
  allItems,
  bitmapOnlyVideos,
  // (the dates these compare come from the last walk, not the disk: statsnap.js)
  unnamedSubtitleWork: () => withLastWalk(unnamedSubtitleWork),
  subtitleSyncWork: () => withLastWalk(subtitleSyncWork),
  audioSyncWork: () => withLastWalk(audioSyncWork),
  starBest,
  makeId,
  subtitleDownloadName,
  // Test-only: folding "<Title>" and "<Title> (<Year>)" folders into one entry
  // must never drop an episode or renumber a season.
  _internals: { relTo, registrySize: () => registry.size, idMemoSize: () => idMemo.size, pruneProbes, mergeDuplicateShows, uniqueLabels, naturalCompare, isCopyName, copyLastCompare },
};
