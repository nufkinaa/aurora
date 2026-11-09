// A household calendar to test with (test/ui/calendar.test.js and
// test/calendar-server.test.js): the episode lists and release dates the
// private instance would otherwise have to ask Cinemeta and TMDB for, seeded
// into its caches with dates relative to TODAY in this machine's time zone
// (the instance's household zone is the machine's).
//
//   Test Show (tt9000003, on the server: S1 E1–E3)  S1 E1–E3 out 2 days ago · S2 E1 in 3 days
//   Night Harbour (tt8200001, My List)              S1 E3 8 days ago · S1 E4 yesterday (neither on the server) · S1 E5 tomorrow
//   Quiet Fields (tt8200002, followed)              all of season 2 in 9 days
//   Paper Moons (tt8200003, My List, a film)        in cinemas 60 days ago · out to stream 4 days ago
//   Glass Orchard (tt8200004, My List, a film)      in cinemas in 12 days · out to stream in 40
"use strict";

const DAY = 86400000;
const todayKey = () => {
  const p = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
};
// a date n days from today, as the sources write a date (midnight UTC)
const day = (n) => new Date(Date.parse(`${todayKey()}T00:00:00.000Z`) + n * DAY).toISOString();

const IDS = { show: "tt9000003", harbour: "tt8200001", fields: "tt8200002", moons: "tt8200003", orchard: "tt8200004" };

const series = (imdbId, title, eps) => ({
  at: Date.now(),
  v: 4, // discover.js META_V
  data: {
    id: imdbId, type: "show", imdbId, title, year: 2024, poster: null, backdrop: null, logo: null,
    synopsis: "", genres: [], rating: null, runtime: null, cast: [], director: null,
    seasons: Object.values(eps.reduce((acc, [s, e, released, name]) => {
      (acc[s] = acc[s] || { number: s, episodes: [] }).episodes.push({ season: s, episode: e, title: name || `Episode ${e}`, overview: "", thumbnail: null, released });
      return acc;
    }, {})),
    episodeCount: eps.length, tmdbId: null, trailers: [], certificate: null, kidsAge: null, originalLanguage: null,
  },
});
const film = (imdbId, title) => ({
  at: Date.now(), v: 4,
  data: { id: imdbId, type: "movie", imdbId, title, year: new Date().getFullYear(), poster: null, backdrop: null, logo: null, synopsis: "", genres: [], rating: null, runtime: null, cast: [], director: null, seasons: null, episodeCount: null, tmdbId: null, trailers: [], certificate: null, kidsAge: null, originalLanguage: null },
});

const seed = () => ({
  "cache/meta.json": {
    [`series|${IDS.show}`]: series(IDS.show, "Test Show", [[1, 1, day(-2), "Pilot"], [1, 2, day(-2)], [1, 3, day(-2)], [2, 1, day(3), "Back Again"]]),
    [`series|${IDS.harbour}`]: series(IDS.harbour, "Night Harbour", [[1, 3, day(-8)], [1, 4, day(-1), "Low Tide"], [1, 5, day(1), "The Lighthouse"]]),
    [`series|${IDS.fields}`]: series(IDS.fields, "Quiet Fields", [[1, 8, day(-300)], ...Array.from({ length: 8 }, (_, i) => [2, i + 1, day(9)])]),
    [`movie|${IDS.moons}`]: film(IDS.moons, "Paper Moons"),
    [`movie|${IDS.orchard}`]: film(IDS.orchard, "Glass Orchard"),
  },
  "cache/availability.json": {
    v: 1,
    titles: {
      [IDS.moons]: { home: true, homeAt: Date.parse(day(-4)), theatricalAt: Date.parse(day(-60)), streamed: null, at: Date.now() },
      [IDS.orchard]: { home: false, homeAt: Date.parse(day(40)), theatricalAt: Date.parse(day(12)), streamed: null, at: Date.now() },
    },
  },
});

// Put the titles in a profile's list (and follow the one that is followed).
const fill = async (api, profile, showLibId) => {
  const h = await api.as(profile);
  const add = (body) => api.ok("POST", `/api/profiles/${profile.id}/watchlist`, body, h);
  await add({ itemId: showLibId });
  await add({ stream: { imdbId: IDS.harbour, type: "show", title: "Night Harbour", year: 2024 } });
  await add({ stream: { imdbId: IDS.moons, type: "movie", title: "Paper Moons", year: new Date().getFullYear() } });
  await add({ stream: { imdbId: IDS.orchard, type: "movie", title: "Glass Orchard", year: new Date().getFullYear() } });
  await api.ok("POST", `/api/profiles/${profile.id}/follow`, { imdbId: IDS.fields, on: true, title: "Quiet Fields" }, h);
};

module.exports = { seed, fill, IDS, day, todayKey };
