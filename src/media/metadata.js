// ffprobe metadata with a persistent cache (keyed by path + mtime).
// One probe per file yields duration, resolution, and subtitle streams.
const fs = require("fs");
const path = require("path");
const { execFileSync, execFile } = require("child_process");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "metadata-cache.json"), {});

// Embedded subtitle codecs ffmpeg can convert to WebVTT text. Bitmap formats
// (dvd_subtitle, hdmv_pgs_subtitle...) need OCR - browsers can't render them.
const TEXT_SUBTITLE_CODECS = new Set([
  "subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text",
]);

// Audio codecs browsers decode natively. AC-3/E-AC-3/DTS play on TVs and in
// VLC but are SILENT in desktop Chrome - those need the compat remux.
const BROWSER_AUDIO_CODECS = new Set([
  "aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le",
]);

// Bump when the probe result shape changes so old cache entries re-probe
// 6: stream dispositions (forced / hearing impaired / commentary — the track
//    names), the file's start time and the video frame rate (subtitle timing)
const PROBE_VERSION = 6;

// What ffprobe is asked, and the empty answer a file that cannot be read gets.
const probeArgs = (videoPath) => [
  "-v", "quiet",
  "-show_entries",
  "format=duration,start_time:stream=index,codec_type,codec_name,profile,channels,channel_layout,width,height,pix_fmt,color_transfer,color_primaries,r_frame_rate,avg_frame_rate:stream_tags=language,title,handler_name:stream_disposition=default,forced,hearing_impaired,visual_impaired,comment:stream_side_data=side_data_type",
  "-of", "json",
  videoPath,
];
const blankResult = (mtime) => ({
  v: PROBE_VERSION,
  mtime,
  duration: 0,
  start: 0,
  width: 0,
  height: 0,
  video: null,
  audioStreams: [],
  subtitleStreams: [],
});

// "24000/1001" -> 23.976
const frameRate = (r) => {
  const m = /^(\d+)\/(\d+)$/.exec(String(r || ""));
  if (!m || !+m[2]) return 0;
  const f = +m[1] / +m[2];
  return f > 1 && f < 300 ? Math.round(f * 1000) / 1000 : 0;
};
// A stream's title. MP4s name every track in handler_name, which is nearly
// always boilerplate ("SoundHandler", "SubtitleHandler", "Core Media Text")
// and only sometimes a real name ("English SDH") — the boilerplate is dropped.
const HANDLER_BOILERPLATE = /^(?:sound|video|subtitle|text|timed ?text|closed caption|hint|gpac|apple|mainconcept|isomedia|core media|l-smash)\b.*(?:handler|media|text|caption)?$|handler$/i;
const titleOf = (s) => {
  if (s.tags?.title) return s.tags.title;
  const h = s.tags?.handler_name;
  return h && !HANDLER_BOILERPLATE.test(String(h).trim()) ? String(h).trim() : null;
};

// ffprobe's JSON -> the fields of `result`. Throws on output that is not
// JSON; whatever was filled in before the throw stays, as it always did.
const fillFromProbe = (result, out) => {
  const data = JSON.parse(out);
  result.duration = parseFloat(data.format?.duration) || 0;
  // Where the file's clock begins. Nearly always 0 (or a few ms either way);
  // a cut from a TV capture can start seconds in, and the offset copy jobs
  // (-copyts) carry that into the player's clock — see routes/stream.js.
  result.start = parseFloat(data.format?.start_time) || 0;

  let subIdx = 0;
  for (const s of data.streams || []) {
    if (s.codec_type === "video" && !result.video) {
      result.width = s.width || 0;
      result.height = s.height || 0;
      // Video codec + bit depth: HEVC/AV1/10-bit play on TVs but not on most
      // phones/desktops. Decodability is decided client-side (canPlayType) —
      // the same file direct-plays on one device and transcodes on another.
      const depth = /(\d+)(?:le|be)$/.exec(s.pix_fmt || "");
      // HDR flavour, for the format badges: Dolby Vision rides as side
      // data (a DOVI configuration record), HDR10 / HLG as the transfer
      // characteristic. Text for the UI, never a logo.
      const side = (s.side_data_list || []).map((d) => String(d.side_data_type || "").toLowerCase());
      const dv = side.some((t) => t.includes("dovi") || t.includes("dolby vision"));
      const transfer = String(s.color_transfer || "").toLowerCase();
      const hdr = dv ? "dolby-vision" : transfer === "smpte2084" ? "hdr10" : transfer === "arib-std-b67" ? "hlg" : null;
      result.video = {
        codec: s.codec_name || null,
        bitDepth: depth ? parseInt(depth[1], 10) : 8,
        hdr,
        // frames a second (23.976, 25…): a subtitle timed for another rate
        // drifts, and providers say which rate theirs was timed for
        fps: frameRate(s.avg_frame_rate) || frameRate(s.r_frame_rate) || null,
      };
    } else if (s.codec_type === "audio") {
      // ffprobe names Atmos in the PROFILE ("Dolby TrueHD + Dolby Atmos",
      // "Dolby Digital Plus + Dolby Atmos") and DTS:X the same way.
      const profile = String(s.profile || "");
      result.audioStreams.push({
        index: result.audioStreams.length,
        language: s.tags?.language || null,
        title: titleOf(s),
        commentary: !!s.disposition?.comment,
        codec: s.codec_name,
        channels: s.channels || 2,
        layout: s.channel_layout || null,
        profile: profile || null,
        atmos: /atmos/i.test(profile),
        dtsx: /dts:x|dts-x|dtsx/i.test(profile),
        compatible: BROWSER_AUDIO_CODECS.has(s.codec_name),
      });
    } else if (s.codec_type === "subtitle") {
      result.subtitleStreams.push({
        index: subIdx++,
        codec: s.codec_name,
        text: TEXT_SUBTITLE_CODECS.has(s.codec_name),
        language: s.tags?.language || null,
        title: titleOf(s),
        // what the file says about the track (the menu names it by these)
        forced: !!s.disposition?.forced,
        sdh: !!s.disposition?.hearing_impaired,
        commentary: !!s.disposition?.comment,
        default: !!s.disposition?.default,
      });
    }
  }
};

const probe = (videoPath) => {
  if (!config.ffmpegAvailable) return null;

  let mtime;
  try {
    mtime = fs.statSync(videoPath).mtimeMs;
  } catch {
    return null;
  }

  const cached = store.data[videoPath];
  if (cached && cached.mtime === mtime && cached.v === PROBE_VERSION) return cached;

  const result = blankResult(mtime);
  try {
    fillFromProbe(result, execFileSync(config.FFPROBE, probeArgs(videoPath), { encoding: "utf-8", timeout: 15000 }));
  } catch {
    // Unprobeable file - cache the empty result so we don't retry every scan
  }

  store.data[videoPath] = result;
  store.save();
  return result;
};

// The same probe without holding the event loop: ffprobe runs as a child the
// server WAITS for instead of one it blocks on. The library enricher uses
// this one — a blocking probe froze every request, picture and video segment
// for the length of each ffprobe run (160 ms a file on a two-core box, 300 new
// files = 48 s of freezes; docs/qa/backend-efficiency). Same question, same
// answer, same cache entry; a file is still probed one at a time.
const probeAsync = async (videoPath) => {
  if (!config.ffmpegAvailable) return null;

  let mtime;
  try {
    mtime = (await fs.promises.stat(videoPath)).mtimeMs;
  } catch {
    return null;
  }

  const cached = store.data[videoPath];
  if (cached && cached.mtime === mtime && cached.v === PROBE_VERSION) return cached;

  const result = blankResult(mtime);
  try {
    const out = await new Promise((resolve, reject) => {
      execFile(
        config.FFPROBE,
        probeArgs(videoPath),
        { encoding: "utf-8", timeout: 15000, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    fillFromProbe(result, out);
  } catch {
    // Unprobeable file - cache the empty result so we don't retry every scan
  }

  store.data[videoPath] = result;
  store.save();
  return result;
};

const getCached = (videoPath) => store.data[videoPath] || null;

// True when the file has no up-to-date probe result (used by the enricher).
// `mtime`: the file's date as the caller knows it (the library walk) — a file
// REPLACED under the same name (a better copy downloaded over it) has a new
// date, and its old probe (length, tracks, codecs) is no answer for it. It
// used to be kept for ever: only the probe version was compared.
const needsProbe = (videoPath, mtime = null) => {
  const entry = store.data[videoPath];
  if (!entry || entry.v !== PROBE_VERSION) return true;
  return mtime != null && entry.mtime !== mtime;
};

const clearCache = () => {
  store.data = {};
  store.flush();
};

module.exports = { probe, probeAsync, getCached, needsProbe, clearCache, TEXT_SUBTITLE_CODECS, _store: store };
