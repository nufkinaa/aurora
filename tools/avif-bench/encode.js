// The AVIF-vs-WebP picture bench behind lib/imgvariant.js's AVIF settings
// (tools/avif-bench; crops in docs/qa/avif). <dir> holds samples/*.jpg (read-only copies of
// real posters "po-*"/"pl-*" and backdrops "bd-*" from the library cache):
//   node tools/avif-bench/encode.js <dir> [grid.json-text] [out]   reference, today's WebP/JPEG, the AVIF grid
//   node tools/avif-bench/decode.js <dir> [out]                    every candidate decoded IN CHROME to PNG
//   node tools/avif-bench/metrics.js <dir> [out]                   SSIM, MS-SSIM, PSNR-HVS, CAMBI (ffmpeg + libvmaf)
//   node tools/avif-bench/analyze.js <dir> enc,enc4 [keys]         against the WebP, per class and width
//   node tools/avif-bench/crop.js out.png x y w h zoom "label=file.png"...   side-by-side crops (BOOST=5 brightens)
// The chosen grid: grid-chosen.json (crf 24 below 1600 px, crf 18 from 1600).
// Stage 1: encode every sample at its widths: reference PNG, today's WebP and
// JPEG variants (imgvariant.js settings), and an AVIF grid. Records bytes and
// ffmpeg's own -benchmark CPU time.
const fs = require("fs"), path = require("path"), { execFile } = require("child_process");
const S = process.argv[2]; const FF = require("../../src/config").FFMPEG;
const GRID = JSON.parse(process.argv[3] || "null") || (() => {
  const g = [];
  for (const pix of ["yuv420p", "yuv420p10le", "yuv444p"]) for (const crf of [14, 18, 22, 26, 30]) g.push({ pix, crf, cpu: 6, usage: "good" });
  return g;
})();
const OUT = path.join(S, process.argv[4] || "enc");
const widthsFor = (n) => (n.startsWith("bd-") ? [640, 1280, 1920] : n.startsWith("po-") ? [360, 480] : [480, 960]);
const run = (args) => new Promise((res) => execFile(FF, ["-hide_banner", "-benchmark", "-v", "info", "-nostats", "-y", ...args], { windowsHide: true, maxBuffer: 1 << 20 }, (e, so, se) => {
  const m = /utime=([\d.]+)s\s+stime=([\d.]+)s\s+rtime=([\d.]+)s/.exec(String(so) + String(se));
  res({ err: e ? String(se).slice(-300) : null, cpu: m ? +m[1] + +m[2] : null, wall: m ? +m[3] : null });
}));
const jobs = [];
for (const f of fs.readdirSync(path.join(S, "samples")).filter((x) => x.endsWith(".jpg") && (!process.env.ONLY || new RegExp(process.env.ONLY).test(x)))) {
  const name = f.replace(/\.jpg$/, ""); const src = path.join(S, "samples", f);
  for (const w of widthsFor(name)) {
    const dir = path.join(OUT, `${name}-w${w}`); fs.mkdirSync(dir, { recursive: true });
    const vf = `scale='min(${w},iw)':-2`;
    jobs.push({ dir, key: "ref", file: "ref.png", args: ["-i", src, "-vf", `${vf},format=rgb24`, "-frames:v", "1"] });
    if (!process.argv[3]) {
      jobs.push({ dir, key: "webp", file: "webp.webp", args: ["-i", src, "-vf", vf, "-frames:v", "1", "-c:v", "libwebp", "-quality", w >= 1600 ? "84" : "78", "-compression_level", "4"] });
      jobs.push({ dir, key: "jpg", file: "jpg.jpg", args: ["-i", src, "-vf", vf, "-frames:v", "1", "-q:v", "4"] });
    }
    for (const g of GRID) {
      const key = `avif-${g.pix}${g.full ? "f" : ""}-c${g.crf}-s${g.cpu}-${g.usage}${g.extra ? "-" + g.tag : ""}`;
      jobs.push({ dir, key, file: key + ".avif", args: ["-i", src, "-vf", `${vf}${g.full ? ":out_range=full" : ""},format=${g.pix}`, ...(g.full ? ["-color_range", "pc"] : []), "-frames:v", "1", "-c:v", "libaom-av1", "-still-picture", "1", "-usage", g.usage, "-crf", String(g.crf), "-cpu-used", String(g.cpu), ...(g.threads ? ["-threads", String(g.threads)] : []), ...(g.extra || [])] });
    }
  }
}
(async () => {
  const results = []; let i = 0; const N = +process.env.CONC || 3;
  const worker = async () => { while (i < jobs.length) { const j = jobs[i++]; const out = path.join(j.dir, j.file);
    const r = await run([...j.args, out]); let bytes = 0; try { bytes = fs.statSync(out).size; } catch {}
    results.push({ img: path.basename(j.dir), key: j.key, file: out, bytes, cpu: r.cpu, wall: r.wall, err: r.err });
    if (r.err) console.error(j.key, path.basename(j.dir), r.err);
    if (results.length % 50 === 0) console.log(results.length, "/", jobs.length); } };
  await Promise.all(Array.from({ length: N }, worker));
  fs.writeFileSync(path.join(OUT, "encodes.json"), JSON.stringify(results, null, 0));
  console.log("done", results.length);
})();
