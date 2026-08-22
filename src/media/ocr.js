// Automatic OCR of bitmap-only embedded subtitles into synced .srt files.
// Serial background queue; emits events so clients can be notified live.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const events = new EventEmitter();
const OCR_SCRIPT = path.join(config.ROOT, "tools", "bitmap-subs-to-srt.py");
const failed = new JsonStore(path.join(config.DATA_DIR, "ocr-failed.json"), {});

const queue = [];
const queued = new Set();
let running = null;

const enqueue = (videoPath, displayName) => {
  if (!config.ocrAvailable || !config.AUTO_OCR) return;
  if (queued.has(videoPath) || running === videoPath) return;

  let mtime = 0;
  try {
    mtime = fs.statSync(videoPath).mtimeMs;
  } catch {
    return;
  }
  const prev = failed.data[videoPath];
  if (prev && prev.mtime === mtime) return; // don't retry unchanged failures

  queued.add(videoPath);
  queue.push({ videoPath, displayName, mtime });
  processQueue();
};

const processQueue = () => {
  if (running || queue.length === 0) return;

  const job = queue.shift();
  queued.delete(job.videoPath);
  running = job.videoPath;

  console.log(`Auto-OCR: generating subtitles for ${job.displayName}...`);
  events.emit("job", { status: "started", name: job.displayName });

  const proc = spawn(config.PYTHON, [OCR_SCRIPT, job.videoPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let output = "";
  proc.stdout.on("data", (d) => (output += d.toString()));
  proc.stderr.on("data", (d) => (output += d.toString()));

  const killTimer = setTimeout(() => proc.kill(), 20 * 60 * 1000);

  const done = (code) => {
    clearTimeout(killTimer);
    running = null;

    const srtPath =
      job.videoPath.slice(0, -path.extname(job.videoPath).length) + ".srt";
    if (code === 0 && fs.existsSync(srtPath)) {
      console.log(`Auto-OCR: subtitles ready for ${job.displayName}`);
      events.emit("job", { status: "done", name: job.displayName });
    } else {
      failed.data[job.videoPath] = {
        mtime: job.mtime,
        at: new Date().toISOString(),
        error: output.trim().slice(-300),
      };
      failed.save();
      console.error(`Auto-OCR failed for ${job.displayName}:`, output.trim().slice(-300));
      events.emit("job", { status: "failed", name: job.displayName });
    }
    processQueue();
  };

  proc.on("close", done);
  proc.on("error", () => done(-1));
};

module.exports = { enqueue, events };
