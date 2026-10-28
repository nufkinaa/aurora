// The fast first segment (media/jit.js fastArgs) is the SAME KIND of H.264 as
// the ladder's own encode that takes over from it: the same sequence header
// (profile, reference pictures, reordering). Plain x264 "ultrafast" is
// Constrained Baseline with no B-frames; where it handed over to the ladder's
// High-with-B-frames the decoder met a new header mid-play and started over —
// a 120–140 ms hitch and dropped frames ~9 s after every seek on a CPU encode
// (measured on a watch party's CPU-encoded guest, tools/ttff/party.js).
// Real ffmpeg for the header check; skipped without libx264.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const config = require("../src/config");
const jit = require("../src/media/jit");
const ladder = require("../src/media/ladder");
const J = jit._internals;

const haveX264 = () => {
  if (!config.ffmpegAvailable) return false;
  try {
    const enc = execFileSync(config.FFMPEG, ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const bsf = execFileSync(config.FFMPEG, ["-hide_banner", "-bsfs"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return /libx264/.test(enc) && /trace_headers/.test(bsf);
  } catch { return false; }
};

test("fastArgs: ultrafast, kept to the ladder's stream structure; an ultrafast ladder is left as it is", () => {
  const sf = ["-c:v", "libx264", "-preset", "superfast", "-crf", "18"];
  assert.equal(J.fastArgs(sf).join(" "), `-c:v libx264 -preset ultrafast -x264-params ${J.FAST_X264} -crf 18`);
  assert.deepEqual(sf, ["-c:v", "libx264", "-preset", "superfast", "-crf", "18"], "the ladder's own args are not touched");
  const uf = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18"];
  assert.deepEqual(J.fastArgs(uf), uf);
  assert.deepEqual(J.fastArgs(["-c:v", "h264_nvenc"]), ["-c:v", "h264_nvenc"]);
});

// The sequence header's fields, as ffmpeg's trace_headers prints them.
const spsOf = (file) => {
  const r = spawnSync(config.FFMPEG, ["-hide_banner", "-i", file, "-c:v", "copy", "-bsf:v", "trace_headers", "-frames:v", "2", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const out = {};
  let inSps = false;
  for (const line of String(r.stderr).split("\n")) {
    if (/Sequence Parameter Set/.test(line)) { inSps = true; continue; }
    if (/Picture Parameter Set|Supplemental Enhancement|Slice Header/.test(line)) inSps = false;
    if (!inSps) continue;
    const m = line.match(/\]\s+\d+\s+(\w+(?:\[[^\]]*\])?)\s+[01]+\s+=\s+(-?\d+)/);
    if (m && !(m[1] in out)) out[m[1]] = Number(m[2]);
  }
  return out;
};

test("real ffmpeg: the fast segment's sequence header is the ladder's, field for field", { skip: !haveX264() && "no ffmpeg with libx264 and trace_headers" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-fasthdr-"));
  try {
    const src = path.join(dir, "src.mkv");
    execFileSync(config.FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=4:size=640x360:rate=24", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p", src]);
    const rung = { name: "h264-480", h: 480, level: 31 };
    const args = ladder._internals && ladder._internals.encVideoArgs ? ladder._internals.encVideoArgs(rung) : ladder.encVideoArgs(rung);
    const ladderArgs = args.map((a) => (a === "superfast" || a === "ultrafast" ? "superfast" : a)); // the ladder's usual preset
    const enc = (vargs, name) => {
      const f = path.join(dir, `${name}.ts`);
      execFileSync(config.FFMPEG, ["-v", "error", "-i", src, "-an", ...vargs, "-f", "mpegts", "-y", f]);
      return spsOf(f);
    };
    const ladderSps = enc(ladderArgs, "ladder");
    const fastSps = enc(J.fastArgs(ladderArgs), "fast");
    assert.ok(Object.keys(ladderSps).length > 10, `the header was read (${JSON.stringify(ladderSps)})`);
    assert.equal(ladderSps.profile_idc, 100, "the ladder makes High");
    assert.deepEqual(fastSps, ladderSps);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
