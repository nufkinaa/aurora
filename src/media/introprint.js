// The intro's own fingerprint and matcher (introdetect.js runs it).
//
// Why a second fingerprint: the first one (introdetect's, 16 single
// frequencies per 128 ms) agrees on only 10-65 % of the frames of two copies
// of the SAME theme — measured on this house's library: Silo's intro, whose
// waveforms correlate at 0.93-0.99, matched in pieces of 10-73 s out of 109;
// Ted's 21-second song, waveforms at 0.9, in pieces of 2-8 s. A run broke at
// every soft passage, so the button came 35 s into Silo's titles (S03E04) or
// never (most of Silo, all of Ted season 1, every short title card).
//
// This one is the classic band-energy fingerprint (Haitsma & Kalker): the
// energy of 33 log-spaced bands, 250 Hz-3 kHz, over 256 ms windows every
// 64 ms; bit m of frame n says whether the step between bands m and m+1
// grew or shrank since the frame before. Two copies of one recording differ
// in 5-25 % of the bits; unrelated audio in 50 %, and so does steady noise or
// room tone — quiet passages cannot fake a match. Near-silence is marked
// invalid and counts for nothing either way.
//
// Matching: every 16-bit half of every frame votes for the offset at which it
// meets the same half in the other file, so the alignment is found at any
// distance (a cold open of one minute in one episode and nine in another) in
// a few milliseconds, instead of a search limited to +-3 minutes. At the best
// offsets the shared stretch is where the bit error rate, over a 2-second
// window, stays low; its edges are then placed from half-second windows, to
// about a tenth of a second.
"use strict";

const SR = 8000;
const N = 2048; // 256 ms window
const HOP = 512; // 64 ms step
const NB = 33; // bands -> 32 bits
const F0 = 250;
const F1 = 3000;
const FLOOR = 3e8; // band power of a sine at about -60 dBFS: below it, nothing to say

// ---------- a real FFT of N samples, as one complex FFT of N/2 ----------
const M = N / 2;
const LOG2M = Math.log2(M);
const REV = new Uint32Array(M);
for (let i = 0; i < M; i++) {
  let r = 0;
  for (let k = 0, x = i; k < LOG2M; k++, x >>= 1) r = (r << 1) | (x & 1);
  REV[i] = r;
}
const COS = new Float64Array(M / 2);
const SIN = new Float64Array(M / 2);
for (let i = 0; i < M / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / M); SIN[i] = -Math.sin((2 * Math.PI * i) / M); }
// the split step's twiddles, e^(-2 pi i k / N)
const WC = new Float64Array(M + 1);
const WS = new Float64Array(M + 1);
for (let k = 0; k <= M; k++) { WC[k] = Math.cos((2 * Math.PI * k) / N); WS[k] = -Math.sin((2 * Math.PI * k) / N); }
const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
const EDGES = Array.from({ length: NB + 1 }, (_, b) => Math.round((F0 * Math.pow(F1 / F0, b / NB) * N) / SR));
const TOP_BIN = EDGES[NB];

const re = new Float64Array(M);
const im = new Float64Array(M);
const E = new Float64Array(NB);

// band energies of the window starting at pcm[base] into E; returns their sum
const bands = (pcm, base) => {
  for (let i = 0; i < M; i++) {
    const j = REV[i];
    re[j] = pcm[base + 2 * i] * HANN[2 * i];
    im[j] = pcm[base + 2 * i + 1] * HANN[2 * i + 1];
  }
  for (let size = 2; size <= M; size <<= 1) {
    const half = size >> 1;
    const step = M / size;
    for (let i = 0; i < M; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j;
        const b = a + half;
        const tr = re[b] * COS[k] - im[b] * SIN[k];
        const ti = re[b] * SIN[k] + im[b] * COS[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  let total = 0;
  let band = 0;
  let acc = 0;
  for (let k = EDGES[0]; k < TOP_BIN; k++) {
    // X[k] from Z[k] and Z[M-k]
    const k2 = (M - k) & (M - 1);
    const zr = re[k], zi = im[k], cr = re[k2], ci = -im[k2];
    const er = (zr + cr) / 2, ei = (zi + ci) / 2; // even part
    const orr = (zi - ci) / 2, oi = -(zr - cr) / 2; // odd part: (Z - conj)/2i
    const xr = er + WC[k] * orr - WS[k] * oi;
    const xi = ei + WC[k] * oi + WS[k] * orr;
    acc += xr * xr + xi * xi;
    if (k + 1 === EDGES[band + 1]) {
      E[band] = acc; total += acc; acc = 0; band++;
      while (band < NB && EDGES[band + 1] === k + 1) { E[band] = 0; band++; } // (an empty band)
    }
  }
  return total;
};

const frameCount = (len) => Math.max(0, Math.floor((len - N) / HOP) + 1);

// The fingerprint of `pcm` (8 kHz mono Int16), frames [from, to).
// Returns { codes: Uint32Array, valid: Uint8Array } for every frame (those
// outside [from, to) are left 0 / invalid) — the cooperative wrapper fills a
// slice at a time.
const PREV = new Float64Array(NB);
const fillFrames = (pcm, out, from, to) => {
  let prevOk = false;
  let prevTotal = 0;
  if (from > 0) { prevTotal = bands(pcm, (from - 1) * HOP); for (let b = 0; b < NB; b++) PREV[b] = E[b]; prevOk = true; }
  for (let f = from; f < to; f++) {
    const total = bands(pcm, f * HOP);
    let code = 0;
    if (prevOk) {
      for (let b = 0; b < NB - 1; b++) {
        if ((E[b] - E[b + 1]) - (PREV[b] - PREV[b + 1]) > 0) code |= 1 << b;
      }
    }
    out.codes[f] = code >>> 0;
    out.valid[f] = prevOk && total >= FLOOR && prevTotal >= FLOOR ? 1 : 0;
    out.level[f] = Math.min(255, Math.round(10 * Math.log10(total + 1))); // the frame's loudness, in dB
    for (let b = 0; b < NB; b++) PREV[b] = E[b];
    prevTotal = total;
    prevOk = true;
  }
};
const fingerprint = (pcm) => {
  const n = frameCount(pcm.length);
  const out = { codes: new Uint32Array(n), valid: new Uint8Array(n), level: new Uint8Array(n) };
  fillFrames(pcm, out, 0, n);
  return out;
};
// The same, ~2 s of audio per turn of the event loop.
const fingerprintAsync = async (pcm, slice = 32) => {
  const n = frameCount(pcm.length);
  const out = { codes: new Uint32Array(n), valid: new Uint8Array(n), level: new Uint8Array(n) };
  for (let f = 0; f < n; f += slice) {
    fillFrames(pcm, out, f, Math.min(n, f + slice));
    await new Promise((r) => setImmediate(r));
  }
  return out;
};

const popcount = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

// Frame <-> seconds. A frame's bits compare its window with the one before,
// so what it describes is centred between the two: N/2 - HOP/2 into it.
const CENTRE = (N - HOP) / 2;
const frameAt = (sec) => Math.round((sec * SR - CENTRE) / HOP);
const timeOf = (f) => (f * HOP + CENTRE) / SR;
const FPS = SR / HOP;

// ---------- where two fingerprints line up ----------
// The offsets o (B[i + o] is A[i]) with the most exact 16-bit half matches,
// strongest first: [{ offset, score }]. A half that occurs very often in B
// is no evidence of anything and does not vote.
const offsets = (A, B, k = 3) => {
  const nA = A.codes.length;
  const nB = B.codes.length;
  if (!nA || !nB) return [];
  const index = new Map();
  for (let j = 0; j < nB; j++) {
    if (!B.valid[j]) continue;
    const c = B.codes[j];
    for (const h of [c & 0xffff, 0x10000 | (c >>> 16)]) {
      const l = index.get(h);
      if (l) l.push(j); else index.set(h, [j]);
    }
  }
  const votes = new Float32Array(nA + nB + 1);
  for (let i = 0; i < nA; i++) {
    if (!A.valid[i]) continue;
    const c = A.codes[i];
    for (const h of [c & 0xffff, 0x10000 | (c >>> 16)]) {
      const l = index.get(h);
      if (!l || l.length > 200) continue;
      for (let q = 0; q < l.length; q++) votes[l[q] - i + nA] += 1;
    }
  }
  const smooth = new Float32Array(votes.length);
  for (let o = 1; o < votes.length - 1; o++) smooth[o] = votes[o - 1] + votes[o] + votes[o + 1];
  const taken = new Uint8Array(votes.length);
  const out = [];
  for (let p = 0; p < k; p++) {
    let best = 0;
    let at = -1;
    for (let o = 0; o < smooth.length; o++) if (!taken[o] && smooth[o] > best) { best = smooth[o]; at = o; }
    if (at < 0 || best < 6) break;
    for (let d = -32; d <= 32; d++) if (at + d >= 0 && at + d < taken.length) taken[at + d] = 1;
    let m = at;
    for (let d = -1; d <= 1; d++) if (at + d >= 0 && at + d < votes.length && votes[at + d] > votes[m]) m = at + d;
    out.push({ offset: m - nA, score: best });
  }
  return out;
};

// ---------- the shared stretches at one offset ----------
const WIN_S = 2; // the error rate is judged over this much audio
const BER_MAX = 0.35; // unrelated audio sits at 0.5 +- 0.02 over 2 s
const EDGE_S = 0.5; // edges: judged over half a second ...
const EDGE_BER = 0.38; // ... at this rate (unrelated audio: 0.5 +- 0.03 over half a second)
const BRIDGE_S = 3; // near-silence inside a stretch is no reason to end it

// Returns [{ start, end }] in A's frames (inclusive), each a stretch where
// A[i] and B[i + offset] are the same recording.
const stretches = (A, B, offset) => {
  const lo = Math.max(0, -offset);
  const hi = Math.min(A.codes.length, B.codes.length - offset);
  const n = hi - lo;
  if (n <= 0) return [];
  const bits = new Uint8Array(n); // differing bits, valid frames only
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = i + lo;
    const b = a + offset;
    if (A.valid[a] && B.valid[b]) { ok[i] = 1; bits[i] = popcount(A.codes[a] ^ B.codes[b]); }
  }
  const S = new Float64Array(n + 1);
  const C = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { S[i + 1] = S[i] + bits[i]; C[i + 1] = C[i] + ok[i]; }
  const rate = (a, b) => { const c = C[b] - C[a]; return c ? (S[b] - S[a]) / (32 * c) : -1; };
  const W = Math.max(4, Math.round(WIN_S * FPS));
  const quietMax = Math.round(BRIDGE_S * FPS);
  const out = [];
  let start = -1;
  let last = -1;
  let quiet = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - (W >> 1));
    const b = Math.min(n, i + (W >> 1) + 1);
    const enough = C[b] - C[a] >= W / 4;
    if (!enough) { // too quiet to judge: neutral, for a while
      if (start >= 0 && ++quiet > quietMax) { out.push({ start, end: last }); start = -1; }
      continue;
    }
    quiet = 0;
    if (rate(a, b) <= BER_MAX) {
      if (start < 0) start = i;
      last = i;
    } else if (start >= 0) {
      out.push({ start, end: last });
      start = -1;
    }
  }
  if (start >= 0) out.push({ start, end: last });
  // Edges, from half-second windows: from a point well inside the stretch,
  // walk outwards for as long as the next (previous) half second still
  // agrees at EDGE_BER, then settle on a frame that itself agrees. Walked,
  // not searched: a stray moment of likeness a second past the end (two
  // room tones, a shared sting) is not reached across the gap before it.
  const w = Math.max(3, Math.round(EDGE_S * FPS));
  const aheadOk = (i) => i >= 0 && C[Math.min(n, i + w)] - C[i] >= w / 2 && rate(i, Math.min(n, i + w)) <= EDGE_BER;
  const behindOk = (i) => i < n && C[i + 1] - C[Math.max(0, i + 1 - w)] >= w / 2 && rate(Math.max(0, i + 1 - w), i + 1) <= EDGE_BER;
  const agrees = (i) => ok[i] && bits[i] <= 10;
  return out.map((r) => {
    const inS = Math.min(r.end, r.start + W);
    let s = inS;
    while (s - 1 >= Math.max(0, r.start - W) && aheadOk(s - 1)) s--;
    while (s < inS && !agrees(s)) s++;
    const inE = Math.max(s, r.end - W);
    let e = inE;
    while (e + 1 <= Math.min(n - 1, r.end + W) && behindOk(e + 1)) e++;
    while (e > inE && !agrees(e)) e--;
    return { start: s + lo, end: e + lo };
  }).filter((r) => r.end > r.start);
};

// Every shared stretch of at least `minS` seconds between A and B, in A's
// clock (seconds): [{ start, end, offset, score }], longest first.
// Two stretches at the very same offset with a short gap between them are
// one recording with a pause in it (a narrator's silence over hiss, a beat
// of dead air): the alignment to the frame is not a coincidence.
const MERGE_GAP_S = 4;
const match = (A, B, { minS = 8, peaks = 3 } = {}) => {
  const found = [];
  for (const p of offsets(A, B, peaks)) {
    const parts = [];
    for (const r of stretches(A, B, p.offset)) {
      const last = parts[parts.length - 1];
      if (last && r.start - last.end <= MERGE_GAP_S * FPS) last.end = r.end;
      else parts.push({ ...r });
    }
    for (const r of parts) {
      const start = timeOf(r.start) - HOP / SR / 2;
      const end = timeOf(r.end) + HOP / SR / 2;
      if (end - start >= minS) found.push({ start, end, offset: p.offset, score: p.score });
    }
  }
  return found.sort((x, y) => y.end - y.start - (x.end - x.start));
};

// ---------- what several comparisons agree on ----------
// `lists`: one entry per comparison — { found: [candidates], trusted } —
// where a trusted comparison is a known intro (a template). Returns
// { start, end, support } or null.
//   - stretches agree when they start within AGREE_S of each other (an
//     episode whose intro is the short version still starts it on time);
//   - the answer is the group the most comparisons share; it needs two of
//     them, or a trusted one, or — when only one comparison found anything
//     at all — a long enough lone answer;
//   - its start is the earliest of the group's, its end the latest: a
//     comparison only ever finds what BOTH files have, so each one is a
//     lower bound on this episode's intro (the full theme in an episode
//     compared with one that has the short version is found short there).
const AGREE_S = 2.5;
const agree = (lists, { minS = 8, loneMinS = 15, limitS = Infinity } = {}) => {
  const all = [];
  lists.forEach((l, i) => {
    for (const c of l.found || []) if (c.start <= limitS && c.end - c.start >= minS) all.push({ ...c, from: i, trusted: !!l.trusted });
  });
  if (!all.length) return null;
  const groups = [];
  for (const c of all.sort((a, b) => a.start - b.start)) {
    const g = groups.find((x) => Math.abs(x.anchor - c.start) <= AGREE_S);
    if (g) g.items.push(c); else groups.push({ anchor: c.start, items: [c] });
  }
  const scored = groups.map((g) => {
    // one candidate per comparison: its longest in the group
    const by = new Map();
    for (const c of g.items) if (!by.has(c.from) || c.end - c.start > by.get(c.from).end - by.get(c.from).start) by.set(c.from, c);
    const items = [...by.values()];
    return { items, support: items.length, trusted: items.some((c) => c.trusted), len: Math.max(...items.map((c) => c.end - c.start)) };
  });
  scored.sort((a, b) => b.support - a.support || (b.trusted ? 1 : 0) - (a.trusted ? 1 : 0) || b.len - a.len);
  const best = scored[0];
  // (comparisons that found nothing at all — an episode of another season
  // with a theme of its own — neither confirm nor contradict)
  const compared = lists.filter((l) => (l.found || []).some((c) => c.end - c.start >= minS)).length;
  const ok = best.support >= 2 || best.trusted || (compared === 1 && best.len >= loneMinS);
  if (!ok) return null;
  const others = best.items.filter((c) => !c.trusted).length;
  return {
    start: Math.min(...best.items.map((c) => c.start)),
    end: Math.max(...best.items.map((c) => c.end)),
    support: best.support,
    trusted: best.trusted,
    // how many of the agreeing comparisons were not known intros (siblings)
    others,
  };
};

// ---------- the credits ----------
// The end theme is the stretch a season's tails share. From one comparison:
// candidates { start, end } — each shared stretch of at least `minS`, as the
// start of everything shared from there on (a scene in the middle of the
// credits splits them in two, at different offsets; the credits still start
// at the first part), its end the last shared second. agree() then takes
// the earliest start the most comparisons share.
const creditsCandidates = (A, B, { minS = 8, totalMinS = 20 } = {}) => {
  const parts = match(A, B, { minS, peaks: 4 }).sort((x, y) => x.start - y.start);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    let total = 0;
    let end = parts[i].end;
    for (let j = i; j < parts.length; j++) { total += parts[j].end - parts[j].start; end = Math.max(end, parts[j].end); }
    if (total >= totalMinS) out.push({ start: parts[i].start, end });
  }
  return out;
};
// Seconds of sound in A after `fromS` at least as loud as `minDb` (a scene
// after the credits is talked or scored at the episode's own level; the
// black at the end of a file has none — at most hiss or room tone).
const audibleAfter = (A, fromS, minDb = 0) => {
  let n = 0;
  for (let f = Math.max(0, frameAt(fromS)); f < A.codes.length; f++) if (A.valid[f] && (!A.level || A.level[f] >= minDb)) n++;
  return n / FPS;
};
// The typical loudness (dB, the median frame) of A over [fromS, toS).
const loudness = (A, fromS, toS) => {
  if (!A.level) return 0;
  const xs = [];
  for (let f = Math.max(0, frameAt(fromS)); f < Math.min(A.level.length, frameAt(toS)); f++) if (A.valid[f]) xs.push(A.level[f]);
  xs.sort((a, b) => a - b);
  return xs.length ? xs[xs.length >> 1] : 0;
};

// ---------- a recap: the episode before, heard again ----------
// How much of [startS, endS) of A is sound out of B (at any offsets — a
// recap is clips, each from somewhere else): { covered (s), clips }.
const reheard = (A, B, startS, endS, { clipS = 2, peaks = 12 } = {}) => {
  const win = cut(A, startS, endS);
  if (!win.codes.length) return { covered: 0, clips: 0 };
  const hit = new Uint8Array(win.codes.length);
  let clips = 0;
  for (const p of offsets(win, B, peaks)) {
    for (const r of stretches(win, B, p.offset)) {
      if ((r.end - r.start + 1) / FPS < clipS) continue;
      clips++;
      for (let f = r.start; f <= r.end; f++) hit[f] = 1;
    }
  }
  let n = 0;
  for (const h of hit) n += h;
  return { covered: n / FPS, clips };
};

// ---------- templates: a show's intro, kept ----------
// A slice of an episode's fingerprint around its intro, so a new episode can
// be matched on its own — the one that just landed while the rest of the
// season was cleaned away, the first of a new season, a season of one.
const cut = (fp, startS, endS) => {
  const a = Math.max(0, frameAt(startS));
  const b = Math.min(fp.codes.length, frameAt(endS) + 1);
  return { codes: fp.codes.slice(a, b), valid: fp.valid.slice(a, b), ...(fp.level ? { level: fp.level.slice(a, b) } : {}) };
};
const b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
const encode = (fp) => ({ codes: b64(fp.codes), valid: b64(fp.valid), hop: HOP, sr: SR });
const decode = (t) => {
  if (!t || t.hop !== HOP || t.sr !== SR || typeof t.codes !== "string") return null;
  try {
    const c = Buffer.from(t.codes, "base64");
    const v = Buffer.from(t.valid || "", "base64");
    const codes = new Uint32Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength - (c.byteLength % 4)));
    const valid = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    if (valid.length !== codes.length) return null;
    return { codes, valid };
  } catch {
    return null;
  }
};

module.exports = {
  SR, N, HOP, NB, FPS,
  fingerprint, fingerprintAsync, offsets, stretches, match, agree, cut, encode, decode, timeOf, frameAt, popcount, creditsCandidates, audibleAfter, loudness, reheard,
  AGREE_S,
};
