// The Calendar (src/media/calendar.js): which titles one person's calendar
// holds (My List, followed shows, watched shows — one entry per title), how
// their releases are grouped by day in the household's time zone, how a
// season dropped at once becomes one entry, and the words every app prints.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const calendar = require("../src/media/calendar");
const { build, collect } = calendar;
const { readDate, dayIn, dayLabel, pickLocale, showWords, dueForRefresh, jobFinder, addDays } = calendar._internals;

const DAY = 86400000;
// Sunday 9 Nov 2026, 10:00 in Jerusalem (08:00 UTC)
const NOW = Date.parse("2026-11-09T08:00:00Z");
const JLM = "Asia/Jerusalem";
const NYC = "America/New_York";
const dateIn = (n) => new Date(Date.parse("2026-11-09T00:00:00Z") + n * DAY).toISOString(); // midnight UTC, n days from today

const show = (imdbId, title, episodes, extra = {}) => ({
  imdbId, title, year: 2024, poster: `${imdbId}.jpg`,
  seasons: Object.values(
    episodes.reduce((acc, e) => {
      (acc[e.season] = acc[e.season] || { number: e.season, episodes: [] }).episodes.push(e);
      return acc;
    }, {}),
  ),
  ...extra,
});
const ep = (season, episode, released, title = `Episode ${episode}`) => ({ season, episode, released, title });
const items = (groups) => groups.flatMap((g) => g.items);

// ---------- dates and time zones ----------

test("a midnight-UTC timestamp is a calendar date in every time zone; any other is a moment", () => {
  // the date both Cinemeta and TMDB mostly write: the 14th everywhere — read as
  // an instant it would be the 13th in New York
  assert.equal(readDate("2026-11-14T00:00:00.000Z", NYC).day, "2026-11-14");
  assert.equal(readDate("2026-11-14T00:00:00.000Z", JLM).day, "2026-11-14");
  assert.equal(readDate("2026-11-14T00:00:00.000Z", NYC).dateOnly, true);
  assert.equal(readDate("2026-11-14", NYC).day, "2026-11-14");
  // a real air time: 02:00 UTC on the 14th is the 13th's evening in New York, the 14th in Jerusalem
  assert.equal(readDate("2026-11-14T02:00:00.000Z", NYC).day, "2026-11-13");
  assert.equal(readDate("2026-11-14T02:00:00.000Z", JLM).day, "2026-11-14");
  assert.equal(readDate("2026-11-14T02:00:00.000Z", JLM).dateOnly, false);
  // 22:30 UTC on the 13th is already the 14th in Jerusalem (UTC+2)
  assert.equal(readDate("2026-11-13T22:30:00.000Z", JLM).day, "2026-11-14");
  // TMDB's dates as availability.js stores them: numbers at midnight UTC
  assert.equal(readDate(Date.parse("2026-11-20T00:00:00.000Z"), NYC).day, "2026-11-20");
  assert.equal(readDate(null, JLM), null);
  assert.equal(readDate("not a date", JLM), null);
  assert.equal(dayIn(NOW, JLM), "2026-11-09");
  // late on the 8th in New York is the 9th in Jerusalem
  assert.equal(dayIn(Date.parse("2026-11-09T03:00:00Z"), NYC), "2026-11-08");
});

test("today is the household's today: the same moment groups differently in two time zones", () => {
  // 23:30 UTC on the 9th: the 10th in Jerusalem, still the 9th in New York
  const now = Date.parse("2026-11-09T23:30:00Z");
  const titles = [{ imdbId: "tt0000100", type: "show", title: "A", why: ["list"] }];
  const metaOf = () => show("tt0000100", "A", [ep(1, 3, "2026-11-10T00:00:00.000Z")]);
  const jlm = build(titles, { metaOf }, { now, tz: JLM, locale: "en-GB" });
  const nyc = build(titles, { metaOf }, { now, tz: NYC, locale: "en-GB" });
  assert.equal(jlm.today, "2026-11-10");
  assert.equal(jlm.upcoming[0].label, "Today");
  assert.equal(nyc.today, "2026-11-09");
  assert.equal(nyc.upcoming[0].label, "Tomorrow");
});

test("an unknown time zone falls back to UTC instead of failing", () => {
  const r = build([], {}, { now: NOW, tz: "Mars/Olympus", locale: "en-GB" });
  assert.equal(r.tz, "UTC");
});

// ---------- grouping and labels ----------

test("day labels: Today, Tomorrow, Yesterday, the weekday within a week, then the date — in the asked locale", () => {
  const today = "2026-11-09";
  assert.deepEqual(dayLabel("2026-11-09", today, "en-GB"), { label: "Today", date: "9 Nov" });
  assert.deepEqual(dayLabel("2026-11-10", today, "en-GB"), { label: "Tomorrow", date: "10 Nov" });
  assert.deepEqual(dayLabel("2026-11-08", today, "en-GB"), { label: "Yesterday", date: "8 Nov" });
  assert.equal(dayLabel("2026-11-12", today, "en-GB").label, "Thursday");
  assert.equal(dayLabel("2026-11-05", today, "en-GB").label, "Thursday");
  const far = dayLabel("2026-11-27", today, "en-GB");
  assert.equal(far.label, "Fri 27 Nov");
  assert.equal(far.date, null);
  // the American order for an American device, the same day
  assert.equal(dayLabel("2026-11-27", today, "en-US").label, "Fri, Nov 27");
  assert.equal(dayLabel("2026-11-10", today, "en-US").date, "Nov 10");
  // another language: its own weekday names
  assert.notEqual(dayLabel("2026-11-12", today, "he-IL").label, "Thursday");
  // a broken or hostile locale is not passed to Intl
  assert.equal(pickLocale("en-GB"), "en-GB");
  assert.equal(pickLocale("<script>"), "en-GB");
  assert.equal(pickLocale(""), "en-GB");
});

test("Coming up is today onwards (soonest first); Recently out the 14 days before (newest first); the rest is left out", () => {
  const titles = [{ imdbId: "tt0000001", type: "show", title: "Show One", why: ["list"] }];
  const metaOf = () =>
    show("tt0000001", "Show One", [
      ep(2, 1, dateIn(-20)), // before the window
      ep(2, 2, dateIn(-14)), // the first day of Recently out
      ep(2, 3, dateIn(-1)),
      ep(2, 4, dateIn(0)),
      ep(2, 5, dateIn(9)),
      ep(2, 6, dateIn(60)), // the last day of Coming up
      ep(2, 7, dateIn(61)), // after it
    ]);
  const r = build(titles, { metaOf }, { now: NOW, tz: JLM, locale: "en-GB" });
  assert.deepEqual(r.upcoming.map((g) => g.day), [dateIn(0), dateIn(9), dateIn(60)].map((d) => d.slice(0, 10)));
  assert.deepEqual(r.recent.map((g) => g.day), [dateIn(-1), dateIn(-14)].map((d) => d.slice(0, 10)));
  assert.equal(r.upcoming[0].label, "Today");
  assert.equal(r.recent[0].label, "Yesterday");
  assert.deepEqual(r.counts, { upcoming: 3, recent: 2, titles: 1 });
  assert.equal(items(r.upcoming)[0].detail, "S2 E4");
});

test("a whole season on one day is ONE entry; episode 1 makes it a premiere", () => {
  const titles = [{ imdbId: "tt0000002", type: "show", title: "Binge", why: ["following"] }];
  const metaOf = () => show("tt0000002", "Binge", Array.from({ length: 8 }, (_, i) => ep(3, i + 1, dateIn(4))));
  const r = build(titles, { metaOf }, { now: NOW, tz: JLM, locale: "en-GB" });
  const all = items(r.upcoming);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "premiere");
  assert.equal(all[0].what, "Season 3 premiere");
  assert.equal(all[0].detail, "S3 E1–E8 · 8 episodes");
  assert.equal(all[0].episodes.length, 8);
  assert.equal(all[0].why, "Following");
});

test("the words for one episode, several, a first season and a group across seasons", () => {
  assert.deepEqual(showWords([{ season: 1, episode: 1, title: "Pilot" }]), { what: "Series premiere", detail: "S1 E1 · Pilot", premiere: true });
  assert.deepEqual(showWords([{ season: 2, episode: 5, title: "Episode 5" }]), { what: "New episode", detail: "S2 E5", premiere: false });
  assert.deepEqual(showWords([{ season: 2, episode: 5, title: "The Long Night" }]), { what: "New episode", detail: "S2 E5 · The Long Night", premiere: false });
  assert.deepEqual(showWords([{ season: 2, episode: 5 }, { season: 2, episode: 6 }]), { what: "2 new episodes", detail: "S2 E5–E6", premiere: false });
  assert.equal(showWords([{ season: 2, episode: 9 }, { season: 3, episode: 1 }]).detail, "S2 E9 – S3 E1");
  assert.equal(showWords([{ season: 2, episode: 9 }, { season: 3, episode: 1 }]).what, "Season 3 premiere");
});

test("an episode the source lists twice is one episode; specials are left out", () => {
  const titles = [{ imdbId: "tt0000003", type: "show", title: "Twice", why: ["list"] }];
  const metaOf = () => ({
    imdbId: "tt0000003", title: "Twice", year: 2020,
    seasons: [
      { number: 0, episodes: [ep(0, 1, dateIn(2))] },
      { number: 1, episodes: [ep(1, 4, dateIn(2)), ep(1, 4, dateIn(2))] },
    ],
  });
  const all = items(build(titles, { metaOf }, { now: NOW, tz: JLM, locale: "en-GB" }).upcoming);
  assert.equal(all.length, 1);
  assert.equal(all[0].episodes.length, 1);
  assert.equal(all[0].what, "New episode");
});

test("premieres lead their day, then by time, then by name", () => {
  const titles = [
    { imdbId: "tt0000010", type: "show", title: "Zed", why: ["list"] },
    { imdbId: "tt0000011", type: "show", title: "Alpha", why: ["list"] },
    { imdbId: "tt0000012", type: "show", title: "Mid", why: ["list"] },
  ];
  const metas = {
    tt0000010: show("tt0000010", "Zed", [ep(4, 1, dateIn(3))]),
    tt0000011: show("tt0000011", "Alpha", [ep(1, 6, dateIn(3))]),
    tt0000012: show("tt0000012", "Mid", [ep(1, 7, dateIn(3))]),
  };
  const r = build(titles, { metaOf: (id) => metas[id] }, { now: NOW, tz: JLM, locale: "en-GB" });
  assert.deepEqual(r.upcoming[0].items.map((i) => i.title), ["Zed", "Alpha", "Mid"]);
});

// ---------- films ----------

test("a film has its cinema date and its date at home, each on its own day", () => {
  const titles = [{ imdbId: "tt0000020", type: "movie", title: "The Film", year: 2026, why: ["list"] }];
  const availOf = () => ({ theatricalAt: Date.parse(dateIn(-5)), homeAt: Date.parse(dateIn(30)) });
  const r = build(titles, { availOf }, { now: NOW, tz: NYC, locale: "en-GB" });
  const cinema = items(r.recent)[0];
  const home = items(r.upcoming)[0];
  assert.equal(cinema.what, "In cinemas");
  assert.equal(cinema.day, dateIn(-5).slice(0, 10)); // midnight-UTC dates do not slip a day in New York
  assert.equal(cinema.canSave, false); // nothing worth saving from a cinema run
  assert.equal(home.what, "Out to stream or buy");
  assert.equal(home.canSave, false); // not out yet
  assert.equal(home.type, "movie");
});

test("a film out at home in the last fortnight offers Save & watch, unless the server has it or it is on its way", () => {
  const titles = [{ imdbId: "tt0000021", type: "movie", title: "Out Now", year: 2026, why: ["list"] }];
  const availOf = () => ({ theatricalAt: Date.parse(dateIn(-90)), homeAt: Date.parse(dateIn(-3)) });
  const none = items(build(titles, { availOf }, { now: NOW, tz: JLM, locale: "en-GB" }).recent)[0];
  assert.equal(none.canSave, true);
  assert.deepEqual(none.save, { imdbId: "tt0000021", type: "movie" });
  assert.equal(none.badge, null);
  const have = items(build(titles, { availOf, ownedOf: () => ({ id: "lib-film" }) }, { now: NOW, tz: JLM, locale: "en-GB" }).recent)[0];
  assert.equal(have.state, "have");
  assert.equal(have.badge, "On the server");
  assert.equal(have.canSave, false);
  assert.deepEqual(have.play, { id: "lib-film", showId: null, season: null, episode: null });
  const job = { imdbId: "tt0000021", type: "movie", status: "downloading" };
  const saving = items(build(titles, { availOf, jobOf: jobFinder([job]) }, { now: NOW, tz: JLM, locale: "en-GB" }).recent)[0];
  assert.equal(saving.state, "saving");
  assert.equal(saving.badge, "Saving");
  assert.equal(saving.canSave, false);
  const waiting = items(build(titles, { availOf, jobOf: jobFinder([{ ...job, status: "pending" }]) }, { now: NOW, tz: JLM, locale: "en-GB" }).recent)[0];
  assert.equal(waiting.badge, "Waiting for approval");
  // a finished or failed job is not "on its way"
  const failed = items(build(titles, { availOf, jobOf: jobFinder([{ ...job, status: "error" }]) }, { now: NOW, tz: JLM, locale: "en-GB" }).recent)[0];
  assert.equal(failed.canSave, true);
});

test("with torrents switched off nothing offers Save & watch", () => {
  const titles = [{ imdbId: "tt0000022", type: "movie", title: "Off", year: 2026, why: ["list"] }];
  const availOf = () => ({ homeAt: Date.parse(dateIn(-3)) });
  const e = items(build(titles, { availOf }, { now: NOW, tz: JLM, locale: "en-GB", torrentsOn: false }).recent)[0];
  assert.equal(e.canSave, false);
});

// ---------- on the server, or not ----------

test("episodes: on the server, part of a drop on the server, not yet out", () => {
  const titles = [{ imdbId: "tt0000030", type: "show", title: "Owned", why: ["watching"] }];
  const metaOf = () => show("tt0000030", "Owned", [ep(1, 1, dateIn(-2)), ep(1, 2, dateIn(-2)), ep(1, 3, dateIn(-2)), ep(1, 4, dateIn(5))]);
  const owned = new Set(["1:1"]);
  const ownedOf = (w) => (owned.has(`${w.season}:${w.episode}`) ? { id: `lib-${w.season}-${w.episode}` } : null);
  const r = build(titles, { metaOf, ownedOf }, { now: NOW, tz: JLM, locale: "en-GB" });
  const drop = items(r.recent)[0];
  assert.equal(drop.state, "partial");
  assert.equal(drop.badge, "1 of 3 on the server");
  assert.equal(drop.canSave, true);
  assert.deepEqual(drop.save, { imdbId: "tt0000030", type: "show", season: 1, episode: 2 }); // the first one it lacks
  assert.deepEqual(drop.play, { id: "lib-1-1", showId: null, season: null, episode: null });
  const next = items(r.upcoming)[0];
  assert.equal(next.out, false);
  assert.equal(next.canSave, false);
  owned.add("1:2").add("1:3");
  const all = items(build(titles, { metaOf, ownedOf }, { now: NOW, tz: JLM, locale: "en-GB" }).recent)[0];
  assert.equal(all.state, "have");
  assert.equal(all.badge, "On the server");
  assert.equal(all.canSave, false);
});

test("an episode later today: out only once its air time has passed", () => {
  const titles = [{ imdbId: "tt0000031", type: "show", title: "Tonight", why: ["list"] }];
  const metaOf = () => show("tt0000031", "Tonight", [ep(1, 2, "2026-11-09T19:00:00.000Z")]);
  const before = items(build(titles, { metaOf }, { now: NOW, tz: JLM, locale: "en-GB" }).upcoming)[0];
  assert.equal(before.out, false);
  assert.equal(before.canSave, false);
  const after = items(build(titles, { metaOf }, { now: Date.parse("2026-11-09T19:30:00Z"), tz: JLM, locale: "en-GB" }).upcoming)[0];
  assert.equal(after.out, true);
  assert.equal(after.canSave, true);
});

test("what a card opens: the library copy when there is one, else the catalogue page", () => {
  const titles = [
    { imdbId: "tt0000040", type: "show", title: "On Disk", why: ["list"], libId: "lib-show" },
    { imdbId: "tt0000041", type: "show", title: "Not On Disk", why: ["list"] },
  ];
  const metas = { tt0000040: show("tt0000040", "On Disk", [ep(1, 2, dateIn(1))]), tt0000041: show("tt0000041", "Not On Disk", [ep(1, 2, dateIn(1))]) };
  const r = build(titles, { metaOf: (id) => metas[id], findById: (id) => (id === "lib-show" ? { id: "lib-show", type: "show", cover: "/lib.jpg" } : null) }, { now: NOW, tz: JLM, locale: "en-GB" });
  const [a, b] = items(r.upcoming).sort((x, y) => x.title.localeCompare(y.title));
  assert.equal(b.title, "On Disk");
  assert.equal(a.title, "Not On Disk");
  assert.deepEqual(b.item, { imdbId: "tt0000040", type: "show", title: "On Disk", year: 2024, id: "lib-show", cover: "/lib.jpg" });
  assert.equal(a.item.source, "stream");
  assert.equal(a.item.id, "disc:tt0000041");
});

test("a show whose episode list is not fetched yet is counted as pending, not silently dropped", () => {
  const titles = [
    { imdbId: "tt0000050", type: "show", title: "Unknown", why: ["list"] },
    { imdbId: "tt0000051", type: "movie", title: "New Film", year: 2026, why: ["list"] },
    { imdbId: "tt0000052", type: "movie", title: "Old Film", year: 1999, why: ["list"] },
  ];
  const r = build(titles, { filmPending: (t) => t.year >= 2025 }, { now: NOW, tz: JLM, locale: "en-GB" });
  assert.equal(r.pending, 2);
  assert.equal(calendar.EMPTY.pending(2), "Still looking up the dates of 2 titles — they show up here soon.");
  assert.equal(calendar.EMPTY.pending(1), "Still looking up the dates of 1 title — they show up here soon.");
});

// ---------- merging My List with followed and watched shows ----------

test("My List, followed shows and watched shows merge into one title each, with every reason", () => {
  const lib = { "lib-a": { id: "lib-a", type: "show", title: "Library Show", year: 2019, cover: "/a.jpg" }, "lib-ep": { id: "lib-ep", showId: "lib-a", type: "episode" } };
  const titles = collect({
    watchlist: [
      "lib-a", // a library show, its IMDb id from the identity stamp
      { stream: true, imdbId: "tt0000060", type: "series", title: "Streamed Show", poster: "/s.jpg", year: 2025 },
      { stream: true, imdbId: "tt0000061", type: "movie", title: "A Film", year: 2026 },
      "lib-ep", // not a film or a show: ignored
      "gone", // no longer in the library: ignored
    ],
    follows: [{ imdbId: "tt0000060", title: "Streamed Show", at: 1 }, { imdbId: "tt0000062", title: "Followed Only", at: 1 }],
    episodeRows: {
      "tt0000060:1:2": { position: 300, updatedAt: NOW - DAY },
      "tt0000063:2:1": { position: 0, finished: true, updatedAt: NOW - 10 * DAY },
      "tt0000064:1:1": { position: 0, finished: false, updatedAt: NOW - DAY }, // opened, never played
      "tt0000065:1:1": { position: 900, updatedAt: NOW - 200 * DAY }, // long ago
    },
    findById: (id) => lib[id] || null,
    imdbIdFor: (item) => (item.id === "lib-a" ? "tt0000059" : null),
    now: NOW,
  });
  const byId = Object.fromEntries(titles.map((t) => [t.imdbId, t]));
  assert.deepEqual(Object.keys(byId).sort(), ["tt0000059", "tt0000060", "tt0000061", "tt0000062", "tt0000063"]);
  assert.deepEqual(byId.tt0000060.why, ["list", "following", "watching"]);
  assert.equal(byId.tt0000060.type, "show"); // "series" is a show
  assert.equal(byId.tt0000059.libId, "lib-a");
  assert.equal(byId.tt0000059.title, "Library Show");
  assert.equal(byId.tt0000061.type, "movie");
  assert.deepEqual(byId.tt0000062.why, ["following"]);
  assert.deepEqual(byId.tt0000063.why, ["watching"]);
  // the merged reasons, as the cards say them
  const r = build(titles, { metaOf: (id) => (id === "tt0000060" ? show("tt0000060", "Streamed Show", [ep(1, 3, dateIn(2))]) : null) }, { now: NOW, tz: JLM, locale: "en-GB" });
  assert.equal(items(r.upcoming)[0].why, "In My List · Following · Watching");
});

test("one title in My List twice (a library copy and a stream ref) is still one title", () => {
  const titles = collect({
    watchlist: ["lib-b", { stream: true, imdbId: "tt0000070", type: "show", title: "Twin" }],
    findById: (id) => (id === "lib-b" ? { id: "lib-b", type: "show", title: "Twin" } : null),
    imdbIdFor: () => "tt0000070",
    now: NOW,
  });
  assert.equal(titles.length, 1);
  assert.equal(titles[0].libId, "lib-b");
});

test("the merged calendar never shows the same release twice", () => {
  const titles = collect({
    watchlist: [{ stream: true, imdbId: "tt0000080", type: "show", title: "Dup" }],
    follows: [{ imdbId: "tt0000080", title: "Dup" }],
    episodeRows: { "tt0000080:1:1": { position: 50, updatedAt: NOW } },
    now: NOW,
  });
  const r = build(titles, { metaOf: () => show("tt0000080", "Dup", [ep(1, 2, dateIn(1)), ep(1, 3, dateIn(8))]) }, { now: NOW, tz: JLM, locale: "en-GB" });
  const keys = items(r.upcoming).map((e) => e.key);
  assert.deepEqual(keys, ["tt0000080:1:2", "tt0000080:1:3"]);
  assert.equal(new Set(keys).size, keys.length);
});

// ---------- the daily refresh ----------

test("the daily refresh asks a running show again after a day, a quiet one after a week", () => {
  const running = { seasons: [{ number: 1, episodes: [{ released: new Date(NOW - 5 * DAY).toISOString() }] }] };
  const quiet = { seasons: [{ number: 1, episodes: [{ released: new Date(NOW - 400 * DAY).toISOString() }] }] };
  assert.equal(dueForRefresh(running, 21 * 3600 * 1000, NOW), true);
  assert.equal(dueForRefresh(running, 3 * 3600 * 1000, NOW), false);
  assert.equal(dueForRefresh(quiet, 2 * DAY, NOW), false);
  assert.equal(dueForRefresh(quiet, 8 * DAY, NOW), true);
  assert.equal(dueForRefresh(null, null, NOW), true);
});

test("refresh(): every title on every profile's calendar, each once, two at a time", async () => {
  const asked = [];
  let inFlight = 0;
  let most = 0;
  const mods = {
    profiles: {
      list: () => [{ id: "p1" }, { id: "p2" }],
      getWatchlist: (id) => (id === "p1" ? [{ imdbId: "tt0000090", type: "show" }, { imdbId: "tt0000095", type: "movie", year: 2026 }] : [{ imdbId: "tt0000090", type: "show" }]),
      followsOf: (id) => (id === "p2" ? [{ imdbId: "tt0000091" }, { imdbId: "tt0000092" }] : []),
      streamEpisodeProgress: () => ({}),
    },
    scanner: { findById: () => null },
    identity: { ensureStamped: () => {}, imdbIdFor: () => null },
    discover: {
      metaCached: (_t, id) => (id === "tt0000092" ? { seasons: [{ number: 1, episodes: [{ released: new Date(NOW - DAY).toISOString() }] }] } : null),
      metaAge: (_t, id) => (id === "tt0000092" ? 3600 * 1000 : null),
      _internals: {
        fetchMetaOnce: async (_t, id) => {
          asked.push(id);
          inFlight++;
          most = Math.max(most, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return {};
        },
      },
    },
    availability: { warm: async (films) => { asked.push(...films.map((f) => `film:${f.imdbId}`)); } },
  };
  const summary = await calendar.refresh(mods, NOW);
  assert.deepEqual(asked.sort(), ["film:tt0000095", "tt0000090", "tt0000091"]); // tt0000092 was asked an hour ago
  assert.ok(most <= 2);
  assert.match(summary, /^3 shows \(2 asked again\), 1 films$/);
});

test("the window edges move with the household's day", () => {
  assert.equal(addDays("2026-11-09", 60), "2027-01-08");
  assert.equal(addDays("2026-11-09", -14), "2026-10-26");
});

// ---------- a kids profile ----------

test("a kids profile's calendar keeps only what it may see, and Save & watch only for those", () => {
  const kids = require("../src/lib/kids");
  const CERTS = { tt0000001: "ALL", tt0000002: "18+" };
  const gate = kids.createGate({
    kidsFor: () => ({ profile: "kid", maxAge: 12, source: "profile" }),
    certOf: kids.makeCertOf({ cached: (id) => CERTS[id] || null }),
    findById: () => null,
  });
  const run = (r, handler) => {
    const res = { statusCode: 200, body: undefined, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let passed = false;
    gate({ query: {}, headers: {}, ...r }, res, () => { passed = true; handler && handler(r, res); });
    return { status: res.statusCode, body: res.body, passed };
  };
  const day = (d, ...ids) => ({ day: d, label: d, items: ids.map((imdbId) => ({ imdbId, type: "movie", title: imdbId })) });
  const r = run({ path: "/api/profiles/kid/calendar", method: "GET" }, (q, res) =>
    res.json({ upcoming: [day("2026-11-10", "tt0000001", "tt0000002"), day("2026-11-11", "tt0000002")], recent: [day("2026-11-01", "tt0000003")], counts: { upcoming: 3, recent: 1, titles: 3 } }));
  assert.deepEqual(r.body.upcoming.map((d) => d.items.map((i) => i.imdbId)), [["tt0000001"]]);
  assert.deepEqual(r.body.recent, [], "an unrated title is not shown either");
  assert.deepEqual(r.body.counts, { upcoming: 1, recent: 0, titles: 3 });
  const no = run({ path: "/api/profiles/kid/calendar/save", method: "POST", body: { imdbId: "tt0000002", type: "movie" } });
  assert.equal(no.status, 403);
  assert.equal(no.passed, false);
  const yes = run({ path: "/api/profiles/kid/calendar/save", method: "POST", body: { imdbId: "tt0000001", type: "movie" } }, (q, res) => res.json({ ok: true }));
  assert.equal(yes.passed, true);
});

// ---------- the month grid (2026-11-10) ----------

const { addMonths, lastOfMonth, weekStartOf, monthLine, whenWords } = calendar._internals;

test("the month grid holds every day of the months a person can page through, and the greyed edges", () => {
  // Sunday 9 Nov 2026: last month (October) to the month holding today + 60 (January)
  const r = build([], {}, { now: NOW, tz: JLM, locale: "en-GB" });
  assert.deepEqual(r.grid.months.map((m) => m.key), ["2026-10", "2026-11", "2026-12", "2027-01"]);
  assert.equal(r.grid.from, "2026-09-25"); // 1 Oct − 6
  assert.equal(r.grid.to, "2027-02-14"); // 31 Jan + 14
  const keys = Object.keys(r.grid.byDay);
  assert.equal(keys.length, 143);
  assert.deepEqual([keys[0], keys[keys.length - 1]], ["2026-09-25", "2027-02-14"]);
  for (let i = 1; i < keys.length; i++) assert.equal(addDays(keys[i - 1], 1), keys[i]); // every day, in order
  // every day has its heading, an empty day too
  assert.deepEqual(r.grid.byDay["2026-11-09"], { label: "Today", date: "9 Nov", items: [] });
  assert.equal(r.grid.byDay["2026-12-24"].label, "Thu 24 Dec");
  const nov = r.grid.months[1];
  assert.deepEqual([nov.month, nov.year, nov.label, nov.first, nov.last, nov.count, nov.line], ["November", "2026", "November 2026", "2026-11-01", "2026-11-30", 0, null]);
  assert.equal(r.next, null);
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2027-01", -1), "2026-12");
  assert.equal(lastOfMonth("2028-02"), "2028-02-29");
});

test("the grid has the releases the two lists leave out: the start of this month, last month, the far end of the last month", () => {
  const titles = [{ imdbId: "tt0000201", type: "show", title: "Wide", why: ["list"] }];
  const metaOf = () =>
    show("tt0000201", "Wide", [
      ep(1, 1, dateIn(-36)), // 4 Oct: last month, not in Recently out
      ep(1, 2, dateIn(-8)), // 1 Nov: in both
      ep(1, 3, dateIn(2)),
      ep(1, 4, dateIn(70)), // 18 Jan: past the 60 days, still January
      ep(1, 5, dateIn(100)), // 17 Feb: beyond the grid
      ep(1, 6, dateIn(-60)), // 10 Sep: before it
    ]);
  const r = build(titles, { metaOf }, { now: NOW, tz: JLM, locale: "en-GB" });
  const onGrid = Object.entries(r.grid.byDay).filter(([, d]) => d.items.length).map(([k, d]) => [k, d.items.map((e) => e.detail)]);
  assert.deepEqual(onGrid, [["2026-10-04", ["S1 E1"]], ["2026-11-01", ["S1 E2"]], ["2026-11-11", ["S1 E3"]], ["2027-01-18", ["S1 E4"]]]);
  // the old lists, exactly as before
  assert.deepEqual(r.upcoming.map((d) => d.day), ["2026-11-11"]);
  assert.deepEqual(r.recent.map((d) => d.day), ["2026-11-01"]);
  assert.deepEqual(r.counts, { upcoming: 1, recent: 1, titles: 1 });
  // the same entry, the same words, wherever it is listed
  assert.deepEqual(r.grid.byDay["2026-11-11"].items[0], r.upcoming[0].items[0]);
  assert.deepEqual(r.grid.months.map((m) => m.line), ["1 release · 1 premiere", "2 releases", null, "1 release"]);
});

test("the week starts where the asking device lives: Sunday in Israel and the US, Monday in Britain, Saturday in Egypt", () => {
  assert.equal(weekStartOf("he-IL"), 0);
  assert.equal(weekStartOf("en-IL"), 0);
  assert.equal(weekStartOf("en-US"), 0);
  assert.equal(weekStartOf("en-GB"), 1);
  assert.equal(weekStartOf("de-DE"), 1);
  assert.equal(weekStartOf("ar-EG"), 6);
  const gb = build([], {}, { now: NOW, tz: JLM, locale: "en-GB" }).grid;
  assert.equal(gb.weekStart, 1);
  assert.deepEqual(gb.weekdays.map((w) => w.short), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  const us = build([], {}, { now: NOW, tz: JLM, locale: "en-US" }).grid;
  assert.deepEqual(us.weekdays.map((w) => w.short), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  assert.deepEqual(us.weekdays.map((w) => w.narrow), ["S", "M", "T", "W", "T", "F", "S"]);
  // Hebrew names for a Hebrew device, Sunday first
  const he = build([], {}, { now: NOW, tz: JLM, locale: "he-IL" }).grid;
  assert.equal(he.weekStart, 0);
  assert.notEqual(he.weekdays[0].short, "Sun");
  assert.notEqual(he.months[1].month, "November");
});

test("a month's line and the next-up line", () => {
  assert.equal(monthLine([]), null);
  const e = (kind, type = "show", imdbId = "tt1") => ({ kind, type, imdbId });
  assert.equal(monthLine([e("episode")]), "1 release");
  assert.equal(monthLine([e("premiere"), e("episode"), e("cinema", "movie", "tt2"), e("home", "movie", "tt2")]), "4 releases · 1 premiere · 1 film");
  assert.deepEqual([whenWords(0), whenWords(1), whenWords(5)], ["Today", "Tomorrow", "In 5 days"]);
  const titles = [
    { imdbId: "tt0000301", type: "show", title: "Aired", why: ["list"] },
    { imdbId: "tt0000302", type: "show", title: "Later", why: ["list"] },
  ];
  const metas = {
    tt0000301: show("tt0000301", "Aired", [ep(1, 2, dateIn(0))]), // today, a plain date: out already
    tt0000302: show("tt0000302", "Later", [ep(2, 1, dateIn(3))]),
  };
  const r = build(titles, { metaOf: (id) => metas[id] }, { now: NOW, tz: JLM, locale: "en-GB" });
  assert.deepEqual(r.next, { key: "tt0000302:2:1", day: dateIn(3).slice(0, 10), title: "Later", what: "Season 2 premiere", kind: "premiere", when: "In 3 days" });
  // an air time later today: next up, "Today"
  const tonight = { tt0000301: show("tt0000301", "Aired", [ep(1, 2, "2026-11-09T19:00:00.000Z")]), tt0000302: metas.tt0000302 };
  assert.equal(build(titles, { metaOf: (id) => tonight[id] }, { now: NOW, tz: JLM, locale: "en-GB" }).next.when, "Today");
});

test("the asking device's own zone: its today and its days (a zone ahead of UTC and one behind)", () => {
  // 21:00 UTC on 9 Nov: already the 10th in Kiritimati (UTC+14), still the 9th in Los Angeles (UTC−8)
  const now = Date.parse("2026-11-09T21:00:00Z");
  const titles = [{ imdbId: "tt0000401", type: "show", title: "Air", why: ["list"] }];
  // an air time: 02:00 UTC on the 12th is the 12th (16:00) in Kiritimati, the 11th (18:00) in Los Angeles
  const metaOf = () => show("tt0000401", "Air", [ep(1, 1, "2026-11-12T02:00:00.000Z"), ep(1, 2, "2026-11-20T00:00:00.000Z")]);
  const east = build(titles, { metaOf }, { now, tz: "Pacific/Kiritimati", locale: "en-GB" });
  const west = build(titles, { metaOf }, { now, tz: "America/Los_Angeles", locale: "en-GB" });
  assert.equal(east.today, "2026-11-10");
  assert.equal(west.today, "2026-11-09");
  const days = (r) => Object.entries(r.grid.byDay).filter(([, d]) => d.items.length).map(([k]) => k);
  assert.deepEqual(days(east), ["2026-11-12", "2026-11-20"]);
  assert.deepEqual(days(west), ["2026-11-11", "2026-11-20"]); // a plain date stays the date it names
});

test("forProfile: a device's zone when it names a real one, else the household's", () => {
  const mods = {
    profiles: { getWatchlist: () => [], followsOf: () => [], streamEpisodeProgress: () => ({}) },
    scanner: { findById: () => null },
    identity: { ensureStamped() {}, imdbIdFor: () => null, _internals: { libraryMaps: () => null }, findLibraryPlayable: () => null, findLibraryFor: () => null },
    discover: { metaCached: () => null, metaRecentlyFailed: () => false, meta: async () => null },
    availability: { cached: () => null, isAmbiguous: () => false, warm: async () => {} },
    downloads: { list: () => [] },
  };
  assert.equal(calendar.forProfile("p", { tz: "Pacific/Kiritimati", now: NOW }, mods).tz, "Pacific/Kiritimati");
  const house = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(calendar.forProfile("p", { tz: "Not/AZone", now: NOW }, mods).tz, house);
  assert.equal(calendar.forProfile("p", { now: NOW }, mods).tz, house);
});

test("an older app's fields keep their shape and their 60/14-day window (TV 5.9.1, phone 1.1.1)", () => {
  const titles = [{ imdbId: "tt0000501", type: "show", title: "Old", why: ["list"] }];
  const metaOf = () => show("tt0000501", "Old", [ep(1, 1, dateIn(-20)), ep(1, 2, dateIn(-14)), ep(1, 3, dateIn(0)), ep(1, 4, dateIn(60)), ep(1, 5, dateIn(61))]);
  const r = build(titles, { metaOf }, { now: NOW, tz: JLM, locale: "en-GB" });
  // the fields the apps in the field read (tv-native/src/calendar.ts Calendar, 5.9.1)
  for (const k of ["tz", "locale", "today", "upcoming", "recent", "counts", "pending"]) assert.ok(k in r, k);
  assert.deepEqual(Object.keys(r.counts).sort(), ["recent", "titles", "upcoming"]);
  for (const d of [...r.upcoming, ...r.recent]) assert.deepEqual(Object.keys(d).sort(), ["date", "day", "items", "label"]);
  assert.deepEqual(r.upcoming.map((d) => d.day), [dateIn(0), dateIn(60)].map((x) => x.slice(0, 10)));
  assert.deepEqual(r.recent.map((d) => d.day), [dateIn(-14).slice(0, 10)]);
  const entry = r.upcoming[0].items[0];
  for (const k of ["key", "kind", "type", "imdbId", "title", "year", "poster", "day", "at", "what", "detail", "why", "out", "state", "badge", "canSave", "save", "play", "item"]) assert.ok(k in entry, k);
  assert.equal(calendar.EMPTY.upcoming, "Nothing coming up in the next 60 days for the titles in your list.");
  assert.equal(calendar.EMPTY.recent, "Nothing came out in the last 14 days for the titles in your list.");
});

test("restrict(): a kids profile's gate takes titles out of the lists, the grid, the months' lines and next up", () => {
  const titles = [
    { imdbId: "tt0000601", type: "show", title: "Fine", why: ["list"] },
    { imdbId: "tt0000602", type: "show", title: "Grown-up", why: ["list"] },
  ];
  const metas = {
    tt0000601: show("tt0000601", "Fine", [ep(1, 3, dateIn(5))]),
    tt0000602: show("tt0000602", "Grown-up", [ep(1, 3, dateIn(2)), ep(1, 4, dateIn(-3))]),
  };
  const body = build(titles, { metaOf: (id) => metas[id] }, { now: NOW, tz: JLM, locale: "en-GB" });
  assert.equal(body.next.title, "Grown-up");
  const out = calendar.restrict(body, (items) => items.filter((e) => e.imdbId !== "tt0000602"));
  assert.deepEqual(out.upcoming.map((d) => d.items.map((e) => e.title)), [["Fine"]]);
  assert.deepEqual(out.recent, []);
  assert.deepEqual(out.counts, { upcoming: 1, recent: 0, titles: 2 });
  const left = Object.values(out.grid.byDay).flatMap((d) => d.items.map((e) => e.title));
  assert.deepEqual(left, ["Fine"]);
  assert.equal(out.grid.months[1].line, "1 release");
  assert.equal(out.next.title, "Fine");
  assert.equal(Object.keys(out.grid.byDay).length, Object.keys(body.grid.byDay).length, "every day keeps its heading");
  // an older answer without a grid passes through as before
  const old = calendar.restrict({ upcoming: body.upcoming, recent: body.recent, counts: body.counts }, (items) => items);
  assert.equal(old.grid, undefined);
});
