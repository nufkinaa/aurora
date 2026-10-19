// WHAT THIS BROWSER CAN PLAY, said to the server (TV round 2026-10-19 —
// the same report the TV app sends, so one table decides for both: parity).
//
// The browser is asked the questions the player already asks it — canPlayType
// per codec, profile and container (screens/player.js MIME) — plus the HDR it
// can decode (mediaCapabilities.decodingInfo) and the Dolby Vision profiles
// (Safari). The answer goes to POST /api/caps once per page load; the id that
// comes back rides on /api/item (?caps=, api.js), and the item then carries
// `play`: how the file plays HERE — as it is, the copy (picture copied, sound
// made AAC), or the encode (src/media/playpath.js). The player's own rules
// (startPlan) read it in place of their canPlayType guesses where it is there.
//
// A browser cannot switch the screen's refresh rate or pass Dolby / DTS sound
// to a receiver as it is: those two are TV-only (Settings → "On the TV").
// (the id itself lives in api.js — capsId / setCapsId — which puts it on the reads)
import { api, capsId, setCapsId } from "./api.js";

// The strings the player asks with (screens/player.js MIME), one per profile.
const VIDEO = {
  h264: { baseline: "avc1.42E01E", main: "avc1.4D401F", high: "avc1.640029", high10: "avc1.6E0029" },
  hevc: { main: "hvc1.1.6.L123.B0", main10: "hvc1.2.4.L123.B0" },
  av1: { main: "av01.0.08M.08" },
  vp9: { 0: "vp09.00.40.08", 2: "vp09.02.40.10" },
  vp8: { "": "vp8" },
};
const CONTAINERS = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime" };
const AUDIO = { aac: "mp4a.40.2", mp3: "mp4a.6B", opus: "opus", flac: "flac", vorbis: "vorbis", ac3: "ac-3", eac3: "ec-3", dts: "dtsc", truehd: "mlpa", alac: "alac" };
// what the server marks playable in any browser (media/metadata.js BROWSER_AUDIO_CODECS)
const ALWAYS_AUDIO = ["aac", "mp3", "opus", "vorbis", "flac", "pcm"];

/** The report, from a <video> element's answers. `nativeHls`: an iPhone, whose
 *  canPlayType says nothing about HEVC that every one of them decodes (the
 *  player's own rule, copyableFor). */
export const buildReport = (video, { nativeHls = false } = {}) => {
  const can = (type) => {
    try { return !!video.canPlayType(type); } catch { return false; }
  };
  const report = { client: "web", video: {}, hdr: [], dv: [], audio: { decode: [], passthrough: [] }, containers: {} };
  for (const [codec, profiles] of Object.entries(VIDEO)) {
    const ok = [];
    for (const [profile, str] of Object.entries(profiles)) {
      if (Object.values(CONTAINERS).some((c) => can(`${c}; codecs="${str}"`))) ok.push(profile);
    }
    if (codec === "hevc" && nativeHls) for (const p of ["main", "main10"]) if (!ok.includes(p)) ok.push(p);
    if (ok.length) report.video[codec] = { profiles: ok.filter(Boolean) };
  }
  for (const [name, type] of Object.entries(CONTAINERS)) {
    // a container opens a codec when the codec's first (plainest) profile plays in it
    report.containers[name] = Object.entries(VIDEO).filter(([, p]) => can(`${type}; codecs="${Object.values(p)[0]}"`)).map(([c]) => c);
  }
  const decode = new Set(ALWAYS_AUDIO);
  for (const [codec, mime] of Object.entries(AUDIO)) {
    if (can(`audio/mp4; codecs="${mime}"`) || can(`video/mp4; codecs="${mime}"`) || can(`audio/webm; codecs="${mime}"`)) decode.add(codec);
  }
  report.audio.decode = [...decode];
  if (can('video/mp4; codecs="dvh1.05.06"')) report.dv.push(5);
  if (can('video/mp4; codecs="dvh1.08.06"')) report.dv.push(8);
  if (report.dv.length) report.hdr.push("dv");
  return report;
};

// HDR the browser decodes (it tone maps on an SDR screen by itself)
const hdrOf = async () => {
  const out = [];
  const mc = navigator.mediaCapabilities;
  if (!mc || typeof mc.decodingInfo !== "function") return out;
  const ask = async (transferFunction, name) => {
    try {
      const r = await mc.decodingInfo({
        type: "file",
        video: { contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"', width: 3840, height: 2160, bitrate: 20000000, framerate: 24, transferFunction, colorGamut: "rec2020", ...(name === "hdr10" ? { hdrMetadataType: "smpteSt2086" } : {}) },
      });
      if (r && r.supported) out.push(name);
    } catch {}
  };
  await ask("pq", "hdr10");
  await ask("hlg", "hlg");
  return out;
};

let sent = null;
/** Say what this browser plays (once per page load); resolves to the id. */
export const reportCaps = () => {
  if (sent) return sent;
  sent = (async () => {
    try {
      const video = document.createElement("video");
      const nativeHls = /iPhone|iPod/.test(navigator.userAgent) && !!video.canPlayType("application/vnd.apple.mpegurl");
      const report = buildReport(video, { nativeHls });
      for (const h of await hdrOf()) if (!report.hdr.includes(h)) report.hdr.push(h);
      const r = await api.reportCaps(report);
      if (r && typeof r.id === "string") setCapsId(r.id);
    } catch {
      sent = null; // asked again next time
    }
    return capsId();
  })();
  return sent;
};
