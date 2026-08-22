// Episode air dates.
//
// Cinemeta lists an episode as soon as it is ANNOUNCED, so a season can hold
// three kinds of row at once: aired, dated but still to come, and announced with
// no date at all. The last one is the whole reason this needs care —
// `Date.parse(undefined) > Date.now()` is false, so the naive check calls an
// unaired episode aired and offers a play button for something that does not
// exist yet.
const test = require("node:test");
const assert = require("node:assert");

let ui;
test.before(async () => {
  ui = await import("../public/js/ui.js");
});

const DAY = 86400000;
const NOW = Date.parse("2026-07-28T12:00:00Z");
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);

// ---------- one date ----------

test("a past date has aired, a future one has not", () => {
  assert.strictEqual(ui.airStatus(iso(-30), NOW), "aired");
  assert.strictEqual(ui.airStatus(iso(30), NOW), "upcoming");
});

test("a missing date is its own answer, not a past one", () => {
  for (const empty of [null, undefined, "", "  ", "TBA"]) {
    assert.strictEqual(ui.airStatus(empty, NOW), "unknown", `${JSON.stringify(empty)}`);
  }
});

test("a date is formatted short, and the year only when it differs", () => {
  const thisYear = ui.fmtAirDate(`${new Date().getFullYear()}-03-12`);
  assert.ok(thisYear.length > 0);
  assert.ok(!/\d{4}/.test(thisYear), `"${thisYear}" should not carry a year`);
  assert.ok(/1999/.test(ui.fmtAirDate("1999-03-12")));
});

test("an unparseable date formats to nothing rather than 'Invalid Date'", () => {
  assert.strictEqual(ui.fmtAirDate(null), "");
  assert.strictEqual(ui.fmtAirDate("soon"), "");
  assert.strictEqual(ui.fmtAirDate(NaN), "");
});

test("a timestamp formats the same as the string it came from", () => {
  // The hero's "Next episode" line compares dates before formatting one, so it
  // holds a number by then. Date.parse() of a number is NaN, which showed up as
  // "Next episode " with nothing after it.
  const isoDate = "2026-09-04";
  assert.strictEqual(ui.fmtAirDate(Date.parse(isoDate)), ui.fmtAirDate(isoDate));
  assert.strictEqual(ui.fmtAirDate(new Date(isoDate)), ui.fmtAirDate(isoDate));
  assert.ok(ui.fmtAirDate(Date.parse(isoDate)).length > 0);
});

// ---------- a season read as a whole ----------

const season = (...episodes) =>
  episodes.map((e, i) => ({ episode: i + 1, ...e }));

test("a mid-season show splits into aired and upcoming", () => {
  const states = ui.resolveAirStates(
    season(
      { released: iso(-21) },
      { released: iso(-14) },
      { released: iso(-7) },
      { released: iso(7) },
      { released: iso(14) },
    ),
    NOW,
  );
  assert.deepStrictEqual(states, ["aired", "aired", "aired", "upcoming", "upcoming"]);
});

test("episodes announced past the schedule are TBA", () => {
  // The Severance S4 shape: real episode titles, dates for the first few, and
  // nothing at all for the rest of the order.
  const states = ui.resolveAirStates(
    season({ released: iso(-7) }, { released: iso(7) }, { released: null }, { released: null }),
    NOW,
  );
  assert.deepStrictEqual(states, ["aired", "upcoming", "tba", "tba"]);
});

test("a show with no dates anywhere is left alone", () => {
  // A finished series from 2004 whose catalogue entry carries no dates must not
  // turn into four unplayable "Date TBA" rows.
  const states = ui.resolveAirStates(
    season({ released: null }, { released: null }, { released: null }),
    NOW,
  );
  assert.deepStrictEqual(states, ["aired", "aired", "aired"]);
});

test("one missing date in the middle of a dated season is not an announcement", () => {
  // Sloppy data, not a schedule: episode 2 sits BEFORE dated episodes, so it
  // cannot be an unannounced future episode.
  const states = ui.resolveAirStates(
    season({ released: iso(-21) }, { released: null }, { released: iso(-7) }),
    NOW,
  );
  assert.deepStrictEqual(states, ["aired", "aired", "aired"]);
});

test("an episode on disk has aired whatever the catalogue says", () => {
  // The file exists and plays. Any date that disagrees is wrong.
  const states = ui.resolveAirStates(
    season(
      { released: iso(-7) },
      { released: null, local: { id: "abc" } },
      { released: iso(30), local: { id: "def" } },
    ),
    NOW,
  );
  assert.deepStrictEqual(states, ["aired", "aired", "aired"]);
});

test("an empty or missing season list is handled", () => {
  assert.deepStrictEqual(ui.resolveAirStates([], NOW), []);
  assert.deepStrictEqual(ui.resolveAirStates(null, NOW), []);
});

test("a fully announced, undated season reads as TBA throughout", () => {
  // Season 1 aired and is dated; season 2 is announced with titles only. Read as
  // one list (which is what the merged season view hands over), every season-2
  // episode sits past the last dated one.
  const states = ui.resolveAirStates(
    [
      { episode: 1, released: iso(-30) },
      { episode: 2, released: iso(-23) },
      { episode: 3, released: null },
      { episode: 4, released: null },
    ],
    NOW,
  );
  assert.deepStrictEqual(states, ["aired", "aired", "tba", "tba"]);
});
