// CPU per encode: today's WebP vs the chosen AVIF, one at a time (ffmpeg -benchmark utime+stime, rtime)
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const FF = require("../../src/config").FFMPEG; const S = process.argv[2];
const run = (args) => { const o = execFileSync(FF, ["-hide_banner", "-benchmark", "-v", "info", "-nostats", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 1 << 22 }); return o; };
const runE = (args) => { try { const { spawnSync } = require("child_process"); const r = spawnSync(FF, ["-hide_banner", "-benchmark", "-v", "info", "-nostats", "-y", ...args], { encoding: "utf8" }); const m = /utime=([\d.]+)s\s+stime=([\d.]+)s\s+rtime=([\d.]+)s/.exec(r.stdout + r.stderr); return { cpu: +m[1] + +m[2], wall: +m[3] }; } catch (e) { return null; } };
const out = path.join(S, "t", "cpu"); fs.mkdirSync(out, { recursive: true });
const res = {};
for (const f of fs.readdirSync(path.join(S, "samples"))) {
  const src = path.join(S, "samples", f); const n = f.replace(".jpg", "");
  const ws = n.startsWith("bd-") ? [640, 1280, 1920] : n.startsWith("po-") ? [360, 480] : [480, 960];
  for (const w of ws) {
    const cls = `${n.slice(0, 2)}-w${w}`; res[cls] = res[cls] || { webp: [], avif: [] };
    const vf = `scale='min(${w},iw)':-2`;
    res[cls].webp.push(runE(["-i", src, "-vf", vf, "-frames:v", "1", "-c:v", "libwebp", "-quality", w >= 1600 ? "84" : "78", "-compression_level", "4", path.join(out, "x.webp")]));
    res[cls].avif.push(runE(["-i", src, "-vf", `${vf}:out_range=full,format=yuv420p`, "-color_range", "pc", "-frames:v", "1", "-c:v", "libaom-av1", "-still-picture", "1", "-usage", "allintra", "-crf", w >= 1600 ? "18" : "24", "-cpu-used", "6", "-threads", "2", "-aom-params", "tune=ssim", path.join(out, "x.avif")]));
  }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
for (const [c, r] of Object.entries(res).sort()) console.log(c.padEnd(9), "webp cpu", mean(r.webp.map((x) => x.cpu)).toFixed(3), "wall", mean(r.webp.map((x) => x.wall)).toFixed(3), "| avif cpu", mean(r.avif.map((x) => x.cpu)).toFixed(3), "wall", mean(r.avif.map((x) => x.wall)).toFixed(3), "| x", (mean(r.avif.map((x) => x.cpu)) / mean(r.webp.map((x) => x.cpu))).toFixed(1));
