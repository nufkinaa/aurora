// Synthetic TV episodes with known intros, for measuring Skip intro
// (tools/intro-eval/run.js, test/introeval.test.js). Deterministic: the same
// seed gives the same audio, sample for sample.
//
// What a real season does to a detector, made on purpose:
//   - a theme (melody, bass, drums, harmonics) shared by every episode, at a
//     different place in each: cold opens of none to several minutes;
//   - programme sound around it — speech-like syllables in phrases, room
//     tone, now and then some score — different in every episode;
//   - each episode its own "encode": gain, a low-pass, hiss, and a start a
//     few samples off the others (no two files share a frame grid);
//   - per show, the hard cases: a 10-second title card; pauses of near-
//     silence inside the theme (narration); a short version of the theme in
//     some episodes; dialogue over its first seconds; "Previously on" clips
//     out of the episode before (sound that IS shared, and is not the intro);
//     a show with no intro at all.
// 8 kHz mono Int16 — what introdetect decodes to.
"use strict";

const SR = 8000;
const TABLE = 8192;
const SINE = Float64Array.from({ length: TABLE }, (_, i) => Math.sin((2 * Math.PI * i) / TABLE));

const rng = (seed) => {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
};

// add a decaying harmonic tone into buf (Float32, mono) at [at, at+len)
const tone = (buf, at, len, f, amp, harmonics, decay) => {
  const end = Math.min(buf.length, at + len);
  const k = Math.exp(-decay / SR); // the decay, one sample at a time
  const attack = SR / 80;
  for (let h = 1; h <= harmonics; h++) {
    const fh = f * h;
    if (fh >= SR / 2 - 200) break;
    // (the phase in 16.16 fixed point: an int32 that wraps where the table does)
    const step = Math.round(((fh * TABLE) / SR) * 65536) | 0;
    const a = amp / h;
    let ph = 0;
    let env = 1;
    for (let i = at, n = 0; i < end; i++, n++) {
      buf[i] += a * (n < attack ? n / attack : 1) * env * SINE[(ph >>> 16) & (TABLE - 1)];
      env *= k;
      ph = (ph + step) | 0;
    }
  }
};
const noiseBurst = (buf, at, len, amp, r, decay) => {
  const end = Math.min(buf.length, at + len);
  const k = Math.exp(-decay / SR);
  let lp = 0;
  let env = 1;
  for (let i = at; i < end; i++) {
    lp = 0.6 * lp + 0.4 * (r() * 2 - 1);
    buf[i] += amp * lp * env;
    env *= k;
  }
};

// A theme: melody on a pentatonic scale, a bass line, drums.
const music = (seconds, seed, level = 6000) => {
  const n = Math.round(seconds * SR);
  const buf = new Float64Array(n);
  const r = rng(seed);
  const bpm = 96 + Math.floor(r() * 50);
  const beat = Math.round((60 / bpm) * SR);
  const scale = [0, 2, 4, 7, 9];
  const root = 196 * Math.pow(2, Math.floor(r() * 7) / 12);
  let deg = Math.floor(r() * 5);
  for (let b = 0; b * beat < n; b++) {
    const at = b * beat;
    // bass on every beat
    const bass = (root / 2) * Math.pow(2, scale[(deg + (b % 4 === 0 ? 0 : 2)) % 5] / 12);
    tone(buf, at, beat, bass, level * 0.5, 4, 3);
    // melody in eighths
    for (const half of [0, 1]) {
      if (r() < 0.15) continue;
      deg = Math.max(0, Math.min(9, deg + Math.floor(r() * 5) - 2));
      const f = root * Math.pow(2, (scale[deg % 5] + 12 * Math.floor(deg / 5)) / 12);
      tone(buf, at + Math.round((half * beat) / 2), beat, f, level * (0.6 + r() * 0.4), 5, 4 + r() * 4);
    }
    // drums: a kick on 1 and 3, a snare-ish burst on 2 and 4
    if (b % 2 === 0) tone(buf, at, Math.round(0.15 * SR), 60, level * 0.8, 2, 25);
    else noiseBurst(buf, at, Math.round(0.12 * SR), level * 0.5, r, 30);
  }
  return buf;
};

// Speech-like programme: syllables (a voice's harmonics through two
// formants), in phrases, over room tone.
const speech = (seconds, seed, level = 4000) => {
  const n = Math.round(seconds * SR);
  const buf = new Float64Array(n);
  const r = rng(seed);
  // room tone
  let lp = 0;
  for (let i = 0; i < n; i++) { lp = 0.95 * lp + 0.05 * (r() * 2 - 1); buf[i] = lp * level * 0.02; }
  let at = Math.round(r() * 0.3 * SR);
  let inPhrase = 0;
  while (at < n) {
    const f0 = 95 + r() * 130;
    const len = Math.round((0.1 + r() * 0.22) * SR);
    const F1 = 300 + r() * 600;
    const F2 = 900 + r() * 1700;
    for (let h = 1; h * f0 < 3500; h++) {
      const f = h * f0;
      const g = Math.exp(-(((f - F1) / 180) ** 2)) + 0.6 * Math.exp(-(((f - F2) / 260) ** 2)) + 0.03;
      tone(buf, at, len, f, level * g, 1, 6);
    }
    at += len + Math.round((0.03 + r() * 0.15) * SR);
    if (++inPhrase > 5 + r() * 8) { inPhrase = 0; at += Math.round((0.3 + r() * 1.0) * SR); }
  }
  return buf;
};

const mix = (dst, src, at, gain = 1) => {
  for (let i = 0; i < src.length && at + i < dst.length; i++) if (at + i >= 0) dst[at + i] += src[i] * gain;
};

// Programme between and after: speech, now and then some score.
const programme = (seconds, seed) => {
  const buf = speech(seconds, seed);
  const r = rng(seed * 31 + 7);
  for (let t = 20 + r() * 40; t < seconds - 20; t += 60 + r() * 90) mix(buf, music(12 + r() * 10, seed * 97 + Math.floor(t), 2500), Math.round(t * SR));
  return buf;
};

// The "encode": gain, a one-pole low-pass, hiss, a start a few samples off.
const encode = (buf, seed, { snrDb = 38, lowpass = null } = {}) => {
  const r = rng(seed * 7919 + 3);
  const gain = Math.pow(10, (r() * 12 - 6) / 20);
  const a = lowpass != null ? lowpass : 0.25 + r() * 0.5;
  const pad = Math.floor(r() * 64);
  const out = new Int16Array(buf.length + pad);
  let rms = 0;
  for (let i = 0; i < buf.length; i += 7) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / Math.max(1, buf.length / 7));
  const hiss = rms * Math.pow(10, -snrDb / 20);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y = a * y + (1 - a) * buf[i];
    const v = (y + (r() * 2 - 1) * hiss * 1.7) * gain;
    out[i + pad] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return { pcm: out, pad: pad / SR };
};

// One show: { name, episodes: [{ season, episode, pcm, duration, label }] }
// label: { start, end } in seconds, or null (no intro).
//   o.introS        the theme's length
//   o.cold          [min, max] cold open, seconds
//   o.eps           episodes per season, o.seasons seasons
//   o.headS         how much of each episode is made (the detector reads the head)
//   o.titleCard / o.pauses / o.shortEvery / o.dialogOver / o.recap / o.none / o.snrDb / o.lowpass
//   o.premiere      the first episode has no intro at all (a premiere)
//   o.narrated      the intro is a voice over a score, not a song
//   o.newTheme      season 2 has a theme of its own
//   o.credits       { themeS, mid, post, logo }: the end theme (shared), a
//                   scene in the middle of it, a scene after it, a shared logo
// Each episode also has its `tail` (the last TAIL_S s) with `credits`:
// { start, scene } in the file's clock, and `recap` (the "Previously on"
// range) where there is one.
const makeShow = (name, seed, o = {}) => {
  const r = rng(seed);
  const introS = o.introS || 60;
  const headS = o.headS || 480;
  const seasons = o.seasons || 1;
  const eps = o.eps || 5;
  // the theme, with near-silent pauses when narrated
  let theme = music(introS, seed * 13 + 1);
  // a narrated intro (Avatar: "Water. Earth. Fire. Air…"): a voice over a
  // quieter score — the shared sound is speech as much as music
  if (o.narrated) {
    const voice = speech(introS, seed * 13 + 7, 5000);
    for (let i = 0; i < theme.length; i++) theme[i] = theme[i] * 0.45 + voice[i];
  }
  if (o.pauses) {
    for (const at of [0.3, 0.65]) {
      const a = Math.round(at * introS * SR);
      for (let i = a; i < a + 1.5 * SR && i < theme.length; i++) theme[i] *= 0.002;
    }
  }
  const theme2 = o.newTheme ? music(introS, seed * 13 + 2) : theme;
  const cr = o.credits || {};
  const endTheme = music(cr.themeS || 45, seed * 17 + 5);
  const logo = music(4, seed * 19 + 3);
  const TAIL_S = 240;
  const out = [];
  let prevProg = null;
  for (let s = 1; s <= seasons; s++) {
    for (let e = 1; e <= eps; e++) {
      const k = (s - 1) * eps + e;
      const buf = new Float64Array(Math.round(headS * SR));
      let at = 0;
      let label = null;
      let recap = null;
      // "Previously on": three clips of the episode before
      if (o.recap && prevProg) {
        for (let c = 0; c < 3; c++) {
          const from = Math.round((60 + c * 50) * SR);
          mix(buf, prevProg.subarray(from, from + 6 * SR), at);
          at += 6 * SR;
        }
        recap = { start: 0, end: at / SR };
        at += Math.round(0.5 * SR);
      }
      const [c0, c1] = o.cold || [0, 120];
      const cold = Math.round((c0 + r() * (c1 - c0)) * SR);
      if (cold > 0) mix(buf, programme(cold / SR + 1, seed * 1000 + k * 3).subarray(0, cold), at);
      at += cold;
      const prog = programme(headS, seed * 1000 + k * 3 + 1);
      if (o.none || (o.premiere && k === 1)) {
        // every episode its own "theme": nothing is shared
        mix(buf, music(introS, seed * 13 + 100 + k), at);
        at += introS * SR;
      } else {
        const short = o.shortEvery && k % o.shortEvery === 0;
        const th = s >= 2 ? theme2 : theme;
        const t = short ? th.subarray(0, Math.round(th.length * 0.6)) : th;
        mix(buf, t, at);
        label = { start: at / SR, end: (at + t.length) / SR };
        if (o.dialogOver) mix(buf, speech(3, seed * 1000 + k * 3 + 2, 5000), at, 1);
        at += t.length;
      }
      mix(buf, prog, at);
      prevProg = prog;
      const { pcm, pad } = encode(buf, seed * 100 + k, { snrDb: o.snrDb, lowpass: o.lowpass });
      if (label) label = { start: label.start + pad, end: label.end + pad };
      if (recap) recap = { start: recap.start + pad, end: recap.end + pad };
      // the tail: the last scene, the end theme (a scene inside it), a scene
      // after it, a logo, then quiet
      const duration = o.durationS || 2400;
      const tb = new Float64Array(TAIL_S * SR);
      const lastScene = 60 + Math.floor(r() * 110);
      mix(tb, programme(lastScene + 1, seed * 1000 + k * 3 + 7).subarray(0, lastScene * SR), 0);
      let ta = lastScene * SR;
      const credits = { start: lastScene, scene: false };
      if (cr.mid) {
        const first = Math.round(15 * SR);
        mix(tb, endTheme.subarray(0, first), ta);
        ta += first;
        mix(tb, programme(21, seed * 1000 + k * 3 + 8).subarray(0, 20 * SR), ta);
        ta += 20 * SR;
        mix(tb, endTheme.subarray(first), ta);
        ta += endTheme.length - first;
      } else {
        mix(tb, endTheme, ta);
        ta += endTheme.length;
      }
      if (cr.post) {
        mix(tb, programme(26, seed * 1000 + k * 3 + 9).subarray(0, 25 * SR), ta);
        ta += 25 * SR;
        credits.scene = true;
      }
      if (cr.logo) mix(tb, logo, ta);
      const enc = encode(tb, seed * 100 + k + 50, { snrDb: o.snrDb, lowpass: o.lowpass });
      const tailStart = duration - TAIL_S;
      credits.start = tailStart + credits.start + enc.pad;
      out.push({ show: name, season: s, episode: e, pcm, duration, label, recap, tail: enc.pcm, tailStart, credits });
    }
  }
  return { name, episodes: out };
};

// The labelled set. `quick`: a small one for the unit test.
const SHOWS = [
  ["plain", 11, { introS: 60, cold: [0, 120] }],
  ["long cold opens", 12, { introS: 100, cold: [60, 400], headS: 560 }],
  ["title card", 13, { introS: 10, cold: [30, 200], headS: 320 }],
  ["narrated, with pauses", 14, { introS: 45, cold: [10, 90], pauses: true }],
  ["short versions", 15, { introS: 70, cold: [20, 150], shortEvery: 2 }],
  ["dialogue over the start", 16, { introS: 50, cold: [5, 60], dialogOver: true }],
  ["previously on", 17, { introS: 40, cold: [10, 80], recap: true }],
  ["rough encodes", 18, { introS: 55, cold: [0, 100], snrDb: 18, lowpass: 0.8 }],
  ["two seasons", 19, { introS: 30, cold: [0, 60], seasons: 2, eps: 3, headS: 300 }],
  ["no intro", 20, { introS: 40, cold: [0, 100], none: true }],
  ["no intro, previously on", 21, { introS: 40, cold: [0, 100], none: true, recap: true }],
  ["a premiere without the intro", 22, { introS: 45, cold: [10, 90], premiere: true }],
  ["a new theme in season 2", 23, { introS: 40, cold: [0, 60], seasons: 2, eps: 3, headS: 300, newTheme: true }],
  ["credits with a scene inside", 24, { introS: 40, cold: [0, 60], credits: { themeS: 60, mid: true, logo: true } }],
  ["narration over a score", 26, { introS: 50, cold: [0, 30], narrated: true, credits: { themeS: 50 } }],
  ["credits, then a scene", 25, { introS: 40, cold: [0, 60], credits: { themeS: 40, post: true, logo: true } }],
];
const QUICK = [
  ["plain", 31, { introS: 40, cold: [0, 60], eps: 4, headS: 200 }],
  ["narrated, with pauses", 34, { introS: 35, cold: [5, 50], pauses: true, eps: 4, headS: 200 }],
  ["no intro", 35, { introS: 30, cold: [0, 40], none: true, eps: 3, headS: 160 }],
  ["previously on, credits then a scene", 36, { introS: 30, cold: [0, 40], recap: true, eps: 4, headS: 200, credits: { themeS: 35, post: true } }],
];
const labelledSet = ({ quick = false } = {}) => (quick ? QUICK : SHOWS).map(([n, s, o]) => makeShow(n, s, o));

module.exports = { SR, makeShow, labelledSet, music, speech, programme, encode, rng };
