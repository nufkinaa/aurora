#!/usr/bin/env node
// Test media for the time-to-first-frame harness (tools/ttff/README.md).
//
//   node tools/ttff/media.js          build what is missing into tools/ttff/.media/
//   node tools/ttff/media.js --list   what is there, with sizes and shapes
//
// Synthetic pictures (ffmpeg's testsrc2 under film grain, so the bitrate is
// spent the way a film spends it) in the SHAPES the owner's library has —
// read off its metadata, 2026-10-10: 1080p at 2–3 Mbit/s, keyframes up to
// 10 s apart, MP4 (H.264 + AAC) with the index at the front OR at the end
// (half of each), MKV with HEVC / H.264 and E-AC-3 / AC-3 / AAC sound.
// Nothing here is the owner's: no real file is copied, read or served.
//
// The folder is git-ignored and is given to the private test instance as its
// library (run.js), never copied.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, ".media");
const VERSION = 2; // bump when a recipe changes

const find = (name) => {
  const env = process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
  if (env && fs.existsSync(env)) return env;
  const win = process.platform === "win32";
  try {
    return execFileSync(win ? "where" : "which", [win ? `${name}.exe` : name], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch { return null; }
};
const FFMPEG = find("ffmpeg");
const FFPROBE = find("ffprobe");

const ff = (args) => {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf-8", windowsHide: true, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr || r.error}\n  ffmpeg ${args.join(" ")}`);
};

const FPS = "24000/1001";
// A picture that costs bits: the moving test card under temporal noise.
// `seed`: every title its own grain and its own sound — identical episodes
// would read as one long intro to the server's intro detection.
const picture = (seconds, seed, size = "1920x1080") => [
  "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${FPS}:duration=${seconds},hue=h=${(seed * 47) % 360},noise=alls=12:allf=t:all_seed=${1000 + seed},format=yuv420p`,
];
const sound = (seconds, seed) => ["-f", "lavfi", "-i", `anoisesrc=color=pink:sample_rate=48000:duration=${seconds}:amplitude=0.2:seed=${1000 + seed}`];
// H.264 High 8-bit, the way a release is encoded: B-frames, a keyframe every
// `gop` seconds (no scene cuts in a test card, so every GOP is that long —
// the worst case a real file has, and a common one).
const h264 = (kbps, gopSec) => [
  "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
  "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.5)}k`, "-bufsize", `${kbps * 2}k`,
  "-g", String(Math.round(gopSec * 24)), "-keyint_min", String(Math.round(gopSec * 24)), "-sc_threshold", "0", "-bf", "3",
];
const hevc10 = (kbps, gopSec) => [
  "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
  "-b:v", `${kbps}k`,
  "-x265-params", `keyint=${Math.round(gopSec * 24)}:min-keyint=${Math.round(gopSec * 24)}:scenecut=0:vbv-maxrate=${Math.round(kbps * 1.5)}:vbv-bufsize=${kbps * 2}:log-level=error`,
];
const AAC = ["-c:a", "aac", "-b:a", "128k", "-ac", "2"];
const AC3 = ["-c:a", "ac3", "-b:a", "640k", "-ac", "6"];
const EAC3 = ["-c:a", "eac3", "-b:a", "640k", "-ac", "6"];

const srt = (seconds) => {
  const t = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")},000`;
  let out = "";
  for (let i = 0, n = 1; i + 3 <= seconds; i += 4, n++) out += `${n}\n${t(i)} --> ${t(i + 3)}\nLine ${n}\n\n`;
  return out;
};

// Each title: a short master is encoded once, then repeated to the wanted
// length as a stream copy (minutes of film in seconds of work).
//   key      the short name run.js and the report use
const TITLES = [
  // --- plays as the file itself ---
  { key: "mp4-fast", title: "Ttff Alpha (2001)", ext: "mp4", video: h264(2400, 10), audio: AAC, base: 600, loops: 6, mov: ["-movflags", "+faststart"],
    why: "MP4 H.264 + AAC, 1080p 2.5 Mbit/s, 60 min, index (moov) at the FRONT — direct play" },
  { key: "mp4-tail", title: "Ttff Bravo (2002)", from: "mp4-fast", ext: "mp4", mov: [],
    why: "the same film with the index at the END, as half the owner's MP4s have it — direct play" },
  { key: "mkv-aac", title: "Ttff Charlie (2003)", from: "mp4-fast", ext: "mkv",
    why: "the same streams in MKV — Chrome plays it as the file itself; a phone cannot" },
  // --- repackaged: video copied, sound re-encoded ("jit", the quality ladder) ---
  { key: "mkv-ac3", title: "Ttff Delta (2004)", ext: "mkv", video: h264(2400, 10), audio: AC3, base: 600, loops: 6, subs: true,
    why: "MKV H.264 + AC-3 5.1, 2.5 Mbit/s video, 60 min, keyframes 10 s apart, an embedded subtitle" },
  { key: "mkv-ac3-8m-g2", title: "Ttff Echo (2005)", ext: "mkv", video: h264(8000, 2), audio: AC3, base: 180, loops: 1,
    why: "MKV H.264 + AC-3, 8 Mbit/s, 3 min, keyframes 2 s apart" },
  { key: "mkv-ac3-8m-g5", title: "Ttff Foxtrot (2006)", ext: "mkv", video: h264(8000, 5), audio: AC3, base: 180, loops: 1,
    why: "…keyframes 5 s apart" },
  { key: "mkv-ac3-8m-g10", title: "Ttff Golf (2007)", ext: "mkv", video: h264(8000, 10), audio: AC3, base: 180, loops: 1,
    why: "…keyframes 10 s apart" },
  // --- video this browser may not decode ---
  { key: "mkv-hevc10", title: "Ttff Hotel (2008)", ext: "mkv", video: hevc10(2400, 5), audio: EAC3, base: 300, loops: 4, subs: true,
    why: "MKV HEVC Main10 + E-AC-3 5.1, 2.5 Mbit/s, 20 min, keyframes 5 s apart" },
  // --- shows, for Next episode ---
  ...[1, 2, 3].map((e) => ({
    key: `ep${e}`, show: "Ttff Show", season: 1, episode: e, ext: "mkv", video: h264(2400, 5), audio: EAC3, base: 150, loops: 1,
    why: `episode ${e}: MKV H.264 + E-AC-3, 2.5 Mbit/s, 2½ min`,
  })),
  ...[1, 2].map((e) => ({
    key: `ep${e}-mp4`, show: "Ttff Direct Show", season: 1, episode: e, ext: "mp4", video: h264(2400, 5), audio: AAC, base: 150, loops: 1, mov: ["-movflags", "+faststart"],
    why: `episode ${e}: MP4 H.264 + AAC, direct play`,
  })),
];

const fileOf = (t) => {
  if (t.show) {
    const name = `${t.show} S${String(t.season).padStart(2, "0")}E${String(t.episode).padStart(2, "0")}`;
    return path.join(ROOT, "shows", t.show, `Season ${t.season}`, `${name}.${t.ext}`);
  }
  return path.join(ROOT, "movies", t.title, `${t.title}.${t.ext}`);
};

const build = ({ quiet = false } = {}) => {
  if (!FFMPEG) throw new Error("ffmpeg was not found on PATH (or FFMPEG_PATH)");
  const stamp = path.join(ROOT, `.v${VERSION}`);
  if (!fs.existsSync(stamp)) fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(stamp, new Date().toISOString());
  const tmp = path.join(ROOT, ".tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const subFile = path.join(tmp, "subs.srt");
  TITLES.forEach((t, seed) => {
    const out = fileOf(t);
    if (fs.existsSync(out)) return;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const t0 = Date.now();
    const part = `${out}.part.${t.ext}`;
    if (t.from) {
      // the same streams, another wrapper
      ff(["-i", fileOf(TITLES.find((x) => x.key === t.from)), "-map", "0", "-c", "copy", ...(t.mov || []), part]);
    } else {
      const master = path.join(tmp, `${t.key}.${t.ext === "mp4" ? "mp4" : "mkv"}`);
      ff([...picture(t.base, seed), ...sound(t.base, seed), ...t.video, ...t.audio, "-metadata:s:a:0", "language=eng", "-shortest", master]);
      const total = t.base * t.loops;
      const inputs = ["-stream_loop", String(t.loops - 1), "-i", master];
      if (t.subs) {
        fs.writeFileSync(subFile, srt(total));
        ff([...inputs, "-i", subFile, "-map", "0:v", "-map", "0:a", "-map", "1:0", "-c", "copy", "-c:s", "srt",
          "-metadata:s:s:0", "language=eng", "-disposition:s:0", "0", part]);
      } else {
        ff([...inputs, "-map", "0", "-c", "copy", ...(t.mov || []), part]);
      }
      fs.rmSync(master, { force: true });
    }
    fs.renameSync(part, out);
    if (!quiet) console.log(`  ${t.key.padEnd(16)} ${(fs.statSync(out).size / 1e6).toFixed(0).padStart(5)} MB  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${t.why}`);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return ROOT;
};

// Where an MP4 keeps its index: the order of its top-level boxes.
const mp4Boxes = (file) => {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const b = Buffer.alloc(16);
    const out = [];
    let pos = 0;
    while (pos < size && out.length < 8) {
      fs.readSync(fd, b, 0, 16, pos);
      let n = b.readUInt32BE(0);
      if (n === 1) n = Number(b.readBigUInt64BE(8));
      if (n < 8) break;
      out.push({ type: b.toString("latin1", 4, 8), at: pos, size: n });
      pos += n;
    }
    return out;
  } finally { fs.closeSync(fd); }
};

const list = () => {
  for (const t of TITLES) {
    const f = fileOf(t);
    if (!fs.existsSync(f)) { console.log(`${t.key.padEnd(16)} (not built)`); continue; }
    const size = fs.statSync(f).size;
    let shape = "";
    try {
      const j = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration,bit_rate:stream=codec_name,profile,pix_fmt,width,height,channels", "-of", "json", f], { encoding: "utf-8" }));
      const v = j.streams.find((s) => s.width);
      const a = j.streams.find((s) => s.channels);
      shape = `${(+j.format.duration / 60).toFixed(1)} min  ${(+j.format.bit_rate / 1e6).toFixed(2)} Mbit/s  ${v.codec_name} ${v.profile} ${v.pix_fmt} ${v.width}x${v.height}  ${a.codec_name} ${a.channels}ch`;
    } catch {}
    let boxes = "";
    if (t.ext === "mp4") boxes = "  boxes: " + mp4Boxes(f).map((b) => `${b.type}(${b.size > 1e6 ? (b.size / 1e6).toFixed(1) + "MB" : b.size})`).join(" ");
    console.log(`${t.key.padEnd(16)} ${(size / 1e6).toFixed(0).padStart(5)} MB  ${shape}${boxes}`);
  }
};

module.exports = { build, list, TITLES, ROOT, fileOf, mp4Boxes, FFMPEG, FFPROBE };

if (require.main === module) {
  if (process.argv.includes("--list")) list();
  else { console.log(`building test media in ${ROOT}`); build(); list(); }
}
