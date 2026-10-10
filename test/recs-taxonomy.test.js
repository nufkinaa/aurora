// The recommender's taxonomy (src/media/recs/taxonomy.{js,json}): canonical
// genre names, and TMDB's keyword folksonomy mapped onto themes. Pure data +
// pure functions — no store, no network.
const test = require("node:test");
const assert = require("node:assert/strict");

const tax = require("../src/media/recs/taxonomy");
const raw = require("../src/media/recs/taxonomy.json");

test("genres: the catalogue's, the library's and TMDB's names land on one set", () => {
  assert.deepEqual(tax.canonGenres(["Science Fiction", "Drama"]), ["Sci-Fi", "Drama"]);
  assert.deepEqual(tax.canonGenres(["sci-fi", "Sci-Fi", "SCIENCE FICTION"]), ["Sci-Fi"]);
  assert.deepEqual(tax.canonGenres(["Action & Adventure"]), ["Action", "Adventure"]);
  assert.deepEqual(tax.canonGenres(["War & Politics", "Kids", "Musical", "Reality"]), ["War", "Family", "Music", "Reality-TV"]);
  assert.deepEqual(tax.canonGenres(["TV Movie", "", null, "Nonsense"]), [], "unknown and empty names are dropped");
});

test("genres: a lumped TMDB bucket never overrides the catalogue's finer genre", () => {
  // IMDb says Sci-Fi; TMDB's "Sci-Fi & Fantasy" must not stamp Fantasy on it
  assert.deepEqual(tax.canonGenres(["Sci-Fi", "Drama", "Sci-Fi & Fantasy"]), ["Sci-Fi", "Drama"]);
  // with nothing finer known, the bucket gives both
  assert.deepEqual(tax.canonGenres(["Drama", "Sci-Fi & Fantasy"]), ["Drama", "Sci-Fi", "Fantasy"]);
});

test("themes: five spellings of a heist are one theme", () => {
  for (const kw of ["heist", "bank robbery", "caper", "bank heist", "art theft", "casino heist"]) {
    const t = tax.themesOf({ keywords: [kw] });
    assert.ok(t.heist, `"${kw}" is a heist`);
  }
  assert.ok(!tax.themesOf({ keywords: ["courtroom"] }).heist);
});

test("themes: one keyword is weak evidence, two are solid, three settle it", () => {
  assert.equal(tax.themesOf({ keywords: ["heist"] }).heist, 0.7);
  assert.equal(tax.themesOf({ keywords: ["heist", "bank robbery"] }).heist, 1.2);
  assert.equal(tax.themesOf({ keywords: ["heist", "bank robbery", "caper", "thief"] }).heist, 1.5);
});

test("themes: the synopsis alone counts a little, and lifts a single keyword", () => {
  const plotOnly = tax.themesOf({ keywords: [], overview: "A crew plans the perfect heist on a casino." });
  assert.equal(plotOnly.heist, 0.4);
  const both = tax.themesOf({ keywords: ["heist"], overview: "A crew plans the perfect heist on a casino." });
  assert.equal(both.heist, 1);
});

test("themes: a mood, a setting and a plot can all be read off one title", () => {
  const t = tax.themesOf({
    keywords: ["dystopia", "totalitarianism", "slow burn", "philosophical", "artificial intelligence (a.i.)", "android"],
    genres: ["Sci-Fi", "Drama"],
  });
  assert.ok(t.dystopia >= 1.2);
  assert.ok(t["slow-burn"] >= 1.2);
  assert.ok(t["ai-robots"] >= 1.2);
});

test("themes: genre fences hold (a slasher needs to be horror or a thriller)", () => {
  const horror = tax.themesOf({ keywords: ["slasher", "masked killer"], genres: ["Horror"] });
  const comedy = tax.themesOf({ keywords: ["slasher", "masked killer"], genres: ["Comedy"] });
  assert.ok(horror.slasher);
  assert.ok(!comedy.slasher);
});

test("the mapping file is well formed: every theme has a group, a label, a row title and lower-case keywords", () => {
  const groups = Object.keys(raw.groups);
  assert.ok(groups.length >= 5);
  const slugs = Object.keys(raw.themes);
  assert.ok(slugs.length >= 80, `a real taxonomy, not a handful (${slugs.length})`);
  for (const slug of slugs) {
    const t = raw.themes[slug];
    assert.match(slug, /^[a-z0-9-]+$/);
    assert.ok(groups.includes(t.group), `${slug}: group "${t.group}"`);
    assert.ok(t.label && t.title, `${slug}: label + title`);
    assert.ok(Array.isArray(t.kw) && t.kw.length >= 3, `${slug}: keywords`);
    for (const k of t.kw) assert.equal(k, k.toLowerCase(), `${slug}: "${k}" is lower-case`);
    assert.equal(new Set(t.kw).size, t.kw.length, `${slug}: no keyword listed twice`);
    if (t.plot) assert.doesNotThrow(() => new RegExp(t.plot, "i"), `${slug}: plot pattern compiles`);
    assert.equal(tax.themeTitle(slug), t.title);
  }
});

test("stop list: paperwork keywords are known and never a theme of their own", () => {
  for (const k of ["based on novel or book", "sequel", "duringcreditsstinger", "woman director", "new york city"]) {
    assert.ok(tax.STOP.has(k), k);
  }
  assert.deepEqual(tax.themesOf({ keywords: ["based on novel or book", "sequel", "new york city"] }), {});
});
