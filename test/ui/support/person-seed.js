// What the person-sheet tests seed into the private instance's cache, in the
// shapes src/media/xray.js and src/media/person.js write — so the SERVER
// answers /api/xray and /api/person without a network (see person.test.js).
const { certificatesSeed, IDS } = require("../../../scripts/ui-test-server");

const at = Date.now();
const NORA = {
  tmdbId: 525, imdbId: "nm0634240", name: "Nora Chris", knownFor: "Directing", born: "1970-07-30", died: null, place: "London",
  bio: "Nora Chris is a filmmaker known for long films about time. She began with shorts shot at weekends.", adult: false,
  photos: ["/nora-a.jpg", "/nora-b.jpg", "/nora-c.jpg"],
  credits: [
    { k: "m", id: 1, t: "Test Film One", y: 2020, p: null, v: 900, r: 7.1, g: [18], roles: { directing: "Director" }, s: 901 },
    { k: "m", id: 3, t: "Stars Between", y: 2014, p: null, v: 800, r: 8.4, g: [878, 12], roles: { directing: "Director", writing: "Writer" }, s: 801 },
    { k: "t", id: 4, t: "Test Show", y: 2021, p: null, v: 500, r: 8, g: [18], roles: { creating: "Creator" }, s: 501 },
    { k: "m", id: 2, t: "Test Film Two", y: 2021, p: null, v: 400, r: 6.2, g: [53], roles: { directing: "Director" }, s: 401 },
    { k: "m", id: 5, t: "Unrated Thing", y: 2001, p: null, v: 50, r: 5, g: [], roles: { acting: "A Cameo" }, s: 51 },
  ],
};
const STARS = "tt7000003";
const xrayTitle = (title) => ({
  at, v: 1, empty: false,
  data: {
    title,
    cast: [{ name: "Ada Actor", role: "The Lead", photo: null, id: "tmdb:600" }, { name: "Nora Chris", role: "A Cameo", photo: null }],
    crew: [{ name: "Nora Chris", job: "Director", id: "tmdb:525" }],
    ratings: [{ source: "IMDb", value: 7.1, scale: 10 }], facts: [], anthology: false, billed: [], tvmazeId: null, episodes: [], _videos: [], sources: ["cinemeta"],
  },
});

const seed = () => ({
  "cache/certificates.json": certificatesSeed({ film1: 0, show: 7, film2: 18 }),
  "cache/xray.json": { [`t|movie|${IDS.film1}`]: xrayTitle("Test Film One") },
  "cache/person.json": {
    "p|525": { at, v: 1, data: NORA },
    // a bare name, pressed on Test Film One (the cast line, TVMaze's people)
    [`r|n|nora chris|${IDS.film1}`]: { at, v: 1, id: 525 },
  },
  "cache/person-titles.json": {
    "m|1": { at, v: 1, i: IDS.film1, c: "ALL", a: 0 },
    "m|2": { at, v: 1, i: IDS.film2, c: "18+", a: 18 },
    "m|3": { at, v: 1, i: STARS, c: "6+", a: 6 },
    "t|4": { at, v: 1, i: IDS.show, c: "6+", a: 7 },
    "m|5": { at, v: 1, i: "tt7000005", c: null, a: null },
  },
});

module.exports = { seed, NORA, STARS };
