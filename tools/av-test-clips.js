#!/usr/bin/env node
// Test clips for the picture-and-sound device checks (docs/qa/tv-av/REPORT.md):
// a white bar crossing the screen at a constant speed — on a screen at the
// wrong refresh rate it moves in uneven steps (3:2 judder), at the right one
// it glides — at each film frame rate, with the sound formats passthrough is
// checked with, plus files the TV must NOT be sent as they are.
//
//   node tools/av-test-clips.js <out folder> [--seconds 60]
//
// Put the folder in a library the private test server reads (its
// libraries.movies), rescan, and play each one on the TV. Every clip is its
// own "film" folder so the library lists it by name. Needs ffmpeg on PATH
// (the dca / truehd encoders are ffmpeg's experimental ones: -strict -2).
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const out = process.argv[2];
if (!out) {
  console.error("usage: node tools/av-test-clips.js <out folder> [--seconds 60]");
  process.exit(2);
}
const si = process.argv.indexOf("--seconds");
const SECONDS = si > 0 ? Math.max(5, parseInt(process.argv[si + 1], 10) || 60) : 60;

// a bar 48 px wide, one screen width every 4 s, over a dark screen
const pan = (rate) => ["-f", "lavfi", "-i", `color=c=0x101418:s=1920x1080:r=${rate}:d=${SECONDS}`];
const tone = (layout) => [
  "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
  "-filter_complex", `[0:v]drawbox=x='mod(t*480\,1920)':y=0:w=48:h=1080:color=white:t=fill[v];[1:a]aformat=channel_layouts=${layout}[a]`,
  "-map", "[v]", "-map", "[a]",
];
const H264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
const HEVC10 = ["-c:v", "libx265", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error"];
const HDR10 = ["-c:v", "libx265", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400"];
const AV1 = ["-c:v", "libaom-av1", "-cpu-used", "8", "-crf", "35", "-b:v", "0", "-pix_fmt", "yuv420p"];

const CLIPS = [
  // name, frame rate, video args, audio layout, audio args, container
  ["AV Judder 23.976 EAC3", "24000/1001", H264, "5.1", ["-c:a", "eac3", "-b:a", "640k"], "mkv"],
  ["AV Judder 24 AC3", "24", H264, "5.1", ["-c:a", "ac3", "-b:a", "448k"], "mkv"],
  ["AV Judder 25 AAC", "25", H264, "stereo", ["-c:a", "aac", "-b:a", "192k"], "mp4"],
  ["AV Judder 29.97 AAC", "30000/1001", H264, "stereo", ["-c:a", "aac", "-b:a", "192k"], "mp4"],
  ["AV Judder 50 AAC", "50", H264, "stereo", ["-c:a", "aac", "-b:a", "192k"], "mp4"],
  ["AV Judder 59.94 AAC", "60000/1001", H264, "stereo", ["-c:a", "aac", "-b:a", "192k"], "mp4"],
  ["AV HEVC10 23.976 EAC3", "24000/1001", HEVC10, "5.1", ["-c:a", "eac3", "-b:a", "640k"], "mkv"],
  ["AV HDR10 23.976 AC3", "24000/1001", HDR10, "5.1", ["-c:a", "ac3", "-b:a", "448k"], "mkv"],
  ["AV DTS 23.976", "24000/1001", H264, "5.1", ["-strict", "-2", "-c:a", "dca", "-b:a", "768k"], "mkv"],
  ["AV TrueHD 23.976", "24000/1001", H264, "5.1", ["-strict", "-2", "-c:a", "truehd"], "mkv"],
  ["AV AV1 24 AAC", "24", AV1, "stereo", ["-c:a", "aac", "-b:a", "192k"], "mkv"],
];

for (const [name, rate, v, layout, a, ext] of CLIPS) {
  const dir = path.join(out, `${name} (2026)`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name} (2026).${ext}`);
  if (fs.existsSync(file)) {
    console.log(`have ${file}`);
    continue;
  }
  const args = ["-hide_banner", "-loglevel", "error", "-y", ...pan(rate), ...tone(layout), ...v, ...a, "-shortest", file];
  const t0 = Date.now();
  const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  console.log(`${r.status === 0 ? "made" : "FAILED"} ${file} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
