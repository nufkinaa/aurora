// Automatic intro + credits detection for library shows.
//
// The idea (the same one the Jellyfin intro-skipper plugin and Plex use):
// the intro is the one stretch of audio that repeats in every episode of a
// season, and the credits are the one that repeats at the end. So: decode a
// short mono stream of each episode's head and tail with ffmpeg, turn it into
// a coarse spectral fingerprint (16 log-spaced bands per 128ms, hashed as
// "is band i louder than band i+1" bits — volume-independent, cheap, robust
// to encodes), then find the longest run that lines up between episodes.
// Chapter markers, when a release carries titled ones ("Intro", "Opening",
// "Credits"), win outright — they are the author's own answer.
//
// Bounds, from what works in the wild: an intro sits in the first 25% or
// first 10 minutes (whichever is smaller) and lasts 15s–2min; credits start
// inside the last 4 minutes and last at least 20s.
//
// Runs in the background after enrichment, one episode at a time, cached per
// file (id + mtime) in data/intro-auto.json. A manual mark (lib/introstore)
// always beats an automatic one in the player.
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const config = require("../config");
const scanner = require("./scanner");
const metadata = require("./metadata");
const { JsonStore } = require("../lib/jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "intro-auto.json"), {});

const SR = 8000; // Hz — speech/music structure survives, decode is ~free
const FRAME = 4096; // 512ms window — long enough that a sub-hop misalignment between two files barely moves the band energies
const HOP = 1024; // 128ms step
const HEAD_MAX_S = 600; // never fingerprint more than the first 10 minutes
const TAIL_S = 240; // the last four minutes
const INTRO_MIN_S = 15;
const INTRO_MAX_S = 150;
const CREDITS_MIN_S = 20;
const BANDS = Array.from({ length: 16 }, (_, i) => 100 * Math.pow(3500 / 100, i / 15)); // 100 Hz … 3.5 kHz, log-spaced

// ---------- fingerprinting ----------
// 16 Goertzel band energies per frame → 15 comparison bits. A frame with
// (nearly) nothing in it — silence, room tone, hiss — hashes the same in
// EVERY file, so it is marked invalid (INVALID never matches anything):
// otherwise two quiet passages in unrelated episodes read as a shared intro.
const INVALID = 0xffff;
const HANN = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const MIN_CONTRAST = 1.2; // log-energy spread across bands: flat spectra are not evidence
const MIN_LEVEL = 9; // log energy floor: near-silence carries no signature
const fingerprint = (pcm) => {
  const n = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
  const out = new Uint16Array(n);
  const coeff = BANDS.map((f) => 2 * Math.cos((2 * Math.PI * f) / SR));
  const energies = new Float64Array(BANDS.length);
  const windowed = new Float64Array(FRAME);
  for (let fi = 0; fi < n; fi++) {
    const base = fi * HOP;
    // Hann-windowed frame: without it, spectral leakage from a rectangular
    // window swings the band energies with phase, and the rankings flip
    // between two copies of the same audio.
    for (let i = 0; i < FRAME; i++) windowed[i] = pcm[base + i] * HANN[i];
    for (let b = 0; b < BANDS.length; b++) {
      const c = coeff[b];
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < FRAME; i++) {
        const s0 = windowed[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      energies[b] = Math.log(1 + s1 * s1 + s2 * s2 - c * s1 * s2);
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let b = 0; b < BANDS.length; b++) {
      if (energies[b] < lo) lo = energies[b];
      if (energies[b] > hi) hi = energies[b];
    }
    if (hi < MIN_LEVEL || hi - lo < MIN_CONTRAST) {
      out[fi] = INVALID;
      continue;
    }
    let code = 0;
    for (let b = 0; b < BANDS.length - 1; b++) if (energies[b] > energies[b + 1]) code |= 1 << b;
    out[fi] = code;
  }
  return out;
};

const popcount = (x) => {
  x = x - ((x >> 1) & 0x5555);
  x = (x & 0x3333) + ((x >> 2) & 0x3333);
  return (((x + (x >> 4)) & 0x0f0f) * 0x0101) >> 8;
};
const similar = (a, b) => a !== INVALID && b !== INVALID && popcount(a ^ b) <= 4; // ≤4 of 15 bits differ

// The longest run of frames where A[i] matches B[i+offset], tolerating short
// dropouts. Returns {start, end} in A's frame indices, or null.
const longestRunAt = (A, B, offset, maxGap = 6) => {
  let best = null;
  let runStart = -1;
  let gap = 0;
  let lastGood = -1;
  const lo = Math.max(0, -offset);
  const hi = Math.min(A.length, B.length - offset);
  for (let i = lo; i < hi; i++) {
    if (similar(A[i], B[i + offset])) {
      if (runStart < 0) runStart = i;
      lastGood = i;
      gap = 0;
    } else if (runStart >= 0) {
      gap++;
      if (gap > maxGap) {
        if (!best || lastGood - runStart > best.end - best.start) best = { start: runStart, end: lastGood };
        runStart = -1;
        gap = 0;
      }
    }
  }
  if (runStart >= 0 && (!best || lastGood - runStart > best.end - best.start)) best = { start: runStart, end: lastGood };
  return best;
};

// Search offsets in [-maxShift, maxShift] frames for the longest matching run
// between two fingerprints. Returns {start, end, offset} in A's frames.
const longestRun = (A, B, maxShift) => {
  let best = null;
  for (let o = -maxShift; o <= maxShift; o++) {
    const r = longestRunAt(A, B, o);
    if (r && (!best || r.end - r.start > best.end - best.start)) best = { ...r, offset: o };
  }
  return best;
};

const framesToSec = (f) => (f * HOP) / SR;
const secToFrames = (s) => Math.round((s * SR) / HOP);

// ---------- decoding ----------
const decode = (file, startSec, lengthSec) =>
  new Promise((resolve) => {
    const args = ["-v", "error", "-nostdin"];
    if (startSec > 0) args.push("-ss", String(startSec));
    args.push("-i", file, "-t", String(lengthSec), "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-");
    const chunks = [];
    const child = execFile(config.FFMPEG, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 60000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const buf = stdout && stdout.length ? stdout : Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
    child.stdout && child.stdout.on("data", (d) => chunks.push(d));
  });

// Titled chapters, when the release carries them.
const chaptersOf = (file) => {
  try {
    const out = execFileSync(config.FFPROBE, ["-v", "error", "-show_chapters", "-of", "json", file], { encoding: "utf-8", timeout: 15000 });
    return (JSON.parse(out).chapters || []).map((c) => ({
      start: parseFloat(c.start_time) || 0,
      end: parseFloat(c.end_time) || 0,
      title: String((c.tags && c.tags.title) || ""),
    }));
  } catch {
    return [];
  }
};
const fromChapters = (chapters, duration) => {
  const intro = chapters.find((c) => /\b(intro|opening|op)\b/i.test(c.title) && c.end - c.start >= 5 && c.end - c.start <= 240);
  const credits = chapters.find((c) => /\b(credits|ending|ed|outro)\b/i.test(c.title) && (!duration || c.start > duration * 0.6));
  return {
    intro: intro ? { start: intro.start, end: intro.end } : null,
    credits: credits ? { start: credits.start } : null,
  };
};

// ---------- the season pass ----------
const mtimeOf = (p) => {
  try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
};

// Median of agreeing detections: at least two comparisons must land within
// 3s of each other; a season of two episodes has only one comparison, which
// is accepted as-is (nothing else to check it against).
const consensus = (runs, tolS = 3) => {
  const ok = runs.filter(Boolean);
  if (!ok.length) return null;
  if (ok.length === 1) return ok[0];
  ok.sort((a, b) => a.start - b.start);
  const mid = ok[Math.floor(ok.length / 2)];
  const agree = ok.filter((r) => Math.abs(r.start - mid.start) <= tolS && Math.abs(r.end - mid.end) <= tolS);
  if (agree.length < 2) return null;
  const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return { start: med(agree.map((r) => r.start)), end: med(agree.map((r) => r.end)) };
};

const fpCache = new Map(); // file -> {head, tail, duration} for the current pass

const fingerprintsFor = async (file, duration) => {
  if (fpCache.has(file)) return fpCache.get(file);
  const headLen = Math.min(HEAD_MAX_S, Math.max(60, duration * 0.25));
  const head = await decode(file, 0, headLen);
  const tail = duration > TAIL_S + 30 ? await decode(file, Math.max(0, duration - TAIL_S), TAIL_S) : null;
  const rec = {
    head: head && head.length > FRAME ? fingerprint(head) : null,
    tail: tail && tail.length > FRAME ? fingerprint(tail) : null,
    tailStart: duration > TAIL_S + 30 ? Math.max(0, duration - TAIL_S) : 0,
  };
  fpCache.set(file, rec);
  return rec;
};

// Analyze one episode against up to three siblings of its season.
const analyze = async (ep, siblings) => {
  const entry = scanner.resolve(ep.id);
  if (!entry) return null;
  const meta = metadata.getCached(entry.path);
  const duration = (meta && meta.duration) || 0;
  if (!duration) return null;

  // 1. chapters: the author's own answer
  const ch = fromChapters(chaptersOf(entry.path), duration);
  if (ch.intro || ch.credits) return { ...ch, source: "chapters" };

  // 2. audio: the stretch every episode shares
  const me = await fingerprintsFor(entry.path, duration);
  if (!me.head) return null;
  const others = [];
  for (const s of siblings.slice(0, 3)) {
    const e = scanner.resolve(s.id);
    const m = e && metadata.getCached(e.path);
    if (!e || !m || !m.duration) continue;
    others.push(await fingerprintsFor(e.path, m.duration));
  }
  const introRuns = [];
  const creditRuns = [];
  for (const o of others) {
    if (o.head) {
      const r = longestRun(me.head, o.head, secToFrames(180));
      if (r) {
        const start = framesToSec(r.start);
        const end = framesToSec(r.end + 1);
        const len = end - start;
        const limit = Math.min(duration * 0.25, HEAD_MAX_S);
        if (len >= INTRO_MIN_S && len <= INTRO_MAX_S && start <= limit) introRuns.push({ start, end });
      }
    }
    if (me.tail && o.tail) {
      const r = longestRun(me.tail, o.tail, secToFrames(120));
      if (r) {
        const start = me.tailStart + framesToSec(r.start);
        const end = me.tailStart + framesToSec(r.end + 1);
        if (end - start >= CREDITS_MIN_S) creditRuns.push({ start, end });
      }
    }
  }
  const intro = consensus(introRuns);
  const credits = consensus(creditRuns);
  if (!intro && !credits) return { intro: null, credits: null, source: "audio" };
  return {
    intro: intro ? { start: Math.round(intro.start * 10) / 10, end: Math.round(intro.end * 10) / 10 } : null,
    credits: credits ? { start: Math.round(credits.start * 10) / 10 } : null,
    source: "audio",
  };
};

let running = false;
let again = false;
const pass = async () => {
  let done = 0;
  for (const show of scanner.index.shows) {
    for (const season of show.seasons || []) {
      const eps = season.episodes || [];
      if (eps.length < 2) continue;
      for (const ep of eps) {
        const entry = scanner.resolve(ep.id);
        if (!entry) continue;
        const mtime = mtimeOf(entry.path);
        const have = store.data[ep.id];
        if (have && have.mtime === mtime) continue;
        const meta = metadata.getCached(entry.path);
        if (!meta || !meta.duration) continue; // enrichment hasn't reached it yet
        try {
          const res = await analyze(ep, eps.filter((e) => e.id !== ep.id));
          if (!res) continue;
          store.data[ep.id] = { mtime, at: Date.now(), ...res };
          store.save();
          done++;
        } catch (e) {
          console.warn(`[intro] ${show.title} S${season.number}E${ep.episode}: ${e && e.message ? e.message : e}`);
        }
        await new Promise((r) => setImmediate(r));
      }
      fpCache.clear(); // a season's fingerprints are only useful within it
    }
  }
  if (done) console.log(`[intro] analyzed ${done} episode(s) for intros and credits`);
};
const run = async () => {
  if (!config.ffmpegAvailable) return;
  if (running) { again = true; return; }
  running = true;
  try {
    do { again = false; await pass(); } while (again);
  } catch (e) {
    console.warn("[intro] pass failed:", e && e.message ? e.message : e);
  } finally {
    running = false;
  }
};

// What the player asks for: the automatic answer for one episode, or nulls.
const get = (episodeId) => {
  const r = store.data[episodeId];
  return r ? { intro: r.intro || null, credits: r.credits || null, source: r.source || null } : { intro: null, credits: null, source: null };
};

scanner.events.on("enriched", () => setTimeout(run, 5000));

module.exports = { run, get, _internals: { fingerprint, longestRun, consensus, fromChapters, similar, INVALID, FRAME, HOP, SR } };
