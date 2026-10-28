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
//
// What the file can't answer, the public databases may (skipsegments.js): an
// episode with no detected intro or credits, a season of one episode, and —
// always — recaps and previews, which repeat nowhere and so can't be found
// by comparison. Those answers ride in the same record under `db`, and get()
// merges them UNDER the file's own: measured-on-this-file beats crowd data.
//
// And the picture (creditscv.js): every library episode — a season of one
// too — has its tail looked at for the credits themselves (text on a flat
// background, cards or a roll, no camera cuts). That answer rides under
// `cv` with a confidence, and chooseCredits() below fuses it with the
// chapters, the audio and the databases.
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const config = require("../config");
const scanner = require("./scanner");
const metadata = require("./metadata");
const { JsonStore } = require("../lib/jsonstore");

const cpuwork = require("./cpuwork");
const creditscv = require("./creditscv");
const introprint = require("./introprint");
const printPool = require("./introprint-pool");
const recaprules = require("./recaprules");
const store = new JsonStore(path.join(config.DATA_DIR, "intro-auto.json"), {});
const prints = new JsonStore(path.join(config.DATA_DIR, "intro-prints.json"), {});

const SR = 8000; // Hz — speech/music structure survives, decode is ~free
const FRAME = 4096; // 512ms window — long enough that a sub-hop misalignment between two files barely moves the band energies
const HOP = 1024; // 128ms step
const HEAD_MAX_S = 900; // the intro is looked for in the first quarter, at most 15 minutes (Silo's comes 10 min in)
const HEAD_FIRST_S = 300; // urgent: the first five minutes are read first
const TAIL_S = 240; // the last four minutes
const INTRO_MIN_S = 8; // a title card — when two comparisons agree, or a known intro answers
const INTRO_LONE_MIN_S = 15; // what one comparison must find to be believed on its own
const INTRO_MAX_S = 180;
const PRINT_MARGIN_S = 5; // a known intro is kept with this much either side
const CHAPTER_MARGIN_S = 20; // ... more when a chapter said where it is (its edges are the picture's, not the sound's)
const PRINTS_PER_SHOW = 8; // a theme per season, short and long versions
const SIBLINGS = 3;
const URGENT_SIBLINGS = 2;
const COPIES_SKIPPED = 3; // at most this many copies of an episode passed over for the next sibling
const WHOLE_MAX_S = 3 * 3600; // the recap check reads a whole episode, never more than this
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
// The synchronous core (tests drive it directly); the credits use the
// cooperative wrapper below so a long head never holds the event loop.
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

// Where the run REALLY begins. longestRunAt tolerates dropouts, and two
// episodes of one show resemble each other well before their credits — the
// same score swelling under the last scene, the same room tone — so a run's
// leading edge creeps early: Up next was arriving 10–20 seconds before the
// credits (elia). The credits proper are the SAME recording in both files,
// which shows as near-total agreement; the lead-in is scattered hits. So the
// start moves forward to the first place where a 4-second window agrees
// densely. Never past the point that would leave less than `minFrames`.
const DENSE_WINDOW_S = 4;
const DENSE_RATIO = 0.72;
const tightenStart = (A, B, run, minFrames = 0) => {
  if (!run) return run;
  const W = Math.max(8, Math.round((DENSE_WINDOW_S * SR) / HOP));
  const last = run.end - Math.max(W, minFrames);
  if (last <= run.start) return run;
  const hit = (i) => {
    const j = i + run.offset;
    return j >= 0 && j < B.length && similar(A[i], B[j]) ? 1 : 0;
  };
  // sliding count over [i, i+W)
  let count = 0;
  for (let i = run.start; i < run.start + W; i++) count += hit(i);
  for (let start = run.start; start <= last; start++) {
    if (count / W >= DENSE_RATIO && hit(start)) return { ...run, start };
    count -= hit(start);
    count += hit(start + W);
  }
  return run; // never dense: keep what we had rather than invent an edge
};

// ---------- the picture's opinion ----------
// Audio says where the end music starts; the credits start where the picture
// goes to them. ffmpeg's blackdetect over a short window after the audio's
// answer finds the cut (or fade) to black that opens a credit roll — and a
// roll of white text on black reads as black from its first frame. The start
// only ever moves LATER, by at most CREDITS_SNAP_S, and only onto a black
// segment that begins after the audio's answer; a show whose credits run over
// the picture has no black to find and keeps the audio's answer.
const CREDITS_SNAP_S = 28;
const parseBlackdetect = (stderr) => {
  const out = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(String(stderr || "")))) out.push({ start: parseFloat(m[1]), end: parseFloat(m[2]) });
  return out;
};
// `at`: the audio's answer, in the same clock as the segments. Returns the
// better start, or null for "no opinion".
const snapToBlack = (segments, at, maxLater = CREDITS_SNAP_S) => {
  for (const b of segments) {
    if (b.start <= at + 0.6 && b.end >= at - 0.2) return null; // already in black: the audio was right
  }
  const next = segments.find((b) => b.start > at + 0.6 && b.start <= at + maxLater);
  return next ? next.start : null;
};
const blackSegments = (file, from, length, threads = null) =>
  new Promise((resolve) => {
    const args = [
      "-hide_banner", "-nostats", "-nostdin", "-v", "info",
      ...(threads ? ["-threads", String(threads)] : []),
      "-ss", String(Math.max(0, from)), "-i", file, "-t", String(length),
      "-an", "-sn",
      // a thumbnail-sized picture at 5 fps is all the detector needs
      "-vf", "fps=5,scale=160:-2,blackdetect=d=0.3:pic_th=0.92:pix_th=0.12",
      "-f", "null", "-",
    ];
    const child = execFile(config.FFMPEG, args, { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 90000 }, (err, stdout, stderr) => {
      resolve(parseBlackdetect(stderr));
    });
    cpuwork.background.lower(child);
  });
const refineCreditsByPicture = async (file, start, duration, threads = null) => {
  try {
    const from = Math.max(0, start - 2);
    const length = Math.min(CREDITS_SNAP_S + 6, Math.max(4, duration - from));
    const segs = await blackSegments(file, from, length, threads);
    const snapped = snapToBlack(segs, start - from);
    return snapped == null ? null : Math.min(duration - 5, from + snapped);
  } catch {
    return null;
  }
};

// The credits' first CARD. The end theme is the sound every episode shares;
// some shows put an episode's own card up before it — Avatar: The Last
// Airbender's "Written by … Directed by" on parchment, four to five seconds
// before its end theme, over the end of the episode's own score (which no
// other episode shares). So, from the audio's answer, look back a few
// seconds for a STILL picture that is not black and runs up to it (but for
// a beat of black between): the credits start where it comes in. Only
// ever earlier, by at most CARD_BACK_S; a picture that moves (the last
// scene), or black, is no card.
const CARD_BACK_S = 8;
const CARD_FPS = 5;
const STILL = 0.5; // mean change per pixel between two frames of a card (a card: 0.0-0.1; slow animation: 1-3)
const CW = 64;
const CH = 36;
const cardFrames = (file, from, length, threads = null) =>
  new Promise((resolve) => {
    const args = ["-hide_banner", "-nostats", "-nostdin", "-v", "error", ...(threads ? ["-threads", String(threads)] : []),
      "-ss", String(Math.max(0, from)), "-i", file, "-t", String(length), "-an", "-sn",
      "-vf", `fps=${CARD_FPS},scale=${CW}:${CH},format=gray`, "-f", "rawvideo", "-"];
    const child = execFile(config.FFMPEG, args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 60000 }, (err, stdout) => {
      const n = stdout ? Math.floor(stdout.length / (CW * CH)) : 0;
      const frames = [];
      for (let i = 0; i < n; i++) frames.push(stdout.subarray(i * CW * CH, (i + 1) * CW * CH));
      resolve(frames);
    });
    cpuwork.background.lower(child);
  });
// frames (gray CWxCH) from `from`; `at` the audio's answer, in seconds from
// `from`. -> seconds from `from` where the card comes in, or null.
const findCard = (frames, at) => {
  const mean = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i]; return s / f.length; };
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const end = Math.min(frames.length - 1, Math.round(at * CARD_FPS));
  // back from the audio's answer, over at most three and a half seconds of
  // change (a fade, a beat of black), to a still picture
  let last = end;
  while (last > 0 && end - last <= CARD_FPS * 3.5 && !(diff(frames[last], frames[last - 1]) < STILL && mean(frames[last]) >= 24)) last--;
  if (end - last > CARD_FPS * 3.5 || last <= 0) return null;
  let first = last;
  while (first > 0 && diff(frames[first], frames[first - 1]) < STILL) first--;
  if ((last - first + 1) / CARD_FPS < 1.5) return null; // not a card: it moves
  if (mean(frames[first]) < 24) return null; // black is not a card
  // where it comes in (a cut, at five pictures a second)
  return first / CARD_FPS;
};
const refineCreditsByCard = async (file, start, threads = null) => {
  try {
    const from = Math.max(0, start - CARD_BACK_S);
    const frames = await cardFrames(file, from, start - from + 1, threads);
    const t = frames.length ? findCard(frames, start - from) : null;
    return t == null ? null : from + t;
  } catch {
    return null;
  }
};

const framesToSec = (f) => (f * HOP) / SR;
const secToFrames = (s) => Math.round((s * SR) / HOP);

// ---------- decoding ----------
const decode = (file, startSec, lengthSec, maxBuffer = 64 * 1024 * 1024) =>
  new Promise((resolve) => {
    const args = ["-v", "error", "-nostdin"];
    if (startSec > 0) args.push("-ss", String(startSec));
    args.push("-i", file, "-t", String(lengthSec), "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-");
    const chunks = [];
    const child = execFile(config.FFMPEG, args, { encoding: "buffer", maxBuffer, windowsHide: true, timeout: Math.max(60000, lengthSec * 100) }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const buf = stdout && stdout.length ? stdout : Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
    child.stdout && child.stdout.on("data", (d) => chunks.push(d));
    cpuwork.background.lower(child);
  });

// Titled chapters, when the release carries them.
const chaptersOf = (file) =>
  new Promise((resolve) => {
    execFile(config.FFPROBE, ["-v", "error", "-show_chapters", "-of", "json", file], { encoding: "utf-8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      try {
        resolve((JSON.parse(out).chapters || []).map((c) => ({
          start: parseFloat(c.start_time) || 0,
          end: parseFloat(c.end_time) || 0,
          title: String((c.tags && c.tags.title) || ""),
        })));
      } catch {
        resolve([]);
      }
    });
  });

// fingerprint() in slices of ~2 s of audio per turn of the event loop: the
// whole head takes a second or two of CPU, which as one block would read as
// a stalled server to everything else (and to the watchdog).
const fingerprintAsync = async (pcm) => {
  const n = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
  const out = new Uint16Array(n);
  const SLICE = 32; // frames per turn (≈ 4 s of audio)
  for (let start = 0; start < n; start += SLICE) {
    const end = Math.min(n, start + SLICE);
    // a window of samples covering frames [start, end)
    const from = start * HOP;
    const to = Math.min(pcm.length, (end - 1) * HOP + FRAME);
    const part = fingerprint(pcm.subarray(from, to));
    for (let i = 0; i < end - start && i < part.length; i++) out[start + i] = part[i];
    await new Promise((r) => setImmediate(r));
  }
  return out;
};
// "Intro", "Opening", "OP"/"OP1", "Opening Credits", "Main Title(s)",
// "Title Sequence", "Theme Song"
const INTRO_CHAPTER = /\b(intro|opening|op\d?|main titles?|title sequence|theme song)\b/i;
const fromChapters = (chapters, duration) => {
  const intro = chapters.find((c) => INTRO_CHAPTER.test(c.title) && c.end - c.start >= 5 && c.end - c.start <= 240);
  const credits = chapters.find((c) => /\b(credits|ending|ed|outro)\b/i.test(c.title) && (!duration || c.start > duration * 0.6));
  return {
    intro: intro ? { start: intro.start, end: intro.end } : null,
    credits: credits ? { start: credits.start } : null,
  };
};

// ---------- the season pass ----------
// One stat per file per run: the audio pass and the database fill that
// follows it both ask for every episode's date (it was 14,400 blocking stats
// an hour on an idle server with 600 episodes — two runs after each scan,
// two stats each). run() opens the memo and drops it when it ends; outside a
// run every call reads the disk, as before.
let mtimeMemo = null;
const mtimeOf = (p) => {
  if (mtimeMemo && mtimeMemo.has(p)) return mtimeMemo.get(p);
  // the scanner's last walk dated every library video (at most one rescan
  // old): no stat at all for a pass over a settled library
  const walked = scanner.walkedStat ? scanner.walkedStat(p) : null;
  if (walked) return Math.floor(walked.mtimeMs);
  let m = 0;
  try { m = Math.floor(fs.statSync(p).mtimeMs); } catch { m = 0; }
  if (mtimeMemo) mtimeMemo.set(p, m);
  return m;
};

// An episode the analysis could say NOTHING about (its sound could not be
// decoded, or is too short to fingerprint) used to get no record at all — so
// it was read again after every scan, for ever: a chapters probe and one or
// two ffmpeg decodes every ten minutes per such episode. It now gets a
// record that says so, and is tried again after NONE_RETRY_MS (a decode can
// fail for a passing reason) or when the file changes.
const NONE_RETRY_MS = 7 * 24 * 3600 * 1000;
// Does this episode need the audio pass now?
const analysisDue = (have, mtime, now = Date.now()) => {
  if (!have || have.mtime !== mtime || have.v !== ANALYSIS_V) return true;
  if (have.checkDue || have.creditsDue) return true;
  return !!have.none && now - (have.at || 0) > NONE_RETRY_MS;
};
// The record for "looked, nothing to say" — or null when what is on file for
// this very file already holds an answer (from an older analysis version, or
// one that worked before): that is never replaced by nothing.
const noneRecord = (have, mtime, now = Date.now()) => {
  const same = have && have.mtime === mtime ? have : null;
  if (same && (same.intro || same.credits)) return null;
  return { mtime, at: now, v: ANALYSIS_V, intro: null, credits: null, source: null, none: true, ...(same && same.db ? { db: same.db } : {}), ...(same && same.cv ? { cv: same.cv } : {}) };
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

// ---------- reading an episode ----------
// What one analysis read of a file, kept for the comparisons that follow —
// a pass keeps one per show (cleared after it), an urgent job its own.
//   head: the intro fingerprint (introprint.js) of the first `headLen` s
//   tail: the credits fingerprint (above) of the last four minutes
const headLimit = (duration) => Math.min(HEAD_MAX_S, Math.max(60, duration * 0.25));
const headOf = async (cache, file, duration, seconds = headLimit(duration)) => {
  const c = cache.get(file) || {};
  if (c.headLen != null && c.headLen >= seconds - 0.5) return c.head;
  // (decoded and fingerprinted in a helper process: introprint-pool.js)
  const head = await printPool.read(file, 0, seconds, { urgent: !!cache.urgent });
  cache.set(file, { ...(cache.get(file) || {}), head, headLen: seconds });
  return head;
};
const tailOf = async (cache, file, duration) => {
  const c = cache.get(file) || {};
  if ("tail" in c) return c;
  const tailStart = duration > TAIL_S + 30 ? Math.max(0, duration - TAIL_S) : 0;
  const tail = duration > TAIL_S + 30 ? await printPool.read(file, tailStart, TAIL_S, { urgent: !!cache.urgent }) : null;
  const rec = { ...(cache.get(file) || {}), tail, tailStart };
  cache.set(file, rec);
  return rec;
};
// The whole of an episode (the recap check: is this the episode before,
// heard again?). Only ever asked for an episode that has a recap to check.
const wholeOf = async (cache, file, duration) => {
  const c = cache.get(file) || {};
  if ("whole" in c) return c.whole;
  const whole = await printPool.read(file, 0, Math.min(duration + 5, WHOLE_MAX_S));
  cache.set(file, { ...(cache.get(file) || {}), whole });
  return whole;
};
let passCache = new Map();

// Where an episode sits in the library: { show, season, ep } or null.
const locate = (episodeId) => {
  for (const show of scanner.index.shows || []) {
    for (const season of show.seasons || []) {
      const ep = (season.episodes || []).find((e) => e.id === episodeId);
      if (ep) return { show, season, ep };
    }
  }
  return null;
};
// Everything an analysis needs about one episode, or null. The length comes
// from the library's probe — or, for a download that landed a moment ago and
// is not probed yet, from a probe now (the same one enrichment would make).
const contextOf = async (episodeId, at = locate(episodeId)) => {
  if (!at) return null;
  const entry = scanner.resolve(at.ep.id);
  if (!entry) return null;
  let meta = metadata.getCached(entry.path);
  if (!meta || !meta.duration) {
    try { meta = await metadata.probeAsync(entry.path); } catch { meta = null; }
  }
  if (!meta || !meta.duration) return null;
  return { ...at, entry, duration: meta.duration, mtime: mtimeOf(entry.path) };
};

// The episodes this one is compared with: its season's nearest first (an
// intro can change mid-season), then the show's other seasons, nearest
// season first — a season of one, the first episode of a new season, or the
// one episode left after the rest were cleaned away still has company.
const num = (x) => Number(x) || 0;
// (the order alone, pure: tools/intro-eval uses it too)
const orderSiblings = (show, season, ep) => {
  const same = (season.episodes || [])
    .filter((e) => e.id !== ep.id)
    .sort((a, b) => Math.abs(num(a.episode) - num(ep.episode)) - Math.abs(num(b.episode) - num(ep.episode)) || num(a.episode) - num(b.episode));
  const others = [];
  for (const s of show.seasons || []) {
    if (s === season) continue;
    const before = num(s.number) < num(season.number);
    for (const e of s.episodes || []) {
      // the previous season's last episodes, the next season's first ones
      others.push({ e, d: Math.abs(num(s.number) - num(season.number)), k: before ? -num(e.episode) : num(e.episode) });
    }
  }
  others.sort((a, b) => a.d - b.d || a.k - b.k);
  return [...same, ...others.map((o) => o.e)];
};
const siblingsOf = (show, season, ep, max) => {
  const out = [];
  for (const e of orderSiblings(show, season, ep)) {
    if (out.length >= max) break;
    const entry = scanner.resolve(e.id);
    const meta = entry && metadata.getCached(entry.path);
    if (!entry || !meta || !meta.duration) continue;
    out.push({ ep: e, entry, duration: meta.duration });
  }
  return out;
};

// ---------- a show's known intros (introprint templates) ----------
// Kept per show in data/intro-prints.json: the fingerprint of an intro that
// was found (a few seconds either side included), so a new episode can be
// matched on its own, in seconds, against what the show's intro sounds like —
// it rarely changes. Trust: "chapters" (the release titled it), "confirmed"
// (two comparisons or more agreed), "pair" (one comparison: used, but it
// takes the company of another to win, and is replaced by a confirmed one).
const RANK = { pair: 0, confirmed: 1, chapters: 2 };
// A known intro carries, beside its fingerprint, WHERE in it the intro is
// (`in`: [start, end] s, in the slice's own clock): the margins either side
// are that episode's own sound — its cold open, the scene after its title
// card. An episode that shares a margin too is a copy of the episode the
// intro was learned from (another name, the other version of a replaced
// file): its match is held to those bounds (matchesOf). Without them its
// intro ran on into the margin, 5 s per round, and the longer intro then
// replaced the known one ("a longer version"): 47.4 -> 52.4 -> 57.5 s on
// Avatar: The Last Airbender S1E4 copies.
// Intros kept before the bounds existed are not used (and are learned again).
const boundsOk = (t) => Array.isArray(t.in) && t.in.length === 2 && Number.isFinite(t.in[0]) && Number.isFinite(t.in[1]) && t.in[1] > t.in[0];
const printsOf = (showId) => (prints.data[showId] && Array.isArray(prints.data[showId].prints) ? prints.data[showId].prints.filter(boundsOk) : []);
// A known intro as a comparison: { fp, trusted, kind, bounds, t } or null.
const comparisonOf = (t) => {
  const fp = boundsOk(t) ? introprint.decode(t) : null;
  return fp ? { fp, trusted: RANK[t.trust] >= RANK.confirmed, kind: "known", bounds: { start: t.in[0], end: t.in[1] }, t } : null;
};
const knownIntros = (show, ep, mtime) =>
  printsOf(show.id)
    // (never an episode against its own intro: that only repeats what it said)
    .filter((t) => !(t.from === ep.id && t.mtime === mtime))
    .map(comparisonOf)
    .filter(Boolean);
// What `head` shares with one comparison, intro-sized: [{ start, end, … }]
// in head's clock. Against a known intro: a match that shares (nearly) all
// of a margin's sound is the episode the intro was learned from, again —
// it is held to the intro's own bounds. Any other match keeps its edges: an
// episode whose intro starts a little before (or ends a little after) where
// it was learned shares only that much of a margin, and that is real.
const MARGIN_SHARED = 0.8;
const sharesMargin = (fp, from, to, at0, at1) => {
  // valid frames of fp in [from, to) s, and how many of them lie in [at0, at1]
  let valid = 0;
  let covered = 0;
  const a = Math.max(0, introprint.frameAt(from));
  const b = Math.min(fp.codes.length, introprint.frameAt(to));
  for (let f = a; f < b; f++) {
    if (!fp.valid[f]) continue;
    valid++;
    const t = introprint.timeOf(f);
    if (t >= at0 && t <= at1) covered++;
  }
  return valid >= introprint.FPS && covered / valid >= MARGIN_SHARED;
};
const matchesOf = (head, c, minS) => {
  const found = introprint.match(head, c.fp, { minS });
  if (!c.bounds) return found;
  const out = [];
  const len = introprint.timeOf(c.fp.codes.length);
  for (const m of found) {
    // head time h is the known intro's h + offset / FPS
    const shift = m.offset / introprint.FPS;
    const t0 = m.start + shift;
    const t1 = m.end + shift;
    const copy = sharesMargin(c.fp, 0, c.bounds.start, t0, t1) || sharesMargin(c.fp, c.bounds.end, len, t0, t1);
    const start = copy ? Math.max(m.start, c.bounds.start - shift) : m.start;
    const end = copy ? Math.min(m.end, c.bounds.end - shift) : m.end;
    if (end - start >= minS) out.push({ ...m, start, end, ...(copy ? { copy: true } : {}) });
  }
  return out.sort((x, y) => y.end - y.start - (x.end - x.start));
};
// Fold an intro just found (its fingerprint slice) into a show's list of
// known ones. Pure: -> { list, changed }. `meta`: { trust, len, from, mtime, season }.
const mergePrints = (known, slice, meta) => {
  const list = known.slice();
  const rec = { ...introprint.encode(slice), ...(slice.at ? { in: [round2(slice.at.start), round2(slice.at.end)] } : {}), ...meta, at: meta.at || Date.now(), uses: 1 };
  // the same intro as one already known?
  const same = list.findIndex((t) => {
    const fp = introprint.decode(t);
    return !!fp && introprint.match(slice, fp, { minS: Math.min(INTRO_MIN_S, meta.len / 2) }).length > 0;
  });
  if (same < 0) {
    list.push(rec);
    // the weakest, least used, oldest goes
    list.sort((a, b) => RANK[b.trust] - RANK[a.trust] || (b.uses || 0) - (a.uses || 0) || (b.at || 0) - (a.at || 0));
    list.length = Math.min(list.length, PRINTS_PER_SHOW);
    return { list, changed: list.includes(rec) };
  }
  const t = list[same];
  const better = RANK[meta.trust] > RANK[t.trust] || (RANK[meta.trust] === RANK[t.trust] && meta.len > (t.len || 0) + 2);
  if (!better) { t.uses = (t.uses || 0) + 1; return { list: known, changed: false }; } // (counted, not worth a write)
  list[same] = { ...rec, uses: (t.uses || 0) + 1 };
  return { list, changed: true };
};
// (`at`: where the intro is in the slice's own clock — its first frame is
// head frame `from`, so every time in it is head time less from / FPS)
const sliceFor = (head, intro, margin = PRINT_MARGIN_S) => {
  const slice = introprint.cut(head, intro.start - margin, intro.end + margin);
  if (slice.codes.length < introprint.FPS * INTRO_MIN_S) return null;
  const from = Math.max(0, introprint.frameAt(intro.start - margin));
  slice.at = { start: intro.start - from / introprint.FPS, end: intro.end - from / introprint.FPS };
  return slice;
};
const learn = (ctx, head, intro, trust, margin = PRINT_MARGIN_S) => {
  if (!head || !intro || !ctx.show || !ctx.show.id) return;
  const slice = sliceFor(head, intro, margin);
  if (!slice) return;
  const len = Math.round((intro.end - intro.start) * 10) / 10;
  const { list, changed } = mergePrints(printsOf(ctx.show.id), slice, { from: ctx.ep.id, mtime: ctx.mtime, season: num(ctx.season.number), trust, len });
  if (!changed) return;
  prints.data[ctx.show.id] = { prints: list };
  prints.save();
};

// ---------- the intro ----------
// `head` against every comparison: what they agree on (introprint.agree), as
// { start, end, support, trusted } or null.
const introFrom = async (head, comparisons, limitS) => {
  const lists = [];
  for (const c of comparisons) {
    const found = matchesOf(head, c, INTRO_MIN_S).filter((x) => x.end - x.start <= INTRO_MAX_S);
    lists.push({ found, trusted: c.trusted });
    await new Promise((r) => setImmediate(r));
  }
  return lists.length ? introprint.agree(lists, { minS: INTRO_MIN_S, loneMinS: INTRO_LONE_MIN_S, limitS }) : null;
};

// ---------- the databases' intro, heard ----------
// A crowd timestamp is for SOME cut of this episode. When our own comparison
// found no intro, is the stretch the database names heard elsewhere (a known
// intro, a sibling) — even a short one? Then it is used, at the edges THIS
// file's sound gives it (a cut with another logo up front is shifted onto
// its own). Not heard although there were two or more to compare with: not
// used — a wrong cut, or an episode with no intro. Fewer: no opinion.
//   -> { intro: <the database's>, verdict: "heard"|"not heard", fixed } | null
const DB_HEARD_MIN_S = 4;
const checkDbIntro = (head, comparisons, dbIntro) => {
  if (!head || !dbIntro || !Number.isFinite(dbIntro.start) || !Number.isFinite(dbIntro.end)) return null;
  const len = dbIntro.end - dbIntro.start;
  let best = null;
  for (const c of comparisons) {
    for (const m of matchesOf(head, c, DB_HEARD_MIN_S)) {
      const overlap = Math.min(m.end, dbIntro.end) - Math.max(m.start, dbIntro.start);
      if (overlap <= 0 || m.end - m.start > INTRO_MAX_S) continue;
      if (!best || overlap > best.overlap) best = { overlap, m };
    }
  }
  const at = { start: dbIntro.start, end: dbIntro.end };
  if (best && best.overlap >= Math.min(len * 0.5, 8)) return { intro: at, verdict: "heard", fixed: { start: round2(best.m.start), end: round2(best.m.end) } };
  if (comparisons.length >= 2) return { intro: at, verdict: "not heard", fixed: null };
  return null;
};
const round2 = (x) => Math.round(x * 100) / 100;

// The intro of one episode: { intro, head, via, support } — intro null when
// nothing agreed; head null when its sound could not be read.
//   urgent (somebody is about to watch it): a known intro is tried on the
//   first five minutes alone, then on the whole head; siblings only when
//   no known intro answers — two of them, not three.
const analyzeIntro = async (ctx, cache, { urgent = false } = {}) => {
  const { show, season, ep, entry, duration } = ctx;
  const limitS = headLimit(duration);
  const known = knownIntros(show, ep, ctx.mtime);
  if (urgent && known.length && limitS > HEAD_FIRST_S + 30) {
    const early = await headOf(cache, entry.path, duration, HEAD_FIRST_S);
    if (early) {
      const r = await introFrom(early, known, HEAD_FIRST_S);
      // (an intro running past the end of what was read is read in full below)
      if (r && r.trusted && r.end < HEAD_FIRST_S - 5) return { intro: r, head: early, via: "known", comparisons: known };
    }
  }
  const head = await headOf(cache, entry.path, duration, limitS);
  if (!head) return { intro: null, head: null, comparisons: [] };
  if (urgent && known.length) {
    const r = await introFrom(head, known, limitS);
    if (r && r.trusted) return { intro: r, head, via: "known", comparisons: known };
  }
  const comparisons = [...known];
  // (a sibling that is this very recording — a copy, the other version —
  // is passed over for the next one: it shares the scene after the intro)
  const want = urgent ? URGENT_SIBLINGS : SIBLINGS;
  let siblings = 0;
  for (const s of siblingsOf(show, season, ep, want + COPIES_SKIPPED)) {
    if (siblings >= want) break;
    const fp = await headOf(cache, s.entry.path, s.duration);
    if (!fp || introprint.sameRecording(head, fp)) continue;
    comparisons.push({ fp, trusted: false, kind: "sibling" });
    siblings++;
  }
  const r = await introFrom(head, comparisons, limitS);
  // (learned from whenever siblings took part — a longer version of a known
  // intro replaces the shorter one)
  return { intro: r, head, via: r ? (r.others > 0 ? "siblings" : "known") : null, comparisons };
};

// ---------- the credits ----------
// The end theme the season shares (introprint.creditsCandidates — a scene in
// the middle of the credits splits the theme, the credits still start at its
// first part), compared with the nearest three episodes the way the intro
// is; then the picture's last word on WHEN (blackdetect, later only), and
// whether a SCENE follows them: sound after the end theme for at least
// SCENE_MIN_S that no other episode has. Up next then does not count down
// over it (the players start the next episode when the file ends).
//   -> { start, end, scene?, snapped? } or null
const SCENE_MIN_S = 15;
const CREDITS_LONE_MIN_S = 25;
// Is the episode in `b` a copy of the one in `a`? By their heads when this
// analysis read them (introprint.sameRecording), else by the tails: a copy
// shares the whole four minutes, an episode at most its credits — 200 s of
// identical credits would start before the tail anyway. (On this house's
// library: two different episodes shared at most 110 s of a head, 65 s of a
// tail, 38 % of the sound side by side.)
const SAME_TAIL_S = 200;
const copyOf = (cache, a, b, tailA, tailB) => {
  const ha = (cache.get(a) || {}).head;
  const hb = (cache.get(b) || {}).head;
  if (ha && hb) return introprint.sameRecording(ha, hb);
  return introprint.sameRecording(tailA, tailB, SAME_TAIL_S);
};
const analyzeCredits = async (ctx, cache, { threads = null } = {}) => {
  const { show, season, ep, entry, duration } = ctx;
  const me = await tailOf(cache, entry.path, duration);
  if (!me.tail) return null;
  const others = [];
  for (const s of siblingsOf(show, season, ep, SIBLINGS + COPIES_SKIPPED)) {
    if (others.length >= SIBLINGS) break;
    const o = await tailOf(cache, s.entry.path, s.duration);
    if (o.tail && !copyOf(cache, entry.path, s.entry.path, me.tail, o.tail)) others.push(o.tail);
  }
  const r = await creditsFrom(me.tail, others, me.tailStart, duration);
  if (!r) return null;
  // the picture gets the last word on WHEN the credits begin: a card before
  // the end theme (earlier), else the cut to black that opens them (later)
  let start = r.start;
  let snapped = false;
  let card = false;
  const byCard = await refineCreditsByCard(entry.path, start, threads);
  if (byCard != null && byCard < start - 0.3 && byCard >= start - CARD_BACK_S) { start = byCard; card = true; }
  if (!card) {
    const byPicture = await refineCreditsByPicture(entry.path, start, duration, threads);
    if (byPicture != null && byPicture > start && byPicture < r.end - 5) { start = byPicture; snapped = true; }
  }
  return { ...r, start: round2(start), ...(snapped ? { snapped: true } : {}), ...(card ? { card: true } : {}) };
};
// The decision alone (tools/intro-eval too): this tail against the others'.
// -> { start, end, scene? } in the file's clock, or null
const creditsFrom = async (tail, others, tailStart, duration) => {
  const lists = [];
  for (const o of others) {
    lists.push({ found: introprint.creditsCandidates(tail, o, { minS: INTRO_MIN_S, totalMinS: CREDITS_MIN_S }), trusted: false });
    await new Promise((r) => setImmediate(r));
  }
  const r = lists.length ? introprint.agree(lists, { minS: 1, loneMinS: CREDITS_LONE_MIN_S }) : null;
  if (!r) return null;
  const tailEnd = Math.min(duration, tailStart + TAIL_S);
  // (at the end theme's own loudness less 12 dB: a scene, not hiss)
  const scene = tailStart + r.end < tailEnd - SCENE_MIN_S && introprint.audibleAfter(tail, r.end, introprint.loudness(tail, r.start, r.end) - 12) >= SCENE_MIN_S;
  return { start: round2(tailStart + r.start), end: round2(tailStart + r.end), ...(scene ? { scene: true } : {}) };
};

// ---------- a recap, heard ----------
// Only the databases name recaps (one repeats in no other episode). A recap
// is the episodes before heard again: its clips are looked for in the last
// RECAP_BACK episodes' whole sound. A recap is re-cut and talked over
// ("Previously on…", new music under the clips) — Seven Havens' 30-50 s
// recaps have 2-6 s of their clips' own sound left; a cold open called a
// recap has none (Avatar: The Last Airbender: 0.0). So: two seconds of an
// earlier episode heard in it = heard, shown; nothing = never shown; the
// episodes before not on disk: decided by trustRecap (strict) instead.
//   -> { recap: <the database's>, verdict, covered } | null
const RECAP_HEARD_S = 2;
const RECAP_BACK = 3;
const previousOf = (show, season, ep, max = 2) => {
  const all = [];
  for (const s of [...(show.seasons || [])].sort((a, b) => num(a.number) - num(b.number))) {
    for (const e of [...(s.episodes || [])].sort((a, b) => num(a.episode) - num(b.episode))) all.push({ s, e });
  }
  const at = all.findIndex((x) => x.e.id === ep.id);
  const out = [];
  for (let i = at - 1; i >= 0 && out.length < max; i--) {
    const entry = scanner.resolve(all[i].e.id);
    const meta = entry && metadata.getCached(entry.path);
    if (entry && meta && meta.duration) out.push({ ep: all[i].e, entry, duration: meta.duration });
  }
  return out;
};
const checkRecap = async (ctx, cache, head, recap) => {
  if (!head || !recap || !Number.isFinite(recap.start) || !Number.isFinite(recap.end) || recap.end <= recap.start) return null;
  const at = { start: recap.start, end: recap.end };
  const before = previousOf(ctx.show, ctx.season, ctx.ep, RECAP_BACK);
  if (!before.length) return { recap: at, verdict: "unverifiable", covered: 0 };
  const wholes = [];
  for (const b of before) {
    const whole = await wholeOf(cache, b.entry.path, b.duration);
    if (whole) wholes.push(whole);
  }
  // and one episode that is NOT before it: what is heard there too is the
  // show's own (its intro, a logo), not a recap
  const controls = [];
  for (const s of siblingsOf(ctx.show, ctx.season, ctx.ep, 6)) {
    if (before.some((b) => b.ep.id === s.ep.id)) continue;
    const fp = await headOf(cache, s.entry.path, s.duration);
    if (fp && !introprint.sameRecording(head, fp)) controls.push(fp); // (a copy of this episode has its recap too)
    if (controls.length) break;
  }
  return recapVerdict(head, wholes, recap, controls);
};
// The decision alone (tools/intro-eval too): `recap` in `head`, against the
// sound of the episodes before. -> { recap, verdict, covered }
const recapVerdict = (head, wholes, recap, controls = []) => {
  const at = { start: recap.start, end: recap.end };
  if (!wholes.length) return { recap: at, verdict: "unverifiable", covered: 0 };
  let covered = 0;
  for (const whole of wholes) {
    covered = Math.max(covered, introprint.reheard(head, whole, recap.start, recap.end).covered);
    if (covered >= RECAP_HEARD_S) break;
  }
  if (covered < RECAP_HEARD_S) return { recap: at, verdict: "not heard", covered: round2(covered) };
  // heard just as well in an episode that is not before it: the show's own
  // sound (the intro, a logo, a theme), not this episode's recap
  for (const c of controls) {
    if (introprint.reheard(head, c, recap.start, recap.end).covered >= covered * 0.5) return { recap: at, verdict: "not heard", covered: round2(covered), shared: true };
  }
  return { recap: at, verdict: "heard", covered: round2(covered) };
};

// One episode, all of it: chapters first (the release's own answer, for what
// it names), then the audio for the rest. Returns the record's fields, or
// null when nothing at all could be read. `keep`: credits already measured on
// this very file (an older analysis whose credits logic has not changed) —
// kept instead of read again. `introOnly`: credits left for later.
const analyzeEpisode = async (ctx, cache, { urgent = false, introOnly = false, threads = null } = {}) => {
  const ch = fromChapters(await chaptersOf(ctx.entry.path), ctx.duration);
  let intro = null;
  let introSource = null;
  let support = null;
  let introTrusted = false;
  let readable = false;
  let head = null;
  let compared = 0;
  let dbCheck = null;
  let recapCheck = null;
  // what the databases said about this episode, when they were asked before
  const db = (store.data[ctx.ep.id] || {}).db || null;
  if (ch.intro) {
    intro = ch.intro;
    introSource = "chapters";
    readable = true;
    // a show without a known intro learns it from the chapter (for the
    // episode that will come without chapters, or alone)
    if (!printsOf(ctx.show.id).some((t) => t.trust === "chapters")) {
      const head = await headOf(cache, ctx.entry.path, ctx.duration, Math.min(headLimit(ctx.duration), ch.intro.end + CHAPTER_MARGIN_S + 5));
      learn(ctx, head, ch.intro, "chapters", CHAPTER_MARGIN_S);
    }
  } else {
    const a = await analyzeIntro(ctx, cache, { urgent });
    readable = !!a.head;
    head = a.head;
    compared = (a.comparisons || []).length;
    if (a.intro) {
      intro = { start: round2(a.intro.start), end: round2(a.intro.end) };
      introSource = "audio";
      support = a.intro.support;
      introTrusted = !!a.intro.trusted;
      if (a.via === "siblings") learn(ctx, a.head, a.intro, a.intro.support >= 2 ? "confirmed" : "pair");
    } else if (db && db.intro) {
      dbCheck = checkDbIntro(a.head, a.comparisons || [], db.intro);
    }
  }
  // a recap the databases name: is it the episode before, heard again?
  if (!urgent && db && db.recap) {
    if (!head) head = await headOf(cache, ctx.entry.path, ctx.duration);
    recapCheck = await checkRecap(ctx, cache, head, db.recap);
  }
  let credits = null;
  let creditsSource = null;
  let creditsDue = false;
  if (ch.credits) { credits = ch.credits; creditsSource = "chapters"; readable = true; }
  else if (introOnly) creditsDue = true;
  else {
    credits = await analyzeCredits(ctx, cache, { threads });
    if (credits) { creditsSource = "audio"; readable = true; }
    else if ((cache.get(ctx.entry.path) || {}).tail) readable = true;
  }
  if (!readable && !creditsDue) return null;
  return {
    intro,
    credits,
    source: introSource || creditsSource || "audio",
    introSource,
    creditsSource,
    ...(support ? { support } : {}),
    ...(introTrusted ? { introTrusted: true } : {}),
    ...(compared ? { compared } : {}),
    ...(dbCheck ? { dbCheck } : {}),
    ...(recapCheck ? { recapCheck } : {}),
    ...(creditsDue ? { creditsDue: true } : {}),
  };
};

// Bumped when the analysis itself changes, so every file is looked at again
// once. 2: credits start tightened to dense agreement and snapped to the
// picture — and records the DATABASE fill created no longer count as
// analysed (they carried the file's mtime, so the audio pass skipped them
// forever: an episode whose timestamps were fetched the moment it finished
// downloading never got its own Skip intro measured). 3: the intro from
// introprint.js (band-energy fingerprint, offsets by voting, sub-second
// edges, known intros per show, the show's other seasons), the credits the
// same way (and a scene after them), the databases' intro and recap checked
// against the sound.
// 4: a known intro keeps where in it the intro is, and a copy of the
// episode it was learned from is held to that; a copy of an episode (another
// name, the other version) is no sibling — the same file gives the same
// intro and credits, whoever it is compared with (an Avatar S1E4 copy had its
// intro end 10 s late, and the known intro grew with it). Known intros kept
// before this are learned again.
const ANALYSIS_V = 4;
let running = false;
let held = false; // waiting for a place behind a viewer encode (cpuwork.js)
let again = false;
let urgentRunning = false;
// (waiting for its turn behind a viewer's encode is not being busy: the
// watchdog must go on judging the event loop through an evening's viewing)
const busy = () => (running && !held) || urgentRunning;

// Store one analysis. Re-read first: the database fill and the credits
// picture may have written this record while the analysis ran — their
// answers ride along, never overwritten.
const write = (id, mtime, res) => {
  const now = store.data[id];
  const same = now && now.mtime === mtime ? now : null;
  if (!res) {
    const none = noneRecord(same, mtime);
    if (none) { store.data[id] = none; store.save(); }
    return;
  }
  store.data[id] = { mtime, at: Date.now(), v: ANALYSIS_V, ...res, ...(same && same.db ? { db: same.db } : {}), ...(same && same.cv ? { cv: same.cv } : {}) };
  store.save();
};

// One analysis per episode at a time, whoever asked: { id -> promise }.
const inflight = new Map();
const once = (id, fn) => {
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => { try { return await fn(); } finally { inflight.delete(id); } })();
  inflight.set(id, p);
  return p;
};

// Analyse one episode now and store it. `mode`: "full", "intro" (credits
// left for later), "credits" (a record whose credits were left for later).
// (An urgent read has its own place: somebody pressed Play on an episode the
// background pass happens to be reading at the lowest priority — the urgent
// one does not wait for that.)
const runEpisode = (ctx, cache, { urgent = false, mode = "full", threads = null } = {}) =>
  once(urgent ? `urgent:${ctx.ep.id}` : ctx.ep.id, async () => {
    const have = store.data[ctx.ep.id];
    if (mode === "credits") {
      if (!have || have.mtime !== ctx.mtime || !have.creditsDue) return;
      const credits = await analyzeCredits(ctx, cache, { threads });
      // (and the recap the databases name, now there is time for it)
      const db = have.db || null;
      const recapCheck = db && db.recap ? await checkRecap(ctx, cache, await headOf(cache, ctx.entry.path, ctx.duration), db.recap) : null;
      const now = store.data[ctx.ep.id];
      if (!now || now.mtime !== ctx.mtime) return;
      const { creditsDue, ...rest } = now;
      store.data[ctx.ep.id] = { ...rest, credits: credits || null, creditsSource: credits ? "audio" : null, source: rest.introSource || (credits ? "audio" : rest.source || "audio"), ...(recapCheck ? { recapCheck } : {}) };
      store.save();
      try { scoreSources(ctx, store.data[ctx.ep.id]); } catch {}
      return;
    }
    const res = await analyzeEpisode(ctx, cache, { urgent, introOnly: mode === "intro", threads });
    write(ctx.ep.id, ctx.mtime, res);
    try { scoreSources(ctx, store.data[ctx.ep.id]); } catch {}
  });

// ---------- the moment an episode needs it ----------
// Landed (a download finished, a scan found it): next in line for the
// background pass — still behind any viewer's encode, like all background
// work (cpuwork.js), but ahead of the whole-library rounds.
const soon = new Set();
const SOON_MAX = 200;
const landed = (episodeId) => {
  if (!episodeId) return;
  soon.delete(episodeId);
  soon.add(episodeId);
  while (soon.size > SOON_MAX) soon.delete(soon.values().next().value);
  if (config.ffmpegAvailable) setImmediate(run);
};
// Background episodes run side by side, as many as cpuwork lets intro
// detection have (cpuwork.background.introSlots: the cores less two, while
// nothing else runs and no viewer is being encoded for) — each its own
// helper process at the lowest priority (introprint-pool.js), so the
// server's own work never waits on them.
let waitingGate = 0;
let activeJobs = 0;
const gateIntro = async (label) => {
  waitingGate++;
  held = activeJobs === 0;
  try {
    return await cpuwork.background.gate("intro", { label });
  } finally {
    waitingGate--;
    activeJobs++;
    held = false;
  }
};
const releaseIntro = (place) => {
  activeJobs--;
  if (activeJobs === 0 && waitingGate > 0) held = true;
  try { place.release(); } catch {}
};
const slots = () => { try { return Math.max(1, cpuwork.background.introSlots()); } catch { return 1; } };
const sideBySide = async (items, fn) => {
  let i = 0;
  const lane = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(slots(), items.length) }, lane));
};
const modeFor = (have, mtime) => (have && have.creditsDue && have.mtime === mtime && have.v === ANALYSIS_V ? "credits" : "full");
const label = (ctx) => `${ctx.show.title} S${ctx.season.number}E${ctx.ep.episode}`;
const serveSoon = async () => {
  while (soon.size) {
    const ids = [...soon];
    soon.clear();
    const ctxs = [];
    for (const id of ids) {
      if (inflight.has(id)) continue;
      const ctx = await contextOf(id);
      if (ctx && analysisDue(store.data[id], ctx.mtime)) ctxs.push(ctx);
    }
    const cache = new Map();
    await sideBySide(ctxs, async (ctx) => {
      const place = await gateIntro(label(ctx));
      try {
        await runEpisode(ctx, cache, { mode: modeFor(store.data[ctx.ep.id], ctx.mtime) });
      } catch (e) {
        console.warn(`[intro] ${label(ctx)}: ${e && e.message ? e.message : e}`);
      } finally {
        releaseIntro(place);
      }
    });
  }
};

// Urgent (somebody pressed Play on an episode with no answer measured on
// it): at once, not behind the viewers — the viewer IS the reason — but
// bounded: one episode at a time, a short queue, its ffmpeg at the lowest
// priority on one thread, the intro first (the first five minutes against
// a known intro: seconds) and stored the moment it is known, then the
// credits. The player asks again while the answer says `pending`.
const urgentQ = [];
const URGENT_MAX = 4;
const URGENT_RETRY_MS = 30 * 60 * 1000; // one urgent try per file per half hour
const urgentTried = new Map(); // id -> { mtime, at }
const pumpUrgent = async () => {
  if (urgentRunning) return;
  urgentRunning = true;
  try {
    while (urgentQ.length) {
      const id = urgentQ[0];
      try {
        const ctx = await contextOf(id);
        if (ctx) {
          const cache = new Map();
          cache.urgent = true; // (its reads go to the front of the helpers' queue)
          const have = store.data[id];
          const label = `${ctx.show.title} S${ctx.season.number}E${ctx.ep.episode}`;
          const started = Date.now();
          if (analysisDue(have, ctx.mtime) && !(have && have.creditsDue && have.mtime === ctx.mtime && have.v === ANALYSIS_V)) {
            await runEpisode(ctx, cache, { urgent: true, mode: "intro", threads: 1 });
            const r = store.data[id];
            // (not "[intro] <episode>: …" — that shape is a failure to the healer, lib/healer-checks/logs.js)
            console.log(`[intro] read on Play — ${label} — ${r && r.intro ? `intro ${r.intro.start}–${r.intro.end} (${r.introSource})` : "no intro"} in ${Date.now() - started} ms`);
          }
          await runEpisode(ctx, cache, { mode: "credits", threads: 1 });
        }
      } catch (e) {
        console.warn(`[intro] urgent ${id}: ${e && e.message ? e.message : e}`);
      } finally {
        urgentQ.shift();
      }
    }
  } finally {
    urgentRunning = false;
  }
};
// Called by the player's question (/api/intro/auto/:id). True while an
// answer for this episode is being worked out (the player asks again).
const request = (episodeId) => {
  if (!config.ffmpegAvailable || !episodeId) return false;
  if (inflight.has(`urgent:${episodeId}`) || urgentQ.includes(episodeId)) return true;
  const entry = scanner.resolve(episodeId);
  if (!entry) return false;
  const mtime = mtimeOf(entry.path);
  const have = store.data[episodeId];
  if (!analysisDue(have, mtime)) return false;
  const tried = urgentTried.get(episodeId);
  // (tried already: still worth asking again while the background has it in hand)
  if (tried && tried.mtime === mtime && Date.now() - tried.at < URGENT_RETRY_MS) return inflight.has(episodeId);
  if (urgentQ.length >= URGENT_MAX) return inflight.has(episodeId);
  urgentTried.set(episodeId, { mtime, at: Date.now() });
  if (urgentTried.size > 500) urgentTried.delete(urgentTried.keys().next().value);
  urgentQ.push(episodeId);
  setImmediate(pumpUrgent);
  return true;
};

// ---------- the season pass ----------
const pass = async () => {
  let done = 0;
  const seen = new Set();
  // Shows with an episode that has NEVER been analysed go first: a download
  // that just landed gets its Skip intro within the minute, instead of
  // queueing behind a whole library being re-read for a new ANALYSIS_V.
  const shows = [];
  for (const show of scanner.index.shows) {
    let fresh = false;
    const eps = [];
    for (const season of show.seasons || []) {
      for (const ep of season.episodes || []) {
        if (scanner.resolve(ep.id)) seen.add(ep.id);
        eps.push({ season, ep });
        const have = store.data[ep.id];
        if (!have || !have.source || !have.v && !have.intro && !have.credits && have.source !== "audio" && have.source !== "chapters") fresh = true;
      }
    }
    if (eps.length) shows.push({ show, eps, fresh });
  }
  shows.sort((a, b) => (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0));
  for (const { show, eps } of shows) {
    await serveSoon();
    passCache = new Map(); // a show's fingerprints are only useful within it
    const due = [];
    for (const { season, ep } of eps) {
      const entry = scanner.resolve(ep.id);
      if (!entry) continue;
      const mtime = mtimeOf(entry.path);
      if (!analysisDue(store.data[ep.id], mtime) || inflight.has(ep.id)) continue;
      const meta = metadata.getCached(entry.path);
      if (!meta || !meta.duration) continue; // enrichment hasn't reached it yet
      due.push({ show, season, ep, entry, duration: meta.duration, mtime });
    }
    // Background work (cpuwork.js): each episode waits for its place — no
    // viewer encode running, none for a while — and its reads run at the
    // lowest priority. An episode already being read is let finish.
    const cache = passCache;
    await sideBySide(due, async (ctx) => {
      const place = await gateIntro(label(ctx));
      try {
        await runEpisode(ctx, cache, { mode: modeFor(store.data[ctx.ep.id], ctx.mtime) });
        done++;
      } catch (e) {
        console.warn(`[intro] ${label(ctx)}: ${e && e.message ? e.message : e}`);
      } finally {
        releaseIntro(place);
      }
    });
  }
  passCache = new Map();
  // entries for episodes that left the library go with them — but never
  // while a library folder cannot be read: an unplugged drive makes every
  // episode on it "gone", and their timestamps took hours to work out
  let pruned = 0;
  let rootAway = false;
  try { rootAway = require("../lib/libroots").missing().length > 0; } catch {}
  for (const id of rootAway ? [] : Object.keys(store.data)) {
    if (!seen.has(id) && !scanner.resolve(id)) { delete store.data[id]; pruned++; }
  }
  if (pruned) store.save();
  if (done) console.log(`[intro] analyzed ${done} episode(s) for intros and credits`);
};
// ---------- the picture's pass (creditscv.js) ----------
// Every library episode, a season of one included, gets its tail looked at
// once per file (and again when CV_V changes). Background work like the
// audio pass: a place from cpuwork.js (no viewer encode running, none for
// the quiet period), the decode at the lowest priority — and should a
// viewer encode start while the decode runs, it is STOPPED (on every OS:
// Windows cannot pause another process) and the episode tried again on a
// later pass. A result is only stored when the decode ran to the end.
//   1: names on nothing / a steady roll / a still card with a portrait / the
//      picture boxed beside the names; the max-credit segment; the black
//      (or empty background) that opens it.
const CV_V = 1;
const cvDue = (have, mtime, now = Date.now()) => {
  if (!have || have.mtime !== mtime || !have.cv || have.cv.v !== CV_V) return true;
  return !!have.cv.failed && now - (have.cv.at || 0) > NONE_RETRY_MS;
};
let cvAborts = 0;
const pictureOf = async (file, duration, label) => {
  const ref = { child: null, aborted: false };
  const stop = () => { ref.aborted = true; try { if (ref.child) ref.child.kill("SIGKILL"); } catch {} };
  held = true;
  const place = await cpuwork.background.gate("credits", { label, onShed: stop });
  held = false;
  const watch = setInterval(() => { if (cpuwork.viewer.busy()) stop(); }, 1000);
  watch.unref?.();
  try {
    if (cpuwork.viewer.busy()) return { aborted: true };
    const res = await creditscv.detect(file, duration, {
      ffmpeg: config.FFMPEG,
      threads: Math.min(2, cpuwork.background.threads()),
      onChild: (c) => { ref.child = c; place.attach(c); if (ref.aborted) stop(); },
    });
    if (ref.aborted) return { aborted: true };
    // a decode that did not run to the end by itself (an unreadable tail, a
    // time-out): no answer — noted, and tried again after NONE_RETRY_MS
    if (res && res.incomplete) return { failed: true };
    return { res };
  } finally {
    clearInterval(watch);
    place.release();
  }
};
const cvRecord = (res, now = Date.now(), failed = false) => res
  ? { v: CV_V, at: now, start: res.start, confidence: res.confidence, length: res.length }
  : { v: CV_V, at: now, start: null, confidence: 0, ...(failed ? { failed: true } : {}) };
const cvPass = async () => {
  const todo = [];
  for (const show of scanner.index.shows) {
    for (const season of show.seasons || []) {
      for (const ep of season.episodes || []) {
        const entry = scanner.resolve(ep.id);
        if (!entry) continue;
        const mtime = mtimeOf(entry.path);
        const have = store.data[ep.id];
        if (!cvDue(have, mtime)) continue;
        // a chapter titled "Credits" is the answer already (chooseCredits)
        if (have && have.mtime === mtime && have.source === "chapters" && have.credits) continue;
        const meta = metadata.getCached(entry.path);
        if (!meta || !meta.duration) continue;
        // episodes nobody has a credits time for go first
        const known = have && have.mtime === mtime && (have.credits || (have.db && have.db.credits));
        todo.push({ show, season, ep, entry, mtime, duration: meta.duration, known: !!known });
      }
    }
  }
  todo.sort((a, b) => (a.known ? 1 : 0) - (b.known ? 1 : 0));
  let done = 0;
  for (const t of todo) {
    await serveSoon(); // an episode that just landed does not wait for the whole library's picture
    const label = `${t.show.title} S${t.season.number}E${t.ep.episode} (credits picture)`;
    let out;
    try {
      out = await pictureOf(t.entry.path, t.duration, label);
    } catch (e) {
      console.warn(`[intro] ${t.show.title} S${t.season.number}E${t.ep.episode}: ${e && e.message ? e.message : e}`);
      continue;
    }
    if (out.aborted) { cvAborts++; continue; } // a viewer came: next pass
    // re-read: the audio pass or the database fill may have written meanwhile
    const now = store.data[t.ep.id];
    const base = now && now.mtime === t.mtime ? now : { mtime: t.mtime, at: Date.now(), intro: null, credits: null, source: null };
    // (a failed read never replaces an answer this file already has)
    if (out.failed && base.cv && base.cv.v === CV_V && base.cv.start != null) continue;
    store.data[t.ep.id] = { ...base, cv: cvRecord(out.res || null, Date.now(), !!out.failed) };
    store.save();
    done++;
    await new Promise((r) => setImmediate(r));
  }
  if (done) console.log(`[intro] looked at the credits picture of ${done} episode(s)`);
};

// ---------- which credits time the player gets ----------
// Every source, with how far it is trusted:
//   chapters  a chapter the release titled "Credits" — the author's own
//             answer, always first;
//   picture   creditscv.js on this very file, with a confidence;
//   audio     the end theme this episode shares with its season;
//   database  SkipDB / TheIntroDB, crowd-sourced, for this runtime.
// The picture is measured to the half second on THIS file, so when it agrees
// with another source (within AGREE_S) its time is the one used; when it is
// sure (CV_SURE) it beats an audio or database time that disagrees — those
// are the cases it exists for: an end theme that starts under the last
// scene, a crowd timestamp from another cut. A picture answer nothing
// confirms and nothing contradicts is used from CV_ALONE.
const CV_SURE = 0.6;
const CV_ALONE = 0.5;
const CV_AGREE_MIN = 0.3;
const AGREE_S = 8;
const chooseCredits = (r, trust = {}) => {
  if (!r) return null;
  // (a database that has been right here first; one that has been WRONG
  // here — another cut, Avatar's credits 45-90 s late — not at all)
  const tc = trustedSource(trust, r.db && r.db.each, "credits");
  const wrongHere = (name) => { const t = trust[`${name}:credits`]; return !!t && t.n >= TRUST_MIN && t.ok / t.n < 0.5; };
  const named = String((r.db && r.db.source) || "").split("+").filter(Boolean);
  const dbc = tc
    ? { start: tc.said.start, end: Number.isFinite(tc.said.end) ? tc.said.end : null, source: tc.name }
    : r.db && r.db.credits && Number.isFinite(r.db.credits.start) && !(named.length && named.every(wrongHere))
      ? { start: r.db.credits.start, end: Number.isFinite(r.db.credits.end) ? r.db.credits.end : null, source: r.db.source || "database" }
      : null;
  // (where the credits came from: creditsSource since analysis 3, source before)
  const ownSource = r.creditsSource || r.source || "audio";
  const own = r.credits && Number.isFinite(r.credits.start)
    ? { start: r.credits.start, end: Number.isFinite(r.credits.end) ? r.credits.end : null, source: ownSource, ...(r.credits.scene ? { scene: true } : {}) }
    : null;
  if (own && ownSource === "chapters") return own;
  const cv = r.cv && Number.isFinite(r.cv.start) ? r.cv : null;
  const others = [own, dbc].filter(Boolean);
  if (cv) {
    const near = others.find((o) => Math.abs(o.start - cv.start) <= AGREE_S);
    if (near && cv.confidence >= CV_AGREE_MIN) return { start: cv.start, end: near.end, source: `picture+${near.source}`, ...(near.scene ? { scene: true } : {}) };
    if (cv.confidence >= CV_SURE) return { start: cv.start, end: null, source: "picture" };
    if (!others.length && cv.confidence >= CV_ALONE) return { start: cv.start, end: null, source: "picture" };
  }
  return own || dbc || null;
};

// ---------- which database to trust, per show ----------
// Every episode whose intro (or credits) we measured ourselves, surely,
// scores each database that answered for it: right (start and end within
// TRUST_S of ours) or not. Kept per show beside its known intros. An episode
// we could not measure (a premiere whose intro is its own, a lone episode)
// then takes the answer of the database that has been right here — not
// whichever the merge happened to prefer (Avatar: The Last Airbender S1E1:
// SkipDB put the intro on a scene four minutes in; IntroDB had it right, as
// it had for E2–E6).
const TRUST_S = 3;
const TRUST_MIN = 2; // episodes scored
const TRUST_RATE = 0.75;
const trustOf = (showId) => (prints.data[showId] && prints.data[showId].dbTrust) || {};
const scoreSources = (ctx, rec) => {
  const each = rec && rec.db && rec.db.each;
  if (!each || !ctx.show || !ctx.show.id) return;
  const sure = (x) => x && Number.isFinite(x.start);
  const own = {
    intro: sure(rec.intro) && (rec.introSource === "chapters" || (rec.support || 0) >= 2 || rec.introTrusted) ? rec.intro : null,
    credits: sure(rec.credits) && rec.creditsSource ? rec.credits : null,
  };
  const book = { ...(trustOf(ctx.show.id)) };
  let changed = false;
  for (const kind of ["intro", "credits"]) {
    if (!own[kind]) continue;
    for (const [src, said] of Object.entries(each)) {
      const x = said && said[kind];
      if (!sure(x)) continue;
      const key = `${src}:${kind}`;
      const ok = Math.abs(x.start - own[kind].start) <= TRUST_S && (kind === "credits" || !Number.isFinite(x.end) || !Number.isFinite(own[kind].end) || Math.abs(x.end - own[kind].end) <= TRUST_S);
      const seen = { ...(book[key] || { n: 0, ok: 0, eps: [] }) };
      if ((seen.eps || []).includes(ctx.ep.id)) continue; // (once per episode)
      seen.n++;
      if (ok) seen.ok++;
      seen.eps = [...(seen.eps || []), ctx.ep.id].slice(-50);
      book[key] = seen;
      changed = true;
    }
  }
  if (!changed) return;
  prints.data[ctx.show.id] = { ...(prints.data[ctx.show.id] || { prints: [] }), dbTrust: book };
  prints.save();
};
// The database that has been right in this show for `kind`, with its answer
// for this episode: { name, said, n, ok } or null.
const trustedSource = (trust, each, kind) => {
  let best = null;
  for (const [src, said] of Object.entries(each || {})) {
    const x = said && said[kind];
    if (!x || !Number.isFinite(x.start)) continue;
    const t = trust[`${src}:${kind}`];
    if (!t || t.n < TRUST_MIN || t.ok / t.n < TRUST_RATE) continue;
    if (!best || t.ok / t.n > best.ok / best.n || (t.ok / t.n === best.ok / best.n && t.n > best.n)) best = { name: src, said: x, n: t.n, ok: t.ok };
  }
  return best;
};

// ---------- which intro the player gets ----------
//   chapters / our own audio answer, when it is sure (two comparisons or a
//            known intro agreed — or an analysis older than 3, as before);
//   our own lone answer (one comparison), unless the databases say otherwise;
//   the databases' answer, when we have none — as heard in this file's sound
//            when it was checked (checkDbIntro), never when it was not heard
//            although there was something to compare with.
// -> { start, end, source } or null
const SAME_INTRO_S = 3;
const sameAs = (chk, x) => chk && chk.intro && x && Math.abs(chk.intro.start - x.start) < 0.05 && Math.abs(chk.intro.end - x.end) < 0.05;
const chooseIntro = (r, trust = {}) => {
  if (!r) return null;
  const db = r.db && r.db.intro && Number.isFinite(r.db.intro.start) && Number.isFinite(r.db.intro.end) && r.db.intro.end > r.db.intro.start ? r.db.intro : null;
  const own = r.intro && Number.isFinite(r.intro.start) && Number.isFinite(r.intro.end) ? r.intro : null;
  const ownSource = r.introSource || r.source || "audio";
  if (own) {
    const agrees = db && Math.abs(own.start - db.start) <= SAME_INTRO_S;
    const sure = ownSource === "chapters" || !(r.v >= 3) || (r.support || 0) >= 2 || !!r.introTrusted;
    if (sure || !db || agrees) return { start: own.start, end: own.end, source: agrees ? `${ownSource}+database` : ownSource };
    const t = trustedSource(trust, r.db.each, "intro");
    if (t && Number.isFinite(t.said.end) && Math.abs(t.said.start - own.start) <= SAME_INTRO_S) return { start: own.start, end: own.end, source: `${ownSource}+${t.name}` };
    return { start: db.start, end: db.end, source: "database (over a single comparison)" };
  }
  if (!db && !(r.db && r.db.each)) return null;
  const chk = db && sameAs(r.dbCheck, db) ? r.dbCheck : null;
  if (chk && chk.verdict === "heard" && chk.fixed) return { start: chk.fixed.start, end: chk.fixed.end, source: "database, heard here" };
  // a database that has been right in this show: its answer
  const t = trustedSource(trust, r.db && r.db.each, "intro");
  if (t && Number.isFinite(t.said.end) && t.said.end > t.said.start) return { start: t.said.start, end: t.said.end, source: `${t.name} (right on ${t.ok} of ${t.n} here)` };
  if (!db) return null;
  if (chk && chk.verdict === "not heard") return null;
  return { start: db.start, end: db.end, source: "database" };
};
// How far the databases' cut is from this file: our own (sure) intro minus
// theirs, when the two are plainly the same intro moved (same length within
// 4 s, at most 90 s apart). 0 when there is nothing to tell.
const dbShift = (r) => {
  if (!r || !r.intro || !r.db || !r.db.intro) return 0;
  const own = r.intro;
  const db = r.db.intro;
  if (!Number.isFinite(db.start) || !Number.isFinite(db.end) || !Number.isFinite(own.start) || !Number.isFinite(own.end)) return 0;
  const d = own.start - db.start;
  if (Math.abs(d) <= SAME_INTRO_S || Math.abs(d) > 90) return 0;
  if (Math.abs((own.end - own.start) - (db.end - db.start)) > 4) return 0;
  return round2(d);
};
// Which recap the player gets: heard in this file's sound (checkRecap), or —
// when it could not be checked — the strict rules (recaprules.js).
// -> { recap, source } or null
const chooseRecap = (r, episodeId, intro) => {
  const rc = r && r.db && r.db.recap;
  if (!rc || !Number.isFinite(rc.start) || !Number.isFinite(rc.end) || rc.end <= rc.start) return null;
  const at = locate(episodeId);
  const who = { season: at ? (at.ep.season != null ? at.ep.season : at.season.number) : null, episode: at ? at.ep.episode : null, intro };
  const chk = r.recapCheck && r.recapCheck.recap && Math.abs(r.recapCheck.recap.start - rc.start) < 0.05 && Math.abs(r.recapCheck.recap.end - rc.end) < 0.05 ? r.recapCheck : null;
  if (!recaprules.plausibleRecap(rc, who)) return null;
  if (chk && chk.verdict === "heard") return { recap: rc, source: "database, heard here" };
  if (chk && chk.verdict === "not heard") return null;
  return recaprules.trustRecap(rc, { ...who, agreed: !!(r.db.agreed && r.db.agreed.recap) }) ? { recap: rc, source: "databases (both)" } : null;
};

// ---------- the databases' turn ----------
// Two cadences:
//   * after every scan, episodes the databases have NEVER been asked about
//     (a new show, a new download, a changed file) — bounded per pass so a
//     big new library fills in over a few passes, not a thousand requests
//     at once;
//   * once a day (refreshFromDatabases, run by lib/daily.js), EVERY library
//     episode whose answer is over a day old is asked again — empty answers
//     first, since a brand-new episode usually has no timestamps on air day
//     and gains them over the following days. That is what keeps Skip intro,
//     Skip recap and the credits-timed Up next current.
// A re-ask that reaches neither database keeps the answer already on file.
const DB_PER_PASS = 150;
const DB_FRESH_MS = 20 * 3600 * 1000; // under a day, so the daily round always finds yesterday's answers due

const dbRecord = (res) => ({ at: Date.now(), intro: res.intro, recap: res.recap, credits: res.credits, preview: res.preview, source: res.source, ...(res.agreed ? { agreed: res.agreed } : {}), ...(res.each ? { each: res.each } : {}) });
// A new database answer for an episode already analysed: what it says is
// checked against the sound again (checkDbIntro / checkRecap) on the next pass.
const dbChanged = (rec, db) => {
  if (!rec || rec.v !== ANALYSIS_V || rec.none) return rec;
  const was = rec.db || {};
  const moved = (a, b) => JSON.stringify(a || null) !== JSON.stringify(b || null);
  return moved(was.intro, db.intro) || moved(was.recap, db.recap) ? { ...rec, checkDue: true } : rec;
};

// Every library episode that can be asked about, with what's on file for it.
const askable = () => {
  const out = [];
  for (const show of scanner.index.shows) {
    if (!show.imdbId) continue;
    for (const season of show.seasons || []) {
      for (const ep of season.episodes || []) {
        const entry = scanner.resolve(ep.id);
        if (!entry) continue;
        const seasonNo = ep.season != null ? ep.season : season.number;
        if (!seasonNo || !ep.episode) continue;
        const mtime = mtimeOf(entry.path);
        const rec = store.data[ep.id];
        const known = rec && rec.mtime === mtime ? rec : null; // a changed file starts over
        out.push({ show, ep, entry, seasonNo, mtime, known });
      }
    }
  }
  return out;
};

const askOne = async (skipsegments, { show, ep, entry, seasonNo, mtime }, force) => {
  const meta = metadata.getCached(entry.path);
  const duration = (meta && meta.duration) || 0;
  const res = await skipsegments.lookup({ imdbId: show.imdbId, season: seasonNo, episode: ep.episode, duration }, { force });
  // re-read: the audio pass may have written this record meanwhile
  const rec = store.data[ep.id];
  const known = rec && rec.mtime === mtime ? rec : null;
  if (res.failed) return { reached: false, known };
  const db = dbRecord(res);
  const before = known && known.db ? JSON.stringify({ ...known.db, at: 0 }) : null;
  // a season of one episode never got a record from the audio pass
  store.data[ep.id] = known ? { ...dbChanged(known, db), db } : { mtime, at: Date.now(), intro: null, credits: null, source: null, db };
  return { reached: true, found: !!res.source, changed: before !== JSON.stringify({ ...db, at: 0 }) };
};

const fillFromDatabases = async () => {
  const skipsegments = require("./skipsegments");
  if (!skipsegments.enabled()) return;
  try { require("./identity").ensureStamped(); } catch {}
  let asked = 0;
  let found = 0;
  for (const t of askable()) {
    if (asked >= DB_PER_PASS) break;
    if (t.known && t.known.db) continue; // on file — the daily round keeps it current
    asked++;
    const r = await askOne(skipsegments, t, false);
    if (r.found) found++;
    if (asked % 20 === 0) store.save();
    await new Promise((r) => setImmediate(r));
  }
  if (asked) {
    store.save();
    console.log(`[intro] asked the public databases about ${asked} new episode(s), ${found} had timestamps`);
  }
};

const refreshFromDatabases = async () => {
  const skipsegments = require("./skipsegments");
  if (!skipsegments.enabled()) return "off (skipDatabases: false)";
  try { require("./identity").ensureStamped(); } catch {}
  const now = Date.now();
  const noAnswer = (t) => !(t.known && t.known.db && t.known.db.source);
  const due = askable()
    .filter((t) => !(t.known && t.known.db) || now - (t.known.db.at || 0) >= DB_FRESH_MS)
    .sort((x, y) => (noAnswer(y) - noAnswer(x)) || ((x.known && x.known.db && x.known.db.at) || 0) - ((y.known && y.known.db && y.known.db.at) || 0));
  let asked = 0, found = 0, changed = 0, unreached = 0;
  for (const t of due) {
    const r = await askOne(skipsegments, t, true);
    asked++;
    if (!r.reached) {
      // both databases down: stop rather than walk the whole library
      // failing — tomorrow's round (or the hourly retry) picks it up
      if (++unreached >= 10 && unreached === asked) throw new Error("the skip databases are unreachable");
      continue;
    }
    if (r.found) found++;
    if (r.changed) changed++;
    if (asked % 20 === 0) store.save();
    await new Promise((r) => setImmediate(r));
  }
  store.save();
  const streamed = await skipsegments.refreshRecent();
  return { library: { asked, withTimestamps: found, changed, unreached }, streamed };
};

// One episode, right now — called the moment a download lands in the library
// (media/downloads.js), so its intro / recap / credits are on file before
// anyone presses Play instead of waiting for its turn in the bounded
// background fill. From then on the daily round keeps it current. Playback
// never triggers a request for a library episode — the player reads this
// record (/api/intro/auto/:id).
const fillEpisode = async (episodeId) => {
  const skipsegments = require("./skipsegments");
  if (!skipsegments.enabled()) return null;
  try { require("./identity").ensureStamped(); } catch {}
  for (const show of scanner.index.shows) {
    for (const season of show.seasons || []) {
      const ep = (season.episodes || []).find((e) => e.id === episodeId);
      if (!ep) continue;
      if (!show.imdbId) return null;
      const entry = scanner.resolve(ep.id);
      if (!entry) return null;
      const meta = metadata.getCached(entry.path);
      const seasonNo = ep.season != null ? ep.season : season.number;
      if (!seasonNo || !ep.episode) return null;
      const res = await skipsegments.lookup({
        imdbId: show.imdbId,
        season: seasonNo,
        episode: ep.episode,
        duration: (meta && meta.duration) || 0,
      });
      const mtime = mtimeOf(entry.path);
      const rec = store.data[ep.id];
      if (res.failed) return null; // unreachable: the next scan's fill asks again
      const db = dbRecord(res);
      store.data[ep.id] = rec && rec.mtime === mtime ? { ...dbChanged(rec, db), db } : { mtime, at: Date.now(), intro: null, credits: null, source: null, db };
      store.save();
      if (res.source) console.log(`[intro] ${show.title} S${seasonNo}E${ep.episode}: timestamps on file from ${res.source}`);
      return db;
    }
  }
  return null;
};

const run = async () => {
  if (running) { again = true; return; }
  running = true;
  mtimeMemo = new Map();
  try {
    do {
      again = false;
      mtimeMemo = new Map(); // (each time round reads the disk afresh)
      // the audio pass needs ffmpeg; the databases need only the internet
      if (config.ffmpegAvailable) { await serveSoon(); await pass(); }
      await fillFromDatabases();
      // the picture last: the heaviest of the three, and the databases'
      // answers decide which episodes it looks at first
      if (config.ffmpegAvailable) await cvPass();
    } while (again);
  } catch (e) {
    console.warn("[intro] pass failed:", e && e.message ? e.message : e);
  } finally {
    running = false;
    mtimeMemo = null;
  }
};

// What the player asks for: the automatic answer for one episode, or nulls.
// The file's own detection first; the databases under it, segment by segment
// (and recap / preview, which only they can know). `sources` says where each
// came from, for the admin and for anyone debugging a wrong button.
const get = (episodeId) => {
  let r = store.data[episodeId];
  if (!r) return { intro: null, credits: null, recap: null, preview: null, source: null };
  // Measured on a file that has since changed (replaced outside replace.js,
  // a better copy landed over it): the old intro and credits are another
  // file's — only the databases' answers, which are by identity, still hold.
  // (The file is read again: request() below, or the next pass.)
  if (r.mtime) {
    const entry = scanner.resolve(episodeId);
    const now = entry ? mtimeOf(entry.path) : 0;
    if (now && now !== r.mtime) r = { db: r.db };
  }
  const db = r.db || {};
  const at = locate(episodeId);
  const trust = at && at.show ? trustOf(at.show.id) : {};
  const introPick = chooseIntro(r, trust);
  const intro = introPick ? { start: introPick.start, end: introPick.end } : null;
  const pick = chooseCredits(r, trust);
  const credits = pick ? { start: pick.start, end: pick.end || null, ...(pick.scene ? { scene: true } : {}) } : null;
  // The databases' times are for SOME cut: when our own intro and theirs are
  // the same intro at another place, their recap and preview move with it.
  const shift = dbShift(r);
  const moved = (x) => (x && shift ? { start: round2(x.start + shift), end: round2(x.end + shift) } : x || null);
  const recapPick = chooseRecap(r, episodeId, intro);
  return {
    intro,
    credits,
    recap: recapPick ? moved(recapPick.recap) : null,
    preview: moved(db.preview),
    source: r.intro || r.credits ? r.source || null : db.source || r.source || (pick ? pick.source : null),
    sources: {
      intro: introPick ? introPick.source : null,
      credits: pick ? pick.source : null,
      recap: recapPick ? recapPick.source : db.recap ? `not shown (${recapPick === null && r.recapCheck ? r.recapCheck.verdict : "not trusted"})` : null,
      ...(shift ? { shifted: shift } : {}),
    },
  };
};

// (a probe pass that found nothing new has nothing for this pass either: the
// scan that preceded it already asked for one, below)
scanner.events.on("enriched", (info) => {
  if (!scanner.enrichedChanged(info)) return;
  // episodes nobody has looked at yet are next in line, even while a
  // whole-library round (the credits picture) is under way
  try {
    for (const show of scanner.index.shows || []) {
      for (const season of show.seasons || []) {
        for (const ep of season.episodes || []) if (!store.data[ep.id] && scanner.resolve(ep.id) && soon.size < SOON_MAX) soon.add(ep.id);
      }
    }
  } catch {}
  setTimeout(run, 5000);
});
// Without ffmpeg there is no enrichment (and so no "enriched") — the database
// fill still has work to do, so a scan wakes it too. Debounced: scans come in
// bursts, and a pass with nothing new to ask is a walk over cached records.
let scanKick = null;
scanner.events.on("scanned", () => {
  clearTimeout(scanKick);
  scanKick = setTimeout(run, 30000);
  scanKick.unref?.();
});

// For the admin's analytics: how much of the library the detector has
// covered, and how much it found. The denominator is every library episode
// (a season of one is compared with the show's other seasons and its known
// intros since analysis 3); "analyzed" is every episode it has looked at,
// found or not.
const coverage = () => {
  let episodes = 0;
  const ids = new Set();
  for (const s of scanner.index.shows || []) {
    for (const season of s.seasons || []) {
      for (const ep of season.episodes || []) { episodes++; ids.add(ep.id); }
    }
  }
  let analyzed = 0, intro = 0, credits = 0, chapters = 0, fromDb = 0, recaps = 0, picture = 0;
  for (const [id, r] of Object.entries(store.data)) {
    if (!ids.has(id)) continue;
    analyzed++;
    const db = r.db || {};
    if (r.intro || db.intro) intro++;
    if (chooseCredits(r)) credits++;
    if (r.cv && r.cv.start != null) picture++;
    if (r.source === "chapters") chapters++;
    if ((!r.intro && db.intro) || (!r.credits && db.credits)) fromDb++;
    if (db.recap) recaps++;
  }
  let known = 0;
  for (const v of Object.values(prints.data)) known += (v && Array.isArray(v.prints) ? v.prints.length : 0);
  return { episodes, analyzed, intro, credits, chapters, fromDb, recaps, picture, knownIntros: known };
};

// A file replaced under the same library id (media/replace.js): what was
// measured on the old file is not the new one's — measured afresh.
const forget = (episodeId) => {
  if (!episodeId || !store.data[episodeId]) return false;
  delete store.data[episodeId];
  store.save();
  return true;
};

module.exports = { run, get, forget, coverage, busy, fillEpisode, refreshFromDatabases, request, landed, _internals: { comparisonOf, matchesOf, copyOf, cardFrames, refineCreditsByCard, findCard, refineCreditsByPicture, scoreSources, trustedSource, trustOf, creditsFrom, recapVerdict, CREDITS_MIN_S, chooseIntro, chooseRecap, dbShift, checkDbIntro, checkRecap, analyzeCredits, dbChanged, previousOf, mergePrints, sliceFor, orderSiblings, RANK, HEAD_FIRST_S, analyzeIntro, analyzeEpisode, siblingsOf, knownIntros, learn, introFrom, write, runEpisode, contextOf, pumpUrgent, urgentQ, soon, store, prints, headLimit, INTRO_MIN_S, INTRO_LONE_MIN_S, INTRO_MAX_S, PRINT_MARGIN_S, fingerprint, fingerprintAsync, longestRun, consensus, fromChapters, similar, tightenStart, parseBlackdetect, snapToBlack, INVALID, FRAME, HOP, SR, ANALYSIS_V, analysisDue, noneRecord, NONE_RETRY_MS, mtimeOf, chooseCredits, cvDue, cvRecord, CV_V, CV_SURE, CV_ALONE, AGREE_S, cvAborts: () => cvAborts, mtimeMemoFor: (fn) => { mtimeMemo = new Map(); try { return fn(); } finally { mtimeMemo = null; } } } };
