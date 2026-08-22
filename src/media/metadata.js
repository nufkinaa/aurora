// ffprobe metadata with a persistent cache (keyed by path + mtime).
// One probe per file yields duration, resolution, and subtitle streams.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
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
const PROBE_VERSION = 3;

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

  const result = {
    v: PROBE_VERSION,
    mtime,
    duration: 0,
    width: 0,
    height: 0,
    video: null,
    audioStreams: [],
    subtitleStreams: [],
  };

  try {
    const out = execFileSync(
      config.FFPROBE,
      [
        "-v", "quiet",
        "-show_entries",
        "format=duration:stream=index,codec_type,codec_name,channels,width,height,pix_fmt:stream_tags=language,title",
        "-of", "json",
        videoPath,
      ],
      { encoding: "utf-8", timeout: 15000 }
    );
    const data = JSON.parse(out);
    result.duration = parseFloat(data.format?.duration) || 0;

    let subIdx = 0;
    for (const s of data.streams || []) {
      if (s.codec_type === "video" && !result.video) {
        result.width = s.width || 0;
        result.height = s.height || 0;
        // Video codec + bit depth: HEVC/AV1/10-bit play on TVs but not on most
        // phones/desktops. Decodability is decided client-side (canPlayType) —
        // the same file direct-plays on one device and transcodes on another.
        const depth = /(\d+)(?:le|be)$/.exec(s.pix_fmt || "");
        result.video = {
          codec: s.codec_name || null,
          bitDepth: depth ? parseInt(depth[1], 10) : 8,
        };
      } else if (s.codec_type === "audio") {
        result.audioStreams.push({
          codec: s.codec_name,
          channels: s.channels || 2,
          compatible: BROWSER_AUDIO_CODECS.has(s.codec_name),
        });
      } else if (s.codec_type === "subtitle") {
        result.subtitleStreams.push({
          index: subIdx++,
          codec: s.codec_name,
          text: TEXT_SUBTITLE_CODECS.has(s.codec_name),
          language: s.tags?.language || null,
          title: s.tags?.title || null,
        });
      }
    }
  } catch {
    // Unprobeable file - cache the empty result so we don't retry every scan
  }

  store.data[videoPath] = result;
  store.save();
  return result;
};

const getCached = (videoPath) => store.data[videoPath] || null;

// True when the file has no up-to-date probe result (used by the enricher)
const needsProbe = (videoPath) => {
  const entry = store.data[videoPath];
  return !entry || entry.v !== PROBE_VERSION;
};

const clearCache = () => {
  store.data = {};
  store.flush();
};

module.exports = { probe, getCached, needsProbe, clearCache, TEXT_SUBTITLE_CODECS };
