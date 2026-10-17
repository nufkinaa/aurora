// Subtitles lined up with what is SAID: the alignment half of the audio sync
// (the other half, where speech is, is media/vad.js + media/speech.js).
//
// The approach of ffsubsync and alass, written here in plain JavaScript and
// measured on the household's library (docs/qa/subtitle-sync/REPORT.md):
//
//   1. Two signals on one 10 ms grid: the film's speech probability (0..1)
//      and the subtitle's "a line is on screen" (0/1).
//   2. GLOBAL: for each frame-rate ratio a subtitle can be out by (the PAL
//      speed-up and its relatives), the cross-correlation of the two signals
//      over every offset up to ±maxShift, by FFT (on a 40 ms grid, then
//      refined on the 10 ms grid around the peak). How far the peak stands
//      out is measured on the curve's SHARP part only (peakZ: less its own
//      ±2 s moving average — how much talk a stretch of film has moves the
//      curve slowly; a right match peaks within half a second).
//   3. PARTS: a subtitle made for another release of the film (a scene more
//      or less, a recap, a longer logo) is right in pieces (piecewise()):
//      offsets proposed by windows of lines that agree, dynamic programming
//      over the lines with a price per split set from the data's own noise,
//      every boundary placed again by the shape of the change (a scene the
//      audio lacks: exactly its seconds of lines are left out), and every
//      part checked on its own evidence.
//   4. A VERDICT with a CONFIDENCE: "in-time" (leave it), "moved" (one
//      offset / frame rate), "parts" (matched to this release in N parts) or
//      "unmatched" (refused: the subtitle stays as it is) — refused whenever
//      the confidence is low (see "the verdict" below for the numbers).
//
// PURE: arrays in, a plan out. The plan is applied to cue lists by
// applyPlan(), at serve time (media/subtitles.js) — the file on disk is never
// changed.
"use strict";

const HOP = 0.01; // s per frame
const COARSE = 4; // the global search runs on 40 ms

// Frame-rate ratios a subtitle can be out by (the subtitle's times are
// multiplied by these): film vs PAL vs 24 fps, both ways.
const SCALES = [1, 23.976 / 24, 24 / 23.976, 24 / 25, 25 / 24, 23.976 / 25, 25 / 23.976];

// ---------- FFT (complex, radix 2, any power of two) ----------
const tables = new Map();
const tablesFor = (n) => {
  let t = tables.get(n);
  if (t) return t;
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  if (tables.size > 8) tables.clear();
  tables.set(n, t);
  return t;
};
// in place; inverse = conjugate twiddles (unscaled)
const fft = (re, im, inverse = false) => {
  const n = re.length;
  const { rev, cos, sin } = tablesFor(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sg = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const c = cos[w];
        const s = sg * sin[w];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
};

// c[lag] = sum_t a[t] * b[t + lag], lag in [-maxLag, maxLag] -> Float64Array
// (index lag + maxLag). Linear (zero padded), by FFT.
const xcorr = (a, b, maxLag, bSpec = null) => {
  let n = 1;
  while (n < Math.max(a.length, b.length) + maxLag + 1) n <<= 1;
  let Bre;
  let Bim;
  if (bSpec && bSpec.n === n) ({ re: Bre, im: Bim } = bSpec);
  else {
    Bre = new Float64Array(n);
    Bim = new Float64Array(n);
    Bre.set(b);
    fft(Bre, Bim);
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(a);
  fft(re, im);
  // conj(A) * B
  for (let k = 0; k < n; k++) {
    const r = re[k] * Bre[k] + im[k] * Bim[k];
    const i = re[k] * Bim[k] - im[k] * Bre[k];
    re[k] = r;
    im[k] = i;
  }
  fft(re, im, true);
  const out = new Float64Array(2 * maxLag + 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) out[lag + maxLag] = re[(lag + n) % n] / n;
  return { c: out, spec: { n, re: Bre, im: Bim } };
};

// ---------- the two signals ----------

// A line's END says little about when its words are: many files keep a line
// up until the next one, translations run longer than the original, and a
// line with its tail cut short reads the same. Its START is the cue (the
// words begin there). So what is matched is each line's first LINE_CAP
// seconds: two subtitles of one film that differ only in how long their
// lines stay up come out at the same place (measured in the report: Ted
// 1x1's two Hebrew files, 0.34 s apart with whole lines, 0.09 s apart).
const LINE_CAP = 2.5;
const capLines = (cues) => cues.map((c) => ({ start: c.start, end: Math.min(c.end, c.start + LINE_CAP) }));

// speech: Uint8Array (0..255 per 10 ms) -> Float64Array 0..1
const speechSignal = (speech) => {
  const out = new Float64Array(speech.length);
  for (let i = 0; i < speech.length; i++) out[i] = speech[i] / 255;
  return out;
};

// cues -> 0/1 per frame, times scaled; length n
const cueMask = (cues, n, scale = 1, hop = HOP) => {
  const m = new Float64Array(n);
  for (const c of cues) {
    const a = Math.max(0, Math.round((c.start * scale) / hop));
    const b = Math.min(n, Math.round((c.end * scale) / hop));
    for (let i = a; i < b; i++) m[i] = 1;
  }
  return m;
};

const decimate = (x, k) => {
  const n = Math.floor(x.length / k);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += x[i * k + j];
    out[i] = s / k;
  }
  return out;
};

const meanOf = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return x.length ? s / x.length : 0; };
const centred = (x) => { const m = meanOf(x); const o = new Float64Array(x.length); for (let i = 0; i < x.length; i++) o[i] = x[i] - m; return o; };
const norm = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s); };

// median and a robust spread of an array (sampled for speed)
const robust = (x, skipFrom = -1, skipTo = -1) => {
  const step = Math.max(1, Math.floor(x.length / 4000));
  const v = [];
  for (let i = 0; i < x.length; i += step) if (i < skipFrom || i > skipTo) v.push(x[i]);
  v.sort((p, q) => p - q);
  const med = v[Math.floor(v.length / 2)] || 0;
  const dev = v.map((y) => Math.abs(y - med)).sort((p, q) => p - q);
  const mad = dev[Math.floor(dev.length / 2)] || 0;
  return { med, sd: Math.max(1e-9, mad * 1.4826) };
};

// How far a correlation peak stands out of its curve: the curve less its own
// moving average (±half samples) — what is left is the SHARP part: a right
// match peaks within a fraction of a second, while how much speech a span of
// the film has only moves the curve slowly — against the robust spread of
// that residual away from the peak (±exclude). -> { z, at } (at: the
// residual's own best, when `best` is null)
const peakZ = (c, best, half, exclude) => {
  const n = c.length;
  const res = new Float64Array(n);
  let s = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    while (hi < b) s += c[++hi];
    while (lo < a) s -= c[lo++];
    res[i] = c[i] - s / (hi - lo + 1);
  }
  let at = best;
  if (at == null) { at = 0; for (let i = 1; i < n; i++) if (res[i] > res[at]) at = i; }
  const { med, sd } = robust(res, at - exclude, at + exclude);
  return { z: (res[at] - med) / sd, at };
};

// The correlation (Pearson, over the overlap the whole film gives) of the
// subtitle at (scale, offset) with the speech — 10 ms grid, direct.
const corrAt = (sp, spNorm, cues, scale, offset) => {
  const n = sp.length;
  // centred speech is already zero-mean; the mask's mean is taken out by
  // working with the speech only: sum over masked frames of sp, minus the
  // mask's share of the speech's (zero) sum.
  let s = 0;
  let on = 0;
  const mark = new Uint8Array(n);
  for (const c of cues) {
    const a = Math.max(0, Math.round((c.start * scale + offset) / HOP));
    const b = Math.min(n, Math.round((c.end * scale + offset) / HOP));
    for (let i = a; i < b; i++) if (!mark[i]) { mark[i] = 1; s += sp[i]; on++; }
  }
  if (!on) return 0;
  const p = on / n;
  const maskNorm = Math.sqrt(on * (1 - p) * (1 - p) + (n - on) * p * p);
  return s / (maskNorm * spNorm);
};

// ---------- global: one ratio, one offset ----------

// -> { scale, offset, r, z, second, byScale: [{scale, offset, r, z}] }
const globalAlign = (speech, cues, { maxShift = 600, scales = SCALES } = {}) => {
  const sp10 = centred(speechSignal(speech));
  const spNorm = norm(sp10);
  const sp40 = centred(decimate(speechSignal(speech), COARSE));
  const n40 = sp40.length;
  const maxLag = Math.min(Math.round(maxShift / (HOP * COARSE)), n40);
  let spec = null;
  const byScale = [];
  for (const scale of scales) {
    const mask = centred(cueMask(cues, n40, scale, HOP * COARSE));
    const mn = norm(mask);
    if (!(mn > 0)) continue;
    const r = xcorr(mask, sp40, maxLag, spec);
    spec = r.spec;
    const c = r.c;
    const den = mn * norm(sp40) || 1;
    let best = 0;
    for (let i = 1; i < c.length; i++) if (c[i] > c[best]) best = i;
    const peak = c[best] / den;
    // the peak against the rest of the curve (±2 s around it left out)
    const { med, sd } = robust(c, best - 50, best + 50);
    const zRaw = (c[best] - med) / sd;
    const { z } = peakZ(c, best, 50, 50);
    byScale.push({ scale, lag40: best - maxLag, r40: peak, z, zRaw, curve: c, den });
  }
  if (!byScale.length) return null;
  byScale.sort((a, b) => b.r40 - a.r40);
  // refine the best two ratios on the 10 ms grid (±80 ms around the peak)
  const refined = byScale.slice(0, 2).map((s) => {
    let bestOff = s.lag40 * HOP * COARSE;
    let bestR = -Infinity;
    for (let d = -8; d <= 8; d++) {
      const off = s.lag40 * HOP * COARSE + d * HOP;
      const r = corrAt(sp10, spNorm, cues, s.scale, off);
      if (r > bestR) { bestR = r; bestOff = off; }
    }
    return { ...s, offset: Math.round(bestOff * 1000) / 1000, r: bestR };
  });
  refined.sort((a, b) => b.r - a.r);
  const top = refined[0];
  // the runner-up PEAK of the winning ratio, away from its own (how unique
  // the answer is)
  const c = top.curve;
  const ml = (c.length - 1) / 2;
  const at = top.lag40 + ml;
  let second = -Infinity;
  for (let i = 0; i < c.length; i++) if (Math.abs(i - at) > 75 && c[i] > second) second = c[i];
  const identityR = corrAt(sp10, spNorm, cues, 1, 0);
  return {
    scale: top.scale,
    offset: top.offset,
    r: top.r,
    z: top.z,
    secondRatio: second / c[at],
    identityR,
    byScale: byScale.map((s) => ({ scale: s.scale, offset: Math.round(s.lag40 * HOP * COARSE * 100) / 100, r: Math.round(s.r40 * 1000) / 1000, z: Math.round(s.z * 10) / 10 })),
  };
};

// ---------- parts: a cut that differs ----------

// prefix sums over the 10 ms grid of the two per-line scores:
//   G: p - mu (speech against the film's average), extended past both ends
//      as "no speech" (a line placed outside the film is evidence against);
//   L: p - its own ±5 s average (speech against its surroundings: inside a
//      dialogue scene, where any placement finds speech, only the RIGHT one
//      lines the pauses up with the gaps between lines).
const LOCAL = 500; // frames (±5 s)
const prefixOf = (p, mu, localWeight = 1) => {
  const n = p.length;
  const P = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) P[i + 1] = P[i] + p[i] - mu;
  const Q = new Float64Array(n + 1);
  if (localWeight) {
    // running ±LOCAL mean
    let s = 0;
    let lo = 0;
    let hi = -1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - LOCAL);
      const b = Math.min(n - 1, i + LOCAL);
      while (hi < b) s += p[++hi];
      while (lo < a) s -= p[lo++];
      Q[i + 1] = Q[i] + p[i] - s / (hi - lo + 1);
    }
  }
  // before 0: frames of (0 - mu) each, so P(x) = mu * -x
  const at = (x) => (x < 0 ? mu * -x : x >= n ? P[n] - mu * (x - n) : P[x]);
  const atQ = (x) => (x < 0 ? 0 : x >= n ? Q[n] : Q[x]);
  const sum = (a, b) => at(b) - at(a) + localWeight * (atQ(b) - atQ(a));
  return { P, at, sum };
};

const STEP = 10; // the DP's grid: 0.1 s in frames

// Split the cue list into parts with their own offsets.
//
// Searching every offset for every line fits noise: over ±300 s, some offset
// always makes thirty lines of a film score well. So the offsets a part may
// take are found first, from evidence that stands out:
//   1. WINDOWS of 60 lines (and of 30 near the two ends; stepping by a
//      third of their size) are each correlated
//      with the speech over ±range; a window whose peak stands out of its own
//      noise (WIN_Z) proposes its offset;
//   2. proposals within 0.3 s are one; an offset proposed by three windows
//      or more that add up to clear evidence (or by two, one very clearly),
//      plus the global one, are the CANDIDATES (at most MAX_CAND) — a wrong
//      peak is a one-off, a real offset comes back window after window;
//   3. dynamic programming over the lines picks a candidate per line, paying
//      the penalty at every change (alass's idea) — a split is only made
//      where a run of lines clearly fits another offset better;
//   4. parts of fewer than MIN_CUES lines join a neighbour;
//   5. every boundary is placed again by the shape of the change: where the
//      offset goes DOWN by D seconds, the subtitle has D seconds this audio
//      does not (a scene of another cut): the lines of D seconds of subtitle
//      time are left out, at the place that fits best; where it goes UP,
//      this audio has D seconds more (a recap, a logo) and the lines are
//      only split. Then each part is refined to 10 ms, and a split that no
//      longer pays its penalty is undone.
//   cues: already at the global (scale, offset); returns the parts with
//   offsets relative to that, and the lines left out (index ranges).
const WIN_SIZES = [60, 30]; // lines a window has (30: only near the ends, where a short part has few windows of 60)
const WIN_Z = 2; // a window's peak, to be a proposal at all
const CAND_ZSUM = 10; // an offset is a candidate: three windows or more whose peaks add up to this…
const CAND_Z2 = 7; // …or two, one of them this clear
const MAX_CAND = 6;
const PEN_K = 4; // the DP's price of a split: at least this many sigmas of one line's evidence…
const PEN_D = 3; // …and this many times a wrong run's typical best excursion (see below)
const PART_Z = 4; // the evidence a part must have of its own (see below)
const MIN_CUES = 20; // the fewest lines a part may have
const piecewise = (speech, cues, { range = 300, penalty = null, minCues = MIN_CUES, localWeight = 1, partMinZ = PART_Z } = {}) => {
  const p = speechSignal(speech);
  const mu = meanOf(p);
  const { at, sum } = prefixOf(p, mu, localWeight);
  const n = cues.length;
  if (!n) return { parts: [], drops: [], mu, candidates: [] };
  const K = Math.round(range / (HOP * STEP));
  const W = 2 * K + 1;
  const a = cues.map((c) => Math.round(c.start / HOP));
  const b = cues.map((c) => Math.max(Math.round(c.start / HOP) + 1, Math.round(c.end / HOP)));
  const score = (i, f) => sum(a[i] + f, b[i] + f); // f: offset in frames
  const gscore = (i, f) => at(b[i] + f) - at(a[i] + f);
  // 1. windows (the plain score: a window of 60 lines has evidence enough)
  const proposals = [];
  for (const size of WIN_SIZES) {
    const step = Math.max(10, Math.floor(size / 3));
    for (let w0 = 0; w0 < n; w0 += step) {
      const w1 = Math.min(n, w0 + size);
      if (w1 - w0 < size / 2 && w0 > 0) break;
      // (the short windows only near the two ends, where long ones are few)
      if (size < WIN_SIZES[0] && w0 >= 90 && w1 <= n - 90) continue;
      const curve = new Float64Array(W);
      for (let i = w0; i < w1; i++) for (let d = 0; d < W; d++) curve[d] += gscore(i, (d - K) * STEP);
      const { z, at: best } = peakZ(curve, null, 30, 10);
      // (a peak at the very edge of the range is the edge, not an offset)
      if (z >= WIN_Z && Math.abs(best - K) < K - 30) proposals.push({ d: best - K, z, w0, w1 });
    }
  }
  // 2. candidates (grid steps of 0.1 s, relative)
  const groups = [];
  for (const pr of proposals) {
    const g = groups.find((x) => Math.abs(x.d - pr.d) <= 3);
    if (g) { g.n++; g.z = Math.max(g.z, pr.z); g.sum += pr.z; } else groups.push({ d: pr.d, n: 1, z: pr.z, sum: pr.z });
  }
  const cand = [0];
  for (const g of groups.filter((x) => (x.n >= 3 && x.sum >= CAND_ZSUM) || (x.n >= 2 && x.z >= CAND_Z2)).sort((x, y) => y.sum - x.sum)) {
    if (cand.length >= MAX_CAND) break;
    if (!cand.some((d) => Math.abs(d - g.d) <= 3)) cand.push(g.d);
  }
  const C = cand.length;
  // 3. DP over the lines, one candidate each
  // the noise of one line's evidence: the difference of its score at two
  // wrong offsets (30 s..range away, both ways), as a standard deviation
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const away = () => Math.round((30 + rnd() * Math.max(1, range - 30)) / HOP) * (rnd() < 0.5 ? -1 : 1);
  let s1 = 0;
  let s2 = 0;
  let adv = 0;
  for (let i = 0; i < n; i++) {
    const d = score(i, away()) - score(i, away());
    s1 += d;
    s2 += d * d;
    adv += score(i, 0) - score(i, away());
  }
  const sigma = Math.max(1, Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2)));
  // ...and one line's evidence FOR the right offset (at the global one,
  // against wrong ones). A run of lines at a wrong offset drifts down by
  // `delta` a line with noise `sigma`: its best excursion above the right
  // offset is about sigma^2 / (2 delta), so that is what a split must cost.
  const delta = Math.max(0.05 * sigma, adv / n);
  const pen = penalty != null ? penalty : Math.max(PEN_K * sigma, PEN_D * (sigma * sigma) / delta);
  const per = new Int32Array(n);
  if (C > 1) {
    const sw = new Uint8Array(n * C);
    const from = new Int32Array(n);
    let V = cand.map((d) => score(0, d * STEP));
    for (let i = 1; i < n; i++) {
      let m = 0;
      for (let k = 1; k < C; k++) if (V[k] > V[m]) m = k;
      from[i] = m;
      V = V.map((v, k) => {
        let x = v;
        if (V[m] - pen > v) { x = V[m] - pen; sw[i * C + k] = 1; }
        return x + score(i, cand[k] * STEP);
      });
    }
    let k = 0;
    for (let j = 1; j < C; j++) if (V[j] > V[k]) k = j;
    for (let i = n - 1; i >= 0; i--) {
      per[i] = k;
      if (i > 0 && sw[i * C + k]) k = from[i];
    }
  }
  const runs = () => {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (!out.length || out[out.length - 1].k !== per[i]) out.push({ from: i, to: i, k: per[i] });
      else out[out.length - 1].to = i;
    }
    return out;
  };
  let rs = runs();
  // 4. small parts join the neighbour they fit best
  const runScore = (pt, f) => { let s = 0; for (let i = pt.from; i <= pt.to; i++) s += score(i, f); return s; };
  for (let changed = true; changed && rs.length > 1;) {
    changed = false;
    for (let j = 0; j < rs.length; j++) {
      const pt = rs[j];
      if (pt.to - pt.from + 1 >= minCues) continue;
      const left = rs[j - 1];
      const right = rs[j + 1];
      const into = !left ? right : !right ? left : runScore(pt, cand[left.k] * STEP) >= runScore(pt, cand[right.k] * STEP) ? left : right;
      for (let i = pt.from; i <= pt.to; i++) per[i] = into.k;
      rs = runs();
      changed = true;
      break;
    }
  }
  // parts: { from, to, f (frames), dropFrom, dropTo } — a drop belongs to
  // the boundary BEFORE its part (lines dropFrom..dropTo are left out)
  const dpRuns = rs.map((r) => [r.from, r.to, cand[r.k] * STEP * HOP]);
  let parts = rs.map((r) => ({ from: r.from, to: r.to, f: cand[r.k] * STEP, dropFrom: null, dropTo: null }));
  const linePrefix = (f) => { const S = new Float64Array(n + 1); for (let i = 0; i < n; i++) S[i + 1] = S[i] + score(i, f); return S; };
  // 5. boundaries by the shape of the change
  const placeBoundaries = () => {
    for (let k = 1; k < parts.length; k++) {
      const A = parts[k - 1];
      const B = parts[k];
      const SA = linePrefix(A.f);
      const SB = linePrefix(B.f);
      const D = (B.f - A.f) * HOP; // s
      const first = A.from + Math.min(minCues, A.to - A.from);
      const last = B.to - Math.min(minCues, B.to - B.from) + 1;
      let best = null;
      const consider = (j, e) => {
        if (j < first || e > B.to || e < j) return;
        const sc = SA[j] - SA[A.from] + SB[B.to + 1] - SB[e];
        if (!best || sc > best.sc) best = { j, e, sc };
      };
      if (D < -0.5) {
        // lines [A.from, j) at A's offset; the lines that START within the
        // |D| s of subtitle time the audio lacks, [t0, t0 + |D|), left out;
        // the rest at B's. The window may begin at a line's start or end
        // just before one: every distinct set of left-out lines is tried.
        const W = -D;
        let e = first;
        for (let j = first; j <= last; j++) {
          // window starting at line j
          while (e <= B.to && cues[e].start < cues[j].start + W) e++;
          consider(j, e);
        }
        let j = first;
        for (let e2 = first; e2 <= B.to; e2++) {
          // window ending just before line e2: starts at cues[e2].start - W
          while (j < e2 && cues[j].start < cues[e2].start - W) j++;
          if (j <= last) consider(j, e2);
        }
      } else {
        // lines [A.from, j) at A's offset, the rest at B's
        for (let j = first; j <= last; j++) consider(j, j);
      }
      if (!best) continue;
      A.to = best.j - 1;
      B.from = best.e;
      B.dropFrom = best.e > best.j ? best.j : null;
      B.dropTo = best.e > best.j ? best.e - 1 : null;
    }
  };
  const refine = () => {
    for (const pt of parts) {
      let best = pt.f;
      let bestS = -Infinity;
      for (let f = pt.f - STEP; f <= pt.f + STEP; f++) {
        const s = runScore(pt, f);
        if (s > bestS) { bestS = s; best = f; }
      }
      pt.f = best;
      pt.score = bestS;
    }
  };
  if (parts.length > 1) placeBoundaries();
  refine();
  if (parts.length > 1) { placeBoundaries(); refine(); }
  // every part must stand on its own evidence: its lines must peak SHARPLY
  // at its offset (peakZ of their summed score over ±30 s around it) and
  // clearly more than they do at a neighbour's offset. The weakest part
  // that does not reach PART_Z joins the neighbour it fits best, and the
  // boundaries are placed again — until every part stands.
  const SPAN = 300; // ±30 s, on the 0.1 s grid
  const sharpAt = (pt, f) => {
    const curve = new Float64Array(2 * SPAN + 1);
    for (let i = pt.from; i <= pt.to; i++) for (let d = 0; d <= 2 * SPAN; d++) curve[d] += score(i, f + (d - SPAN) * STEP);
    return peakZ(curve, SPAN, 30, 10).z;
  };
  // (the lines a boundary leaves out count too: if THEY peak at the
  // neighbour's offset they are real lines, and the split that drops them
  // is wrong)
  // is wrong) — and the split must still pay its price in plain score: the
  // part at its offset (its dropped lines at nothing) against the part and
  // those lines at the neighbour's
  const partZ = (k) => {
    const pt = parts[k];
    let other = 0;
    for (const j of [k - 1, k + 1]) {
      if (j < 0 || j >= parts.length) continue;
      const nb = parts[j];
      other = Math.max(other, sharpAt(pt, nb.f));
      const between = j < k ? pt : nb; // the part whose drop lies between the two
      const drop = between.dropFrom != null ? { from: between.dropFrom, to: between.dropTo } : null;
      if (drop && drop.to - drop.from >= 4) other = Math.max(other, sharpAt(drop, nb.f));
      const gain = runScore(pt, pt.f) - runScore(pt, nb.f) - (drop ? runScore(drop, nb.f) : 0);
      if (gain < pen) return Math.min(-1, gain / pen);
    }
    return sharpAt(pt, pt.f) - other;
  };
  for (let guard = 0; parts.length > 1 && guard < 100; guard++) {
    let weak = -1;
    let weakZ = Infinity;
    for (let k = 0; k < parts.length; k++) {
      const z = Math.abs(parts[k].f - (parts[k - 1] || parts[k + 1]).f) * HOP < 0.15 ? -Infinity : partZ(k);
      if (z < weakZ) { weakZ = z; weak = k; }
    }
    if (weakZ >= partMinZ) break;
    const pt = parts[weak];
    const L = parts[weak - 1];
    const R = parts[weak + 1];
    const intoLeft = !R || (L && runScore(pt, L.f) >= runScore(pt, R.f));
    if (intoLeft) parts.splice(weak - 1, 2, { from: L.from, to: pt.to, f: L.f, dropFrom: L.dropFrom, dropTo: L.dropTo });
    else parts.splice(weak, 2, { from: pt.from, to: R.to, f: R.f, dropFrom: pt.dropFrom, dropTo: pt.dropTo });
    if (parts.length > 1) placeBoundaries();
    refine();
  }
  if (parts.length === 1) { parts[0].from = 0; parts[0].to = n - 1; parts[0].dropFrom = null; parts[0].dropTo = null; refine(); }
  const drops = parts.filter((pt) => pt.dropFrom != null).map((pt) => [pt.dropFrom, pt.dropTo]);
  return {
    parts: parts.map((pt, k) => ({ from: pt.from, to: pt.to, offset: Math.round(pt.f) * HOP, score: pt.score, z: parts.length > 1 ? Math.round(partZ(k) * 10) / 10 : null })),
    drops, mu, pen, sigma, delta, candidates: cand.map((d) => d * STEP * HOP), proposals: proposals.length,
    debug: { dpRuns, groups: groups.map((g) => [g.d * STEP * HOP, g.n, Math.round(g.sum * 10) / 10, Math.round(g.z * 10) / 10]) },
  };
};

// How sharply a cue list, as it is, sits on the speech: the correlation
// curve over ±60 s (40 ms grid) and the z of its value at 0 (peakZ).
const sharpness = (speech, cues, span = 60) => {
  const sp40 = centred(decimate(speechSignal(speech), COARSE));
  const mask = centred(cueMask(cues, sp40.length, 1, HOP * COARSE));
  if (!(norm(mask) > 0)) return 0;
  const maxLag = Math.round(span / (HOP * COARSE));
  const { c } = xcorr(mask, sp40, maxLag);
  return peakZ(c, maxLag, 50, 50).z;
};

// ---------- the verdict ----------

// Confidence (docs/qa/subtitle-sync/REPORT.md, "Confidence and refusal").
// Three numbers say whether a cue list belongs to this audio, and the
// WEAKEST decides:
//   z       the global correlation peak, sharp part only (peakZ), in robust
//           standard deviations — another film's or another episode's
//           subtitle measured 1.3-3.3, every right one 6.1 or more;
//   zAfter  the same for the cue list as the plan places it (a plan that is
//           right sits sharply where it put the lines: right plans 10.9 or
//           more, the refused ones 3.7 at most);
//   partZ   each part's own evidence (piecewise; a part below PART_Z is
//           never kept, so this only lowers the number).
// Each is mapped to 0..1 between "noise" and "certain"; confidence is the
// smallest. Below MIN_CONFIDENCE the answer is "unmatched": refused, the
// subtitle stays as it is.
const Z_NOISE = 3;
const Z_SURE = 15;
const ZA_NOISE = 4;
const ZA_SURE = 20;
const PZ_NOISE = 2;
const PZ_SURE = 10;
const MIN_CONFIDENCE = 0.2; // = z 5.4, zAfter 7.2, a part 3.6
const MIN_Z = Z_NOISE + MIN_CONFIDENCE * (Z_SURE - Z_NOISE); // (reported; the gate is the confidence)
const MIN_R = 0.05; // the correlation at the peak: a sanity floor only (r does not separate)
// s: one offset closer to the original than this is "in time". The right
// subtitles of the test set peak between -0.27 and +0.16 s of where they
// are (the detector's precision on one film, and each release's own habit):
// a smaller move is not a measurement.
const SAME = 0.25;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const confidenceOf = (z, zAfter, partZ) => {
  let c = Math.min(clamp01((z - Z_NOISE) / (Z_SURE - Z_NOISE)), zAfter == null ? 1 : clamp01((zAfter - ZA_NOISE) / (ZA_SURE - ZA_NOISE)));
  if (partZ && partZ.length) c = Math.min(c, clamp01((Math.min(...partZ) - PZ_NOISE) / (PZ_SURE - PZ_NOISE)));
  return Math.round(c * 100) / 100;
};

// The whole alignment of a cue list to a speech timeline.
// -> { verdict "in-time" | "moved" | "parts" | "unmatched", apply,
//      plan: { parts: [{ from (sub time), scale, offset }], drop: [[a, b]] },
//      confidence (0..1), scale, offset, parts, r, z, zAfter, partZ,
//      identityR, rAfter, total, dropped, why }
const align = (speech, cues, opts = {}) => {
  const list = cues.filter((c) => c.end > c.start && c.start >= 0).sort((x, y) => x.start - y.start);
  const dur = speech.length * HOP;
  const refuse = (why, extra = {}) => ({ verdict: "unmatched", apply: false, confidence: 0, why, total: list.length, ...extra });
  if (list.length < 20) return refuse("too few lines to judge");
  if (dur < 120) return refuse("too little audio to judge");
  const maxShift = opts.maxShift || Math.min(600, Math.max(60, dur / 3));
  // what is matched: each line's first LINE_CAP seconds (capLines)
  const sig = capLines(list);
  const g = globalAlign(speech, sig, { maxShift });
  if (!g) return refuse("nothing to compare");
  const base = {
    total: list.length,
    r: round3(g.r),
    z: Math.round(g.z * 10) / 10,
    identityR: round3(g.identityR),
    secondRatio: round3(g.secondRatio),
    byScale: g.byScale,
  };
  const minConf = opts.minConfidence != null ? opts.minConfidence : MIN_CONFIDENCE;
  const c0 = confidenceOf(g.z, null, null);
  if (c0 < minConf || !(g.r >= MIN_R)) {
    return refuse("the speech does not match these lines", { ...base, confidence: c0, scale: g.scale, offset: g.offset });
  }
  // parts, on the cues as the global answer places them
  const placed = sig.map((c) => ({ start: c.start * g.scale + g.offset, end: c.end * g.scale + g.offset }));
  let parts = [{ from: 0, to: list.length - 1, offset: 0 }];
  let drops = [];
  let pw = null;
  if (opts.parts !== false) {
    pw = piecewise(speech, placed, { range: opts.range || Math.min(300, maxShift), penalty: opts.penalty, localWeight: opts.localWeight, partMinZ: opts.partMinZ });
    parts = pw.parts;
    drops = pw.drops;
  }
  // the plan, in the SUBTITLE's own time: a part starts halfway between its
  // first line's start and the line before's; lines left out by their range
  // of starts
  const planParts = parts.map((pt, k) => ({
    from: k === 0 ? 0 : round3((list[pt.from - 1].start + list[pt.from].start) / 2),
    scale: g.scale,
    offset: round3(g.offset + pt.offset),
  }));
  const drop = drops.map(([i, j]) => [round3(list[i].start), round3(list[j].start)]);
  const debug = opts.debug && pw ? { ...pw.debug, candidates: pw.candidates, parts: pw.parts.map((p) => [p.from, p.to, p.offset]), drops } : undefined;
  const plan = { parts: planParts, drop };
  const moved = applyPlan(list, plan);
  const movedSig = applyPlan(sig, plan);
  const sp10 = centred(speechSignal(speech));
  const rAfter = corrAt(sp10, norm(sp10), movedSig, 1, 0);
  const zAfter = sharpness(speech, movedSig);
  const nParts = planParts.length;
  const partZ = parts.length > 1 ? parts.map((pt) => pt.z) : undefined;
  const confidence = confidenceOf(g.z, zAfter, partZ);
  const out = {
    ...base,
    scale: g.scale,
    offset: g.offset,
    parts: nParts,
    plan,
    confidence,
    rAfter: round3(rAfter),
    zAfter: Math.round(zAfter * 10) / 10,
    partZ,
    dropped: list.length - moved.length,
    debug,
  };
  if (confidence < minConf) return { ...out, verdict: "unmatched", apply: false, why: "the lines do not sit clearly where the match puts them" };
  const same = nParts === 1 && g.scale === 1 && Math.abs(planParts[0].offset) < SAME;
  if (same) return { ...out, verdict: "in-time", apply: false, why: "already in time" };
  // the original must really be worse: when it scores as well, nothing is
  // changed
  if (g.identityR >= rAfter) return { ...out, verdict: "in-time", apply: false, why: "already in time (the original scores as well)" };
  if (nParts > 1) return { ...out, verdict: "parts", apply: true, why: `matched to this release in ${nParts} parts` };
  return { ...out, verdict: "moved", apply: true, why: g.scale !== 1 ? "frame rate and offset" : "constant offset" };
};

const round3 = (x) => Math.round(x * 1000) / 1000;

// A plan applied to a cue list (any objects with start/end; other fields are
// kept). Cues inside a dropped range are left out.
const applyPlan = (cues, plan) => {
  if (!plan || !plan.parts || !plan.parts.length) return cues.slice();
  const parts = plan.parts;
  const drop = plan.drop || [];
  const out = [];
  for (const c of cues) {
    if (drop.some(([a, b]) => c.start >= a - 1e-6 && c.start <= b + 1e-6)) continue;
    let k = 0;
    while (k + 1 < parts.length && c.start >= parts[k + 1].from) k++;
    const p = parts[k];
    const s = c.start * p.scale + p.offset;
    const e = c.end * p.scale + p.offset;
    if (e <= 0) continue;
    out.push({ ...c, start: Math.max(0, s), end: e });
  }
  return out;
};

// What the result says, in words for the player.
const describe = (res) => {
  if (!res) return "Couldn't match — kept as it was";
  if (res.verdict === "unmatched") return "Couldn't match — kept as it was";
  if (res.verdict === "in-time") return "Already in time — nothing to move";
  if (res.verdict === "parts") return `Matched to this release in ${res.parts} parts`;
  const off = res.plan && res.plan.parts[0] ? res.plan.parts[0].offset : res.offset;
  const secs = Math.abs(off) < 10 ? Math.abs(off).toFixed(1) : String(Math.round(Math.abs(off)));
  const dir = off >= 0 ? "later" : "earlier";
  if (res.scale !== 1) return Math.abs(off) < 0.05 ? "Matched the frame rate" : `Matched the frame rate and moved ${secs} s ${dir}`;
  return `Moved ${secs} s ${dir}`;
};

module.exports = { SCALES, HOP, MIN_Z, MIN_R, MIN_CONFIDENCE, PART_Z, LINE_CAP, align, confidenceOf, capLines, globalAlign, piecewise, applyPlan, describe, cueMask, xcorr, corrAt, _internals: { fft, robust, prefixOf } };
