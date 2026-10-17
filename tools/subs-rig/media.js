// Media for the subtitle timing rig (tools/subs-rig/run.js and
// test/ui/subtitles.test.js): films whose every frame carries its own
// timestamp, and subtitles whose every cue says when it belongs.
//
//   THE PICTURE. The top half of each frame is twelve vertical bars, the
//   binary digits of floor(t * 10), t the frame's time in the SOURCE (least
//   significant bit on the left, white = 1). A page reads them back from a
//   canvas (sampler.js), so "which moment of the film is on screen" is known
//   to a tenth of a second, whatever the player did to the clock.
//
//   THE CUES. Cue i runs from i.0 s to i.8 s of the same source time and its
//   text is "T<i>". A cue's text therefore says which frame it belongs to,
//   and the error of any path is (when the cue is scheduled) − (when the
//   frame it belongs to is shown).
//
// Titles (what each one exercises):
//   Sync Direct (2031).mp4  H.264 + AAC: the browser plays the file itself.
//                           English sidecar .srt.
//   Sync Jit (2032).mkv     H.264 (keyframe every 5 s) + AC-3: no browser can
//                           play the sound, so it goes through the server's
//                           repackaging (jit / hls.js), or — with jit refused —
//                           through the offset copy job (-copyts). Embedded
//                           English track + English sidecar.
//   Sync Late (2033).mkv    the same, with every timestamp moved 1.5 s later
//                           (start_time 1.5 — what a release cut from a TV
//                           capture looks like). Embedded + sidecar.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SECONDS = 90;
const RECIPE = 4; // bump when anything below changes (the cache is keyed by it)

const srt = (seconds) => {
  const t = (s) => {
    const ms = Math.round(s * 1000);
    const hh = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const mm = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
    const ss = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss},${String(ms % 1000).padStart(3, "0")}`;
  };
  let out = "";
  for (let i = 1; i < seconds; i++) out += `${i}\n${t(i)} --> ${t(i + 0.8)}\nT${i}\n\n`;
  return out;
};

// The bar picture: geq paints bar k white when bit k of floor(T*10) is set.
// (Commas inside a filter expression are escaped for the filtergraph parser.)
const BARS =
  "color=c=gray:size=320x180:rate=25:duration=" + SECONDS +
  ",format=gray,geq=lum='if(lt(Y\\,90)\\,16+219*mod(floor(floor(T*10+0.0001)/pow(2\\,floor(X*12/W)))\\,2)\\,128)',format=yuv420p";

const run = (ffmpeg, args) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr || r.error}\n  ffmpeg ${args.join(" ")}`);
};

const H264 = (gop) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0"];
const TONE = ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`];

const TITLES = {
  direct: { folder: "Sync Direct (2031)", file: "Sync Direct (2031).mp4", title: "Sync Direct" },
  jit: { folder: "Sync Jit (2032)", file: "Sync Jit (2032).mkv", title: "Sync Jit" },
  late: { folder: "Sync Late (2033)", file: "Sync Late (2033).mkv", title: "Sync Late", startTime: 1.5 },
};

// Build every title into <dir>/movies/<folder>/ (once: a ready marker per recipe).
const build = (dir, ffmpeg) => {
  const marker = path.join(dir, `.ready-${RECIPE}`);
  if (fs.existsSync(marker)) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  const mk = (t) => { const d = path.join(dir, "movies", t.folder); fs.mkdirSync(d, { recursive: true }); return d; };
  const subs = srt(SECONDS);
  const subFile = path.join(dir, "cues.srt");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(subFile, subs, "utf-8");

  let d = mk(TITLES.direct);
  run(ffmpeg, ["-f", "lavfi", "-i", BARS, ...TONE, ...H264(25), "-c:a", "aac", "-b:a", "96k",
    "-metadata:s:a:0", "language=eng", "-movflags", "+faststart", "-shortest", path.join(d, TITLES.direct.file)]);
  fs.writeFileSync(path.join(d, "Sync Direct (2031).English.srt"), subs, "utf-8");

  for (const key of ["jit", "late"]) {
    const t = TITLES[key];
    d = mk(t);
    run(ffmpeg, ["-f", "lavfi", "-i", BARS, ...TONE, "-i", subFile,
      "-map", "0:v", "-map", "1:a", "-map", "2:0", ...H264(125), "-c:a", "ac3", "-b:a", "128k", "-c:s", "srt",
      "-metadata:s:a:0", "language=eng", "-metadata:s:s:0", "language=eng", "-disposition:s:0", "0",
      ...(t.startTime ? ["-output_ts_offset", String(t.startTime)] : []),
      "-shortest", path.join(d, t.file)]);
    // the sidecar is timed to the picture as the viewer sees it: cue i with frame i
    fs.writeFileSync(path.join(d, `${t.folder}.English.srt`), subs, "utf-8");
  }
  fs.rmSync(subFile);
  fs.writeFileSync(marker, new Date().toISOString());
  return dir;
};

module.exports = { build, TITLES, SECONDS, RECIPE, srt };
