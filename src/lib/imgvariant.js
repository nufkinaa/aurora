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
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const config = require("../config");

const DIR = path.join(config.CACHE_DIR, "img-variants");
try {
  fs.mkdirSync(DIR, { recursive: true });
} catch {}

const LADDER = [240, 360, 480, 640, 800, 960, 1280];
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

const encode = (src, out, width) =>
  new Promise((resolve, reject) => {
    const tmp = `${out}.tmp${path.extname(out)}`;
    // -2 keeps the height even (a JPEG requirement); q 4 / webp quality 78 are
    // visually transparent for artwork at these sizes.
    const codec = out.endsWith(".webp")
      ? ["-c:v", "libwebp", "-quality", "78", "-compression_level", "4"]
      : ["-q:v", "4"];
    execFile(
      config.FFMPEG,
      ["-v", "error", "-y", "-i", src, "-vf", `scale='min(${width},iw)':-2`, "-frames:v", "1", ...codec, tmp],
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
// then send the original.
const variant = async (src, width) => {
  const w = snap(width);
  if (!w || !config.FFMPEG) return null;
  let st;
  try {
    st = fs.statSync(src);
  } catch {
    return null;
  }
  const key = crypto.createHash("md5").update(`${src}|${st.mtimeMs}|${st.size}|${w}`).digest("hex");
  const out = path.join(DIR, `${key}-w${w}.${hasWebp() ? "webp" : "jpg"}`);
  try {
    if (fs.statSync(out).size > 512) return out;
  } catch {}
  if (Date.now() - (failed.get(out) || 0) < FAIL_TTL) return null;
  let p = inflight.get(out);
  if (!p) {
    p = new Promise((resolve, reject) => {
      queue.push(() => encode(src, out, w).then(resolve, reject));
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

module.exports = { variant, snap, LADDER, DIR };
