// S7 — JIT full-timeline streaming. The player (and Apple's fullscreen) gets
// a COMPLETE VOD playlist up front — exact total duration from the MKV
// header, exact segment boundaries from the video track's Cues — and segments
// materialize on demand: a "seek" stops being a transcode restart and becomes
// the player fetching segment #1042, which a rolling copy producer emits at
// stream speed.
//
// THE CONTRACT: the playlist is a promise about every segment — which
// keyframe it starts on and which one ends it — and it has to hold no matter
// where a producer was started. The first version kept it by predicting how
// ffmpeg's HLS muxer would split; that prediction was wrong twice over (the
// muxer splits against a cumulative target measured from wherever THAT
// producer began, so every start point cut the film differently, and the
// table was built from every track's cues, subtitle lines included), and a
// 410-entry playlist met 511 segment files.
//
// Nothing is predicted now. The producer never decides a boundary:
//  • ffmpeg writes ONE FILE PER GOP (segment muxer, a split at every video
//    keyframe — no heuristics, no "target duration", nothing start-relative)
//    and reports each file's real start time as it goes;
//  • this module groups those GOP files into the playlist's segments by
//    their measured timestamps — segment k is exactly the GOPs that start in
//    [table[k].start, table[k+1].start) — and only then gives the result its
//    public name (segNNNNN), atomically;
//  • every boundary is CHECKED on the way: a segment is published only if a
//    keyframe really sits on its declared start and on its declared end
//    (±2ms). If the file's index lied (a cue that is not a keyframe, a
//    damaged region), nothing wrong is ever served — the job fails fast, the
//    file is remembered as declined, and the client falls back to the
//    non-jit path.
// So a segment's bytes depend only on the file, never on which producer
// made it or where that producer started.
//
// Timestamps: -copyts plus one CONSTANT offset (TS_OFFSET_SEC) on every
// producer, so media time == movie time + 10s everywhere. The constant
// matters: at the top of a file the first video packets have negative DTS
// (B-frame reordering) and ffmpeg would otherwise shift that one producer's
// whole run forward (measured: +83ms on Silo) while a producer started
// anywhere else stayed unshifted. fMP4 gets absolute tfdt and no edit list
// for the same reason — the init segment is identical whatever the start.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const config = require("../config");
const { parseMkvIndex } = require("./mkvindex");

const TARGET_SEG_SEC = 6;
const IDLE_MS = 150000;
const WAIT_POLL_MS = 100;
const SEGMENT_WAIT_MS = 90000; // torrents legitimately wait on the swarm
const TS_OFFSET_SEC = 10; // constant media-clock offset (Apple's own segmenter uses 10s too)
const BOUNDARY_TOL_SEC = 0.002; // cue times and packet times are both ms-exact
const COVER_AHEAD = 3; // a producer "covers" a segment this close to its write head
const SEEK_BACK_SEC = 1; // aim BEFORE the wanted keyframe (see producerArgs)
const MAX_SPAWNS_PER_WAIT = 3;
const ALGO = 2; // bump when the table rule changes: declined files are re-tried

// dir -> job (see jobFor)
const jobs = new Map();
const tables = new Map(); // indexKey -> { key, table, durationSec }

// ---------- files jit has to decline ----------
// A file whose index disagreed with its real keyframes once will disagree
// every time; remember it (across restarts) so its playlist is refused up
// front — the client falls back to the non-jit path instead of starting a
// stream that fails where the damage is.
let declinedFile = path.join(config.CACHE_DIR, "jit-declined.json");
let declined = null; // key -> { why, at }
const loadDeclined = () => {
  if (declined) return declined;
  declined = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(declinedFile, "utf8"));
    if (raw && raw.algo === ALGO && raw.keys) {
      for (const [k, v] of Object.entries(raw.keys)) declined.set(k, v);
    }
  } catch {}
  return declined;
};
const decline = (key, why) => {
  if (!key) return;
  const map = loadDeclined();
  map.set(key, { why, at: Date.now() });
  while (map.size > 500) map.delete(map.keys().next().value);
  tables.delete(key);
  try {
    fs.mkdirSync(path.dirname(declinedFile), { recursive: true });
    fs.writeFileSync(declinedFile, JSON.stringify({ algo: ALGO, keys: Object.fromEntries(map) }));
  } catch {}
};
const declinedReason = (key) => loadDeclined().get(key)?.why || null;
// The key an ENCODED rendition of a source is declined under (see jobFor).
const encKey = (key) => `${key}|enc`;

// ---------- the segment table ----------
// `index.cues` are the VIDEO track's cue points (mkvindex). A segment starts
// on a cue and runs to the first cue at least TARGET_SEG_SEC later. Any rule
// would do — the producer does not have to reproduce it, only the cue times
// have to be real keyframes — this one keeps segments ≥ 6s where it can.
const buildTable = (index) => {
  const cues = index.cues.filter((c) => c.t < index.durationSec);
  if (!cues.length || cues[0].t > 1) return null; // must start at the top
  const table = [];
  let i = 0;
  while (i < cues.length) {
    const start = cues[i].t;
    let j = i + 1;
    while (j < cues.length && cues[j].t < start + TARGET_SEG_SEC) j++;
    const end = j < cues.length ? cues[j].t : index.durationSec;
    table.push({ start, dur: Math.max(0.04, end - start) });
    i = j;
  }
  // A cue within a sliver of the file's end would declare a near-empty
  // final segment. Fold it into the previous one; only the LAST segment can
  // be a sliver (mid-table gaps are real GOP lengths).
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

// What the file itself weighs per second, from the same index: a cue's
// offset is where its cluster starts, so the bytes between two segment
// boundaries are everything the file holds for that stretch of film. Peak =
// the busiest segment, avg = the whole film (the last segment has no end
// offset and is left out of both). Boundaries that share a cluster are
// measured together. For the ladder's BANDWIDTH (ladder.js); null when the
// offsets do not make sense.
const sourceRate = (index, table) => {
  const at = new Map(index.cues.map((c) => [c.t, c.offset]));
  const off = (k) => at.get(table[k].start);
  let peak = 0;
  let from = 0;
  for (let k = 1; k < table.length; k++) {
    const bytes = off(k) - off(from);
    if (!(bytes > 0)) continue;
    peak = Math.max(peak, (bytes * 8) / (table[k].start - table[from].start));
    from = k;
  }
  const last = table.length - 1;
  const span = table[last].start - table[0].start;
  const avg = span > 0 ? ((off(last) - off(0)) * 8) / span : 0;
  return peak > 0 && avg > 0 && peak >= avg ? { avg: Math.round(avg), peak: Math.round(peak) } : null;
};

// Build (or reuse) the segment table for a media source. null = this file
// cannot be served by jit (not MKV, no video cues, or declined earlier).
const tableFor = async (indexKey, readRange, fileSize) => {
  if (declinedReason(indexKey)) return null;
  const hit = tables.get(indexKey);
  if (hit) return hit;
  if (!readRange) return null;
  const index = await parseMkvIndex(readRange, fileSize);
  if (!index) return null;
  const table = buildTable(index);
  if (!table || table.length < 2) return null;
  const entry = { key: indexKey, table, durationSec: index.durationSec, rate: sourceRate(index, table) };
  if (tables.size >= 100) tables.clear();
  tables.set(indexKey, entry);
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

const extOf = (fmt) => (fmt === "fmp4" ? "m4s" : "ts");
const segPath = (dir, k, fmt) => path.join(dir, `seg${String(k).padStart(5, "0")}.${extOf(fmt)}`);
const gopPath = (run, i) => path.join(run.pdir, `g${String(i).padStart(6, "0")}.${extOf(run.fmt)}`);

// ---------- the producer's command line ----------
const producerArgs = (run, input, startSec) => [
  // verbose: the segment muxer announces each file it opens together with
  // the timestamp of the keyframe that opened it — the earliest moment a
  // boundary can be known. (Its segment list, on stdout, says the same once
  // the file is finished; either is enough, see onOpened/onClosed.)
  "-v", "verbose", "-nostats",
  // Input seek to BEFORE the wanted keyframe: the demuxer lands on an
  // earlier keyframe (wherever its own seek rounding puts it — ffmpeg also
  // backs off 3/23s when a stream has B-frames) and the first GOPs it emits
  // are a pre-roll this module throws away; the exact start is found by
  // timestamp, never assumed. The seek is ACCURATE for the audio: decoded
  // sound before the -ss point is dropped before it reaches the encoder
  // (decoding is ~15x cheaper than the AAC encode, which is what a seek
  // waits on), and what remains starts a full second ahead of the keyframe
  // — more than any reorder delay — so the wanted segment gets exactly the
  // audio a producer running through from the top would have put in it.
  ...(startSec != null ? ["-ss", (startSec - SEEK_BACK_SEC).toFixed(3)] : []),
  ...input.extra,
  "-i", input.url,
  // `audio`: which of the file's audio tracks (0 = the first, as always)
  "-map", "0:v:0", "-map", `0:a:${input.audio > 0 ? input.audio : 0}?`,
  ...(input.enc
    // An ENCODED rendition of the quality ladder (ladder.js): the encoder is
    // forced onto the source's own keyframes and timestamps, so everything
    // below — one file per GOP, grouped and checked against the table — is
    // the same contract as for the copy.
    ? input.enc.videoArgs
    : [
        "-c:v", "copy",
        // Apple requires the hvc1 sample tag for HEVC-in-fMP4 (ffmpeg's default
        // hev1 is the black-screen tag — measured 2026-08-26).
        ...(input.vtagHvc1 ? ["-tag:v", "hvc1"] : []),
      ]),
  "-c:a", "aac", "-ac", "2", "-b:a", input.enc ? input.enc.audioRate : "192k",
  "-af", "volume=4dB,alimiter=limit=0.7:level=disabled:latency=true",
  "-muxdelay", "0", "-muxpreload", "0",
  // Movie time rides through, plus the same constant on every producer; with
  // the constant no timestamp is ever negative, so nothing may "fix" them.
  "-copyts", "-output_ts_offset", String(TS_OFFSET_SEC), "-avoid_negative_ts", "disabled",
  "-f", "segment",
  "-segment_time", "0.001", // any keyframe is "due": one file per GOP
  ...(run.fmt === "fmp4"
    ? [
        "-segment_format", "mp4",
        // frag_custom: one moof+mdat per GOP file (flushed when the file is
        // closed); empty_moov: the init is written before any packet, so it
        // cannot depend on where this producer starts; frag_discont +
        // use_editlist=0: tfdt is the packet's real DTS, no edit list.
        "-segment_format_options",
        "movflags=+frag_custom+empty_moov+default_base_moof+frag_discont:use_editlist=0:video_track_timescale=90000:avoid_negative_ts=disabled",
        "-segment_header_filename", path.join(run.pdir, "init.mp4"),
      ]
    // one muxer across all files: continuity counters run on, and PAT/PMT
    // are re-sent at the head of every file
    : ["-segment_format", "mpegts", "-individual_header_trailer", "0"]),
  "-segment_list", "pipe:1", "-segment_list_type", "csv",
  path.join(run.pdir, `g%06d.${extOf(run.fmt)}`),
];

// The muxer's "file opened" line carries the opening packet's pts in the
// stream's time base — 1/90000 for MPEG-TS, and for MP4 because we ask for
// it. Trusted only while the line's own two renderings of the time agree,
// and (below) only until a segment-list entry ever contradicts one.
let openLineTrusted = true;
const OPEN_RE = /segment:'.*g(\d{6})\.(?:ts|m4s)' starts with packet stream:(\d+) pts:(-?\d+) pts_time:(\S+)/;
const parseOpenLine = (line) => {
  const m = OPEN_RE.exec(line);
  if (!m) return null;
  const idx = parseInt(m[1], 10);
  let start = null;
  if (openLineTrusted && m[2] === "0") {
    const sec = parseInt(m[3], 10) / 90000;
    const approx = parseFloat(m[4]);
    // pts_time is printed with 6 significant digits
    if (Number.isFinite(approx) && Math.abs(sec - approx) <= Math.max(0.002, Math.abs(approx) * 2e-5)) {
      start = sec - TS_OFFSET_SEC;
    }
  }
  return { idx, start };
};
// "g000012.ts,123.456000,129.462000"
const LIST_RE = /^g(\d{6})\.(?:ts|m4s),(-?[\d.]+),(-?[\d.]+)/;
const parseListLine = (line) => {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  return { idx: parseInt(m[1], 10), start: parseFloat(m[2]) - TS_OFFSET_SEC };
};

// ---------- grouping GOP files into segments ----------
// Pure decision step: given what is known about a run's GOP files, which
// segment (if any) can be published next?
//   { wait: true }                         — not enough is known yet
//   { fail: "…" }                          — the table disagrees with the file
//   { seg: k, members: [gop indexes], drop: [pre-roll gop indexes] }
const nextSegment = (table, run) => {
  const k = run.nextSeg;
  if (k >= table.length) return { wait: true };
  const lo = table[k].start;
  const hi = k + 1 < table.length ? table[k + 1].start : Infinity;
  const members = [];
  const drop = [];
  let closer = null;
  for (let i = run.cursor; i < run.gops.length; i++) {
    const g = run.gops[i];
    if (!g) break; // a file we have not heard about yet: nothing after it counts
    if (g.start == null) {
      // A run's first file opens on whatever the seek landed on and nobody
      // reports where that was: pre-roll. Any later file opens on a keyframe
      // whose time is on its way (the segment list) — wait for it.
      if (i > 0) break;
      drop.push(i);
      continue;
    }
    if (g.start < lo - BOUNDARY_TOL_SEC) {
      if (members.length) return { fail: `GOP file ${i} runs backwards (${g.start}s)` };
      drop.push(i); // pre-roll
      continue;
    }
    if (g.start >= hi - BOUNDARY_TOL_SEC) { closer = g; break; }
    members.push(i);
  }
  // The segment is complete once a GOP that belongs to a LATER segment has
  // been opened (every file before it is closed by then) or the film ended.
  if (!closer && !run.ended) return { wait: true };
  const at = (t) => `${t.toFixed(3)}s`;
  if (!members.length) return { fail: `segment ${k}: no keyframe at its declared start ${at(lo)}` };
  const first = run.gops[members[0]].start;
  if (Math.abs(first - lo) > BOUNDARY_TOL_SEC) {
    return { fail: `segment ${k}: first keyframe at ${at(first)}, playlist says ${at(lo)}` };
  }
  if (closer && closer.start - hi > BOUNDARY_TOL_SEC) {
    return { fail: `segment ${k + 1}: next keyframe at ${at(closer.start)}, playlist says ${at(hi)}` };
  }
  if (!closer && k + 1 < table.length) {
    return { fail: `the video ends inside segment ${k}; the playlist promised ${table.length}` };
  }
  return { seg: k, members, drop };
};

const wake = (job) => {
  const w = [...job.waiters];
  job.waiters.clear();
  for (const fn of w) fn();
};

const stopProducer = (job) => {
  const proc = job.proc;
  job.proc = null;
  job.run = null;
  if (proc) { try { proc.kill("SIGKILL"); } catch {} }
};

// ---------- encoded renditions: how many, and for how long ----------
// A copy producer is cheap (it is the disk's speed). An ENCODING producer —
// a rendition of the quality ladder — is a libx264 process, and the machine
// serves other people. Three rules:
//  • at most MAX_ENCODES encoders at once across the whole server, counted
//    together with the single-rendition encodes (remux.js) and the torrent
//    transcodes. A lower rung under a copy is a courtesy to a slow line —
//    the title plays without it — so it never takes the LAST slot; the top
//    rung of a device that cannot decode the file (`essential`) may.
//  • the other renditions of the SAME title are this viewer's own: the one
//    nobody is waiting on is the level the player just switched away from —
//    it is parked (its finished segments stay). One that is still being
//    waited on (the player's last request to the old level is in flight)
//    is let finish, so for a moment a title may hold both slots; it never
//    holds more, and it never refuses its own viewer a level change.
//  • an encoder that has run ENC_LEAD_MAX segments ahead of the last one
//    anybody asked for is parked too — a rendition the player left costs
//    nothing more, and one being watched is resumed as its reader gets
//    within ENC_LEAD_MIN segments of the end of what is made.
const MAX_ENCODES = 2; // the same figure as remux.js MAX_ACTIVE_TRANSCODES
const ENC_LEAD_MAX = 20; // ~2 minutes of film
const ENC_LEAD_MIN = 5;
const encodeCount = (except = null) => {
  let n = 0;
  for (const j of jobs.values()) if (j.enc && j.proc && j !== except) n++;
  return n;
};
// Encoders running outside jit (lazy requires: those modules load this one's
// neighbours, and the tests load this module alone).
let outsideEncodes = () => {
  let n = 0;
  try { n += require("./remux").encodeLoad().own; } catch {}
  try { n += require("./torrent-transcode")._internals.activeCount(); } catch {}
  return n;
};
const park = (dir, job, why) => {
  if (!job.proc) return;
  console.log(`[jit] parked ${path.basename(dir)} (${why})`);
  stopProducer(job);
  wake(job);
};
// Encoders running for OTHER titles (and outside jit), and for this title:
// those someone is waiting on, and those nobody is.
const encodeCensus = (title, except) => {
  let others = outsideEncodes();
  const waited = [];
  const idle = [];
  for (const [d, j] of jobs) {
    if (!j.enc || !j.proc || j === except) continue;
    if (j.title !== title) others++;
    else (j.waiting > 0 ? waited : idle).push([d, j]);
  }
  return { others, waited, idle };
};
// May this job start (or restart) an encoder now? Parks the renditions of
// its own title that nobody is waiting on. Records a refusal so the route
// can say "busy".
const admitEncode = (job, essential) => {
  const c = encodeCensus(job.title, job);
  const ok = c.others < (essential ? MAX_ENCODES : MAX_ENCODES - 1) && c.others + c.waited.length < MAX_ENCODES;
  if (!ok) {
    job.refusedAt = Date.now();
    return false;
  }
  for (const [d, j] of c.idle) park(d, j, "its viewer moved to another rendition");
  return true;
};
// Would a new encoder be admitted right now? (the routes ask before they
// offer or serve an encoded rendition; nothing is parked by asking)
const encodeRoom = (title, essential) => {
  const c = encodeCensus(title, null);
  return c.others < (essential ? MAX_ENCODES : MAX_ENCODES - 1) && c.others + c.waited.length < MAX_ENCODES;
};

const failJob = (dir, job, why, declineFile) => {
  if (job.broken) return;
  job.broken = why;
  console.error(`[jit] ${path.basename(dir)}: ${why}${declineFile ? " — declining this file" : ""}`);
  if (declineFile) decline(job.key, why);
  stopProducer(job);
  wake(job);
};

const renameRetry = async (from, to) => {
  for (let n = 0; ; n++) {
    try { return await fs.promises.rename(from, to); } catch (err) {
      // a scanner or indexer briefly holding the file (Windows)
      if (n >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 40 * (n + 1)));
    }
  }
};
const unlinkQuiet = (f) => fs.promises.unlink(f).catch(() => {});
// Give `from` its public name. Losing a race for the name is not a failure:
// whoever won put the same segment there.
const moveInto = async (from, final) => {
  try {
    await renameRetry(from, final);
  } catch (err) {
    if (!fs.existsSync(final)) throw err;
    await unlinkQuiet(from);
  }
};

// Publish segment k from its GOP files: the public name appears only when
// the bytes are complete (rename), so "exists" always means "servable".
const publish = async (dir, job, run, k, members) => {
  const final = segPath(dir, k, run.fmt);
  const files = members.map((i) => gopPath(run, i));
  if (fs.existsSync(final)) {
    // already published by an earlier producer — same bytes by contract
    await Promise.all(files.map(unlinkQuiet));
    return;
  }
  if (files.length === 1) {
    await moveInto(files[0], final);
  } else {
    const part = `${final}.${run.gen}.part`;
    const out = await fs.promises.open(part, "w");
    try {
      for (const f of files) await out.write(await fs.promises.readFile(f));
    } finally {
      await out.close();
    }
    await moveInto(part, final);
    await Promise.all(files.map(unlinkQuiet));
  }
  wake(job);
};

// The fMP4 init: written by ffmpeg before the first GOP file is opened, and
// the same bytes from every producer (no start-dependent edit list).
const publishInit = async (dir, run) => {
  const final = path.join(dir, "init.mp4");
  const mine = path.join(run.pdir, "init.mp4");
  if (fs.existsSync(final)) {
    const [a, b] = await Promise.all([fs.promises.readFile(final), fs.promises.readFile(mine)]);
    if (!a.equals(b)) console.error(`[jit] ${path.basename(dir)}: init.mp4 differs between producers`);
    return;
  }
  const part = `${final}.${run.gen}.part`;
  await fs.promises.copyFile(mine, part);
  await moveInto(part, final);
};

// Something new is known about the run: publish every segment that is now
// decidable, in order.
const advance = (dir, job, run) => {
  if (job.run !== run || job.broken) return;
  for (;;) {
    const step = nextSegment(job.table, run);
    if (step.wait) return;
    if (step.fail) return failJob(dir, job, step.fail, true);
    const { seg, members, drop } = step;
    run.cursor = members[members.length - 1] + 1;
    run.nextSeg = seg + 1;
    run.queue = run.queue
      .then(async () => {
        await Promise.all(drop.map((i) => unlinkQuiet(gopPath(run, i))));
        await publish(dir, job, run, seg, members);
      })
      .catch((err) => {
        if (job.run === run) failJob(dir, job, `could not publish segment ${seg}: ${err.message}`, false);
      });
    // An encoder far ahead of anything asked for stops here (what it decided
    // is still published — the queue above does not need the process).
    if (job.enc && seg - (job.wantSeg != null ? job.wantSeg : run.fromSeg) >= ENC_LEAD_MAX && !(job.waiting > 0)) {
      return park(dir, job, `${ENC_LEAD_MAX} segments ahead of its reader`);
    }
  }
};

const gopOf = (run, i) => run.gops[i] || (run.gops[i] = { start: null, closed: false });

// ffmpeg opened GOP file i (so every earlier file is closed and complete).
const onOpened = (dir, job, run, i, start) => {
  if (job.run !== run) return;
  const g = gopOf(run, i);
  if (start != null && g.start == null) g.start = start;
  // A run from the very top: file 0 is the top of the film by definition,
  // even when an audio packet happened to be written first.
  if (i === 0 && run.fromSeg === 0 && g.start == null) g.start = job.table[0].start;
  for (let j = i - 1; j >= 0 && run.gops[j] && !run.gops[j].closed; j--) run.gops[j].closed = true;
  if (i === 0 && run.fmt === "fmp4") {
    run.queue = run.queue.then(() => publishInit(dir, run)).then(() => wake(job)).catch((err) => {
      if (job.run === run) failJob(dir, job, `could not publish init.mp4: ${err.message}`, false);
    });
  }
  advance(dir, job, run);
};

// ffmpeg finished GOP file i and listed it with its measured start.
const onClosed = (dir, job, run, i, start) => {
  if (job.run !== run) return;
  if (!run.gops[i]) onOpened(dir, job, run, i, null); // the open line never came
  if (job.run !== run) return;
  const g = gopOf(run, i);
  // The list's start is the splitting keyframe's pts for every file but the
  // first (whose entry starts at 0 whatever the stream does).
  if (i > 0 && Number.isFinite(start)) {
    if (g.start != null && Math.abs(g.start - start) > BOUNDARY_TOL_SEC) {
      // the log line and the list disagree: stop trusting the log line for
      // good, and nothing this run decided from it can be vouched for
      openLineTrusted = false;
      return failJob(dir, job, `ffmpeg's log and segment list disagree on GOP ${i} (${g.start} vs ${start})`, false);
    }
    g.start = start;
  }
  g.closed = true;
  advance(dir, job, run);
};

// Split a child's output stream into lines.
const eachLine = (stream, onLine) => {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl).replace(/\r$/, ""));
      buf = buf.slice(nl + 1);
    }
  });
  stream.on("end", () => { if (buf) onLine(buf); });
};

// Spawn a rolling producer emitting GOP files from just before
// table[fromSeg] to EOF.
const startProducer = (dir, job, input, fromSeg) => {
  stopProducer(job);
  const gen = ++job.gen;
  const run = {
    gen, fromSeg, fmt: input.fmt,
    pdir: path.join(dir, `p${gen}`),
    gops: [], // per GOP file: { start (movie seconds) | null, closed }
    cursor: 0, // first GOP file not yet assigned to a segment
    nextSeg: fromSeg, // next segment to publish
    ended: false,
    queue: Promise.resolve(), // file work, strictly in order
  };
  fs.mkdirSync(run.pdir, { recursive: true });
  const start = job.table[fromSeg].start;
  const args = producerArgs(run, input, fromSeg > 0 ? start : null);
  const proc = spawn(config.FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // An encoder yields the CPU to the server itself (as remux.js does).
  if (input.enc) { try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} }
  let errTail = "";
  eachLine(proc.stderr, (line) => {
    const open = parseOpenLine(line);
    if (open) return onOpened(dir, job, run, open.idx, open.start);
    if (/error|invalid|failed|unable|no such/i.test(line)) errTail = (errTail + line + "\n").slice(-400);
  });
  eachLine(proc.stdout, (line) => {
    const done = parseListLine(line);
    if (done) onClosed(dir, job, run, done.idx, done.start);
  });
  proc.on("error", () => {});
  proc.on("close", (code) => {
    if (job.proc === proc) job.proc = null;
    if (code === 0 && job.run === run) {
      // EOF: the last file is closed too, and no later keyframe will come
      run.ended = true;
      for (const g of run.gops) if (g) g.closed = true;
      advance(dir, job, run);
    } else if (code !== 0 && code !== null) {
      console.error(`[jit] producer exited ${code} (${path.basename(dir)} @seg${fromSeg}):`, errTail.trim());
      if (input.enc && input.enc.onExit) { try { input.enc.onExit(code, errTail); } catch {} }
    }
    // the run's scratch files go once its pending publishes are through
    run.queue.then(() => fs.promises.rm(run.pdir, { recursive: true, force: true })).catch(() => {});
    wake(job);
  });
  job.proc = proc;
  job.run = run;
  job.fromSeg = fromSeg;
  console.log(`[jit] producer ${path.basename(dir)} from seg${fromSeg} (${start.toFixed(1)}s)`);
};

// Highest segment index already published in this dir (any producer), or -1.
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

// Wait for the next publish (or a poll tick, whichever is first).
const tick = (job) =>
  new Promise((resolve) => {
    const woken = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { job.waiters.delete(woken); resolve(); }, WAIT_POLL_MS);
    job.waiters.add(woken);
  });

// Serve segment k: instantly if published; else (re)aim the producer and wait.
// "Covered" means the RUNNING producer will deliver k IMMINENTLY — k is at
// most a few segments past the last one it decided — not merely someday:
// waiting for a distant k would mean producing (and, for torrents,
// DOWNLOADING) everything between, which is exactly the cold-seek cost jit
// exists to kill. Re-aim instead. (The write head is the producer's own:
// segments an earlier producer left further along the film say nothing
// about how soon this one arrives.)
const ensureSegment = async (dir, job, input, k) => {
  job.lastAccess = Date.now();
  job.waiting = (job.waiting || 0) + 1;
  // One rendition, one set of encoder arguments for as long as its job
  // lives: whatever the first request decided (tone mapping depends on how
  // busy the machine was) holds for every later producer of this job.
  if (job.enc) {
    input = { ...input, enc: job.encArgs || (job.encArgs = input.enc) };
    job.wantSeg = k;
  }
  try {
    const file = await ensureSegmentInner(dir, job, input, k);
    if (file && job.enc) resumeAhead(dir, job, input, k);
    return file;
  } finally {
    job.waiting--;
  }
};
// A parked encoder whose reader is getting close to the end of what it made:
// start it again at the first segment that is missing, before it is asked for.
const resumeAhead = (dir, job, input, k) => {
  if (job.proc || job.broken) return;
  const last = Math.min(k + ENC_LEAD_MIN, job.table.length - 1);
  for (let m = k + 1; m <= last; m++) {
    if (fs.existsSync(segPath(dir, m, input.fmt))) continue;
    if (admitEncode(job, input.enc.essential)) startProducer(dir, job, input, m);
    return;
  }
};
const covers = (job, k) =>
  !!(job.proc && job.run && k >= job.run.fromSeg && k - job.run.nextSeg < COVER_AHEAD);
const ensureSegmentInner = async (dir, job, input, k) => {
  if (!(k >= 0 && k < job.table.length)) return null;
  const file = segPath(dir, k, input.fmt);
  if (fs.existsSync(file)) return file;
  let spawns = 0;
  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return file;
    if (job.broken) return null;
    // not coming soon — or the producer died without delivering: aim here.
    // A producer that keeps dying is not asked a fourth time.
    if (!covers(job, k)) {
      // a publish already decided may still be on its way to disk
      const run = job.run;
      if (run && k >= run.fromSeg && k < run.nextSeg) {
        await run.queue;
        if (fs.existsSync(file)) return file;
        if (job.broken) return null;
      }
      if (spawns >= MAX_SPAWNS_PER_WAIT) return null;
      // an encoder needs a slot (a copy never does)
      if (job.enc && !admitEncode(job, input.enc.essential)) return null;
      spawns++;
      startProducer(dir, job, input, k);
    }
    await tick(job);
    job.lastAccess = Date.now();
  }
  return null;
};

// The fMP4 init segment (codec parameters, no media). Any producer writes
// it first thing, so if none is running, aim one at seg0.
const ensureInit = async (dir, job, input) => {
  job.lastAccess = Date.now();
  if (job.enc) input = { ...input, enc: job.encArgs || (job.encArgs = input.enc) };
  const file = path.join(dir, "init.mp4");
  let spawns = 0;
  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return file;
    if (job.broken) return null;
    if (!job.proc) {
      if (spawns >= MAX_SPAWNS_PER_WAIT) return null;
      if (job.enc && !admitEncode(job, input.enc.essential)) return null;
      spawns++;
      startProducer(dir, job, input, 0);
    }
    await tick(job);
    job.lastAccess = Date.now();
  }
  return null;
};

// Get-or-create the job for a stream's jit dir. `entry` is what tableFor
// returned. `enc`: this dir holds an ENCODED rendition (ladder.js) — it
// counts against the encoder cap, and a boundary its encoder misses is held
// against the encodes of this file only (key "…|enc"), never against the
// copy, whose index was not the one that lied.
const jobFor = (dir, entry, { enc = false } = {}) => {
  let job = jobs.get(dir);
  if (!job) {
    // Whatever is in the dir was left by a process that is gone — possibly
    // half-written, possibly cut by other rules. Never serve it.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(dir, { recursive: true });
    job = {
      proc: null, run: null, gen: 0, fromSeg: 0, lastAccess: Date.now(),
      table: entry.table, key: entry.key ? (enc ? encKey(entry.key) : entry.key) : null,
      broken: null, waiters: new Set(), waiting: 0,
      enc: !!enc, title: entry.key || dir, encArgs: null, wantSeg: null, refusedAt: 0,
    };
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
      stopProducer(job);
      jobs.delete(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      console.log(`[jit] idle-killed ${path.basename(dir)}`);
    }
  }
}, 30000).unref?.();

// Under memory pressure the watchdog asks: drop the segment tables (they are
// re-read from the file in a few ms) and kill every idle producer now.
try {
  require("../lib/watchdog").onSoftHeal(() => {
    const n = tables.size;
    tables.clear();
    let killed = 0;
    const now = Date.now();
    for (const job of jobs.values()) {
      // a producer someone is waiting on, or that served a segment in the
      // last two minutes (a paused viewer, a full buffer), is not idle
      if (now - job.lastAccess > 120000 && job.proc && !(job.waiting > 0)) {
        stopProducer(job);
        killed++;
      }
    }
    return `jit: ${n} tables dropped, ${killed} idle producers stopped`;
  });
} catch {}

const liveCount = () => { let n = 0; for (const j of jobs.values()) if (j.proc) n++; return n; };

// Stop a job and forget it (tests; the reaper does the same on idle).
const dropJob = (dir) => {
  const job = jobs.get(dir);
  if (!job) return;
  stopProducer(job);
  jobs.delete(dir);
};

module.exports = {
  liveCount,
  tableFor,
  playlistText,
  jobFor,
  ensureSegment,
  ensureInit,
  segPath,
  declinedReason,
  // the quality ladder (ladder.js, the routes)
  encodeCount,
  encodeRoom,
  encodeDeclined: (key) => declinedReason(encKey(key)),
  refusedJustNow: (job) => Date.now() - (job.refusedAt || 0) < 2000,
  // Test-only.
  _internals: {
    buildTable, producedUpTo, nextSegment, parseOpenLine, parseListLine, producerArgs,
    dropJob, decline,
    setDeclinedFile: (f) => { declinedFile = f; declined = null; },
    TARGET_SEG_SEC, TS_OFFSET_SEC, BOUNDARY_TOL_SEC,
    sourceRate, admitEncode, park, MAX_ENCODES, ENC_LEAD_MAX, ENC_LEAD_MIN,
    setOutsideEncodes: (fn) => { outsideEncodes = fn; },
    jobs,
  },
};
