// What the server's Wrapped answer carries for the story (src/telemetry.js
// wrappedFor, 2026-11-10): the week and the day, the nights, the best
// streak's span, which top titles are shows — additive: everything the
// older apps read is unchanged.
const test = require("node:test");
const assert = require("node:assert/strict");

const telemetry = require("../src/telemetry");
const js = require("../src/lib/jsonstore");

const kept = [];
test.before(() => { kept.push(...telemetry.sessions.data.splice(0)); });
test.after(() => { telemetry.sessions.data.length = 0; telemetry.sessions.data.push(...kept); js.flushAll(); });

// local times, as the store keeps ISO strings
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const S = (profile, content, startedAt, min, device = "TV") => ({ id: Math.random().toString(16).slice(2), profile, content, startedAt, watchedSec: min * 60, device: { device } });

test("the story's fields: weekday and hour totals, the nights, the streak, shows marked", () => {
  telemetry.sessions.data.length = 0;
  telemetry.sessions.data.push(
    S("Wren", "Low Orbit · S1 E1", at(2026, 3, 2, 21), 50), // a Monday
    S("Wren", "Low Orbit · S1 E2", at(2026, 3, 3, 21), 40),
    S("Wren", "Low Orbit · S1 E3", at(2026, 3, 4, 22), 30),
    S("Wren", "Arcadia Bay", at(2026, 3, 10, 1, 30), 90, "Mobile"), // after midnight
    S("Wren", "Arcadia Bay", at(2026, 3, 11, 20), 20),
    S("Wren", "Arcadia Bay", at(2026, 3, 12, 20), 20),
    S("Wren", "Arcadia Bay", at(2026, 3, 13, 20), 20), // a second run of three: the LATER one is kept
    S("Other", "Low Orbit · S1 E4", at(2026, 3, 5, 21), 99),
  );
  const w = telemetry.wrappedFor("Wren");
  assert.equal(w.plays, 7);
  // sums: the week and the day add up to everything
  assert.equal(w.byWeekday.length, 7);
  assert.equal(w.byHour.length, 24);
  assert.equal(w.byWeekday.reduce((a, b) => a + b, 0), w.totalSec);
  assert.equal(w.byHour.reduce((a, b) => a + b, 0), w.totalSec);
  assert.equal(w.byHour[21], 90 * 60);
  assert.equal(w.byHour[1], 90 * 60);
  assert.equal(w.byWeekday[1], 50 * 60); // Monday 2 March
  // the nights: oldest first, days after nightsFrom, minutes
  assert.equal(w.nightsFrom, "2026-03-02");
  assert.deepEqual(w.nights, [[0, 50], [1, 40], [2, 30], [8, 90], [9, 20], [10, 20], [11, 20]]);
  // two streaks: 2–4 March (3) and 10–13 March (4): the longer
  assert.equal(w.bestStreak, 4);
  assert.deepEqual(w.streak, { from: "2026-03-10", to: "2026-03-13" });
  // shows are marked, films are not
  assert.deepEqual(w.topTitles.map((t) => [t.name, !!t.show]), [["Arcadia Bay", false], ["Low Orbit", true]]);
  // what the older apps read is all still there
  for (const k of ["since", "totalSec", "plays", "distinctTitles", "topTitles", "topWeekday", "byDevice", "biggestDay", "bestStreak", "lateNightSessions", "latestFinish", "longestSession", "activeDays"]) assert.ok(k in w, k);
  assert.equal(w.lateNightSessions, 1);
});

test("equal streaks: the later one is the constellation", () => {
  telemetry.sessions.data.length = 0;
  telemetry.sessions.data.push(
    S("Wren", "A", at(2026, 5, 1, 20), 30), S("Wren", "A", at(2026, 5, 2, 20), 30),
    S("Wren", "A", at(2026, 5, 9, 20), 30), S("Wren", "A", at(2026, 5, 10, 20), 30),
  );
  const w = telemetry.wrappedFor("Wren");
  assert.equal(w.bestStreak, 2);
  assert.deepEqual(w.streak, { from: "2026-05-09", to: "2026-05-10" });
});

test("one sitting: a streak of one, one night, nothing breaks; no sittings: empty", () => {
  telemetry.sessions.data.length = 0;
  telemetry.sessions.data.push(S("Wren", "A", at(2026, 6, 1, 20), 42));
  const w = telemetry.wrappedFor("Wren");
  assert.equal(w.bestStreak, 1);
  assert.deepEqual(w.streak, { from: "2026-06-01", to: "2026-06-01" });
  assert.deepEqual(w.nights, [[0, 42]]);
  assert.deepEqual(telemetry.wrappedFor("Nobody"), { empty: true });
});

test("the nights are capped to the most recent 400", () => {
  telemetry.sessions.data.length = 0;
  for (let d = 0; d < 450; d++) telemetry.sessions.data.push(S("Wren", "A", new Date(2025, 0, 1 + d, 20).toISOString(), 10));
  const w = telemetry.wrappedFor("Wren");
  assert.equal(w.nights.length, 400);
  assert.equal(w.activeDays, 450);
  assert.equal(w.nights[0][0], 0);
  assert.equal(w.nights[399][0], 399);
  assert.equal(w.bestStreak, 450);
});
