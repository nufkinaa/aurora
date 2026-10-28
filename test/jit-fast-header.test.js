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

test("fastArgs: ultrafast, kept to the ladder's stream structure; an ultrafast ladder keeps (or gets) the same parameters", () => {
  const sf = ["-c:v", "libx264", "-preset", "superfast", "-crf", "18"];
  assert.equal(J.fastArgs(sf).join(" "), `-c:v libx264 -preset ultrafast -x264-params ${J.FAST_X264} -crf 18`);
  assert.deepEqual(sf, ["-c:v", "libx264", "-preset", "superfast", "-crf", "18"], "the ladder's own args are not touched");
  // an ultrafast ladder (encbudget.presetArgs while the machine is behind) already carries them: left as it is
  const ufp = ["-c:v", "libx264", "-preset", "ultrafast", "-x264-params", J.FAST_X264, "-crf", "18"];
  assert.deepEqual(J.fastArgs(ufp), ufp);
  // a bare ultrafast list (made before the parameters existed) gets them
  const uf = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18"];
  assert.equal(J.fastArgs(uf).join(" "), `-c:v libx264 -preset ultrafast -x264-params ${J.FAST_X264} -crf 18`);
  assert.deepEqual(J.fastArgs(["-c:v", "h264_nvenc"]), ["-c:v", "h264_nvenc"]);
});

// encbudget.presetNow says "ultrafast" for a while after an encode fell
// behind real time. Every encoder that takes it (the ladder, the
// single-rendition / TV offset encode, the torrent transcode) carries the
// fast segment's parameters with it, so a viewer crossing from one encode to
// the next never meets another kind of H.264.
const budget = require("../src/media/encbudget");
const remux = require("../src/media/remux");
const tt = require("../src/media/torrent-transcode");
const behind = (fn) => {
  const st = budget._internals.state;
  const was = st.slowAt;
  st.slowAt = Date.now();
  try { return fn(); } finally { st.slowAt = was; }
};
const presetPart = (args) => {
  const i = args.indexOf("-preset");
  const j = args.indexOf("-x264-params");
  return [args[i + 1], j >= 0 ? args[j + 1] : null];
};

test("presetArgs: superfast alone; ultrafast always with the fast segment's parameters (one constant)", () => {
  assert.equal(budget.FAST_X264, J.FAST_X264);
  assert.equal(budget.FAST_X264, "8x8dct=1:bframes=3:b-adapt=0:b-pyramid=normal");
  const st = budget._internals.state;
  const was = st.slowAt;
  try {
    st.slowAt = 0;
    assert.deepEqual(budget.presetArgs(), ["-preset", "superfast"]);
    assert.equal(budget.presetNow(), "superfast");
    st.slowAt = Date.now();
    assert.deepEqual(budget.presetArgs(), ["-preset", "ultrafast", "-x264-params", budget.FAST_X264]);
    // the slow period ends: superfast again, no parameters
    st.slowAt = Date.now() - budget._internals.SLOW_PRESET_MS - 1;
    assert.deepEqual(budget.presetArgs(), ["-preset", "superfast"]);
  } finally { st.slowAt = was; }
});

test("behind real time: ladder, single-rendition and torrent encodes all start ultrafast WITH the parameters", () => {
  const rung = { name: "h264-480", h: 480, level: 31 };
  const enc = () => (ladder._internals && ladder._internals.encVideoArgs ? ladder._internals.encVideoArgs(rung) : ladder.encVideoArgs(rung));
  const normal = [presetPart(enc()), presetPart(remux._internals.videoArgsFor("h264")), presetPart(remux._internals.videoArgsFor("h264-720")), presetPart(tt._internals.videoArgsFor("h264"))];
  for (const p of normal) assert.deepEqual(p, ["superfast", null]);
  const slow = behind(() => [enc(), remux._internals.videoArgsFor("h264"), remux._internals.videoArgsFor("h264-480"), tt._internals.videoArgsFor("h264")]);
  for (const a of slow) {
    assert.deepEqual(presetPart(a), ["ultrafast", budget.FAST_X264], a.join(" "));
    assert.equal(a.filter((x) => x === "-x264-params").length, 1, "one -x264-params");
  }
  // jit's fast first segment from an ultrafast ladder: the same list (nothing doubled)
  assert.deepEqual(J.fastArgs(slow[0]), slow[0]);
  // copy stays copy
  assert.deepEqual(behind(() => remux._internals.videoArgsFor("copy")), ["-c:v", "copy"]);
  assert.deepEqual(behind(() => tt._internals.videoArgsFor("copy")), ["-c:v", "copy"]);
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
    // the ladder started while this machine is behind real time (encbudget
    // presetNow "ultrafast"), and its fast first segment: the same header
    const slowArgs = behind(() => (ladder._internals && ladder._internals.encVideoArgs ? ladder._internals.encVideoArgs(rung) : ladder.encVideoArgs(rung)));
    assert.ok(slowArgs.includes("ultrafast"), slowArgs.join(" "));
    assert.deepEqual(enc(slowArgs, "ladder-slow"), ladderSps, "an ultrafast ladder encode: the superfast ladder's header");
    assert.deepEqual(enc(J.fastArgs(slowArgs), "fast-slow"), ladderSps, "its fast first segment: the same");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("real ffmpeg: the single-rendition (TV offset) encode keeps its header when it starts ultrafast", { skip: !haveX264() && "no ffmpeg with libx264 and trace_headers" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-fasthdr-"));
  try {
    const src = path.join(dir, "src.mkv");
    execFileSync(config.FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=4:size=640x360:rate=24", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p", src]);
    const enc = (vargs, name) => {
      const f = path.join(dir, `${name}.ts`);
      execFileSync(config.FFMPEG, ["-v", "error", "-i", src, "-an", ...vargs, "-f", "mpegts", "-y", f]);
      return spsOf(f);
    };
    for (const v of ["h264", "h264-720"]) {
      const normal = remux._internals.videoArgsFor(v);
      assert.ok(normal.includes("superfast"));
      const slow = behind(() => remux._internals.videoArgsFor(v));
      const a = enc(normal, `remux-${v}`);
      assert.ok(Object.keys(a).length > 10, `the header was read (${JSON.stringify(a)})`);
      assert.equal(a.profile_idc, 100, "superfast makes High");
      assert.deepEqual(enc(slow, `remux-${v}-slow`), a, `${v}: ultrafast with the parameters = superfast's header`);
    }
    // and the torrent transcode
    const tn = enc(tt._internals.videoArgsFor("h264"), "tt");
    assert.deepEqual(enc(behind(() => tt._internals.videoArgsFor("h264")), "tt-slow"), tn);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
