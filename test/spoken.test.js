// Voice search (src/media/spoken.js): what a microphone heard, tidied into
// the query the search reads — English and Hebrew — and the best of its
// spellings searched by the real engine over a fixture corpus. No network:
// the engine's sources and the Wikipedia lookup are swapped for fixtures.
const test = require("node:test");
const assert = require("node:assert/strict");

const spoken = require("../src/media/spoken");
const engine = require("../src/media/search");
const { normalize } = spoken;

const said = (text) => {
  const n = normalize(text);
  return { q: n.q, season: n.season, episode: n.episode, spellings: n.candidates.map((c) => c.q) };
};

// ---------- the normaliser ----------
test("English: the command, the kind and courtesy words are not the title", () => {
  assert.equal(said("search for the movie Inception").q, "Inception");
  assert.equal(said("Hey Aurora, play Breaking Bad").q, "Breaking Bad");
  assert.equal(said("find me the tv show the office please").q, "the office");
  assert.equal(said("I want to watch Dune").q, "Dune");
  assert.equal(said("can you show me Interstellar").q, "Interstellar");
  assert.equal(said("Look up the film Arrival.").q, "Arrival");
  // nothing but a command is left as it was ("Search" — maybe a title, never empty)
  assert.equal(said("search").q, "search");
  assert.equal(said("play").q, "play");
});

test("English: season and episode are read off the title", () => {
  assert.deepEqual(said("Breaking Bad season two episode three"), {
    q: "Breaking Bad", season: 2, episode: 3, spellings: ["Breaking Bad", "Breaking Bad season 2 episode 3"],
  });
  assert.deepEqual(said("play the sopranos season 3, episode 11").q, "the sopranos");
  assert.equal(said("play the sopranos season 3, episode 11").season, 3);
  assert.equal(said("play the sopranos season 3, episode 11").episode, 11);
  assert.deepEqual([said("season 2 of Fauda").q, said("season 2 of Fauda").season], ["Fauda", 2]);
  assert.deepEqual([said("the second season of the office").q, said("the second season of the office").season], ["the office", 2]);
  assert.deepEqual(said("s2e3 the sopranos"), { q: "the sopranos", season: 2, episode: 3, spellings: ["the sopranos"] });
  assert.deepEqual([said("Silo episode five").q, said("Silo episode five").episode, said("Silo episode five").season], ["Silo", 5, null]);
  // a title that only sounds like it keeps its words
  assert.equal(said("Season of the Witch").q, "Season of the Witch");
  assert.equal(said("John Wick chapter 2").q, "John Wick chapter 2");
});

test("English numbers: words become digits, and the other spelling is tried too", () => {
  assert.deepEqual(said("seven").spellings, ["7", "seven"]);
  assert.deepEqual(said("oceans eleven").spellings, ["oceans 11", "oceans eleven"]);
  assert.deepEqual(said("Ocean's 11").spellings, ["Ocean's 11", "Ocean's eleven"]);
  assert.deepEqual(said("twenty-one jump street").spellings, ["21 jump street", "twenty one jump street"]);
  assert.equal(said("apollo thirteen").q, "apollo 13");
  assert.equal(said("Dune part two").q, "Dune part 2");
  assert.equal(said("three hundred").q, "300");
  assert.equal(said("the hundred").q, "the hundred", "'hundred' alone is a word");
  // years said in two halves
  assert.equal(said("nineteen eighty four").q, "1984");
  assert.equal(said("blade runner twenty forty nine").q, "blade runner 2049");
  assert.equal(said("twenty twenty one").q, "2021");
  assert.equal(said("two thousand and nineteen").q, "2019");
  assert.equal(said("nineteen oh five").q, "1905");
  // 1-10 the engine reads both ways itself: no second spelling of the digits
  assert.deepEqual(said("Toy Story 3").spellings, ["Toy Story 3"]);
  // a digit inside a word is the word's
  assert.deepEqual(said("Se7en").spellings, ["Se7en"]);
  // ordinals stay words outside a season / an episode
  assert.equal(said("The Fifth Element please").q, "The Fifth Element");
});

test("Hebrew: commands, kinds, seasons and episodes, numbers as words", () => {
  assert.deepEqual(said("תחפש את הסדרה פאודה עונה שנייה"), {
    q: "פאודה", season: 2, episode: null, spellings: ["פאודה", "תחפש את הסדרה פאודה עונה שנייה"],
  });
  assert.deepEqual(said("שובר שורות עונה 2 פרק 3"), {
    q: "שובר שורות", season: 2, episode: 3, spellings: ["שובר שורות", "שובר שורות עונה 2 פרק 3"],
  });
  assert.deepEqual([said("העונה השלישית של הבורר").q, said("העונה השלישית של הבורר").season], ["הבורר", 3]);
  assert.deepEqual([said("שטיסל עונה אחת ופרק שבע").q, said("שטיסל עונה אחת ופרק שבע").season, said("שטיסל עונה אחת ופרק שבע").episode], ["שטיסל", 1, 7]);
  assert.equal(said("הבורר עונה אחת עשרה").season, 11);
  assert.equal(said("אני רוצה לצפות בפאודה").q, "פאודה", "the glued preposition goes with the command");
  assert.equal(said("תראה לי את הסרט שבעה").q, "שבעה", "a number word outside a season stays a word");
  assert.equal(said("חפש הארי פוטר בבקשה").q, "הארי פוטר");
  assert.equal(said("הארי פוטר").q, "הארי פוטר");
  // niqqud is not part of the letters
  assert.equal(said("פָאוּדָה").q, "פאודה");
  assert.equal(normalize("פאודה").hebrew, true);
  assert.equal(normalize("Fauda").hebrew, false);
});

test("courtesy and wake words alone add no 'as said' spelling (one search, not two)", () => {
  assert.deepEqual(said("hey aurora inception please").spellings, ["inception"]);
  assert.deepEqual(said("בבקשה פאודה").spellings, ["פאודה"]);
  assert.deepEqual(said("  Inception  ").spellings, ["Inception"]);
  assert.deepEqual(said("").spellings, []);
  assert.equal(said(null).q, "");
});

// ---------- the search, over a fixture corpus ----------
const lib = (id, type, title, year, imdbId, genres = [], extra = {}) =>
  ({ id, type, title, year, imdbId, genres, cover: `/img/${id}`, rating: 7, synopsis: "", ...extra });
const cat = (type, title, year, imdbId, genres = []) =>
  ({ type, title, year, imdbId, genres, poster: `https://p/${imdbId}.jpg`, rating: 7, synopsis: "" });
const LIBRARY = [
  lib("L1", "movie", "Inception", 2010, "tt1375666", ["Sci-Fi"]),
  lib("L2", "show", "Breaking Bad", 2008, "tt0903747", ["Crime", "Drama"]),
  lib("L3", "movie", "Ocean's Eleven", 2001, "tt0240772", ["Crime"]),
  lib("L4", "movie", "Seven Samurai", 1954, "tt0047478", ["Drama"]),
];
const TRENDING = {
  movies: [
    cat("movie", "A Hero", 2021, "tt14466130", ["Drama"]),
    cat("movie", "Star Wars", 1977, "tt0076759", ["Sci-Fi"]),
    cat("movie", "Star Wars: Episode IV - A New Hope", 1977, "tt9076759", ["Sci-Fi"]),
    cat("movie", "Harry Potter and the Philosopher's Stone", 2001, "tt0241527", ["Fantasy"]),
    cat("movie", "1984", 1984, "tt0087803", ["Drama"]),
  ],
  shows: [cat("show", "Show Me a Hero", 2015, "tt2492296", ["Drama"]), cat("show", "Fauda", 2015, "tt4565380", ["Thriller"])],
};
const calls = { live: [] };
test.before(() => {
  const byImdb = new Map(LIBRARY.map((i) => [i.imdbId, i]));
  engine._internals._setSources({
    stamp: () => 1,
    libraryItems: () => LIBRARY,
    imdbIdFor: (i) => i.imdbId || null,
    markLibrary: (list) => {
      for (const m of list) m.inLibrary = byImdb.has(m.imdbId) ? byImdb.get(m.imdbId).id : null;
      return list;
    },
    trending: () => TRENDING,
    seenTitles: () => [],
    seenPeople: () => [],
    knownTitles: () => [],
    knownStamp: () => "",
    recTitles: () => [],
    facts: () => [],
    liveCached: () => null,
    live: async (q) => { calls.live.push(q); return { movies: [], shows: [] }; },
    similarCached: () => null,
    collectionCached: () => null,
    canFetchSimilar: () => false,
    similarFetch: async () => [],
    canFetchPeople: () => false,
    personFetch: async () => null,
    remember: () => {},
  });
});
const top = (r) => (r.results[0] ? r.results[0].title : null);

test("search: the title out of a sentence, the same cards as typing it", async () => {
  const r = await spoken.search("search for the movie inception", { wait: true });
  assert.equal(top(r), "Inception");
  assert.equal(r.q, "inception");
  assert.deepEqual(r.spoken, { heard: "search for the movie inception", q: "inception", season: null, episode: null, via: "digits" });
  const typed = await engine.search("inception", { wait: true, commit: true });
  assert.deepEqual(r.results.map((c) => c.key), typed.results.map((c) => c.key));
});

test("search: a season and an episode find the show, and say which", async () => {
  const r = await spoken.search("Hey Aurora play Breaking Bad season two episode three", { wait: true });
  assert.equal(top(r), "Breaking Bad");
  assert.equal(r.spoken.season, 2);
  assert.equal(r.spoken.episode, 3);
});

test("search: the spelling that matches wins — digits, words, or the sentence as said", async () => {
  // a recogniser's digits for a title spelled in words
  let r = await spoken.search("Ocean's 11", { wait: true });
  assert.equal(top(r), "Ocean's Eleven");
  assert.equal(r.spoken.via, "words");
  assert.equal(r.q, "Ocean's eleven");
  // words for a title spelled in digits
  r = await spoken.search("nineteen eighty four", { wait: true });
  assert.equal(top(r), "1984");
  assert.equal(r.q, "1984");
  // "seven" → 7, and Seven Samurai is found either way: the words as said stand in the field
  r = await spoken.search("seven samurai", { wait: true });
  assert.equal(top(r), "Seven Samurai");
  assert.equal(r.q, "seven samurai");
  // a title that starts with a command word
  r = await spoken.search("show me a hero", { wait: true });
  assert.equal(top(r), "Show Me a Hero");
  assert.equal(r.spoken.via, "as-said");
  // …and one that does not: the command goes
  r = await spoken.search("show me inception", { wait: true });
  assert.equal(top(r), "Inception");
  // a title whose name holds "episode"
  r = await spoken.search("star wars episode four", { wait: true });
  assert.equal(top(r), "Star Wars: Episode IV - A New Hope");
});

test("search: Hebrew the catalogues do not know is looked up by its English name (Wikipedia), once", async () => {
  const asked = [];
  spoken._internals._setFetch(async (url) => {
    asked.push(url);
    const q = decodeURIComponent(/gsrsearch=([^&]+)/.exec(url)[1]);
    // (as Wikipedia answers it: the pages in its own order, `index` the search's)
    if (q === "פאודה") {
      return { query: { pages: [
        { index: 3, title: "ליאור רז", langlinks: [{ lang: "en", title: "Lior Raz" }] },
        { index: 2, title: "אבי יששכרוף", langlinks: [{ lang: "en", title: "Avi Issacharoff" }] },
        { index: 1, title: "פאודה", langlinks: [{ lang: "en", title: "Fauda" }] },
      ] } };
    }
    if (q === "שם שאין לו דף") return { query: { pages: [{ index: 2, title: "משהו אחר", langlinks: [{ lang: "en", title: "Something Else" }] }, { index: 1, title: "דף בלי קישור" }] } };
    if (q === "הארי פוטר ואבן החכמים") {
      return { query: { pages: [
        { index: 2, title: "הארי פוטר (סדרת סרטים)", langlinks: [{ lang: "en", title: "Harry Potter (film series)" }] },
        { index: 1, title: "הארי פוטר ואבן החכמים (סרט)", langlinks: [{ lang: "en", title: "Harry Potter and the Philosopher's Stone (film)" }] },
      ] } };
    }
    return { query: { pages: [] } };
  });
  // the quick call (no wait) does not go out: it says more is coming
  let r = await spoken.search("תחפש את הסדרה פאודה", {});
  assert.equal(r.pending, true);
  assert.equal(asked.length, 0);
  // the waiting call asks Wikipedia and searches the English name
  r = await spoken.search("תחפש את הסדרה פאודה", { wait: true });
  assert.equal(top(r), "Fauda");
  assert.equal(r.q, "Fauda");
  assert.equal(r.spoken.via, "hebrew-title");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^https:\/\/he\.wikipedia\.org\/w\/api\.php\?/);
  assert.match(asked[0], /lllimit=max/, "every page's link, not one page's");
  // remembered: the next quick call has it at once
  r = await spoken.search("פאודה", {});
  assert.equal(top(r), "Fauda");
  assert.equal(asked.length, 1);
  // Wikipedia's "(film)" is not part of the name; its first page is the best one
  r = await spoken.search("הארי פוטר ואבן החכמים", { wait: true });
  assert.equal(top(r), "Harry Potter and the Philosopher's Stone");
  // the search's first page has no English page: no later page stands in for it
  r = await spoken.search("שם שאין לו דף", { wait: true });
  assert.deepEqual(r.results, []);
  assert.equal(r.spoken.via, "digits");
  // nothing found: what was heard is the answer, empty — and not asked again
  r = await spoken.search("מילים שאינן שם של סרט", { wait: true });
  assert.deepEqual(r.results, []);
  assert.equal(r.q, "מילים שאינן שם של סרט");
  const n = asked.length;
  await spoken.search("מילים שאינן שם של סרט", { wait: true });
  assert.equal(asked.length, n);
});

test("search: Wikipedia down is not an error, and is asked again next time", async () => {
  let n = 0;
  spoken._internals._setFetch(async () => { n++; throw new Error("ETIMEDOUT"); });
  const r = await spoken.search("שובר שורות", { wait: true });
  assert.deepEqual(r.results, []);
  assert.equal(r.spoken.via, "digits");
  await spoken.search("שובר שורות", { wait: true });
  assert.equal(n, 2);
});

test("search: a kids profile's filter applies to every spelling", async () => {
  const allow = (item) => item.title !== "Show Me a Hero";
  const r = await spoken.search("show me a hero", { wait: true, allow });
  assert.ok(!r.results.some((c) => c.title === "Show Me a Hero"));
  assert.equal(top(r), "A Hero");
});

test("search: nothing heard is an empty answer, not an error", async () => {
  const r = await spoken.search("   ", { wait: true });
  assert.equal(r.q, "");
  assert.deepEqual(r.results, []);
  assert.equal(r.spoken.heard, "");
});
