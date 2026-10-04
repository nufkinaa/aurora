// X-Ray: one entry per person, the billed names first, and what makes a
// series an anthology.
const test = require("node:test");
const assert = require("node:assert");
const { _internals: x } = require("../src/media/xray");

test("a person appears once; a second character folds into the first; photos fill in", () => {
  const out = x.mergePeople([
    { name: "Jesse Plemons", role: "Robert Daly" },
    { name: "Jesse Plemons", role: "Captain Daly", photo: "p.jpg" },
    { name: "Q36301", role: "Amelia Brand" }, // a Wikidata id with no label is not a name
    { name: "Cristin Milioti" },
  ]);
  assert.deepEqual(out.map((p) => p.name), ["Jesse Plemons", "Cristin Milioti"]);
  assert.equal(out[0].role, "Robert Daly / Captain Daly");
  assert.equal(out[0].photo, "p.jpg");
});

test("top-billed names lead, everyone else keeps their order", () => {
  const out = x.billedFirst([{ name: "C" }, { name: "A" }, { name: "D" }, { name: "B" }], ["A", "B"]);
  assert.deepEqual(out.map((p) => p.name), ["A", "B", "C", "D"]);
});

test("an anthology is a series with (almost) no regular cast", () => {
  assert.equal(x.isAnthology([]), true); // Black Mirror
  assert.equal(x.isAnthology([{ name: "Host" }]), true);
  assert.equal(x.isAnthology(new Array(11).fill({ name: "x" })), false); // Breaking Bad
});

test("crew lines pick jobs by name, once each", () => {
  const crew = [{ name: "Joe Wright", job: "Director" }, { name: "Rashida Jones", job: "Teleplay" }, { name: "Charlie Brooker", job: "Story" }, { name: "Joe Wright", job: "Director" }];
  assert.deepEqual(x.crewLine(crew, ["^director$"]), ["Joe Wright"]);
  assert.deepEqual(x.crewLine(crew, ["writer", "teleplay", "story"]), ["Rashida Jones", "Charlie Brooker"]);
});
