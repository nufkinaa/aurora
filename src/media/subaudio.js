// Subtitles lined up with the FILM'S AUDIO, kept per file + subtitle on the
// server, so every device gets the corrected timing.
//
// "Subs resync btn: this btn was broken because it did not use a real
// method of trying to match what was said to a text in the subs track… it
// needs to really sync the subs." / "Hebrew subs out of sync: can't we adapt
// them for the release that was downloaded?" (the owner, 2026-10-17)
//
// Two ways in:
//   resync()   the player's Resync button: the subtitle on screen against
//              the audio track playing, now (media/speech.js urgent), with
//              progress for the menu; the result is applied at once for
//              everyone (and may be undone).
//   enqueue()  the background: every sidecar of a library file — Hebrew
//              first, the household's language — once per file + mtime,
//              through the background budget. Applied only when confident
//              (media/audiosync.js verdicts). Embedded tracks are SCORED here
//              (which one matches this release, for the menu's ★) but never
//              moved by the background: only a Resync moves them.
//
// What is kept (data/sub-audiosync.json), per subtitle key —
//   "file:<sidecar path>"  or  "emb:<video path>#<subtitle stream index>":
//   { v, subMtime, video, videoMtime, audio, source: "resync"|"auto"|"undo",
//     at, ms, result: { verdict, apply, plan, words, r, z, rAfter, … } }
// An entry is stale (ignored) once the subtitle or the video changes.
// The FILES are never touched: media/subtitles.js applies the plan when the
// subtitle is served (X-Aurora-Subtitle-Repair says so).
"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");
const audiosync = require("./audiosync");
const statsnap = require("../lib/statsnap");

const V = 1; // bump when the alignment changes: background results are made again
const store = new JsonStore(path.join(config.DATA_DIR, "sub-audiosync.json"), {});
const events = new EventEmitter();

const deps = {
  speech: () => require("./speech"),
  subtitles: () => require("./subtitles"),
  subsync: () => require("./subsync"),
  now: () => Date.now(),
};

// (during a library scan, from the walk instead of the disk: lib/statsnap.js)
const mtimeOf = (p) => statsnap.mtimeMs(p);

// ---------- keys ----------
const fileKey = (subPath) => `file:${subPath}`;
const embKey = (videoPath, index) => `emb:${videoPath}#${index}`;
// sub: { kind: "file", path } | { kind: "emb", video, index }
const keyOf = (sub) => (sub.kind === "file" ? fileKey(sub.path) : embKey(sub.video, sub.index));
const subMtime = (sub) => (sub.kind === "file" ? mtimeOf(sub.path) : mtimeOf(sub.video));

const fresh = (e, sub, videoPath) =>
  !!e && e.subMtime === subMtime(sub) && e.videoMtime === mtimeOf(videoPath || e.video) && (e.source !== "auto" || e.v === V);

// ---------- what is known ----------

// The entry for a subtitle (fresh only), or null.
const entryFor = (sub) => {
  const e = store.data[keyOf(sub)];
  return fresh(e, sub, sub.kind === "emb" ? sub.video : e && e.video) ? e : null;
};

// The plan to serve a subtitle with, or null (media/subtitles.js).
// -> { plan, words, source }
const planFor = (sub) => {
  const e = entryFor(sub);
  if (!e || !e.result || !e.result.apply || !e.result.plan) return null;
  return { plan: e.result.plan, words: e.result.words || audiosync.describe(e.result), source: e.source };
};

// May the OTHER correction (lined up with the video's own text track,
// media/sublang.js) still be applied? Not once the audio has the last word:
// the audio found the file in time as it is, or somebody chose the file's
// own timing (undo).
const trackSyncAllowed = (sub) => {
  const e = entryFor(sub);
  if (!e) return true;
  if (e.source === "undo") return false;
  return !(e.result && e.result.verdict === "in-time");
};

// What the menu may say about a track: { verdict, words, source, r } | null
const timingOf = (sub) => {
  const e = entryFor(sub);
  if (e && e.source === "undo") return { verdict: "original", words: "The file's own timing", source: "undo" };
  if (!e || !e.result) return null;
  return { verdict: e.result.verdict, words: e.result.words || audiosync.describe(e.result), source: e.source, r: e.result.rAfter != null ? e.result.rAfter : e.result.r, cues: e.result.total };
};

// ---------- reading a subtitle's cues ----------
const cuesOf = async (sub, videoPath) => {
  const subtitles = deps.subtitles();
  const subsync = deps.subsync();
  if (sub.kind === "file") return subsync.parse(subtitles.decodeSubtitle(await fs.promises.readFile(sub.path)));
  const text = await subtitles.vttText({ videoPath, trackIndex: sub.index, original: true });
  return text ? subsync.parse(text) : [];
};

const save = (sub, videoPath, audio, source, result, ms) => {
  store.data[keyOf(sub)] = {
    v: V,
    subMtime: subMtime(sub),
    video: videoPath,
    videoMtime: mtimeOf(videoPath),
    audio,
    source,
    at: new Date(deps.now()).toISOString(),
    ms,
    result: result ? { ...result, byScale: undefined, words: audiosync.describe(result) } : null,
  };
  store.save();
};

// ---------- the Resync button ----------

const jobs = new Map(); // key -> { state, progress, startedAt, result, words, error, promise }
const JOB_KEEP_MS = 10 * 60 * 1000;

const publicJob = (j) => (j ? {
  state: j.state, // "listening" | "matching" | "done" | "failed"
  progress: Math.round((j.progress || 0) * 100) / 100,
  verdict: j.result ? j.result.verdict : null,
  applied: !!(j.result && j.result.apply),
  words: j.words || null,
  parts: j.result && j.result.parts,
  ms: j.ms || null,
  error: j.error || null,
} : null);

// Start (or join) the alignment of `sub` against `videoPath`'s audio track
// `audio`. -> the job (publicJob) at once; `job.promise` settles when done.
const resync = ({ videoPath, sub, audio = 0 }) => {
  const key = keyOf(sub);
  const running = jobs.get(key);
  if (running && (running.state === "listening" || running.state === "matching")) return running;
  const t0 = deps.now();
  const job = { state: "listening", progress: 0, startedAt: t0, result: null, words: null, error: null };
  jobs.set(key, job);
  job.promise = (async () => {
    try {
      const cues = await cuesOf(sub, videoPath);
      if (cues.length < 20) throw Object.assign(new Error("this subtitle has too few lines to match"), { quiet: true });
      const { speech } = await deps.speech().timeline(videoPath, { audio, urgent: true, onProgress: (p) => { job.progress = p * 0.9; } });
      job.state = "matching";
      job.progress = 0.92;
      const result = await deps.speech().alignInWorker(speech, cues);
      job.result = result;
      job.words = audiosync.describe(result);
      job.ms = deps.now() - t0;
      // a refusal leaves whatever was there before (a background result, the
      // file as it is) — the button never makes things worse; with nothing
      // there before, the refusal is kept (the background need not ask again)
      if (result.verdict !== "unmatched" || !entryFor(sub)) save(sub, videoPath, audio, "resync", result, job.ms);
      job.state = "done";
      job.progress = 1;
      console.log(`[subsync] resync ${path.basename(sub.kind === "file" ? sub.path : `${videoPath} #${sub.index}`)}: ${job.words} (r ${result.r} z ${result.z}${result.rAfter != null ? ` → ${result.rAfter}` : ""}, ${job.ms} ms)`);
      events.emit("synced", { video: videoPath, key, source: "resync" });
    } catch (e) {
      job.state = "failed";
      job.error = e.message || String(e);
      job.words = "Couldn't match — kept as it was";
      if (!e.quiet) console.warn(`[subsync] resync failed for ${path.basename(videoPath)}: ${job.error}`);
    } finally {
      const t = setTimeout(() => { if (jobs.get(key) === job) jobs.delete(key); }, JOB_KEEP_MS);
      if (t.unref) t.unref();
    }
    return publicJob(job);
  })();
  return job;
};
const jobFor = (sub) => jobs.get(keyOf(sub)) || null;

// Back to the file's own timing, for everyone; the background leaves it so.
const undo = ({ videoPath, sub }) => {
  save(sub, videoPath, null, "undo", null, 0);
  events.emit("synced", { video: videoPath, key: keyOf(sub), source: "undo" });
};

// ---------- the background ----------

const queue = []; // { video, audio, subs: [sub], hebrew: bool }
const queuedVideos = new Set();
let running = null;

const needsWork = (sub, videoPath) => {
  const e = store.data[keyOf(sub)];
  if (!e) return true;
  if (e.source === "resync" || e.source === "undo") return !(e.subMtime === subMtime(sub) && e.videoMtime === mtimeOf(videoPath));
  return !fresh(e, sub, videoPath);
};

// job: { video, audio?, subs: [{ kind, path } | { kind: "emb", video, index }], hebrew?, front? }
const enqueue = (job) => {
  if (!job || !job.video || queuedVideos.has(job.video) || running === job.video) return false;
  const subs = (job.subs || []).filter((s) => needsWork(s, job.video));
  if (!subs.length) return false;
  queuedVideos.add(job.video);
  const entry = { ...job, subs };
  // Hebrew first (the household's language), then the order asked; a fresh
  // provider download goes to the front
  if (job.front) queue.unshift(entry);
  else {
    const at = job.hebrew ? queue.findIndex((q) => !q.hebrew && !q.front) : -1;
    if (at < 0) queue.push(entry);
    else queue.splice(at, 0, entry);
  }
  pump();
  return true;
};

const runJob = async (job) => {
  const audio = job.audio || 0;
  const t0 = deps.now();
  let speech;
  try {
    ({ speech } = await deps.speech().timeline(job.video, { audio }));
  } catch (e) {
    // not tried again until the film or the subtitle changes
    for (const sub of job.subs) save(sub, job.video, audio, "auto", { verdict: "error", apply: false, why: e.message }, deps.now() - t0);
    throw e;
  }
  // the embedded tracks to score, out of the file in ONE pass (cached for
  // the player too) — background work like any other
  const emb = job.subs.filter((s) => s.kind === "emb").map((s) => s.index);
  if (emb.length) {
    const place = await require("./cpuwork").background.gate("sublang", { label: path.basename(job.video), pausable: true });
    try {
      await deps.subtitles().extractAll(job.video, emb, { spawned: (child) => place.attach(child) });
    } finally {
      place.release();
    }
  }
  let changed = 0;
  for (const sub of job.subs) {
    if (!needsWork(sub, job.video)) continue; // a Resync landed meanwhile
    let result = null;
    try {
      const cues = await cuesOf(sub, job.video);
      result = cues.length >= 20 ? await deps.speech().alignInWorker(speech, cues) : { verdict: "unmatched", apply: false, why: "too few lines", total: cues.length };
    } catch (e) {
      result = { verdict: "unmatched", apply: false, why: e.message };
    }
    // embedded tracks are scored only: never moved without a Resync
    if (sub.kind === "emb" && result) result = { ...result, apply: false, scoredOnly: true };
    save(sub, job.video, audio, "auto", result, deps.now() - t0);
    changed++;
    if (result && result.apply) console.log(`[subsync] ${path.basename(sub.path || job.video)}: ${audiosync.describe(result)} (r ${result.r} → ${result.rAfter}, z ${result.z})`);
  }
  if (changed) events.emit("synced", { video: job.video, source: "auto" });
};

const pump = () => {
  if (running || !queue.length) return;
  const job = queue.shift();
  queuedVideos.delete(job.video);
  running = job.video;
  runJob(job)
    .catch((e) => console.warn(`[subsync] background sync of ${path.basename(job.video)} failed: ${e.message}`))
    .finally(() => {
      running = null;
      setImmediate(pump);
    });
};

const idle = () => !running && !queue.length;

module.exports = {
  rev: () => store.rev,
  V, keyOf, fileKey, embKey, entryFor, planFor, trackSyncAllowed, timingOf, resync, jobFor, publicJob, undo, enqueue, idle, events,
  _internals: { store, deps, jobs, queue, needsWork, cuesOf },
};
