// Cinematic backdrops: grab a real frame from the video (~22% in, past any
// intro) and cache it. Gives the hero and detail pages proper landscape art
// instead of a blurred poster.
const fs = require("fs");
const path = require("path");
const config = require("../config");
const metadata = require("./metadata");

const STILL_DIR = path.join(config.CACHE_DIR, "stills");
const scannerLib = require("../lib/lazy")(require, "./scanner");
const spawnerLib = require("../lib/lazy")(require, "../lib/spawner");
// A library video's date as the scanner's last walk saw it (no stat), or null.
const walkedMtime = (videoPath) => {
  try {
    const st = scannerLib().walkedStat(videoPath);
    return st ? Math.floor(st.mtimeMs) : null;
  } catch {
    return null;
  }
};
const inflight = new Map(); // file -> Promise<string|null>
let active = 0;
const queue = [];
const MAX_CONCURRENT = 2;

const runNext = () => {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  active++;
  const job = queue.shift();
  job().finally(() => {
    active--;
    runNext();
  });
};

const generate = (videoPath, outFile) =>
  new Promise((resolve) => {
    const meta = metadata.getCached(videoPath);
    const duration = meta ? meta.duration : 0;
    const seekTo = duration > 120 ? Math.floor(duration * 0.22) : Math.floor(duration / 2) || 10;

    // (started from a worker thread: lib/spawner.js)
    spawnerLib()
      .run(config.FFMPEG, ["-v", "error", "-ss", String(seekTo), "-i", videoPath, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", "-y", outFile], { timeoutMs: 30000, maxBuffer: 64 * 1024, name: "still", lower: true })
      .then((r) => (r.code === 0 ? fs.promises.access(outFile).then(() => outFile, () => null) : null))
      .then(resolve);
  });

// A frame at (roughly) a given second — the resume prompt's "this is where
// you stopped". Bucketed to 10s so a slowly-moving resume point doesn't
// mint a new file every save; small (640px) because it's a thumbnail.
const generateAt = (videoPath, seconds, outFile) =>
  new Promise((resolve) => {
    spawnerLib()
      .run(config.FFMPEG, ["-v", "error", "-ss", String(Math.max(0, Math.floor(seconds))), "-i", videoPath, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", "-y", outFile], { timeoutMs: 30000, maxBuffer: 64 * 1024, name: "frame", lower: true })
      .then((r) => (r.code === 0 ? fs.promises.access(outFile).then(() => outFile, () => null) : null))
      .then(resolve);
  });

const getFrame = (videoPath, seconds) => {
  if (!config.ffmpegAvailable) return Promise.resolve(null);
  let mtime = 0;
  try {
    mtime = Math.floor(fs.statSync(videoPath).mtimeMs);
  } catch {
    return Promise.resolve(null);
  }
  const bucket = Math.max(0, Math.floor((Number(seconds) || 0) / 10) * 10);
  const name =
    require("crypto").createHash("md5").update(`${videoPath}|${mtime}|frame|${bucket}`).digest("hex") + ".jpg";
  const outFile = path.join(STILL_DIR, name);
  if (fs.existsSync(outFile)) return Promise.resolve(outFile);
  const key = `frame|${outFile}`;
  if (inflight.has(key)) return inflight.get(key);
  fs.mkdirSync(STILL_DIR, { recursive: true });
  const p = new Promise((resolve) => {
    queue.push(() => generateAt(videoPath, bucket, outFile).then(resolve));
    runNext();
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
};

// Returns the cached still path, generating it on first request.
const getStill = (videoPath) => {
  if (!config.ffmpegAvailable) return Promise.resolve(null);

  let mtime = 0;
  // (the date from the library walk when it has one — no stat — and a still
  // already known to be made is not looked for on disk again: hasStill below)
  const walked = walkedMtime(videoPath);
  if (walked != null) mtime = walked;
  else {
    try {
      mtime = Math.floor(fs.statSync(videoPath).mtimeMs);
    } catch {
      return Promise.resolve(null);
    }
  }

  const name =
    require("crypto").createHash("md5").update(`${videoPath}|${mtime}`).digest("hex") + ".jpg";
  const outFile = path.join(STILL_DIR, name);
  if (made.has(`${videoPath}|${mtime}`) || fs.existsSync(outFile)) return Promise.resolve(outFile);

  if (inflight.has(outFile)) return inflight.get(outFile);

  fs.mkdirSync(STILL_DIR, { recursive: true });
  const promise = new Promise((resolve) => {
    queue.push(() =>
      // A synchronous throw inside generate() (missing ffmpeg path, metadata
      // error) would otherwise leave this promise pending forever AND keep the
      // dead entry in `inflight`, hanging every future request for this video.
      generate(videoPath, outFile)
        .catch(() => null)
        .then((r) => {
          inflight.delete(outFile);
          if (r) notYet.delete(videoPath); // its placeholder may be made now (hasStill)
          resolve(r);
          return r;
        })
    );
    runNext();
  });
  inflight.set(outFile, promise);
  return promise;
};

// Is this film's still already made? (Without making it.) The blur-up
// placeholders (lib/blurup.js) ask before they fetch /img/still/: a list of
// 1,261 films used to have every film's frame cut out of its video just so a
// 150-byte placeholder could be made of it — about a thousand ffmpeg runs for
// pictures nobody had opened. A still is made when a screen asks for it; its
// placeholder after that. "Made" is remembered (a still is never deleted
// while its file is unchanged); "not made" is asked again after a minute.
const MADE_MAX = 20000;
const made = new Map(); // `${videoPath}|${mtime}` -> true
const notYet = new Map(); // videoPath -> checkedAt
const NOT_YET_MS = 60 * 1000;
const hasStill = (videoPath, now = Date.now()) => {
  const checked = notYet.get(videoPath);
  if (checked && now - checked < NOT_YET_MS) return false;
  let mtime = walkedMtime(videoPath);
  if (mtime == null) {
    try {
      mtime = Math.floor(fs.statSync(videoPath).mtimeMs);
    } catch {
      return false;
    }
  }
  const key = `${videoPath}|${mtime}`;
  if (made.has(key)) return true;
  const name = require("crypto").createHash("md5").update(`${videoPath}|${mtime}`).digest("hex") + ".jpg";
  if (fs.existsSync(path.join(STILL_DIR, name))) {
    if (made.size >= MADE_MAX) made.clear();
    made.set(key, true);
    notYet.delete(videoPath);
    return true;
  }
  if (notYet.size >= MADE_MAX) notYet.clear();
  notYet.set(videoPath, now);
  return false;
};

module.exports = { getStill, getFrame, hasStill, _internals: { made, notYet } };
