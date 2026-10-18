// Hardware video encoding: what this machine's graphics can do, found out
// safely, and the ffmpeg arguments that use it for the quality ladder.
//
// FOUND OUT, NEVER REQUIRED. A while after the server starts, ffmpeg is
// asked which hardware encoders it was built with, and each family that
// exists here is TRIED, every try with a time limit, at the lowest priority:
//   1. the encoder opens at all (a second of generated picture);
//   2. which sources the card DECODES: a short H.264, HEVC and 10-bit HEVC
//      clip is made and decoded → scaled → encoded on the card;
//   3. the exact arguments the ladder would use (argsFor) are run once on a
//      generated clip — the probe proves the very command a viewer gets.
// Whatever fails is simply "not available": no card, no driver, no
// /dev/dri, a build of ffmpeg without the encoder — ordinary answers on most
// machines. Only a family whose step 3 passed is ever used. The result is on
// the admin page (Server → Encoding) and in GET /api/admin/encoding.
//
// FAMILIES, in order of preference:
//   nvenc  NVIDIA (Windows, Linux): NVDEC decode, scale_cuda, h264_nvenc.
//          The only one measured (the house server's RTX 3090:
//          docs/qa/server-round/STREAMING.md).
//   vaapi  Intel / AMD on Linux (/dev/dri/renderD128): VA-API decode,
//          scale_vaapi, h264_vaapi. DESIGNED, NOT TESTED on real hardware
//          here — the probe's step 3 is what stands between it and a viewer.
//   qsv    Intel Quick Sync (Windows, Linux): CPU decode, hwupload, h264_qsv.
//          DESIGNED, NOT TESTED here (this PC's Intel graphics is off).
// macOS VideoToolbox is detected and reported only.
//
// USED WHERE IT IS BETTER (owner, 2026-10-18: "if we have a graphics card we
// should use it if and when we can and if and when it's better"). `hwEncode`
// in config.json, or the admin's setting of the same name:
//   "auto" (the default) — a family whose probe passed AND whose picture was
//          measured at least as good as x264's at the same ceilings
//          (QUALITY_PROVEN: NVENC, every rung — STREAMING.md), while one of
//          its sessions is free; anything else is encoded on the CPU, as before
//   "on"   — any family whose probe passed, measured or not
//   "off"  — never
//
// WHAT FOR, when on: the ENCODED renditions of the quality ladder (jit
// producers, ladder.js). An HDR source keeps the software path (tone mapping
// is a CPU filter in this ffmpeg); a source the card cannot decode is decoded
// by the CPU and only encoded on the card. A hardware rendition lives in its
// own job dir ("-hw"); a boundary it misses is held against the card's
// encodes of that file only. When the card refuses a session (the driver's
// limit, another program), the hardware path is put aside for a while and
// the next rendition is encoded in software, as before.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const config = require("../config");

// Sessions the card may hold at once, by default. GeForce drivers allow 5
// (8 on recent ones — measured on this PC: STREAMING.md), professional cards
// and Intel more; another program may hold some. config `hwEncodeSessions`.
const DEFAULT_SESSIONS = 3;
const REFUSED_HOLD_MS = 60 * 1000; // after the card refused: software only, this long
const PROBE_TIMEOUT_MS = 20 * 1000;
const RETRY_PROBE_MS = 10 * 60 * 1000;
const RENDER_NODE = "/dev/dri/renderD128";
// constant quality the encoders aim at (under the rung's ceiling); chosen by
// measurement against x264 superfast crf 18 (STREAMING.md): at 19 the full
// 1080p rung spends about what x264 does and scores higher; the 720p / 480p
// rungs are held by their ceilings whatever it is
const CQ = 19;

const state = {
  probing: null,
  result: null, // { at, encoders: { nvenc, vaapi, qsv, videotoolbox } }
  refusedUntil: 0,
  refusedWhy: null,
  sessions: new Set(),
  used: 0,
  fallbacks: 0,
};

const deps = {
  ffmpeg: () => config.FFMPEG,
  run: (args, timeout = PROBE_TIMEOUT_MS) => new Promise((resolve) => {
    const child = execFile(deps.ffmpeg(), args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(stdout || ""), err: String(stderr || "").slice(-600) });
    });
    // below normal, not the lowest: the idle class can be starved for minutes
    // on a busy machine, and a starved check concludes "no card"
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  }),
  exists: (p) => fs.existsSync(p),
  tmpdir: () => path.join(config.CACHE_DIR, "hwprobe"),
  platform: () => process.platform,
  setting: () => {
    try {
      const s = require("../lib/settings").data;
      if (s && s.hwEncode != null) return s.hwEncode;
    } catch {}
    return config.HW_ENCODE;
  },
  sessionsSet: () => {
    const n = parseInt(config.HW_ENCODE_SESSIONS, 10);
    return n > 0 ? Math.min(32, n) : 0;
  },
  now: () => Date.now(),
};

const mode = () => {
  const v = String(deps.setting() == null || deps.setting() === "" ? "auto" : deps.setting()).toLowerCase();
  if (v === "off" || v === "false" || v === "0") return "off";
  if (v === "on" || v === "true" || v === "force") return "on";
  return "auto";
};
// Families whose picture was measured at least as good as libx264 superfast
// crf 18 at the ladder's own ceilings, on every rung (VMAF higher on all 12
// clip × rung pairs, SSIM within 0.001, at 15-90x less CPU — STREAMING.md).
// "auto" uses only these; "on" uses any family whose probe passed.
const QUALITY_PROVEN = new Set(["nvenc"]);

const firstLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim()).filter(Boolean).slice(-1)[0] || null;

const listEncoders = (text) => {
  const have = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*V[.A-Z]{5}\s+(\S+)/.exec(line);
    if (m) have.add(m[1]);
  }
  return have;
};
const testSrc = (w, h, secs = 1) => ["-f", "lavfi", "-i", `testsrc2=s=${w}x${h}:r=24`, "-t", String(secs)];

// ---------- the arguments, per family ----------
// The same contract as ladder.encVideoArgs's libx264: a keyframe exactly
// where the source has one (-force_key_frames source; the family's own
// "make it an IDR" switch), every frame's own timestamp (-fps_mode
// passthrough, -enc_time_base -1), the rendition's size, its ceiling, the
// level the playlist states, High profile, 8-bit 4:2:0.
// `dims` { w, h } (ladder.dimsFor) · `rate` { maxrate, bufsize } kbit/s ·
// `level` 31, 40… · `onCard`: the card decodes this source.
// → { inputArgs (before -i), videoArgs }
const common = (level, fmt) => [
  "-profile:v", "high",
  "-level:v", (level / 10).toFixed(1),
  "-g", "600",
  "-force_key_frames", "source",
  "-fps_mode", "passthrough",
  "-enc_time_base", "-1",
  ...(fmt === "fmp4"
    ? ["-flags:v", "+global_header", "-bsf:v", "setts=pts=PTS:dts=DTS:duration=if(eq(NEXT_DTS\\,NOPTS)\\,DURATION\\,NEXT_DTS-DTS)"]
    : []),
];
const ARGS = {
  nvenc: ({ dims, rate, level, fmt, cq, onCard }) => ({
    // (4 frames on the card beyond the decoder's own: more made ffmpeg give
    // up on the card's decoder here — "hwaccel initialisation returned error")
    inputArgs: onCard ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-extra_hw_frames", "4"] : [],
    videoArgs: [
      // lanczos: scale_cuda's default (bilinear) cost 1–3 VMAF points on the
      // 720p and 480p rungs against the CPU's own scaler (measured)
      "-vf", onCard ? `scale_cuda=${dims.w}:${dims.h}:interp_algo=lanczos:format=yuv420p` : `scale=${dims.w}:${dims.h},format=yuv420p`,
      "-c:v", "h264_nvenc",
      // (p6 with two passes, a 20-frame look-ahead and temporal AQ was
      // measured too: no better on these ceilings — VMAF within ±0.3)
      "-preset", "p4", "-tune", "hq",
      "-rc", "vbr", "-cq", String(cq), "-b:v", "0",
      "-maxrate", `${rate.maxrate}k`, "-bufsize", `${rate.bufsize}k`,
      "-spatial-aq", "1",
      "-bf", "3", "-refs", "2", "-b_ref_mode", "disabled",
      "-forced-idr", "1",
      ...common(level, fmt),
    ],
  }),
  // (designed, not tested on real hardware — see the head of the file)
  vaapi: ({ dims, rate, level, fmt, cq, onCard }) => ({
    inputArgs: onCard
      ? ["-hwaccel", "vaapi", "-hwaccel_device", RENDER_NODE, "-hwaccel_output_format", "vaapi"]
      : ["-vaapi_device", RENDER_NODE],
    videoArgs: [
      "-vf", onCard ? `scale_vaapi=w=${dims.w}:h=${dims.h}:format=nv12` : `scale=${dims.w}:${dims.h},format=nv12,hwupload`,
      "-c:v", "h264_vaapi",
      "-rc_mode", "QVBR", "-global_quality", String(Math.max(1, cq + 4)),
      "-b:v", `${Math.round(rate.maxrate * 0.8)}k`, "-maxrate", `${rate.maxrate}k`, "-bufsize", `${rate.bufsize}k`,
      "-bf", "2",
      ...common(level, fmt),
    ],
  }),
  // (designed, not tested on real hardware — see the head of the file)
  qsv: ({ dims, rate, level, fmt, cq }) => ({
    inputArgs: ["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw"],
    videoArgs: [
      "-vf", `scale=${dims.w}:${dims.h},format=nv12,hwupload=extra_hw_frames=64`,
      "-c:v", "h264_qsv",
      "-preset", "medium", "-global_quality", String(cq + 2), "-look_ahead", "0",
      "-maxrate", `${rate.maxrate}k`, "-bufsize", `${rate.bufsize}k`,
      "-bf", "2",
      "-forced_idr", "1",
      ...common(level, fmt),
    ],
  }),
};
const ENCODER = { nvenc: "h264_nvenc", vaapi: "h264_vaapi", qsv: "h264_qsv", videotoolbox: "h264_videotoolbox" };

// ---------- detection ----------
const DECODE_CHAIN = {
  nvenc: (file) => ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-i", file, "-vf", "scale_cuda=640:360:format=yuv420p", "-c:v", "h264_nvenc", "-f", "null", "-"],
  vaapi: (file) => ["-hwaccel", "vaapi", "-hwaccel_device", RENDER_NODE, "-hwaccel_output_format", "vaapi", "-i", file, "-vf", "scale_vaapi=w=640:h=360:format=nv12", "-c:v", "h264_vaapi", "-f", "null", "-"],
};
const OPEN = {
  nvenc: () => [...testSrc(1280, 720), "-c:v", "h264_nvenc", "-f", "null", "-"],
  vaapi: () => ["-vaapi_device", RENDER_NODE, ...testSrc(1280, 720), "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-f", "null", "-"],
  qsv: () => ["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw", ...testSrc(1280, 720), "-vf", "format=nv12,hwupload=extra_hw_frames=8", "-c:v", "h264_qsv", "-f", "null", "-"],
  videotoolbox: () => [...testSrc(1280, 720), "-c:v", "h264_videotoolbox", "-f", "null", "-"],
};

// A probe step that got no word from ffmpeg at all ran out of time (the
// probe runs at the lowest priority, and a busy machine starves it): once
// more, with three times as long. Seen on this PC under load: the decode
// tests timing out made a card that decodes everything look like one that
// decodes nothing (every encode then decoded on the CPU).
const tryRun = async (args) => {
  const r = await deps.run(args);
  if (r.ok || firstLine(r.err)) return r;
  return deps.run(args, 3 * PROBE_TIMEOUT_MS);
};

const probeFamily = async (family, have) => {
  const out = { present: have.has(ENCODER[family]), encode: false, decode: { h264: false, hevc: false, hevc10: false }, chain: false, tested: family === "nvenc", why: null };
  if (!out.present) { out.why = `this ffmpeg has no ${ENCODER[family]}`; return out; }
  if (family === "vaapi" && !deps.exists(RENDER_NODE)) { out.why = `no ${RENDER_NODE}`; return out; }
  const open = await tryRun(["-hide_banner", "-v", "error", ...OPEN[family]()]);
  if (!open.ok) { out.why = firstLine(open.err) || "the encoder would not open in time"; return out; }
  out.encode = true;
  if (!ARGS[family]) return out; // reported only
  const dir = path.join(deps.tmpdir(), family);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  // test clips made by the CPU (libx264/libx265 when this ffmpeg has them,
  // else by this family's own encoder)
  const clip = async (name, codec) => {
    const f = path.join(dir, name);
    const sw = codec === "h264" ? (have.has("libx264") ? ["-c:v", "libx264", "-preset", "ultrafast"] : ["-c:v", ENCODER[family]])
      : have.has("libx265") ? ["-c:v", "libx265", "-preset", "ultrafast", ...(codec === "hevc10" ? ["-pix_fmt", "yuv420p10le"] : [])]
        : have.has("hevc_nvenc") && family === "nvenc" ? ["-c:v", "hevc_nvenc", ...(codec === "hevc10" ? ["-pix_fmt", "p010le", "-profile:v", "main10"] : [])] : null;
    if (!sw) return null;
    const r = await tryRun(["-hide_banner", "-v", "error", "-y", ...testSrc(1280, 720, 2), "-g", "24", ...sw, f]);
    return r.ok ? f : null;
  };
  const files = { h264: await clip("h264.mp4", "h264"), hevc: await clip("hevc.mp4", "hevc"), hevc10: await clip("hevc10.mp4", "hevc10") };
  if (DECODE_CHAIN[family]) {
    for (const k of Object.keys(files)) {
      if (files[k]) out.decode[k] = (await tryRun(["-hide_banner", "-v", "error", ...DECODE_CHAIN[family](files[k])])).ok;
    }
  }
  // step 3: the ladder's own arguments, as a viewer would get them (from a
  // source the card decodes, if any; from the CPU otherwise)
  const src = files.h264;
  if (src) {
    const onCard = out.decode.h264;
    const a = ARGS[family]({ dims: { w: 640, h: 360 }, rate: { maxrate: 1000, bufsize: 2000 }, level: 30, fmt: null, cq: CQ, onCard });
    const r = await tryRun(["-hide_banner", "-v", "error", ...a.inputArgs, "-i", src, "-map", "0:v:0", ...a.videoArgs, "-f", "mpegts", "-y", path.join(dir, "ladder.ts")]);
    out.chain = r.ok;
    if (!r.ok) out.why = firstLine(r.err) ? `the ladder's arguments failed: ${firstLine(r.err)}` : "the ladder's arguments did not finish in time";
    // how many sessions the driver gives at once (GeForce drivers cap it)
    if (r.ok) {
      const tries = await Promise.all(Array.from({ length: PROBE_PARALLEL }, () => deps.run(["-hide_banner", "-v", "error", ...OPEN[family]()], 3 * PROBE_TIMEOUT_MS)));
      // (only a REFUSAL counts against it: a try that ran out of time on a
      // busy machine says nothing about the driver)
      out.parallel = tries.filter((t) => t.ok || !REFUSAL_RE.test(t.err)).length;
    }
  } else {
    out.why = "no test clip could be made";
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return out;
};

const probe = ({ force = false } = {}) => {
  if (state.probing) return state.probing;
  if (state.result && !force) return Promise.resolve(state.result);
  if (!deps.ffmpeg()) return Promise.resolve((state.result = { at: deps.now(), encoders: {}, why: "no ffmpeg" }));
  state.probing = (async () => {
    const list = await deps.run(["-hide_banner", "-encoders"], 10000);
    const have = listEncoders(list.out);
    const encoders = {};
    const plat = deps.platform();
    encoders.nvenc = await probeFamily("nvenc", have);
    if (plat === "linux") encoders.vaapi = await probeFamily("vaapi", have);
    if (plat === "linux" || plat === "win32") encoders.qsv = await probeFamily("qsv", have);
    if (plat === "darwin") encoders.videotoolbox = await probeFamily("videotoolbox", have);
    state.result = { at: deps.now(), encoders };
    console.log(`[hwenc] ${sentence()}`);
    // a family that exists but ran out of time (a machine too busy to answer)
    // is asked again later, once
    const starved = Object.values(encoders).some((e) => e && e.present && !e.chain && /in time/.test(String(e.why || "")));
    if (starved && !state.retried) {
      state.retried = true;
      const t = setTimeout(() => { probe({ force: true }).catch(() => {}); }, RETRY_PROBE_MS);
      t.unref?.();
    }
    return state.result;
  })().finally(() => { state.probing = null; });
  return state.probing;
};

let started = false;
const start = (delayMs = 40 * 1000) => {
  if (started) return;
  started = true;
  const t = setTimeout(() => { probe().catch(() => {}); }, delayMs);
  t.unref?.();
};

// ---------- using it ----------
// The family in use: the first whose probe ran the ladder's own arguments.
const family = () => {
  const e = state.result && state.result.encoders;
  if (!e) return null;
  for (const k of ["nvenc", "vaapi", "qsv"]) if (e[k] && e[k].chain) return k;
  return null;
};
const busy = () => state.sessions.size;
// How many hardware encodes at once: the admin's number; else what the boot
// check opened at once (PROBE_PARALLEL tried; all of them → SESSIONS_CAP, a
// driver limit below that → one fewer than it, one kept for other programs);
// else DEFAULT_SESSIONS.
const PROBE_PARALLEL = 7;
const SESSIONS_CAP = 6; // 6 × 4K → 1080p at once made 3.7× real time each on the RTX 3090
const capacity = () => {
  const set = deps.sessionsSet();
  if (set) return set;
  const fam = family();
  const n = fam && state.result.encoders[fam].parallel;
  if (n >= PROBE_PARALLEL) return SESSIONS_CAP;
  if (n >= 2) return n - 1;
  return DEFAULT_SESSIONS;
};
const sessionsWhy = () => {
  if (deps.sessionsSet()) return " (set in config)";
  const fam = family();
  const n = fam && state.result.encoders[fam].parallel;
  if (n >= PROBE_PARALLEL) return ` (${n} opened at once in the boot check)`;
  if (n >= 2) return ` (the driver allowed ${n} at once in the boot check; one is kept for other programs)`;
  return " (a cautious default)";
};

// May a NEW hardware rendition be started for this source? (one already being
// made in hardware stays in hardware — ladder.useHw)
// → { ok, why } — `why` is said on the admin page beside the running job.
const decide = (f) => {
  const m = mode();
  if (m === "off") return { ok: false, why: "hardware encoding is switched off" };
  const fam = family();
  if (!fam) return { ok: false, why: state.result ? "no working hardware encoder on this machine" : "the graphics card has not been checked yet" };
  if (m === "auto" && !QUALITY_PROVEN.has(fam)) return { ok: false, why: `${LABEL[fam]} works, but its picture has not been measured against the CPU's ("on" uses it anyway)` };
  if (deps.now() < state.refusedUntil) return { ok: false, why: `the graphics card refused an encode a moment ago (${state.refusedWhy || "?"})` };
  if (busy() >= capacity()) return { ok: false, why: `all ${capacity()} of the graphics card's sessions are in use` };
  if (!(f && f.width > 0 && f.height > 0)) return { ok: false, why: "the source's picture size is not known" };
  return { ok: true, why: `${LABEL[fam]}${gpuDecodes(f, fam) ? ", decoded on the card too" : ", decoded by the CPU (the card cannot decode this source)"} — measured as good as the CPU's encode, for a sliver of the CPU` };
};
const canUse = (f) => decide(f).ok;

// Does the card decode this source, so that every step stays on the card?
const gpuDecodes = (f, fam = family()) => {
  const e = fam && state.result && state.result.encoders && state.result.encoders[fam];
  if (!e || !e.decode || !f) return false;
  const codec = String(f.codec || "").toLowerCase();
  const pix = String(f.pixFmt || "");
  const tenBit = /10|12/.test(pix);
  if (/422|444/.test(pix)) return false;
  if (codec === "h264") return e.decode.h264 && !tenBit;
  if (codec === "hevc") return tenBit ? e.decode.hevc10 : e.decode.hevc;
  return false;
};

// The arguments for one rendition of `f` on the family in use (or `fam`).
const argsFor = (f, { dims, rate, level, fmt = null, cq = CQ, fam = family() } = {}) => {
  if (!fam || !ARGS[fam]) return null;
  const onCard = gpuDecodes(f, fam);
  return { ...ARGS[fam]({ dims, rate, level, fmt, cq, onCard }), onCard, family: fam };
};
// (the NVIDIA arguments by name: the bench and the tests)
const nvencArgs = (f, opts = {}) => argsFor(f, { ...opts, fam: "nvenc" });

const track = (run, proc) => {
  state.sessions.add(run);
  state.used++;
  const done = () => state.sessions.delete(run);
  proc.once("close", done);
  proc.once("error", done);
};

// A hardware producer exited with an error: was it the card refusing (no
// session, out of its memory, no device)? Then software only, for a while.
const REFUSAL_RE = /OpenEncodeSessionEx|out of memory|No capable devices|InitializeEncoder failed|incompatible client key|cuInit|cuCtxCreate|CUDA_ERROR|No NVENC capable|Failed to (?:create|initialise|initialize).*(?:cuda|nvenc|hw|device|session)|vaInitialize|Error creating a MFX session|MFX_ERR|Device creation failed/i;
const noteExit = (code, stderr) => {
  if (!code || !REFUSAL_RE.test(String(stderr || ""))) return false;
  state.refusedUntil = deps.now() + REFUSED_HOLD_MS;
  state.refusedWhy = firstLine(stderr);
  state.fallbacks++;
  console.warn(`[hwenc] the card refused an encode (${state.refusedWhy}) — software for the next ${REFUSED_HOLD_MS / 1000}s`);
  return true;
};

// ---------- for a person ----------
const LABEL = { nvenc: "NVIDIA NVENC", vaapi: "VA-API (Intel/AMD)", qsv: "Intel Quick Sync", videotoolbox: "VideoToolbox" };
const sentence = () => {
  const r = state.result;
  if (!r) return "Hardware encoding: not checked yet.";
  const found = [];
  for (const k of ["nvenc", "vaapi", "qsv", "videotoolbox"]) {
    const e = r.encoders && r.encoders[k];
    if (!e || !e.encode) continue;
    const d = e.decode || {};
    const dec = [d.h264 && "H.264", d.hevc && "HEVC", d.hevc10 && "10-bit HEVC"].filter(Boolean);
    const usable = e.chain ? `works${dec.length ? ` (decodes ${dec.join(", ")} on the card too)` : ""}${e.tested ? "" : " — not yet tried on real hardware by Aurora's makers"}` : `opens, but ${e.why || "the ladder's arguments did not run"} — not used`;
    found.push(`${LABEL[k]} ${ARGS[k] ? usable : "works (detected only — not used)"}`);
  }
  if (!found.length) return "Hardware encoding: none available on this machine — every encode is done by the CPU.";
  const fam = family();
  const m = mode();
  const use = !fam ? "" : m === "off"
    ? ' Not in use (the setting "hwEncode" is "off").'
    : m === "auto" && !QUALITY_PROVEN.has(fam)
      ? ` Not in use: ${LABEL[fam]}'s picture has not been measured against the CPU's ("hwEncode": "on" uses it).`
      : ` In use (${LABEL[fam]}) for the quality ladder's encodes, up to ${capacity()} at once${sessionsWhy()}; HDR sources stay on the CPU.`;
  return `Hardware encoding: ${found.join("; ")}.${use}`;
};

const status = () => ({
  mode: mode(),
  family: family(),
  checked: !!state.result,
  checkedAt: state.result ? state.result.at : null,
  encoders: state.result ? state.result.encoders : null,
  sessions: { running: busy(), max: capacity(), why: sessionsWhy().trim().replace(/^\(|\)$/g, "") },
  refused: deps.now() < state.refusedUntil ? { until: state.refusedUntil, why: state.refusedWhy } : null,
  used: state.used,
  fallbacks: state.fallbacks,
  sentence: sentence(),
});

module.exports = {
  start, probe, mode, family, decide, canUse, QUALITY_PROVEN, LABEL, gpuDecodes, argsFor, nvencArgs, track, noteExit, busy, capacity, status, sentence,
  CQ, DEFAULT_SESSIONS,
  _internals: { deps, state, listEncoders, REFUSAL_RE, firstLine, ARGS,
    reset: () => { state.result = null; state.probing = null; state.refusedUntil = 0; state.sessions.clear(); state.used = 0; state.fallbacks = 0; started = false; },
    setResult: (r) => { state.result = r; },
  },
};
