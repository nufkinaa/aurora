#!/usr/bin/env node
// Linux (WSL) runs: a settled seed for a library copied into the Linux
// filesystem, made from the Windows harness's generated-media seed. The
// probe cache is keyed by absolute path + mtime, so its keys are rewritten to
// the Linux paths and its mtimes to the Linux files' — the box then needs no
// ffprobe to know its library (Ubuntu here has no ffmpeg; CI has none either).
//
//   node tools/loadtest/wsl-seed.js --from /mnt/c/.../seed-gen-v1 --win-media 'C:\...\media-gen-v1-300' \
//        --media ~/aurora-lt/media --out <LT_WORK>/seed-dir-<md5 of the media path, 8>
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseArgs, WORK } = require("./lib");

const a = parseArgs();
const from = a.from, winMedia = String(a["win-media"] || ""), media = path.resolve(a.media);
const out = a.out || path.join(WORK, `seed-dir-${crypto.createHash("md5").update(media).digest("hex").slice(0, 8)}`);
if (!from || !winMedia || !a.media) throw new Error("--from, --win-media and --media are needed");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "cache"), { recursive: true });
const BS = String.fromCharCode(92);
const winPrefix = winMedia.toLowerCase().split(BS).join("/");
let mapped = 0, missing = 0;
for (const f of fs.readdirSync(from)) {
  const p = path.join(from, f);
  if (fs.statSync(p).isDirectory() || f === ".ready") continue;
  if (f !== "metadata-cache.json") { fs.copyFileSync(p, path.join(out, f)); continue; }
  const src = JSON.parse(fs.readFileSync(p, "utf8"));
  const dst = {};
  for (const [k, v] of Object.entries(src)) {
    const fwd = k.split(BS).join("/");
    if (!fwd.toLowerCase().startsWith(winPrefix)) continue;
    const lin = path.join(media, fwd.slice(winPrefix.length));
    try { dst[lin] = { ...v, mtime: fs.statSync(lin).mtimeMs }; mapped++; } catch { missing++; }
  }
  fs.writeFileSync(path.join(out, f), JSON.stringify(dst));
}
for (const f of fs.readdirSync(path.join(from, "cache"))) {
  const p = path.join(from, "cache", f);
  if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(out, "cache", f));
}
fs.writeFileSync(path.join(out, ".ready"), new Date().toISOString());
console.log(`seed ${out}: ${mapped} probes mapped, ${missing} missing`);
