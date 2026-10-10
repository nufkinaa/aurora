#!/usr/bin/env node
// How fast is each ffmpeg job Aurora starts, and what does it cost?
//
//   node tools/capacity/ffmpeg-bench.js [--emulate host|10400|10210u] [--repeat 2]
//        [--only <substring>] [--sweep 1,2,3,4,6] [--sweep-case h264-1080p-from-hevc1080]
//        [--no-single] [--tag name]
//
// The command lines are NOT retyped here: they are built by the server's own
// modules (src/media/jit.js producerArgs, ladder.js encFor, remux.js
// videoArgsFor, tonemap.js, offline.js argsFor, lib/imgvariant.js), so what
// is timed is what a viewer's request starts. Only `-threads` is replaced
// when a smaller CPU is emulated (the server derives it from the core count).
//
// --emulate pins this process and every ffmpeg it starts to the first N
// logical CPUs (12 = 6C/12T for an i5-10400, 8 = 4C/8T for an i5-10210U) —
// same core design as this machine's i7-10700K, so what is left to scale is
// clock speed (REPORT.md has the factors).
//
// Reported per job: speed (film seconds per wall second), CPU seconds per
// film second (from ffmpeg -benchmark: the OS's accounting of that process —
// holds on a busy machine), average cores in use, peak memory, and how busy
// the whole machine was meanwhile.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REPO, MEDIA, OUT, FFMPEG, runFfmpeg, probeDuration, pinTo, rmrf, round, saveJson } = require("./lib");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const EMU = {
  host: { logical: os.cpus().length, label: `this machine (${os.cpus()[0].model.trim()}, ${os.cpus().length} threads)` },
  10400: { logical: 12, label: "i5-10400 shape: 6C/12T of this machine" },
  "10210u": { logical: 8, label: "i5-10210U shape: 4C/8T of this machine" },
};
const emuName = String(arg("emulate", "host")).toLowerCase();
const emu = EMU[emuName];
if (!emu) { console.error("unknown --emulate"); process.exit(1); }
// What the server would compute on a machine with that many logical CPUs:
const ENC_THREADS = Math.max(2, Math.floor(emu.logical / 2)); // ladder.js
const REMUX_THREADS = Math.max(1, emu.logical - 2); // remux.js, torrent-transcode.js
const withThreads = (args, n) => {
  const a = [...args];
  const i = a.indexOf("-threads");
  if (i >= 0) a[i + 1] = String(n);
  return a;
};

const repeat = parseInt(arg("repeat", "2"), 10);
const only = arg("only", "");
const tag = arg("tag", emuName);

const main = async () => {
  if (emuName !== "host" && !pinTo(emu.logical)) console.warn("could not pin CPUs — results are for the whole machine");
  process.env.AURORA_TONEMAP = "force"; // time the chain even where the speed gate would decline it
  const ladder = require(path.join(REPO, "src/media/ladder"));
  const jit = require(path.join(REPO, "src/media/jit"));
  const remux = require(path.join(REPO, "src/media/remux"));
  const tonemap = require(path.join(REPO, "src/media/tonemap"));
  const offline = require(path.join(REPO, "src/media/offline"));
  const imgvariant = require(path.join(REPO, "src/lib/imgvariant"));

  const src = (n) => path.join(MEDIA, n);
  const A = src("h264-1080p-8M.mkv"), F = src("hevc-1080p-10bit-6M.mkv"), C = src("hevc-2160p-10bit-25M.mkv"), D = src("hevc-2160p-hdr10-40M.mkv");
  for (const f of [A, F, C, D]) if (!fs.existsSync(f)) { console.error(`missing ${f} — run make-media.js`); process.exit(1); }
  const support = await tonemap.probeSupport();

  // One jit producer (what /stream/transcode/:id/jit/segNNNNN starts), from the top of the file.
  const jitCase = async (file, rendition, { top = "copy", tm = true } = {}) => {
    const key = `${path.basename(file)}-${rendition}-${tm}`;
    let enc = null;
    if (rendition !== "copy") {
      const f = await ladder.probe(key, file);
      const rung = ladder.describe({ facts: f, top: rendition === "h264" ? "h264" : top, lower: true, anyRate: true }).find((r) => r.name === rendition);
      if (!rung) throw new Error(`no rung ${rendition} for ${file}`);
      if (!tm) process.env.AURORA_TONEMAP = "0";
      enc = await ladder.encFor(rung, f, { fmt: null, busy: false, label: "" });
      process.env.AURORA_TONEMAP = "force";
    }
    return (outDir) => {
      const run = { fmt: null, pdir: outDir };
      const input = { url: file, extra: [], fmt: null, vtagHvc1: false, audio: 0, enc };
      return withThreads(jit._internals.producerArgs(run, input, null), ENC_THREADS);
    };
  };
  // The older single-rendition job (remux.js ensure): same encoder, hls muxer, cpus-2 threads.
  const remuxCase = (file, vcodec) => (outDir) => withThreads([
    "-v", "error", "-i", file, "-map", "0:v:0", "-map", "0:a:0",
    ...remux._internals.videoArgsFor(vcodec, null),
    "-c:a", "aac", "-ac", "2", "-b:a", "192k",
    "-af", vcodec === "copy" ? "volume=4dB,alimiter=limit=0.7:level=disabled:latency=true" : "aresample=async=1:first_pts=0,volume=4dB,alimiter=limit=0.7:level=disabled:latency=true",
    "-muxdelay", "0", "-muxpreload", "0", "-f", "hls", "-hls_time", "6", "-hls_init_time", "2",
    "-hls_playlist_type", "event", "-hls_flags", "independent_segments+temp_file",
    "-hls_segment_filename", path.join(outDir, "seg%05d.ts"), path.join(outDir, "index.m3u8"),
  ], REMUX_THREADS);

  const cases = [
    // ---- viewer-facing (jit: one producer per rendition per viewer position) ----
    { name: "copy-1080p-h264 (remux: video copied, AC-3 -> AAC)", file: A, args: await jitCase(A, "copy") },
    { name: "copy-2160p-hevc (remux: video copied, E-AC-3 -> AAC)", file: C, args: await jitCase(C, "copy") },
    { name: "h264-720-from-h264-1080 (ladder rung)", file: A, args: await jitCase(A, "h264-720") },
    { name: "h264-480-from-h264-1080 (ladder rung)", file: A, args: await jitCase(A, "h264-480") },
    { name: "h264-1080p-from-hevc1080 (full encode, device cannot decode HEVC)", file: F, args: await jitCase(F, "h264") },
    { name: "h264-720-from-hevc1080", file: F, args: await jitCase(F, "h264-720", { top: "h264" }) },
    { name: "h264-1080p-from-hevc2160 SDR (4K folded to 1080p)", file: C, args: await jitCase(C, "h264") },
    { name: "h264-720-from-hevc2160 SDR", file: C, args: await jitCase(C, "h264-720", { top: "h264" }) },
    { name: "h264-1080p-from-hevc2160 HDR10 tone-mapped", file: D, args: await jitCase(D, "h264") },
    { name: "h264-1080p-from-hevc2160 HDR10 NOT tone-mapped", file: D, args: await jitCase(D, "h264", { tm: false }) },
    { name: "h264-720-from-hevc2160 HDR10 tone-mapped", file: D, args: await jitCase(D, "h264-720", { top: "h264" }) },
    // ---- the older single-rendition path (remux.js) ----
    { name: "legacy-h264-from-hevc1080 (remux.js, hls muxer)", file: F, args: remuxCase(F, "h264") },
    // ---- background work that competes with viewers ----
    { name: "bg offline/preconvert 1080 (veryfast crf23, all threads, normal priority)", file: F, args: (o) => offline._internals.argsFor(F, path.join(o, "out.mp4"), "1080", {}) },
    { name: "bg subtitle extract (embedded srt -> webvtt)", file: A, args: (o) => ["-v", "error", "-i", A, "-map", "0:s:0", "-f", "webvtt", path.join(o, "s.vtt")] },
    { name: "bg intro fingerprint audio decode (8 kHz mono pcm)", file: A, args: (o) => ["-v", "error", "-nostdin", "-i", A, "-t", "600", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", path.join(o, "a.pcm")] },
    { name: "bg intro blackdetect (video decode, 5 fps 160px)", file: A, args: () => ["-nostdin", "-v", "info", "-i", A, "-an", "-sn", "-vf", "fps=5,scale=160:-2,blackdetect=d=0.3:pic_th=0.92:pix_th=0.12", "-f", "null", "-"] },
    // ---- pictures (lib/imgvariant.js) ----
    { name: "img variant poster w=256 webp", file: null, frames: 1, args: (o) => ["-v", "error", "-i", src("poster.jpg"), "-vf", imgvariant.filterFor(256, 0, ""), "-frames:v", "1", ...imgvariant.codecFor("x.webp", 256, 0), path.join(o, "p.webp")] },
    { name: "img variant backdrop w=1280 webp", file: null, frames: 1, args: (o) => ["-v", "error", "-i", src("backdrop.jpg"), "-vf", imgvariant.filterFor(1280, 0, ""), "-frames:v", "1", ...imgvariant.codecFor("x.webp", 1280, 0), path.join(o, "b.webp")] },
    { name: "img variant backdrop w=1280 blur=8 jpg", file: null, frames: 1, args: (o) => ["-v", "error", "-i", src("backdrop.jpg"), "-vf", imgvariant.filterFor(1280, 8, ""), "-frames:v", "1", ...imgvariant.codecFor("x.jpg", 1280, 8), path.join(o, "bb.jpg")] },
    { name: "still frame (scale 1280, seek 20s)", file: null, frames: 1, args: (o) => ["-v", "error", "-ss", "20", "-i", A, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", path.join(o, "s.jpg")] },
    { name: "ffprobe-equivalent open (probe cost stand-in: read header)", file: null, frames: 1, args: () => ["-v", "error", "-i", A, "-t", "0", "-f", "null", "-"] },
  ];

  const runCase = async (c, idx = 0) => {
    const outDir = path.join(OUT, `bench-${process.pid}-${idx}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(outDir, { recursive: true });
    const r = await runFfmpeg(c.args(outDir));
    let outBytes = 0;
    try { for (const f of fs.readdirSync(outDir)) outBytes += fs.statSync(path.join(outDir, f)).size; } catch {}
    rmrf(outDir);
    const dur = c.file ? probeDuration(c.file) : 0;
    return {
      ok: r.code === 0, err: r.err,
      filmSec: round(dur, 1),
      wallSec: round(r.rtime, 2),
      speed: dur ? round(dur / r.rtime, 2) : null,
      fps: dur ? round((dur * 24) / r.rtime, 1) : null,
      cpuSec: round(r.cpu, 2),
      cpuPerFilmSec: dur && r.cpu != null ? round(r.cpu / dur, 3) : null,
      coresUsed: r.cpu != null ? round(r.cpu / r.rtime, 2) : null,
      maxrssMb: r.maxrssMb,
      outMbit: dur ? round((outBytes * 8) / dur / 1e6, 2) : null,
      sysBusy: round(r.sysBusy, 2),
      // CPUs busy with OTHER work meanwhile, in logical CPUs
      othersBusyCpus: r.cpu != null ? round((r.sysBusySec - r.cpu) / r.rtime, 1) : null,
    };
  };

  const report = {
    when: new Date().toISOString(),
    host: { cpu: os.cpus()[0].model.trim(), logical: os.cpus().length, memGb: round(os.totalmem() / 1024 ** 3, 1), platform: process.platform, ffmpeg: FFMPEG },
    emulate: emuName, emulateLabel: emu.label, logicalUsed: emu.logical, encThreads: ENC_THREADS, remuxThreads: REMUX_THREADS,
    tonemapSupport: support,
    tonemapAutoDecision: {
      "2160p->1080p idle": tonemap.decide({ transfer: "smpte2084", primaries: "bt2020", matrix: "bt2020nc", width: 3840, height: 2160, fps: 24, outHeight: 0, available: support, env: {} }),
      "2160p->1080p busy": tonemap.decide({ transfer: "smpte2084", primaries: "bt2020", matrix: "bt2020nc", width: 3840, height: 2160, fps: 24, outHeight: 0, available: support, busy: true, env: {} }),
      "2160p->720p idle": tonemap.decide({ transfer: "smpte2084", primaries: "bt2020", matrix: "bt2020nc", width: 3840, height: 2160, fps: 24, outHeight: 720, available: support, env: {} }),
    },
    single: [], sweep: [],
  };
  for (const k of Object.keys(report.tonemapAutoDecision)) { const d = report.tonemapAutoDecision[k]; report.tonemapAutoDecision[k] = { why: d.why, speed: round(d.speed, 2), need: d.need || null }; }
  console.log(`\nffmpeg bench — ${emu.label}; ladder threads ${ENC_THREADS}, legacy threads ${REMUX_THREADS}; tone-map filter ${support.ok ? support.mpps + " MP/s" : "unavailable"}\n`);

  if (!has("no-single")) {
    console.log("job".padEnd(72), "speed  fps   cpu-s/film-s  cores  rssMB  outMbit  othersBusy");
    for (const c of cases) {
      if (only && !c.name.includes(only)) continue;
      const runs = [];
      for (let i = 0; i < repeat; i++) runs.push(await runCase(c));
      const good = runs.filter((r) => r.ok);
      // the FASTEST run is what the machine can do; CPU cost is the smallest seen
      const best = good.sort((a, b) => a.wallSec - b.wallSec)[0] || runs[0];
      const minCpu = good.length ? Math.min(...good.map((r) => r.cpuSec)) : null;
      const row = { name: c.name, ...best, cpuSecMin: minCpu, cpuPerFilmSecMin: best.filmSec ? round(minCpu / best.filmSec, 3) : null, runs: runs.length };
      report.single.push(row);
      console.log(c.name.slice(0, 71).padEnd(72), String(row.speed ?? `${row.wallSec}s`).padEnd(6), String(row.fps ?? "-").padEnd(5), String(row.cpuPerFilmSecMin ?? row.cpuSecMin).padEnd(13), String(row.coresUsed).padEnd(6), String(row.maxrssMb).padEnd(6), String(row.outMbit ?? "-").padEnd(8), row.othersBusyCpus, row.ok ? "" : `FAILED ${row.err}`);
    }
  }

  // N of the same job at once: where does each one stop keeping up with the film?
  const sweepList = String(arg("sweep", "")).split(",").map((s) => parseInt(s, 10)).filter((n) => n > 0);
  const sweepNames = String(arg("sweep-case", "h264-1080p-from-hevc1080,h264-720-from-h264-1080")).split(",");
  for (const sn of sweepNames) {
    const c = cases.find((x) => x.name.startsWith(sn));
    if (!c || !sweepList.length) continue;
    console.log(`\nconcurrent: ${c.name}`);
    console.log("  N   min speed  avg speed  total cores  othersBusy");
    for (const n of sweepList) {
      const rs = await Promise.all(Array.from({ length: n }, (_, i) => runCase(c, i)));
      const speeds = rs.map((r) => r.speed || 0);
      const row = {
        case: c.name, n,
        minSpeed: Math.min(...speeds), avgSpeed: round(speeds.reduce((a, b) => a + b, 0) / n, 2),
        totalCores: round(rs.reduce((a, r) => a + (r.coresUsed || 0), 0), 1),
        cpuPerFilmSec: round(rs.reduce((a, r) => a + (r.cpuPerFilmSec || 0), 0) / n, 3),
        rssMbEach: Math.max(...rs.map((r) => r.maxrssMb || 0)),
        othersBusyCpus: round(rs.reduce((a, r) => a + (r.othersBusyCpus || 0), 0) / n - rs.reduce((a, r) => a + (r.coresUsed || 0), 0) * (n - 1) / n, 1),
        failed: rs.filter((r) => !r.ok).length,
      };
      report.sweep.push(row);
      console.log(`  ${String(n).padEnd(3)} ${String(row.minSpeed).padEnd(10)} ${String(row.avgSpeed).padEnd(10)} ${String(row.totalCores).padEnd(12)} ${row.othersBusyCpus}${row.failed ? `  (${row.failed} failed)` : ""}`);
    }
  }

  const f = saveJson(`ffmpeg-bench-${tag}.json`, report);
  console.log(`\nsaved ${f}`);
  process.exit(0);
};
main().catch((e) => { console.error(e); process.exit(1); });
