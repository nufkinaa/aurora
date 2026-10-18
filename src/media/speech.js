// Where people talk in a library file: its speech timeline, one probability
// per 10 ms (media/vad.js), for lining subtitles up with the audio
// (media/subaudio.js).
//
// ffmpeg decodes ONE audio track to 8 kHz mono — the centre channel where
// the layout has one (films mix dialogue there; music and effects live in
// the other channels), else the down-mix — with `aresample=async=1:
// first_pts=0`, so a damaged stretch or a late first packet is filled with
// silence and every later sample stays at its true time. The PCM goes to a
// worker thread (media/subsync-worker.js) as it arrives; the event loop only
// passes buffers along.
//
// Two speeds:
//   urgent      a viewer pressed Resync and is waiting. The film is split
//               into up to four parts decoded side by side (each with its own
//               ffmpeg and worker), started at once — not queued behind the
//               background budget — at below-normal priority, or at the
//               lowest when a viewer's stream is being encoded right now (the
//               stream must never stutter for this).
//   background  one ffmpeg, through the background budget (media/cpuwork.js
//               kind "speech": lowest priority, held while viewers are
//               encoded for, paused where the OS can).
//
// The result is cached per file + mtime + audio track (data/cache/speech),
// so a second sync of the same film is instant.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { Worker } = require("worker_threads");
const config = require("../config");
const vad = require("./vad");

const V = 2; // bump when the detector changes: every timeline is made again (2: the fitted model, 2026-10-17)
const DIR = path.join(config.CACHE_DIR, "speech");
const WORKER = path.join(__dirname, "subsync-worker.js");
const MAX_FILES = 400; // cached timelines kept (about 0.5 MB an hour of film)

const deps = {
  spawn: (...a) => spawn(...a),
  ffmpeg: () => config.FFMPEG,
  available: () => !!config.ffmpegAvailable,
  probe: (p) => require("./metadata").probeAsync(p),
  cpuwork: () => require("./cpuwork"),
  dir: () => DIR, // where timelines are kept (tests point it elsewhere)
  segmentSeconds: () => SEGMENT_S, // decodeStaged's pieces (tests make them short)
  stallMs: () => STALL_MS, // (tests make it short)
  // a media file's own start time (s)
  startOf: (file) => new Promise((resolve) => {
    execFile(config.FFPROBE, ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", file], { encoding: "utf-8", timeout: 15000, windowsHide: true }, (err, out) => resolve(err ? 0 : +String(out).trim() || 0));
  }),
};

const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
const keyOf = (videoPath, mtime, audio) => crypto.createHash("md5").update(`${videoPath}|${mtime}|${audio}|v${V}`).digest("hex");
const fileOf = (key) => path.join(deps.dir(), `${key}.u8`);

const memo = new Map(); // key -> Uint8Array (the last few)
const remember = (key, speech) => {
  memo.delete(key);
  memo.set(key, speech);
  while (memo.size > 3) memo.delete(memo.keys().next().value);
};

// The cached timeline, or null.
const cached = (videoPath, audio = 0) => {
  const mtime = mtimeOf(videoPath);
  if (mtime == null) return null;
  const key = keyOf(videoPath, mtime, audio);
  if (memo.has(key)) return memo.get(key);
  try {
    const b = fs.readFileSync(fileOf(key));
    const speech = new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    remember(key, speech);
    return speech;
  } catch {
    return null;
  }
};

const store = (key, speech) => {
  try {
    const dir = deps.dir();
    fs.mkdirSync(dir, { recursive: true });
    const f = fileOf(key);
    fs.writeFileSync(`${f}.part`, speech);
    fs.renameSync(`${f}.part`, f);
    // keep the folder bounded: the oldest go (in the background, a few
    // files at a time — lib/dirsweep.js)
    require("../lib/dirsweep").trim(dir, { max: MAX_FILES, filter: (x) => x.endsWith(".u8") }).catch(() => 0);
  } catch {}
  remember(key, speech);
};

// The ffmpeg filter for a track: its centre channel when it has one.
const filterFor = (stream) => {
  const layout = String((stream && stream.layout) || "");
  const ch = (stream && stream.channels) || 2;
  const centre = /^(3\.0|3\.1|4\.0|4\.1|5\.0|5\.1|6\.0|6\.1|7\.0|7\.1)/.test(layout) || (!layout && ch >= 6);
  return `${centre ? "pan=mono|c0=FC," : ""}aresample=${vad.RATE}:async=1:first_pts=0`;
};

const runWorker = (workerData, transfer = []) => new Worker(WORKER, { workerData, transferList: transfer });
const once = (w) => new Promise((resolve, reject) => {
  w.once("message", (m) => (m && m.error ? reject(new Error(m.error)) : resolve(m)));
  w.once("error", reject);
  w.once("exit", (code) => { if (code) reject(new Error(`worker exited ${code}`)); });
});

// A decode that has sent nothing for this long is stuck (a damaged file, a
// drive that stopped answering): it is stopped and fails, instead of holding
// its place in the background budget — and everything queued behind it —
// for ever. Time a background decode spends PAUSED for a viewer's encode
// (media/cpuwork.js, SIGSTOP where the OS has it) is not counted.
const STALL_MS = 3 * 60 * 1000;

// ffmpeg (args) -> its s16le PCM on stdout -> a VAD worker -> raw rows.
// skip: samples to leave out at the start (to begin on the 10 ms grid).
// isPaused: () => true while the decode is paused on purpose (cpuwork).
const runToRows = ({ args, skip = 0, priority, onSpawn, onBytes, signal, isPaused = null, stallMs = deps.stallMs() }) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = deps.spawn(deps.ffmpeg(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    if (priority != null && child.pid) { try { os.setPriority(child.pid, priority); } catch {} }
    if (onSpawn) { try { onSpawn(child); } catch {} }
    const w = runWorker({ task: "rows" });
    const done = once(w);
    // (a decode that fails ends its worker with terminate(), whose exit then
    // rejects this — handled, or every failed decode was an unhandled rejection)
    done.catch(() => {});
    let stderr = "";
    let toSkip = skip * 2; // bytes
    child.stderr.on("data", (d) => { if (stderr.length < 2000) stderr += d; });
    child.stdout.on("data", (d) => {
      if (onBytes) onBytes(d.length);
      if (toSkip > 0) {
        const n = Math.min(toSkip, d.length);
        toSkip -= n;
        d = d.subarray(n);
        if (!d.length) return;
      }
      const ab = d.buffer.slice(d.byteOffset, d.byteOffset + d.length);
      w.postMessage({ pcm: ab }, [ab]);
    });
    const abort = () => { try { child.kill("SIGKILL"); } catch {} };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    let lastData = Date.now();
    let stalled = false;
    child.stdout.on("data", () => { lastData = Date.now(); });
    const watch = setInterval(() => {
      if (isPaused && isPaused()) { lastData = Date.now(); return; }
      if (Date.now() - lastData > stallMs) { stalled = true; abort(); }
    }, Math.min(10000, Math.max(50, Math.floor(stallMs / 4))));
    watch.unref?.();
    child.on("error", (e) => { clearInterval(watch); w.terminate(); reject(e); });
    child.on("close", (code) => {
      clearInterval(watch);
      if (signal) signal.removeEventListener("abort", abort);
      if (stalled) {
        w.terminate();
        return reject(new Error(`ffmpeg sent nothing for ${Math.round(stallMs / 1000)} s and was stopped`));
      }
      if (code !== 0 || (signal && signal.aborted)) {
        w.terminate();
        return reject(new Error(signal && signal.aborted ? "stopped" : `ffmpeg: ${stderr.trim().slice(-200) || code}`));
      }
      w.postMessage({ end: true });
      done.then((m) => { w.terminate(); resolve(m.rows); }, (e) => { w.terminate(); reject(e); });
    });
  });

// rows -> exactly `frames` frames: trimmed, or padded with copies of the last
const fitRows = (rows, frames) => {
  const want = frames * vad.RAW;
  if (rows.length === want) return rows;
  const r = new Float32Array(want);
  r.set(rows.subarray(0, Math.min(want, rows.length)));
  for (let i = rows.length; i < want; i++) r[i] = rows.length ? rows[rows.length - vad.RAW + (i % vad.RAW)] : 0;
  return r;
};

// Decode [from, from+len) of the track straight from the file into raw VAD
// rows (exactly len*100 frames; the last part as long as the audio is).
const decodePart = ({ videoPath, audio, stream, from, len, last, priority, onSpawn, onBytes, signal, isPaused }) => {
  const args = ["-v", "error", "-nostdin"];
  if (from > 0) args.push("-ss", from.toFixed(3));
  if (!last) args.push("-t", len.toFixed(3));
  args.push("-i", videoPath, "-map", `0:a:${audio}`, "-vn", "-sn", "-dn", "-af", filterFor(stream), "-ac", "1", "-f", "s16le", "pipe:1");
  return runToRows({ args, priority, onSpawn, onBytes, signal, isPaused }).then((rows) => (last ? rows : fitRows(rows, Math.round(len * 100))));
};

// The URGENT way, measured on the household's disk (a 2-hour EAC-3 film:
// four parts read side by side from a spinning disk took 176 s, one pass
// 40 s): the film is READ ONCE, in order, by one ffmpeg that only copies
// the audio track out into SEGMENT_S-second pieces in a temporary folder
// (copying is cheap: no decoding), and each piece is decoded — up to
// `concurrency` at once — as soon as it is complete, while the reading goes
// on. The pieces keep the track's own times (-copyts -start_at_zero: a
// track that starts late keeps its delay), each is placed on the 10 ms grid
// by its own start, and the folder is removed at the end.
const SEGMENT_S = 300;
// folders a stopped run could not remove (a file still open on Windows)
// (asynchronous: nothing waits for it)
const sweepTmp = () => {
  const dir = deps.dir();
  fs.promises.readdir(dir).then(async (names) => {
    for (const x of names) {
      if (!x.startsWith("tmp-")) continue;
      const p = path.join(dir, x);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 3600 * 1000) await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }, () => {});
};
const decodeStaged = async ({ key, videoPath, audio, stream, dur, priority, concurrency, onProgress, signal }) => {
  sweepTmp();
  const tmp = path.join(deps.dir(), `tmp-${key}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const list = path.join(tmp, "list.csv");
  const stop = new AbortController();
  const onOuter = () => stop.abort();
  if (signal) {
    if (signal.aborted) stop.abort();
    else signal.addEventListener("abort", onOuter, { once: true });
  }
  let read = 0; // s of audio the reader has written out
  let decoded = 0; // s decoded
  const progress = () => { if (onProgress) onProgress(Math.min(0.95, (0.4 * read + 0.6 * decoded) / Math.max(1, dur) * 0.95)); };
  try {
    // 1. the reader
    const reader = deps.spawn(deps.ffmpeg(), [
      "-v", "error", "-nostdin", "-copyts", "-start_at_zero", "-i", videoPath, "-map", `0:a:${audio}`, "-c", "copy", "-vn", "-sn", "-dn",
      "-f", "segment", "-segment_time", String(deps.segmentSeconds()), "-segment_format", "matroska", "-reset_timestamps", "0",
      "-segment_list", list, "-segment_list_type", "csv", path.join(tmp, "s%04d.mka"),
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    if (priority != null && reader.pid) { try { os.setPriority(reader.pid, priority); } catch {} }
    let readerErr = "";
    reader.stderr.on("data", (d) => { if (readerErr.length < 2000) readerErr += d; });
    const killReader = () => { try { reader.kill("SIGKILL"); } catch {} };
    stop.signal.addEventListener("abort", killReader, { once: true });
    const readerDone = new Promise((resolve) => reader.on("close", (code) => resolve(code)));
    reader.on("error", () => {});
    // 2. the pieces, decoded as they come
    const seen = new Set();
    const queue = [];
    const results = [];
    let running = 0;
    let failed = null;
    let wake = null;
    const kick = () => { if (wake) { const w = wake; wake = null; w(); } };
    const decodeOne = async (file, end) => {
      const f = path.join(tmp, file);
      // its own start time: where its first sample belongs
      const start = await deps.startOf(f);
      const s0 = Math.round(start * vad.RATE);
      const k0 = Math.ceil(s0 / vad.HOP);
      const rows = await runToRows({
        args: ["-v", "error", "-nostdin", "-i", f, "-af", filterFor(stream), "-ac", "1", "-f", "s16le", "pipe:1"],
        skip: k0 * vad.HOP - s0, priority, signal: stop.signal,
      });
      try { fs.unlinkSync(f); } catch {}
      decoded += Math.max(0, end - start);
      progress();
      return { k0, rows };
    };
    const pump = () => {
      while (running < concurrency && queue.length && !failed) {
        const { file, end } = queue.shift();
        running++;
        decodeOne(file, end).then((r) => results.push(r), (e) => { failed = failed || e; stop.abort(); }).finally(() => { running--; kick(); });
      }
    };
    const poll = () => {
      let text = "";
      try { text = fs.readFileSync(list, "utf8"); } catch {}
      for (const line of text.split(/\r?\n/)) {
        const [file, , end] = line.split(",");
        if (!file || seen.has(file) || !/\.mka$/.test(file)) continue;
        seen.add(file);
        queue.push({ file, end: +end });
        read = Math.max(read, +end || 0);
      }
      progress();
      pump();
    };
    let readerCode = null;
    readerDone.then((code) => { readerCode = code; kick(); });
    // (the reader too is stopped when nothing moves for STALL_MS)
    let moved = Date.now();
    let mark = -1;
    for (;;) {
      poll();
      if (failed) throw failed;
      if (read + decoded !== mark) { mark = read + decoded; moved = Date.now(); }
      else if (Date.now() - moved > deps.stallMs()) {
        stop.abort();
        throw new Error(`the read of the track stopped moving for ${Math.round(deps.stallMs() / 1000)} s`);
      }
      if (readerCode != null) {
        poll();
        if (readerCode !== 0) throw new Error(stop.signal.aborted ? "stopped" : `ffmpeg: ${readerErr.trim().slice(-200) || readerCode}`);
        if (!queue.length && !running) break;
      }
      await new Promise((resolve) => { wake = resolve; setTimeout(kick, 200); });
    }
    if (failed) throw failed;
    if (stop.signal.aborted) throw new Error("stopped");
    // 3. one timeline: each piece at its frame, gaps (a late start) filled
    // with the nearest frame; as long as the track is (as one pass makes it)
    let frames = 0;
    for (const r of results) frames = Math.max(frames, r.k0 + r.rows.length / vad.RAW);
    const rows = new Float32Array(frames * vad.RAW);
    const have = new Uint8Array(frames);
    results.sort((a, b) => a.k0 - b.k0);
    for (const r of results) {
      rows.set(r.rows.subarray(0, Math.min(r.rows.length, (frames - r.k0) * vad.RAW)), r.k0 * vad.RAW);
      have.fill(1, r.k0, Math.min(frames, r.k0 + r.rows.length / vad.RAW));
    }
    const first = have.indexOf(1);
    if (first < 0) throw new Error("the track decoded to nothing");
    for (let k = 0; k < frames; k++) {
      if (have[k]) continue;
      const from = k < first ? first : k - 1;
      rows.copyWithin(k * vad.RAW, from * vad.RAW, from * vad.RAW + vad.RAW);
    }
    return rows;
  } finally {
    if (signal) signal.removeEventListener("abort", onOuter);
    stop.abort();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
};

// Jobs in flight, per timeline key: { urgent, promise, listeners (progress),
// supersede(promise) }. An urgent call joins an urgent job; it never waits
// behind a background one (lowest priority, maybe paused, maybe still
// queued for its place): it starts its own decode, and the background job
// is stopped and hands its callers the urgent result.
const jobs = new Map();

// How many parts an urgent decode is split into (tools/subsync-eval and
// docs/qa/subtitle-sync/REPORT.md "Speed": the parts run side by side; the
// disk, not the CPU, is what a 2-hour file waits on).
const URGENT_PARTS = 4;
const URGENT_PARTS_BUSY = 2; // while a viewer's stream is being encoded
const PART_MIN_S = 900; // no part shorter than 15 minutes

// The speech timeline of `videoPath`'s audio track `audio` (0-based among
// its audio streams). -> Promise<{ speech: Uint8Array, cached: bool, ms, joined? }>
//   urgent: a viewer is waiting (see the top); onProgress(0..1); signal: AbortSignal
//   parts: (tests, measurements) how many parts to decode in, overriding the rule
const timeline = async (videoPath, { audio = 0, urgent = false, onProgress = null, signal = null, parts: partsWanted = null } = {}) => {
  const t0 = Date.now();
  const mtime = mtimeOf(videoPath);
  if (mtime == null) throw new Error("the film is not there");
  const key = keyOf(videoPath, mtime, audio);
  const hit = cached(videoPath, audio);
  if (hit) return { speech: hit, cached: true, ms: Date.now() - t0 };
  if (!deps.available()) throw new Error("ffmpeg is not available");
  const cur = jobs.get(key);
  if (cur && (cur.urgent || !urgent)) {
    if (onProgress) cur.listeners.add(onProgress);
    try {
      const speech = await cur.promise;
      return { speech, cached: false, ms: Date.now() - t0, joined: true };
    } finally {
      if (onProgress) cur.listeners.delete(onProgress);
    }
  }
  const job = startJob(key, videoPath, audio, urgent, signal, partsWanted);
  if (onProgress) job.listeners.add(onProgress);
  // an urgent job takes over a background one for the same timeline
  if (cur && !cur.urgent && urgent) {
    for (const f of cur.listeners) job.listeners.add(f);
    cur.supersede(job.promise);
  }
  jobs.set(key, job);
  try {
    const speech = await job.promise;
    return { speech, cached: false, ms: Date.now() - t0 };
  } finally {
    if (jobs.get(key) === job) jobs.delete(key);
  }
};

const startJob = (key, videoPath, audio, urgent, signal, partsWanted) => {
  const listeners = new Set();
  const progress = (x) => { for (const f of listeners) { try { f(x); } catch {} } };
  const stop = new AbortController(); // this job's own decode
  const onOuter = () => stop.abort();
  if (signal) {
    if (signal.aborted) stop.abort();
    else signal.addEventListener("abort", onOuter, { once: true });
  }
  let takenOver = null; // the urgent job's promise, once one takes over
  // raw rows -> probabilities (a worker), kept
  const finish = async (rows) => {
    const w = runWorker({ task: "prob", rows }, [rows.buffer]);
    const { speech } = await once(w).finally(() => w.terminate());
    store(key, speech);
    progress(1);
    return speech;
  };
  const run = async () => {
    const meta = await deps.probe(videoPath).catch(() => null);
    const streams = (meta && meta.audioStreams) || [];
    if (!streams.length) throw new Error("the film has no audio track");
    const stream = streams[audio] || streams[0];
    const a = streams[audio] ? audio : 0;
    const dur = (meta && meta.duration) || 0;
    if (!(dur > 0)) throw new Error("the film's length is not known");
    const cpuwork = deps.cpuwork();
    let place = null;
    let priority;
    let parts;
    if (urgent) {
      const busy = cpuwork.viewer.busy();
      priority = busy ? cpuwork.PRIORITY.background : cpuwork.PRIORITY.viewer;
      const cores = os.cpus().length;
      parts = partsWanted || Math.max(1, Math.min(busy ? URGENT_PARTS_BUSY : URGENT_PARTS, Math.floor(cores / 3), Math.ceil(dur / PART_MIN_S)));
    } else {
      place = await cpuwork.background.gate("speech", { label: path.basename(videoPath), pausable: true });
      parts = partsWanted || 1;
    }
    try {
      if (stop.signal.aborted) throw new Error("stopped");
      // (an urgent run may have made it while this waited for its place)
      const again = cached(videoPath, audio);
      if (again) return again;
      if (urgent && !partsWanted) {
        // read once, decode the pieces side by side (decodeStaged); if that
        // fails for a reason of its own, one plain pass
        try {
          const rows = await decodeStaged({ key, videoPath, audio: a, stream, dur, priority, concurrency: parts, onProgress: progress, signal: stop.signal });
          return await finish(rows);
        } catch (e) {
          if (stop.signal.aborted) throw e;
          parts = 1;
        }
      }
      const len = Math.ceil(dur / parts / 10) * 10; // whole 10 s: the parts meet on the frame grid
      const total = dur * vad.RATE * 2;
      let got = 0;
      const onBytes = (n) => { got += n; progress(Math.min(0.95, (got / total) * 0.95)); };
      const ranges = [];
      for (let i = 0; i < parts; i++) {
        const from = i * len;
        if (from >= dur) break;
        ranges.push({ from, len, last: i === parts - 1 || from + len >= dur });
      }
      const rowsParts = await Promise.all(ranges.map((r) => decodePart({
        videoPath, audio: a, stream, ...r, priority, signal: stop.signal, onBytes,
        onSpawn: place ? (child) => place.attach(child) : null,
        isPaused: place && place.paused ? () => place.paused() : null,
      })));
      let size = 0;
      for (const r of rowsParts) size += r.length;
      const rows = new Float32Array(size);
      let o = 0;
      for (const r of rowsParts) { rows.set(r, o); o += r.length; }
      return await finish(rows);
    } finally {
      if (place) place.release();
      if (signal) signal.removeEventListener("abort", onOuter);
    }
  };
  // taken over: its callers get the urgent result at once (this job may
  // still be waiting for its place in the budget; it stops when it gets one)
  let handOver;
  const taken = new Promise((resolve) => { handOver = resolve; });
  const promise = Promise.race([
    run().catch((e) => {
      if (takenOver) return takenOver;
      throw e;
    }),
    taken,
  ]);
  return {
    urgent,
    promise,
    listeners,
    supersede: (p) => {
      takenOver = p;
      handOver(p);
      stop.abort();
    },
  };
};

// Run the alignment in a worker. -> Promise<result> (media/audiosync.js align)
const alignInWorker = async (speech, cues, opts = {}) => {
  const w = runWorker({ task: "align", speech, cues: cues.map((c) => ({ start: c.start, end: c.end })), opts });
  try {
    const { result } = await once(w);
    return result;
  } finally {
    w.terminate();
  }
};

module.exports = { timeline, cached, alignInWorker, filterFor, V, URGENT_PARTS, _internals: { deps, keyOf, memo, jobs, DIR, decodePart, decodeStaged, SEGMENT_S } };
