// Cinematic backdrops: grab a real frame from the video (~22% in, past any
// intro) and cache it. Gives the hero and detail pages proper landscape art
// instead of a blurred poster.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("../config");
const metadata = require("./metadata");

const STILL_DIR = path.join(config.CACHE_DIR, "stills");
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

    execFile(
      config.FFMPEG,
      [
        "-v", "error",
        "-ss", String(seekTo),
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", "scale=1280:-2",
        "-q:v", "3",
        "-y", outFile,
      ],
      { windowsHide: true, timeout: 30000 },
      (err) => resolve(!err && fs.existsSync(outFile) ? outFile : null)
    );
  });

// Returns the cached still path, generating it on first request.
const getStill = (videoPath) => {
  if (!config.ffmpegAvailable) return Promise.resolve(null);

  let mtime = 0;
  try {
    mtime = Math.floor(fs.statSync(videoPath).mtimeMs);
  } catch {
    return Promise.resolve(null);
  }

  const name =
    require("crypto").createHash("md5").update(`${videoPath}|${mtime}`).digest("hex") + ".jpg";
  const outFile = path.join(STILL_DIR, name);
  if (fs.existsSync(outFile)) return Promise.resolve(outFile);

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
          resolve(r);
          return r;
        })
    );
    runNext();
  });
  inflight.set(outFile, promise);
  return promise;
};

module.exports = { getStill };
