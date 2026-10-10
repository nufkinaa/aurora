// "More like this" by vibe: the ranking rules, pinned on synthetic TMDB
// profiles — no network, no key.
const test = require("node:test");
const assert = require("node:assert");

const { rankCandidates, profileOf, hardMismatch, qualityOf } = require("../src/media/vibe")._internals;

let nextId = 100;
// a TMDB-ish detail payload, enriched with keywords
const movie = (over = {}) => {
  const { keywords = [], genres = [18, 878], pools = ["rec"], ...rest } = over;
  return profileOf(
    {
      id: nextId++,
      title: "T",
      release_date: "2014-11-05",
      genres: genres.map((id) => ({ id })),
      keywords: { keywords: keywords.map((name, i) => ({ id: i, name })) },
      runtime: 150,
      original_language: "en",
      vote_average: 7.8,
      vote_count: 4000,
      popularity: 40,
      poster_path: "/p.jpg",
      external_ids: { imdb_id: `tt${nextId}000` },
      ...rest,
    },
    "movie",
    pools,
  );
};

// Interstellar-ish: cerebral, emotional space epic
const SRC = movie({
  id: 1,
  genres: [12, 18, 878],
  keywords: ["space travel", "wormhole", "black hole", "father daughter relationship", "time dilation", "based on novel or book"],
  popularity: 45,
});

test("shared VIBE keywords beat a merely popular same-genre film", () => {
  const vibe = movie({ title: "Contact", genres: [18, 878], keywords: ["space travel", "wormhole", "first contact"], popularity: 20 });
  const popular = movie({ title: "Blockbuster", genres: [12, 878], keywords: ["alien invasion", "explosion"], popularity: 900, vote_count: 20000 });
  const ranked = rankCandidates(SRC, [popular, vibe]);
  assert.equal(ranked[0].title, "Contact");
});

test("stop-listed paperwork keywords count for nothing", () => {
  const paperwork = movie({ title: "Same Source Novel", genres: [18, 878], keywords: ["based on novel or book", "father daughter relationship"] });
  const vibe = movie({ title: "Black Hole Film", genres: [18, 878], keywords: ["black hole"] });
  const ranked = rankCandidates(SRC, [paperwork, vibe]);
  assert.equal(ranked[0].title, "Black Hole Film");
  const p = ranked.find((r) => r.title === "Same Source Novel");
  assert.ok(!/based on novel/.test(p.why || ""), "the why never cites a stop-listed keyword");
});

test("a rare shared keyword outweighs one the whole neighbourhood shares", () => {
  const common = Array.from({ length: 6 }, (_, i) => movie({ title: `Space ${i}`, keywords: ["space travel"] }));
  const rare = movie({ title: "Tesseract", keywords: ["time dilation"] });
  const ranked = rankCandidates(SRC, [...common, rare]);
  assert.equal(ranked[0].title, "Tesseract");
});

test("hard rules: no cartoons under live action, no documentaries under fiction, no kids' TV", () => {
  assert.equal(hardMismatch(SRC, movie({ genres: [16, 878] })), "animation vs live action");
  assert.equal(hardMismatch(SRC, movie({ genres: [99] })), "documentary vs fiction");
  const cartoon = movie({ genres: [16, 878] });
  assert.equal(hardMismatch(cartoon, movie({ genres: [16, 12] })), null, "animation under animation is fine");
  const ranked = rankCandidates(SRC, [movie({ title: "Cartoon", genres: [16, 878], keywords: ["wormhole", "black hole"] })]);
  assert.equal(ranked.length, 0, "even a perfect keyword match can't cross the rule");
});

test("the source's own franchise is excluded (it has its own shelf), and one per other franchise", () => {
  const src = movie({ id: 2, belongs_to_collection: { id: 77 }, keywords: ["space travel"] });
  const sameFranchise = movie({ title: "Part II", belongs_to_collection: { id: 77 }, keywords: ["space travel"] });
  const trek1 = movie({ title: "Trek 1", belongs_to_collection: { id: 88 }, keywords: ["space travel"] });
  const trek2 = movie({ title: "Trek 2", belongs_to_collection: { id: 88 }, keywords: ["space travel"] });
  const solo = movie({ title: "Solo", keywords: ["space travel"] });
  const titles = rankCandidates(src, [sameFranchise, trek1, trek2, solo]).map((r) => r.title);
  assert.ok(!titles.includes("Part II"));
  assert.equal(titles.filter((t) => t.startsWith("Trek")).length, 1);
  assert.ok(titles.includes("Solo"));
});

test("quality is shrunk: a 9.5 from 12 votes is not better than an 8.2 from 30k", () => {
  const tiny = movie({ vote_average: 9.5, vote_count: 12 });
  const proven = movie({ vote_average: 8.2, vote_count: 30000 });
  assert.ok(qualityOf(proven) > qualityOf(tiny));
});

test("every pick says why: shared keywords first, else the collaborative vote", () => {
  const byKw = movie({ keywords: ["wormhole", "black hole"] });
  const byRec = movie({ keywords: ["heist"], pools: ["rec"] });
  const [a, b] = rankCandidates(SRC, [byKw, byRec]);
  assert.match(a.why, /^Same vibe: /);
  assert.match(a.why, /wormhole|black hole/);
  assert.equal(b.why, "People who loved this loved this too");
});

test("never returns the source itself, anything without a poster, or more than the limit", () => {
  const self = movie({ id: SRC.tmdbId, keywords: ["wormhole"] });
  const noPoster = movie({ poster_path: null, keywords: ["wormhole"] });
  const many = Array.from({ length: 30 }, () => movie({ keywords: ["space travel"] }));
  const ranked = rankCandidates(SRC, [self, noPoster, ...many], { limit: 14 });
  assert.equal(ranked.length, 14);
  assert.ok(!ranked.some((r) => r.tmdbId === SRC.tmdbId));
  assert.ok(ranked.every((r) => r.poster));
});

test("tone: same keywords, but a comedy or an action spectacle under a contemplative drama loses", () => {
  const drama = movie({ title: "Drama twin", genres: [18, 878], keywords: ["wormhole", "black hole"] });
  const comedy = movie({ title: "Comedy twin", genres: [35, 878], keywords: ["wormhole", "black hole"] });
  const action = movie({ title: "Action twin", genres: [28, 878], keywords: ["wormhole", "black hole"] });
  const titles = rankCandidates(SRC, [comedy, action, drama]).map((r) => r.title);
  assert.equal(titles[0], "Drama twin");
});

test("speculative vs grounded is a tone axis: at equal shared vibe, Washington loses to a sci-fi dystopia", () => {
  // as in the real Silo row: both share TWO keywords — tone has to decide
  const silo = movie({ id: 3, genres: [10765, 18], keywords: ["dystopia", "politics", "corruption", "post-apocalyptic future"] });
  const houseOfCards = movie({ title: "House of Cards", genres: [18], keywords: ["politics", "corruption", "washington dc"] });
  const snowpiercer = movie({ title: "Snowpiercer", genres: [10765, 18], keywords: ["dystopia", "post-apocalyptic future", "train"] });
  assert.equal(rankCandidates(silo, [houseOfCards, snowpiercer])[0].title, "Snowpiercer");
});

test("a candidate with barely any keywords can't vouch for its vibe (NOS4A2 had one)", () => {
  const sparse = movie({ title: "Sparse", genres: [18, 878, 12], keywords: ["ghost"] });
  const rich = movie({ title: "Rich", genres: [18, 878], keywords: ["space travel", "grief", "astronaut", "nasa"] });
  assert.equal(rankCandidates(SRC, [sparse, rich])[0].title, "Rich");
});

test("TMDB's own recommendation order counts: rank 0 beats rank 15, all else equal", () => {
  const a = movie({ title: "Rank 15", keywords: ["wormhole"] });
  const b = movie({ title: "Rank 0", keywords: ["wormhole"] });
  a.recRank = 15;
  b.recRank = 0;
  assert.equal(rankCandidates(SRC, [a, b])[0].title, "Rank 0");
});

// The row cache around it (media/similar.js): what counts as fresh.
test("row cache: a failed vibe build retries within the hour, and any older-version row rebuilds", () => {
  const { fresh, ALGO, FAIL_TTL, ROW_TTL } = require("../src/media/similar")._internals;
  const now = Date.now();
  const good = { items: [{}], source: "tmdb", algo: ALGO, at: now - ROW_TTL + 60e3 };
  assert.ok(fresh(good), "a good row lives out its week");
  assert.ok(!fresh({ ...good, failed: true, source: "genre", at: now - FAIL_TTL - 1 }), "a stopgap row goes stale fast");
  assert.ok(fresh({ ...good, failed: true, source: "genre", at: now - 60e3 }), "…but not instantly");
  assert.ok(!fresh({ ...good, source: "genre", algo: ALGO - 1, at: now }), "a pre-upgrade genre fallback rebuilds");
  assert.ok(!fresh(undefined));
});

// v5: themes (recs/taxonomy.json) and makers.
test("themes: the same idea under another spelling is vibe evidence (heist ~ bank robbery ~ caper)", () => {
  const src = movie({ id: 3, genres: [80, 53], keywords: ["heist", "casino", "las vegas"] });
  const synonym = movie({ title: "Bank Job", genres: [80, 53], keywords: ["bank robbery", "caper", "getaway driver"] });
  const unrelated = movie({ title: "Courtroom", genres: [80, 53], keywords: ["trial", "lawyer", "jury"] });
  const ranked = rankCandidates(src, [unrelated, synonym], { explain: true });
  assert.equal(ranked[0].title, "Bank Job");
  assert.deepEqual(ranked[0].shared, [], "not one keyword is shared word for word");
  assert.ok(ranked[0].sharedThemes.includes("heist"));
  assert.equal(ranked[0].why, "Same vibe: heist", "and the why names the theme");
  // v4 saw two equally unrelated crime thrillers here
  const v4 = rankCandidates(src, [unrelated, synonym], { explain: true, weights: { theme: 0, maker: 0 } });
  assert.ok(ranked[0].score - ranked[1].score > v4[0].score - v4[1].score + 0.05);
});

test("themes never double-count a keyword that is literally shared", () => {
  // "space travel" is shared word for word: the keyword match pays for it,
  // weighted by how common it is here; its theme must not vote again
  const { themeSim } = require("../src/media/vibe")._internals;
  const a = movie({ keywords: ["space travel", "astronaut"] });
  const b = movie({ keywords: ["space travel", "spacecraft"] });
  assert.ok(themeSim(a, b).sim > 0.9, "on themes alone they are the same thing");
  assert.equal(themeSim(a, b, new Set(["space"])).sim, 0, "credited to the keyword: nothing left for the theme");
});

test("the same director is a vote of its own", () => {
  const withCrew = (over, director) => movie({ ...over, credits: { crew: [{ id: director, job: "Director" }], cast: [] } });
  const src = withCrew({ id: 4, keywords: ["wormhole", "black hole"] }, 525);
  const same = withCrew({ title: "Same Director", keywords: ["wormhole"] }, 525);
  const other = withCrew({ title: "Other Director", keywords: ["wormhole"] }, 999);
  const ranked = rankCandidates(src, [other, same], { explain: true });
  assert.equal(ranked[0].title, "Same Director");
  assert.equal(ranked[0].parts.maker, 1);
  assert.equal(ranked[1].parts.maker, 0);
});
