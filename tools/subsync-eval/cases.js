// The test cases of the subtitle-sync evaluation: per item, a list of
//   { label, group, cues: [{start, end, truth}], edit?, expect }
// truth: where the line really belongs in the audio aligned against (null:
// the audio has no such line — dialogue of a scene this release lacks).
// edit: an AUDIO-side change (common.editedRows) — the reference is then
// aligned, untouched, to audio that differs the way another release does.
// expect: "fix" (move it right), "keep" (in time: change nothing),
// "refuse" (not this audio: must come out "unmatched").
"use strict";
const as = require("../../src/media/audiosync");

const truthOf = (q) => (q.truth !== undefined ? q.truth : q.start);
const withTruth = (cues) => cues.map((q) => ({ start: q.start, end: q.end, truth: q.start }));
const shift = (cues, d) => cues.map((q) => ({ start: q.start + d, end: q.end + d, truth: truthOf(q) })).filter((q) => q.start > 0);
const scale = (cues, k, d = 0) => cues.map((q) => ({ start: q.start * k + d, end: q.end * k + d, truth: truthOf(q) })).filter((q) => q.start > 0);
// the subtitle's release has `len` s more at `at` (fraction of the lines):
// later lines are late by len, and the extra scene has lines of its own
// (copied from 10 minutes later: dialogue this audio does not have there)
const extraScene = (cues, at, len, d = 0) => {
  const t = cues[Math.floor(cues.length * at)].start - 0.5;
  const out = cues.map((q) => (q.start < t ? { start: q.start + d, end: q.end + d, truth: truthOf(q) } : { start: q.start + len + d, end: q.end + len + d, truth: truthOf(q) }));
  const base = t + 600;
  const donor = cues.filter((q) => q.start > base && q.end < base + len - 1);
  for (const q of donor) out.push({ start: t + d + (q.start - base) + 0.5, end: t + d + (q.end - base) + 0.5, truth: null });
  return out.sort((a, b) => a.start - b.start).filter((q) => q.start > 0);
};
// this audio has `len` s the subtitle's release does not: the lines after
// `at` are early by len, and the lines of those seconds are missing
const missingScene = (cues, at, len, d = 0) => {
  const t = cues[Math.floor(cues.length * at)].start - 0.5;
  return cues
    .filter((q) => q.start < t - 0.2 || q.start > t + len)
    .map((q) => (q.start < t ? { start: q.start + d, end: q.end + d, truth: truthOf(q) } : { start: q.start - len + d, end: q.end - len + d, truth: truthOf(q) }))
    .filter((q) => q.start > 0);
};
// the reference against EDITED audio: truth through the edit
const throughEdit = (cues, e, map) => cues.map((q) => ({ start: q.start, end: q.end, truth: map(e, q.start) }));

const r1 = (x) => Math.round(x * 100) / 100;

// -> cases for one item
const casesFor = ({ name, ref, ref2, dur, other, siblings, mapThrough }) => {
  const base = withTruth(ref);
  const out = [];
  const add = (label, group, cues, expect, edit = null) => out.push({ label, group, cues, expect, edit });
  add("reference as is", "control", base, "keep");
  if (ref2) add("second English track (SDH/CC) as is", "control", withTruth(ref2), "keep");
  add("+0.3 s", "small", shift(base, 0.3), "fix");
  add("-0.5 s", "small", shift(base, -0.5), "fix");
  add("+2.5 s", "shift", shift(base, 2.5), "fix");
  add("-12 s", "shift", shift(base, -12), "fix");
  add("+55.7 s", "shift", shift(base, 55.7), "fix");
  for (const k of as.SCALES.slice(1)) add(`x${k.toFixed(5)}`, "fps", scale(base, k), "fix");
  add("x24/23.976 +55.7 s (Inception Hebrew 3)", "fps", scale(base, 24 / 23.976, 55.7), "fix");
  add("x25/23.976 -3 s", "fps", scale(base, 25 / 23.976, -3), "fix");
  add("subtitle has an extra 45 s scene at 40 %", "scene", extraScene(base, 0.4, 45), "fix");
  add("subtitle misses 30 s at 60 %", "scene", missingScene(base, 0.6, 30), "fix");
  add("+3 s, misses 20 s at 10 %, extra 60 s at 70 %", "scene", extraScene(missingScene(base, 0.1, 20), 0.7, 60, 3), "fix");
  add("x23.976/25 +1 s, extra 45 s at 50 %", "scene", scale(extraScene(base, 0.5, 45), 23.976 / 25, 1), "fix");
  // audio side: another cut of the film
  const at35 = r1(dur * 0.35);
  const at50 = r1(dur * 0.5);
  const credits = r1(Math.max(0, dur - 150)); // the end credits' music: a "logo"
  const cut = { kind: "cut", at: at35, len: 40 };
  add("audio lacks 40 s at 35 %", "audio", throughEdit(base, cut, mapThrough), "fix", cut);
  const logo = { kind: "insert", at: 0, len: 30, from: credits };
  add("audio has a 30 s logo/music at the start", "audio", throughEdit(base, logo, mapThrough), "fix", logo);
  const recap = { kind: "insert", at: at50, len: 30, from: r1(dur * 0.2) };
  add("audio has a 30 s recap (speech) at 50 %", "audio", throughEdit(base, recap, mapThrough), "fix", recap);
  add("audio lacks 40 s at 35 %, subtitle +2.5 s", "audio", shift(throughEdit(base, cut, mapThrough), 2.5), "fix", cut);
  // controls that must be refused
  if (other) add(`another film's subtitle (${other.name})`, "refuse", other.ref.map((q) => ({ ...q, truth: null })), "refuse");
  for (const s of siblings || []) add(`another episode's subtitle (${s.name})`, "refuse", s.ref.map((q) => ({ ...q, truth: null })), "refuse");
  return out;
};

module.exports = { casesFor, shift, scale, extraScene, missingScene, withTruth };
