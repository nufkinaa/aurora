// The person sheet's data (src/media/person.js) and the route's per-profile
// marks and kids gate (routes/api.js personCredit). TMDB is a table of canned
// answers here: no key, no disk, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const person = require("../src/media/person");
const { parseId, slim, choose, roleLine, shortBio } = person._internals;

// ---------- a small TMDB ----------
const movie = (id, title, year, votes, extra = {}) => ({ id, media_type: "movie", title, release_date: `${year}-05-01`, vote_count: votes, vote_average: 7.44, poster_path: `/p${id}.jpg`, genre_ids: [18], ...extra });
const tv = (id, name, year, votes, extra = {}) => ({ id, media_type: "tv", name, first_air_date: `${year}-01-01`, vote_count: votes, vote_average: 8.06, poster_path: `/t${id}.jpg`, genre_ids: [18], ...extra });

const DIRECTOR = {
  id: 525, name: "Nora Chris", known_for_department: "Directing", birthday: "1970-07-30", place_of_birth: "London", profile_path: "/main.jpg",
  biography: "Nora Chris is a filmmaker. " + "She makes long films about time. ".repeat(30),
  external_ids: { imdb_id: "nm0634240" },
  images: { profiles: [
    { file_path: "/b.jpg", aspect_ratio: 0.667, vote_count: 3 },
    { file_path: "/a.jpg", aspect_ratio: 0.667, vote_count: 9 },
    { file_path: "/wide.jpg", aspect_ratio: 1.78, vote_count: 99 }, // not a portrait
    { file_path: "/main.jpg", aspect_ratio: 0.667, vote_count: 1 },
    ...Array.from({ length: 12 }, (_, i) => ({ file_path: `/x${i}.jpg`, aspect_ratio: 0.667, vote_count: 0 })),
  ] },
  combined_credits: {
    cast: [
      movie(900, "A Making Of", 2015, 300, { character: "Self", genre_ids: [99] }),
      tv(901, "The Late Sofa", 2010, 5000, { character: "Self - Guest", genre_ids: [35, 10767], episode_count: 1 }),
      movie(902, "Cameo Film", 1990, 56, { character: "Man in Black" }),
      movie(903, "Before She Was Born", 1960, 800, { character: "A Hen" }),
      movie(904, "Not For Here", 2001, 9000, { character: "X", adult: true }),
    ],
    crew: [
      { ...movie(1, "Stars Between", 2014, 38000), job: "Director", department: "Directing" },
      { ...movie(1, "Stars Between", 2014, 38000), job: "Screenplay", department: "Writing" },
      { ...movie(1, "Stars Between", 2014, 38000), job: "Producer", department: "Production" },
      { ...movie(2, "Dream Heist", 2010, 40000), job: "Director", department: "Directing" },
      { ...movie(3, "Steel Man", 2013, 15000), job: "Story", department: "Writing" },
      { ...movie(4, "Big League", 2017, 13000), job: "Executive Producer", department: "Production" },
      { ...movie(902, "Cameo Film", 1990, 56), job: "Director", department: "Directing" },
      { ...movie(5, "Thanked", 2019, 7000), job: "Thanks", department: "Crew" }, // not a job worth a card
    ],
  },
};
const ACTOR = {
  id: 17419, name: "Bryan Cran", known_for_department: "Acting", birthday: "1956-03-07", profile_path: "/bc.jpg",
  biography: "An actor.", external_ids: { imdb_id: "nm0186505" },
  images: { profiles: [{ file_path: "/bc.jpg", aspect_ratio: 0.667, vote_count: 5 }, { file_path: "/bc2.jpg", aspect_ratio: 0.667, vote_count: 2 }] },
  combined_credits: {
    cast: [
      tv(10, "Bad Chemistry", 2008, 14000, { character: "Walter", episode_count: 62 }),
      movie(11, "Private Rescue", 1998, 15000, { character: "Colonel" }),
      movie(12, "Panda Three", 2016, 5000, { character: "Li (voice)" }),
      tv(13, "Famous Sitcom", 1989, 20000, { character: "Dentist", episode_count: 1 }), // a guest spot
      movie(14, "Small One", 2001, 40, { character: "Dad" }),
      movie(15, "Unrated Indie", 2003, 30, { character: "Lead" }),
      movie(16, "No Imdb Id", 2004, 25, { character: "Lead" }),
    ],
    crew: [{ ...tv(10, "Bad Chemistry", 2008, 14000), job: "Director", department: "Directing" }],
  },
};
const TITLES = {
  "/movie/1": { imdb_id: "tt0000001", release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG-13" }] }, { iso_3166_1: "DE", release_dates: [{ certification: "12" }] }] } },
  "/movie/2": { imdb_id: "tt0000002", release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG-13" }] }] } },
  "/movie/3": { imdb_id: "tt0000003", release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "R" }] }] } },
  "/movie/4": { imdb_id: "tt0000004", release_dates: { results: [] } },
  "/movie/902": { imdb_id: "tt0000902", release_dates: { results: [] } },
  "/tv/10": { external_ids: { imdb_id: "tt0000010" }, content_ratings: { results: [{ iso_3166_1: "US", rating: "TV-MA" }] } },
  "/movie/11": { imdb_id: "tt0000011", release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "R" }] }] } },
  "/movie/12": { imdb_id: "tt0000012", release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG" }] }] } },
  "/tv/13": { external_ids: { imdb_id: "tt0000013" }, content_ratings: { results: [{ iso_3166_1: "US", rating: "TV-PG" }] } },
  "/movie/14": { imdb_id: "tt0000014", release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "G" }] }] } },
  "/movie/15": { imdb_id: "tt0000015", release_dates: { results: [] } },
  "/movie/16": { imdb_id: null, release_dates: { results: [] } },
};

// A fake TMDB: `routes` maps a path prefix to an answer, a function, or an
// Error to throw. Every request is logged.
const tmdb = (extra = {}) => {
  const calls = [];
  const routes = {
    "/person/525?": DIRECTOR,
    "/person/17419?": ACTOR,
    "/find/nm0186505": { person_results: [{ id: 17419 }] },
    "/find/tt0000010": { tv_results: [{ id: 10 }], movie_results: [] },
    "/tv/10/aggregate_credits": { cast: [{ id: 17419, name: "Bryan Cran" }, { id: 5, name: "Someone Else" }], crew: [] },
    "/search/person": { results: [{ id: 99, name: "Bryan Cran", popularity: 1 }, { id: 17419, name: "Bryan Cran", popularity: 30 }, { id: 7, name: "Bryan Cranberry", popularity: 90 }] },
    ...Object.fromEntries(Object.entries(TITLES).map(([k, v]) => [`${k}?`, v])),
    ...extra,
  };
  const getJson = async (p) => {
    calls.push(p);
    // the longest matching prefix answers
    const hit = Object.keys(routes).filter((k) => p.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!hit) { const e = new Error("tmdb 404"); e.status = 404; throw e; }
    const v = typeof routes[hit] === "function" ? await routes[hit](p) : routes[hit];
    if (v instanceof Error) throw v;
    return v;
  };
  return { getJson, calls, routes };
};
const mem = () => ({ data: {}, saves: 0, save() { this.saves++; } });
const make = (extra, o = {}) => {
  const t = tmdb(extra);
  const clock = { t: 1_800_000_000_000 };
  const stores = { store: mem(), titleStore: mem() };
  const p = person.create({ getJson: t.getJson, key: "k", now: () => clock.t, ...stores, ...o });
  return { p, t, clock, ...stores };
};

// ---------- ids ----------
test("an id is a TMDB number, an IMDb name id, or a name; anything else is refused", () => {
  assert.deepEqual(parseId("tmdb:525"), { kind: "tmdb", id: 525 });
  assert.deepEqual(parseId("525"), { kind: "tmdb", id: 525 });
  assert.deepEqual(parseId("nm0634240"), { kind: "imdb", id: "nm0634240" });
  assert.deepEqual(parseId("name:Bryan  Cranston "), { kind: "name", name: "Bryan Cranston" });
  assert.deepEqual(parseId("Zoë Saldaña"), { kind: "name", name: "Zoë Saldaña" });
  for (const bad of ["", " ", "x", "<script>", "name:", "a".repeat(200), null, undefined, "!!!"]) assert.equal(parseId(bad), null, String(bad));
});

// ---------- the filmography ----------
test("one entry per title with its jobs folded; chat shows, adult titles and thank-yous are gone; 'Self' is not a role", () => {
  const s = slim(DIRECTOR);
  const by = Object.fromEntries(s.credits.map((c) => [c.t, c]));
  assert.deepEqual(by["Stars Between"].roles, { directing: "Director", writing: "Writer", producing: "Producer" });
  assert.equal(s.credits.filter((c) => c.t === "Stars Between").length, 1);
  assert.equal(by["The Late Sofa"], undefined, "a talk show is not a credit");
  assert.equal(by["Not For Here"], undefined, "an adult title is never listed");
  assert.equal(by["Thanked"], undefined);
  assert.equal(by["A Making Of"].minor, true, "appearing as oneself is kept only as a last resort");
  assert.deepEqual(by["Cameo Film"].roles, { acting: "Man in Black", directing: "Director" });
  assert.equal(s.imdbId, "nm0634240");
  assert.equal(by["Dream Heist"].y, 2010);
  assert.equal(by["Dream Heist"].r, 7.4);
});

test("photos: the person's own portraits only, the main one first, the best-voted next, eight at most", () => {
  const s = slim(DIRECTOR);
  assert.equal(s.photos.length, 8);
  assert.deepEqual(s.photos.slice(0, 3), ["/main.jpg", "/a.jpg", "/b.jpg"]);
  assert.ok(!s.photos.includes("/wide.jpg"), "a landscape picture is a still, not a portrait");
});

test("the biography is cut at a sentence", () => {
  const b = shortBio(DIRECTOR.biography);
  assert.ok(b.length <= 421 && b.endsWith("."), b);
  assert.equal(shortBio(""), null);
  assert.equal(shortBio("Short."), "Short.");
});

test("a director's sheet leads with what they directed; other departments follow; a credit from before they were born is dropped", () => {
  const picked = choose(slim(DIRECTOR));
  assert.deepEqual(picked.map((x) => `${x.dept}:${x.credit.t}`), [
    "directing:Dream Heist", "directing:Stars Between", "directing:Cameo Film",
    "writing:Steel Man", "producing:Big League",
  ]);
  assert.equal(roleLine(picked[1].credit, "directing"), "Director · Writer · Producer");
  assert.equal(roleLine(picked[2].credit, "directing"), "Director · Man in Black");
});

test("an actor's guest spot in a famous series ranks under their real parts; what the household owns leads its group", () => {
  const s = slim(ACTOR);
  const names = choose(s).filter((x) => x.dept === "acting").map((x) => x.credit.t);
  assert.deepEqual(names.slice(0, 3), ["Private Rescue", "Bad Chemistry", "Panda Three"]);
  assert.ok(names.indexOf("Famous Sitcom") > names.indexOf("Panda Three"));
  const owned = choose(s, { owned: (c) => c.t === "Small One" });
  assert.equal(owned[0].credit.t, "Small One");
  assert.equal(owned[0].owned, true);
});

test("someone filed under Acting whose directing clearly outweighs it opens on what they directed", () => {
  const p = {
    knownFor: "Acting", born: "1983-08-04",
    credits: slim({ id: 1, name: "G", combined_credits: {
      cast: [movie(1, "Small Part", 2011, 3000, { character: "Patrice" }), movie(2, "Indie", 2013, 1500, { character: "Frances" })],
      crew: [{ ...movie(3, "Pink", 2023, 10000), job: "Director" }, { ...movie(3, "Pink", 2023, 10000), job: "Writer" }, { ...movie(4, "Bird", 2017, 9000), job: "Director" }, { ...movie(2, "Indie", 2013, 1500), job: "Writer" }],
    } }).credits,
  };
  const picked = choose(p);
  assert.deepEqual(picked.map((x) => `${x.dept}:${x.credit.t}`), ["directing:Pink", "directing:Bird", "acting:Small Part", "acting:Indie"]);
});

test("the answer is bounded: forty titles — thirty from the leading department, six from each other one, the room left to the best of the rest", () => {
  const cast = Array.from({ length: 70 }, (_, i) => movie(100 + i, `Film ${i}`, 2000, 5000 - i, { character: "Part" }));
  const crew = Array.from({ length: 30 }, (_, i) => ({ ...movie(300 + i, `Produced ${i}`, 2001, 4000 - i), job: "Producer" }));
  const picked = choose(slim({ id: 1, name: "Busy", known_for_department: "Acting", combined_credits: { cast, crew } }));
  assert.equal(picked.length, 40);
  assert.equal(picked.filter((x) => x.dept === "acting").length, 34);
  assert.equal(picked.filter((x) => x.dept === "producing").length, 6);
  assert.equal(picked[34].dept, "producing", "grouped: the leading department first");
  assert.equal(choose(slim({ id: 1, name: "Busy", known_for_department: "Acting", combined_credits: { cast, crew } }), { max: 10 }).length, 10);
});

// ---------- the answer ----------
test("a TMDB id answers with the person, sized photo addresses through the image proxy, and credits that carry IMDb ids", async () => {
  const { p, t } = make();
  const r = await p.get("tmdb:525");
  assert.equal(r.name, "Nora Chris");
  assert.equal(r.id, "tmdb:525");
  assert.equal(r.imdbId, "nm0634240");
  assert.equal(r.knownFor, "Directing");
  assert.equal(r.partial, false);
  assert.equal(r.photos.length, 8);
  assert.equal(r.photos[0].url, "https://image.tmdb.org/t/p/h632/main.jpg");
  assert.match(r.photos[0].thumb, /^\/img\/ext\?u=https%3A%2F%2Fimage\.tmdb\.org%2F.*&w=360$/);
  assert.match(r.photos[0].full, /^\/img\/ext\?u=.*original.*&w=960$/);
  const first = r.credits[0];
  assert.deepEqual(
    { title: first.title, year: first.year, type: first.type, role: first.role, dept: first.dept, imdbId: first.imdbId, poster: first.poster, certificate: first.certificate, kidsAge: first.kidsAge },
    { title: "Dream Heist", year: 2010, type: "movie", role: "Director", dept: "directing", imdbId: "tt0000002", poster: "https://image.tmdb.org/t/p/w342/p2.jpg", certificate: "13+", kidsAge: 13 },
  );
  assert.deepEqual(r.credits.map((c) => c.title), ["Dream Heist", "Stars Between", "Cameo Film", "Steel Man", "Big League"]);
  // one request for the person, one per title shown
  assert.equal(t.calls.filter((c) => c.startsWith("/person/")).length, 1);
  assert.equal(t.calls.filter((c) => /^\/(movie|tv)\/\d+\?/.test(c)).length, 5);
});

test("the second answer costs nothing: person and titles come off the disk cache until their time is up", async () => {
  const { p, t, clock, store, titleStore } = make();
  await p.get("tmdb:525");
  assert.ok(store.saves > 0 && titleStore.saves > 0, "kept on disk");
  const n = t.calls.length;
  await p.get("525");
  assert.equal(t.calls.length, n);
  // two weeks later the person is asked again. A title's IMDb id and rating
  // are kept for months — only the two nobody had rated yet are asked about
  // again (rating boards catch up).
  clock.t += 15 * 24 * 3600 * 1000;
  await p.get("tmdb:525");
  assert.deepEqual(t.calls.slice(n).sort(), [
    "/movie/4?append_to_response=external_ids,release_dates",
    "/movie/902?append_to_response=external_ids,release_dates",
    "/person/525?append_to_response=combined_credits,images,external_ids",
  ]);
});

test("two people opening the same sheet at once make one set of requests", async () => {
  const { p, t } = make();
  const [a, b] = await Promise.all([p.get("tmdb:525"), p.get("tmdb:525")]);
  assert.equal(a.credits.length, b.credits.length);
  assert.equal(t.calls.filter((c) => c.startsWith("/person/")).length, 1);
  assert.equal(new Set(t.calls).size, t.calls.length, "nothing asked twice");
});

test("a name is found through the credits of the title it was pressed on, and remembered", async () => {
  const { p, t } = make();
  const r = await p.get("name:Bryan Cran", { of: "tt0000010", type: "series" });
  assert.equal(r.id, "tmdb:17419");
  assert.ok(t.calls.includes("/find/tt0000010?external_source=imdb_id"));
  assert.ok(t.calls.includes("/tv/10/aggregate_credits"));
  assert.ok(!t.calls.some((c) => c.startsWith("/search/")), "no name search when the title knows them");
  const n = t.calls.length;
  await p.get("name:bryan cran", { of: "tt0000010" });
  assert.equal(t.calls.length, n, "the same name on the same title is not looked up again");
});

test("a bare name falls back to a search: the exact name wins, the better known of two namesakes first", async () => {
  const { p } = make();
  assert.equal((await p.get("name:Bryan Cran")).id, "tmdb:17419");
});

test("an IMDb name id resolves through TMDB's find", async () => {
  const { p, t } = make();
  assert.equal((await p.get("nm0186505")).name, "Bryan Cran");
  assert.ok(t.calls.includes("/find/nm0186505?external_source=imdb_id"));
});

test("a title with no IMDb id is left out — My List could not hold on to it", async () => {
  const { p } = make();
  const r = await p.get("tmdb:17419");
  assert.ok(!r.credits.some((c) => c.title === "No Imdb Id"));
  assert.ok(r.credits.some((c) => c.title === "Unrated Indie"));
  const show = r.credits.find((c) => c.title === "Bad Chemistry");
  assert.deepEqual({ type: show.type, role: show.role, imdbId: show.imdbId, kidsAge: show.kidsAge }, { type: "show", role: "Walter · Director", imdbId: "tt0000010", kidsAge: 17 });
});

test("slow title lookups do not hold the sheet: the budget passes, the answer is partial, the next one is whole", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { await gate; return TITLES["/movie/3"]; };
  const { p } = make({ "/movie/3?": slow });
  const r = await p.get("tmdb:525", { budgetMs: 40 });
  assert.equal(r.partial, true);
  assert.ok(!r.credits.some((c) => c.title === "Steel Man"));
  assert.equal(r.credits.length, 4);
  release();
  await new Promise((r2) => setTimeout(r2, 20));
  const again = await p.get("tmdb:525", { budgetMs: 40 });
  assert.equal(again.partial, false);
  assert.ok(again.credits.some((c) => c.title === "Steel Man"));
});

test("a title lookup that fails leaves that title out and says the answer is partial", async () => {
  const { p } = make({ "/movie/3?": new Error("tmdb 500") });
  const r = await p.get("tmdb:525");
  assert.equal(r.partial, true);
  assert.deepEqual(r.credits.map((c) => c.title), ["Dream Heist", "Stars Between", "Cameo Film", "Big League"]);
});

test("the one-request form failing: the parts are asked for, and credits come back even with no photos", async () => {
  const { combined_credits, images, ...base } = DIRECTOR;
  const { p, t, clock } = make({
    "/person/525?": new Error("tmdb 500"),
    "/person/525": base,
    "/person/525/combined_credits": combined_credits,
    "/person/525/images": new Error("tmdb 500"),
  });
  const r = await p.get("tmdb:525");
  assert.equal(r.name, "Nora Chris");
  assert.equal(r.credits.length, 5);
  assert.deepEqual(r.photos.map((x) => x.url), ["https://image.tmdb.org/t/p/h632/main.jpg"], "only the main portrait the person record itself carries");
  // …and such an answer is kept for an hour, not two weeks
  clock.t += 2 * 3600 * 1000;
  const n = t.calls.length;
  await p.get("tmdb:525");
  assert.ok(t.calls.length > n);
});

test("TMDB down: someone already known is still answered from the last copy; a stranger is a 502", async () => {
  const { p, t, clock } = make();
  await p.get("tmdb:525");
  clock.t += 30 * 24 * 3600 * 1000;
  for (const k of Object.keys(t.routes)) if (k.startsWith("/person/525")) t.routes[k] = new Error("tmdb 503");
  t.routes["/person/525"] = new Error("tmdb 503");
  const r = await p.get("tmdb:525");
  assert.equal(r.name, "Nora Chris");
  t.routes["/person/4242"] = new Error("tmdb 503");
  const stranger = await p.get("tmdb:4242");
  assert.equal(stranger.status, 502);
});

test("nobody by that name, a bad id, an adult performer: 404, 400, 404", async () => {
  const { p } = make({ "/search/person": { results: [] }, "/person/66?": { id: 66, name: "X", adult: true, combined_credits: {}, images: {} } });
  assert.equal((await p.get("name:Zzz Qqq")).status, 404);
  assert.equal((await p.get("<bad>")).status, 400);
  assert.equal((await p.get("tmdb:66")).status, 404);
  assert.equal((await p.get("tmdb:31337")).status, 404, "TMDB's own 404");
});

test("no TMDB key: a clear 503 for a stranger, the cached sheet for someone already known", async () => {
  const shared = { store: mem(), titleStore: mem() };
  const withKey = make({}, shared);
  await withKey.p.get("tmdb:525");
  const t = tmdb();
  const keyless = person.create({ getJson: t.getJson, key: null, now: () => withKey.clock.t, ...shared });
  const known = await keyless.get("tmdb:525");
  assert.equal(known.name, "Nora Chris");
  assert.equal(known.credits.length, 5);
  assert.equal(t.calls.length, 0, "nothing is asked without a key");
  const stranger = await keyless.get("tmdb:17419");
  assert.deepEqual({ status: stranger.status, noKey: stranger.noKey }, { status: 503, noKey: true });
  assert.equal((await keyless.get("name:Bryan Cran")).status, 503);
});

test("the stores stay bounded", async () => {
  const { p, store, clock } = make();
  for (let i = 0; i < 1100; i++) store.data[`r|n|filler ${i}|`] = { at: clock.t - 1000 - i, v: 1, id: i };
  await p.get("name:Bryan Cran");
  assert.ok(Object.keys(store.data).length < 1100);
  assert.ok(store.data["p|17419"], "the newest entry survives the trim");
});

// ---------- the route's half: this profile's marks, and the kids gate ----------
const { personCredit, personOverBudget } = require("../src/routes/api")._internals;
const credit = (o = {}) => ({ key: "m:1", imdbId: "tt0000001", type: "movie", title: "Stars Between", year: 2014, role: "Director", dept: "directing", poster: null, rating: 8.4, certificate: "12+", kidsAge: 13, ownedHint: false, ...o });
const LIB = { id: "lib1", type: "movie", title: "Stars Between", year: 2014 };

test("a credit is marked for the asking profile: in the library, in My List (either stored form), watched, part-way", () => {
  const findLibrary = (ref) => (ref.imdbId === "tt0000001" ? LIB : null);
  const plain = personCredit(credit(), { findLibrary: () => null });
  assert.deepEqual({ inLibrary: plain.inLibrary, inList: plain.inList, watched: plain.watched }, { inLibrary: null, inList: false, watched: false });
  assert.ok(!("kidsAge" in plain) && !("ownedHint" in plain), "server-side fields stay on the server");
  assert.equal(personCredit(credit(), { findLibrary }).inLibrary, "lib1");
  assert.equal(personCredit(credit(), { findLibrary, list: ["lib1"] }).inList, true, "listed as the library copy");
  assert.equal(personCredit(credit(), { findLibrary: () => null, list: [{ stream: true, imdbId: "tt0000001" }] }).inList, true, "listed as a stream ref");
  assert.equal(personCredit(credit(), { findLibrary: () => null, list: ["other", { stream: true, imdbId: "tt9" }] }).inList, false);
  assert.equal(personCredit(credit(), { findLibrary: () => null, row: () => ({ finished: true, position: 100, duration: 100 }) }).watched, true);
  assert.equal(personCredit(credit(), { findLibrary: () => null, row: () => ({ finished: false, position: 600, duration: 6000 }) }).progress, 0.1);
  // a series' history is per episode: no claim is made about the whole show
  assert.equal(personCredit(credit({ type: "show" }), { findLibrary: () => null, row: () => ({ finished: true }) }).watched, false);
});

test("kids: a title is shown only when its rating is known and within the limit — the strictest reading decides", () => {
  const base = { findLibrary: () => null };
  const kid = { maxAge: 12 };
  assert.equal(personCredit(credit({ kidsAge: 13, certificate: "12+" }), { ...base, kid }), null, "the strict age beats the lenient label");
  assert.ok(personCredit(credit({ kidsAge: 12, certificate: "12+" }), { ...base, kid }));
  assert.ok(personCredit(credit({ kidsAge: null, certificate: "6+" }), { ...base, kid }), "a label alone still counts");
  assert.equal(personCredit(credit({ kidsAge: null, certificate: null }), { ...base, kid }), null, "unknown rating: hidden");
  assert.equal(personCredit(credit({ kidsAge: 0, certificate: "ALL" }), { ...base, kid, certOf: () => 16 }), null, "the household's own stricter reading wins");
  assert.ok(personCredit(credit({ kidsAge: null, certificate: null }), { ...base, kid, certOf: () => "6+" }), "…and can vouch for a title TMDB says nothing about");
  assert.ok(personCredit(credit({ kidsAge: 18, certificate: "18+" }), { ...base, kid: null }), "nobody else is filtered");
});

test("the route is rate-limited per address", () => {
  const now = 5_000_000;
  let over = false;
  for (let i = 0; i < 40; i++) over = personOverBudget("10.9.9.9", now + i);
  assert.equal(over, false);
  assert.equal(personOverBudget("10.9.9.9", now + 50), true);
  assert.equal(personOverBudget("10.9.9.8", now + 50), false, "someone else is not held back");
  assert.equal(personOverBudget("10.9.9.9", now + 61_000 + 50), false, "a minute later it is open again");
});
