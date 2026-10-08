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
// The synchronous core (tests drive it directly); analyze() uses the
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
const blackSegments = (file, from, length) =>
  new Promise((resolve) => {
    const args = [
      "-hide_banner", "-nostats", "-nostdin", "-v", "info",
      "-ss", String(Math.max(0, from)), "-i", file, "-t", String(length),
      "-an", "-sn",
      // a thumbnail-sized picture at 5 fps is all the detector needs
      "-vf", "fps=5,scale=160:-2,blackdetect=d=0.3:pic_th=0.92:pix_th=0.12",
      "-f", "null", "-",
    ];
    execFile(config.FFMPEG, args, { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 90000 }, (err, stdout, stderr) => {
      resolve(parseBlackdetect(stderr));
    });
  });
const refineCreditsByPicture = async (file, start, duration) => {
  try {
    const from = Math.max(0, start - 2);
    const length = Math.min(CREDITS_SNAP_S + 6, Math.max(4, duration - from));
    const segs = await blackSegments(file, from, length);
    const snapped = snapToBlack(segs, start - from);
    return snapped == null ? null : Math.min(duration - 5, from + snapped);
  } catch {
    return null;
  }
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
    head: head && head.length > FRAME ? await fingerprintAsync(head) : null,
    tail: tail && tail.length > FRAME ? await fingerprintAsync(tail) : null,
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
  const ch = fromChapters(await chaptersOf(entry.path), duration);
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
      const r = tightenStart(me.tail, o.tail, longestRun(me.tail, o.tail, secToFrames(120)), secToFrames(CREDITS_MIN_S));
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
  // the picture gets the last word on WHEN the credits begin (later only)
  let creditsStart = credits ? credits.start : null;
  let snapped = false;
  if (credits) {
    const byPicture = await refineCreditsByPicture(entry.path, credits.start, duration);
    if (byPicture != null && byPicture > creditsStart) { creditsStart = byPicture; snapped = true; }
  }
  return {
    intro: intro ? { start: Math.round(intro.start * 10) / 10, end: Math.round(intro.end * 10) / 10 } : null,
    credits: credits ? { start: Math.round(creditsStart * 10) / 10, ...(snapped ? { snapped: true } : {}) } : null,
    source: "audio",
  };
};

// Bumped when the analysis itself changes, so every file is looked at again
// once. 2: credits start tightened to dense agreement and snapped to the
// picture — and records the DATABASE fill created no longer count as
// analysed (they carried the file's mtime, so the audio pass skipped them
// forever: an episode whose timestamps were fetched the moment it finished
// downloading never got its own Skip intro measured).
const ANALYSIS_V = 2;
let running = false;
let again = false;
const busy = () => running;
const pass = async () => {
  let done = 0;
  const seen = new Set();
  // Seasons with an episode that has NEVER been analysed go first: a download
  // that just landed gets its Skip intro within the minute, instead of
  // queueing behind a whole library being re-read for a new ANALYSIS_V.
  const seasons = [];
  for (const show of scanner.index.shows) {
    for (const season of show.seasons || []) {
      const eps = season.episodes || [];
      for (const ep of eps) if (scanner.resolve(ep.id)) seen.add(ep.id);
      if (eps.length < 2) continue;
      const fresh = eps.some((ep) => {
        const have = store.data[ep.id];
        return !have || !have.source || !have.v && !have.intro && !have.credits && have.source !== "audio" && have.source !== "chapters";
      });
      seasons.push({ show, season, eps, fresh });
    }
  }
  seasons.sort((a, b) => (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0));
  for (const { show, season, eps } of seasons) {
    for (const ep of eps) {
      const entry = scanner.resolve(ep.id);
      if (!entry) continue;
      const mtime = mtimeOf(entry.path);
      const have = store.data[ep.id];
      if (have && have.mtime === mtime && have.v === ANALYSIS_V) continue;
      const meta = metadata.getCached(entry.path);
      if (!meta || !meta.duration) continue; // enrichment hasn't reached it yet
      try {
        const res = await analyze(ep, eps.filter((e) => e.id !== ep.id));
        if (!res) continue;
        // re-read: the database fill may have written this record while
        // the analysis ran — its answer rides along, never overwritten
        const now = store.data[ep.id];
        const db = now && now.mtime === mtime && now.db ? { db: now.db } : {};
        store.data[ep.id] = { mtime, at: Date.now(), v: ANALYSIS_V, ...res, ...db };
        store.save();
        done++;
      } catch (e) {
        console.warn(`[intro] ${show.title} S${season.number}E${ep.episode}: ${e && e.message ? e.message : e}`);
      }
      await new Promise((r) => setImmediate(r));
    }
    fpCache.clear(); // a season's fingerprints are only useful within it
  }
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

const dbRecord = (res) => ({ at: Date.now(), intro: res.intro, recap: res.recap, credits: res.credits, preview: res.preview, source: res.source });

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
  store.data[ep.id] = known ? { ...known, db } : { mtime, at: Date.now(), intro: null, credits: null, source: null, db };
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
      store.data[ep.id] = rec && rec.mtime === mtime ? { ...rec, db } : { mtime, at: Date.now(), intro: null, credits: null, source: null, db };
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
  try {
    do {
      again = false;
      // the audio pass needs ffmpeg; the databases need only the internet
      if (config.ffmpegAvailable) await pass();
      await fillFromDatabases();
    } while (again);
  } catch (e) {
    console.warn("[intro] pass failed:", e && e.message ? e.message : e);
  } finally {
    running = false;
  }
};

// What the player asks for: the automatic answer for one episode, or nulls.
// The file's own detection first; the databases under it, segment by segment
// (and recap / preview, which only they can know). `sources` says where each
// came from, for the admin and for anyone debugging a wrong button.
const get = (episodeId) => {
  const r = store.data[episodeId];
  if (!r) return { intro: null, credits: null, recap: null, preview: null, source: null };
  const db = r.db || {};
  const intro = r.intro || db.intro || null;
  const credits = r.credits || (db.credits ? { start: db.credits.start, end: db.credits.end || null } : null);
  return {
    intro,
    credits,
    recap: db.recap || null,
    preview: db.preview || null,
    source: r.intro || r.credits ? r.source || null : db.source || r.source || null,
    sources: {
      intro: r.intro ? r.source : db.intro ? db.source : null,
      credits: r.credits ? r.source : db.credits ? db.source : null,
    },
  };
};

scanner.events.on("enriched", () => setTimeout(run, 5000));
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
// covered, and how much it found. The denominator is what the pass would
// consider (episodes in seasons of two or more); "analyzed" is every episode
// it has looked at, found or not.
const coverage = () => {
  let episodes = 0;
  const ids = new Set();
  for (const s of scanner.index.shows || []) {
    for (const season of s.seasons || []) {
      if ((season.episodes || []).length < 2) continue;
      for (const ep of season.episodes) { episodes++; ids.add(ep.id); }
    }
  }
  let analyzed = 0, intro = 0, credits = 0, chapters = 0, fromDb = 0, recaps = 0;
  for (const [id, r] of Object.entries(store.data)) {
    if (!ids.has(id)) continue;
    analyzed++;
    const db = r.db || {};
    if (r.intro || db.intro) intro++;
    if (r.credits || db.credits) credits++;
    if (r.source === "chapters") chapters++;
    if ((!r.intro && db.intro) || (!r.credits && db.credits)) fromDb++;
    if (db.recap) recaps++;
  }
  return { episodes, analyzed, intro, credits, chapters, fromDb, recaps };
};

module.exports = { run, get, coverage, busy, fillEpisode, refreshFromDatabases, _internals: { fingerprint, fingerprintAsync, longestRun, consensus, fromChapters, similar, tightenStart, parseBlackdetect, snapToBlack, INVALID, FRAME, HOP, SR, ANALYSIS_V } };
