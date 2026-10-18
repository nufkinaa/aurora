#!/usr/bin/env node
// SOFTWARE x264 AGAINST THE GRAPHICS CARD, for the quality ladder's encodes.
// For each clip and rung: the ladder's own libx264 arguments
// (ladder._internals.encVideoArgs) and the NVENC ones (hwenc.nvencArgs) —
// CPU seconds, wall time, peak memory (ffmpeg -benchmark), the bitrate that
// came out (and its busiest 6 s), and the picture against the source scaled
// to the same size: VMAF, PSNR, SSIM (libvmaf). Then the card's session
// limit: N encodes at once, how many open and how fast each runs.
//
//   node tools/streamload/hwbench.js --clips <dir of .mkv clips> [--rungs h264,h264-720,h264-480] [--sessions 1,4,8,10]
//
// Clips: short stretches of real films, video only, stream-copied
// (ffmpeg -ss 1800 -t 60 -i film -map 0:v:0 -c copy clip.mkv).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { REPO, SCRATCH, arg, round } = require("./lib");

const ladder = require(path.join(REPO, "src", "media", "ladder"));
const hwenc = require(path.join(REPO, "src", "media", "hwenc"));
const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";

const clipsDir = arg("clips");
const rungs = arg("rungs", "h264,h264-720,h264-480").split(",");
const sessions = arg("sessions", "").split(",").filter(Boolean).map(Number);
const cqs = arg("cq", String(hwenc.CQ)).split(",").map(Number);

const out = path.join(SCRATCH, "hwbench");
fs.mkdirSync(out, { recursive: true });

const run = (args) => new Promise((resolve) => {
  execFile(FFMPEG, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, so, se) => resolve({ ok: !err, err: String(se || "") }));
});
const bench = (txt) => {
  const m = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(txt);
  const r = /maxrss=(\d+)kB/.exec(txt);
  return m ? { cpu: +m[1] + +m[2], wall: +m[3], rssMb: r ? Math.round(+r[1] / 1024) : null } : null;
};
const probeFacts = (file) => new Promise((resolve) => {
  execFile(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,color_transfer,color_primaries,color_space,color_range,profile,level:format=duration", "-of", "json", file], (e, so) => {
    const j = JSON.parse(so);
    const f = ladder._internals.parseFacts(j);
    f.duration = parseFloat(j.format.duration);
    resolve(f);
  });
});
// bytes per 6 s window, the busiest
const peakRate = (file) => new Promise((resolve) => {
  execFile(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,size", "-of", "csv=p=0", file], { maxBuffer: 256 * 1024 * 1024 }, (e, so) => {
    const pk = String(so).trim().split("\n").map((l) => l.split(",")).map(([t, s]) => [parseFloat(t), parseInt(s, 10)]).filter(([t, s]) => Number.isFinite(t) && s > 0).sort((a, b) => a[0] - b[0]);
    let peak = 0;
    let j = 0;
    let sum = 0;
    for (let i = 0; i < pk.length; i++) {
      sum += pk[i][1];
      while (pk[i][0] - pk[j][0] > 6) { sum -= pk[j][1]; j++; }
      if (pk[i][0] - pk[0][0] >= 6) peak = Math.max(peak, (sum * 8) / 6);
    }
    resolve(Math.round(peak / 1000));
  });
});
const quality = async (dist, ref, w, h) => {
  const log = `${dist}.vmaf.json`;
  const lav = `[1:v]scale=${w}:${h}:flags=lanczos,format=yuv420p,setpts=PTS-STARTPTS[ref];[0:v]format=yuv420p,setpts=PTS-STARTPTS[d];[d][ref]libvmaf=n_threads=8:n_subsample=2:feature=name=psnr|name=float_ssim:log_fmt=json:log_path=${log.replace(/\\/g, "/").replace(/:/g, "\\\\:")}`;
  const r = await run(["-hide_banner", "-v", "error", "-i", dist, "-i", ref, "-lavfi", lav, "-f", "null", "-"]);
  if (!r.ok) return { err: r.err.slice(-300) };
  const j = JSON.parse(fs.readFileSync(log, "utf8"));
  const p = j.pooled_metrics;
  return { vmaf: round(p.vmaf.mean, 2), vmafMin: round(p.vmaf.min, 1), psnr: round(p.psnr_y.mean, 2), ssim: round(p.float_ssim.mean, 4) };
};

const encode = async (clip, f, rung, kind, cq) => {
  const d = ladder._internals.dimsFor(rung.name, f.width, f.height);
  const dst = path.join(out, `${path.basename(clip, path.extname(clip))}-${rung.name}-${kind}${kind === "hw" ? cq : ""}.ts`);
  let pre = [];
  let vargs;
  if (kind === "sw") {
    vargs = ladder._internals.encVideoArgs(rung, {});
  } else {
    const a = hwenc.nvencArgs(f, { dims: d, rate: ladder._internals.rateFor(rung.name, d.h), level: rung.level, cq });
    pre = a.inputArgs;
    vargs = a.videoArgs;
  }
  const r = await run(["-hide_banner", "-v", "info", "-nostats", "-benchmark", "-y", ...pre, "-i", clip, "-map", "0:v:0", ...vargs, "-an", "-f", "mpegts", dst]);
  if (!r.ok) return { kind, err: r.err.slice(-300) };
  const b = bench(r.err);
  const kbps = Math.round((fs.statSync(dst).size * 8) / f.duration / 1000);
  const q = await quality(dst, clip, d.w, d.h);
  return { kind: kind === "hw" ? `nvenc cq${cq}` : "x264 superfast crf18", ...b, cpuPerFilmSec: round(b.cpu / f.duration, 3), speed: round(f.duration / b.wall, 2), kbps, peak6sKbps: await peakRate(dst), ceilingKbps: ladder._internals.rateFor(rung.name, d.h).maxrate, ...q };
};

const parallel = async (clip, f, n) => {
  const rung = ladder.describe({ facts: f, top: "h264", lower: true, anyRate: true }).find((r) => r.name === "h264");
  const d = ladder._internals.dimsFor("h264", f.width, f.height);
  const a = hwenc.nvencArgs(f, { dims: d, rate: ladder._internals.rateFor("h264", d.h), level: rung.level });
  const t0 = Date.now();
  const res = await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-v", "info", "-nostats", "-benchmark", ...a.inputArgs, "-i", clip, "-map", "0:v:0", ...a.videoArgs, "-an", "-f", "null", "-"], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (x) => (err += x));
    p.on("close", (code) => resolve({ code, err, wall: (Date.now() - t0) / 1000 }));
  })));
  const ok = res.filter((r) => r.code === 0);
  const failed = res.filter((r) => r.code !== 0);
  const why = failed.length ? hwenc._internals.firstLine(failed[0].err) : null;
  const cpu = ok.map((r) => bench(r.err)).filter(Boolean).reduce((s, b) => s + b.cpu, 0);
  return {
    parallel: n, opened: ok.length, refused: failed.length, why,
    slowestSpeed: ok.length ? round(f.duration / Math.max(...ok.map((r) => r.wall)), 2) : null,
    cpuPerFilmSecEach: ok.length ? round(cpu / ok.length / f.duration, 3) : null,
    refusalRecognised: failed.length ? hwenc._internals.REFUSAL_RE.test(failed[0].err) : null,
  };
};

(async () => {
  await hwenc.probe();
  console.log(hwenc.sentence());
  console.log(JSON.stringify(hwenc.status().encoders.nvenc)); // (what the card was found to decode: a busy machine can make the probe miss)
  const clips = fs.readdirSync(clipsDir).filter((x) => /\.(mkv|mp4|ts)$/.test(x)).map((x) => path.join(clipsDir, x));
  const results = { encodes: [], sessions: [] };
  for (const clip of clips) {
    const f = await probeFacts(clip);
    for (const name of rungs) {
      const rung = ladder.describe({ facts: f, top: "h264", lower: true, anyRate: true }).find((r) => r.name === name);
      if (!rung) continue;
      for (const { kind, cq } of [...(arg("nosw") ? [] : [{ kind: "sw" }]), ...cqs.map((c) => ({ kind: "hw", cq: c }))]) {
        const r = await encode(clip, f, rung, kind, cq);
        const row = { clip: path.basename(clip), src: `${f.codec} ${f.width}x${f.height} ${f.pixFmt}`, rung: name, ...r };
        results.encodes.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
  if (sessions.length && clips.length) {
    const f = await probeFacts(clips[0]);
    for (const n of sessions) {
      const r = await parallel(clips[0], f, n);
      results.sessions.push(r);
      console.log(JSON.stringify(r));
    }
  }
  const dir = path.join(REPO, "docs", "qa", "server-round", "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `hwbench-${arg("label", "run")}.json`), JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
