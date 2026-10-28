// A helper PROCESS for introdetect.js: decodes a stretch of an episode's
// sound with ffmpeg and fingerprints it (introprint.js) — so neither the
// decode's output nor a second of fingerprinting ever passes through the
// server's event loop. It runs at the lowest CPU priority (the pool lowers
// it, cpuwork.background.lower; ffmpeg inherits it), so on a busy machine it
// gets only what nobody else wants.
//   message { id, file, start, length, ffmpeg }  ->  { id, codes, valid, level } | { id, error }
//   (codes / valid as Buffers of the typed arrays; null when nothing could be read)
"use strict";
const { execFile } = require("child_process");
const introprint = require("./introprint");

const SR = introprint.SR;

const decode = (ffmpeg, file, start, length) =>
  new Promise((resolve) => {
    const args = ["-v", "error", "-nostdin", "-threads", "1"];
    if (start > 0) args.push("-ss", String(start));
    args.push("-i", file, "-t", String(length), "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-");
    execFile(ffmpeg, args, { encoding: "buffer", maxBuffer: Math.ceil(length * SR * 2 + 4 * 1024 * 1024), windowsHide: true, timeout: Math.max(60000, length * 100) }, (err, stdout) => {
      if (!stdout || !stdout.length) return resolve(null);
      resolve(new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2)));
    });
  });

process.on("message", async (m) => {
  if (!m || m.id == null) return;
  try {
    const pcm = await decode(m.ffmpeg, m.file, m.start || 0, m.length);
    if (!pcm || pcm.length <= introprint.N * 2) return process.send({ id: m.id, codes: null, valid: null });
    const fp = introprint.fingerprint(pcm);
    process.send({ id: m.id, codes: Buffer.from(fp.codes.buffer), valid: Buffer.from(fp.valid.buffer), level: Buffer.from(fp.level.buffer) });
  } catch (e) {
    process.send({ id: m.id, error: (e && e.message) || String(e) });
  }
});
process.on("disconnect", () => process.exit(0));
