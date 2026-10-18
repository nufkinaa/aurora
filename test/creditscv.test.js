// The credits picture (media/creditscv.js): synthetic tails — scenes, dark
// scenes, cuts to black, credit cards, a scrolling roll, a letterboxed film,
// names over a flat light background, a montage between names — are reduced
// exactly as ffmpeg's frames are, and the credits start must land on the
// frame. Then the fusion rule (introdetect chooseCredits), and one real
// ffmpeg decode of a generated clip.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const cv = require("../src/media/creditscv");
const { W, H, FPS, bestSegment } = cv._internals;

// ---------- a tiny picture factory ----------
const rng = (seed) => {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
};
const blank = (v = 16) => new Uint8Array(W * H).fill(v);
// A "scene": a lit gradient, soft blobs and fine texture — what a camera
// shot looks like at 384×216. `shot` picks the content (a cut changes it),
// `t` moves it a little (camera drift), `gain` darkens it (a night scene).
const shots = new Map(); // shot → its picture, 40 px wider than the frame (for the drift)
const shotPicture = (shot) => {
  if (shots.has(shot)) return shots.get(shot);
  const WW = W + 40;
  const px = new Float32Array(WW * H);
  const r = rng(shot * 7919 + 17);
  const gx = r() * 2 - 1, gy = r() * 2 - 1, base = 60 + r() * 90;
  const blobs = Array.from({ length: 6 }, () => ({ x: r() * WW, y: r() * H, rad: 20 + r() * 50, v: r() * 120 - 40 }));
  const tex = rng(shot * 31 + 5);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < WW; x++) {
      let v = base + gx * (x - W / 2) * 0.4 + gy * (y - H / 2) * 0.4;
      for (const b of blobs) {
        const d = Math.hypot(x - b.x, y - b.y);
        if (d < b.rad) v += b.v * (1 - d / b.rad);
      }
      px[y * WW + x] = v + Math.round((tex() - 0.5) * 34);
    }
  }
  shots.set(shot, px);
  return px;
};
const scene = (shot, t, gain = 1) => {
  const src = shotPicture(shot);
  const WW = W + 40;
  const dx = Math.round(t * 3) % 40;
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) px[y * W + x] = Math.max(0, Math.min(255, Math.round(src[y * WW + x + dx] * gain)));
  }
  return px;
};
// A line of "text": glyphs of 1–2 px strokes, 6 px tall, bright on whatever
// is under them.
const drawLine = (px, y0, x0, chars, seed, ink = 225) => {
  const r = rng(seed);
  let x = x0;
  for (let c = 0; c < chars; c++) {
    if (r() < 0.15) { x += 4; continue; } // a space
    const strokes = 1 + Math.floor(r() * 3);
    for (let k = 0; k < strokes; k++) {
      const wdt = r() < 0.5 ? 1 : 2;
      const top = r() < 0.3 ? 0 : 2;
      for (let y = y0 + top; y < y0 + 6; y++) for (let xx = x; xx < x + wdt && xx < W; xx++) if (y >= 0 && y < H) px[y * W + xx] = ink;
      x += wdt + 1;
    }
    x += 2;
  }
};
// A credit card: a few centred lines on black (or on `bg`).
const card = (n, bg = null) => {
  const px = bg ? Uint8Array.from(bg) : blank(16);
  for (let l = 0; l < 3; l++) drawLine(px, 80 + l * 14, 150 - (l % 2) * 20, 14 + l * 3, n * 13 + l);
  return px;
};
// A roll: a tall page of lines, moving up `speed` rows a sample.
const roll = (i, speed = 8) => {
  const px = blank(16);
  const off = i * speed;
  for (let l = 0; l < 400; l++) {
    const y = l * 18 - off;
    if (y < -8 || y >= H) continue;
    drawLine(px, y, 110, 22, l * 101 + 3);
  }
  return px;
};
// Add letterbox bars (a 2.39:1 film in a 16:9 frame).
const letterbox = (px) => {
  const bar = Math.round(H * 0.12);
  for (let y = 0; y < bar; y++) for (let x = 0; x < W; x++) { px[y * W + x] = 0; px[(H - 1 - y) * W + x] = 0; }
  return px;
};

// Pictures → the detector's samples, as the decode makes them.
const samplesOf = (frames, from = 0) => frames.map((px, i) => ({ ...cv.rowStats(px), t: from + i / FPS }));
const run = (frames, from = 1000) => {
  const s = samplesOf(frames, from);
  const duration = from + frames.length / FPS;
  return cv.estimate(cv.features(s), duration);
};
// Scenes with a cut every `every` seconds.
const scenes = (seconds, { every = 4, gain = 1, seed = 1 } = {}) =>
  Array.from({ length: Math.round(seconds * FPS) }, (_, i) => scene(seed + Math.floor(i / (every * FPS)), i / FPS, gain));
const repeat = (seconds, fn) => Array.from({ length: Math.round(seconds * FPS) }, (_, i) => fn(i));

test("cards on black after a cut to black: the start is the black, to the half second", () => {
  const frames = [...scenes(90), ...repeat(2, () => blank(16)), ...repeat(50, (i) => card(Math.floor(i / 6)))];
  const r = run(frames);
  assert.ok(r, "credits were found");
  assert.ok(Math.abs(r.start - (1000 + 90)) <= 0.5, `start at the black (got ${r.start})`);
  assert.ok(r.confidence >= 0.6, `sure of it (got ${r.confidence})`);
});

test("a scrolling roll straight after the last scene", () => {
  const frames = [...scenes(80, { seed: 3 }), ...repeat(60, (i) => roll(i, 7))];
  const r = run(frames);
  assert.ok(r, "credits were found");
  assert.ok(Math.abs(r.start - 1080) <= 0.5, `start where the roll begins (got ${r.start})`);
  assert.ok(r.confidence >= 0.6, `sure of it (got ${r.confidence})`);
});

test("a dark ending with a cut to black and no names is NOT credits (a cliffhanger)", () => {
  const frames = [...scenes(80, { seed: 5 }), ...scenes(30, { seed: 9, gain: 0.25, every: 6 }), ...repeat(12, () => blank(16))];
  const r = run(frames);
  assert.ok(!r || r.confidence < 0.5, `no confident credits (got ${JSON.stringify(r)})`);
});

test("a dark scene with a few bright lamps before the credits does not move the start", () => {
  const lamps = (i) => {
    const px = scene(40 + Math.floor(i / 10), i / FPS, 0.2);
    for (const [lx, ly] of [[60, 50], [200, 70], [320, 40]]) for (let y = ly; y < ly + 5; y++) for (let x = lx; x < lx + 4; x++) px[y * W + x] = 240;
    return px;
  };
  const frames = [...scenes(60, { seed: 11 }), ...repeat(40, lamps), ...repeat(1, () => blank(16)), ...repeat(45, (i) => card(Math.floor(i / 8)))];
  const r = run(frames);
  assert.ok(r && Math.abs(r.start - 1100) <= 0.5, `start after the dark scene (got ${r && r.start})`);
});

test("logos and a 'next time' preview after the names stay outside the credits", () => {
  const logo = () => { const px = blank(16); for (let y = 90; y < 130; y++) for (let x = 160; x < 230; x++) px[y * W + x] = 120 + ((x * y) % 60); return px; };
  const frames = [...scenes(70, { seed: 13 }), ...repeat(40, (i) => card(Math.floor(i / 6))), ...repeat(6, logo), ...scenes(40, { seed: 17, every: 2 })];
  const r = run(frames);
  assert.ok(r && Math.abs(r.start - 1070) <= 0.5, `start at the first card (got ${r && r.start})`);
  assert.ok(r.length >= 35 && r.length <= 50, `the names' length, not the preview's (got ${r.length})`);
});

test("a letterboxed film: the bars are not 'dark background', the names are still found", () => {
  const frames = [...scenes(90, { seed: 19 }).map(letterbox), ...repeat(3, () => blank(0)), ...repeat(60, (i) => letterbox(roll(i, 6)))];
  const r = run(frames);
  assert.ok(r && Math.abs(r.start - 1090) <= 0.5, `start at the black (got ${r && r.start})`);
  assert.ok(r.confidence >= 0.6, `sure of it (got ${r.confidence})`);
});

test("names over a flat light background (clouds, a coloured card)", () => {
  const flatGrey = blank(120);
  const frames = [...scenes(60, { seed: 23 }), ...repeat(40, (i) => card(Math.floor(i / 6), flatGrey))];
  const r = run(frames);
  assert.ok(r && Math.abs(r.start - 1060) <= 0.5, `start at the first card (got ${r && r.start})`);
});

test("a montage between blocks of names is bridged; the start is the first names", () => {
  const block = (n) => repeat(8, (i) => card(n * 10 + Math.floor(i / 6)));
  const shot = (n) => scenes(4, { seed: 100 + n, every: 4 });
  const frames = [...scenes(60, { seed: 29 }), ...block(0), ...shot(0), ...block(1), ...shot(1), ...block(2), ...shot(2), ...block(3)];
  const r = run(frames);
  assert.ok(r && Math.abs(r.start - 1060) <= 0.5, `start at the first block (got ${r && r.start})`);
  assert.ok(r.length >= 40, `the montage is inside the credits (got ${r.length})`);
});

test("side-by-side credits: the picture shrunk into a box, the names beside it", () => {
  const boxed = (i) => {
    const px = blank(16);
    const src = scene(200 + Math.floor(i / 8), i / FPS);
    for (let y = 20; y < 170; y++) for (let x = 0; x < 250; x++) px[y * W + x] = src[y * W + x];
    for (let l = 0; l < 4; l++) drawLine(px, 60 + l * 14, 268, 12, i * 7 + l);
    drawLine(px, 185, 120, 16, i + 99);
    return px;
  };
  const frames = [...scenes(60, { seed: 37 }), ...repeat(40, boxed)];
  const r = run(frames);
  assert.ok(r && Math.abs(r.start - 1060) <= 0.5, `start where the picture shrinks (got ${r && r.start})`);
});

test("a 4:3 programme in a 16:9 frame: the side bars are not a boxed picture", () => {
  const pillar = (px) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < 48; x++) { px[y * W + x] = 0; px[y * W + W - 1 - x] = 0; }
    return px;
  };
  const frames = [...scenes(90, { seed: 43 }).map(pillar), ...repeat(1, () => blank(0)), ...repeat(40, (i) => pillar(card(Math.floor(i / 6))))];
  const r = run(frames);
  assert.ok(r && Math.abs(r.start - 1090) <= 0.5, `start at the black (got ${r && r.start})`);
  // and without credits it says nothing
  assert.equal(run(scenes(90, { seed: 47 }).map(pillar)), null);
});

test("a still card with a portrait and names (a cast card)", () => {
  const portrait = (n) => {
    const px = blank(16);
    const src = scene(300 + n, 0);
    for (let y = 40; y < 140; y++) for (let x = 150; x < 230; x++) { const dx = (x - 190) / 40, dy = (y - 90) / 50; if (dx * dx + dy * dy < 1) px[y * W + x] = src[y * W + x]; }
    drawLine(px, 150, 150, 10, n * 3);
    drawLine(px, 164, 140, 13, n * 3 + 1);
    return px;
  };
  const frames = [...scenes(60, { seed: 53 }), ...repeat(1, () => blank(16)), ...repeat(48, (i) => portrait(Math.floor(i / 8)))];
  const r = run(frames);
  assert.ok(r && Math.abs(r.start - 1060) <= 0.5, `start at the black before the first card (got ${r && r.start})`);
});

test("a programme with no credits at all says nothing", () => {
  assert.equal(run(scenes(120, { seed: 31 })), null);
});

test("bestSegment: the run with the most credit-likeness, black neutral", () => {
  assert.deepEqual(bestSegment([0, 0, 0, 1, 1, 0.5, 1, 1, 0, 0]).start, 3);
  assert.deepEqual(bestSegment([0, 0, 0, 1, 1, 0.5, 1, 1, 0, 0]).end, 8);
  assert.equal(bestSegment([0, 0, 0.5, 0]), null);
});

test("the tail window: 15% of the runtime, at least four minutes, at most twenty-five", () => {
  assert.deepEqual(cv.tailWindow(2700), { from: 2700 - 405, length: 405 });
  assert.deepEqual(cv.tailWindow(1200), { from: 960, length: 240 });
  assert.equal(cv.tailWindow(12000).length, 1500);
  assert.equal(cv.tailWindow(0), null);
});

// ---------- fusion ----------
const { chooseCredits, cvDue, cvRecord, CV_V, noneRecord } = require("../src/media/introdetect")._internals;

test("chooseCredits: chapters first; the picture's time when it agrees; a sure picture beats a disagreeing source", () => {
  const db = { credits: { start: 2990, end: 3050 }, source: "skipdb" };
  // the author's chapter wins outright
  assert.equal(chooseCredits({ source: "chapters", credits: { start: 3000 }, cv: { start: 3020, confidence: 0.9 } }).start, 3000);
  // agreement: the picture's half-second time, the database's end
  const a = chooseCredits({ source: "audio", credits: null, db, cv: { start: 2992.5, confidence: 0.4 } });
  assert.deepEqual(a, { start: 2992.5, end: 3050, source: "picture+skipdb" });
  // a sure picture beats an audio time that disagrees
  assert.equal(chooseCredits({ source: "audio", credits: { start: 1801 }, cv: { start: 1780, confidence: 0.8 } }).start, 1780);
  // an unsure picture does not
  assert.equal(chooseCredits({ source: "audio", credits: { start: 1801 }, cv: { start: 1780, confidence: 0.4 } }).start, 1801);
  // alone: used from CV_ALONE
  assert.equal(chooseCredits({ source: null, credits: null, cv: { start: 2560, confidence: 0.55 } }).source, "picture");
  assert.equal(chooseCredits({ source: null, credits: null, cv: { start: 2560, confidence: 0.3 } }), null);
  // nothing from the picture: today's order (own, then the databases)
  assert.equal(chooseCredits({ source: "audio", credits: { start: 1801 }, db }).start, 1801);
  assert.equal(chooseCredits({ source: "audio", credits: null, db }).start, 2990);
  assert.equal(chooseCredits({ source: null, credits: null, cv: { start: null, confidence: 0 } }), null);
});

test("the picture is looked at once per file and version, and survives the other passes' records", () => {
  assert.equal(cvDue(null, 5), true);
  assert.equal(cvDue({ mtime: 5 }, 5), true);
  assert.equal(cvDue({ mtime: 5, cv: { v: CV_V } }, 5), false);
  assert.equal(cvDue({ mtime: 5, cv: { v: CV_V } }, 6), true, "a changed file is looked at again");
  assert.equal(cvDue({ mtime: 5, cv: { v: CV_V - 1 } }, 5), true, "a new version looks again");
  assert.deepEqual(Object.keys(cvRecord(null)).sort(), ["at", "confidence", "start", "v"]);
  // a decode that could not finish is noted, and tried again a week later
  const failed = { mtime: 5, cv: cvRecord(null, 1000, true) };
  assert.equal(failed.cv.failed, true);
  assert.equal(cvDue(failed, 5, 1000 + 3600e3), false);
  assert.equal(cvDue(failed, 5, 1000 + 8 * 24 * 3600e3), true);
  const kept = noneRecord({ mtime: 5, cv: { v: CV_V, start: 100, confidence: 0.9 } }, 5);
  assert.equal(kept.cv.start, 100, "an audio 'nothing found' keeps the picture's answer");
});

// ---------- the real decode ----------
const config = require("../src/config");
test("end to end through ffmpeg: a generated clip with a cut to black and a roll", { skip: !config.FFMPEG, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-creditscv-"));
  const file = path.join(dir, "tail.mkv");
  try {
    const frames = [...scenes(40, { seed: 41 }), ...repeat(2, () => blank(16)), ...repeat(30, (i) => roll(i, 6))];
    // 2 fps pictures → a 24 fps mpeg4 clip (every picture held 12 frames),
    // so the decode has real GOPs, B-frames and -skip_frame noref to do
    await new Promise((resolve, reject) => {
      const ff = spawn(config.FFMPEG, ["-v", "error", "-y", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
        "-vf", "fps=24", "-c:v", "mpeg4", "-q:v", "3", "-bf", "2", "-g", "48", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      ff.stderr.on("data", (d) => (err += d));
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg ${code}`))));
      for (const f of frames) ff.stdin.write(Buffer.from(f));
      ff.stdin.end();
    });
    const duration = frames.length / FPS; // 72 s: the window is the whole clip
    const r = await cv.detect(file, duration, { ffmpeg: config.FFMPEG, threads: 1 });
    assert.ok(r, "credits were found");
    assert.ok(Math.abs(r.start - 40) <= 1, `start at the cut to black (got ${r.start})`);
    assert.ok(r.confidence >= 0.5, `confident (got ${r.confidence})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a decode that does not run to the end is no answer (unreadable file, or stopped for a viewer)", { skip: !config.FFMPEG, timeout: 60000 }, async () => {
  const missing = await cv.detect(path.join(os.tmpdir(), "aurora-creditscv-no-such-file.mkv"), 600, { ffmpeg: config.FFMPEG });
  assert.equal(missing.incomplete, true);
  // stopped mid-way, the way introdetect stops it when a viewer encode begins
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-creditscv-"));
  const file = path.join(dir, "long.mkv");
  try {
    await new Promise((resolve, reject) => {
      const ff = spawn(config.FFMPEG, ["-v", "error", "-y", "-threads", "1", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=30", "-c:v", "mpeg4", "-q:v", "8", file], { stdio: "ignore" });
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
    });
    const r = await cv.detect(file, 30, { ffmpeg: config.FFMPEG, threads: 1, onChild: (c) => c.kill("SIGKILL") });
    assert.equal(r.incomplete, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The analysis runs in a worker thread (server round, 2026-10-18): the same
// answer as on the calling thread, and the event loop keeps turning meanwhile.
require("node:test").test("estimateOffLoop: the same answer as features + estimate, without holding the loop", async () => {
  const assertx = require("node:assert");
  const cv = require("../src/media/creditscv");
  const { W, H, FPS, estimateOffLoop } = cv._internals;
  const samples = [];
  const frame = Buffer.alloc(W * H);
  for (let i = 0; i < 600 * FPS; i++) {
    // a picture for the first 400 s, then white names on black
    for (let j = 0; j < frame.length; j++) frame[j] = i < 800 ? (i * 7 + j) & 255 : (j % W > W * 0.4 && j % W < W * 0.6 && (j / W | 0) % 12 < 3 ? 230 : 8);
    const st = cv.rowStats(frame);
    st.t = 3000 + i / FPS;
    samples.push(st);
  }
  const want = cv.estimate(cv.features(samples), 3600);
  let ticks = 0;
  const t = setInterval(() => ticks++, 5);
  const got = await estimateOffLoop(samples, 3600);
  clearInterval(t);
  assertx.deepEqual(got, want);
  assertx.ok(ticks >= 1, "the loop turned while the worker worked");
});
