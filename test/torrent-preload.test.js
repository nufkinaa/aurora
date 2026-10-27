// The torrent engine's code is read at a quiet moment after boot, not at the
// first torrent played after a restart (media/torrent.js preload): no client
// is made by it, and nothing when torrents are switched off.
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("preload reads the engine's code ahead without making a client", async () => {
  const torrent = require("../src/media/torrent");
  const gate = require("../src/lib/torrentgate");
  if (!gate.enabled()) return; // (a config with torrents off: nothing to load)
  assert.equal(torrent._loaded(), false);
  torrent.preload(0);
  const until = Date.now() + 20000;
  while (!torrent._loaded() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(torrent._loaded(), true, "the code is in");
  assert.equal(torrent.clientIfLoaded(), null, "no client made");
});
