// The remark picker. PURE: everything it needs comes in, the memory object it
// is handed is updated in place (plain JSON, so tests can read it).
//
//   memory = {
//     held:   { id, text, kind, at } | null   the line on screen now
//     recent: [id, ...]                       the last RECENT ids shown, oldest first
//     used:   { kind: [id, ...] }             ids of a kind shown since it last ran dry
//     kinds:  [kind, ...]                     the last KIND_MEMORY kinds shown
//   }
//
// How "a different thing each time" works:
// - a line is held for HOLD_MS, so going into a title and back keeps it;
// - after that each visit draws a kind by weight, with a kind shown lately
//   damped (so one situation does not take over), then a line of that kind it
//   has not used since the kind last ran dry, and never one of the last
//   RECENT lines shown, whatever their kind.
"use strict";

const { KINDS, fill } = require("./bank");

const HOLD_MS = 10 * 60 * 1000;
const RECENT = 40;
const KIND_MEMORY = 6;
const KIND_DAMP = 0.4; // weight × KIND_DAMP per showing among the last KIND_MEMORY
const LAST_DAMP = 0.25; // and × LAST_DAMP more for the kind shown last time

const newMemory = () => ({ held: null, recent: [], used: {}, kinds: [] });

// Ids a client says it has seen (after a server restart, memory starts empty):
// folded in as the oldest part of `recent`.
const absorbSeen = (memory, seen) => {
  if (!Array.isArray(seen) || !seen.length) return;
  const have = new Set(memory.recent);
  const older = seen.filter((id) => !have.has(id));
  memory.recent = [...older, ...memory.recent].slice(-RECENT);
};

// The lines of one kind that can be said with these fields.
const sayable = (kind, fields) => {
  const def = KINDS[kind];
  if (!def) return [];
  const out = [];
  for (const line of def.lines) {
    if (!line) continue;
    const text = fill(line.text, fields, def);
    if (text) out.push({ id: line.id, text, kind });
  }
  return out;
};

const weightOf = (cand, memory) => {
  const shown = memory.kinds.filter((k) => k === cand.kind).length;
  const last = memory.kinds[memory.kinds.length - 1] === cand.kind ? LAST_DAMP : 1;
  return Math.max(0, cand.weight) * Math.pow(KIND_DAMP, shown) * last;
};

const draw = (cands, memory, rng) => {
  const total = cands.reduce((s, c) => s + weightOf(c, memory), 0);
  if (total <= 0) return cands[0];
  let r = rng() * total;
  for (const c of cands) {
    r -= weightOf(c, memory);
    if (r < 0) return c;
  }
  return cands[cands.length - 1];
};

// cands: [{ kind, weight, fields }] — what applies right now (situations.js).
// Returns { id, text, kind, held } or null when nothing at all can be said.
const pick = (cands, memory, { now = Date.now(), rng = Math.random, hold = HOLD_MS } = {}) => {
  if (memory.held && now - memory.held.at >= 0 && now - memory.held.at < hold) {
    return { id: memory.held.id, text: memory.held.text, kind: memory.held.kind, held: true };
  }
  const recent = new Set(memory.recent);
  let pool = cands.filter((c) => KINDS[c.kind]);
  while (pool.length) {
    const cand = draw(pool, memory, rng);
    const lines = sayable(cand.kind, cand.fields);
    const notRecent = lines.filter((l) => !recent.has(l.id));
    if (!notRecent.length) { pool = pool.filter((c) => c !== cand); continue; }
    let used = new Set(memory.used[cand.kind] || []);
    let fresh = notRecent.filter((l) => !used.has(l.id));
    if (!fresh.length) { used = new Set(); fresh = notRecent; } // ran dry: start the kind over
    const line = fresh[Math.floor(rng() * fresh.length) % fresh.length];
    used.add(line.id);
    memory.used[cand.kind] = [...used];
    memory.recent = [...memory.recent.filter((id) => id !== line.id), line.id].slice(-RECENT);
    memory.kinds = [...memory.kinds, cand.kind].slice(-KIND_MEMORY);
    memory.held = { id: line.id, text: line.text, kind: cand.kind, at: now };
    return { id: line.id, text: line.text, kind: cand.kind, held: false };
  }
  // Everything that applies was said lately (a tiny bank and a long memory):
  // the least recently shown line of what applies, rather than silence.
  const all = cands.flatMap((c) => sayable(c.kind, c.fields));
  if (!all.length) return null;
  const age = (l) => memory.recent.indexOf(l.id);
  const line = all.reduce((a, b) => (age(b) < age(a) ? b : a));
  memory.recent = [...memory.recent.filter((id) => id !== line.id), line.id].slice(-RECENT);
  memory.held = { id: line.id, text: line.text, kind: line.kind, at: now };
  return { id: line.id, text: line.text, kind: line.kind, held: false };
};

module.exports = { pick, newMemory, absorbSeen, sayable, HOLD_MS, RECENT, KIND_MEMORY };
