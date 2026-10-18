// Where the end credits begin, read from the PICTURE.
//
// Why: the audio comparison (introdetect.js) needs a season of siblings and
// a shared end theme, and finds credits for only a few episodes of this
// library; the public databases (skipsegments.js) know popular shows only.
// A credit sequence, though, looks like nothing else in a programme: text —
// sharp, thin, bright strokes in horizontal lines — on a flat background
// (nearly always black), which either stands still card by card or rolls
// upward at a steady speed, with no camera cuts in between. A computer can
// see that in a thumbnail.
//
// How (CPU-cheap by construction — the whole budget is the video decode):
//   * ffmpeg decodes only the tail (the last ~15% of the runtime, clamped)
//     at 2 frames a second into 384×216 grey pictures, skipping the frames
//     no other frame depends on (-skip_frame noref) and the deblocking
//     filter: a third to a half of a plain decode's CPU, still clean pictures;
//   * each picture is reduced at once to a few numbers per ROW (how dark,
//     how many sharp edges) plus a coarse copy for motion — nothing
//     larger than a few kilobytes is kept per sample;
//   * every sample gets a credits-likeness from four looks at it:
//       - names on nothing: lines of text (rows with many sharp edges side
//         by side) and EVERY other row empty — black, or one flat tone. That
//         is what tells a credit card from a night scene, which is just as
//         dark but has soft detail in every row;
//       - a roll: the text rows move up by the same few rows sample after
//         sample (a 1-D correlation of the rows' edge profiles), with gaps
//         between the lines — names scrolling over clouds read like this;
//       - a still card with a picture on it (a cast portrait beside the
//         name): text, mostly dark, and not a pixel of change;
//       - side by side: the programme shrunk into a box, the names beside
//         it — a black margin whose inner edge is the same column in many
//         rows, held for seconds;
//     pure black is neutral; letterbox and pillarbox bars (dark in every
//     sample) are left out;
//   * the credits are the contiguous stretch with the most credit-likeness
//     (maximum-sum segment): logos, a "next time" preview or a post-credits
//     scene after the names fall outside it, a montage or a logo between
//     two blocks of names is bridged — and the start moves back onto the
//     cut or fade to black that opens the names (or the empty background
//     they appear on), if one does;
//   * the answer carries a confidence: how credit-like the stretch is, how
//     story-like the minute before it, how long it runs, how much of it
//     carries text, and whether plain story follows it for long.
//   Measured on a hand-labelled set: docs/qa/credits/REPORT.md.
//
// Fusion with the other sources lives in introdetect.js (chooseCredits).
// Runs as background work (cpuwork.js) at the lowest priority, never while
// a viewer is being encoded for; cached per file with the rest of the
// automatic answer in data/intro-auto.json.
"use strict";
const { spawn } = require("child_process");

const W = 384;
const H = 216;
const FPS = 2; // samples per second
const COARSE = 4; // the motion copy is W/COARSE × H/COARSE
const CW = W / COARSE;
const CH = H / COARSE;
const DARK = 40; // luma (0–255) under which a pixel is background-dark
const SHARP = 48; // a horizontal step this large over two pixels is an edge
const FLAT = 6; // a step this small is flat background
const TEXT_ROW_EDGES = 6; // a row with this many sharp edges is a line of text
const SHIFT_MAX = 24; // rows of vertical scroll looked for between samples
const STILL = 0.4; // coarse change (0–255) under which a picture stands still
const ROLL_RUN = 6; // samples (3 s) of steady scroll that make a roll
const BOX_RUN = 6; // samples (3 s) of the same box edge that make side-by-side credits

// ---------- one picture → its numbers ----------
// `px`: W*H grey bytes. Returns per-row counts and a coarse copy.
const rowStats = (px) => {
  const dark = new Uint16Array(H);
  const edges = new Uint16Array(H);
  const flat = new Uint16Array(H);
  const bright = new Uint16Array(H);
  const left = new Uint16Array(H); // how far in from the left edge the row stays dark
  const right = new Uint16Array(H); // … and from the right edge
  const coarse = new Uint8Array(CW * CH);
  const acc = new Uint32Array(CW * CH);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let d = 0, e = 0, f = 0, b = 0;
    for (let x = 0; x < W; x++) {
      const v = px[row + x];
      if (v < DARK) d++;
      else if (v > 110) b++;
      if (x > 0 && x < W - 1) {
        const g = px[row + x + 1] - px[row + x - 1];
        const a = g < 0 ? -g : g;
        if (a >= SHARP) e++;
        else if (a <= FLAT) f++;
      }
      acc[((y / COARSE) | 0) * CW + ((x / COARSE) | 0)] += v;
    }
    dark[y] = d;
    edges[y] = e;
    flat[y] = f;
    bright[y] = b;
    let l = 0;
    while (l < W && px[row + l] < DARK) l++;
    let r = 0;
    while (r < W - l && px[row + W - 1 - r] < DARK) r++;
    left[y] = l;
    right[y] = r;
  }
  const n = COARSE * COARSE;
  for (let i = 0; i < coarse.length; i++) coarse[i] = Math.round(acc[i] / n);
  return { dark, edges, flat, bright, left, right, coarse };
};

// Rows that are dark in (nearly) every sample are letterbox bars: they are
// left out of every share below, so a 2.39:1 film reads like a 16:9 one.
const activeRows = (samples) => {
  const keep = new Uint8Array(H).fill(1);
  if (!samples.length) return keep;
  for (let y = 0; y < H; y++) {
    let darkIn = 0;
    for (const s of samples) if (s.dark[y] >= W * 0.98 && s.edges[y] === 0) darkIn++;
    if (darkIn >= samples.length * 0.97) keep[y] = 0;
  }
  // never trust a mask that leaves almost nothing (an all-black tail)
  let k = 0;
  for (let y = 0; y < H; y++) k += keep[y];
  if (k < H * 0.4) keep.fill(1);
  return keep;
};

// Black side bars present in (nearly) every sample — a 4:3 programme in a
// 16:9 frame — are the frame, not a credits layout: their width is taken
// off every row's dark run before the boxed-picture test below.
const pillarBars = (samples, keep) => {
  if (!samples.length || !samples[0].left) return { left: 0, right: 0 };
  const lows = (key) => {
    const per = [];
    for (const s of samples) {
      let m = W;
      for (let y = 0; y < H; y++) if (keep[y] && s[key][y] < m) m = s[key][y];
      per.push(m);
    }
    per.sort((a, b) => a - b);
    return per[Math.floor(per.length * 0.03)] || 0;
  };
  return { left: lows("left"), right: lows("right") };
};

// Side-by-side credits: the programme's picture shrunk into a box, the names
// beside or below it on black. In the rows the picture occupies, the black
// margin on one side has the SAME width row after row (a box edge is a
// straight vertical line), and it is wide; every row outside the picture is
// a line of text or empty. A dark scene is dark at its sides too, but
// raggedly, row by row.
const BOX_MARGIN = 0.12; // of the width
const boxedPicture = (s, keep, rows, bars) => {
  if (!s.left) return false;
  const pic = [];
  for (let y = 0; y < H; y++) {
    if (!keep[y]) continue;
    const e = s.edges[y];
    const isText = e >= TEXT_ROW_EDGES && e <= W * 0.35 && (s.dark[y] + e >= W * 0.9 || s.flat[y] + e >= W * 0.9);
    const isClean = e <= 1 && (s.dark[y] >= W * 0.985 || s.flat[y] >= W * 0.97);
    if (!isText && !isClean) pic.push(y);
  }
  // a box leaves rows above or below it: names, or nothing
  if (pic.length < rows * 0.25 || pic.length > rows * 0.9) return false;
  const straight = (key, bar) => {
    const runs = pic.map((y) => s[key][y] - bar).sort((a, b) => a - b);
    // A row's dark run reaches at least to the box edge — further where the
    // picture itself is dark beside its edge, shorter where a name sits in
    // the margin — so the edge is the shortest wide run at which MANY rows
    // stop at the same column.
    let lo = 0;
    for (let i = 0; i < runs.length; i++) {
      const v = runs[i];
      if (v < W * BOX_MARGIN) continue;
      while (runs[lo] < v - 3) lo++;
      let hi = i;
      while (hi + 1 < runs.length && runs[hi + 1] <= v + 3) hi++;
      if (hi - lo + 1 >= runs.length * 0.35) return v;
    }
    return 0;
  };
  const l = straight("left", bars.left);
  if (l) return { side: "left", at: l };
  const r = straight("right", bars.right);
  return r ? { side: "right", at: r } : null;
};

// Mean absolute difference of two coarse copies (0–255).
const coarseDiff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d < 0 ? -d : d; }
  return s / a.length;
};

// The vertical shift (rows, positive = moved UP) that best lines up two
// edge profiles, and how well (normalised correlation, −1…1).
const bestShift = (p, q, keep, maxShift = SHIFT_MAX) => {
  let best = { shift: 0, corr: -1 };
  for (let s = -maxShift; s <= maxShift; s++) {
    let sxy = 0, sxx = 0, syy = 0, sx = 0, sy = 0, n = 0;
    for (let y = 0; y < H; y++) {
      const y2 = y - s; // where row y of the earlier picture went
      if (y2 < 0 || y2 >= H || !keep[y] || !keep[y2]) continue;
      const a = p[y];
      const b = q[y2];
      sxy += a * b; sxx += a * a; syy += b * b; sx += a; sy += b; n++;
    }
    if (n < H / 3) continue;
    const cov = sxy - (sx * sy) / n;
    const va = sxx - (sx * sx) / n;
    const vb = syy - (sy * sy) / n;
    if (va <= 0 || vb <= 0) continue;
    const c = cov / Math.sqrt(va * vb);
    if (c > best.corr) best = { shift: s, corr: c };
  }
  return best;
};

// ---------- samples → features ----------
// Per sample: dark (share of dark pixels), flat (share of flat steps),
// textRows (rows that read as a line of text), edgeRows, card (share of rows
// that are text or empty), diff (coarse change since the last sample),
// shift / shiftCorr (the text rows' vertical move since the last sample),
// and the run-based flags still, roll and boxed.
const features = (samples) => {
  const keep = activeRows(samples);
  let rows = 0;
  for (let y = 0; y < H; y++) rows += keep[y];
  const bars = pillarBars(samples, keep);
  const out = [];
  let prev = null;
  for (const s of samples) {
    let dark = 0, flat = 0, edges = 0, bright = 0, textRows = 0, edgeRows = 0, cleanRows = 0;
    for (let y = 0; y < H; y++) {
      if (!keep[y]) continue;
      const e = s.edges[y];
      dark += s.dark[y];
      flat += s.flat[y];
      edges += e;
      bright += s.bright[y];
      if (e > 0) edgeRows++;
      // a line of text: many sharp edges in a row that is otherwise dark or flat
      if (e >= TEXT_ROW_EDGES && e <= W * 0.35 && (s.dark[y] + e >= W * 0.9 || s.flat[y] + e >= W * 0.9)) textRows++;
      // a clean row: nothing in it — black, or one flat tone
      else if (e <= 1 && (s.dark[y] >= W * 0.985 || s.flat[y] >= W * 0.97)) cleanRows++;
    }
    const area = rows * W;
    const f = {
      t: s.t,
      dark: dark / area,
      flat: flat / (rows * (W - 2)),
      edges: edges / area,
      bright: bright / area,
      textRows,
      edgeRows,
      // how much of the picture is "names on nothing": clean rows + text rows
      card: (cleanRows + textRows) / rows,
      diff: prev ? coarseDiff(s.coarse, prev.coarse) : 0,
      shift: 0,
      shiftCorr: 0,
    };
    f.box = textRows >= 2 ? boxedPicture(s, keep, rows, bars) : null;
    f.boxed = false;
    if (prev && textRows >= 2) {
      const m = bestShift(s.edges, prev.edges, keep);
      f.shift = m.shift;
      f.shiftCorr = m.corr;
    }
    out.push(f);
    prev = s;
  }
  // (No camera-cut rate: card-by-card credits "cut" at every card, so the
  // rate says little the four looks below do not say better.)
  for (let i = 0; i < out.length; i++) {
    // still: the picture is the same as the one before or the one after it
    // (a card, from its first sample; film grain and the smallest camera
    // move both read well above this)
    out[i].still = (i > 0 && out[i].diff <= STILL) || (i < out.length - 1 && out[i + 1].diff <= STILL);
    out[i].rows = rows;
  }
  // a roll: the text rows move by the same few rows, sample after sample,
  // and the rows stay text with gaps between the lines — names scrolling
  // over clouds read like this, a camera tilt over a scene does not hold
  // the correlation, nor the gaps
  const moving = (f) => f.textRows >= 3 && Math.abs(f.shift) >= 2 && f.shiftCorr >= 0.9 && f.edgeRows <= f.rows * 0.8;
  // a boxed picture holds its edge for a while (a shot of the montage), at
  // the same column — a dark scene's shadow at the side does not
  for (let i = 0; i < out.length; ) {
    let j = i;
    while (j < out.length && out[j].box && (j === i || (out[j].box.side === out[i].box.side && Math.abs(out[j].box.at - out[i].box.at) <= 3))) j++;
    if (j - i >= BOX_RUN) for (let k = i; k < j; k++) out[k].boxed = true;
    i = j > i ? j : i + 1;
  }
  for (let i = 0; i < out.length; i++) out[i].roll = false;
  for (let i = 0; i < out.length; ) {
    let j = i;
    while (j < out.length && moving(out[j]) && (j === i || Math.abs(out[j].shift - out[j - 1].shift) <= 2)) j++;
    if (j - i >= ROLL_RUN) for (let k = i; k < j; k++) out[k].roll = true;
    i = j > i ? j : i + 1;
  }
  return out;
};

// ---------- features → how much each sample looks like credits ----------
// 1 = credits, 0 = story, 0.5 = cannot tell (black: it belongs with whatever
// it sits in — a fade between scenes, or the gap between two credit cards).
const isBlack = (f) => f.dark > 0.985 && f.textRows === 0 && f.edges < 0.0004;
const score = (f) => {
  if (isBlack(f)) return 0.5;
  // names on nothing: every row is either a line of text or empty (black,
  // or one flat tone — clouds, a coloured card)
  if (f.textRows >= 2 && f.card >= 0.9) return 1;
  // names rolling up at a steady speed, over whatever background
  if (f.roll) return 1;
  // a still card with a picture on it: a portrait, a logo beside the names
  if (f.textRows >= 4 && f.still && f.dark >= 0.8) return 0.8;
  // the picture shrunk into a box, the names beside it
  if (f.boxed) return 0.8;
  // mostly names on nothing: a card with a logo, a roll over a soft picture
  if (f.textRows >= 2 && f.card >= 0.8) return 0.6;
  // a picture: a scene (however dark), or a montage beside the names
  return 0;
};
// A light picture with nothing in it at all — the cloud bank or coloured
// field the names will appear over, faded up from black.
// (the first line of names may already be sliding in at its lower edge;
// the fade from black passes through every shade)
const isEmptyLight = (f) => f.textRows <= 1 && f.edges < 0.003 && f.flat >= 0.93 && f.dark < 0.85;

// ---------- the segment ----------
// The credits are the stretch of samples that looks MOST like credits: the
// contiguous run [start, end) with the largest sum of (2·score − 1) — story
// counts −1 a sample, names +1, black 0 (Kadane's maximum subarray). Logos,
// a "next time" preview or a post-credits scene after the names are simply
// left outside the run; a montage or a logo between two blocks of names is
// bridged when the names on its far side outweigh it.
const bestSegment = (scores) => {
  let best = null;
  let sum = 0;
  let from = 0;
  for (let i = 0; i < scores.length; i++) {
    const v = 2 * scores[i] - 1;
    if (sum <= 0) { sum = v; from = i; } else sum += v;
    if (!best || sum > best.sum + 1e-9) best = { start: from, end: i + 1, sum };
  }
  return best && best.sum > 0 ? best : null;
};
const mean = (xs, a, b) => {
  let s = 0;
  for (let i = a; i < b; i++) s += xs[i];
  return b > a ? s / (b - a) : 0;
};

// From the per-sample features, the credits start: { start (s), confidence
// (0–1), length (s of names), … } or null when nothing looks like credits.
const MIN_CREDITS_S = 12;
const STORY_LOOK_S = 60; // how far before the names the picture must look like story
const WALK_BACK_S = 90; // at most this much black / empty background is taken in before the names
const estimate = (feats, duration) => {
  if (!feats || feats.length < 8) return null;
  const scores = feats.map(score);
  const seg = bestSegment(scores);
  if (!seg) return null;
  let k = seg.start;
  // move back over the black that opens the credits (a cut or fade to
  // black), and over the empty background the first names appear on
  // — the latter only when the names themselves sit on a light background
  const back = Math.round(WALK_BACK_S * FPS);
  const head = feats.slice(seg.start, Math.min(seg.end, seg.start + 10));
  const lightNames = head.reduce((a, f) => a + f.dark, 0) / Math.max(1, head.length) < 0.5;
  while (k > 0 && seg.start - k < back && (isBlack(feats[k - 1]) || (lightNames && isEmptyLight(feats[k - 1])))) k--;
  const start = feats[k].t;
  const len = (seg.end - seg.start) / FPS;
  const inside = mean(scores, seg.start, seg.end);
  const look = Math.round(STORY_LOOK_S * FPS);
  // (the share of credit-like samples just before: black is no evidence either way)
  let likeBefore = 0;
  for (let i = Math.max(0, k - look); i < k; i++) if (scores[i] >= 0.6) likeBefore++;
  const before = k ? likeBefore / Math.min(k, look) : 0;
  let text = 0;
  for (let i = seg.start; i < seg.end; i++) if (feats[i].textRows >= 2) text++;
  const textShare = text / Math.max(1, seg.end - seg.start);
  // after the names: a long stretch of plain story means the "names" were
  // text inside the programme (a letter, a screen) — or a post-credits scene
  let storyAfter = 0;
  for (let i = seg.end; i < scores.length; i++) if (scores[i] === 0) storyAfter++;
  storyAfter /= FPS;
  let conf = Math.max(0, 2 * (inside - 0.5)) * Math.max(0, 1 - before) * Math.min(1, len / 20) * Math.min(1, 2 * textShare);
  if (storyAfter > 120) conf *= 0.6;
  if (len < MIN_CREDITS_S) conf = 0;
  conf = Math.max(0, Math.min(1, conf));
  return {
    start: Math.round(start * 10) / 10,
    confidence: Math.round(conf * 100) / 100,
    length: Math.round(len),
    inside: Math.round(inside * 100) / 100,
    before: Math.round(before * 100) / 100,
    storyAfter: Math.round(storyAfter),
  };
};

// ---------- the decode ----------
// The tail window to look at: the last 15% of the runtime, at least four
// minutes and at most twenty-five (a feature's rolls run long).
const tailWindow = (duration) => {
  if (!(duration > 0)) return null;
  const len = Math.min(duration, Math.max(240, Math.min(1500, duration * 0.15)));
  return { from: Math.max(0, duration - len), length: len };
};

// Decode [from, from+length) of `file` into samples. `opts.ffmpeg`: the
// binary; `opts.lower(child)`: lowers its priority (cpuwork); `opts.threads`.
// Resolves with { samples, wallMs } — samples [] when nothing could be read.
const sample = (file, from, length, opts = {}) =>
  new Promise((resolve) => {
    const args = [
      "-hide_banner", "-nostdin", "-v", "error",
      "-threads", String(opts.threads || 2),
      "-skip_frame", "noref", "-skip_loop_filter", "all",
      "-ss", String(Math.max(0, from)), "-i", file, "-t", String(length),
      "-map", "0:v:0", "-an", "-sn", "-dn",
      "-vf", `fps=${FPS},scale=${W}:${H}:flags=area,format=gray`,
      "-f", "rawvideo", "-",
    ];
    let child;
    try {
      child = spawn(opts.ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve({ samples: [], wallMs: 0, complete: false });
    }
    if (opts.lower) try { opts.lower(child); } catch {}
    if (opts.onChild) try { opts.onChild(child); } catch {}
    const size = W * H;
    const samples = [];
    let buf = Buffer.alloc(0);
    const started = Date.now();
    child.stdout.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        const frame = buf.subarray(0, size);
        const st = rowStats(frame);
        st.t = from + samples.length / FPS;
        samples.push(st);
        buf = buf.subarray(size);
      }
    });
    // (at the idle priority a busy machine may take a while: three times the
    // window's own length, ten minutes at least, then it is given up on)
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, opts.timeoutMs || Math.max(10 * 60 * 1000, length * 3000));
    timer.unref?.();
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // complete: ffmpeg ended by itself, cleanly, having given (nearly) the
      // pictures the window holds — anything else is not an answer to keep
      const complete = !timedOut && code === 0 && samples.length >= Math.floor(length * FPS * 0.9);
      resolve({ samples, wallMs: Date.now() - started, complete });
    };
    child.once("close", (code) => done(code));
    child.once("error", () => done(-1));
  });

// The whole picture opinion for one file: { start, confidence, … }, null
// for "looked, no credits", or { incomplete: true } when the decode did not
// run to the end (stopped for a viewer, timed out, unreadable) — not an
// answer, to be asked again later.
const detect = async (file, duration, opts = {}) => {
  const win = tailWindow(duration);
  if (!win) return null;
  const { samples, wallMs, complete } = await sample(file, win.from, win.length, opts);
  if (!complete) return { incomplete: true, samples: samples.length };
  if (samples.length < 8) return null;
  if (opts.debug) {
    const feats = features(samples);
    const est = estimate(feats, duration);
    opts.debug({ feats, est, wallMs });
    return est ? { ...est, window: Math.round(win.length) } : null;
  }
  // the analysis itself off the event loop (media/creditscv-worker.js); the
  // same functions here if a worker cannot be had
  const est = await estimateOffLoop(samples, duration);
  return est ? { ...est, window: Math.round(win.length) } : null;
};

// Samples as a few big typed arrays, handed to the worker without a copy
// (3,000 samples are 23 MB of small arrays: cloned one by one they held the
// loop for 100 ms on their own). unpack() gives back the same samples.
const FIELDS16 = ["dark", "edges", "flat", "bright", "left", "right"];
const pack = (samples) => {
  const n = samples.length;
  const rows = n ? samples[0].dark.length : 0;
  const cells = n ? samples[0].coarse.length : 0;
  const out = { n, rows, cells, t: new Float64Array(n), coarse: new Uint8Array(n * cells) };
  for (const f of FIELDS16) out[f] = new Uint16Array(n * rows);
  samples.forEach((s, i) => {
    out.t[i] = s.t;
    for (const f of FIELDS16) out[f].set(s[f], i * rows);
    out.coarse.set(s.coarse, i * cells);
  });
  return out;
};
const unpack = (p) => {
  const samples = new Array(p.n);
  for (let i = 0; i < p.n; i++) {
    const s = { t: p.t[i], coarse: p.coarse.subarray(i * p.cells, (i + 1) * p.cells) };
    for (const f of FIELDS16) s[f] = p[f].subarray(i * p.rows, (i + 1) * p.rows);
    samples[i] = s;
  }
  return samples;
};
const estimateOffLoop = (samples, duration) =>
  new Promise((resolve) => {
    const inThread = () => resolve(estimate(features(samples), duration));
    let w;
    try {
      const { Worker } = require("worker_threads");
      const packed = pack(samples);
      const transfer = [packed.t.buffer, packed.coarse.buffer, ...FIELDS16.map((f) => packed[f].buffer)];
      w = new Worker(require("path").join(__dirname, "creditscv-worker.js"), { workerData: { packed, duration }, transferList: transfer, execArgv: [] });
    } catch {
      return inThread();
    }
    let done = false;
    const finish = (fn) => { if (done) return; done = true; w.terminate().catch(() => {}); fn(); };
    w.once("message", (m) => finish(() => (m && !m.error ? resolve(m.est) : inThread())));
    w.once("error", () => finish(inThread));
    w.once("exit", (code) => { if (!done) finish(inThread); });
  });

module.exports = { detect, estimate, features, rowStats, tailWindow, sample, _internals: { estimateOffLoop, pack, unpack, W, H, FPS, score, isBlack, isEmptyLight, bestSegment, boxedPicture, pillarBars, bestShift, activeRows, coarseDiff } };
