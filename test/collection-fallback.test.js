// /api/discover/collection is decoration on a title page: when the lookup
// throws it answers "nothing", and "nothing" has the same four keys as an
// answer (the fallback used to leave `creator` and `network` out).
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");

test("the failure answer of /api/discover/collection has every key of a real one", async () => {
  const similarPath = require.resolve("../src/media/similar");
  const similar = require(similarPath);
  const real = similar.collection;
  similar.collection = async () => { throw new Error("the catalogue is unreachable"); };
  const app = express();
  app.use(require("../src/routes/requests"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const empty = { collection: null, director: null, creator: null, network: null };
    const failed = await fetch(`${base}/api/discover/collection/series/tt0903747`);
    assert.equal(failed.status, 200);
    assert.deepEqual(await failed.json(), empty);
    // (the answer for an id that is not one was already complete)
    const bad = await fetch(`${base}/api/discover/collection/movie/not-an-id`);
    assert.deepEqual(await bad.json(), empty);
  } finally {
    similar.collection = real;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
