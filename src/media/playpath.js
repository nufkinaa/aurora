// HOW A FILE PLAYS ON THIS DEVICE — the one decision table (TV round
// 2026-10-19, "direct play").
//
// In: what the file is (the library probe, media/metadata.js — or, for a
// torrent source, what its release name says) and what the device said it
// can play (its report, media/avcaps.js). Out: the cheapest way that works —
//
//   direct     the file as it is (/stream/video/:id): no ffmpeg at all; the
//              TV hands AC-3 / E-AC-3 / DTS / TrueHD to the TV or soundbar
//              untouched (passthrough) or decodes it itself
//   remux      the picture copied, the sound made AAC stereo (the jit copy /
//              the offset copy): the container or the sound is the problem,
//              the picture is not
//   transcode  the picture re-encoded to H.264 (the ladder's encodes): the
//              device cannot show the picture as it is
//
// The website and the TV both ask this table (parity): a browser that
// decodes HEVC in hardware gets the HEVC, a TV that passes E-AC-3 through
// gets the E-AC-3. PURE — no requires, no clock: the tests run it as it is
// over many file × device combinations (test/playpath.test.js), and
// tools/playpath-count.js counts a whole library with it.
//
// Each answer carries `why`: one short line per thing that decided it, for
// the logs, the admin and the device checks.
"use strict";

// ------------------------------------------------------------- the file
// ffprobe's codec names → the report's vocabulary (media/avcaps.js)
const VIDEO_NAME = { h264: "h264", hevc: "hevc", h265: "hevc", av1: "av1", vp9: "vp9", vp8: "vp8", mpeg2video: "mpeg2", mpeg4: "mpeg4", msmpeg4v3: "mpeg4", vc1: "vc1", wmv3: "vc1" };
const audioName = (codec, profile) => {
  const c = String(codec || "").toLowerCase();
  if (c === "dts") return /dts-hd|dts:x|dts-x|\bma\b|\bhra\b/i.test(String(profile || "")) ? "dtshd" : "dts";
  if (/^pcm_/.test(c)) return "pcm";
  return c;
};
const CONTAINER_NAME = { mkv: "mkv", mk3d: "mkv", mp4: "mp4", m4v: "mp4", mov: "mov", webm: "webm", avi: "avi", ts: "ts", m2ts: "ts", mts: "ts" };

/** The facts of a library item (the /api/item answer, scanner + probe). */
const factsOfItem = (item) => {
  if (!item || typeof item !== "object") return null;
  const v = item.video || null;
  const tracks = [];
  if (Array.isArray(item.audioTracks) && item.audioTracks.length) {
    for (const t of item.audioTracks) tracks.push({ index: t.index != null ? t.index : tracks.length, codec: t.codec, channels: t.channels || 2, profile: t.profile || null, atmos: !!t.atmos });
    // (the list carries no profile; the first stream's own record does)
    if (item.audio && tracks[0] && tracks[0].codec === item.audio.codec) {
      tracks[0].profile = item.audio.profile || null;
      tracks[0].atmos = !!item.audio.atmos;
    }
  } else if (item.audio) {
    tracks.push({ index: 0, codec: item.audio.codec, channels: item.audio.channels || 2, profile: item.audio.profile || null, atmos: !!item.audio.atmos });
  }
  return {
    container: CONTAINER_NAME[String(item.container || "").toLowerCase()] || String(item.container || "").toLowerCase() || null,
    width: item.width || 0,
    height: item.height || 0,
    video: v
      ? {
          codec: VIDEO_NAME[String(v.codec || "").toLowerCase()] || String(v.codec || "").toLowerCase() || null,
          bitDepth: v.bitDepth || 8,
          hdr: v.hdr || null,
          fps: v.fps || 0,
          profile: v.profile || null,
          dvProfile: v.dvProfile != null ? v.dvProfile : null,
          dvCompat: v.dvCompat != null ? v.dvCompat : null,
        }
      : null,
    audio: tracks.map((t) => ({ ...t, codec: audioName(t.codec, t.profile) })),
  };
};

/** The facts a torrent release NAME gives (the source list has nothing
 *  better before the swarm is joined): a guess, read the way the source
 *  badges are (media/torrent.js parseTags) but a little finer. */
const factsOfRelease = (name, quality) => {
  const s = String(name || "");
  const codec = /\bav1\b/i.test(s) ? "av1" : /x265|h\.?265|hevc/i.test(s) ? "hevc" : /\bvp9\b/i.test(s) ? "vp9" : "h264";
  const dv = /dolby\s*vision|\bDV\b|\bDoVi\b/i.test(s);
  const hdr = dv ? "dolby-vision" : /HDR10\+?|\bHDR\b/i.test(s) ? "hdr10" : /\bHLG\b/i.test(s) ? "hlg" : null;
  // a DV release that also says HDR is a profile 7/8 one: HDR10 underneath
  const dvCompat = dv && /HDR10|\bHDR\b|hybrid/i.test(s) ? 1 : null;
  const bitDepth = /10.?bit|hi10|main10/i.test(s) || (codec === "hevc" && hdr) ? 10 : 8;
  const atmos = /atmos/i.test(s);
  const ac = /truehd/i.test(s)
    ? "truehd"
    : /dts-?hd|dts-?x|dts.?ma/i.test(s)
      ? "dtshd"
      : /\bdts\b/i.test(s)
        ? "dts"
        : /ddp|dd\+|e-?ac-?3|eac3/i.test(s)
          ? "eac3"
          : atmos
            ? "truehd" // Atmos with nothing else said: the harder one to play
            : /\bdd\b|\bdd5|\bac-?3\b|dolby\s*digital/i.test(s)
              ? "ac3"
              : /\bopus\b/i.test(s)
                ? "opus"
                : /\bflac\b/i.test(s)
                  ? "flac"
                  : "aac";
  const ext = /\.(mkv|mp4|m4v|avi|webm|m2ts|ts|mov)(?=\s|$)/i.exec(s);
  const q = String(quality || s);
  const height = /2160p|\b4k\b|uhd/i.test(q) ? 2160 : /1080p/i.test(q) ? 1080 : /720p/i.test(q) ? 720 : /480p/i.test(q) ? 480 : 0;
  return {
    container: ext ? CONTAINER_NAME[ext[1].toLowerCase()] : "mkv",
    width: height ? Math.round((height * 16) / 9) : 0,
    height,
    video: { codec, bitDepth, hdr, fps: 0, profile: null, dvProfile: null, dvCompat },
    audio: [{ index: 0, codec: ac, channels: ac === "aac" ? 2 : 6, profile: null, atmos }],
    guessed: true,
  };
};

// ------------------------------------------------------------- the rules
// The profile the picture needs, in the report's words.
const neededProfile = (v) => {
  const p = String(v.profile || "").toLowerCase();
  const deep = (v.bitDepth || 8) > 8;
  switch (v.codec) {
    case "h264":
      if (/4:4:4/.test(p)) return "high444";
      if (/4:2:2/.test(p)) return "high422";
      if (/high 10/.test(p) || deep) return "high10";
      if (/baseline/.test(p)) return "baseline";
      if (/main/.test(p)) return "main";
      return "high";
    case "hevc":
      if (/rext|12/.test(p) || (v.bitDepth || 8) > 10) return "main12";
      return /main 10/.test(p) || deep ? "main10" : "main";
    case "vp9": {
      const m = /profile\s*(\d)/.exec(p);
      return m ? m[1] : deep ? "2" : "0";
    }
    case "av1":
      return /professional/.test(p) ? "professional" : /high/.test(p) ? "high" : "main";
    default:
      return null;
  }
};
// the profiles that any decoder of the codec plays (a report that lists no
// profiles for a codec is taken to mean these, and no more)
const BASE_PROFILES = { h264: ["baseline", "main", "high"], hevc: ["main"], vp9: ["0"], av1: ["main"] };
// A higher profile's decoder plays the lower ones (H.264 High plays Main…).
const PROFILE_COVERS = {
  h264: { high444: ["high444", "high422", "high10", "high", "main", "baseline"], high422: ["high422", "high10", "high", "main", "baseline"], high10: ["high10", "high", "main", "baseline"], high: ["high", "main", "baseline"], main: ["main", "baseline"], baseline: ["baseline"] },
  hevc: { main12: ["main12", "main10", "main"], main10: ["main10", "main"], main: ["main"] },
  vp9: { 3: ["3", "2", "1", "0"], 2: ["2", "0"], 1: ["1", "0"], 0: ["0"] },
};
const profileOk = (codec, need, listed) => {
  if (!need) return true;
  const have = listed && listed.length ? listed : BASE_PROFILES[codec] || [];
  const covers = PROFILE_COVERS[codec];
  return have.some((h) => h === need || (covers && covers[h] && covers[h].includes(need)));
};

// What the picture's HDR is, presented: { ok, as, why }
const hdrVerdict = (v, caps) => {
  const hdr = v.hdr;
  if (!hdr) return { ok: true, as: "sdr" };
  const shows = caps.hdr || [];
  if (hdr === "dolby-vision") {
    const dvp = v.dvProfile;
    if (shows.includes("dv") && (dvp == null || !(caps.dv || []).length || caps.dv.includes(dvp))) return { ok: true, as: "dv" };
    // no Dolby Vision here: the base layer is what shows
    const base = v.dvCompat === 1 || v.dvCompat === 6 ? "hdr10" : v.dvCompat === 4 ? "hlg" : v.dvCompat === 2 ? "sdr" : v.dvCompat === 0 || dvp === 5 ? null : "hdr10";
    if (!base) return { ok: false, why: "dolby vision profile 5 (no fallback layer) and no dolby vision here" };
    if (base === "sdr") return { ok: true, as: "sdr", why: "dolby vision: its sdr base layer" };
    if (shows.includes(base)) return { ok: true, as: base, why: `dolby vision: its ${base} base layer${v.dvCompat == null ? " (profile not probed — assumed 7/8)" : ""}` };
    if (caps.client === "web") return { ok: true, as: "sdr", why: `dolby vision ${base} base layer, tone mapped by the browser` };
    return { ok: false, why: `dolby vision ${base} base layer and no ${base} on this screen` };
  }
  if (shows.includes(hdr)) return { ok: true, as: hdr };
  // a browser draws HDR on an SDR screen by tone mapping it itself
  if (caps.client === "web") return { ok: true, as: "sdr", why: `${hdr} tone mapped by the browser` };
  return { ok: false, why: `${hdr} and this screen shows no ${hdr}` };
};

/** Can the device decode and show the picture as it is? { ok, why } */
const videoVerdict = (f, caps) => {
  const v = f.video;
  if (!v || !v.codec) return { ok: false, why: "no video facts" };
  const c = (caps.video || {})[v.codec];
  if (!c) return { ok: false, why: `no ${v.codec} decoder` };
  const need = neededProfile(v);
  if (!profileOk(v.codec, need, c.profiles)) return { ok: false, why: `${v.codec} ${need} not decoded here` };
  const long = Math.max(f.width || 0, f.height || 0);
  const short = Math.min(f.width || 0, f.height || 0);
  if (c.maxW && c.maxH && long && (long > Math.max(c.maxW, c.maxH) || short > Math.min(c.maxW, c.maxH))) {
    return { ok: false, why: `${f.width}x${f.height} is over the ${v.codec} decoder's ${c.maxW}x${c.maxH}` };
  }
  if (c.maxFps && v.fps && v.fps > c.maxFps * 1.01) return { ok: false, why: `${v.fps} fps is over the decoder's ${c.maxFps}` };
  const h = hdrVerdict(v, caps);
  if (!h.ok) return { ok: false, why: h.why };
  return { ok: true, why: `${v.codec} ${need || ""}${h.as !== "sdr" ? ` ${h.as}` : ""}${h.why ? ` (${h.why})` : ""}`.replace(/\s+/g, " ").trim() };
};

// The forms a track can be passed through as, the richest first.
const passForms = (t) =>
  t.codec === "eac3" && t.atmos ? ["eac3-joc", "eac3"] : t.codec === "dtshd" ? ["dtshd", "dts"] : t.codec === "truehd" ? ["truehd"] : [t.codec];
// The decoder that plays the track (a DTS core decoder plays DTS-HD's core,
// an E-AC-3 decoder plays Atmos' E-AC-3 bed).
const decodeForms = (t) => (t.codec === "dtshd" ? ["dtshd", "dts"] : t.codec === "eac3" ? ["eac3"] : [t.codec]);
const BITSTREAM = new Set(["ac3", "eac3", "dts", "dtshd", "truehd"]);

/** One audio track: 'passthrough' (as it is, to the TV/soundbar), 'decode'
 *  (the device decodes it) or 'convert' (the server makes AAC). */
const audioVerdict = (t, caps, prefs = {}) => {
  if (!t || !t.codec) return { audio: "decode", why: "no audio" };
  const a = caps.audio || {};
  if (prefs.surround !== "stereo" && BITSTREAM.has(t.codec)) {
    const form = passForms(t).find((x) => (a.passthrough || []).includes(x));
    if (form) return { audio: "passthrough", form, why: `${form} passthrough${form === "eac3-joc" ? " (atmos)" : ""}` };
  }
  const dec = decodeForms(t).find((x) => (a.decode || []).includes(x));
  if (dec) return { audio: "decode", form: dec, why: `${t.codec} decoded here${prefs.surround === "stereo" && BITSTREAM.has(t.codec) ? " (surround: stereo only)" : ""}` };
  return { audio: "convert", why: `${t.codec} neither decoded nor passed through here` };
};

const COPYABLE = new Set(["h264", "hevc"]); // what the copy streams carry (TS / fMP4)

/**
 * The decision. `facts`: factsOfItem / factsOfRelease. `caps`: a normalized
 * report. `opts.track`: which audio track (index, default the first);
 * `opts.prefs`: the person's { surround: 'auto'|'stereo' }.
 * → { v, mode, video, audio, form?, decodes, container, why[], tracks[] }
 */
const decide = (facts, caps, opts = {}) => {
  if (!facts || !caps) return null;
  const prefs = opts.prefs || {};
  const why = [];
  const vv = videoVerdict(facts, caps);
  why.push(vv.ok ? `video: ${vv.why}` : `video: ${vv.why}`);
  const codec = facts.video && facts.video.codec;
  const cont = facts.container;
  const contList = cont ? (caps.containers || {})[cont] : null;
  const containerOk = !!(cont && contList && codec && contList.includes(codec));
  if (!containerOk) why.push(`container: ${cont || "unknown"}${contList ? ` with ${codec}` : ""} not opened here`);
  const tracks = (facts.audio || []).map((t) => ({ index: t.index, ...audioVerdict(t, caps, prefs) }));
  const want = opts.track != null ? tracks.find((t) => t.index === opts.track) : tracks[0];
  const av = want || { audio: "decode", why: "no audio" };
  why.push(`audio: ${av.why}`);
  let mode;
  if (vv.ok && containerOk && av.audio !== "convert") mode = "direct";
  else if (vv.ok && COPYABLE.has(codec)) mode = "remux";
  else mode = "transcode";
  if (mode === "remux") why.push("the picture is copied; the sound becomes AAC stereo");
  if (mode === "transcode" && vv.ok) why.push(`${codec} cannot be copied into a stream: re-encoded`);
  const out = {
    v: 1,
    mode,
    video: mode === "direct" ? "direct" : mode === "remux" ? "copy" : "encode",
    audio: av.audio,
    decodes: vv.ok,
    container: containerOk,
    why,
    tracks: tracks.map((t) => ({ index: t.index, audio: t.audio })),
  };
  if (av.form) out.form = av.form;
  if (facts.video && facts.video.fps) out.fps = facts.video.fps;
  if (facts.guessed) out.guessed = true;
  return out;
};

module.exports = { decide, factsOfItem, factsOfRelease, videoVerdict, audioVerdict, neededProfile, hdrVerdict, audioName, COPYABLE };
