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
    video: v
      ? {
          codec: v.codec_name === "mpeg2video" ? "mpeg2" : v.codec_name,
          bitDepth: BIT10.test(String(v.pix_fmt || "")) ? 10 : 8,
        }
      : null,
    audioStreams: streams
      .filter((s) => s.codec_type === "audio")
      .map((s) => ({ codec: s.codec_name, channels: s.channels || 2 })),
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

module.exports = { probe, segmentStart };
