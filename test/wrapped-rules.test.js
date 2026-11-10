// Aurora Wrapped's pure rules (public/js/wrappedrules.js): the viewer type
// table, what the hours feel like, which chapters a year has, the sky of
// nights, and the words for a kids profile.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "public/js/wrappedrules.js")).href);

const H = 3600;
// a plain, unremarkable year: nothing past any type's bar
const base = (over = {}) => ({
  since: "2026-01-10T20:00:00.000Z",
  totalSec: 40 * H,
  plays: 40,
  distinctTitles: 6,
  topTitles: [{ name: "A", sec: 9 * H }, { name: "B", sec: 8 * H }, { name: "C", sec: 7 * H }],
  topWeekday: 3,
  byWeekday: [5, 6, 6, 6, 6, 5, 6].map((h) => h * H),
  byHour: Array.from({ length: 24 }, (_, h) => (h >= 18 && h <= 22 ? 8 * H : 0)),
  byDevice: [{ name: "TV", sec: 30 * H }, { name: "Mobile", sec: 10 * H }],
  biggestDay: { day: "2026-03-01", sec: 3 * H },
  bestStreak: 3,
  lateNightSessions: 0,
  latestFinish: null,
  longestSession: { title: "A", watchedSec: 1.5 * H },
  activeDays: 30,
  topGenres: [{ name: "Drama", sec: 20 * H }, { name: "Comedy", sec: 10 * H }],
  started: 2,
  finished: 1,
  nightsFrom: "2026-01-10",
  nights: [[0, 60], [1, 50], [2, 40], [9, 90]],
  streak: { from: "2026-01-10", to: "2026-01-12" },
  ...over,
});

test("viewer type: a plain year is The Casual; under three sittings, always The Newcomer", async () => {
  const { viewerType } = await load();
  assert.equal(viewerType(base()).id, "casual");
  assert.equal(viewerType(base({ plays: 2, lateNightSessions: 40 })).id, "newcomer");
  const t = viewerType(base());
  assert.ok(t.name && t.verdict && t.stars.length >= 2 && t.lines.length >= 1 && t.no >= 1);
});

test("viewer type: each rule wins when its stat is the one that stands out", async () => {
  const { viewerType } = await load();
  assert.equal(viewerType(base({ lateNightSessions: 9 })).id, "night-owl");
  assert.equal(viewerType(base({ biggestDay: { day: "2026-03-01", sec: 7 * H } })).id, "marathoner");
  assert.equal(viewerType(base({ topTitles: [{ name: "A", sec: 24 * H }] })).id, "loyalist");
  assert.equal(viewerType(base({ bestStreak: 14 })).id, "creature");
  assert.equal(viewerType(base({ finished: 9, started: 1 })).id, "finisher");
  assert.equal(viewerType(base({ distinctTitles: 30, plays: 40 })).id, "sampler");
  assert.equal(viewerType(base({ topGenres: ["a", "b", "c", "d", "e"].map((n) => ({ name: n, sec: 10 * H })) })).id, "explorer");
  assert.equal(viewerType(base({ byWeekday: [10, 1, 1, 1, 1, 10, 10].map((h) => h * H) })).id, "weekender");
  assert.equal(viewerType(base({ byDevice: [{ name: "Mobile", sec: 35 * H }, { name: "TV", sec: 5 * H }] })).id, "pocket");
});

test("viewer type: the strongest stat wins, a tie goes to the earlier row, and it is the same every time", async () => {
  const { viewerType } = await load();
  // night owl 10/5 = 2.0 against the streak 14/9 = 1.56
  assert.equal(viewerType(base({ lateNightSessions: 10, bestStreak: 14 })).id, "night-owl");
  // streak 27/9 = 3 beats the night owl's 2
  assert.equal(viewerType(base({ lateNightSessions: 10, bestStreak: 27 })).id, "creature");
  // exactly equal (2 and 2): the earlier row, the Night Owl
  assert.equal(viewerType(base({ lateNightSessions: 10, biggestDay: { day: "x", sec: 10 * H } })).id, "night-owl");
  const w = base({ lateNightSessions: 7 });
  assert.deepEqual(viewerType(w), viewerType(w));
  // older servers: no byHour / byWeekday — still a type, never a throw
  const old = base();
  delete old.byHour; delete old.byWeekday; delete old.nights; delete old.streak;
  assert.ok(viewerType(old).id);
});

test("viewer type: a kids profile gets the kind verdict, the same type", async () => {
  const { viewerType } = await load();
  const w = base({ lateNightSessions: 9 });
  const grown = viewerType(w);
  const kid = viewerType(w, { kids: true });
  assert.equal(kid.id, grown.id);
  assert.notEqual(kid.verdict, grown.verdict);
});

test("the hours, felt: the number, its unit, and a comparison that fits the size", async () => {
  const { hoursFelt } = await load();
  assert.deepEqual(hoursFelt(136 * H), { value: "136", unit: "hours", lines: ["That's 5 days and 16 hours, back to back.", "Or flying London to Sydney 6 times — without the jet lag."] });
  assert.equal(hoursFelt(2496 * H).value, "2,496");
  assert.deepEqual(hoursFelt(20 * H).lines, ["Enough to fly London to New York 3 times."]);
  assert.deepEqual(hoursFelt(6 * H), { value: "6.0", unit: "hours", lines: ["About 3 feature films, credits included."] });
  assert.deepEqual(hoursFelt(42 * 60), { value: "42", unit: "minutes", lines: ["One episode and a snack. A gentle start."] });
  assert.equal(hoursFelt(60).unit, "minute");
  assert.equal(hoursFelt(48 * H).lines[0], "That's 2 days, back to back.");
});

test("chapters: a full year has them all; a tiny one and an older server's answer skip what they cannot show", async () => {
  const { chaptersFor } = await load();
  const full = base({ topTitles: [1, 2, 3, 4, 5].map((i) => ({ name: `T${i}`, sec: H })) });
  assert.deepEqual(chaptersFor(full), ["opening", "hours", "top", "podium", "genres", "night", "streak", "longest", "type", "roasts", "finale"]);
  const tiny = { totalSec: 2520, plays: 1, distinctTitles: 1, topTitles: [{ name: "Arcadia Bay", sec: 2520 }], topGenres: [], bestStreak: 1, longestSession: { title: "Arcadia Bay", watchedSec: 2520 }, byHour: Array(24).fill(0), byWeekday: Array(7).fill(0), nights: [[0, 42]], nightsFrom: "2026-11-09", streak: { from: "2026-11-09", to: "2026-11-09" } };
  assert.deepEqual(chaptersFor(tiny), ["opening", "hours", "top", "type", "roasts", "finale"]);
  const old = base();
  delete old.byHour; delete old.nights; delete old.streak;
  assert.deepEqual(chaptersFor(old), ["opening", "hours", "top", "podium", "genres", "longest", "type", "roasts", "finale"]);
});

test("the sky: every night is a star inside the box; the streak's nights rise into a constellation", async () => {
  const { skyLayout, CON_MAX } = await load();
  const w = base();
  for (const wide of [true, false]) {
    const s = skyLayout(w, wide);
    assert.equal(s.stars.length, 4);
    for (const st of s.stars) assert.ok(st.x > 0 && st.x < 1 && st.y > 0 && st.y < 1, JSON.stringify(st));
    assert.deepEqual(s.path, [0, 1, 2]);
    assert.equal(s.con.length, 3);
    assert.deepEqual(s.con.map((c) => c.i), [0, 1, 2]);
    for (const c of s.con) assert.ok(c.x >= 0.1 && c.x <= 0.9 && c.y >= 0.1 && c.y <= 0.9);
    // the constellation runs along the long side
    assert.ok(wide ? s.con[2].x > s.con[0].x : s.con[2].y > s.con[0].y);
    assert.equal(s.brightest, 0); // 60 minutes, the most of the three
  }
  // a very long streak is sampled down, first and last kept
  const nights = Array.from({ length: 100 }, (_, d) => [d, 30 + (d % 7)]);
  const long = skyLayout(base({ nights, nightsFrom: "2026-01-01", streak: { from: "2026-01-01", to: "2026-04-10" } }));
  assert.equal(long.path.length, 100);
  assert.equal(long.con.length, CON_MAX);
  assert.equal(long.con[0].i, 0);
  assert.equal(long.con[CON_MAX - 1].i, 99);
  assert.deepEqual(skyLayout({}), { stars: [], path: [], con: [], brightest: null, weeks: 0 });
});

test("the intervention: roasts for grown-ups, kind words for kids — never a roast to a kids profile", async () => {
  const { roastsFor, kindWordsFor } = await load();
  const w = base({ lateNightSessions: 9, bestStreak: 12, started: 9, finished: 2 });
  const r = roastsFor(w, "Maya");
  assert.ok(r.length >= 1 && r.length <= 4);
  assert.match(r.join(" "), /Commitment issues|3am/);
  const k = kindWordsFor(w, "Pip");
  assert.ok(k.length >= 1 && k.length <= 4);
  for (const line of k) assert.doesNotMatch(line, /Commitment|Bold strategy|relationship|voicemail|not a phase|misses you|overrated/);
  assert.match(roastsFor(base(), "Maya")[0], /Nothing to roast/);
  assert.match(kindWordsFor({ topTitles: [], activeDays: 1, distinctTitles: 1, bestStreak: 1, finished: 0 }, "Pip")[0], /just getting started/);
});

test("small words: the clock, the hour, the prime hour, shares", async () => {
  const { clock, hourLabel, primeHour, weekendShare, genreShares } = await load();
  assert.equal(clock(13260), "3:41");
  assert.equal(clock(59 * 60), "0:59");
  assert.deepEqual([0, 9, 12, 21].map(hourLabel), ["midnight", "9 am", "noon", "9 pm"]);
  assert.equal(primeHour(base()), 18);
  assert.equal(primeHour({}), null);
  assert.ok(Math.abs(weekendShare(base()) - 16 / 40) < 1e-9);
  const g = genreShares(base());
  assert.deepEqual(g.map((x) => Math.round(x.share * 100)), [67, 33]);
});
