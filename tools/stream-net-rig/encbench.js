#!/usr/bin/env node
// Quality per bit of the ladder's encodes, on a real film's minute: what the
// server makes today (x264 superfast, crf 18 under a ceiling) against slower
// x264 presets, lower ceilings, and x265 — each scored with VMAF (Netflix's
// metric, model v0.6.1) against the source at its own size, the way a viewer
// sees a lower rung: scaled up to the screen.
//
//   node tools/stream-net-rig/encbench.js --src <file> [--at 180] [--sec 60] [--threads 8] [--out results.json]
//
// Every encode runs on --threads threads with the process held to the 8 real
// cores (affinity 0x5555, as the rig holds the server), so the speed column is
// "times real time on an 8-core machine without a graphics card".
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SRC = arg("src");
const AT = Number(arg("at", 180));
const SEC = Number(arg("sec", 60));
const THREADS = Number(arg("threads", 8));
const OUT = arg("out", null);
const ONLY = arg("only", null);
const TMP = arg("tmp", path.join(os.tmpdir(), "aurora-agents", "research-stream-efficiency", "encbench"));
fs.mkdirSync(TMP, { recursive: true });
// this process (and so every ffmpeg it starts) on the 8 real cores 0,2,…,14
if (process.platform === "win32" && arg("cpus8", "1") !== "0") {
  try { require("child_process").execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${0x5555}`], { stdio: "pipe", windowsHide: true }); } catch {}
}

const ff = (args, { time = false } = {}) => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  return time ? ms : r.stderr;
};
const probe = (f) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=bit_rate,duration:stream=width,height", "-select_streams", "v:0", "-of", "json", f], { encoding: "utf8" }).stdout);

// the reference: the source minute, video only, as it is (a copy)
const ref = path.join(TMP, "ref.mkv");
if (!fs.existsSync(ref)) ff(["-ss", String(AT), "-i", SRC, "-t", String(SEC), "-map", "0:v:0", "-c", "copy", ref]);
const rp = probe(ref);
const W = rp.streams[0].width, H = rp.streams[0].height;
const refKbps = Math.round(Number(rp.format.bit_rate) / 1000);

// The candidates. `h`: output height; `args`: the encoder (video only).
const x264 = (preset, crf, max, buf, extra = []) => ["-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-maxrate", `${max}k`, "-bufsize", `${buf}k`, "-pix_fmt", "yuv420p", "-profile:v", "high", ...extra];
const x265 = (preset, crf, max, buf) => ["-c:v", "libx265", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p", "-x265-params", `vbv-maxrate=${max}:vbv-bufsize=${buf}:log-level=error`, "-tag:v", "hvc1"];
const CANDS = [
  // today's rungs (ladder.js CAPS, encVideoArgs): superfast, crf 18, the ceiling decides
  { name: "720p x264 superfast 2200k (today)", h: 720, args: x264("superfast", 18, 2200, 4400) },
  { name: "480p x264 superfast 1000k (today)", h: 480, args: x264("superfast", 18, 1000, 2000) },
  // the same ceilings, slower presets: the bits buy more
  { name: "720p x264 veryfast 2200k", h: 720, args: x264("veryfast", 18, 2200, 4400) },
  { name: "720p x264 medium 2200k", h: 720, args: x264("medium", 18, 2200, 4400) },
  { name: "480p x264 veryfast 1000k", h: 480, args: x264("veryfast", 18, 1000, 2000) },
  { name: "480p x264 medium 1000k", h: 480, args: x264("medium", 18, 1000, 2000) },
  // a smaller ceiling, a slower preset: the same picture for fewer bits?
  { name: "720p x264 medium 1500k", h: 720, args: x264("medium", 20, 1500, 3000) },
  { name: "480p x264 medium 700k", h: 480, args: x264("medium", 21, 700, 1400) },
  // the rung that does not exist yet: for a 1.5 Mbit/s line
  { name: "360p x264 veryfast 500k", h: 360, args: x264("veryfast", 21, 500, 1000) },
  { name: "360p x264 medium 500k", h: 360, args: x264("medium", 21, 500, 1000) },
  { name: "540p x264 medium 1100k", h: 540, args: x264("medium", 21, 1100, 2200) },
  // HEVC (iPhone, Mi TV, Android, Chrome with hardware HEVC): the same picture at ~60%?
  { name: "720p x265 fast 1300k", h: 720, args: x265("fast", 22, 1300, 2600) },
  { name: "480p x265 fast 600k", h: 480, args: x265("fast", 23, 600, 1200) },
  { name: "1080p x265 fast 2000k", h: 0, args: x265("fast", 22, 2000, 4000) },
  { name: "1080p x264 medium 3000k", h: 0, args: x264("medium", 20, 3000, 6000) },
];

const results = { src: path.basename(SRC), at: AT, sec: SEC, threads: THREADS, size: `${W}x${H}`, refKbps, rows: [] };
const vmaf = (dist) => {
  // the rung scaled up to the source's size (bicubic, as a player would), then scored
  const log = path.join(TMP, "vmaf.json");
  const logArg = log.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\\\:");
  ff(["-i", dist, "-i", ref, "-lavfi", `[0:v]scale=${W}:${H}:flags=bicubic,setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]libvmaf=log_fmt=json:log_path='${logArg}':n_threads=${THREADS}`, "-f", "null", "-"]);
  const j = JSON.parse(fs.readFileSync(log, "utf8"));
  const pooled = j.pooled_metrics && j.pooled_metrics.vmaf;
  const frames = (j.frames || []).map((f) => f.metrics.vmaf).sort((a, b) => a - b);
  return { mean: pooled ? +pooled.mean.toFixed(2) : null, p5: frames.length ? +frames[Math.floor(frames.length * 0.05)].toFixed(2) : null };
};
for (const c of CANDS) {
  if (ONLY && !c.name.includes(ONLY)) continue;
  const out = path.join(TMP, c.name.replace(/[^a-z0-9]+/gi, "_") + ".mkv");
  const vf = c.h ? ["-vf", `scale=-2:${c.h}`] : [];
  const ms = ff(["-threads", "4", "-i", ref, ...vf, ...c.args, "-threads", String(THREADS), "-an", out], { time: true });
  const p = probe(out);
  const kbps = Math.round(Number(p.format.bit_rate) / 1000);
  const v = vmaf(out);
  const row = { name: c.name, height: p.streams[0].height, kbps, vmaf: v.mean, vmafP5: v.p5, speedX: +((SEC * 1000) / ms).toFixed(2) };
  results.rows.push(row);
  console.log(`${c.name.padEnd(36)} ${String(kbps).padStart(5)} kbit/s  VMAF ${String(v.mean).padStart(6)} (5th pct ${v.p5})  ${row.speedX}x real time`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
}
console.log(`source ${W}x${H} ${refKbps} kbit/s, ${SEC}s from ${AT}s`);
