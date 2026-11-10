// Aurora's remarks (src/lib/remarks): the bank's rules, the picker's promises
// (no repeat until a situation runs dry, no repeat of the last 40, the
// ten-minute hold, variety of subject), kids, the situations from the clock,
// the facts from a person's own viewing only, and Wrapped's roasts.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { KINDS, fill, HOME_MAX, ROAST_MAX, FIELD_MAX, ROAST_FIELD_MAX } = require("../src/lib/remarks/bank");
const { pick, newMemory, absorbSeen, sayable, HOLD_MS, RECENT } = require("../src/lib/remarks/picker");
const { clockOf, situationsFor } = require("../src/lib/remarks/situations");
const { factsFrom } = require("../src/lib/remarks/facts");
const { roastsFrom, rulesFor } = require("../src/lib/remarks/roasts");

const seeded = (seed = 7) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const longest = (limits) => Object.fromEntries(Object.entries(limits).map(([k, n]) => [k, k === "n" || k === "m" || k === "pct" || k === "hour" ? "9".repeat(n) : "W".repeat(n)]));

test("every line fits its cap with the longest allowed fields, and names only fields that exist", () => {
  const known = new Set([...Object.keys(FIELD_MAX), ...Object.keys(ROAST_FIELD_MAX)]);
  let n = 0;
  for (const def of Object.values(KINDS)) {
    const fields = longest(def.fieldMax);
    for (const line of def.lines) {
      if (!line) continue;
      n++;
      for (const [, key] of line.text.matchAll(/\{([a-z]+)\}/g)) {
        assert.ok(known.has(key) && def.fieldMax[key], `${line.id}: unknown field {${key}}`);
      }
      const text = fill(line.text, fields, def);
      assert.ok(text, `${line.id} does not fit ${def.max} with the longest fields: ${line.text}`);
      assert.ok(text.length <= (def.roast ? ROAST_MAX : HOME_MAX));
      assert.ok(!/[!]/.test(line.text), `${line.id}: no exclamation marks`);
      assert.ok(!/\p{Extended_Pictographic}/u.test(line.text), `${line.id}: no emoji`);
    }
  }
  assert.ok(n >= 400, `a bank of 400+ lines (${n})`);
});

test("no line twice, no code twice, every situation has enough takes", () => {
  const seen = new Map();
  for (const def of Object.values(KINDS)) {
    const lines = def.lines.filter(Boolean);
    const min = def.roast ? 4 : def.place ? 8 : def.kids ? 8 : 12;
    assert.ok(lines.length >= min, `${def.kind}: ${lines.length} lines, want ${min}+`);
    for (const l of lines) {
      const key = l.text.toLowerCase().replace(/[^a-z{}]+/g, " ").trim();
      assert.ok(!seen.has(key), `${l.id} repeats ${seen.get(key)}`);
      seen.set(key, l.id);
    }
  }
  const everyday = ["everyday-morning", "everyday-afternoon", "everyday-evening", "everyday-night", "everyday-any"]
    .reduce((s, k) => s + KINDS[k].lines.filter(Boolean).length, 0);
  assert.ok(everyday >= 100, `100+ everyday lines (${everyday})`);
});

test("a too-long title skips the template; a missing field skips it; sentences start upper-case", () => {
  const def = KINDS["left-show"];
  assert.equal(fill("{title} waits.", { title: "W".repeat(23) }, def), null);
  assert.equal(fill("{title} waits.", {}, def), null);
  assert.equal(fill("{genre} again. {genre} always.", { genre: "horror" }, KINDS["genre-diet"]), "Horror again. Horror always.");
  // a long title leaves the situation's title-free lines
  const lines = sayable("left-show", { title: "A Title Far Too Long For The Hero" });
  assert.ok(lines.length >= 2 && lines.every((l) => !l.text.includes("Far Too Long")));
});

test("no repeat until a situation's lines are all used, then a fresh lap", () => {
  const kind = "everyday-night";
  const n = sayable(kind, {}).length;
  const memory = newMemory();
  const rng = seeded(3);
  const ids = [];
  let now = 0;
  for (let i = 0; i < n; i++) { now += HOLD_MS; ids.push(pick([{ kind, weight: 1, fields: {} }], memory, { now, rng }).id); }
  assert.equal(new Set(ids).size, n, "every line once before any repeats");
  now += HOLD_MS;
  const next = pick([{ kind, weight: 1, fields: {} }], memory, { now, rng });
  assert.ok(next, "and after the lap, still something to say");
});

test("never one of the last 40 lines, across situations", () => {
  const memory = newMemory();
  const rng = seeded(11);
  const cands = [
    { kind: "everyday-evening", weight: 3, fields: {} }, { kind: "everyday-any", weight: 2, fields: {} },
    { kind: "streak", weight: 4, fields: { n: 6 } }, { kind: "mylist-grows", weight: 2, fields: { n: 31 } },
  ];
  const shown = [];
  let now = 0;
  for (let i = 0; i < 200; i++) {
    now += HOLD_MS + 1;
    const r = pick(cands, memory, { now, rng });
    assert.ok(!shown.slice(-RECENT).includes(r.id), `${r.id} again within ${RECENT}`);
    shown.push(r.id);
  }
});

test("the ten-minute hold: the same line until it runs out, then a new one", () => {
  const memory = newMemory();
  const cands = [{ kind: "everyday-any", weight: 1, fields: {} }];
  const a = pick(cands, memory, { now: 1000 });
  assert.equal(pick(cands, memory, { now: 1000 + 9 * 60000 }).id, a.id);
  assert.equal(pick(cands, memory, { now: 1000 + 9 * 60000 }).held, true);
  assert.notEqual(pick(cands, memory, { now: 1000 + HOLD_MS }).id, a.id);
});

test("variety of subject: one heavy situation does not take every visit", () => {
  const memory = newMemory();
  const rng = seeded(5);
  const clock = clockOf(Date.parse("2026-11-10T18:00:00Z"), -120, "Asia/Jerusalem");
  const cands = situationsFor({ awayMs: 40 * 86400000, myList: 60, genre: "horror" }, clock);
  const kinds = [];
  for (let i = 0; i < 30; i++) kinds.push(pick(cands, memory, { now: (i + 1) * HOLD_MS, rng }).kind);
  const most = Math.max(...[...new Set(kinds)].map((k) => kinds.filter((x) => x === k).length));
  assert.ok(most <= 12, `one kind took ${most} of 30`);
  assert.ok(kinds.some((k) => k.startsWith("everyday-")), "plain everyday lines get through");
  for (let i = 1; i < kinds.length; i++) {
    if (i >= 2) assert.ok(!(kinds[i] === kinds[i - 1] && kinds[i] === kinds[i - 2]), `three ${kinds[i]} in a row`);
  }
});

test("the ids an app sends back after a restart are not said again", () => {
  const memory = newMemory();
  const all = sayable("lunch", {}).map((l) => l.id);
  absorbSeen(memory, all.slice(0, all.length - 1));
  const r = pick([{ kind: "lunch", weight: 1, fields: {} }], memory, { now: 1 });
  assert.equal(r.id, all[all.length - 1]);
});

test("kids profiles only ever get kids kinds, at every hour and on holidays", () => {
  for (const iso of ["2026-12-25T08:00:00Z", "2026-10-31T21:00:00Z", "2026-11-13T02:00:00Z", "2026-11-14T14:00:00Z"]) {
    const clock = clockOf(Date.parse(iso), 0, "Europe/London");
    const cands = situationsFor({ awayMs: 60 * 86400000, myList: 99, ratings: "harsh" }, clock, { kids: true });
    assert.ok(cands.length && cands.every((c) => KINDS[c.kind].kids), JSON.stringify(cands.map((c) => c.kind)));
  }
  for (const def of Object.values(KINDS)) if (def.kids) assert.ok(def.kind.startsWith("kids-") || def.kind === "roast-kids");
});

test("the clock is the viewer's: hour, weekday, weekend by zone, holidays", () => {
  const now = Date.parse("2026-11-13T23:30:00Z"); // Saturday 01:30 in Israel, Friday 23:30 in London
  const il = clockOf(now, -120, "Asia/Jerusalem");
  assert.deepEqual([il.hour, il.weekday, il.date], [1, 6, 14]);
  const uk = clockOf(now, 0, "Europe/London");
  assert.deepEqual([uk.hour, uk.weekday, uk.date], [23, 5, 13]);
  assert.ok(situationsFor({}, uk).some((c) => c.kind === "friday-13"));
  // Sunday is the first workday in Israel, a weekend day in London
  const sunday = Date.parse("2026-11-15T07:00:00Z");
  assert.ok(situationsFor({}, clockOf(sunday, -120, "Asia/Jerusalem")).some((c) => c.kind === "week-start" && c.fields.day === "Sunday"));
  assert.ok(situationsFor({}, clockOf(sunday, 0, "Europe/London")).some((c) => c.kind === "weekend-morning"));
  assert.ok(situationsFor({}, clockOf(Date.parse("2026-12-31T20:00:00Z"), 0, "")).some((c) => c.kind === "new-years-eve"));
  assert.ok(situationsFor({}, clockOf(Date.parse("2026-11-10T01:00:00Z"), 0, "")).some((c) => c.kind === "now-3am") === false);
  assert.ok(situationsFor({}, clockOf(Date.parse("2026-11-10T03:00:00Z"), 0, "")).some((c) => c.kind === "now-3am"));
});

test("facts come from the sessions handed in, in the viewer's day", () => {
  const now = Date.parse("2026-11-10T10:00:00Z"); // 12:00 in Israel
  const at = (h) => new Date(now - h * 3600000).toISOString();
  const f = factsFrom({
    now, tzo: -120,
    sessions: [
      { startedAt: at(9), watchedSec: 3600, content: "Slow Horses · S1 E2" }, // 03:00 today, local
      { startedAt: at(30), watchedSec: 5 * 3600, content: "Heat" }, // yesterday, 5 hours
    ],
    myList: 21, ratings: { a: 1, b: 2, c: 1, d: 2, e: 3, f: 1 },
  });
  assert.equal(f.lateLastNight, true);
  assert.equal(f.yesterdayHours, 5);
  assert.equal(f.streak, 2);
  assert.equal(f.ratings, "harsh");
  assert.equal(f.myList, 21);
  assert.equal(f.firstVisit, false);
  assert.ok(f.awayMs < 86400000);
  assert.equal(factsFrom({ now, tzo: 0, sessions: [], progress: {} }).firstVisit, true);
});

test("facts read only this person's history (gathered from the live stores)", () => {
  const path = require("path");
  const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  const now = Date.now();
  const iso = (h) => new Date(now - h * 3600000).toISOString();
  stub("src/telemetry.js", { sessions: { data: [
    { profile: "Eli", startedAt: iso(26), watchedSec: 6 * 3600, content: "Marathon" },
    { profile: "Dana", startedAt: iso(50), watchedSec: 1800, content: "Short" },
  ] } });
  stub("src/profiles.js", {
    stateOf: () => ({ progress: {}, titles: {}, ratings: {} }), getWatchlist: (id) => (id === "eli" ? new Array(40).fill({}) : []),
    getProgressView: () => ({}), getStreamItems: () => ({}), nextEpisode: () => null,
  });
  stub("src/media/scanner.js", { allItems: () => [], findById: () => null, idForPath: () => "x" });
  stub("src/media/downloads.js", { rawJobs: () => [{ profile: "eli", status: "done", doneAt: iso(100), destPath: "/m/x.mkv" }] });
  stub("src/media/newEpisodes.js", { select: () => [] });
  const factsPath = require.resolve("../src/lib/remarks/facts");
  delete require.cache[factsPath];
  const { factsFor } = require("../src/lib/remarks/facts");
  const dana = factsFor({ id: "dana", name: "Dana" }, { now, tzo: 0 });
  assert.equal(dana.yesterdayHours, 0);
  assert.equal(dana.myList, 0);
  assert.equal(dana.unwatchedDownloads, 0);
  const eli = factsFor({ id: "eli", name: "Eli" }, { now, tzo: 0 });
  assert.equal(eli.myList, 40);
  assert.equal(eli.unwatchedDownloads, 1);
  for (const rel of ["src/telemetry.js", "src/profiles.js", "src/media/scanner.js", "src/media/downloads.js", "src/media/newEpisodes.js"]) {
    delete require.cache[require.resolve(path.join(__dirname, "..", rel))];
  }
  delete require.cache[factsPath];
});

test("Wrapped's roasts: up to four, one per rule, different takes on the next visit; kids get warm ones", () => {
  const w = {
    totalSec: 100 * 3600, plays: 80, distinctTitles: 12, started: 12, finished: 3,
    topTitles: [{ name: "The Bear", sec: 55 * 3600 }], latestFinish: { hour: 4, title: "Heat" },
    lateNightSessions: 9, biggestDay: { day: "2026-09-30", sec: 7 * 3600 }, bestStreak: 9,
    byDevice: [{ name: "Mobile", sec: 1 }, { name: "TV", sec: 1 }], topGenres: [{ name: "Drama", sec: 70 * 3600 }],
    longestSession: { title: "Heat", watchedSec: 4 * 3600 }, topWeekday: 5,
  };
  assert.ok(rulesFor(w, "Dana").length > 4);
  const memory = newMemory();
  const rng = seeded(9);
  const first = roastsFrom(w, "Dana", memory, { rng });
  const second = roastsFrom(w, "Dana", memory, { rng });
  assert.equal(first.length, 4);
  assert.ok(first.every((s) => s.length <= ROAST_MAX));
  assert.ok(first[0].includes("12") && first[0].includes("3"), first[0]);
  assert.ok(second.every((s) => !first.includes(s)), "a new visit, new takes");
  const kid = roastsFrom(w, "Kid", newMemory(), { kids: true, rng });
  assert.equal(kid.length, 1);
  assert.ok(sayable("roast-kids", { n: 80 }).some((l) => l.text === kid[0]), kid[0]);
  assert.deepEqual(roastsFrom({ empty: true }, "Dana", newMemory()), []);
  const clean = roastsFrom({ totalSec: 3600, plays: 2, distinctTitles: 2, started: 1, finished: 1, topTitles: [{ name: "A", sec: 1000 }], byDevice: [] }, "Dana", newMemory(), { rng });
  assert.equal(clean.length, 1);
  assert.ok(clean[0].includes("Dana"));
});
