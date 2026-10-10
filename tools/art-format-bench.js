#!/usr/bin/env node
// LAB — which encoding should the TV's remaining JPEG artwork get?
// (docs/qa/native-bench/ART-FORMAT-PLAN.md)
//
//   node tools/art-format-bench.js [--n 10] [--dir <cache dir>] [--server http://localhost:4000]
//                                  [--profile 242da3b05797] [--runs 3] [--only A|B|C] [--per-image]
//
// Takes N real backdrops (the catalogue's originals, ids read from the running
// server's /api/home — read-only GETs), and for each:
//
//  A. the home hero's blurred variants (?w=1280&blur=1|2). The REAL filter
//     chain from src/lib/imgvariant.js (blurChain), then one encoder option per
//     row: today's 4:4:4 JPEG q2 against WebP at several qualities, with the
//     RGB→YUV step done by swscale (yuv420p) or by libwebp itself (bgra).
//     Lossy WebP is 4:2:0 by definition and this ffmpeg's libwebp exposes no
//     sharp_yuv ("ffmpeg -h encoder=libwebp"), so those two are the only
//     chroma choices; lossless is listed as the ceiling.
//     Judged against the UNENCODED blurred picture, both upscaled to 1920×1080
//     bilinear (the size the TV draws): bytes, SSIM, PSNR, worst single
//     channel error, mean error, encode ms, and decode ms on this PC.
//  B. the title page's backdrop: the original JPEG against the sized, unblurred
//     WebP the server already makes at 1280 / 1600 / 1920.
//  C. stills / scrubber frames: JPEG (today) against WebP at the stills' sizes —
//     encode time is the question there.
//
// Times are wall-clock per ffmpeg process (median of --runs), so they carry
// the process start and the source decode equally on every row: compare rows,
// do not read them as absolutes. Decode ms is (40 decodes − 1 decode) / 39 of
// "-threads 1 -loop 1 … -vf format=rgb24 -f null", a PC-side proxy for the box.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const config = require("../src/config");
const iv = require("../src/lib/imgvariant");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);
const N = parseInt(arg("n", "10"), 10);
const RUNS = parseInt(arg("runs", "3"), 10);
const SERVER = arg("server", "http://localhost:4000").replace(/\/+$/, "");
const PROFILE = arg("profile", "242da3b05797");
const DIR = path.resolve(arg("dir", path.join(os.tmpdir(), "aurora-art-bench")));
const ONLY = arg("only", "");
const FF = config.FFMPEG;
if (!FF) {
  console.error("no ffmpeg");
  process.exit(1);
}
const SRC = path.join(DIR, "src");
const TMP = path.join(DIR, "tmp");
fs.mkdirSync(SRC, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const ff = (args, opts = {}) => execFileSync(FF, ["-v", "error", "-y", ...args], { windowsHide: true, maxBuffer: 64 << 20, ...opts });
const timed = (args) => {
  const t = process.hrtime.bigint();
  const r = spawnSync(FF, ["-v", "error", "-y", ...args], { windowsHide: true, stdio: "ignore" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
  return Number(process.hrtime.bigint() - t) / 1e6;
};
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const medianOf = (n, fn) => median(Array.from({ length: n }, fn));

// ---- the pictures -----------------------------------------------------------
const pickIds = async () => {
  const home = await (await fetch(`${SERVER}/api/home?profile=${encodeURIComponent(PROFILE)}`)).json();
  const idOf = (it) => {
    const m = /metahub\.space\/background\/medium\/(tt\d+)\/img/.exec((it && it.backdrop) || "");
    return m ? m[1] : it && /^tt\d+$/.test(it.imdbId || "") ? it.imdbId : null;
  };
  const ids = [];
  const add = (it) => {
    const id = idOf(it);
    if (id && !ids.includes(id)) ids.push(id);
  };
  // half from the billboard's own rotation (that is what gets blurred), then
  // one title from each row in turn, so genres — dark thrillers, flat
  // animation, bright comedies — are all in
  (home.hero || []).slice(0, Math.ceil(N / 2)).forEach(add);
  const rows = (home.rows || []).map((r) => r.items || []);
  for (let i = 0; ids.length < N * 3 && i < 30; i++) for (const items of rows) if (items[i]) add(items[i]);
  return ids;
};
const fetchSources = async () => {
  const have = fs.readdirSync(SRC).filter((f) => f.endsWith(".jpg"));
  if (have.length >= N) return have.slice(0, N).map((f) => path.join(SRC, f));
  const out = have.map((f) => path.join(SRC, f));
  for (const id of await pickIds()) {
    if (out.length >= N) break;
    const file = path.join(SRC, `${id}.jpg`);
    if (out.includes(file)) continue;
    try {
      const res = await fetch(`https://images.metahub.space/background/medium/${id}/img`);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 20000) continue; // a placeholder, not a backdrop
      fs.writeFileSync(file, buf);
      out.push(file);
    } catch {}
  }
  return out;
};

// ---- measuring --------------------------------------------------------------
const TVW = 1920;
const TVH = 1080;
// A picture as the TV shows it: decoded to RGB at its own size (so 4:2:0
// chroma is upsampled by the decoder, as on the box), then stretched bilinear.
const asDrawn = (file) =>
  ff(["-i", file, "-vf", `format=gbrp,scale=${TVW}:${TVH}:flags=bilinear,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"]);
const pixelStats = (a, b) => {
  let se = 0;
  let abs = 0;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    se += d * d;
    abs += d;
    if (d > worst) worst = d;
  }
  const mse = se / a.length;
  return { psnr: mse ? 10 * Math.log10((255 * 255) / mse) : 99, worst, meanErr: abs / a.length };
};
const ssim = (rawA, rawB) => {
  const raw = (f) => ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${TVW}x${TVH}`, "-i", f];
  const r = spawnSync(
    FF,
    ["-v", "info", "-nostats", ...raw(rawA), ...raw(rawB), "-lavfi", "[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]ssim", "-f", "null", "-"],
    { windowsHide: true, encoding: "utf8", maxBuffer: 16 << 20 },
  );
  const m = /All:([0-9.]+)/.exec(r.stderr || "");
  return m ? parseFloat(m[1]) : NaN;
};
const decodeMs = (file) => {
  // one thread: the webp decoder is frame-threaded here, which a wall clock
  // over 40 copies of one picture would flatter; the box decodes one picture
  const run = (n) => timed(["-threads", "1", "-loop", "1", "-i", file, "-frames:v", String(n), "-vf", "format=rgb24", "-f", "null", "-"]);
  return medianOf(RUNS, () => (run(40) - run(1)) / 39);
};

const table = (title, cols, rows) => {
  console.log(`\n${title}`);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((v, i) => (i === 0 ? String(v).padEnd(w[i]) : String(v).padStart(w[i]))).join("  ");
  console.log(line(cols));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  rows.forEach((r) => console.log(line(r)));
};
const kb = (b) => (b / 1024).toFixed(1);
const dims = (file) => {
  const r = spawnSync(FF, ["-hide_banner", "-i", file], { windowsHide: true, encoding: "utf8" });
  const m = /, (\d{2,5})x(\d{2,5})[ ,]/.exec(r.stderr || "");
  return m ? `${m[1]}x${m[2]}` : "?";
};

// ---- A. the hero's blurred variants ----------------------------------------
const webp = (q, pix, extra = []) => ({
  ext: "webp",
  pix,
  codec: ["-c:v", "libwebp", "-quality", String(q), "-compression_level", "4", ...extra],
});
const BLUR_OPTIONS = [
  { name: "jpeg 4:4:4 q2 (today)", ext: "jpg", pix: "yuvj444p", codec: ["-q:v", "2"] },
  { name: "jpeg 4:2:0 q2", ext: "jpg", pix: "yuvj420p", codec: ["-q:v", "2"] },
  // (not something the server offers — the cheap-to-decode alternative, for scale)
  { name: "jpeg 4:2:0 q4", ext: "jpg", pix: "yuvj420p", codec: ["-q:v", "4"] },
  { name: "jpeg 4:2:0 q6", ext: "jpg", pix: "yuvj420p", codec: ["-q:v", "6"] },
  { name: "webp q70 bgra", ...webp(70, "bgra") },
  { name: "webp q78 bgra", ...webp(78, "bgra") },
  { name: "webp q78 yuv420p", ...webp(78, "yuv420p") },
  { name: "webp q84 bgra", ...webp(84, "bgra") },
  { name: "webp q84 yuv420p", ...webp(84, "yuv420p") },
  { name: "webp q84 bgra preset photo", ...webp(84, "bgra", ["-preset", "photo"]) },
  { name: "webp q84 bgra cl6", ext: "webp", pix: "bgra", codec: ["-c:v", "libwebp", "-quality", "84", "-compression_level", "6"] },
  { name: "webp q90 bgra", ...webp(90, "bgra") },
  { name: "webp q90 yuv420p", ...webp(90, "yuv420p") },
  { name: "webp q95 bgra", ...webp(95, "bgra") },
  { name: "webp lossless", ext: "webp", pix: "bgra", codec: ["-c:v", "libwebp", "-lossless", "1", "-compression_level", "4"] },
];
const partA = (sources) => {
  const acc = BLUR_OPTIONS.map(() => ({ bytes: [], ssim: [], psnr: [], worst: [], meanErr: [], enc: [], dec: [] }));
  const perImage = [];
  for (const src of sources) {
    for (const blur of [1, 2]) {
      const chain = iv.blurChain(1280, blur); // the server's own blur + downscale
      const ref = path.join(TMP, "ref.png");
      ff(["-i", src, "-vf", `${chain},format=rgb24`, "-frames:v", "1", ref]);
      const refRaw = asDrawn(ref);
      const refFile = path.join(TMP, "ref.rgb");
      fs.writeFileSync(refFile, refRaw);
      BLUR_OPTIONS.forEach((o, i) => {
        const out = path.join(TMP, `a${i}.${o.ext}`);
        const args = ["-i", src, "-vf", `${chain},format=${o.pix}`, "-frames:v", "1", ...o.codec, out];
        const enc = medianOf(RUNS, () => timed(args));
        const raw = asDrawn(out);
        const candFile = path.join(TMP, "cand.rgb");
        fs.writeFileSync(candFile, raw);
        const st = pixelStats(refRaw, raw);
        const row = { bytes: fs.statSync(out).size, ssim: ssim(refFile, candFile), ...st, enc, dec: decodeMs(out) };
        for (const k of Object.keys(acc[i])) acc[i][k].push(row[k]);
        perImage.push([path.basename(src, ".jpg"), blur, o.name, kb(row.bytes), row.ssim.toFixed(4), row.psnr.toFixed(1), row.worst]);
      });
      process.stderr.write(".");
    }
  }
  process.stderr.write("\n");
  table(
    `A. hero, blurred, 1280 wide (${sources.length} backdrops × blur 1 and 2; vs the unencoded blur, both drawn at ${TVW}×${TVH})`,
    ["option", "KB med", "KB min", "KB max", "SSIM mean", "SSIM min", "PSNR mean", "PSNR min", "worst px", "mean err", "enc ms", "dec ms"],
    BLUR_OPTIONS.map((o, i) => {
      const a = acc[i];
      return [
        o.name,
        kb(median(a.bytes)),
        kb(Math.min(...a.bytes)),
        kb(Math.max(...a.bytes)),
        mean(a.ssim).toFixed(4),
        Math.min(...a.ssim).toFixed(4),
        mean(a.psnr).toFixed(1),
        Math.min(...a.psnr).toFixed(1),
        Math.max(...a.worst),
        mean(a.meanErr).toFixed(2),
        median(a.enc).toFixed(0),
        median(a.dec).toFixed(1),
      ];
    }),
  );
  if (flag("per-image")) table("A, per picture", ["id", "blur", "option", "KB", "SSIM", "PSNR", "worst"], perImage);
};

// ---- B. the title page's backdrop ------------------------------------------
const partB = (sources) => {
  const opts = [
    { name: "original jpeg (today)", w: 0 },
    { name: "webp w1280", w: 1280 },
    { name: "webp w1600", w: 1600 },
    { name: "webp w1920", w: 1920 },
  ];
  const acc = opts.map(() => ({ bytes: [], ssim: [], psnr: [], worst: [], enc: [], dec: [] }));
  for (const src of sources) {
    const refRaw = asDrawn(src);
    const refFile = path.join(TMP, "ref.rgb");
    fs.writeFileSync(refFile, refRaw);
    opts.forEach((o, i) => {
      let file = src;
      let enc = 0;
      if (o.w) {
        file = path.join(TMP, `b${i}.webp`);
        // exactly the server's unblurred variant (filterFor + codecFor)
        const args = ["-i", src, "-vf", iv.filterFor(o.w, 0), "-frames:v", "1", ...iv.codecFor(file, o.w, 0), file];
        enc = medianOf(RUNS, () => timed(args));
      }
      const raw = o.w ? asDrawn(file) : refRaw;
      const candFile = path.join(TMP, "cand.rgb");
      fs.writeFileSync(candFile, raw);
      const st = pixelStats(refRaw, raw);
      const a = acc[i];
      a.bytes.push(fs.statSync(file).size);
      a.ssim.push(o.w ? ssim(refFile, candFile) : 1);
      a.psnr.push(st.psnr);
      a.worst.push(st.worst);
      a.enc.push(enc);
      a.dec.push(decodeMs(file));
    });
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  table(
    `B. title-page backdrop, sharp (${sources.length} backdrops; vs the catalogue's original, both drawn at ${TVW}×${TVH})`,
    ["option", "KB med", "KB min", "KB max", "SSIM mean", "SSIM min", "PSNR mean", "worst px", "enc ms", "dec ms"],
    opts.map((o, i) => {
      const a = acc[i];
      return [
        o.name,
        kb(median(a.bytes)),
        kb(Math.min(...a.bytes)),
        kb(Math.max(...a.bytes)),
        mean(a.ssim).toFixed(4),
        Math.min(...a.ssim).toFixed(4),
        o.w ? mean(a.psnr).toFixed(1) : "-",
        Math.max(...a.worst),
        o.w ? median(a.enc).toFixed(0) : "-",
        median(a.dec).toFixed(1),
      ];
    }),
  );
};

// ---- C. stills and scrubber frames -----------------------------------------
// media/stills.js cuts a frame out of a VIDEO; the seek and the video decode
// are the same whatever it is written as, so the backdrop stands in for the
// decoded frame and only the scale + encode differ.
const partC = (sources) => {
  const wp = (cl) => ["-c:v", "libwebp", "-quality", "78", "-compression_level", String(cl)];
  const opts = [
    { name: "still 1280 jpeg q3 (today)", w: 1280, ext: "jpg", codec: ["-q:v", "3"] },
    { name: "still 1280 webp q78 cl4", w: 1280, ext: "webp", codec: wp(4) },
    { name: "still 1280 webp q78 cl1", w: 1280, ext: "webp", codec: wp(1) },
    { name: "still 1280 webp q78 cl0", w: 1280, ext: "webp", codec: wp(0) },
    { name: "frame 640 jpeg q4 (today)", w: 640, ext: "jpg", codec: ["-q:v", "4"] },
    { name: "frame 640 webp q78 cl4", w: 640, ext: "webp", codec: wp(4) },
    { name: "frame 640 webp q78 cl1", w: 640, ext: "webp", codec: wp(1) },
    { name: "frame 640 webp q78 cl0", w: 640, ext: "webp", codec: wp(0) },
  ];
  const acc = opts.map(() => ({ bytes: [], enc: [], ssim: [] }));
  // what every row pays before its own encode: start ffmpeg, decode the source
  const floor = [];
  for (const src of sources) {
    floor.push(medianOf(RUNS, () => timed(["-i", src, "-frames:v", "1", "-f", "null", "-"])));
    const refs = {};
    opts.forEach((o, i) => {
      if (!refs[o.w]) {
        const png = path.join(TMP, `cref${o.w}.png`);
        ff(["-i", src, "-vf", `scale=${o.w}:-2,format=rgb24`, "-frames:v", "1", png]);
        refs[o.w] = path.join(TMP, `cref${o.w}.rgb`);
        fs.writeFileSync(refs[o.w], asDrawn(png));
      }
      const out = path.join(TMP, `c${i}.${o.ext}`);
      const args = ["-i", src, "-frames:v", "1", "-vf", `scale=${o.w}:-2`, ...o.codec, out];
      acc[i].enc.push(medianOf(RUNS, () => timed(args)));
      acc[i].bytes.push(fs.statSync(out).size);
      const candFile = path.join(TMP, "cand.rgb");
      fs.writeFileSync(candFile, asDrawn(out));
      acc[i].ssim.push(ssim(refs[o.w], candFile));
    });
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  const f = median(floor);
  table(
    `C. stills / frames (${sources.length} pictures; "floor" = start ffmpeg + decode the source, ${f.toFixed(0)} ms, paid by every row)`,
    ["option", "KB med", "SSIM mean", "total ms", "scale+encode ms"],
    opts.map((o, i) => [
      o.name,
      kb(median(acc[i].bytes)),
      mean(acc[i].ssim).toFixed(4),
      median(acc[i].enc).toFixed(0),
      (median(acc[i].enc) - f).toFixed(0),
    ]),
  );
};

(async () => {
  const sources = await fetchSources();
  if (!sources.length) {
    console.error("no backdrops fetched (is the server up? is the network?)");
    process.exit(1);
  }
  const ver = String(execFileSync(FF, ["-version"], { windowsHide: true })).split("\n")[0].trim();
  console.log(`${sources.length} backdrops in ${SRC}\n${ver}\nruns per timing: ${RUNS}`);
  console.log(sources.map((s) => `  ${path.basename(s)}  ${dims(s)}  ${kb(fs.statSync(s).size)} KB`).join("\n"));
  if (!ONLY || ONLY === "A") partA(sources);
  if (!ONLY || ONLY === "B") partB(sources);
  if (!ONLY || ONLY === "C") partC(sources);
  process.exit(0);
})();
