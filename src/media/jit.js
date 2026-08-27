// S7 — JIT full-timeline streaming. The player (and Apple's fullscreen) gets
// a COMPLETE VOD playlist up front — exact total duration from the MKV
// header, exact segment boundaries from the Cues — and segments materialize
// on demand: a "seek" stops being a transcode restart and becomes the player
// fetching segment #1042, which a rolling copy producer emits at stream
// speed. Timestamps ride through untouched (-copyts): the media clock IS the
// movie clock, no offset bookkeeping anywhere.
//
// The one rule that makes the promised playlist TRUE: segment boundaries are
// computed with ffmpeg's own splitting rule (cut at the first keyframe at or
// after start + target), over the same keyframe list ffmpeg will see — so
// declared EXTINFs and produced segments agree by construction.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../config");
const { parseMkvIndex } = require("./mkvindex");

const TARGET_SEG_SEC = 6;
const IDLE_MS = 150000;
const WAIT_POLL_MS = 100;
const SEGMENT_WAIT_MS = 90000; // torrents legitimately wait on the swarm

// dir -> { proc, fromSeg, lastAccess, table, indexKey }
const jobs = new Map();
const tables = new Map(); // indexKey -> { table, durationSec }

const buildTable = (index) => {
  const cues = index.cues.filter((c) => c.t < index.durationSec);
  if (!cues.length || cues[0].t > 1) return null; // must start at the top
  const table = [];
  let i = 0;
  while (i < cues.length) {
    const start = cues[i].t;
    // ffmpeg's rule: split at the first keyframe >= start + hls_time
    let j = i + 1;
    while (j < cues.length && cues[j].t < start + TARGET_SEG_SEC) j++;
    const end = j < cues.length ? cues[j].t : index.durationSec;
    table.push({ start, dur: Math.max(0.04, end - start) });
    i = j;
  }
  // A cue within a sliver of the file's end would declare a near-empty
  // final segment — whose producer (-ss start+0.3) would seek past EOF and
  // emit nothing, hanging the request to its deadline. Fold it into the
  // previous segment instead; only the LAST segment can be a sliver (mid-
  // table gaps are real GOP lengths).
  if (table.length >= 2) {
    const last = table[table.length - 1];
    if (last.dur < 0.5) {
      table.pop();
      const prev = table[table.length - 1];
      prev.dur = index.durationSec - prev.start;
    }
  }
  return table;
};

// Build (or reuse) the segment table for a media source.
const tableFor = async (indexKey, readRange, fileSize) => {
  const hit = tables.get(indexKey);
  if (hit) return hit;
  const index = await parseMkvIndex(readRange, fileSize);
  if (!index) return null;
  const table = buildTable(index);
  if (!table || table.length < 2) return null;
  const entry = { table, durationSec: index.durationSec };
  tables.set(indexKey, entry);
  if (tables.size > 100) tables.clear();
  return entry;
};

// fmt: null → MPEG-TS (hls.js); "fmp4" → fragmented MP4 (Apple native HLS —
// required for HEVC, fine for h264). Same table, same producer contract.
const playlistText = (entry, suffix, fmt) => {
  const target = Math.ceil(Math.max(...entry.table.map((s) => s.dur)));
  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${fmt === "fmp4" ? 7 : 3}`,
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  if (fmt === "fmp4") lines.push(`#EXT-X-MAP:URI="init.mp4${suffix}"`);
  const ext = fmt === "fmp4" ? "m4s" : "ts";
  entry.table.forEach((s, i) => {
    lines.push(`#EXTINF:${s.dur.toFixed(6)},`);
    lines.push(`seg${String(i).padStart(5, "0")}.${ext}${suffix}`);
  });
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
};

const segPath = (dir, k, fmt) =>
  path.join(dir, `seg${String(k).padStart(5, "0")}.${fmt === "fmp4" ? "m4s" : "ts"}`);

// Spawn a rolling producer emitting segments from table[fromSeg] to EOF.
const startProducer = (dir, job, input, fromSeg) => {
  if (job.proc) {
    try { job.proc.kill("SIGKILL"); } catch {}
    job.proc = null;
  }
  const start = job.table[fromSeg].start;
  const args = [
    "-v", "error",
    // input seek without audio trimming: both streams from the keyframe,
    // original timestamps preserved end-to-end. +300ms epsilon: the mkv demuxer
    // lands STRICTLY BEFORE a target that equals a cue time (measured: -ss
    // 104.167 landed at 93.75; -ss 104.5 landed at 104.167), so aim safely
    // past the keyframe — under any real inter-cue gap — and its ≤-seek
    // picks exactly the intended one.
    ...(fromSeg > 0 ? ["-noaccurate_seek", "-ss", String(start + 0.3)] : []),
    ...input.extra,
    "-i", input.url,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy",
    // Apple requires the hvc1 sample tag for HEVC-in-fMP4 (ffmpeg's default
    // hev1 is the black-screen tag — measured 2026-08-26).
    ...(input.vtagHvc1 ? ["-tag:v", "hvc1"] : []),
    "-c:a", "aac", "-ac", "2", "-b:a", "192k",
    "-af", "volume=4dB,alimiter=limit=0.7:level=disabled:latency=true",
    "-muxdelay", "0", "-muxpreload", "0",
    // -copyts is timeline-honest HERE even for fMP4: the jit playlist is the
    // COMPLETE movie, so real PTS agree with cumulative EXTINF positions by
    // construction (the legacy fmp4 jobs dropped copyts because their
    // playlist was a window — playlist time and PTS disagreed).
    "-copyts",
    "-f", "hls",
    "-hls_time", String(TARGET_SEG_SEC),
    "-hls_playlist_type", "event",
    "-hls_flags", "independent_segments+temp_file",
    ...(input.fmt === "fmp4"
      ? ["-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", path.join(dir, "init.mp4")]
      : []),
    "-start_number", String(fromSeg),
    "-hls_segment_filename", segPath(dir, 99999, input.fmt).replace("99999", "%05d"),
    path.join(dir, "producer.m3u8"), // ffmpeg's own playlist; never served
  ];
  const proc = spawn(config.FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  proc.on("close", (code) => {
    if (job.proc === proc) job.proc = null;
    if (code !== 0 && code !== null) {
      console.error(`[jit] producer exited ${code} (${path.basename(dir)} @seg${fromSeg}):`, stderr.slice(-200));
    }
  });
  job.proc = proc;
  job.fromSeg = fromSeg;
  console.log(`[jit] producer ${path.basename(dir)} from seg${fromSeg} (${start.toFixed(1)}s)`);
};

// Highest segment index already produced in this dir (any aim), or -1.
const producedUpTo = (dir, fmt) => {
  const ext = fmt === "fmp4" ? ".m4s" : ".ts";
  let max = -1;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.endsWith(ext) && f.match(/^seg(\d{5})\./);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {}
  return max;
};

// Serve segment k: instantly if produced; else (re)aim the producer and wait.
// "Covered" means the running producer will deliver k IMMINENTLY (within a
// few segments of its write head) — not merely someday: waiting for a distant
// k would mean producing (and, for torrents, DOWNLOADING) everything between,
// which is exactly the cold-seek cost jit exists to kill. Re-aim instead.
const ensureSegment = async (dir, job, input, k) => {
  job.lastAccess = Date.now();
  const file = segPath(dir, k, input.fmt);
  if (fs.existsSync(file)) return file;
  const head = Math.max(job.fromSeg - 1, producedUpTo(dir, input.fmt));
  const covered = job.proc && k >= job.fromSeg && k - head <= 3;
  if (!covered) startProducer(dir, job, input, k);
  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return file;
    // the producer died without delivering → one respawn aimed exactly here
    if (!job.proc) startProducer(dir, job, input, k);
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    job.lastAccess = Date.now();
  }
  return null;
};

// The fMP4 init segment (codec parameters, no media). ffmpeg writes it the
// moment a producer spawns, so if none is running yet, aim one at seg0 —
// the init doesn't depend on where production starts. Unlike segments
// (temp_file-protected), the init is written in place, so "exists" is not
// "complete": require a non-empty size that holds across two polls.
const ensureInit = async (dir, job, input) => {
  job.lastAccess = Date.now();
  const file = path.join(dir, "init.mp4");
  const size = () => {
    try { return fs.statSync(file).size; } catch { return -1; }
  };
  let last = -1;
  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (Date.now() < deadline) {
    const sz = size();
    if (sz > 0 && sz === last) return file;
    last = sz;
    if (!job.proc && sz <= 0) startProducer(dir, job, input, 0);
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    job.lastAccess = Date.now();
  }
  return null;
};

// Get-or-create the job for a stream's jit dir.
const jobFor = (dir, entry) => {
  let job = jobs.get(dir);
  if (!job) {
    fs.mkdirSync(dir, { recursive: true });
    job = { proc: null, fromSeg: 0, lastAccess: Date.now(), table: entry.table };
    jobs.set(dir, job);
  }
  job.lastAccess = Date.now();
  return job;
};

// Idle reaper — same contract as the other transcoders.
setInterval(() => {
  const now = Date.now();
  for (const [dir, job] of jobs) {
    if (now - job.lastAccess > IDLE_MS) {
      if (job.proc) { try { job.proc.kill("SIGKILL"); } catch {} }
      jobs.delete(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      console.log(`[jit] idle-killed ${path.basename(dir)}`);
    }
  }
}, 30000).unref?.();

module.exports = {
  tableFor,
  playlistText,
  jobFor,
  ensureSegment,
  ensureInit,
  segPath,
  // Test-only: the split rule must mirror ffmpeg's or declared EXTINFs lie.
  _internals: { buildTable, producedUpTo, TARGET_SEG_SEC },
};
