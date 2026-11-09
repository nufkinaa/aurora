// The curated franchise list (src/media/franchises/list) is only worth having
// if every entry is right: the IMDb id is that title (name, year, type and
// TMDB id as the catalogue has them — test/fixtures/franchise-meta.json, made
// by tools/franchises/snapshot.js from Cinemeta), nothing is listed twice, the
// entries are in release order and every other order is a full ordering of
// the same entries.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const franchises = require("../src/media/franchises");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "franchise-meta.json"), "utf8"));
const list = franchises.readAll();

test("every curated franchise and entry checks out against the catalogue snapshot", () => {
  assert.ok(list.length >= 10, `only ${list.length} franchises`);
  assert.deepEqual(franchises.validate(list, fixture), []);
});

test("the snapshot holds what the list names, and only that", () => {
  const named = new Set(list.flatMap((fr) => (fr.entries || []).map((e) => e.imdbId)));
  for (const id of named) assert.ok(fixture[id], `${id} is not in the snapshot`);
  for (const id of Object.keys(fixture)) assert.ok(named.has(id), `${id} is in the snapshot but no franchise lists it`);
});

test("every franchise has a name a sentence can carry, and its own sources", () => {
  for (const fr of list) {
    const line = `Part of ${fr.the ? "the " : ""}${fr.name}`;
    assert.ok(!/\bthe the\b/i.test(line), `${fr.id}: "${line}"`);
    assert.ok(!/^the /i.test(fr.name) || !fr.the, `${fr.id}: the name starts with "The" — set "the": false`);
    assert.ok(fr.sources.every((s) => s.length >= 8), `${fr.id}: a source is too short to find again`);
  }
});

test("a title in two franchises is shown under one of them, decided by priority", () => {
  const cat = franchises.build(list);
  for (const [id, frs] of cat.byTitle) {
    if (frs.length < 2) continue;
    for (let i = 1; i < frs.length; i++) {
      assert.ok(frs[i - 1].priority >= frs[i].priority, `${id}: ${frs[i - 1].id} before ${frs[i].id}`);
    }
  }
});

test("the validator catches what it is there to catch", () => {
  const good = {
    id: "toy", name: "Toy", the: false, priority: 1, sources: ["https://example.org/x"],
    entries: [
      { imdbId: "tt0000001", tmdbId: 1, type: "movie", title: "A", year: 2001, date: "2001-01-01" },
      { imdbId: "tt0000002", tmdbId: 2, type: "movie", title: "B", year: 2002, date: "2002-01-01" },
    ],
  };
  assert.deepEqual(franchises.validate([good]), []);
  const bad = (patch) => franchises.validate([{ ...good, ...patch }]);
  assert.ok(bad({ entries: [good.entries[1], good.entries[0]] }).some((p) => /release order/.test(p)));
  assert.ok(bad({ entries: [good.entries[0], good.entries[0]] }).some((p) => /twice/.test(p)));
  assert.ok(bad({ story: ["tt0000002"] }).some((p) => /leaves out/.test(p)));
  assert.ok(bad({ story: ["tt0000001", "tt0000002"] }).some((p) => /is the release order/.test(p)));
  assert.ok(bad({ story: ["tt0000002", "tt0000001", "tt0000003"] }).some((p) => /not an entry/.test(p)));
  assert.ok(bad({ sources: [] }).some((p) => /sources/.test(p)));
  const fx = { tt0000001: { type: "movie", name: "A", year: 2001, tmdbId: 1 }, tt0000002: { type: "movie", name: "Bee", year: 2003, tmdbId: 9 } };
  const p = franchises.validate([good], fx);
  assert.ok(p.some((x) => /calls it "Bee"/.test(x)));
  assert.ok(p.some((x) => /says 2003/.test(x)));
  assert.ok(p.some((x) => /TMDB id is 9/.test(x)));
});
