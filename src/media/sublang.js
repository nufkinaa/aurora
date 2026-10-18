// The language of subtitle tracks the FILE does not name, read off their text.
//
// 209 of the library's embedded text tracks carry no language tag and no
// title (one Silo episode alone: 42), and the menu could only call them
// "Track 1", "Track 2"… (the admin inbox, 2026-10). Once per file, in the
// background, every such track is extracted — ONE ffmpeg pass for all of a
// file's tracks, written into the same cache the player is served from, so
// the work is not wasted — and media/subnames.js detectLanguage reads the
// language from the words and letters. A sidecar whose name says no language
// ("Movie.srt") is read the same way (no ffmpeg: it is a small text file).
//
// Results are kept per path + mtime in data/sub-langs.json; a file that
// changes is looked at again, one that failed is not retried until it does.
// Runs through the background budget (media/cpuwork.js): lowest priority,
// paused while somebody's stream is being encoded.
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");
const subnames = require("./subnames");
const statsnap = require("../lib/statsnap");

const V = 1; // bump when detection changes: everything is read again
const store = new JsonStore(path.join(config.DATA_DIR, "sub-langs.json"), {});
const events = new EventEmitter();

// (during a library scan, from the walk instead of the disk: lib/statsnap.js)
const mtimeOf = (p) => statsnap.mtimeMs(p);
const fresh = (e, mtime) => e && e.v === V && e.mtime === mtime;

// Cue texts of a WebVTT / SRT body.
const cueTexts = (text) => {
  const out = [];
  for (const block of String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n+/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const t = lines.slice(at + 1).join("\n").trim();
    if (t) out.push(t);
  }
  return out;
};

// What one track's text says: { lang (3-letter), sdh, cues }
const readTrack = (text) => {
  const cues = cueTexts(text);
  const det = subnames.detectLanguage(cues.join("\n"));
  return { lang: det ? det.lang : null, sdh: subnames.sdhShare(cues) >= 0.1, cues: cues.length };
};

// A track with a small fraction of the dialogue of another in its language is
// the "forced" one (signs, foreign-language lines).
const markForced = (tracks) => {
  const most = {};
  for (const t of Object.values(tracks)) if (t.lang) most[t.lang] = Math.max(most[t.lang] || 0, t.cues);
  for (const t of Object.values(tracks)) {
    if (t.lang && most[t.lang] >= 100 && t.cues < most[t.lang] * 0.25) t.forced = true;
  }
  return tracks;
};

// ---------- what is known ----------

// Detected facts for a video's embedded tracks: { [subIndex]: { lang, sdh, forced, cues } } | null
const forVideo = (videoPath, mtime = mtimeOf(videoPath)) => {
  const e = store.data[videoPath];
  return fresh(e, mtime) && e.tracks ? e.tracks : null;
};
// …and for a sidecar file: { lang, sdh, cues } | null
const forFile = (subPath, mtime = mtimeOf(subPath)) => {
  const e = store.data[subPath];
  return fresh(e, mtime) && e.track ? e.track : null;
};
const known = (p, mtime = mtimeOf(p)) => fresh(store.data[p], mtime);

// ---------- timing: a sidecar lined up against the video's own track ----------
// (media/subsync.js align). Kept per sidecar path + mtime under "sync:<path>",
// with the video's mtime too — a new copy of the video is judged again.
//   -> { scale, offset, how } when the sidecar should be moved, else null
const syncFor = (subPath) => {
  const e = store.data[`sync:${subPath}`];
  if (!e || e.v !== V || e.mtime !== mtimeOf(subPath) || e.videoMtime !== mtimeOf(e.video)) return null;
  return e.result && e.result.apply ? { scale: e.result.scale, offset: e.result.offset, how: e.result.why } : null;
};
// What the check said about a sidecar: "moved" (it is served lined up),
// "in-time", "unmatched" (a reference existed and nothing lined up — another
// cut or a wrong file), or null (not checked / no reference).
const syncVerdict = (subPath) => {
  if (!subPath) return null;
  const e = store.data[`sync:${subPath}`];
  if (!e || e.v !== V || e.mtime !== mtimeOf(subPath) || !e.result) return null;
  if (e.result.apply) return "moved";
  if (e.result.why === "already in time") return "in-time";
  if (e.result.why === "no strong match with the reference") return "unmatched";
  return null;
};
const syncKnown = (subPath, videoPath) => {
  const e = store.data[`sync:${subPath}`];
  return !!e && e.v === V && e.mtime === mtimeOf(subPath) && e.video === videoPath && e.videoMtime === mtimeOf(videoPath);
};

// The embedded text tracks of a probe result that nothing names.
const unnamedTracks = (meta) =>
  ((meta && meta.subtitleStreams) || []).filter((s) => s.text && !subnames.normLang(s.language) && !(s.title && subnames.normLang(s.title)));

// ---------- the queue ----------

const queue = [];
const queued = new Set();
let running = null;

// job: { kind: "video", path, indices } | { kind: "file", path }
//    | { kind: "sync", path (the video), ref (its text track), subs: [sidecar paths] }
const jobKey = (job) => `${job.kind}:${job.path}`;
const enqueue = (job) => {
  if (!job || !job.path || queued.has(jobKey(job)) || running === jobKey(job)) return;
  if (job.kind === "sync" ? job.subs.every((s) => syncKnown(s, job.path)) : known(job.path)) return;
  queued.add(jobKey(job));
  queue.push(job);
  pump();
};

const save = (p, entry) => {
  store.data[p] = { v: V, mtime: mtimeOf(p), at: new Date().toISOString(), ...entry };
  store.save();
};

const runFile = async (job) => {
  try {
    // (read without blocking the event loop: this is background work)
    const text = require("./subtitles").decodeSubtitle(await fs.promises.readFile(job.path));
    save(job.path, { track: readTrack(text) });
  } catch {
    save(job.path, { failed: true });
  }
};

const runVideo = async (job) => {
  const subtitles = require("./subtitles");
  const place = await require("./cpuwork").background.gate("sublang", { label: path.basename(job.path), pausable: true });
  let texts = {};
  try {
    texts = await subtitles.extractAll(job.path, job.indices, { spawned: (child) => place.attach(child) });
  } finally {
    place.release();
  }
  const tracks = {};
  for (const i of job.indices) if (texts[i] != null) tracks[i] = readTrack(texts[i]);
  if (!Object.keys(tracks).length) return save(job.path, { failed: true });
  save(job.path, { tracks: markForced(tracks) });
  const named = Object.values(tracks).filter((t) => t.lang).length;
  console.log(`[subs] ${path.basename(job.path)}: ${named} of ${job.indices.length} untagged track(s) named from their text`);
};

// Line each sidecar up against the video's own text track.
const runSync = async (job) => {
  const subtitles = require("./subtitles");
  const subsync = require("./subsync");
  const place = await require("./cpuwork").background.gate("sublang", { label: path.basename(job.path), pausable: true });
  let texts = {};
  try {
    texts = await subtitles.extractAll(job.path, [job.ref], { spawned: (child) => place.attach(child) });
  } finally {
    place.release();
  }
  const ref = texts[job.ref] != null ? subsync.parse(texts[job.ref]) : null;
  for (const sub of job.subs) {
    let result = { apply: false, why: "no reference track" };
    if (ref && ref.length) {
      try {
        const cues = subsync.parse(subtitles.decodeSubtitle(await fs.promises.readFile(sub)));
        result = subsync.align(cues, ref);
      } catch (e) {
        result = { apply: false, why: e.message };
      }
    }
    store.data[`sync:${sub}`] = { v: V, mtime: mtimeOf(sub), video: job.path, videoMtime: mtimeOf(job.path), ref: job.ref, at: new Date().toISOString(), result };
    if (result.apply) {
      console.log(`[subs] ${path.basename(sub)}: ${result.why} — x${result.scale.toFixed(4)} ${result.offset >= 0 ? "+" : ""}${result.offset.toFixed(2)} s (${result.matched}/${result.total} lines match the video's own track, ${result.identity} as it was)`);
    }
  }
  store.save();
};

const pump = () => {
  if (running || !queue.length) return;
  const job = queue.shift();
  queued.delete(jobKey(job));
  running = jobKey(job);
  (job.kind === "file" ? runFile(job) : job.kind === "sync" ? runSync(job) : runVideo(job))
    .catch((e) => console.error(`[subs] language detection failed for ${path.basename(job.path)}:`, e.message))
    .finally(() => {
      running = null;
      events.emit("detected", job.path); // (a sync verdict reorders a menu too: scanner.js)
      setImmediate(pump);
    });
};

const idle = () => !running && !queue.length;

module.exports = { rev: () => store.rev, forVideo, forFile, known, syncFor, syncKnown, syncVerdict, unnamedTracks, enqueue, events, idle, _internals: { cueTexts, readTrack, markForced, store } };
