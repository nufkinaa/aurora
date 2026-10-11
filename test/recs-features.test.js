// A title as the recommender sees it (src/media/recs/features.js) and the
// record it is built from (titleindex.js). Synthetic TMDB payloads, an
// in-memory index — no disk, no network.
const test = require("node:test");
const assert = require("node:assert/strict");

const titleindex = require("../src/media/recs/titleindex");
const features = require("../src/media/recs/features");
const tmdb = require("../src/media/recs/tmdb");
const config = require("../src/config");
const { fromTmdb, fromCard, useMemory } = titleindex._internals;

let n = 1000;
// a TMDB detail payload with the appends the index asks for
const payload = (over = {}) => {
  const id = over.id || n++;
  const { keywords = [], genres = ["Drama"], directors = [], cast = [], recs = [], ...rest } = over;
  return {
    id,
    title: `Title ${id}`,
    release_date: "2014-11-05",
    status: "Released",
    genres: genres.map((name, i) => ({ id: i + 1, name })),
    keywords: { keywords: keywords.map((name, i) => ({ id: 5000 + i, name })) },
    credits: {
      crew: directors.map((d) => ({ id: d, name: `Director ${d}`, job: "Director" })),
      cast: cast.map((c, order) => ({ id: c, name: `Actor ${c}`, order })),
    },
    external_ids: { imdb_id: `tt${String(id).padStart(7, "0")}` },
    release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG-13" }] }] },
    recommendations: { results: recs.map((r) => ({ id: r, poster_path: "/x.jpg" })) },
    similar: { results: [] },
    runtime: 120,
    original_language: "en",
    vote_average: 7.5,
    vote_count: 3000,
    popularity: 30,
    poster_path: "/p.jpg",
    backdrop_path: "/b.jpg",
    overview: "A linguist is recruited to speak with visitors from the stars.",
    ...rest,
  };
};
const rec = (over) => fromTmdb(payload(over), "movie");

test("a full record keeps what the old pipeline threw away: keywords, makers, franchise, ratings, neighbours", () => {
  const r = fromTmdb(payload({
    id: 42, genres: ["Science Fiction", "Drama"], keywords: ["First Contact", "linguist"],
    directors: [7], cast: [1, 2, 3], recs: [50, 51],
    belongs_to_collection: { id: 9, name: "Saga" },
  }), "movie");
  assert.equal(r.id, "tt0000042");
  assert.equal(r.tm, 42);
  assert.deepEqual(r.g, ["Sci-Fi", "Drama"], "TMDB's names are canonical");
  assert.deepEqual(r.kw.map((k) => k[1]), ["first contact", "linguist"], "keywords lower-cased, ids kept");
  assert.deepEqual(r.dir, [[7, "Director 7"]]);
  assert.deepEqual(r.cast.map((c) => c[0]), [1, 2, 3]);
  assert.deepEqual(r.col, [9, "Saga"]);
  assert.deepEqual(r.recs, [50, 51]);
  assert.equal(r.year, 2014);
  assert.equal(typeof r.age, "number", "the strict age came out of the same call");
  assert.match(r.poster, /^https:\/\/image\.tmdb\.org\/t\/p\/w342\/p\.jpg$/);
  assert.equal(r.lite, undefined);
});

test("a payload without an IMDb id is not a record (clients navigate by it)", () => {
  assert.equal(fromTmdb({ ...payload(), external_ids: {} }, "movie"), null);
});

test("a lite record needs no network: a catalogue card is enough to compare titles", () => {
  const lite = fromCard({ imdbId: "tt0000900", type: "show", title: "Card", year: 2020, genres: ["Sci-Fi", "Mystery"], rating: 8.1, poster: "https://x/p.jpg", synopsis: "Workers have their memories split." });
  assert.equal(lite.lite, true);
  assert.equal(lite.k, "tv");
  assert.deepEqual(lite.g, ["Sci-Fi", "Mystery"]);
  assert.equal(fromCard({ title: "no id" }), null);
});

test("the index: a lite record never replaces a full one; catalogue genres survive the upgrade", () => {
  useMemory();
  titleindex.noteCards([{ imdbId: "tt0000042", type: "movie", title: "Card", genres: ["Mystery"], poster: "https://x/p.jpg" }]);
  assert.equal(titleindex.get("tt0000042").lite, true);
  titleindex.put(rec({ id: 42, genres: ["Drama"] }));
  const full = titleindex.get("tt0000042");
  assert.equal(full.lite, undefined);
  assert.deepEqual(full.g, ["Mystery", "Drama"], "the catalogue's genre is kept beside TMDB's");
  titleindex.put(fromCard({ imdbId: "tt0000042", type: "movie", title: "Card again", genres: [] }));
  assert.equal(titleindex.get("tt0000042").lite, undefined, "still the full record");
  assert.equal(titleindex.byTmdb("movie", 42).id, "tt0000042");
});

test("ensure(): bounded, paced through one door, and silent when there is no key", async () => {
  useMemory();
  const key = config.TMDB_KEY;
  const calls = [];
  tmdb.setFetch(async (url) => {
    calls.push(String(url).replace(/api_key=[^&]+/, "api_key=x"));
    const m = /\/3\/movie\/(tt\d+|\d+)\?/.exec(url);
    if (!m) return { ok: false, status: 404, json: async () => ({}) };
    const id = parseInt(String(m[1]).replace("tt", ""), 10);
    return { ok: true, status: 200, json: async () => payload({ id }) };
  });
  try {
    config.TMDB_KEY = null;
    const none = await titleindex.ensure([{ imdbId: "tt0000001", kind: "movie" }]);
    assert.equal(none.noKey, true);
    assert.equal(calls.length, 0, "no key: not one request");

    config.TMDB_KEY = "test-key";
    const wants = Array.from({ length: 10 }, (_, i) => ({ imdbId: `tt${String(i + 1).padStart(7, "0")}`, kind: "movie" }));
    const out = await titleindex.ensure(wants, { budget: 4 });
    assert.equal(out.asked, 4, "the budget is a hard cap");
    assert.equal(out.got, 4);
    assert.equal(calls.length, 4, "one call per film (the detail endpoint takes the IMDb id)");
    assert.ok(calls.every((u) => /append_to_response=keywords,credits,external_ids,release_dates,recommendations,similar/.test(u)));
    const again = await titleindex.ensure(wants.slice(0, 4), { budget: 10 });
    assert.equal(again.asked, 0, "what is known is never asked twice");
  } finally {
    tmdb.setFetch(null);
    config.TMDB_KEY = key;
    useMemory();
  }
});

// ---------- vectors ----------
const A = rec({ id: 1, genres: ["Science Fiction", "Drama"], keywords: ["first contact", "linguist", "alien", "time loop"], directors: [7], cast: [1, 2] });
const B = rec({ id: 2, genres: ["Science Fiction", "Drama"], keywords: ["first contact", "alien", "astronaut", "space travel"], directors: [7], cast: [3, 4] });
const C = rec({ id: 3, genres: ["Comedy", "Romance"], keywords: ["wedding", "romcom", "falling in love"], directors: [8], cast: [5, 6], overview: "Two strangers meet at a wedding and fall in love." });
const D = rec({ id: 4, genres: ["Science Fiction"], keywords: ["alien", "alien invasion", "spacecraft"], directors: [9], cast: [1, 9] });
const ALL = [A, B, C, D];
const stats = features.buildStats(ALL);
const V = new Map(ALL.map((r) => [r.id, features.vectorOf(r, stats)]));
const v = (r) => V.get(r.id);

test("every block is unit length (or absent)", () => {
  for (const r of ALL) {
    for (const b of features.BLOCKS) {
      const blk = v(r)[b];
      if (!blk) continue;
      const len = Math.sqrt(blk.w.reduce((s, x) => s + x * x, 0));
      assert.ok(Math.abs(len - 1) < 1e-5, `${r.id} ${b}: ${len}`);
      assert.ok(features.dot(blk, blk) > 0.999);
    }
  }
});

test("similarity: symmetric, 0..1, and what shares vibe + maker + genre is closest", () => {
  const ab = features.similarity(v(A), v(B));
  const ac = features.similarity(v(A), v(C));
  const ad = features.similarity(v(A), v(D));
  assert.ok(Math.abs(ab - features.similarity(v(B), v(A))) < 1e-9);
  for (const s of [ab, ac, ad]) assert.ok(s >= 0 && s <= 1);
  assert.ok(ab > ad, "same director and more shared keywords beats one shared keyword");
  assert.ok(ad > ac, "a sci-fi film is closer to a sci-fi film than to a romcom");
  assert.ok(ac < 0.15, `the romcom is far (${ac})`);
});

test("people: the director weighs more than a lead, a lead more than the sixth-billed", () => {
  const r = rec({ id: 10, directors: [70], cast: [71, 72, 73, 74, 75, 76] });
  const p = features.unpack(features.vectorOf(r, stats).people);
  assert.ok(p.d70 > p.a71, "director > lead");
  assert.ok(p.a71 > p.a76, "lead > sixth-billed");
});

test("the link block: TMDB recommending one title beside another makes them neighbours", () => {
  const src = rec({ id: 20, genres: ["Drama"], keywords: [], recs: [21, 30, 31] });
  const linked = rec({ id: 21, genres: ["Comedy"], keywords: [], recs: [30, 31] });
  const stranger = rec({ id: 22, genres: ["Comedy"], keywords: [], recs: [90, 91] });
  const st = features.buildStats([src, linked, stranger]);
  const [a, b, c] = [src, linked, stranger].map((r) => features.vectorOf(r, st));
  assert.ok(features.dot(a.link, b.link) > 0.3, "recommended beside it, and beside the same things");
  assert.equal(features.dot(a.link, c.link), 0);
  const noLink = { ...features.W_SIM, link: 0 };
  assert.ok(features.similarity(a, b) > features.similarity(a, b, noLink), "the graph adds to content similarity");
});

test("a lite record still compares: genre, era and plot words carry it, at a discount", () => {
  const lite = fromCard({ imdbId: "tt0000050", type: "movie", title: "Lite", year: 2016, genres: ["Sci-Fi", "Drama"], rating: 7.9, synopsis: "A linguist is recruited to speak with visitors from the stars." });
  const lv = features.vectorOf(lite, stats);
  assert.equal(lv.kw, null);
  assert.equal(lv.people, null);
  assert.ok(features.similarity(lv, v(A)) > features.similarity(lv, v(C)), "it still knows sci-fi drama from a romcom");
  assert.ok(features.similarity(lv, v(A)) < features.similarity(v(B), v(A)) + 0.2);
});

test("TMDB's lumped Sci-Fi & Fantasy bucket is split by what the title is about", () => {
  const { softGenreShare } = features._internals;
  assert.equal(softGenreShare("Sci-Fi", { space: 1.2, "ai-robots": 1 }), 1);
  assert.equal(softGenreShare("Fantasy", { space: 1.2, "ai-robots": 1 }), 0.25);
  assert.equal(softGenreShare("Fantasy", { magic: 1.5 }), 1);
  assert.equal(softGenreShare("Sci-Fi", {}), 0.7, "no evidence: both stay, a little lighter");
});

test("quality is shrunk: a 9.5 from 12 votes is not better than an 8.2 from 30k", () => {
  const tiny = features.qualityOf({ va: 9.5, vc: 12 });
  const proven = features.qualityOf({ va: 8.2, vc: 30000 });
  assert.ok(proven > tiny);
  assert.ok(features.qualityOf({ va: 0, vc: 0 }) > 0 && features.qualityOf({ va: 0, vc: 0 }) < 0.5, "unknown sits at the prior");
});

test("explain(): a similarity can be read — which themes and keywords are shared", () => {
  const e = features.explain(v(A), v(B));
  assert.ok(e.keywords.includes("first contact"));
  assert.ok(e.themes.includes("aliens"));
  assert.ok(e.parts.genre > 0.9);
});

test("the index is bounded: beyond the cap the least-voted go — never a title someone has touched", () => {
  useMemory();
  for (let i = 1; i <= 30; i++) titleindex.put(rec({ id: 3000 + i, vote_count: i * 10 }));
  titleindex.setKeep(["tt0003001", "tt0003002"]); // the two least-voted, but watched
  const dropped = titleindex.prune(undefined, 20);
  assert.equal(dropped, 10);
  assert.equal(titleindex.size(), 20);
  assert.ok(titleindex.get("tt0003001") && titleindex.get("tt0003002"), "kept: someone's history");
  assert.equal(titleindex.get("tt0003003"), null, "the least-voted untouched title went");
  assert.ok(titleindex.get("tt0003030"), "the well-known stay");
  titleindex.setKeep([]);
  useMemory();
});
