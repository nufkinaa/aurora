// A file's speech timeline (src/media/speech.js) through the real ffmpeg:
// generated media only (speech-like syllables written by this test, a held
// chord and noise in the other channels), kept in a temp folder. Skipped
// cleanly where ffmpeg is not installed.
//   - one value per 10 ms, high where the words are;
//   - a 5.1 track is heard through its CENTRE channel (where films put
//     dialogue): loud music and noise in the others do not count;
//   - the second call is the cache;
//   - an urgent decode in parts gives the same timeline as one pass (the
//     parts meet exactly on the 10 ms grid);
//   - an urgent call does not wait behind a background one for the same file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const config = require("../src/config");
const speech = require("../src/media/speech");

const ffmpeg = config.FFMPEG;
const ffprobe = config.FFPROBE;
const skip = !(ffmpeg && ffprobe) && "ffmpeg is not installed";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-speech-test-"));
const D = speech._internals.deps;
const keep = { ...D };
D.dir = () => path.join(DIR, "cache");
// a probe of our own: the real one keeps a store in data/
D.probe = async (p) => {
  const j = JSON.parse(execFileSync(ffprobe, ["-v", "quiet", "-show_entries", "format=duration:stream=codec_type,channels,channel_layout", "-of", "json", p], { encoding: "utf-8" }));
  return {
    duration: +j.format.duration,
    audioStreams: j.streams.filter((s) => s.codec_type === "audio").map((s, index) => ({ index, channels: s.channels, layout: s.channel_layout || null })),
  };
};
// the CPU budget as a stub: a place at once, or held until released
let held = null;
const gateCalls = [];
D.cpuwork = () => ({
  viewer: { busy: () => false },
  PRIORITY: { viewer: os.constants.priority.PRIORITY_BELOW_NORMAL, background: os.constants.priority.PRIORITY_LOW },
  background: {
    gate: (kind) => {
      gateCalls.push(kind);
      const place = { attach() {}, release() {} };
      return held ? held.then(() => place) : Promise.resolve(place);
    },
  },
});
test.after(() => {
  Object.assign(D, keep);
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------- generated audio ----------
const R = 8000;
let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s - 3; };
const speechInto = (x, a, b) => {
  for (let t = a; t < b;) {
    const syl = 0.12 + rnd() * 0.18;
    const f0 = 100 + rnd() * 120;
    const F1 = 400 + rnd() * 500;
    const F2 = 1100 + rnd() * 1300;
    const s0 = Math.floor(t * R);
    const s1 = Math.min(Math.floor((t + syl) * R), Math.floor(b * R));
    let ph = 0;
    for (let i = s0; i < s1; i++) {
      const u = (i - s0) / (s1 - s0);
      ph += (2 * Math.PI * f0 * (1 + 0.1 * (u - 0.5))) / R;
      let v = 0;
      for (let h = 1; h * f0 < 3400; h++) {
        const hf = h * f0;
        v += ((Math.exp(-(((hf - F1) / 250) ** 2)) + 0.6 * Math.exp(-(((hf - F2) / 350) ** 2)) + 0.05) * Math.sin(h * ph)) / h ** 0.3;
      }
      x[i] += 0.08 * Math.sin(Math.PI * u) * v;
    }
    t += syl + 0.02 + rnd() * 0.08;
    if (rnd() < 0.15) t += 0.3 + rnd() * 0.6;
  }
};
// where the words are: 2-minute file, five stretches
const DUR = 125;
const TALK = [[6, 16], [28, 35], [50, 64], [80, 88], [104, 118]];
const writeWav = (file, channels) => {
  const n = DUR * R;
  const ch = channels.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(R, 24); buf.writeUInt32LE(R * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * ch * 2, 40);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, n * ch);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) pcm[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767)));
  fs.writeFileSync(file, buf);
};
const make = (name, layout) => {
  seed = 3;
  const n = DUR * R;
  const voice = new Float64Array(n);
  for (let i = 0; i < n; i++) voice[i] = 0.003 * gauss();
  for (const [a, b] of TALK) speechInto(voice, a, b);
  const wav = path.join(DIR, `${name}.wav`);
  if (layout === "mono") writeWav(wav, [voice]);
  else {
    // 5.1: FL FR FC LFE BL BR — the words in the centre only, a loud chord
    // and noise everywhere else, all the time
    const music = new Float64Array(n);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const t = i / R;
      let v = 0;
      for (const f of [220, 277.2, 329.6]) v += Math.sin(2 * Math.PI * f * t);
      p = 0.9 * p + gauss();
      music[i] = 0.12 * v + 0.05 * p;
    }
    writeWav(wav, [music, music, voice, new Float64Array(n), music, music]);
  }
  const out = path.join(DIR, `${name}.mkv`);
  const r = spawnSync(ffmpeg, ["-v", "error", "-y", "-i", wav, ...(layout === "mono" ? [] : ["-af", "aformat=channel_layouts=5.1"]), "-c:a", "pcm_s16le", out], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  fs.unlinkSync(wav);
  return out;
};
const mean = (p, a, b) => { let s = 0; for (let i = Math.round(a * 100); i < Math.round(b * 100); i++) s += p[i]; return s / ((b - a) * 100) / 255; };
const talkVsQuiet = (p) => {
  const inside = TALK.map(([a, b]) => mean(p, a + 1, b - 1));
  const quiet = [];
  for (let k = 0; k + 1 < TALK.length; k++) quiet.push(mean(p, TALK[k][1] + 3, TALK[k + 1][0] - 2));
  return { inside: Math.min(...inside), quiet: Math.max(...quiet) };
};

let MONO;
let SURROUND;

test("filterFor: the centre channel of a surround track, the down-mix of stereo", () => {
  assert.match(speech.filterFor({ layout: "5.1(side)", channels: 6 }), /^pan=mono\|c0=FC,aresample=8000/);
  assert.match(speech.filterFor({ layout: "7.1", channels: 8 }), /^pan=mono\|c0=FC,/);
  assert.match(speech.filterFor({ layout: null, channels: 6 }), /^pan=mono\|c0=FC,/);
  assert.equal(speech.filterFor({ layout: "stereo", channels: 2 }), "aresample=8000:async=1:first_pts=0");
});

test("a mono file: one value per 10 ms, high where the words are", { skip }, async () => {
  MONO = make("mono", "mono");
  const res = await speech.timeline(MONO, { urgent: true, parts: 1 });
  assert.equal(res.cached, false);
  assert.ok(Math.abs(res.speech.length - DUR * 100) <= 2, `${res.speech.length} frames`);
  const { inside, quiet } = talkVsQuiet(res.speech);
  assert.ok(inside > 0.6 && quiet < 0.3, `talk ${inside.toFixed(2)} quiet ${quiet.toFixed(2)}`);
  // the second time: the cache (memory, then the file)
  const again = await speech.timeline(MONO, { urgent: true });
  assert.equal(again.cached, true);
  assert.deepEqual(again.speech, res.speech);
  speech._internals.memo.clear();
  const fromDisk = speech.cached(MONO, 0);
  assert.ok(fromDisk, "kept in the cache folder");
  assert.deepEqual(fromDisk, res.speech);
  assert.equal(fs.readdirSync(path.join(DIR, "cache")).filter((f) => f.endsWith(".u8")).length, 1);
});

test("urgent parts give the same timeline as one pass (they meet on the 10 ms grid)", { skip }, async (t) => {
  assert.ok(MONO);
  speech._internals.memo.clear();
  fs.rmSync(path.join(DIR, "cache"), { recursive: true, force: true });
  const one = (await speech.timeline(MONO, { urgent: true, parts: 1 })).speech;
  for (const parts of [3, 4]) {
    speech._internals.memo.clear();
    fs.rmSync(path.join(DIR, "cache"), { recursive: true, force: true });
    const progress = [];
    const res = await speech.timeline(MONO, { urgent: true, parts, onProgress: (x) => progress.push(x) });
    const many = res.speech;
    assert.equal(many.length, one.length, `${parts} parts: same length`);
    let worst = 0;
    let sum = 0;
    for (let i = 0; i < one.length; i++) { const d = Math.abs(one[i] - many[i]); worst = Math.max(worst, d); sum += d; }
    assert.ok(sum / one.length < 1, `${parts} parts: mean difference ${(sum / one.length).toFixed(2)} of 255`);
    assert.ok(worst < 64, `${parts} parts: worst frame ${worst}`);
    t.diagnostic(`${parts} parts: mean |difference| ${(sum / one.length).toFixed(3)} of 255, worst frame ${worst}`);
    assert.equal(progress[progress.length - 1], 1);
    for (let k = 1; k < progress.length; k++) assert.ok(progress[k] >= progress[k - 1], "progress only goes up");
  }
});

test("urgent, read once in pieces: the same timeline as one pass — also when the track starts late", { skip }, async (t) => {
  assert.ok(MONO);
  // a copy whose audio starts 1.3 s after the picture (a delayed track)
  const late = path.join(DIR, "late.mkv");
  const r = spawnSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=64x64:r=10:d=${DUR + 2}`, "-itsoffset", "1.3", "-i", MONO, "-map", "0:v", "-map", "1:a", "-c:v", "ffv1", "-c:a", "aac", "-b:a", "96k", late], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  const keepSeg = D.segmentSeconds;
  D.segmentSeconds = () => 30; // five pieces
  const got = {};
  try {
    for (const file of [MONO, late]) {
      speech._internals.memo.clear();
      fs.rmSync(path.join(DIR, "cache"), { recursive: true, force: true });
      const one = (await speech.timeline(file, { urgent: true, parts: 1 })).speech;
      speech._internals.memo.clear();
      fs.rmSync(path.join(DIR, "cache"), { recursive: true, force: true });
      const progress = [];
      const staged = (await speech.timeline(file, { urgent: true, onProgress: (x) => progress.push(x) })).speech;
      got[file] = staged;
      assert.ok(Math.abs(staged.length - one.length) <= 2, `${path.basename(file)}: ${staged.length} vs ${one.length} frames`);
      let sum = 0;
      let worst = 0;
      const L = Math.min(one.length, staged.length);
      for (let i = 0; i < L; i++) { const d = Math.abs(one[i] - staged[i]); sum += d; worst = Math.max(worst, d); }
      t.diagnostic(`${path.basename(file)}: pieces vs one pass, mean |difference| ${(sum / L).toFixed(3)} of 255, worst frame ${worst}`);
      assert.ok(sum / L < 1.5, `${path.basename(file)}: mean difference ${(sum / L).toFixed(2)}`);
      assert.equal(progress[progress.length - 1], 1);
      for (let k = 1; k < progress.length; k++) assert.ok(progress[k] >= progress[k - 1], "progress only goes up");
      assert.deepEqual(fs.readdirSync(path.join(DIR, "cache")).filter((x) => x.startsWith("tmp-")), [], "the pieces' folder is gone");
    }
    // the late track's words are 1.3 s later than the original's
    const a = got[MONO];
    const b = got[late];
    let best = 0;
    let bestScore = -Infinity;
    for (let d = 100; d <= 160; d++) { let s = 0; for (let i = 0; i + d < b.length && i < a.length; i++) s += a[i] * b[i + d]; if (s > bestScore) { bestScore = s; best = d; } }
    assert.ok(Math.abs(best - 130) <= 3, `the delay kept: ${best * 10} ms`);
  } finally {
    D.segmentSeconds = keepSeg;
  }
});

test("5.1: heard through the centre channel — loud music in the others does not count", { skip }, async () => {
  SURROUND = make("surround", "5.1");
  const res = await speech.timeline(SURROUND, { urgent: true });
  const { inside, quiet } = talkVsQuiet(res.speech);
  assert.ok(inside > 0.6 && quiet < 0.3, `talk ${inside.toFixed(2)} quiet ${quiet.toFixed(2)}`);
});

test("background: through the CPU budget; an urgent call does not wait behind it", { skip }, async () => {
  assert.ok(MONO);
  speech._internals.memo.clear();
  fs.rmSync(path.join(DIR, "cache"), { recursive: true, force: true });
  // the budget holds the background job back (a viewer is watching, say)
  let open;
  held = new Promise((r) => { open = r; });
  gateCalls.length = 0;
  const bg = speech.timeline(MONO, { urgent: false });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(gateCalls, ["speech"], "the background job asked the budget for a place");
  const t0 = Date.now();
  const urgent = await speech.timeline(MONO, { urgent: true });
  assert.equal(urgent.cached, false);
  assert.ok(!urgent.joined, "it did its own decode");
  // the background caller gets the urgent result, without decoding again
  const b = await bg;
  assert.deepEqual(b.speech, urgent.speech);
  open();
  held = null;
  assert.ok(Date.now() - t0 < 60000);
  // and with nothing in the way the background job decodes (one pass)
  speech._internals.memo.clear();
  fs.rmSync(path.join(DIR, "cache"), { recursive: true, force: true });
  const plain = await speech.timeline(MONO, { urgent: false });
  assert.equal(plain.cached, false);
  assert.deepEqual(plain.speech, urgent.speech, "one pass either way for a 2-minute file");
});

test("a file that is not there, and one with no audio", { skip }, async () => {
  await assert.rejects(speech.timeline(path.join(DIR, "nope.mkv")), /not there/);
  const silent = path.join(DIR, "video-only.mkv");
  const r = spawnSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=3", "-c:v", "ffv1", silent], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  await assert.rejects(speech.timeline(silent, { urgent: true }), /no audio/);
});

test("alignInWorker runs the alignment off the event loop", async () => {
  // a small generated case: speech exactly where 40 lines are, the lines 3 s late
  const cues = [];
  let t = 10;
  let s = 5;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  while (cues.length < 120) { const len = 1 + r() * 2.5; cues.push({ start: t, end: t + len }); t += len + 0.3 + r() * 2.5; }
  const sp = new Uint8Array(Math.ceil((t + 20) * 100)).fill(25);
  for (const c of cues) sp.fill(220, Math.round(c.start * 100), Math.round(c.end * 100));
  const res = await speech.alignInWorker(sp, cues.map((c) => ({ start: c.start + 3, end: c.end + 3, text: "x" })));
  assert.equal(res.verdict, "moved");
  assert.ok(Math.abs(res.offset + 3) < 0.05, `offset ${res.offset}`);
});
