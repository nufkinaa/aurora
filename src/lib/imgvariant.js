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
//
// AVIF (2026-11-09, docs/qa/avif/REPORT.md): an unblurred variant for a
// browser that says it decodes AVIF (`image/avif` in its Accept header — the
// route passes `opts.avif`, see wantsAvif) or that asks with ?fmt=avif. The
// same picture at a smaller size, settings chosen by measurement against
// today's WebP (as good or better on SSIM, MS-SSIM and banding, crops looked
// at). An AVIF encode costs several times a WebP's CPU, so it is NEVER waited
// for: the first ask for a picture gets the WebP it always got (marked
// `opts.avifPending`, so the route keeps that answer short-lived) and the
// AVIF is made in the background — one at a time, only when no WebP/JPEG
// variant is waiting, never while somebody's video is being encoded — for
// the next ask. The TV and the phone apps never send image/avif (Fresco on
// Android 9 has no AVIF decoder): they get exactly what they got before.
// Blurred variants, and an ffmpeg without libaom-av1 or the avif muxer, are
// never AVIF. The files sit beside the WebPs, under their own file cap.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const config = require("../config");
const spawnerLib = require("./lazy")(require, "./spawner");

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
// The wait behind those two is bounded. It used to have no limit: forty
// blurred variants asked for at once took 22.6 s to drain, each request
// holding its connection (measured), and nothing stopped four thousand. Past
// these lines a variant is not queued at all — the caller sends the original
// straight away (cached briefly, so the variant is asked for again later).
//   MAX_QUEUE          waiting, everyone together
//   MAX_QUEUE_CLIENT   waiting, for one client (routes pass `opts.client`) —
//                      a page of forty posters is inside it; one device
//                      cannot fill the queue for the rest
const MAX_QUEUE = 200;
const MAX_QUEUE_CLIENT = 48;
const waitingOf = new Map(); // client -> jobs waiting
const shedStats = { shed: 0 };
let running = 0;
const queue = [];
const inflight = new Map(); // out path -> promise
const failed = new Map(); // out path -> failedAt (don't retry a broken source every request)
const FAIL_TTL = 10 * 60 * 1000;
const MAX_FILES = 6000;
let writes = 0;
let avifWrites = 0;

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

// Does this Accept header say AVIF? Only an explicit `image/avif` with a q
// above zero counts — `image/*` and `*/*` do not (an Android image loader
// that sends `*/*` cannot decode it).
const acceptsAvif = (accept) => {
  if (typeof accept !== "string" || !accept) return false;
  for (const part of accept.toLowerCase().split(",")) {
    const [type, ...params] = part.split(";").map((x) => x.trim());
    if (type !== "image/avif") continue;
    const q = params.find((x) => x.startsWith("q="));
    return !q || parseFloat(q.slice(2)) > 0;
  }
  return false;
};
// Should this request get the AVIF? ?fmt=avif asks outright; ?fmt=webp (or
// any other fmt, or a blur) says no; otherwise the Accept header decides.
// `q`: the query ({ fmt, blur }); `accept`: the request's Accept header.
const wantsAvif = (q, accept) => {
  if (q && blurOf(q.blur)) return false;
  const fmt = q && typeof q.fmt === "string" ? q.fmt.trim().toLowerCase() : q && q.fmt != null ? "?" : "";
  if (fmt === "avif") return true;
  if (fmt) return false;
  return acceptsAvif(accept);
};

// THE FAST PATH (server round, 2026-10-18). A variant that was found or
// made is remembered for TRUST_MS by what was asked (source, width, blur,
// format): the next request for it goes straight to sending the file — no
// stat of the source, no hash, no stat of the variant (two blocking calls
// and an md5 per picture, 300 pictures a Home page). The source changing in
// that window is seen at the next look after it, as an edited stylesheet is
// seen at the next reload; a sweep forgets everything it may have removed.
const TRUST_MS = 30 * 1000;
const FAST_MAX = 8000;
const fast = new Map(); // `${src}|${w}|${blur}|${fmt}` -> { out, at }
const fastStats = { hits: 0, misses: 0 };
// Every variant of a source known to exist, by its kind (blur, format) and
// width — what a request that cannot wait is handed instead (nearest()).
const bySrc = new Map(); // src -> Map<`${blur}|${fmt}`, Map<width, out>>
const noteSize = (src, w, blur, fmt, out) => {
  if (!w) return;
  let kinds = bySrc.get(src);
  if (!kinds) {
    if (bySrc.size >= FAST_MAX) bySrc.clear();
    bySrc.set(src, (kinds = new Map()));
  }
  const k = `${blur}|${fmt}`;
  if (!kinds.has(k)) kinds.set(k, new Map());
  kinds.get(k).set(w, out);
};
// The nearest size of this picture already made: the smallest that still
// covers the box, else the biggest there is. null when none is known.
const nearest = (src, w, blur, fmt) => {
  const sizes = bySrc.get(src) && bySrc.get(src).get(`${blur}|${fmt}`);
  if (!sizes || !sizes.size) return null;
  let up = null;
  let down = null;
  for (const [width, out] of sizes) {
    if (width === w) continue;
    if (width >= w) { if (!up || width < up.width) up = { width, out }; }
    else if (!down || width > down.width) down = { width, out };
  }
  return (up || down || {}).out || null;
};

// WAITING IS BOUNDED BY TIME TOO (server round, 2026-10-18). Two encoders
// and a queue of up to 200 can mean most of a minute behind other people's
// pictures on a busy machine: a request whose variant is not made within
// MAX_WAIT_MS gets, at once, the nearest size already made — or the original
// (null) — marked `opts.shed` so the route caches that answer for a minute
// only. The variant goes on being made (one encode, however many asked) and
// is the answer next time.
const MAX_WAIT_MS = 2500;
const waitStats = { waited: 0, gaveNearest: 0, gaveOriginal: 0 };

// (asynchronous, a few files at a time: lib/dirsweep.js — the blocking
// version held the event loop for the length of 6,000 stats)
// (the AVIFs are counted apart, under their own cap: a browser's AVIFs never
// push out the WebPs the TVs are sent)
const isAvifName = (n) => n.endsWith(".avif");
const sweep = () =>
  require("./dirsweep").trim(DIR, { max: MAX_FILES, down: MAX_FILES - 500, filter: (n) => !isAvifName(n), onRemoved: () => { fast.clear(); bySrc.clear(); } }).catch(() => 0);
const AVIF_MAX_FILES = 6000;
const sweepAvif = () =>
  require("./dirsweep").trim(DIR, { max: AVIF_MAX_FILES, down: AVIF_MAX_FILES - 500, filter: isAvifName, onRemoved: () => { fast.clear(); bySrc.clear(); } }).catch(() => 0);

const pump = () => {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (job.client != null) {
      const n = (waitingOf.get(job.client) || 1) - 1;
      if (n > 0) waitingOf.set(job.client, n); else waitingOf.delete(job.client);
    }
    running++;
    job.run().finally(() => {
      running--;
      pump();
      pumpAvif();
    });
  }
};
// Is there room to wait? (the two limits above)
const roomFor = (client) => queue.length < MAX_QUEUE && (client == null || (waitingOf.get(client) || 0) < MAX_QUEUE_CLIENT);

// THE AVIF QUEUE (see the header). Nobody waits on it: a request that wants
// an AVIF not made yet is answered with the WebP and puts the AVIF here.
//   AVIF_CONCURRENT   encodes at once (libaom: several times a WebP's CPU)
//   AVIF_QUEUE_MAX    waiting; past it the ask is not queued (and not looked
//                     for again for AVIF_RETRY_MS — the WebP is the answer)
// An AVIF encode starts only when no WebP/JPEG variant is being made or
// waiting (somebody is waiting for those), and not while a viewer's video encode runs
// (media/cpuwork.js) — then it is looked at again in AVIF_VIEWER_WAIT_MS.
const AVIF_CONCURRENT = 1;
const AVIF_QUEUE_MAX = 400;
const AVIF_RETRY_MS = 30 * 1000;
const AVIF_VIEWER_WAIT_MS = 5000;
const avifQueue = [];
let avifRunning = 0;
let avifTimer = null;
const avifInflight = new Map(); // `${src}|${w}|0|avif` -> promise
const avifWait = new Map(); // same key -> not asked again before this time (failed, or the queue was full)
const avifStats = { queued: 0, made: 0, failed: 0, full: 0, heldForViewers: 0 };
const cpuworkLib = require("./lazy")(require, "../media/cpuwork");
const avifDeps = { viewerBusy: () => { try { return cpuworkLib().viewer.busy(); } catch { return false; } } };
const pumpAvif = () => {
  while (avifRunning < AVIF_CONCURRENT && avifQueue.length) {
    if (queue.length || running > 0) return; // pump() calls again when one ends
    if (avifDeps.viewerBusy()) {
      if (!avifTimer) {
        avifStats.heldForViewers++;
        avifTimer = setTimeout(() => { avifTimer = null; pumpAvif(); }, AVIF_VIEWER_WAIT_MS);
        if (avifTimer.unref) avifTimer.unref();
      }
      return;
    }
    const job = avifQueue.shift();
    avifRunning++;
    job.run().finally(() => {
      avifRunning--;
      pumpAvif();
    });
  }
};
const avifLater = (k, ms) => {
  if (avifWait.size > 4000) avifWait.clear();
  avifWait.set(k, Date.now() + ms);
};
const rememberAvif = (k, file) => {
  if (fast.size >= FAST_MAX) fast.delete(fast.keys().next().value);
  fast.set(k, { out: file, at: Date.now() });
  return file;
};
// Put an AVIF on the queue (once, however many ask). true: it is being made.
const queueAvif = (src, out, w, k) => {
  if (avifInflight.has(k)) return true;
  if (avifQueue.length >= AVIF_QUEUE_MAX) {
    avifStats.full++;
    avifLater(k, AVIF_RETRY_MS);
    return false;
  }
  const p = new Promise((resolve, reject) => {
    avifQueue.push({ run: () => encode(src, out, w, 0).then(resolve, reject) });
  });
  avifInflight.set(k, p);
  avifStats.queued++;
  p.then(
    (made) => { avifStats.made++; rememberAvif(k, made); },
    () => { avifStats.failed++; avifLater(k, FAIL_TTL); },
  ).finally(() => avifInflight.delete(k));
  // (on the next turn: the WebP this same request is about to queue goes first)
  setImmediate(pumpAvif);
  return true;
};

// WebP when this ffmpeg has libwebp (every build we've seen does; a JPEG at
// q4 otherwise). Same picture, roughly a third fewer bytes than the JPEG.
// Probed once, asynchronously, at load — never a blocking call inside a
// request; until the answer lands the odd early variant is a JPEG.
let webp = false;
// AVIF needs both libaom's AV1 encoder and the avif muxer (ffmpeg 6.0 on;
// Ubuntu 24.04's 6.1 has both) — asked once, at load, like the WebP probe.
let aom = false;
let avifMux = false;
if (config.FFMPEG) {
  execFile(config.FFMPEG, ["-hide_banner", "-encoders"], { windowsHide: true, timeout: 8000 }, (err, out) => {
    webp = !err && /\blibwebp\b/.test(String(out || ""));
    // (and an ffmpeg new enough for libaom's still-picture and all-intra
    // modes — an older one would fail every encode)
    if (!err && /\blibaom-av1\b/.test(String(out || "")))
      execFile(config.FFMPEG, ["-hide_banner", "-h", "encoder=libaom-av1"], { windowsHide: true, timeout: 8000 }, (e2, help) => {
        aom = !e2 && /still-picture/.test(String(help || "")) && /allintra/.test(String(help || ""));
      });
  });
  execFile(config.FFMPEG, ["-hide_banner", "-muxers"], { windowsHide: true, timeout: 8000 }, (err, out) => {
    avifMux = !err && /^\s*E\s+avif\b/m.test(String(out || ""));
  });
}
const hasWebp = () => webp;
// (`config.IMG_AVIF`: the admin's switch, on unless config.json says false;
// WebP is the fallback, so no WebP encoder means no AVIF either)
const hasAvif = () => !!(config.IMG_AVIF !== false && aom && avifMux && webp);

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

// The AVIF encode — every choice measured (docs/qa/avif/REPORT.md: 29
// real posters and backdrops from the library cache, 70 picture-and-width
// pairs, decoded in Chrome, against today's WebP on SSIM, MS-SSIM, PSNR-HVS
// and Netflix's banding score CAMBI, and crops looked at):
//   - 4:2:0 8-bit, FULL range (as the JPEG sources are): the AVIF baseline
//     profile, which every AVIF decoder reads; full range is what took the
//     banding below the WebP's (limited range banded more than the WebP in
//     dark skies and gradients; 10-bit shifted colours by a level in Chrome);
//   - libaom's all-intra mode tuned for SSIM, speed 6 (speed 4: 6× the CPU
//     for ~3% fewer bytes);
//   - crf 24 up to 1280 px and crf 18 from HERO_STEP up (the WebP there is
//     a finer q84 too): the highest crf at which the AVIF is as good as the
//     WebP on every measure, on average and on nearly every picture —
//     4–5% fewer bytes on posters, 17–18% on backdrops, ~19% on the hero;
//   - explicit colour tags (sRGB primaries and curve, BT.601 matrix — the
//     JPEG's) so no decoder has to guess;
//   - two threads, below normal priority like every picture variant.
const AVIF_CRF = 24;
const AVIF_CRF_HERO = 18;
const AVIF_CPU = 6;
const AVIF_THREADS = 2;
const avifCodec = (width) => [
  "-c:v", "libaom-av1", "-still-picture", "1", "-usage", "allintra",
  "-crf", String(width >= HERO_STEP ? AVIF_CRF_HERO : AVIF_CRF), "-cpu-used", String(AVIF_CPU), "-threads", String(AVIF_THREADS),
  "-aom-params", "tune=ssim",
  "-color_range", "pc", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-colorspace", "bt470bg",
];
const AVIF_TIMEOUT_MS = 60000;
const avifFilter = (width) => `scale='min(${width},iw)':-2:out_range=full,format=yuv420p`;

const encode = (src, out, width, blur = 0) =>
  new Promise((resolve, reject) => {
    const tmp = `${out}.tmp${path.extname(out)}`;
    // -2 keeps the height even (a JPEG requirement); q 4 / webp quality 78 are
    // visually transparent for artwork at these sizes.
    const isAvif = out.endsWith(".avif");
    const codec = isAvif ? avifCodec(width) : codecFor(out, width, blur);
    const fmt = blur && out.endsWith(".webp") ? "webp" : "";
    const vf = isAvif ? avifFilter(width) : filterFor(width, blur, fmt);
    // (started from a worker thread: lib/spawner.js — starting a process
    // blocked the event loop 50-90 ms each on a loaded Windows box)
    spawnerLib()
      .run(config.FFMPEG, ["-v", "error", "-y", "-i", src, "-vf", vf, "-frames:v", "1", ...codec, tmp], { timeoutMs: isAvif ? AVIF_TIMEOUT_MS : 20000, name: isAvif ? "picture variant (avif)" : "picture variant", maxBuffer: 64 * 1024, lower: true })
      .then((r) => {
        if (r.code !== 0) {
          fs.unlink(tmp, () => {});
          return reject(new Error(r.timedOut ? "ffmpeg timed out" : `ffmpeg ${r.code}: ${String(r.stderr || r.error || "").trim().slice(-200)}`));
        }
        fs.rename(tmp, out, (e) => {
          if (e) return reject(e);
          if (isAvif) { if (++avifWrites % 100 === 0) sweepAvif(); }
          else if (++writes % 100 === 0) sweep();
          resolve(out);
        });
      });
  });

// The path of a variant of `src` at `width` (ladder-snapped), made if it
// doesn't exist yet. Resolves null when no variant can be had — callers
// then send the original. When the reason is "too many waiting" the opts
// object is marked `shed: true`, so the caller can keep that answer out of
// long-lived caches. `opts.client`: who is asking (for the per-client limit). `opts.blur` (see the header): pre-blurred, at
// `width` or, with no usable width, at the original size. `opts.fmt`
// "webp": that blurred variant as WebP (ignored without blur, and where this
// ffmpeg has no libwebp — the JPEG is the answer then). `opts.avif` (the
// route's wantsAvif): the AVIF when it is made; when it is not, the variant
// it would have been without, and `opts.avifPending` set while the AVIF is
// on its way (the route caches that answer briefly).
const variant = async (src, width, opts = {}) => {
  const w = snap(width);
  const blur = blurOf(opts && opts.blur);
  const fmt = blur && hasWebp() ? fmtOf(opts && opts.fmt) : "";
  if ((!w && !blur) || !config.FFMPEG) return null;
  const fastKey = `${src}|${w || 0}|${blur}|${fmt}`;
  const known = fast.get(fastKey);
  const now = Date.now();
  // The AVIF first, for an asker that can have it: made → sent; on its way →
  // the WebP meanwhile; not known → looked for on disk below.
  const avifKey = !blur && w && opts && opts.avif && hasAvif() ? `${src}|${w}|0|avif` : null;
  let lookForAvif = false;
  if (avifKey) {
    const a = fast.get(avifKey);
    if (a && now - a.at < TRUST_MS) { fastStats.hits++; return a.out; }
    if (avifInflight.has(avifKey)) opts.avifPending = true;
    else if (now >= (avifWait.get(avifKey) || 0)) lookForAvif = true;
  }
  if (known && now - known.at < TRUST_MS && !lookForAvif) { fastStats.hits++; return known.out; }
  fastStats.misses++;
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
  const remember = (file) => {
    if (fast.size >= FAST_MAX) fast.delete(fast.keys().next().value);
    fast.set(fastKey, { out: file, at: Date.now() });
    noteSize(src, w, blur, fmt, file);
    return file;
  };
  if (lookForAvif) {
    // (the same key as the WebP's: the same source, the same width)
    const avifOut = path.join(DIR, `${key}-w${w}.avif`);
    try {
      if (fs.statSync(avifOut).size > 512) return rememberAvif(avifKey, avifOut);
    } catch {}
    if (queueAvif(src, avifOut, w, avifKey)) opts.avifPending = true;
    if (known && now - known.at < TRUST_MS) return known.out;
  }
  try {
    if (fs.statSync(out).size > 512) return remember(out);
  } catch {}
  if (Date.now() - (failed.get(out) || 0) < FAIL_TTL) return null;
  let p = inflight.get(out);
  if (!p) {
    const client = opts && opts.client != null ? String(opts.client) : null;
    if (running >= MAX_CONCURRENT && !roomFor(client)) {
      shedStats.shed++;
      if (opts && typeof opts === "object") opts.shed = true;
      return null; // the original, now — not a place in a queue that long
    }
    p = new Promise((resolve, reject) => {
      queue.push({ client, run: () => encode(src, out, w, blur).then(resolve, reject) });
      if (client != null) waitingOf.set(client, (waitingOf.get(client) || 0) + 1);
      pump();
    });
    inflight.set(out, p);
    const done = () => inflight.delete(out);
    p.then(done, done);
    // remembered when it is made, whoever is still waiting for it by then
    p.then((made) => { if (made) remember(made); }, () => {});
    p.catch(() => {
      if (failed.size > 2000) failed.clear();
      failed.set(out, Date.now());
    });
  }
  const maxWait = opts && opts.maxWaitMs != null ? opts.maxWaitMs : MAX_WAIT_MS;
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(LATE), maxWait); });
  try {
    const made = await Promise.race([p, late]);
    if (made === LATE) {
      waitStats.waited++;
      if (opts && typeof opts === "object") opts.shed = true;
      const near = nearest(src, w, blur, fmt);
      if (near) waitStats.gaveNearest++;
      else waitStats.gaveOriginal++;
      return near;
    }
    return made ? remember(made) : made;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
const LATE = Symbol("late");

// The AVIF side, for the admin's health numbers.
const avifStatus = () => ({ on: hasAvif(), waiting: avifQueue.length, running: avifRunning, ...avifStats });

module.exports = { variant, snap, blurOf, fmtOf, acceptsAvif, wantsAvif, filterFor, blurChain, codecFor, hasWebp, hasAvif, avifStatus, avifFilter, avifCodec, LADDER, MAX_BLUR, DIR, MAX_QUEUE, MAX_QUEUE_CLIENT, TRUST_MS, MAX_WAIT_MS, AVIF_MAX_FILES, forget: () => { fast.clear(); bySrc.clear(); avifWait.clear(); }, _internals: { queue, waitingOf, shedStats, waitStats, roomFor, inflight, fast, fastStats, sweep, sweepAvif, nearest, bySrc, avifQueue, avifInflight, avifWait, avifStats, avifDeps, pumpAvif, probe: { set: (v) => { if ("aom" in v) aom = v.aom; if ("avifMux" in v) avifMux = v.avifMux; if ("webp" in v) webp = v.webp; }, get: () => ({ aom, avifMux, webp }) } } };
