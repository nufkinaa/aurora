// S7 — JIT full-timeline streaming. The player (and Apple's fullscreen) gets
// a COMPLETE VOD playlist up front — exact total duration from the MKV
// header, exact segment boundaries from the video track's Cues — and segments
// materialize on demand: a "seek" stops being a transcode restart and becomes
// the player fetching segment #1042, which a rolling copy producer emits at
// stream speed. (Several people in one film: see "producers" below.)
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
const { parseMp4Index } = require("./mp4index");

const TARGET_SEG_SEC = 6;
const IDLE_MS = 150000;
const WAIT_POLL_MS = 100;
const SEGMENT_WAIT_MS = 90000; // torrents legitimately wait on the swarm
const TS_OFFSET_SEC = 10; // constant media-clock offset (Apple's own segmenter uses 10s too)
const BOUNDARY_TOL_SEC = 0.002; // cue times and packet times are both ms-exact
const COVER_AHEAD = 3; // a producer "covers" a segment this close to its write head
const SEEK_BACK_SEC = 1; // aim BEFORE the wanted keyframe (see producerArgs)
const MAX_SPAWNS_PER_WAIT = 3; // per waiting request: a producer that keeps dying
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
// The whole list, for the healer and the admin's "retry" action:
// [{ key, why, at }]. A key is "<library id>-<file mtime>[|enc]".
const declinedList = () => [...loadDeclined()].map(([key, v]) => ({ key, why: (v && v.why) || "", at: (v && v.at) || 0 }));
// Forget ONE entry (the file was replaced): true when something was removed.
const forgetDeclined = (key) => {
  const map = loadDeclined();
  if (!map.delete(key)) return false;
  try { fs.writeFileSync(declinedFile, JSON.stringify({ algo: ALGO, keys: Object.fromEntries(map) })); } catch {}
  return true;
};
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
// cannot be served by jit (no keyframe index it can read, or declined earlier).
// `mp4`: an MP4's index may be read too (mp4index.js) — asked for by the
// library's routes; a torrent's are MKV-only as before (an MP4's index is
// megabytes, often at the far end of a file that is still downloading).
const tableFor = async (indexKey, readRange, fileSize, { mp4 = false } = {}) => {
  if (declinedReason(indexKey)) return null;
  const hit = tables.get(indexKey);
  if (hit) return hit;
  if (!readRange) return null;
  let index = await parseMkvIndex(readRange, fileSize);
  if (!index && mp4) index = await parseMp4Index(readRange, fileSize);
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

// ---------- producers: more than one reader in a film ----------
// A job (one rendition of one source) used to have ONE producer, re-aimed at
// whatever segment was asked for that it was not about to deliver. Two
// people far apart in the same film re-aimed it away from each other on
// every request — six ffmpeg starts and a 504 inside 50ms, for the length of
// the film. A job now has a short LIST of producers and three rules:
//  • a producer somebody is waiting on is never taken away. Whoever starts
//    (or re-aims) a producer is covered by it until its segment is out, so a
//    waiter can no longer lose its producer to another waiter;
//  • who a producer "belongs" to is read from the requests themselves: a
//    reader is a run of requests moving along the film (job.readers), a
//    producer is IN USE while a reader was seen in its range in the last
//    CLAIM_MS, and its LEAD is how far it has got past that reader;
//  • a request no producer covers takes, in this order (plan): a producer
//    nobody reads any more; a new one, when the job is known to have two
//    live readers and there is room; a producer far enough ahead of its
//    reader that taking it costs that reader nothing soon; any producer
//    nobody is waiting on, while nothing says there are two readers; a new
//    one when there is room. Otherwise it waits its turn — for BUSY_WAIT_MS
//    at most, then the route says 503.
// One viewer seeking is therefore what it always was: the old producer is
// re-aimed (a second one is started beside it only while a request is still
// waiting on the old one, and is reaped when nobody reads it). "Two live
// readers" is not guessed from one request: it takes requests going BACK to
// a reader that was left for another one, twice (A, B, A, B) — one player
// seeking does not produce that. Until it is seen, two viewers may take
// each other's producer once or twice; nobody waiting is ever the loser.
// Bounds: MAX_PRODUCERS_PER_JOB per rendition; second and third producers of
// copies are MAX_EXTRA_PRODUCERS across the server; every producer of an
// encoded rendition is one of the MAX_ENCODES encoders (below), and a second
// encoder for the same rendition never takes the last slot unless the
// rendition is the only way its viewers can play the file.
// Exactness is untouched by any of this: each producer groups and checks its
// own GOP files against the table, and a segment gets its public name once.
const MAX_PRODUCERS_PER_JOB = 3;
const MAX_EXTRA_PRODUCERS = 4;
const CLAIM_MS = 20000; // a playing reader asks at least once per segment
const READER_TTL_MS = 60000;
const READER_NEAR = 4; // a request this close ahead of a reader is that reader
const STEAL_LEAD = 8; // segments ahead of its reader (~50s of film)
const CONTEND_MS = 60000;
const BUSY_WAIT_MS = 15000; // under a player's own segment timeout

// A producer is its run (see startProducer); job.producers are the live ones.
const stopRun = (job, run) => {
  run.stopped = true;
  const i = job.producers.indexOf(run);
  if (i >= 0) job.producers.splice(i, 1);
  const proc = run.proc;
  run.proc = null;
  if (proc) { try { proc.kill("SIGKILL"); } catch {} }
};
const stopProducers = (job) => { for (const run of [...job.producers]) stopRun(job, run); };

// "Covered" means the producer will deliver k IMMINENTLY — k is at most a
// few segments past the last one it decided — not merely someday: waiting
// for a distant k would mean producing (and, for torrents, DOWNLOADING)
// everything between, which is exactly the cold-seek cost jit exists to
// kill. (The write head is the producer's own: segments an earlier producer
// left further along the film say nothing about how soon this one arrives.)
const coversRun = (run, k) => k >= run.fromSeg && k - run.nextSeg < COVER_AHEAD;
const covering = (job, k) => job.producers.find((run) => coversRun(run, k)) || null;
// Is somebody waiting, right now, on a segment this producer is about to make?
const waitedOn = (job, run) => job.wanted.some((k) => coversRun(run, k));

// A request for segment k: move the reader it continues, or note a new one.
const noteReader = (job, k, now) => {
  job.readers = job.readers.filter((r) => now - r.at < READER_TTL_MS);
  let hit = null;
  for (const r of job.readers) {
    const d = k - r.seg;
    if (d >= -2 && d <= READER_NEAR && (!hit || Math.abs(d) < Math.abs(k - hit.seg))) hit = r;
  }
  if (!hit) {
    hit = { seg: k, at: now };
    job.readers.push(hit);
    if (job.readers.length > 8) job.readers.shift();
  } else {
    // back at a reader that was left for another one, and recently: twice
    // in a row and these are two players, not one that is seeking
    if (job.lastReader && job.lastReader !== hit && now - hit.at < CLAIM_MS) {
      job.returns = job.returns.filter((t) => now - t < 2 * CLAIM_MS);
      job.returns.push(now);
      if (job.returns.length >= 2) job.contendedAt = now;
    }
    hit.seg = k;
    hit.at = now;
  }
  job.lastReader = hit;
};
const contended = (job, now) => now - job.contendedAt < CONTEND_MS;

// Who reads a producer's output: readers inside its range, or up to a
// resume-ahead's distance behind where it started. `at`: when one was last
// seen (0 = never); `lead`: segments decided past the furthest of them.
const usage = (job, run, now) => {
  let at = 0;
  let seg = null;
  for (const r of job.readers) {
    if (now - r.at >= READER_TTL_MS) continue;
    if (r.seg < run.fromSeg - ENC_LEAD_MIN - 1 || r.seg - run.nextSeg >= COVER_AHEAD) continue;
    at = Math.max(at, r.at);
    seg = seg == null ? r.seg : Math.max(seg, r.seg);
  }
  return { at, lead: run.nextSeg - 1 - (seg != null ? seg : run.fromSeg) };
};

// Pure: what a request for a segment NO producer covers should do.
//   { spawn: true }   start a producer for it (beside the others, if any)
//   { steal: run }    stop that producer and start one here in its place
//   { wait: true }    every producer is somebody's, and there is no room
// `room`: may this job have one more producer (the caps — the caller's).
// `polite`: a look-ahead, not a viewer waiting — only what costs nobody.
const plan = (job, now, { room = false, polite = false } = {}) => {
  const live = job.producers;
  if (!live.length) return { spawn: true };
  const free = live
    .filter((run) => !waitedOn(job, run))
    .map((run) => ({ run, ...usage(job, run, now) }))
    .sort((a, b) => a.at - b.at); // the one read longest ago first
  const unread = free.find((f) => now - f.at >= CLAIM_MS);
  if (unread) return { steal: unread.run };
  const two = contended(job, now);
  if (two && room) return { spawn: true };
  const ahead = free.find((f) => f.lead >= STEAL_LEAD);
  if (ahead) return { steal: ahead.run };
  // nothing says there are two readers: this is the one viewer, seeking
  if (!polite && !two && free.length) return { steal: free[0].run };
  if (room) return { spawn: true };
  return { wait: true };
};

// Second and third producers of copies, across the server.
const extraCount = () => {
  let n = 0;
  for (const j of jobs.values()) if (!j.enc && j.producers.length > 1) n += j.producers.length - 1;
  return n;
};

// Producers beyond a job's first that no reader has been near for
// READER_TTL_MS (the viewer left, paused for long, or sought away): pure —
// the reaper stops them. The most recently read one always stays.
const reapable = (job, now) => {
  if (job.producers.length < 2) return [];
  const ranked = job.producers
    .map((run) => ({ run, at: usage(job, run, now).at }))
    .sort((a, b) => b.at - a.at);
  return ranked.slice(1).filter((f) => f.at === 0 && !waitedOn(job, f.run)).map((f) => f.run);
};

// ---------- encoded renditions: how many, and for how long ----------
// A copy producer is cheap (it is the disk's speed). An ENCODING producer —
// a rendition of the quality ladder — is a libx264 process, and the machine
// serves other people. Three rules:
//  • at most MAX_ENCODES encoders at once across the whole server, counted
//    together with the single-rendition encodes (remux.js) and the torrent
//    transcodes. A lower rung under a copy is a courtesy to a slow line —
//    the title plays without it — so it never takes the LAST slot; the top
//    rung of a device that cannot decode the file (`essential`) may. The
//    same goes for a SECOND encoder of one rendition (two viewers far apart
//    in it): only an essential rendition gets one, and only into a free
//    slot — the viewers of a courtesy rung share its one encoder (plan), or
//    are told 503 and their players move to another rendition.
//  • the other renditions of the SAME title are this viewer's own: the one
//    nobody is waiting on is the level the player just switched away from —
//    it is parked (its finished segments stay). One that is still being
//    waited on (the player's last request to the old level is in flight)
//    is let finish, so for a moment a title may hold both slots; it never
//    holds more, and it never refuses its own viewer a level change.
//  • an encoder that has run ENC_LEAD_MAX segments ahead of the last one
//    its reader asked for is parked too — a rendition the player left costs
//    nothing more, and one being watched is resumed as its reader gets
//    within ENC_LEAD_MIN segments of the end of what is made.
const MAX_ENCODES = 2; // the same figure as remux.js MAX_ACTIVE_TRANSCODES
const ENC_LEAD_MAX = 20; // ~2 minutes of film
const ENC_LEAD_MIN = 5;
const encodeCount = (except = null) => {
  let n = 0;
  for (const j of jobs.values()) if (j.enc && j !== except) n += j.producers.length;
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
// Stop every encoder of a rendition (what it made stays).
const park = (dir, job, why) => {
  if (!job.producers.length) return;
  console.log(`[jit] parked ${path.basename(dir)} (${why})`);
  stopProducers(job);
  wake(job);
};
// An encoder of ANOTHER title that nobody has asked anything of for
// ABANDONED_MS, and nobody is waiting on: its viewer went away (closed the
// tab, moved to the next episode, paused for a while). It used to hold its
// slot all the same until it had run ENC_LEAD_MAX segments ahead or the idle
// reaper found it (2.5 min) — and for that long the NEXT title was refused
// its lighter renditions: on a thin line that title then had only its top
// rung, which the line could not carry (measured 2026-10-10, tools/ttff: the
// next episode on a 3 Mbit/s line, 73 s to its first frame). Such an encoder
// no longer counts against anyone, and is parked when the slot is wanted
// (what it made stays; a viewer who comes back to it restarts it — see
// resumeAhead — exactly as after any park).
const ABANDONED_MS = 20000; // a playing reader asks at least once per segment (CLAIM_MS)
const abandoned = (j, now) => !(j.waiting > 0) && now - (j.lastAccess || 0) > ABANDONED_MS;
// Encoders running for OTHER titles (and outside jit), and for this title's
// other renditions: those someone is waiting on (`waited`, a count of
// encoders), and those nobody is (`idle`, the jobs). `left`: other titles'
// encoders that were abandoned (above) — not counted, parked on admission.
const encodeCensus = (title, except, now = Date.now()) => {
  let others = outsideEncodes();
  let waited = 0;
  const idle = [];
  const left = [];
  for (const [d, j] of jobs) {
    if (!j.enc || !j.producers.length || j === except) continue;
    if (j.title !== title) {
      if (abandoned(j, now)) left.push([d, j]);
      else others += j.producers.length;
    } else if (j.waiting > 0) waited += j.producers.length;
    else idle.push([d, j]);
  }
  return { others, waited, idle, left };
};
// Could this job start an encoder now? `replacing`: one of its own that
// would be stopped for it. Nothing is changed by asking.
const encodeAdmission = (job, essential, replacing = null) => {
  const c = encodeCensus(job.title, job);
  const own = job.producers.length - (replacing ? 1 : 0);
  const limit = essential ? MAX_ENCODES : MAX_ENCODES - 1;
  const ok = own > 0
    ? c.others + c.waited + own < limit
    : c.others < limit && c.others + c.waited < MAX_ENCODES;
  return { ok, idle: c.idle, left: c.left };
};
// May this job start (or restart) an encoder now? Parks the renditions of
// its own title that nobody is waiting on. Records a refusal so the route
// can say "busy".
const admitEncode = (job, essential, replacing = null) => {
  const a = encodeAdmission(job, essential, replacing);
  if (!a.ok) {
    job.refusedAt = Date.now();
    try { require("../lib/signals").hit("no-encoder", "rendition"); } catch {} // the healer counts these (a 503 follows)
    return false;
  }
  for (const [d, j] of a.idle) park(d, j, "its viewer moved to another rendition");
  for (const [d, j] of a.left) park(d, j, "nobody has asked for it lately, and another title needs the encoder");
  return true;
};
// Would a new encoder be admitted right now? (the routes ask before they
// offer or serve an encoded rendition; nothing is parked by asking)
const encodeRoom = (title, essential) => {
  const c = encodeCensus(title, null);
  return c.others < (essential ? MAX_ENCODES : MAX_ENCODES - 1) && c.others + c.waited < MAX_ENCODES;
};

const failJob = (dir, job, why, declineFile) => {
  if (job.broken) return;
  job.broken = why;
  console.error(`[jit] ${path.basename(dir)}: ${why}${declineFile ? " — declining this file" : ""}`);
  if (declineFile) decline(job.key, why);
  stopProducers(job);
  wake(job);
};

const renameRetry = async (from, to) => {
  for (let n = 0; ; n++) {
    try { return await fs.promises.rename(from, to); } catch (err) {
      // a scanner or indexer briefly holding the file (Windows)…
      if (n >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      // …or another producer of this job put the same segment there first
      if (fs.existsSync(to)) throw err;
      await new Promise((r) => setTimeout(r, 40 * (n + 1)));
    }
  }
};
const unlinkQuiet = (f) => fs.promises.unlink(f).catch(() => {});
// Give `from` its public name. Losing a race for the name is not a failure:
// whoever won put the same segment there (two producers of one job can
// reach the same segment), and a published file is never replaced.
const moveInto = async (from, final) => {
  if (fs.existsSync(final)) return unlinkQuiet(from);
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
    // already published by another producer — same bytes by contract
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
  if (run.stopped || job.broken) return;
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
        if (!run.stopped) failJob(dir, job, `could not publish segment ${seg}: ${err.message}`, false);
      });
    // (what a producer decided before it is stopped is still published — the
    // queue above does not need the process)
    // It has reached where another producer of this job started and is still
    // going: from here on the two would make the same segments. Its readers
    // are the other one's now.
    if (run.nextSeg < job.table.length && job.producers.some((o) => o !== run && o.fromSeg <= run.nextSeg && run.nextSeg <= o.nextSeg)) {
      console.log(`[jit] producer ${path.basename(dir)} from seg${run.fromSeg} met another at seg${run.nextSeg}`);
      stopRun(job, run);
      return wake(job);
    }
    // A warm-up (warmSegment) has made what it was started for, and nobody
    // came: it stops here. What it made stays for as long as the job does.
    if (run.warm != null && run.nextSeg > run.warm && !waitedOn(job, run)) {
      console.log(`[jit] warm-up ${path.basename(dir)} done at seg${run.nextSeg - 1}`);
      stopRun(job, run);
      return wake(job);
    }
    // An encoder far ahead of anything its reader asked for stops here.
    if (job.enc && !waitedOn(job, run) && usage(job, run, Date.now()).lead >= ENC_LEAD_MAX) {
      console.log(`[jit] parked ${path.basename(dir)} (${ENC_LEAD_MAX} segments ahead of its reader)`);
      stopRun(job, run);
      return wake(job);
    }
  }
};

const gopOf = (run, i) => run.gops[i] || (run.gops[i] = { start: null, closed: false });

// ffmpeg opened GOP file i (so every earlier file is closed and complete).
const onOpened = (dir, job, run, i, start) => {
  if (run.stopped) return;
  const g = gopOf(run, i);
  if (start != null && g.start == null) g.start = start;
  // A run from the very top: file 0 is the top of the film by definition,
  // even when an audio packet happened to be written first.
  if (i === 0 && run.fromSeg === 0 && g.start == null) g.start = job.table[0].start;
  for (let j = i - 1; j >= 0 && run.gops[j] && !run.gops[j].closed; j--) run.gops[j].closed = true;
  if (i === 0 && run.fmt === "fmp4") {
    run.queue = run.queue.then(() => publishInit(dir, run)).then(() => wake(job)).catch((err) => {
      if (!run.stopped) failJob(dir, job, `could not publish init.mp4: ${err.message}`, false);
    });
  }
  advance(dir, job, run);
};

// ffmpeg finished GOP file i and listed it with its measured start.
const onClosed = (dir, job, run, i, start) => {
  if (run.stopped) return;
  if (!run.gops[i]) onOpened(dir, job, run, i, null); // the open line never came
  if (run.stopped) return;
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

// Once a run's process is gone and its pending publishes are through, its
// scratch files go and the job forgets it.
const settle = (job, run) => {
  const q = run.queue;
  q.then(() => {
    if (run.queue !== q) return settle(job, run);
    job.runs.delete(run);
    return fs.promises.rm(run.pdir, { recursive: true, force: true });
  }).catch(() => {});
};

// Spawn a rolling producer emitting GOP files from just before
// table[fromSeg] to EOF — beside whatever producers the job already has
// (who is stopped for it, if anyone, is acquire's decision).
const startProducer = (dir, job, input, fromSeg) => {
  const gen = ++job.gen;
  const run = {
    gen, fromSeg, fmt: input.fmt,
    pdir: path.join(dir, `p${gen}`),
    gops: [], // per GOP file: { start (movie seconds) | null, closed }
    cursor: 0, // first GOP file not yet assigned to a segment
    nextSeg: fromSeg, // next segment to publish
    ended: false,
    stopped: false, // killed by us: nothing more is decided from its output
    startedAt: Date.now(),
    proc: null,
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
    const i = job.producers.indexOf(run);
    if (i >= 0) job.producers.splice(i, 1);
    run.proc = null;
    if (code === 0 && !run.stopped) {
      // EOF: the last file is closed too, and no later keyframe will come
      run.ended = true;
      for (const g of run.gops) if (g) g.closed = true;
      advance(dir, job, run);
    } else if (code !== 0 && code !== null) {
      console.error(`[jit] producer exited ${code} (${path.basename(dir)} @seg${fromSeg}):`, errTail.trim());
      if (input.enc && input.enc.onExit) { try { input.enc.onExit(code, errTail); } catch {} }
    }
    settle(job, run);
    wake(job);
  });
  run.proc = proc;
  job.producers.push(run);
  job.runs.add(run);
  console.log(`[jit] producer ${path.basename(dir)} from seg${fromSeg} (${start.toFixed(1)}s)${job.producers.length > 1 ? ` — ${job.producers.length} running` : ""}`);
  return run;
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

// Get a producer aimed at segment k, which none covers: "started",
// "refused" (an encoded rendition with no encoder to be had — recorded, the
// route says 503), or "busy" (every producer is somebody's: wait).
const acquire = (dir, job, input, k, now, polite = false) => {
  const essential = !!(job.enc && input.enc.essential);
  const room = job.producers.length < MAX_PRODUCERS_PER_JOB
    && (job.enc ? encodeAdmission(job, essential).ok : extraCount() < MAX_EXTRA_PRODUCERS);
  const step = plan(job, now, { room, polite });
  if (step.wait) return "busy";
  // an encoder needs a slot (a copy never does)
  if (job.enc && !admitEncode(job, essential, step.steal || null)) return "refused";
  if (step.steal) stopRun(job, step.steal);
  startProducer(dir, job, input, k);
  return "started";
};

// Serve segment k: instantly if published; else wait for the producer that
// is about to make it, or get one aimed at it (acquire) and wait.
// `gone`: () => true once the client that asked is no longer there (it
// closed the connection: a seek, a change of level, the player leaving). The
// wait ends then. It used to go on for as long as the segment took — up to
// SEGMENT_WAIT_MS — and for that long it held its producer as "somebody is
// waiting on this": the producer could not be re-aimed or parked, its encoder
// stayed counted, and the next title was refused its lighter renditions on
// the strength of a viewer who had left (measured 2026-10-10).
const ensureSegment = async (dir, job, input, k, { gone = null } = {}) => {
  const now = Date.now();
  job.lastAccess = now;
  if (!(k >= 0 && k < job.table.length)) return null;
  // One rendition, one set of encoder arguments for as long as its job
  // lives: whatever the first request decided (tone mapping depends on how
  // busy the machine was) holds for every later producer of this job.
  if (job.enc) input = { ...input, enc: job.encArgs || (job.encArgs = input.enc) };
  noteReader(job, k, now);
  for (const run of job.producers) run.warm = null; // a viewer is here: no warm-up bound applies
  job.waiting = (job.waiting || 0) + 1;
  job.wanted.push(k);
  try {
    const file = await ensureSegmentInner(dir, job, input, k, gone);
    if (file && job.enc && !(gone && gone())) resumeAhead(dir, job, input, k);
    return file;
  } finally {
    job.waiting--;
    const i = job.wanted.indexOf(k);
    if (i >= 0) job.wanted.splice(i, 1);
  }
};
// An encoder was parked and its reader is getting close to the end of what
// it made: start one again at the first segment that is missing, before it
// is asked for — if that takes nothing from anybody (plan, polite).
const resumeAhead = (dir, job, input, k) => {
  if (job.broken) return;
  const last = Math.min(k + ENC_LEAD_MIN, job.table.length - 1);
  for (let m = k + 1; m <= last; m++) {
    if (fs.existsSync(segPath(dir, m, input.fmt))) continue;
    if (covering(job, m)) return;
    for (const run of job.runs) if (m >= run.fromSeg && m < run.nextSeg) return; // on its way to disk
    acquire(dir, job, input, m, Date.now(), true);
    return;
  }
};
const ensureSegmentInner = async (dir, job, input, k, gone = null) => {
  const file = segPath(dir, k, input.fmt);
  if (fs.existsSync(file)) return file;
  let spawns = 0;
  let busySince = 0;
  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return file;
    if (job.broken) return null;
    if (gone && gone()) return null; // nobody is waiting for this any more
    // not coming soon — or the producer died without delivering: aim here.
    if (!covering(job, k)) {
      // a publish already decided may still be on its way to disk
      const pending = [...job.runs].find((run) => k >= run.fromSeg && k < run.nextSeg);
      if (pending) {
        await pending.queue;
        if (fs.existsSync(file)) return file;
        if (job.broken) return null;
      }
      if (!covering(job, k)) {
        // A producer that keeps dying is not asked a fourth time.
        if (spawns >= MAX_SPAWNS_PER_WAIT) return null;
        const now = Date.now();
        const got = acquire(dir, job, input, k, now);
        if (got === "refused") return null;
        if (got === "started") {
          spawns++;
          busySince = 0;
        } else {
          // every producer is another reader's: its turn comes when one of
          // them is far enough ahead — or the honest answer is "busy"
          if (!busySince) busySince = now;
          if (now - busySince >= BUSY_WAIT_MS) {
            job.refusedAt = now;
            try { require("../lib/signals").hit("no-encoder", "rendition"); } catch {}
            return null;
          }
        }
      }
    }
    await tick(job);
    job.lastAccess = Date.now();
  }
  return null;
};

// ---------- before the viewer asks ----------
// WARM-UP. The first segment of a start is the one a viewer waits for, and
// making it is a process start, a seek and a whole GOP (plus an encode, for
// an encoded rendition): a third of a second on a fast box with the file in
// memory, seconds on a slow one. A client that knows a start is coming — the
// pointer is on Play, or the player has just been opened and is still
// loading its playlists — says so (the segment's own URL with &warm=1), and
// the making begins then instead of when the segment is finally asked for.
//
// It is bounded so that a hint can never cost a viewer anything:
//  • it never takes or adds to a job's producers — only a job with none gets
//    one — and it is nobody's reader (the readers' bookkeeping is untouched);
//  • the producer stops by itself WARM_AHEAD segments on (see advance) unless
//    a real request arrives first, which makes it an ordinary producer;
//  • an ENCODED rendition is warmed only while no encoder is running
//    anywhere on the server: a hint never competes with a film being watched;
//  • WARM_MAX_PER_MIN starts a minute across the server, whoever asks.
// Returns what happened: "ready" (already on disk), "coming" (a producer is
// about to make it), "started", or why not: "busy", "refused", "throttled", "no".
const WARM_AHEAD = 2;
const WARM_MAX_PER_MIN = 8;
const warmStarts = [];
const warmSegment = (dir, job, input, k, now = Date.now()) => {
  if (job.broken || !(k >= 0 && k < job.table.length)) return "no";
  job.lastAccess = now;
  if (fs.existsSync(segPath(dir, k, input.fmt))) return "ready";
  if (covering(job, k)) return "coming";
  for (const run of job.runs) if (k >= run.fromSeg && k < run.nextSeg) return "coming"; // on its way to disk
  if (job.producers.length) return "busy";
  if (job.enc) {
    if (encodeCount() + outsideEncodes() > 0) return "refused";
    input = { ...input, enc: job.encArgs || (job.encArgs = input.enc) };
  }
  while (warmStarts.length && now - warmStarts[0] > 60000) warmStarts.shift();
  if (warmStarts.length >= WARM_MAX_PER_MIN) return "throttled";
  warmStarts.push(now);
  const run = startProducer(dir, job, input, k);
  run.warm = k + WARM_AHEAD;
  return "started";
};

// A viewer LEFT a title (the player closed, or moved to the next episode):
// every producer of that title that nobody is waiting on is parked now,
// instead of running on — an encoder for up to ENC_LEAD_MAX segments, a copy
// to the end of the film — until the idle reaper finds it. What they made
// stays. If someone else is in the same film, their next request finds the
// segments already made and restarts a producer where they run out, as
// after any park. Returns how many producers were stopped.
const release = (title) => {
  let n = 0;
  for (const [d, j] of jobs) {
    if (j.title !== title || !j.producers.length || j.waiting > 0) continue;
    n += j.producers.length;
    park(d, j, "its viewer left");
  }
  return n;
};

// The segment of a table that holds second `sec` of the film (the one a
// player starting there asks for first). PURE.
const segmentAt = (table, sec) => {
  if (!table || !table.length) return -1;
  let lo = 0;
  let hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table[mid].start <= sec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
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
    if (!job.producers.length) {
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
      producers: [], // live producers (runs), see "producers" above
      runs: new Set(), // every run whose publishes are not all on disk yet
      gen: 0, lastAccess: Date.now(),
      table: entry.table, key: entry.key ? (enc ? encKey(entry.key) : entry.key) : null,
      broken: null, waiters: new Set(), waiting: 0,
      wanted: [], // the segments being waited on right now
      readers: [], lastReader: null, returns: [], contendedAt: 0,
      enc: !!enc, title: entry.key || dir, encArgs: null, refusedAt: 0,
    };
    jobs.set(dir, job);
  }
  job.lastAccess = Date.now();
  return job;
};

// Idle reaper — same contract as the other transcoders; and the producers a
// job no longer has a reader for (see reapable).
setInterval(() => {
  const now = Date.now();
  for (const [dir, job] of jobs) {
    if (now - job.lastAccess > IDLE_MS) {
      stopProducers(job);
      jobs.delete(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      console.log(`[jit] idle-killed ${path.basename(dir)}`);
      continue;
    }
    for (const run of reapable(job, now)) {
      console.log(`[jit] producer ${path.basename(dir)} from seg${run.fromSeg} has no reader — stopped`);
      stopRun(job, run);
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
      if (now - job.lastAccess > 120000 && job.producers.length && !(job.waiting > 0)) {
        killed += job.producers.length;
        stopProducers(job);
      }
    }
    return `jit: ${n} tables dropped, ${killed} idle producers stopped`;
  });
} catch {}

const liveCount = () => { let n = 0; for (const j of jobs.values()) n += j.producers.length; return n; };
// Every ffmpeg this module has running: what it is for, since when, and how
// long ago anybody last asked its job for anything (the healer's "stuck
// helper" check — the idle reaper above should never let that grow old).
const helpers = (now = Date.now()) => {
  const out = [];
  for (const [dir, j] of jobs) for (const r of j.producers) out.push({ kind: "jit", name: path.basename(dir), startedAt: r.startedAt || 0, idleMs: now - (j.lastAccess || now), enc: !!j.enc });
  return out;
};

// Stop a job and forget it (tests; the reaper does the same on idle).
const dropJob = (dir) => {
  const job = jobs.get(dir);
  if (!job) return;
  stopProducers(job);
  jobs.delete(dir);
};

module.exports = {
  liveCount,
  helpers,
  declinedList,
  forgetDeclined,
  tableFor,
  playlistText,
  jobFor,
  ensureSegment,
  ensureInit,
  warmSegment,
  segmentAt,
  release,
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
    // producers and readers
    plan, noteReader, usage, reapable, contended, coversRun, extraCount, stopRun,
    MAX_PRODUCERS_PER_JOB, MAX_EXTRA_PRODUCERS, CLAIM_MS, READER_TTL_MS, STEAL_LEAD, BUSY_WAIT_MS, COVER_AHEAD,
    setOutsideEncodes: (fn) => { outsideEncodes = fn; },
    jobs, encodeCensus, abandoned, ABANDONED_MS, WARM_AHEAD, WARM_MAX_PER_MIN, warmStarts, advance,
  },
};
