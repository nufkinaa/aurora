// The quality ladder: one HLS MASTER playlist over the jit full-timeline
// stream (jit.js), so the player itself moves between renditions — up and
// down, at a segment boundary, with no rebuild.
//
// Every rendition is cut by the SAME segment table (the file's own keyframe
// index): the top one is the file's video as it is (a copy) or, for a device
// that cannot decode that codec, a full H.264 encode; below it come 720p and
// 480p encodes — only heights BELOW the top one, never an upscale. An encoded
// rendition is made by the same producer as the copy, with the encoder forced
// to put a keyframe on every keyframe of the source (`-force_key_frames
// source`) and to keep every frame's own timestamp (`-fps_mode passthrough`,
// `-enc_time_base -1`). So jit's rule — one file per GOP, grouped by measured
// start time, every declared boundary checked — holds for it unchanged, and
// segment k of any rendition holds the same frames of the film.
// Measured 2026-10-08 on Knives Out (HEVC) and Night Hunter (H.264, 60 fps):
// GOP starts and frame counts identical between the copy and a 480p encode.
//
// Nothing here runs unless a client asks for the master playlist. A rendition
// nobody plays is never produced; one that is left is stopped (jit parks an
// encoder that has run far ahead of its reader) and reaped when idle.
//
// This module is the arithmetic and the text: which rungs, what each one
// costs on the wire, the playlist, the encoder's arguments. The producing,
// the grouping and the checking are jit.js.
const os = require("os");
const { execFile } = require("child_process");
const config = require("../config");
const tonemap = require("./tonemap");

// The capped renditions: the SAME heights and ceilings the single-rendition
// capped streams use (remux.js CAPS — "h264-720" / "h264-480"), in kbit/s.
const CAPS = {
  "h264-720": { h: 720, maxrate: 2200, bufsize: 4400, audio: 128 },
  "h264-480": { h: 480, maxrate: 1000, bufsize: 2000, audio: 96 },
};
// The full encode ("h264": the top rung where the device cannot decode the
// file). crf 18 like the single-rendition encode, but under a ceiling chosen
// by its height — without one its bitrate is whatever the film needs, and a
// BANDWIDTH could not be stated honestly.
const TOP_AUDIO = 192;
const topCeiling = (outH) => (outH > 720 ? 10000 : outH > 480 ? 5000 : 2500);

// A segment is at least this long (jit's table rule; only the last one may be
// shorter), which bounds how far a rate-controlled stream can exceed its
// ceiling over one segment: maxrate + bufsize / duration.
const SEG_MIN_SEC = 6;
// What is served weighs more than the streams' nominal rates. Measured on
// produced segments of three films, 2026-10-08:
//  • a copy: 1% over the bytes the file holds for the same stretch (which
//    already include the file's own audio and subtitles) — 8% is allowed;
//  • an encode: the container (MPEG-TS packet and PES headers, PAT/PMT at
//    every GOP) plus how far superfast's single-pass rate control runs over
//    its ceiling. Means over 30 consecutive segments came to 1214–1255 kbit/s
//    for the 480p rung (ceiling 1000 + 96 audio: +11…15%) and 2468–2510 for
//    720p (2200 + 128: +6…8%). 16% covers every one of them.
const MUX_OVERHEAD = 1.08;
const ENC_OVERHEAD = 1.16;

// libx264 threads for a ladder encode: half the machine. Two may run at once
// (jit's cap), and the server still has to serve everyone else.
const ENC_THREADS = Math.max(2, Math.floor(os.cpus().length / 2));

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// The picture size a rendition comes out at (what its scale filter produces).
const dimsFor = (name, width, height) => {
  if (!(width > 0 && height > 0)) return null;
  if (name === "copy") return { w: width, h: height };
  const cap = CAPS[name];
  if (cap) {
    const h = Math.min(cap.h, height);
    return { w: even((width * h) / height), h: h === height ? even(height) : h };
  }
  // "h264": anything wider than 1920 is folded down, nothing is upscaled
  const w = Math.min(1920, width);
  return { w: w === width ? even(width) : w, h: even((height * w) / width) };
};
// The scale filter itself — the same expressions remux.js uses.
const scaleFor = (name) => (CAPS[name] ? `scale=-2:min(${CAPS[name].h}\\,ih)` : "scale=min(1920\\,iw):-2");

// Rate figures of an encoded rendition, kbit/s.
const rateFor = (name, outH) => {
  const cap = CAPS[name];
  if (cap) return { maxrate: cap.maxrate, bufsize: cap.bufsize, audio: cap.audio };
  const max = topCeiling(outH);
  return { maxrate: max, bufsize: max * 2, audio: TOP_AUDIO };
};

// Which renditions a title gets, top first. `top`: "copy" (the device decodes
// the file's codec) or "h264". `maxHeight` (a data-saver client): nothing
// taller than that — and if that leaves nothing, the smallest there is.
const rungNames = ({ width, height, top = "copy", maxHeight = 0 }) => {
  const first = top === "h264" ? "h264" : "copy";
  const topDims = dimsFor(first, width, height);
  if (!topDims) return [first]; // size unknown: no honest lower rung can be named
  const names = [first, ...Object.keys(CAPS).filter((n) => CAPS[n].h < topDims.h)];
  if (!(maxHeight > 0)) return names;
  const fits = names.filter((n) => dimsFor(n, width, height).h <= maxHeight);
  return fits.length ? fits : [names[names.length - 1]];
};

// ---------- CODECS ----------
// H.264 levels: [level_idc, MaxMBPS, MaxFS, MaxBR (kbit/s, High profile), MaxDpbMbs]
const H264_LEVELS = [
  [30, 40500, 1620, 12500, 8100],
  [31, 108000, 3600, 17500, 18000],
  [32, 216000, 5120, 25000, 20480],
  [40, 245760, 8192, 25000, 32768],
  [41, 245760, 8192, 62500, 32768],
  [42, 522240, 8704, 62500, 34816],
  [50, 589824, 22080, 168750, 110400],
  [51, 983040, 36864, 300000, 184320],
  [52, 2073600, 36864, 300000, 184320],
];
const DPB_FRAMES = 4; // superfast: 1 reference + the B-frame reorder depth
// The lowest level that holds this picture at this rate. The encoder is TOLD
// this level, so the playlist's CODECS is what the stream says of itself.
const h264Level = (w, h, fps, maxrateK) => {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const rate = fps > 0 ? fps : 30;
  for (const [idc, mbps, fs, br, dpb] of H264_LEVELS) {
    if (mbs <= fs && mbs * rate <= mbps && maxrateK <= br && mbs * DPB_FRAMES <= dpb) return idc;
  }
  return 52;
};
const hex2 = (n) => n.toString(16).padStart(2, "0");
const AAC = "mp4a.40.2";
const encCodecs = (levelIdc) => `avc1.6400${hex2(levelIdc)},${AAC}`;

// The file's own video, as an RFC 6381 string — or null when it cannot be
// said for certain (the attribute is then left out rather than guessed).
const H264_PROFILES = { "constrained baseline": "42e0", baseline: "4200", main: "4d00", extended: "5800", high: "6400", "high 10": "6e00", "high 4:2:2": "7a00", "high 4:4:4 predictive": "f400" };
const HEVC_PROFILES = { main: "1.6", "main 10": "2.4" };
const copyCodecs = (f) => {
  if (!f || !(f.level > 0)) return null;
  const profile = String(f.profile || "").toLowerCase();
  if (f.codec === "h264" && H264_PROFILES[profile]) return `avc1.${H264_PROFILES[profile]}${hex2(f.level)},${AAC}`;
  if (f.codec === "hevc" && HEVC_PROFILES[profile]) return `hvc1.${HEVC_PROFILES[profile]}.L${f.level}.B0,${AAC}`;
  return null;
};

// ---------- BANDWIDTH ----------
// An encoded rendition: its rate control's own bound. Over a window of T
// seconds a VBV-constrained stream carries at most maxrate*T + bufsize bits,
// so the worst segment (T >= 6s) peaks at maxrate + bufsize/6; plus the
// audio, plus the container. AVERAGE is the ceiling itself.
const encBandwidth = (r) => ({
  peak: Math.ceil((r.maxrate + r.bufsize / SEG_MIN_SEC + r.audio) * 1000 * ENC_OVERHEAD),
  avg: Math.ceil((r.maxrate + r.audio) * 1000 * ENC_OVERHEAD),
});
// The copy: read off the file. `rate` is what jit measured from the keyframe
// index — the bytes the file holds between two segment boundaries, over the
// time between them: the busiest segment (peak) and the whole film (avg).
// Those bytes are the video plus everything else in the file (its own audio
// tracks, subtitles), so they overstate the video a little; the audio we send
// (192k AAC) and the container are added on top. An upper bound, as the
// attribute is defined. null when the index gave no figure.
const copyBandwidth = (rate) =>
  rate && rate.peak > 0 && rate.avg > 0
    ? {
        peak: Math.ceil((rate.peak + TOP_AUDIO * 1000) * MUX_OVERHEAD),
        avg: Math.ceil((rate.avg + TOP_AUDIO * 1000) * MUX_OVERHEAD),
      }
    : null;

// ---------- the rungs, described ----------
// facts: what probe() returned (or null). rate: jit's entry.rate (or null).
// Returns [{ name, w, h, bandwidth, average, codecs, fps, level }] — a rung
// whose numbers cannot be stated honestly is not offered: without the picture
// size there are no encoded rungs, without a rate for the copy there is no
// ladder at all (an ABR player would be choosing blind).
const describe = ({ facts, rate, top = "copy", maxHeight = 0, lower = true, anyRate = false }) => {
  const width = facts ? facts.width : 0;
  const height = facts ? facts.height : 0;
  const fps = facts && facts.fps > 0 ? facts.fps : 0;
  const out = [];
  const first = top === "h264" ? "h264" : "copy";
  for (const name of rungNames({ width, height, top, maxHeight })) {
    const d = dimsFor(name, width, height);
    if (name === "copy") {
      const bw = anyRate ? { peak: 0, avg: 0 } : copyBandwidth(rate);
      if (!bw) return [];
      out.push({ name, w: d ? d.w : 0, h: d ? d.h : 0, bandwidth: bw.peak, average: bw.avg, codecs: copyCodecs(facts), fps, level: null });
      continue;
    }
    // the top encode is the title itself for its device: no size, no ladder.
    // The rungs under the top are offered only while `lower` says so.
    if (!d) { if (name === first) return []; continue; }
    if (name !== first && !lower) continue;
    const r = rateFor(name, d.h);
    const level = h264Level(d.w, d.h, fps, r.maxrate);
    const bw = encBandwidth(r);
    out.push({ name, w: d.w, h: d.h, bandwidth: bw.peak, average: bw.avg, codecs: encCodecs(level), fps, level });
  }
  // A smaller picture that costs MORE than the file itself is not a rung (a
  // lean source: its own peak is under the encode's ceiling). The ladder
  // must go down in BANDWIDTH as it goes down in size.
  if (!anyRate && out.length && out[0].name === "copy") {
    return out.filter((r) => r.name === "copy" || r.bandwidth < out[0].bandwidth);
  }
  return out;
};

// The master playlist. `query(name)` gives the variant's query string (the
// routes own the parameter names). fMP4 needs version 7 like its media
// playlists.
const masterText = (rungs, query, fmt) => {
  const lines = ["#EXTM3U", `#EXT-X-VERSION:${fmt === "fmp4" ? 7 : 3}`, "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (const r of rungs) {
    const attrs = [`BANDWIDTH=${r.bandwidth}`, `AVERAGE-BANDWIDTH=${r.average}`];
    if (r.w > 0 && r.h > 0) attrs.push(`RESOLUTION=${r.w}x${r.h}`);
    if (r.fps > 0) attrs.push(`FRAME-RATE=${r.fps.toFixed(3)}`);
    if (r.codecs) attrs.push(`CODECS="${r.codecs}"`);
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`);
    lines.push(`index.m3u8${query(r.name)}`);
  }
  return lines.join("\n") + "\n";
};

// ---------- the encoder's arguments ----------
// For jit's producer, in place of "-c:v copy". `vf`: the whole filter chain
// when the source is HDR and gets tone-mapped (tonemap.js), else null and the
// rendition's own scale is used.
const encVideoArgs = (rung, { vf = null, fmt = null } = {}) => {
  const r = rateFor(rung.name, rung.h);
  return [
    "-c:v", "libx264",
    // the same picture the single-rendition encode makes (remux.js)
    "-preset", "superfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level:v", (rung.level / 10).toFixed(1),
    "-threads", String(ENC_THREADS),
    // A keyframe exactly where the SOURCE has one — nowhere is a boundary
    // decided here; jit groups and checks the result against the table. The
    // -g is only a backstop for a source with no keyframe for 600 frames.
    "-g", "600",
    "-force_key_frames", "source",
    "-forced-idr", "1",
    // Every frame keeps its own timestamp, in the source's time base: no
    // frame is dropped or duplicated to fit a rate, no time is rounded to a
    // frame grid (measured: without these the boundaries drift by up to
    // 0.4 ms and a gap in the source is filled with duplicates).
    "-fps_mode", "passthrough",
    "-enc_time_base", "-1",
    "-vf", vf || scaleFor(rung.name),
    "-maxrate", `${r.maxrate}k`,
    "-bufsize", `${r.bufsize}k`,
    ...(fmt === "fmp4"
      ? [
          // fMP4: the init segment is written before the first frame is
          // encoded, so the parameter sets must be in the encoder's header,
          // not in-band.
          "-flags:v", "+global_header",
          // …and every packet's duration is made the REAL step to the next
          // one. The MP4 muxer starts each fragment where the previous one's
          // last duration says it ended. The encoder's nominal frame
          // duration (16.667 ms, rounded to 17) is not always the real step
          // (16 or 17 ms — the source's millisecond timestamps): when it is
          // longer the muxer "repairs" the next keyframe by throwing its PTS
          // away, and when shorter it moves that PTS by the difference —
          // measured: a segment's first keyframe shown two frames early.
          // With exact durations there is nothing to repair. (The copy has
          // the mild form only: its durations are rounded DOWN, so a
          // boundary lands at most 1 ms early.)
          "-bsf:v", "setts=pts=PTS:dts=DTS:duration=if(eq(NEXT_DTS\\,NOPTS)\\,DURATION\\,NEXT_DTS-DTS)",
        ]
      : []),
  ];
};

// ---------- what a source is ----------
// One ffprobe of the first video stream: size, frame rate, profile and level
// (for CODECS), and the colour facts tone mapping decides from. Cached — a
// file's video does not change (the key carries its mtime).
const PROBE_ARGS = [
  "-v", "error",
  "-select_streams", "v:0",
  "-show_entries",
  "stream=codec_type,codec_name,profile,level,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,avg_frame_rate,r_frame_rate:stream_side_data=side_data_type,dv_profile,dv_bl_signal_compatibility_id",
  "-of", "json",
];
const parseFacts = (json) => {
  let j;
  try { j = typeof json === "string" ? JSON.parse(json) : json; } catch { return null; }
  const f = tonemap.parseProbe(j);
  if (!f) return null;
  const s = ((j && j.streams) || []).find((x) => !x.codec_type || x.codec_type === "video") || {};
  f.profile = s.profile || null;
  f.level = Number.isFinite(s.level) && s.level > 0 ? s.level : null;
  return f;
};
const facts = new Map(); // key -> facts
const failed = new Map(); // key -> failedAt
const inflight = new Map();
const FAIL_TTL = 60 * 1000;
const probe = (key, input, { http = false } = {}) => {
  if (facts.has(key)) return Promise.resolve(facts.get(key));
  if (!config.FFPROBE || Date.now() - (failed.get(key) || 0) < FAIL_TTL) return Promise.resolve(null);
  let p = inflight.get(key);
  if (p) return p;
  p = new Promise((resolve) => {
    execFile(
      config.FFPROBE,
      [...PROBE_ARGS, ...(http ? ["-probesize", "16M", "-analyzeduration", "10M"] : []), input],
      { windowsHide: true, timeout: http ? 8000 : 5000, maxBuffer: 1024 * 1024 },
      (err, out) => resolve(err ? null : parseFacts(String(out || ""))),
    );
  }).then((f) => {
    inflight.delete(key);
    if (f) {
      if (facts.size > 500) facts.clear();
      facts.set(key, f);
    } else {
      if (failed.size > 500) failed.clear();
      failed.set(key, Date.now());
    }
    return f;
  });
  inflight.set(key, p);
  return p;
};

// The whole of an encoded rendition's side of a producer input: { name,
// essential, videoArgs, audioRate, onExit }. Async only for an HDR source
// (the tone-map support check runs once per process). `busy`: another encode
// is already running — tone mapping then demands twice the headroom.
const encFor = async (rung, f, { fmt = null, busy = false, label = "" } = {}) => {
  let vf = null;
  if (f && tonemap.enabled() && tonemap.isHdr(f)) {
    await tonemap.probeSupport();
    vf = tonemap.vfFor(f, { scale: scaleFor(rung.name), outHeight: CAPS[rung.name] ? CAPS[rung.name].h : 0, busy, label });
  }
  return {
    name: rung.name,
    // the top rung of a device that cannot play the file any other way; the
    // rungs below a copy are a courtesy to a slow line (jit's cap treats
    // them differently)
    essential: rung.name === "h264",
    videoArgs: encVideoArgs(rung, { vf, fmt }),
    audioRate: `${rateFor(rung.name, rung.h).audio}k`,
    // a tone-mapped producer that died in its filters: plain encode from now on
    onExit: vf ? (code, stderr) => { if (code) tonemap.veto(f, stderr); } : null,
  };
};

// The master playlist for one source, from a request's query — the part the
// library and the torrent routes share.
//   ?top=copy|h264   the top rung: the file's video as it is (default), or the
//                    full encode for a device that cannot decode its codec
//   ?max=<height>    nothing taller than this (a data-saver client)
//   ?seg=fmp4        fragmented-MP4 segments in every rendition (Apple)
//   ?vtag=hvc1       the hvc1 sample tag on a copied HEVC rendition (Apple)
//   ?a=<n>           the file's n-th audio track, in every rendition
// Resolves { text } or { status, message }: 503 = no encoder is free for a
// ladder that needs one (try the single-rendition URL), 404 = no honest
// ladder can be stated for this source.
const master = async (entry, { key, input, http = false, query = {}, jit }) => {
  const fmt = query.seg === "fmp4" ? "fmp4" : null;
  const audio = audioFromQuery(query.a);
  const top = query.top === "h264" ? "h264" : "copy";
  const maxHeight = Math.max(0, parseInt(query.max, 10) || 0);
  const f = await probe(key, input, { http });
  const encodable = !!config.FFMPEG && !jit.encodeDeclined(key);
  if (top === "h264" && (!encodable || !jit.encodeRoom(key, true))) {
    return { status: encodable ? 503 : 404, message: encodable ? "Server is busy transcoding other streams" : "This file cannot be re-encoded on the full timeline" };
  }
  const lower = encodable && jit.encodeRoom(key, false);
  const rungs = describe({ facts: f, rate: entry.rate, top, maxHeight, lower });
  if (!rungs.length) {
    return maxHeight > 0 && encodable && !lower
      ? { status: 503, message: "Server is busy — the lighter streams aren't available right now" }
      : { status: 404, message: "No quality ladder for this file" };
  }
  const q = (name) =>
    `?v=${name}${fmt ? "&seg=fmp4" : ""}${name === "copy" && query.vtag === "hvc1" ? "&vtag=hvc1" : ""}${audio ? `&a=${audio}` : ""}`;
  return { text: masterText(rungs, q, fmt), rungs };
};

// The producer input of one ENCODED rendition (for a segment or init
// request): `base` is the copy's input ({ url, extra }), the rest is added.
// Resolves null when the rendition cannot be described (the probe failed) —
// the caller answers 404.
const encInput = async (base, { key, name, top, fmt, audio, http = false, jit, label = "" }) => {
  const f = await probe(key, base.url, { http });
  const rung = describe({ facts: f, top: name === "h264" ? "h264" : top || "copy", lower: true, anyRate: true }).find((r) => r.name === name);
  if (!rung) return null;
  const enc = await encFor(rung, f, { fmt, busy: jit.encodeCount() > 0, label });
  return { ...base, fmt, audio, vtagHvc1: false, enc };
};

// The jit cache dir of one rendition of one source. The copy with the first
// audio track keeps the names it always had (`key`, `key-f4`).
const dirName = (key, name, fmt, audio) =>
  key + (name && name !== "copy" ? `-${name}` : "") + (fmt === "fmp4" ? "-f4" : "") + (audio > 0 ? `-a${audio}` : "");

// What ?v= may name on a jit URL. Anything else is the copy, as before.
const renditionFromQuery = (v) => (v === "h264" || CAPS[v] ? v : "copy");
const audioFromQuery = (a) => Math.max(0, Math.min(31, parseInt(a, 10) || 0));

module.exports = {
  master,
  encInput,
  describe,
  masterText,
  probe,
  encFor,
  dirName,
  renditionFromQuery,
  audioFromQuery,
  _internals: {
    CAPS, dimsFor, scaleFor, rateFor, rungNames, h264Level, encCodecs, copyCodecs,
    encBandwidth, copyBandwidth, encVideoArgs, parseFacts, topCeiling,
    SEG_MIN_SEC, MUX_OVERHEAD, ENC_OVERHEAD, ENC_THREADS,
  },
};
