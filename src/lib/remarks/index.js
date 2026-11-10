// Home's remark and Wrapped's roasts, one source of truth for every app.
//
// Memory is per profile and in this process only — no disk write per request.
// After a restart it starts empty, and two things keep the promise of "not
// the same thing again": the apps send back the ids they were shown lately
// (`seen`, ids only), which become the oldest part of the no-repeat window,
// and they keep the line they were given for the ten-minute hold themselves.
// What is lost on a restart is only which lines of a kind were used since it
// last ran dry — a fresh lap of that kind, minus the lines the app sent back.
"use strict";

const { pick, newMemory, absorbSeen, RECENT } = require("./picker");
const { clockOf, situationsFor } = require("./situations");
const { factsFor } = require("./facts");
const { roastsFrom } = require("./roasts");
const { ID_RE, BY_ID } = require("./bank");

const MAX_PROFILES = 500;
const memories = new Map(); // profileId → picker memory (+ visits)
const roastMemories = new Map();

const memoryOf = (map, id) => {
  let m = map.get(id);
  if (!m) {
    m = newMemory();
    map.set(id, m);
    if (map.size > MAX_PROFILES) map.delete(map.keys().next().value);
  }
  return m;
};

// `seen` from the query: "em-3,aw-2,…" — known ids only, at most RECENT.
const parseSeen = (raw) => String(raw || "").split(",").map((s) => s.trim())
  .filter((id) => ID_RE.test(id) && BY_ID.has(id)).slice(-RECENT);

// profile: { id, name, kids }. opts: { now, tzo, tz, seen }.
const remarkFor = (profile, { now = Date.now(), tzo, tz, seen } = {}) => {
  const clock = clockOf(now, tzo, tz);
  const memory = memoryOf(memories, profile.id);
  absorbSeen(memory, parseSeen(seen));
  const kids = !!profile.kids;
  const facts = kids ? {} : factsFor(profile, { now, tzo: clock.tzo });
  // visits today that drew a fresh line, for "several visits, nothing played"
  const day = new Date(now - clock.tzo * 60000).toISOString().slice(0, 10);
  if (!memory.visits || memory.visits.day !== day) memory.visits = { day, n: 0 };
  const browsingToday = facts.playedToday ? 0 : memory.visits.n;
  const cands = situationsFor({ ...facts, browsingToday }, clock, { kids });
  const got = pick(cands, memory, { now });
  if (!got) return null;
  if (!got.held) memory.visits.n++;
  return { id: got.id, text: got.text, kind: got.kind };
};

// Wrapped: up to four roasts, different takes on each visit.
const roastsFor = (profile, w, opts = {}) =>
  roastsFrom(w, profile.name, memoryOf(roastMemories, profile.id), { kids: !!profile.kids, ...opts });

const _reset = () => { memories.clear(); roastMemories.clear(); require("./facts")._reset(); };

module.exports = { remarkFor, roastsFor, parseSeen, _reset };
