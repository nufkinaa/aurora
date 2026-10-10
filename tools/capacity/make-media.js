#!/usr/bin/env node
// Test media for the capacity benches — made with ffmpeg's own sources, kept
// in CAP_WORK/media (outside the repo). Run once; files that exist are kept.
//
//   node tools/capacity/make-media.js [--force]
//
// The picture is testsrc2 (moving shapes, gradients, a running clock) with
// temporal noise on top, so the encoders have residual to code the way they
// do with film grain. It is NOT a film: see REPORT.md "method and its limits".
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { FFMPEG, MEDIA } = require("./lib");

const force = process.argv.includes("--force");
const NOISE = process.env.CAP_NOISE || "8";
const pic = (size, secs, pixfmt) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=24:duration=${secs},noise=alls=${NOISE}:allf=t+u,format=${pixfmt}`];
// 5.1 sound that is not silence (silence costs an audio encoder nothing)
const sound51 = (secs) => ["-f", "lavfi", "-i", `anoisesrc=color=pink:sample_rate=48000:duration=${secs}:amplitude=0.3,pan=5.1|c0=c0|c1=0.8*c0|c2=0.5*c0|c3=0.3*c0|c4=0.6*c0|c5=0.4*c0`];
const stereo = (secs) => ["-f", "lavfi", "-i", `anoisesrc=color=pink:sample_rate=48000:duration=${secs}:amplitude=0.3,pan=stereo|c0=c0|c1=0.9*c0`];

const srt = (secs) => {
  const t = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")},000`;
  let out = "";
  for (let i = 0, n = 1; i + 2 <= secs; i += 3, n++) out += `${n}\n${t(i)} --> ${t(i + 2)}\nLine ${n} of the test subtitles\n\n`;
  return out;
};

const make = (name, args) => {
  const out = path.join(MEDIA, name);
  if (!force && fs.existsSync(out) && fs.statSync(out).size > 1000) return console.log(`  kept   ${name}`);
  const t0 = Date.now();
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args, out], { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`  made   ${name}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
};

const S1080 = 60, S2160 = 40;
const subs = path.join(MEDIA, "subs.srt");
fs.writeFileSync(subs, srt(S1080));
const X264 = (rate) => ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-b:v", `${rate}M`, "-maxrate", `${rate * 1.5}M`, "-bufsize", `${rate * 2}M`, "-g", "120", "-pix_fmt", "yuv420p"];
const X265 = (rate, extra = "") => ["-c:v", "libx265", "-preset", "ultrafast", "-b:v", `${rate}M`, "-x265-params", `log-level=error:keyint=120:vbv-maxrate=${rate * 1500}:vbv-bufsize=${rate * 2000}${extra}`, "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1"];

console.log(`Test media in ${MEDIA}`);
// A. the everyday file: H.264 1080p ~8 Mbit, AC-3 5.1 (no browser decodes it) + a stereo AAC dub, text subtitles
make("h264-1080p-8M.mkv", [...pic("1920x1080", S1080, "yuv420p"), ...sound51(S1080), ...stereo(S1080), "-i", subs,
  "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:0", ...X264(8),
  "-c:a:0", "ac3", "-b:a:0", "384k", "-c:a:1", "aac", "-b:a:1", "128k", "-c:s", "srt",
  "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=heb", "-metadata:s:s:0", "language=eng"]);
// B. the same picture as a browser-playable MP4 (direct play)
make("h264-1080p-8M.mp4", ["-i", path.join(MEDIA, "h264-1080p-8M.mkv"), "-map", "0:v", "-map", "0:a:1", "-c", "copy", "-movflags", "+faststart"]);
// F. the common "x265 10-bit 1080p" release: phones and most browsers need a full H.264 encode of it
make("hevc-1080p-10bit-6M.mkv", [...pic("1920x1080", S1080, "yuv420p10le"), ...sound51(S1080), "-map", "0:v", "-map", "1:a", ...X265(6), "-c:a", "eac3", "-b:a", "384k"]);
// C. 4K HEVC 10-bit SDR ~25 Mbit
make("hevc-2160p-10bit-25M.mkv", [...pic("3840x2160", S2160, "yuv420p10le"), ...sound51(S2160), "-map", "0:v", "-map", "1:a", ...X265(25), "-c:a", "eac3", "-b:a", "640k"]);
// D. 4K HEVC HDR10 ~40 Mbit (PQ / BT.2020 tags, mastering metadata), DTS sound
make("hevc-2160p-hdr10-40M.mkv", [...pic("3840x2160", S2160, "yuv420p10le"), ...sound51(S2160), "-map", "0:v", "-map", "1:a",
  ...X265(40, ":colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:hdr10=1:repeat-headers=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400"),
  "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
  "-c:a", "dca", "-strict", "-2", "-b:a", "1509k"]);
// a poster-sized and a backdrop-sized picture for the image-variant bench
make("poster.jpg", ["-f", "lavfi", "-i", "testsrc2=size=1000x1500:rate=1:duration=1,noise=alls=10", "-frames:v", "1", "-q:v", "3"]);
make("backdrop.jpg", ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=1:duration=1,noise=alls=10", "-frames:v", "1", "-q:v", "3"]);
console.log("done");
