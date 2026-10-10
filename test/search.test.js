// The one search (src/media/search.js): ranking, the related tail,
// suggestions, de-duplication, kids filtering and the old answer shape —
// over a fixture corpus of the awkward cases. No network, no disk: the
// engine's sources are swapped for the fixture below.
const test = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../src/media/search");
const { _setSources, parseQuery, tierForms, forms, highlight, titleScore } = engine._internals;

// ---------- the corpus ----------
const lib = (id, type, title, year, imdbId, genres, extra = {}) =>
  ({ id, type, title, year, imdbId, genres, cover: `/img/${id}`, rating: 7, synopsis: "", ...extra });
const cat = (type, title, year, imdbId, genres = [], extra = {}) =>
  ({ type, title, year, imdbId, genres, poster: `https://p/${imdbId}.jpg`, rating: 7, synopsis: "", ...extra });

const LIBRARY = [
  lib("L1", "movie", "Inception", 2010, "tt1375666", ["Action", "Sci-Fi", "Thriller"], { synopsis: "A thief runs a heist inside dreams." }),
  lib("L2", "movie", "Avatar Movie", 2009, "tt0499549", ["Sci-Fi", "Adventure"]), // the folder's name, not the film's
  lib("L3", "show", "The Sopranos", 1999, "tt0141842", ["Crime", "Drama"], {
    seasons: [
      { number: 1, episodes: [{ id: "e1", season: 1, episode: 5, title: "College" }, { id: "e0", season: 1, episode: 1, title: "Episode 1" }] },
      { number: 2, episodes: [{ id: "e2", season: 2, episode: 1, title: "Heat" }] },
      { number: 3, episodes: [{ id: "e3", season: 3, episode: 11, title: "Pine Barrens" }] },
    ],
  }),
  lib("L4", "movie", "Troy", 2004, "tt0332452", ["Action", "History"]),
  lib("L5", "movie", "Dune", 1984, "tt0087182", ["Sci-Fi", "Adventure"]), // the OLD Dune is the one on disk
  lib("L6", "show", "The Gentlemen", 2024, "tt13210838", ["Crime", "Comedy"]),
  lib("L7", "show", "The Office", 2005, "tt0386676", ["Comedy"]),
];
const TRENDING = {
  movies: [
    cat("movie", "Dune: Part Two", 2024, "tt15239678", ["Sci-Fi", "Adventure"]),
    cat("movie", "The Gentlemen", 2019, "tt8367814", ["Crime", "Comedy"]),
    cat("movie", "Inception", 2010, "tt1375666", ["Action", "Sci-Fi"]), // the library's twin
    cat("movie", "Heat", 1995, "tt0113277", ["Crime", "Thriller"]),
    cat("movie", "It", 2017, "tt1396484", ["Horror"]),
    cat("movie", "Up", 2009, "tt1049413", ["Animation", "Family"]),
    cat("movie", "Her", 2013, "tt1798709", ["Romance", "Sci-Fi"]),
    cat("movie", "Se7en", 1995, "tt0114369", ["Crime", "Thriller"]),
    cat("movie", "WALL·E", 2008, "tt0910970", ["Animation", "Family"]),
    cat("movie", "Amélie", 2001, "tt0211915", ["Romance", "Comedy"]),
    cat("movie", "Rocky II", 1979, "tt0079817", ["Drama", "Sport"]),
    cat("movie", "Rocky III", 1982, "tt0084602", ["Drama", "Sport"]),
    cat("movie", "Interstellar", 2014, "tt0816692", ["Sci-Fi", "Adventure", "Drama"]),
    cat("movie", "The Dark Knight Rises", 2012, "tt1345836", ["Action", "Thriller"]),
    cat("movie", "Dunkirk", 2017, "tt5013056", ["War", "Drama"]),
    cat("movie", "It Follows", 2014, "tt3235888", ["Horror"]),
    cat("movie", "Upgrade", 2018, "tt6499752", ["Action", "Sci-Fi"]),
    cat("movie", "Here", 2024, "tt18272208", ["Drama"]),
    cat("movie", "Hereditary", 2018, "tt7784604", ["Horror"]),
    cat("movie", "Superbad", 2007, "tt0829482", ["Comedy"]),
    cat("movie", "The Italian Job", 2003, "tt0317740", ["Action", "Crime"]),
    cat("movie", "Avatar: The Way of Water", 2022, "tt1630029", ["Sci-Fi", "Adventure"]),
    cat("movie", "Arrival", 2016, "tt2543164", ["Sci-Fi", "Drama"]),
  ],
  shows: [
    cat("show", "The Office", 2001, "tt0290978", ["Comedy"]), // the UK one
    cat("show", "It", 1990, "tt0099864", ["Horror"]),
    cat("show", "Dune", 2000, "tt0142032", ["Sci-Fi"]),
    cat("show", "Friends", 1994, "tt0108778", ["Comedy", "Romance"]),
    cat("show", "The Thursday Murder Club", 2025, "tt12001534", ["Crime", "Comedy"]),
  ],
};
const FACTS = [
  { imdbId: "tt1375666", title: "Inception", cast: ["Leonardo DiCaprio", "Tom Hardy"], director: ["Christopher Nolan"], roles: [{ name: "Leonardo DiCaprio", role: "Dom Cobb" }] },
  { imdbId: "tt0499549", title: "Avatar", cast: ["Sam Worthington"], director: ["James Cameron"] },
  { imdbId: "tt1345836", cast: ["Christian Bale", "Tom Hardy"], director: ["Christopher Nolan"] },
  { imdbId: "tt5013056", cast: ["Tom Hardy"], director: ["Christopher Nolan"] },
  { imdbId: "tt0816692", cast: ["Matthew McConaughey"], director: ["Christopher Nolan"] },
  { imdbId: "tt1396484", cast: ["Bill Skarsgård"] },
];
const LIVE = {
  dune: {
    movies: [
      cat("movie", "Dune", 2021, "tt1160419", ["Sci-Fi"]),
      cat("movie", "Dune: Part Two", 2024, "tt15239678", ["Sci-Fi"]),
      cat("movie", "Dune", 1984, "tt0087182", ["Sci-Fi"]), // on disk: must not get a second card
      cat("movie", "Dune Drifter", 2020, "tt10521144", ["Sci-Fi"]),
    ],
    shows: [cat("show", "Dune", 2000, "tt0142032", ["Sci-Fi"])],
  },
  "the office": {
    movies: [cat("movie", "Office Space", 1999, "tt0151804", ["Comedy"]), cat("movie", "Bad Day at the Office", 2026, "tt9900001", ["Comedy"])],
    shows: [cat("show", "The Office", 2005, "tt0386676", ["Comedy"]), cat("show", "The Office", 2001, "tt0290978", ["Comedy"])],
  },
  freinds: { movies: [cat("movie", "Alex and Freinds", 2023, "tt26742274")], shows: [cat("show", "Friends", 1994, "tt0108778", ["Comedy"])] },
};

const libByImdb = new Map(LIBRARY.map((i) => [i.imdbId, i]));
let calls;
const fixture = (over = {}) => {
  calls = { live: [], similarFetch: [], personFetch: [] };
  _setSources({
    stamp: () => 1,
    libraryItems: () => LIBRARY,
    imdbIdFor: (i) => i.imdbId || null,
    markLibrary: (list) => {
      for (const m of list) m.inLibrary = libByImdb.has(m.imdbId) ? libByImdb.get(m.imdbId).id : null;
      return list;
    },
    trending: () => TRENDING,
    seenTitles: () => [],
    seenPeople: () => [],
    facts: () => FACTS,
    liveCached: () => null,
    live: async (q) => {
      calls.live.push(q);
      return LIVE[q.toLowerCase()] || { movies: [], shows: [] };
    },
    similarCached: () => null,
    collectionCached: () => null,
    canFetchSimilar: () => false,
    similarFetch: async (type, id) => { calls.similarFetch.push(id); return []; },
    canFetchPeople: () => false,
    personFetch: async (name) => { calls.personFetch.push(name); return null; },
    remember: () => {},
    ...over,
  });
};
const local = (q, opts = {}) => engine.search(q, { localOnly: true, ...opts });
const full = (q, opts = {}) => engine.search(q, { wait: true, commit: true, ...opts });
const names = (r) => r.results.map((x) => `${x.title} ${x.year}`);
const top = (r) => r.results[0] && `${r.results[0].title} ${r.results[0].year}`;

// ---------- ranking ----------
test("the scoring table: one tier per kind of match, in this order", () => {
  const t = (q, title) => tierForms(forms(q), forms(title));
  assert.equal(t("dune", "Dune"), 1000);
  assert.equal(t("DUNE!", "Dune"), 1000); // case, punctuation
  assert.equal(t("amelie", "Amélie"), 1000); // accents
  assert.equal(t("office", "The Office"), 1000); // a leading article, either side
  assert.equal(t("the dune", "Dune"), 1000);
  assert.equal(t("walle", "WALL·E"), 1000); // spacing
  assert.equal(t("wall-e", "WALL·E"), 1000);
  assert.equal(t("seven", "Se7en"), 1000); // a digit standing in for a letter
  assert.equal(t("rocky 2", "Rocky II"), 1000); // roman numerals
  assert.equal(t("dune part 2", "Dune: Part Two"), 1000); // number words
  assert.equal(t("fast and furious", "Fast & Furious"), 1000);
  assert.equal(t("dune", "Dune: Part Two"), 900); // starts with
  assert.equal(t("dun", "Dunkirk"), 900);
  assert.equal(t("spiderm", "Spider-Man"), 900); // …whatever the spacing
  assert.equal(t("of dune", "Children of Dune"), 820); // a run of whole words
  assert.equal(t("club thursday", "The Thursday Murder Club"), 800); // whole words, any order
  assert.equal(t("thurs clu", "The Thursday Murder Club"), 760); // word starts
  assert.equal(t("ception", "Inception"), 700); // inside a word
  assert.equal(t("incepton", "Inception"), 650); // one slip in the whole title
  assert.equal(t("intersteller", "Interstellar"), 650);
  assert.equal(t("murdr club thursday", "The Thursday Murder Club"), 600); // a slip in one word
  assert.equal(t("incpet", "Inception"), 580); // a slip while still typing
  assert.equal(t("dune", "Duel"), 0);
  assert.equal(t("man", "Men"), 0); // three letters: no substitutions
  assert.equal(t("arrival", "Inception"), 0);
});

test("one letter and two letters only match what starts with them / whole words", () => {
  const t = (q, title) => tierForms(forms(q), forms(title));
  assert.equal(t("i", "Inception"), 900);
  assert.equal(t("n", "Inception"), 0);
  assert.equal(t("it", "Split"), 0); // "it" inside a word is nothing
  assert.equal(t("up", "Superbad"), 0);
});

test("a year: with it, without it, one off, another one", () => {
  const s = (q, title, year) => titleScore(parseQuery(q), forms(title), year);
  assert.deepEqual([s("dune 2021", "Dune", 2021).tier, s("dune 2021", "Dune", 2021).ym], [1000, 1]);
  assert.equal(s("dune (2021)", "Dune", 2021).tier, 1000);
  assert.equal(s("her 2013", "Her", 2014).tier, 1000, "the catalogues disagree by a year");
  assert.equal(s("her 2013", "Her", 2014).ym, 0.5);
  assert.equal(s("dune 2021", "Dune", 1984).tier, 750, "the name, another year: kept, lower");
  assert.equal(s("dune 20", "Dune", 2021).tier, 990, "a year still being typed");
  assert.equal(s("dune 19", "Dune", 2021).tier, 0);
  assert.equal(s("blade runner 2049", "Blade Runner 2049", 2017).tier, 1000, "a number that is part of the title");
  assert.equal(s("arrival 2", "Arrival", 2016).tier, 990);
});

test("the first card for an exact title is that title — every title in the corpus, four spellings", async () => {
  fixture();
  const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const all = [...LIBRARY, ...TRENDING.movies, ...TRENDING.shows];
  for (const item of all) {
    if (item.title === "Avatar Movie") continue; // (its real name has a test of its own)
    for (const q of [item.title, item.title.toLowerCase(), strip(item.title).toUpperCase(), item.title.replace(/^the /i, "")]) {
      const r = await local(q);
      assert.ok(r.results.length, `"${q}" found nothing`);
      assert.equal(tierForms(forms(q), forms(r.results[0].title)), 1000, `"${q}" → first card "${r.results[0].title}"`);
      // …and when the library has a title of that name, the first card is the library's
      const owned = LIBRARY.find((l) => tierForms(forms(q), forms(l.title)) === 1000);
      if (owned) assert.equal(r.results[0].id, owned.id, `"${q}" → the library's ${owned.title} first`);
    }
  }
});

test("'It', 'Up', 'Her': a two- or three-letter title comes before everything that merely starts with it", async () => {
  fixture();
  assert.deepEqual(names(await local("it")), ["It 2017", "It 1990", "It Follows 2014", "The Italian Job 2003"]);
  assert.deepEqual(names(await local("up")), ["Up 2009", "Upgrade 2018"]);
  assert.deepEqual(names(await local("her")), ["Her 2013", "Here 2024", "Hereditary 2018"]);
});

test("'The Office' US and UK: both, the library's first; 'office' finds them too", async () => {
  fixture();
  for (const q of ["The Office", "the office", "office"]) {
    const r = await local(q);
    assert.deepEqual(names(r).slice(0, 2), ["The Office 2005", "The Office 2001"], q);
    assert.equal(r.results[0].id, "L7");
    assert.equal(r.results[1].source, "stream");
  }
});

test("Dune 1984 / 2021 / Part Two: exact before 'starts with', library before catalogue, one card per title", async () => {
  fixture();
  const first = await engine.search("dune"); // what is in memory
  assert.deepEqual(names(first), ["Dune 1984", "Dune 2000", "Dune: Part Two 2024", "Dunkirk 2017"].slice(0, 3));
  assert.equal(first.pending, true, "the catalogue has not been asked yet");

  const r = await full("dune");
  assert.deepEqual(names(r), ["Dune 1984", "Dune 2021", "Dune 2000", "Dune: Part Two 2024", "Dune Drifter 2020"]);
  assert.equal(r.results[0].id, "L5", "the library's copy");
  assert.equal(r.results.filter((x) => x.imdbId === "tt0087182").length, 1, "the catalogue twin of the library's Dune is not a second card");
  assert.equal(r.pending, false);

  assert.equal(top(await full("dune 2021")), "Dune 2021");
  assert.equal(top(await full("dune 1984")), "Dune 1984");
  for (const q of ["dune part two", "dune: part 2", "Dune Part II", "dune part tow"]) assert.equal(top(await local(q)), "Dune: Part Two 2024", q);
});

test("Se7en / Seven, WALL·E, Amélie, Rocky II / 2 / III", async () => {
  fixture();
  for (const q of ["se7en", "seven", "Seven"]) assert.equal(top(await local(q)), "Se7en 1995", q);
  for (const q of ["WALL·E", "wall-e", "wall e", "walle", "Wall.E"]) assert.equal(top(await local(q)), "WALL·E 2008", q);
  for (const q of ["Amélie", "amelie", "AMELIE"]) assert.equal(top(await local(q)), "Amélie 2001", q);
  assert.deepEqual(names(await local("rocky 2")).slice(0, 1), ["Rocky II 1979"]);
  assert.deepEqual(names(await local("rocky ii")).slice(0, 2), ["Rocky II 1979", "Rocky III 1982"]);
  assert.deepEqual(names(await local("rocky 3")), ["Rocky III 1982"]);
  assert.deepEqual(names(await local("rocky")), ["Rocky II 1979", "Rocky III 1982"]);
});

test("a show and a film with the same name are two cards; the library's first", async () => {
  fixture();
  const r = await local("the gentlemen");
  assert.deepEqual(r.results.slice(0, 2).map((x) => `${x.type} ${x.year}`), ["show 2024", "movie 2019"]);
  assert.equal(r.results[0].id, "L6");
});

test("an episode called like a film: the film first, the show after it, saying which episode", async () => {
  fixture();
  const r = await local("heat");
  assert.equal(top(r), "Heat 1995");
  const show = r.results.find((x) => x.id === "L3");
  assert.ok(show, "the show with an episode called Heat is in the list");
  assert.deepEqual(show.match, { tier: 520, kind: "episode", label: "S2 E1 · Heat" });
  assert.equal(show.meta, "S2 E1 · Heat");
  assert.ok(r.results.indexOf(show) > 0);

  const pine = await local("pine barrens");
  assert.equal(pine.results[0].id, "L3");
  assert.equal(pine.results[0].match.kind, "episode");
  assert.equal((await local("episode 1")).results.some((x) => x.id === "L3"), false, "'Episode 1' is not a name");
});

test("a library title under its real name: the folder says 'Avatar Movie', the film is 'Avatar'", async () => {
  fixture();
  const r = await local("avatar");
  assert.equal(r.results[0].id, "L2");
  assert.equal(r.results[0].match.tier, 1000);
  assert.deepEqual(names(r).slice(0, 2), ["Avatar Movie 2009", "Avatar: The Way of Water 2022"]);
  assert.equal(top(await local("avatar 2009")), "Avatar Movie 2009");
});

test("typos: the title a slip away is found; one in the library sits right under 'starts with'", async () => {
  fixture();
  for (const [q, want] of [["incepton", "Inception 2010"], ["inecption", "Inception 2010"], ["intersteller", "Interstellar 2014"], ["teh office", "The Office 2005"], ["tory", "Troy 2004"], ["sopranso", "The Sopranos 1999"], ["honey", undefined]]) {
    assert.equal(top(await local(q)), want, q);
  }
  // the catalogue's own first answer for a mistyped name outranks a title that merely contains the typo
  const r = await full("freinds");
  assert.deepEqual(names(r), ["Friends 1994", "Alex and Freinds 2023"]);
  assert.equal(r.results[0].match.tier, 890);
});

test("no near-misses under a title named exactly", async () => {
  fixture();
  const r = await local("here"); // "Her" is one letter away
  assert.deepEqual(names(r), ["Here 2024", "Hereditary 2018"]);
});

test("people and characters: their titles, the library's first, each saying why", async () => {
  fixture();
  const r = await local("tom hardy");
  assert.deepEqual(names(r), ["Inception 2010", "The Dark Knight Rises 2012", "Dunkirk 2017"]);
  assert.deepEqual(r.results[0].match, { tier: 420, kind: "person", label: "Tom Hardy" });
  assert.equal(r.results[0].meta, "With Tom Hardy");
  assert.deepEqual(names(await local("nolan")).sort(), ["Dunkirk 2017", "Inception 2010", "Interstellar 2014", "The Dark Knight Rises 2012"]);
  assert.equal(top(await local("christoper nolan")), "Inception 2010", "a typo in a name");
  const role = await local("dom cobb");
  assert.deepEqual(names(role), ["Inception 2010"]);
  assert.equal(role.results[0].meta, "Leonardo DiCaprio as Dom Cobb");
});

test("the synopsis is the last resort, and never under a real title match", async () => {
  fixture();
  const r = await local("heist dreams");
  assert.deepEqual(names(r), ["Inception 2010"]);
  assert.equal(r.results[0].match.kind, "synopsis");
  assert.equal((await local("inception")).results.some((x) => x.match.kind === "synopsis"), false);
});

test("order inside a tier: the typed year, the library, popularity — never across tiers", async () => {
  fixture();
  const r = await full("dune");
  const tiers = r.results.map((x) => x.match.tier);
  assert.deepEqual(tiers, [...tiers].sort((a, b) => b - a), "tiers only ever go down the list");
  // a hugely popular 'starts with' never passes an obscure exact match
  fixture({ trending: () => ({ movies: [cat("movie", "Jolt Force", 2025, "tt9900010"), ...Array.from({ length: 30 }, (_, i) => cat("movie", `Filler ${i}`, 2000, `tt99100${i}`)), cat("movie", "Jolt", 2001, "tt9900011")], shows: [] }) });
  assert.deepEqual(names(await local("jolt")), ["Jolt 2001", "Jolt Force 2025"]);
});

test("the card that was first stays first when the catalogue answers — unless something matches better", async () => {
  fixture({ libraryItems: () => [] });
  const before = await engine.search("the office");
  assert.equal(top(before), "The Office 2001"); // the only one in memory
  const pinned = await full("the office", { pin: before.results[0].key });
  assert.equal(top(pinned), "The Office 2001", "equal match: the card on screen keeps its place");
  assert.equal(top(await full("the office")), "The Office 2005", "(without the pin the catalogue's order decides)");
  // a better MATCH does take the first place
  const b2 = await engine.search("dune 2021");
  const after = await full("dune 2021", { pin: b2.results[0].key });
  assert.equal(top(after), "Dune 2021");
});

// ---------- the related tail ----------
test("related: after an exact match, its neighbours — never mixed into the matches, never a duplicate", async () => {
  fixture();
  const r = await local("inception");
  assert.equal(top(r), "Inception 2010");
  assert.equal(r.relatedLabel, "More like Inception");
  assert.equal(r.relatedKind, "similar");
  assert.ok(r.related.length >= 3);
  const keys = new Set(r.results.map((x) => x.key));
  assert.equal(r.related.some((x) => keys.has(x.key)), false, "a related card repeats a result");
  assert.equal(new Set(r.related.map((x) => x.key)).size, r.related.length);
  // shared cast first, then genre neighbours — each card says which
  assert.deepEqual(r.related.slice(0, 3).map((x) => x.title).sort(), ["Dunkirk", "Interstellar", "The Dark Knight Rises"]);
  assert.equal(r.related[0].why.kind, "cast");
  assert.ok(r.related.some((x) => x.why.kind === "genre"));
  assert.equal(r.related.some((x) => x.title === "Superbad"), false, "nothing in common is not related");
});

test("related: the franchise and the 'more like this' row come first when they are cached", async () => {
  fixture({
    collectionCached: (id) => (id === "tt1375666" ? { collection: { name: "Dream Collection", items: [cat("movie", "Inception", 2010, "tt1375666"), cat("movie", "Dream Two", 2030, "tt9900020")] } } : null),
    similarCached: (type, id) => (id === "tt1375666" ? [cat("movie", "Paprika", 2006, "tt0851578"), cat("movie", "Arrival", 2016, "tt2543164")] : null),
  });
  const r = await local("inception");
  assert.deepEqual(r.related.slice(0, 3).map((x) => [x.title, x.why.kind]), [["Dream Two", "collection"], ["Paprika", "similar"], ["Arrival", "similar"]]);
  assert.equal(r.related[0].why.label, "Dream Collection");
});

test("related: a row that must be fetched is fetched only for a title named in full, only in the waiting call", async () => {
  fixture({ canFetchSimilar: () => true, similarFetch: async (type, id) => { calls.similarFetch.push(id); return [cat("movie", "Paprika", 2006, "tt0851578")]; } });
  const first = await local("inception");
  assert.equal(first.pending, true);
  assert.deepEqual(calls.similarFetch, [], "nothing is fetched by the instant answer");
  const second = await local("inception", { wait: true });
  assert.deepEqual(calls.similarFetch, ["tt1375666"]);
  assert.equal(second.related[0].title, "Paprika");
  assert.equal(second.pending, false);
  await local("incep", { wait: true }); // one film left, but not named in full
  assert.deepEqual(calls.similarFetch, ["tt1375666"], "typing does not fetch");
});

test("related: none without a confident match; a lone 'starts with' is confident", async () => {
  fixture();
  for (const q of ["th", "i", "the", "zzqqxx", "du"]) {
    const r = await local(q);
    assert.deepEqual([r.related.length, r.relatedLabel], [0, null], q);
  }
  const r = await local("incep");
  assert.equal(r.relatedLabel, "More like Inception");
});

test("related: a genre query lists the genre (library first); a person query their other titles", async () => {
  fixture();
  const g = await local("comedy");
  assert.deepEqual([g.results.length, g.relatedKind, g.relatedLabel], [0, "genre", "Comedy"]);
  assert.ok(g.related.length >= 4);
  assert.ok(g.related.every((x) => (x.genres || []).includes("Comedy")));
  assert.equal(g.related[0].source, "downloaded");
  assert.equal((await local("sci fi")).relatedLabel, "Sci-Fi");
  assert.equal((await local("science fiction")).relatedLabel, "Sci-Fi");

  fixture({
    canFetchPeople: () => true,
    personFetch: async (name) => {
      calls.personFetch.push(name);
      return /nolan/i.test(name) ? { name: "Christopher Nolan", items: [cat("movie", "Oppenheimer", 2023, "tt15398776"), cat("movie", "Inception", 2010, "tt1375666")] } : null;
    },
  });
  const p1 = await local("christopher nolan");
  assert.equal(p1.pending, true);
  assert.deepEqual(calls.personFetch, []);
  const p = await local("christopher nolan", { wait: true });
  assert.deepEqual(calls.personFetch, ["Christopher Nolan"]);
  assert.deepEqual([p.relatedKind, p.relatedLabel], ["person", "With Christopher Nolan"]);
  assert.deepEqual(p.related.map((x) => x.title), ["Oppenheimer"], "Inception is already a result");
  await local("inception", { wait: true });
  await local("dune", { wait: true });
  assert.equal(calls.personFetch.length, 1, "a title search never costs a people lookup");
});

// ---------- kids ----------
test("a kids profile: results, related and suggestions hold only what it may see — and the tail is built on what is left", async () => {
  fixture();
  const blocked = new Set(["tt1375666", "tt1396484", "tt1345836", "tt5013056", "tt0816692"]); // Inception, It, and every Nolan film
  const allow = (item) => !blocked.has(item.imdbId);
  const r = await local("inception", { allow });
  assert.deepEqual([r.results.length, r.related.length, r.anchor], [0, 0, null], "no 'More like' a title it cannot see");
  assert.deepEqual(names(await local("it", { allow })), ["It 1990", "It Follows 2014", "The Italian Job 2003"]);
  const d = await local("dune", { allow: (item) => item.imdbId !== "tt0816692" });
  assert.equal(d.related.some((x) => x.title === "Interstellar"), false);

  const s = engine.suggest("inc", { allow });
  assert.deepEqual(s, []);
  assert.equal(engine.suggest("tom", { allow }).some((x) => x.kind === "person"), false, "a person with no title left is not suggested");
  assert.equal(engine.suggest("tom").some((x) => x.kind === "person" && x.name === "Tom Hardy"), true);
});

test("the kids gate filters v2 answers on the way out as well", () => {
  const kids = require("../src/lib/kids");
  const gate = kids.createGate({
    kidsFor: () => ({ profile: "kid", maxAge: 7, source: "lock" }),
    certOf: (item) => ({ tt1: "ALL", tt2: "18+" })[item.imdbId] || null,
    findById: () => null,
  });
  const run = (path, query, body) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const req = { path, method: "GET", query, headers: {} };
    gate(req, res, () => res.json(body));
    return { res, req };
  };
  const a = { imdbId: "tt1", title: "A" };
  const b = { imdbId: "tt2", title: "B" };
  const s = run("/api/search", { q: "x", v: "2" }, { results: [a, b], related: [b, a], relatedLabel: "x" });
  assert.deepEqual([s.res.body.results, s.res.body.related], [[a], [a]]);
  assert.equal(typeof s.req.kidsAllows, "function", "the handler is handed the same judgement");
  assert.deepEqual([s.req.kidsAllows(a), s.req.kidsAllows(b)], [true, false]);
  const sug = run("/api/search/suggest", { q: "x", v: "2" }, { suggestions: [{ kind: "title", ...a }, { kind: "title", ...b }, { kind: "person", name: "P" }, { kind: "genre", name: "G" }] });
  assert.deepEqual(sug.res.body.suggestions.map((x) => x.kind + (x.title || x.name)), ["titleA", "personP", "genreG"]);
});

// ---------- suggestions ----------
test("suggestions: what starts with the letters first (library, then catalogue), no duplicates, eight at most", () => {
  fixture();
  const s = engine.suggest("du");
  assert.deepEqual(s.map((x) => `${x.title} ${x.year}`), ["Dune 1984", "Dune: Part Two 2024", "Dune 2000", "Dunkirk 2017"]);
  assert.deepEqual(s[0], { kind: "title", id: "L5", imdbId: "tt0087182", type: "movie", title: "Dune", year: 1984, cover: "/img/L5", inLibrary: true, hl: [[0, 2]] });
  assert.equal(s[1].inLibrary, false); // (and among the catalogue's, the more popular first)
  assert.equal(s.filter((x) => x.title === "Inception").length <= 1, true);
  const many = engine.suggest("the");
  assert.equal(many.length, 8);
  assert.equal(new Set(many.map((x) => x.id || x.imdbId || x.name)).size, many.length);
  assert.ok(many.slice(0, 3).every((x) => x.inLibrary), "the library's titles lead");
  assert.equal(engine.suggest("the", { limit: 5 }).length, 5);
  assert.deepEqual(engine.suggest(""), []);
  assert.deepEqual(engine.suggest("zzqqxx"), []);
});

test("suggestions: one letter is enough, and only lists what starts with it", () => {
  fixture();
  const s = engine.suggest("i");
  assert.ok(s.length >= 4);
  assert.ok(s.every((x) => x.kind === "title" && /^(the )?i/i.test(x.title)), JSON.stringify(s.map((x) => x.title)));
  assert.equal(s[0].title, "Inception", "the library's first");
});

test("suggestions: people and genres are rows of their own kind", () => {
  fixture();
  const tom = engine.suggest("tom");
  assert.deepEqual(tom.find((x) => x.kind === "person"), { kind: "person", name: "Tom Hardy", count: 3, hl: [[0, 3]] });
  const hardy = engine.suggest("hardy");
  assert.deepEqual(hardy.map((x) => [x.kind, x.name]), [["person", "Tom Hardy"]]);
  assert.deepEqual(hardy[0].hl, [[4, 9]]);
  const com = engine.suggest("com");
  assert.deepEqual(com.find((x) => x.kind === "genre"), { kind: "genre", name: "Comedy", hl: [[0, 3]] });
  // a title that starts with the letters still comes before a person
  const ch = engine.suggest("in");
  assert.equal(ch[0].title, "Inception");
  // the Movies / Shows pages ask for one kind of title: no people, no genres, no other kind
  const typed = engine.suggest("the", { type: "show" });
  assert.ok(typed.length && typed.every((x) => x.kind === "title" && x.type === "show"));
  assert.equal(engine.suggest("tom", { type: "movie" }).some((x) => x.kind !== "title"), false);
});

test("suggestions: typos find the title, under anything that starts with the letters", () => {
  fixture();
  assert.equal(engine.suggest("incepton")[0].title, "Inception");
  assert.deepEqual(engine.suggest("incepton")[0].hl, [], "nothing to underline in a typo match");
  assert.equal(engine.suggest("intersteller")[0].title, "Interstellar");
  const s = engine.suggest("her"); // Her, Here, Hereditary start with it; nothing fuzzy above them
  assert.deepEqual(s.slice(0, 3).map((x) => x.title), ["Her", "Here", "Hereditary"]);
});

test("suggestions are stable while typing: the first row only changes for a better match", () => {
  fixture();
  for (const [word, want, from] of [["inception", "Inception", 1], ["the office", "The Office", 5], ["the sopranos", "The Sopranos", 5], ["dune: part two", "Dune", 2]]) {
    let locked = false;
    for (let n = from; n <= word.length; n++) {
      const q = word.slice(0, n);
      if (!q.trim() || q.endsWith(" ")) continue;
      const first = engine.suggest(q)[0];
      assert.ok(first, `"${q}" suggested nothing`);
      if (word === "dune: part two" && n > 5) {
        // past "dune" the only thing still matching is Part Two
        assert.equal(first.title, "Dune: Part Two", q);
        continue;
      }
      assert.equal(first.title, want, `first row for "${q}"`);
      locked = true;
    }
    assert.ok(locked);
  }
});

test("highlight: the matched letters in the title as it is printed", () => {
  const h = (title, q) => highlight(title, parseQuery(q)).map(([a, b]) => title.slice(a, b));
  assert.deepEqual(h("Dune: Part Two", "dune"), ["Dune"]);
  assert.deepEqual(h("The Office", "office"), ["Office"]);
  assert.deepEqual(h("WALL·E", "walle"), ["WALL·E"]);
  assert.deepEqual(h("Amélie", "amel"), ["Amél"]);
  assert.deepEqual(h("Honey Don't!", "honey dont"), ["Honey Don't"]);
  assert.deepEqual(h("The Thursday Murder Club", "club thurs"), ["Thurs", "Club"]);
  assert.deepEqual(h("Inception", "xyz"), []);
});

test("suggestions answer fast on a big index (3,000 titles)", () => {
  const big = Array.from({ length: 3000 }, (_, i) => cat(i % 3 ? "movie" : "show", `Title ${i.toString(36)} of the ${["Lost", "Dark", "Blue", "Last"][i % 4]} ${["City", "River", "Night"][i % 3]}`, 1980 + (i % 45), `tt77${String(i).padStart(5, "0")}`, ["Drama"]));
  fixture({ trending: () => ({ movies: big, shows: [] }) });
  engine.suggest("warm up"); // builds the index
  const t0 = process.hrtime.bigint();
  for (const q of ["t", "ti", "title 1", "lost cit", "dark rivr", "the lats night", "inception"]) engine.suggest(q);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 7;
  assert.ok(ms < 50, `a suggestion took ${ms.toFixed(1)} ms on 3,000 titles`);
});

// ---------- one card per title; the old answer ----------
test("a library title and its catalogue twin are one card (by id, and by name + year when the id is missing)", async () => {
  fixture({
    libraryItems: () => [...LIBRARY, lib("L9", "movie", "Arrival", 2016, null, ["Sci-Fi"])], // no id resolved yet
    imdbIdFor: (i) => i.imdbId || null,
  });
  const inc = await local("inception");
  assert.equal(inc.results.filter((x) => x.title === "Inception").length, 1);
  assert.equal(inc.results[0].id, "L1");
  const arr = await local("arrival");
  assert.equal(arr.results.filter((x) => x.title === "Arrival").length, 1);
  assert.deepEqual([arr.results[0].id, arr.results[0].imdbId], ["L9", "tt2543164"], "the library card, with the id the twin brought");
});

test("card shape: a library card is the library item (no episode tree), a catalogue card opens as a stream", async () => {
  fixture();
  const r = await local("the sopranos");
  const c = r.results[0];
  assert.deepEqual([c.id, c.type, c.title, c.cover, c.inLibrary, c.source, c.key], ["L3", "show", "The Sopranos", "/img/L3", "L3", "downloaded", "lib:L3"]);
  assert.equal("seasons" in c, false);
  const s = (await local("superbad")).results[0];
  assert.deepEqual(
    { imdbId: s.imdbId, type: s.type, title: s.title, year: s.year, poster: s.poster, cover: s.cover, inLibrary: s.inLibrary, source: s.source, key: s.key },
    { imdbId: "tt0829482", type: "movie", title: "Superbad", year: 2007, poster: "https://p/tt0829482.jpg", cover: "https://p/tt0829482.jpg", inLibrary: null, source: "stream", key: "tt0829482" },
  );
});

test("clients from before v2: `results` are the library's own items, `catalog` the cached catalogue's — both in the new order", () => {
  fixture();
  const old = engine.legacy("dune");
  assert.deepEqual(Object.keys(old), ["results", "catalog"]);
  assert.equal(old.results[0], LIBRARY.find((i) => i.id === "L5"), "the very library item, as before");
  assert.deepEqual(old.catalog.map((c) => c.title), ["Dune", "Dune: Part Two", "Dunkirk"].slice(0, old.catalog.length));
  assert.deepEqual(Object.keys(old.catalog[0]), ["imdbId", "type", "title", "year", "poster", "rating", "genres", "score"]);
  assert.equal(old.catalog.some((c) => c.imdbId === "tt0087182"), false, "nothing the library owns is in `catalog`");
  assert.deepEqual(engine.legacy(""), { results: [], catalog: [] });
  // "it": the film, exactly, first — it used to come after every library title containing the letters
  assert.equal(engine.legacy("it").catalog[0].title, "It");
});

test("the live catalogue is asked once per spelling, from three letters while typing, at any length when committed", async () => {
  fixture();
  await engine.search("it", { wait: true });
  assert.deepEqual(calls.live, []);
  await engine.search("it", { wait: true, commit: true });
  assert.deepEqual(calls.live, ["it"]);
  calls.live.length = 0;
  await engine.search("WALL·E", { wait: true });
  assert.deepEqual(calls.live, ["WALL E", "walle"], "the words, and the joined spelling the catalogue knows");
  calls.live.length = 0;
  await engine.search("her 2013", { wait: true });
  assert.deepEqual(calls.live, ["her 2013", "her"], "and the name without the year");
  calls.live.length = 0;
  const instant = await engine.search("dune");
  assert.deepEqual([instant.pending, calls.live.length], [true, 1], "the instant answer starts the lookup and says more is coming");
});

test("a catalogue that fails or hangs never loses the local answer", async () => {
  fixture({ live: async () => { throw new Error("down"); } });
  const r = await full("dune");
  assert.equal(top(r), "Dune 1984");
  assert.equal(r.catalogFailed, true);
});
