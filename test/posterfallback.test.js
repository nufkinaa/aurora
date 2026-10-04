// The backup poster chain: which sources are tried, in what order, and that
// the last-resort title search only accepts the right title.
const test = require("node:test");
const assert = require("node:assert");
const { candidates } = require("../src/media/posterfallback")._internals;

const collect = async (q, fetchJson) => {
  const out = [];
  for await (const u of candidates(q, fetchJson)) out.push(u);
  return out;
};

test("a show: the image host first, then Cinemeta's own record, then TVMaze by IMDb id", async () => {
  const urls = await collect({ imdbId: "tt123", type: "show", title: "Silo" }, async (url) => {
    if (url.includes("cinemeta")) return { meta: { poster: "https://example.org/cinemeta-poster.jpg" } };
    if (url.includes("tvmaze")) return { image: { original: "https://static.tvmaze.com/x.jpg" } };
    return null;
  });
  assert.equal(urls[0], "https://images.metahub.space/poster/medium/tt123/img");
  assert.equal(urls[1], "https://example.org/cinemeta-poster.jpg");
  assert.equal(urls[2], "https://static.tvmaze.com/x.jpg");
});

test("a film never asks TVMaze, and the title search only takes the same title and year", async () => {
  const asked = [];
  const urls = await collect({ imdbId: "tt9", type: "movie", title: "Arrival", year: 2016 }, async (url) => {
    asked.push(url);
    if (url.includes("itunes")) {
      return { results: [
        { trackName: "Arrival of the Dead", releaseDate: "2016-01-01", artworkUrl100: "https://a/100x100bb.jpg" },
        { trackName: "Arrival", releaseDate: "1996-01-01", artworkUrl100: "https://b/100x100bb.jpg" },
        { trackName: "Arrival", releaseDate: "2016-11-11", artworkUrl100: "https://c/100x100bb.jpg" },
      ] };
    }
    return null;
  });
  assert.ok(!asked.some((u) => u.includes("tvmaze")));
  assert.equal(urls[urls.length - 1], "https://c/600x900bb.jpg", "the right film, at poster size");
});

test("a provider that throws is skipped, not fatal", async () => {
  const urls = await collect({ imdbId: "tt5", type: "show", title: "X" }, async () => { throw new Error("down"); });
  assert.deepEqual(urls, ["https://images.metahub.space/poster/medium/tt5/img"]);
});
