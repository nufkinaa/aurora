// Tone mapping for HDR sources that have to be RE-ENCODED to 8-bit H.264.
//
// A device that cannot decode a file's own codec (HEVC / 10-bit / AV1) gets a
// libx264 encode (remux.js, torrent-transcode.js). When that file is HDR — PQ
// (HDR10, transfer smpte2084) or HLG (arib-std-b67), BT.2020 — folding 10 bits
// to 8 with `-pix_fmt yuv420p` keeps the HDR signal curve: on an SDR screen
// the picture is grey and washed out (measured on a 400-nit test clip: luma
// spread 24 against 55 for the SDR original, saturation 101 against 245), and
// the stream still carries smpte2084/bt2020 tags on an 8-bit picture. This
// module decides WHEN a job gets a tone-map filter and builds the one -vf
// chain for it. It never touches a "copy" job and never an SDR source: for
// those the callers emit exactly the arguments they always did.
//
// The condition from the owner: "let's be careful and see that it doesn't
// ruin anything or slows things down". So three gates, all of which must hold:
//
//  1. The source REALLY is HDR. Known from ffprobe on the file itself
//     (probeVideo below), never from a release name. Unknown = SDR = today's
//     behaviour. Dolby Vision without an HDR10/HLG base layer (profile 5,
//     IPT-PQ-C2) cannot be mapped correctly by these filters and is left alone.
//
//  2. This ffmpeg can do it. zscale (libzimg) + tonemap are checked ONCE, by
//     actually running the chain (probeSupport) — a build without them, or one
//     where the chain errors, never gets the filter.
//
//  3. It stays comfortably above real time. These encodes run live; a stream
//     that falls behind is worse than a grey one. The same run that proves the
//     chain works also times it (megapixels per second through the filter on
//     THIS host), and predictSpeed() turns that into "x real time" for a given
//     source size, output size and frame rate. Below MIN_SPEED (1.5x; doubled
//     when another encode is already running) the job is left as it is today.
//
// Measured 2026-10-08 on the development machine (i7-10700K, 16 threads,
// ffmpeg 6.0, noisy synthetic HDR10 clips, single job, whole pipeline incl.
// audio; fps before -> after tone mapping):
//     2160p -> 1080p    84 -> 50      1080p -> 1080p   145 ->  73
//     2160p ->  720p   103 -> 73      1080p ->  720p   262 -> 131
//     2160p ->  480p   107 -> 93      1080p ->  480p   321 -> 208
// The filter costs ~4.2 ms per OUTPUT megapixel there (235 MP/s), which is why
// the downscale always comes first: linear-light float RGB at 4K would cost
// four times what it costs at 1080p. The model constants below are fitted to
// that table and scaled by the host's own measured filter speed.
//
// KILL SWITCH (environment, read at call time, no deploy needed — restart only):
//   AURORA_TONEMAP=0        never tone-map (also: off / false / no)
//   AURORA_TONEMAP=force    skip the speed gate (filters + real HDR still required)
//   AURORA_TONEMAP_MIN_SPEED=2.0   demand more (or less) headroom than 1.5x
const { execFile } = require("child_process");
const config = require("../config");

const MIN_SPEED_DEFAULT = 1.5;
// Fitted on the development machine (see the table above), in milliseconds
// per frame at REF_MPPS: decode + downscale per SOURCE megapixel, x264
// superfast per OUTPUT megapixel, a constant. The fit runs 0–8% pessimistic
// against every measured row.
const REF_MPPS = 235;
const MS_PER_SRC_MP = 0.95;
const MS_PER_OUT_MP = 2.2;
const MS_CONST = 0.5;
const ASSUMED_FPS = 30; // when the probe could not read a frame rate

const mode = (env = process.env) => {
  const v = String(env.AURORA_TONEMAP == null ? "" : env.AURORA_TONEMAP).trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "force") return "force";
  return "auto";
};
const enabled = (env = process.env) => mode(env) !== "off";
const minSpeed = (env = process.env) => {
  const n = parseFloat(env.AURORA_TONEMAP_MIN_SPEED);
  return Number.isFinite(n) && n > 0 ? n : MIN_SPEED_DEFAULT;
};

const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();

// "pq" | "hlg" | null. `v` is what parseProbe returns (transfer + optional dv).
// Dolby Vision: the record's bl_signal_compatibility_id says what the base
// layer is — 1 = HDR10, 4 = HLG, 6 = HDR10 (Blu-ray, profile 7); 0 = none
// (profile 5 and AV1 10.0: IPT-PQ-C2, which zscale would read as BT.2020 PQ
// and turn green/purple), 2 = SDR. Only a known mappable base is touched.
const hdrKind = (v) => {
  if (!v) return null;
  const t = lower(v.transfer);
  const kind = t === "smpte2084" ? "pq" : t === "arib-std-b67" ? "hlg" : null;
  if (!kind) return null;
  const dv = v.dv;
  if (dv) {
    const profile = Number.isFinite(dv.profile) ? dv.profile : null;
    const compat = Number.isFinite(dv.compat) ? dv.compat : null;
    if (profile === null || profile === 5) return null;
    if (compat !== null) {
      if (compat !== 1 && compat !== 4 && compat !== 6) return null;
    } else if (profile !== 7 && profile !== 8) {
      return null;
    }
  }
  return kind;
};
const isHdr = (v) => hdrKind(v) !== null;

// What zscale is TOLD the input is. Explicit on purpose: zscale otherwise
// reads the colour tags off each decoded frame, and a file whose container
// says PQ while its bitstream says nothing makes it fail with "no path
// between colorspaces" — a dead stream instead of a grey one. Anything we do
// not recognise is not guessed at: no filter.
const PRIMARIES = { "": "bt2020", unknown: "bt2020", unspecified: "bt2020", bt2020: "bt2020", bt709: "bt709", smpte432: "smpte432", smpte431: "smpte431" };
const MATRICES = { "": "bt2020nc", unknown: "bt2020nc", unspecified: "bt2020nc", bt2020nc: "bt2020nc", bt2020c: "bt2020c", bt709: "bt709" };

// The size a job's own scale filter will produce: a capped rendition folds to
// its height, the full one folds anything wider than 1920 (never upscaling).
const outDims = (width, height, outHeight) => {
  const w = width > 0 ? width : 3840; // unknown = assume the expensive case
  const h = height > 0 ? height : 2160;
  if (outHeight > 0) {
    const oh = Math.min(outHeight, h);
    return { srcW: w, srcH: h, outW: Math.round((w * oh) / h), outH: oh };
  }
  const ow = Math.min(1920, w);
  return { srcW: w, srcH: h, outW: ow, outH: Math.round((h * ow) / w) };
};

// Predicted speed of the whole tone-mapped encode, as a multiple of real time.
// `mpps` = megapixels/second through the tone-map chain on this host
// (probeSupport). The rest of the pipeline is assumed to scale with the same
// number — both are multi-threaded SIMD work on the same cores.
const predictSpeed = ({ width, height, outHeight, fps, mpps }) => {
  if (!(mpps > 0)) return 0;
  const d = outDims(width, height, outHeight);
  const srcMP = (d.srcW * d.srcH) / 1e6;
  const outMP = (d.outW * d.outH) / 1e6;
  const base = (MS_PER_SRC_MP * srcMP + MS_PER_OUT_MP * outMP + MS_CONST) * (REF_MPPS / mpps);
  const ms = base + (outMP * 1000) / mpps;
  const rate = fps > 0 ? fps : ASSUMED_FPS;
  return 1000 / ms / rate;
};

// The chain itself. zscale to linear light AND BT.709 primaries in one step
// (byte-identical output to the textbook two-step form, ~12% faster), float
// RGB for the tonemap filter, hable with no desaturation, back to BT.709
// limited-range 8-bit 4:2:0 — tagged bt709 all the way out.
const tonemapChain = (kind, pin, min, full) =>
  [
    `zscale=tin=${kind === "hlg" ? "arib-std-b67" : "smpte2084"}:pin=${pin}:min=${min}${full ? ":rin=pc" : ""}:t=linear:npl=100:p=bt709`,
    "format=gbrpf32le",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=bt709:m=bt709:r=tv",
    "format=yuv420p",
  ].join(",");

const defaultScale = (outHeight) => (outHeight > 0 ? `scale=-2:min(${outHeight}\\,ih)` : "scale=min(1920\\,iw):-2");

// The decision, with its reason (for the log and the tests). Pure.
//   transfer/primaries/matrix/range/pixFmt/width/height/fps/dv — the source
//   outHeight — the capped rendition's height, or 0/undefined for the full one
//   scale     — the job's own scale filter; it goes FIRST (default: the same
//               expressions remux.js uses)
//   available — { ok, mpps } from probeSupport()
//   busy      — another encode is already running: demand twice the headroom
const decide = (o = {}) => {
  const env = o.env || process.env;
  const m = mode(env);
  if (m === "off") return { vf: null, why: "off" };
  const kind = hdrKind(o);
  if (!kind) return { vf: null, why: o.dv && (lower(o.transfer) === "smpte2084" || lower(o.transfer) === "arib-std-b67") ? "dolby-vision-base" : "sdr" };
  const a = o.available;
  if (!a || !a.ok) return { vf: null, why: "unsupported", kind };
  const pin = PRIMARIES[lower(o.primaries)];
  const min = MATRICES[lower(o.matrix)];
  if (!pin || !min) return { vf: null, why: "unknown-colours", kind };
  let speed = null;
  if (m !== "force") {
    speed = predictSpeed({ width: o.width, height: o.height, outHeight: o.outHeight, fps: o.fps, mpps: a.mpps });
    const need = minSpeed(env) * (o.busy ? 2 : 1);
    if (!(speed >= need)) return { vf: null, why: "too-slow", kind, speed, need };
  }
  const scale = o.scale || defaultScale(o.outHeight);
  return { vf: `${scale},${tonemapChain(kind, pin, min, lower(o.range) === "pc")}`, why: "ok", kind, speed };
};
const filterFor = (o) => decide(o).vf;

// ---- what this ffmpeg can do, and how fast (once per process) ----

const CAL_W = 1280;
const CAL_H = 720;
const CAL_SHORT = 24;
const CAL_LONG = 216;
const runChain = (kind, frames) =>
  new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    execFile(
      config.FFMPEG,
      [
        "-v", "error", "-f", "lavfi", "-i", `color=c=gray:s=${CAL_W}x${CAL_H}:r=24`,
        "-frames:v", String(frames),
        "-vf", `format=yuv420p10le,${tonemapChain(kind, "bt2020", "bt2020nc", false)}`,
        "-f", "null", "-",
      ],
      { windowsHide: true, timeout: 30000 },
      (err) => resolve(err ? null : Number(process.hrtime.bigint() - t0) / 1e6),
    );
  });

let support = null; // resolved value, once known
let supportP = null;
const probeSupport = () => {
  if (supportP) return supportP;
  supportP = new Promise((resolve) => {
    const none = (why) => resolve({ ok: false, zscale: false, tonemap: false, mpps: 0, why });
    if (!config.FFMPEG) return none("no ffmpeg");
    execFile(config.FFMPEG, ["-hide_banner", "-filters"], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, async (err, out) => {
      const text = String(out || "");
      const zscale = !err && /^\s*\S+\s+zscale\s/m.test(text);
      const tonemap = !err && /^\s*\S+\s+tonemap\s/m.test(text);
      if (!zscale || !tonemap) return resolve({ ok: false, zscale, tonemap, mpps: 0, why: "filters missing" });
      // Prove both chains run, and time the filter: the long run minus the
      // short one cancels process start-up. The HLG run is the short one.
      const short = await runChain("hlg", CAL_SHORT);
      const long1 = short === null ? null : await runChain("pq", CAL_LONG);
      const long2 = long1 === null ? null : await runChain("pq", CAL_LONG);
      if (short === null || long1 === null || long2 === null) return resolve({ ok: false, zscale, tonemap, mpps: 0, why: "chain failed" });
      const ms = Math.max(1, Math.min(long1, long2) - short);
      const mpps = ((CAL_LONG - CAL_SHORT) * CAL_W * CAL_H) / 1e6 / (ms / 1000);
      resolve({ ok: true, zscale, tonemap, mpps: Math.round(mpps) });
    });
  }).then((s) => {
    support = s;
    const eg = (w, h, oh) => predictSpeed({ width: w, height: h, outHeight: oh, fps: 24, mpps: s.mpps }).toFixed(1);
    console.log(
      s.ok
        ? `[tonemap] HDR tone mapping available — ${s.mpps} MP/s; at 24fps: 2160p→1080p ${eg(3840, 2160, 0)}x, 1080p→1080p ${eg(1920, 1080, 0)}x, 2160p→720p ${eg(3840, 2160, 720)}x (needs ${minSpeed()}x; AURORA_TONEMAP=${mode()})`
        : `[tonemap] HDR tone mapping unavailable (${s.why}; zscale=${s.zscale}, tonemap=${s.tonemap}) — HDR re-encodes stay as they were`,
    );
    return s;
  });
  return supportP;
};
const supportNow = () => support;

// One timing is one moment: a host that was busy for those two seconds would
// call itself slow until the next restart (seen here — 173 MP/s with other
// work running, 235 idle). Timed again later, the FASTEST answer is kept: the
// question is what the host can do, the same footing the plain encode is on.
const recalibrate = async () => {
  const s = await probeSupport();
  if (!s.ok) return s;
  const short = await runChain("hlg", CAL_SHORT);
  const long = short === null ? null : await runChain("pq", CAL_LONG);
  if (short === null || long === null) return s;
  const mpps = Math.round(((CAL_LONG - CAL_SHORT) * CAL_W * CAL_H) / 1e6 / (Math.max(1, long - short) / 1000));
  if (mpps > s.mpps) {
    console.log(`[tonemap] re-timed: ${s.mpps} → ${mpps} MP/s`);
    s.mpps = mpps;
  }
  return s;
};

// Called once the server is up (remux.bootSweep): not at module load — the
// tests load these modules — and not in the first seconds of boot, where a
// machine busy scanning would measure itself slow.
let warmed = false;
const warmUp = () => {
  if (warmed || !enabled() || !config.FFMPEG) return;
  warmed = true;
  setTimeout(() => { probeSupport(); }, 15000).unref?.();
  for (const ms of [90000, 300000]) setTimeout(() => { recalibrate().catch(() => {}); }, ms).unref?.();
};

// ---- what a source is (ffprobe on the file itself) ----

const rate = (s) => {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(String(s || ""));
  if (!m) return null;
  const v = parseInt(m[1], 10) / (m[2] ? parseInt(m[2], 10) : 1);
  return Number.isFinite(v) && v >= 1 && v <= 240 ? v : null;
};

// ffprobe -of json (first video stream) -> the colour facts decide() needs.
const parseProbe = (json) => {
  let j;
  try { j = typeof json === "string" ? JSON.parse(json) : json; } catch { return null; }
  const s = ((j && j.streams) || []).find((x) => !x.codec_type || x.codec_type === "video");
  if (!s) return null;
  let dv = null;
  for (const d of s.side_data_list || []) {
    const type = lower(d.side_data_type);
    if (!type.includes("dovi") && !type.includes("dolby vision")) continue;
    const profile = parseInt(d.dv_profile, 10);
    const compat = parseInt(d.dv_bl_signal_compatibility_id, 10);
    dv = { profile: Number.isFinite(profile) ? profile : null, compat: Number.isFinite(compat) ? compat : null };
  }
  return {
    codec: s.codec_name || null,
    width: s.width || 0,
    height: s.height || 0,
    pixFmt: s.pix_fmt || null,
    transfer: lower(s.color_transfer) || null,
    primaries: lower(s.color_primaries) || null,
    matrix: lower(s.color_space) || null,
    range: lower(s.color_range) || null,
    fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate),
    dv,
  };
};

const PROBE_ARGS = [
  "-v", "error",
  "-select_streams", "v:0",
  "-show_entries",
  "stream=codec_type,codec_name,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,avg_frame_rate,r_frame_rate:stream_side_data=side_data_type,dv_profile,dv_bl_signal_compatibility_id",
  "-of", "json",
];
const probeVideo = (input, { http = false } = {}) =>
  new Promise((resolve) => {
    if (!config.FFPROBE) return resolve(null);
    execFile(
      config.FFPROBE,
      // Over our own blocking torrent route: the same bounds streamprobe.js
      // uses, so a slow swarm cannot hold a stream's start for long.
      [...PROBE_ARGS, ...(http ? ["-probesize", "16M", "-analyzeduration", "10M"] : []), input],
      { windowsHide: true, timeout: http ? 6000 : 5000, maxBuffer: 1024 * 1024 },
      (err, out) => resolve(err ? null : parseProbe(String(out || ""))),
    );
  });

const facts = new Map(); // key -> facts (a source's colours do not change)
const failed = new Map(); // key -> failedAt
const inflight = new Map(); // key -> promise
const FAIL_TTL = 60 * 1000;

// The colour facts for a source that is about to be re-encoded, or null when
// tone mapping is off / impossible here / the probe failed — null always
// means "encode it the way it always was". Never rejects.
const sourceFacts = (key, input, opts) => {
  if (!enabled()) return Promise.resolve(null);
  if (facts.has(key)) return Promise.resolve(facts.get(key));
  if (Date.now() - (failed.get(key) || 0) < FAIL_TTL) return Promise.resolve(null);
  let p = inflight.get(key);
  if (p) return p;
  p = probeSupport()
    .then((s) => (s.ok ? probeVideo(input, opts) : null))
    .then((f) => {
      inflight.delete(key);
      if (f) {
        if (facts.size > 500) facts.clear();
        facts.set(key, f);
      } else if (support && support.ok) {
        if (failed.size > 500) failed.clear();
        failed.set(key, Date.now());
      }
      return f;
    })
    .catch(() => {
      inflight.delete(key);
      return null;
    });
  inflight.set(key, p);
  return p;
};

// For a call site: the -vf for this job (starting with the job's own scale
// filter), or null to leave the job exactly as it was. Logs what it did for
// an HDR source, once per decision.
const vfFor = (f, { scale, outHeight = 0, busy = false, label = "" } = {}) => {
  if (!f || f.veto) return null;
  const d = decide({ ...f, scale, outHeight, busy, available: support });
  if (d.kind) {
    const sp = d.speed != null ? ` (predicted ${d.speed.toFixed(1)}x real time)` : "";
    console.log(
      d.vf
        ? `[tonemap] ${d.kind.toUpperCase()} → SDR ${label}${sp}`
        : `[tonemap] ${d.kind.toUpperCase()} left untouched ${label}: ${d.why}${sp}`,
    );
  }
  return d.vf;
};

// Safety net. A tone-mapped job that exits with a FILTER error (a pixel format
// or colour combination zscale refuses) would otherwise fail the same way on
// every retry — a title that played grey before and now does not play. The
// first such failure switches tone mapping off for that source until restart,
// so the retry gets the encode it always got. Failures that are not about the
// filters (a torrent's bad piece, a kill) change nothing.
const veto = (f, stderr) => {
  if (!f || f.veto || !/zscale|tonemap|filter/i.test(String(stderr || ""))) return false;
  f.veto = true;
  console.log("[tonemap] the filter chain failed on this source — plain encode from now on");
  return true;
};

module.exports = {
  veto,
  isHdr,
  hdrKind,
  filterFor,
  decide,
  predictSpeed,
  outDims,
  probeSupport,
  supportNow,
  recalibrate,
  warmUp,
  parseProbe,
  probeVideo,
  sourceFacts,
  vfFor,
  enabled,
  mode,
  _internals: { tonemapChain, defaultScale, REF_MPPS, MIN_SPEED_DEFAULT },
};
