// Downscaled artwork for the screen that asked for it.
//
// The catalogue's "medium" backdrops arrive as 1920×1080 JPEGs of 0.8–1.3 MB
// and library posters as ~200 KB scans — fine on a LAN, brutal on a phone
// with two bars of signal, where a home screen pulled several megabytes of
// pictures that were then drawn 150px wide. /img/ext and /img/:id take an
// optional ?w=<px>; the first request for a size re-encodes the cached
// original through ffmpeg (the stills pipeline's tool, already a dependency)
// and every request after is a plain file send. No ffmpeg, or a failed
// encode: the original is served, so nothing is ever worse than before.
//
// Sizes are snapped to a short ladder so a fleet of slightly different
// screens shares a handful of variants instead of minting one each.
//
// ?blur=<px> (optional, 1..8): the picture pre-blurred here instead of on the
// device. The TV's billboard used to ask Android for `blurRadius`, which runs
// Fresco's iterative box blur on the full-size decoded bitmap — a copy of the
// whole picture and a native blur on every hero rotation, on boxes that have
// neither the memory nor the CPU for it. The blur here is the SAME filter:
// two passes of a (2r+1) box, horizontal then vertical, on the original
// pixels before any downscale (r in source pixels, exactly what Android's
// IterativeBoxBlurPostProcessor(2, r) does), so a client asks for the radius
// it would have handed the postprocessor. Measured against a port of Fresco's
// blur_filter.cpp: at most one level apart on any channel.
// Without the param nothing changes — same file names, same encode.
//
// ?fmt=webp (optional, LAB — docs/qa/native-bench/ART-FORMAT-PLAN.md): the
// blurred variant as WebP instead of the full-chroma JPEG. Opt-in: without it
// a blurred variant is the JPEG it always was, under the name it always had.
// It only means something together with ?blur= (unblurred variants are WebP
// already); any other value is ignored. Settings picked by measurement:
// tools/art-format-bench.js.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const config = require("../config");

const DIR = path.join(config.CACHE_DIR, "img-variants");
try {
  fs.mkdirSync(DIR, { recursive: true });
} catch {}

// 256 / 352 / 448: the TV app's poster, landscape and Continue Watching cards
// on a 1080p set (124 / 176 / 224 dp × 2), so each is fetched at the size it
// is drawn and decoded without a re-encode on the box.
// 1600 / 1920: the website's full-bleed hero on a desktop monitor, which is
// drawn wider than 1280 and used to be handed the 1280 step stretched. (The
// TV app's own ladder stops at 1280 — above it the box asks for the plain
// address, so these two steps are never what a TV receives; the LAB app's
// title-page backdrop is the one exception, behind its artWebp switch.)
const LADDER = [240, 256, 352, 360, 448, 480, 640, 800, 960, 1280, 1600, 1920];
// From here up the picture fills a monitor and is looked at, not glanced at:
// a finer WebP (1920: ~0.98 SSIM against the source at 84, ~0.967 at 78).
const HERO_STEP = 1600;
const MAX_BLUR = 8;
const MAX_CONCURRENT = 2; // ffmpeg encodes behind the video pipeline's back
let running = 0;
const queue = [];
const inflight = new Map(); // out path -> promise
const failed = new Map(); // out path -> failedAt (don't retry a broken source every request)
const FAIL_TTL = 10 * 60 * 1000;
const MAX_FILES = 6000;
let writes = 0;

// Snap a requested width onto the ladder (up, never down — the picture must
// still cover the box it was asked for). Anything absurd → null (no variant).
const snap = (w) => {
  const n = parseInt(w, 10);
  if (!Number.isFinite(n) || n < 64) return null;
  for (const step of LADDER) if (n <= step) return step;
  return null; // wider than the biggest step: serve the original
};

// A blur radius from a query string → 1..MAX_BLUR, or 0 (no blur).
const blurOf = (b) => {
  const n = parseInt(b, 10);
  return Number.isFinite(n) && n >= 1 && n <= MAX_BLUR ? n : 0;
};

// ?fmt= → "webp" or "" (anything else: not asked for).
const fmtOf = (f) => (typeof f === "string" && f.trim().toLowerCase() === "webp" ? "webp" : "");

const sweep = () => {
  try {
    const entries = fs.readdirSync(DIR);
    if (entries.length <= MAX_FILES) return;
    entries
      .map((f) => ({ f, m: fs.statSync(path.join(DIR, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m)
      .slice(0, entries.length - (MAX_FILES - 500))
      .forEach(({ f }) => {
        try {
          fs.unlinkSync(path.join(DIR, f));
        } catch {}
      });
  } catch {}
};

const pump = () => {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
};

// WebP when this ffmpeg has libwebp (every build we've seen does; a JPEG at
// q4 otherwise). Same picture, roughly a third fewer bytes than the JPEG.
// Probed once, asynchronously, at load — never a blocking call inside a
// request; until the answer lands the odd early variant is a JPEG.
let webp = false;
if (config.FFMPEG) {
  execFile(config.FFMPEG, ["-hide_banner", "-encoders"], { windowsHide: true, timeout: 8000 }, (err, out) => {
    webp = !err && /\blibwebp\b/.test(String(out || ""));
  });
}
const hasWebp = () => webp;

// The filter chain. Blurred: to planar RGB first (boxblur on YUV would blur
// the subsampled chroma planes at twice the reach), the two-pass box at the
// source's own resolution, then the downscale.
// It is written as a full-chroma (4:4:4) JPEG at q 2, never WebP: WebP's
// 4:2:0 chroma put individual pixels up to ~50 levels off the on-device blur
// at a 1280 width, where this stays within ~25 at the worst pixel and under
// one level on average — at ~100 KB, against the 1–1.5 MB original.
//
// fmt "webp" (opt-in): the same blur and downscale, handed to libwebp as
// BLUR_WEBP_PIX with BLUR_WEBP_CODEC — see the table in
// docs/qa/native-bench/ART-FORMAT-PLAN.md for why these and not others.
const blurChain = (width, blur) => {
  const bb = `format=gbrp,boxblur=lr=${blur}:lp=2:cr=${blur}:cp=2`;
  return width ? `${bb},scale='min(${width},iw)':-2` : bb;
};
const BLUR_WEBP_PIX = "bgra";
const filterFor = (width, blur, fmt) => {
  if (!blur) return `scale='min(${width},iw)':-2`;
  return `${blurChain(width, blur)},format=${fmt === "webp" ? BLUR_WEBP_PIX : "yuvj444p"}`;
};
const BLUR_CODEC = ["-q:v", "2"];
const BLUR_WEBP_CODEC = ["-c:v", "libwebp", "-quality", "78", "-compression_level", "4"];
// The encoder arguments for a variant written to `out`.
const codecFor = (out, width, blur) =>
  blur
    ? out.endsWith(".webp")
      ? BLUR_WEBP_CODEC
      : BLUR_CODEC
    : out.endsWith(".webp")
    ? ["-c:v", "libwebp", "-quality", width >= HERO_STEP ? "84" : "78", "-compression_level", "4"]
    : ["-q:v", "4"];

const encode = (src, out, width, blur = 0) =>
  new Promise((resolve, reject) => {
    const tmp = `${out}.tmp${path.extname(out)}`;
    // -2 keeps the height even (a JPEG requirement); q 4 / webp quality 78 are
    // visually transparent for artwork at these sizes.
    const codec = codecFor(out, width, blur);
    const fmt = blur && out.endsWith(".webp") ? "webp" : "";
    execFile(
      config.FFMPEG,
      ["-v", "error", "-y", "-i", src, "-vf", filterFor(width, blur, fmt), "-frames:v", "1", ...codec, tmp],
      { timeout: 20000, windowsHide: true },
      (err) => {
        if (err) {
          try {
            fs.unlinkSync(tmp);
          } catch {}
          return reject(err);
        }
        try {
          fs.renameSync(tmp, out);
        } catch (e) {
          return reject(e);
        }
        if (++writes % 100 === 0) sweep();
        resolve(out);
      },
    );
  });

// The path of a variant of `src` at `width` (ladder-snapped), made if it
// doesn't exist yet. Resolves null when no variant can be had — callers
// then send the original. `opts.blur` (see the header): pre-blurred, at
// `width` or, with no usable width, at the original size. `opts.fmt`
// "webp": that blurred variant as WebP (ignored without blur, and where this
// ffmpeg has no libwebp — the JPEG is the answer then).
const variant = async (src, width, opts = {}) => {
  const w = snap(width);
  const blur = blurOf(opts && opts.blur);
  const fmt = blur && hasWebp() ? fmtOf(opts && opts.fmt) : "";
  if ((!w && !blur) || !config.FFMPEG) return null;
  let st;
  try {
    st = fs.statSync(src);
  } catch {
    return null;
  }
  // (the unblurred key and name, and the blurred JPEG's, are exactly what
  // they always were, so every variant already on disk stays valid; the
  // blurred WebP has a key and a name of its own)
  const key = crypto
    .createHash("md5")
    .update(
      blur
        ? `${src}|${st.mtimeMs}|${st.size}|${w || 0}|b${blur}${fmt ? `|${fmt}` : ""}`
        : `${src}|${st.mtimeMs}|${st.size}|${w}`,
    )
    .digest("hex");
  const out = blur
    ? path.join(DIR, `${key}-w${w || "full"}-b${blur}.${fmt || "jpg"}`)
    : path.join(DIR, `${key}-w${w}.${hasWebp() ? "webp" : "jpg"}`);
  try {
    if (fs.statSync(out).size > 512) return out;
  } catch {}
  if (Date.now() - (failed.get(out) || 0) < FAIL_TTL) return null;
  let p = inflight.get(out);
  if (!p) {
    p = new Promise((resolve, reject) => {
      queue.push(() => encode(src, out, w, blur).then(resolve, reject));
      pump();
    });
    inflight.set(out, p);
    const done = () => inflight.delete(out);
    p.then(done, done);
    p.catch(() => {
      if (failed.size > 2000) failed.clear();
      failed.set(out, Date.now());
    });
  }
  try {
    return await p;
  } catch {
    return null;
  }
};

module.exports = { variant, snap, blurOf, fmtOf, filterFor, blurChain, codecFor, hasWebp, LADDER, MAX_BLUR, DIR };
