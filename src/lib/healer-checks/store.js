// What the healer has to remember across restarts, in one small file
// (data/healer.json): the error fingerprints it has already seen, errors per
// hour for the last two weeks, each day's playback and download numbers (the
// baselines), how often each automatic repair has run (the circuit breaker),
// the last twenty repairs, the AI budget, and a few "already said" marks.
//
// Created on first use, never at require time — a unit test that requires a
// check module does not touch the real data folder; tests hand in a memory
// store with useMemory().
"use strict";
const path = require("path");

const defaults = () => ({
  fingerprints: {}, // fp -> { first, last, n, sample, reported, ai }
  errHours: {}, // "2026-10-08T14" -> problem lines that hour
  days: {}, // "2026-10-08" -> { plays, started, startFailures, stalls, errors, ttffP50, sessions, abnormal, watchSec }
  repairs: {}, // "<repair>|<subject>" -> [ms…] of automatic runs
  repairLog: [], // newest last: { at, repair, action, subject, why, runId, outcome, said }
  ai: { day: null, n: 0 },
  growth: {}, // name -> [{ at, bytes }]
  notes: {}, // one-off "already said" marks
  delivery: {}, // channel -> last known outcome (survives a restart)
  roots: {}, // library folder -> { ok, since }
  declinedSeen: {}, // jit declined key -> first seen (ms)
  memo: {}, // small cached facts (lock drift, clock)
});

let s = null;
const fill = (data) => {
  const d = defaults();
  for (const k of Object.keys(d)) if (data[k] == null || typeof data[k] !== typeof d[k] || Array.isArray(data[k]) !== Array.isArray(d[k])) data[k] = d[k];
  return data;
};

const get = () => {
  if (s) return s;
  const config = require("../../config");
  const { JsonStore } = require("../jsonstore");
  s = new JsonStore(path.join(config.DATA_DIR, "healer.json"), defaults);
  if (!s.data || typeof s.data !== "object" || Array.isArray(s.data)) s.data = defaults();
  fill(s.data);
  return s;
};
const data = () => get().data;
const save = () => get().save();

// Tests: a store that lives in memory and is never written anywhere.
const useMemory = (seed = {}) => {
  s = { data: fill({ ...seed }), save() {}, flush() {}, memory: true };
  return s;
};

module.exports = { get, data, save, useMemory, defaults };
