// Head-probe for torrent streams: the release NAME is a guess (missing tags,
// lying tags — both observed in the wild), but the file's container header
// cannot lie. ffprobe reads the stream's first bytes through our own blocking
// range route — the same head pieces playback needs first anyway, so the
// probe rides demand that already exists — and answers with the REAL codecs
// in the same shape the library scanner gives its items, so the client's one
// set of capability functions (videoNeedsTranscode / audioNeedsRemux) can
// decide for streams exactly as it does for library files.
//
// Results are cached per infoHash+fileIdx for the process lifetime (codecs
// don't change), and a probe in flight is shared by all askers. Failure is
// cached only briefly: an mp4 with its moov at the tail, or a swarm with no
// head pieces yet, legitimately fails now and succeeds later.
const { spawn } = require("child_process");
const config = require("../config");

const results = new Map(); // "hash:idx" -> result object
const failures = new Map(); // "hash:idx" -> failedAt ms
const inflight = new Map(); // "hash:idx" -> promise
const FAIL_TTL = 60 * 1000;
const PROBE_TIMEOUT_MS = 30000;

const BIT10 = /10le|10be/;
const CONTAINERS = [
  [/matroska|webm/, "mkv"],
  [/mp4|mov|m4a/, "mp4"],
  [/avi/, "avi"],
  [/mpegts/, "ts"],
];

const parse = (json) => {
  const j = JSON.parse(json);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
  const format = String((j.format || {}).format_name || "");
  let container = null;
  for (const [re, name] of CONTAINERS) if (re.test(format)) { container = name; break; }
  return {
    container,
    // where the file's clock begins (format start_time): the offset copy
    // jobs' -copyts clock carries it, routes/torrent.js takes it back out
    start: parseFloat((j.format || {}).start_time) || 0,
    video: v
      ? {
          codec: v.codec_name === "mpeg2video" ? "mpeg2" : v.codec_name,
          bitDepth: BIT10.test(String(v.pix_fmt || "")) ? 10 : 8,
        }
      : null,
    // index = the stream's position among the AUDIO streams (what ffmpeg's
    // -map 0:a:N counts), with its language and title tags — the player's
    // audio menu for a multi-dub release
    audioStreams: streams
      .filter((s) => s.codec_type === "audio")
      .map((s, i) => ({
        index: i,
        codec: s.codec_name,
        channels: s.channels || 2,
        language: (s.tags && s.tags.language) || null,
        title: (s.tags && s.tags.title) || null,
        // the audio menu's name for it (media/subnames.js, as for the library)
        label: require("./subnames").audioName({ language: s.tags && s.tags.language, title: s.tags && s.tags.title, commentary: !!(s.disposition && s.disposition.comment) }, i).label,
      })),
  };
};

// Probe a torrent file's head. `readyFile` is an async () => ready check the
// caller provides (routes/torrent.js passes readyTorrent+pickVideoFile) so
// this module stays free of torrent lifecycle knowledge.
const probe = (infoHash, fileIdx) => {
  const key = `${infoHash}:${fileIdx}`;
  if (results.has(key)) return Promise.resolve(results.get(key));
  if (Date.now() - (failures.get(key) || 0) < FAIL_TTL) {
    return Promise.reject(new Error("probe recently failed"));
  }
  let p = inflight.get(key);
  if (p) return p;
  p = new Promise((resolve, reject) => {
    if (!config.FFPROBE) return reject(new Error("ffprobe not available"));
    const url = `http://127.0.0.1:${config.PORT}/stream/torrent/${infoHash}/${fileIdx}`;
    const proc = spawn(
      config.FFPROBE,
      [
        "-v", "error",
        // Enough for any sane container header, small enough to answer in
        // seconds on a stream whose head pieces are being fetched anyway.
        "-probesize", "16M",
        "-analyzeduration", "10M", // microseconds: 10s of content max
        "-print_format", "json",
        "-show_streams", "-show_format",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, PROBE_TIMEOUT_MS);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out) {
        return reject(new Error(`ffprobe exited ${code}: ${err.slice(-200)}`));
      }
      try {
        const r = parse(out);
        results.set(key, r);
        resolve(r);
      } catch (e) {
        reject(e);
      }
    });
  });
  inflight.set(key, p);
  const done = () => inflight.delete(key);
  p.then(done, done);
  p.catch(() => {
    if (failures.size > 500) failures.clear();
    failures.set(key, Date.now());
  });
  return p;
};

// Start position of a finished HLS segment: the MAX of its streams' start
// times. For a `-copyts` offset-copy job (S3) the media timeline IS content
// time — video begins at the keyframe at/below the requested second while
// audio begins exactly AT it (measured: -ss 100 → video 93.75, audio 99.97) —
// so playback must start at the later of the two or the viewer gets seconds
// of silent video lead. Cached per file path: segments are immutable.
// Two numbers describe the timeline (measured 2026-08-26, and hls.js's
// rebasing is why both are needed): hls.js maps media time 0 to the
// segment's MINIMUM stream PTS (the video keyframe at/below the requested
// second), so `base` anchors the clock (content = base + currentTime), and
// `offset` = maxStart - minStart is where playback should BEGIN within the
// rebased timeline (the audio's exact start — skipping the video-only
// keyframe pre-roll). Native HLS players don't rebase (raw PTS clock), so
// they use base 0 and read EXT-X-START, which is playlist-relative = offset.
const segStarts = new Map();
const segmentStart = (file) => {
  if (segStarts.has(file)) return Promise.resolve(segStarts.get(file));
  return new Promise((resolve) => {
    if (!config.FFPROBE) return resolve(null);
    const proc = spawn(
      config.FFPROBE,
      ["-v", "error", "-show_entries", "stream=start_time", "-of", "csv=p=0", file],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 8000);
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const starts = out.split(/\r?\n/).map(parseFloat).filter((n) => isFinite(n));
      if (!starts.length) return resolve(null);
      const r = {
        base: Math.min(...starts),
        offset: Math.max(0, Math.max(...starts) - Math.min(...starts)),
      };
      segStarts.set(file, r);
      if (segStarts.size > 500) segStarts.clear();
      resolve(r);
    });
  });
};

// ---------- the fMP4 (iPhone) copy job's clock ----------
// An fMP4 copy job at an offset does NOT keep the source's timestamps (Apple's
// player chokes on them — remux.js): ffmpeg starts it at the keyframe at or
// before the asked second and its clock at ~0 there. The player assumed media
// 0 = the asked second, so on an iPhone every cue and the scrubber ran up to a
// keyframe interval AHEAD after a resume or a far seek (measured with
// tools/subs-rig: 5.1 s at ss=20 on a 5 s GOP; real HEVC releases use 10 s).
// The truth is told from two reads: where that keyframe is in the source (the
// demuxer's packet flags — no decoding), and where the job's first video
// frame sits on its own clock (init + first fragment, read as one file).

const run = (args, ms = 8000) =>
  new Promise((resolve) => {
    if (!config.FFPROBE) return resolve(null);
    const proc = spawn(config.FFPROBE, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => { if (out.length < 200000) out += d; });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, ms);
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
    proc.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });

// The source time of the last video keyframe at or before `ss`, or null.
const keyframeAtOrBefore = async (file, ss) => {
  const from = Math.max(0, ss - 60);
  const out = await run(["-v", "error", "-select_streams", "v:0", "-read_intervals", `${from}%${ss + 0.5}`,
    "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file]);
  if (!out) return null;
  let best = null;
  for (const line of out.split(/\r?\n/)) {
    const [t, flags] = line.split(",");
    const v = parseFloat(t);
    if (isFinite(v) && /K/.test(flags || "") && v <= ss + 0.001 && (best == null || v > best)) best = v;
  }
  return best;
};

// The first video frame's time on an fMP4 job's own clock (init.mp4 + the
// first fragment, read back to back).
const fmp4FirstVideo = async (dir) => {
  const fs = require("fs");
  const path = require("path");
  const init = path.join(dir, "init.mp4");
  const seg = path.join(dir, "seg00000.m4s");
  // (the playlist can be answered a moment before the first fragment is on
  // disk under its final name — seen once on a cold start: a short wait)
  for (let i = 0; i < 6 && !(fs.existsSync(init) && fs.existsSync(seg)); i++) await new Promise((r) => setTimeout(r, 250));
  if (!fs.existsSync(init) || !fs.existsSync(seg)) return null;
  const out = await run(["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
    "-show_entries", "packet=pts_time", "-of", "csv=p=0", `concat:${init.replace(/\\/g, "/")}|${seg.replace(/\\/g, "/")}`]);
  const v = out ? parseFloat(out.split(/\r?\n/)[0]) : NaN;
  return isFinite(v) ? v : null;
};

// Content time at media position 0 of an fMP4 copy job at `ss` (the file's
// start time taken out, as for the TS jobs), or null when it cannot be told.
//
// WHICH keyframe ffmpeg lands on is its own rule (fftools ffmpeg_demux.c,
// ffmpeg 6): the asked second plus the file's start time, and — for a
// container that does not seek by PTS (Matroska; MP4/MOV do) with a video
// stream that reorders frames (B-frames) — 3/23 s earlier still; then the
// keyframe at or before that. Measured on the rig's MKV: asked 20, keyframes
// every 5 s, it begins at 15, not 20.
const hasBFrames = async (file) => {
  const out = await run(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=has_b_frames", "-of", "csv=p=0", file]);
  return !!out && parseInt(out, 10) > 0;
};
const fmp4ClockBase = async (file, dir, ss, fileStart = 0) => {
  const seeksByPts = /\.(mp4|m4v|mov)$/i.test(file);
  const delay = !seeksByPts && (await hasBFrames(file)) ? 3 / 23 : 0;
  const target = ss + (Number(fileStart) > 0 ? Number(fileStart) : 0) - delay;
  const [kf, first] = await Promise.all([keyframeAtOrBefore(file, target), fmp4FirstVideo(dir)]);
  if (kf == null || first == null) return null;
  const base = clockBase(kf - first, fileStart);
  return base <= ss + 1 && base >= ss - 60 ? base : null;
};

// The X-Aurora-Base a copy job's player is told: the segment's first
// timestamp, less the file's own start time (only a positive one — the few
// milliseconds below zero some files report are below what anyone sees).
const clockBase = (segBase, fileStart) => {
  const st = Number(fileStart) > 0 ? Number(fileStart) : 0;
  return Math.round((segBase - st) * 1000) / 1000;
};

// A probe already answered for this file, or null (never starts one).
const cached = (infoHash, fileIdx) => results.get(`${String(infoHash).toLowerCase()}:${fileIdx}`) || null;

module.exports = { probe, segmentStart, cached, clockBase, fmp4ClockBase, keyframeAtOrBefore, _parse: parse };
