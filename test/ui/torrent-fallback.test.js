// A torrent source nobody shares: the player moves on to the next source from
// the list by itself (playstart.js deadSource — nobody after 25 s) instead of
// "Connecting to peers…" for a minute and a half. The private server has no
// way out to any swarm, so every source here is one nobody shares.
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite({});

const item = (hash, quality, alts = []) => ({
  id: `torrent|${hash}|0`, type: "movie", title: "Nobody Seeds This", year: 2024,
  videoUrl: `/stream/torrent/${hash}/0`, downloadUrl: `/stream/torrent/${hash}/0`,
  transcodeBase: `/stream/torrent/hls/${hash}/0`, transcodeV: "h264", needsTranscode: false,
  duration: 5400, subtitles: [], infoHash: hash, quality, _isTorrent: true, _chosen: true, _alts: alts,
});

ui.test("a source with nobody sharing it: after 25 s the next source is tried, by itself, and Back still leads home", { allow: [/Failed to load resource/] }, async ({ page, srv, signIn, freshProfile, goto }) => {
  await signIn(await freshProfile());
  await goto("#/movies");
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  await page.evaluate(async ({ first }) => {
    const { state } = await import("/js/state.js");
    state.pendingItems[first.id] = first;
    location.hash = `#/play/${encodeURIComponent(first.id)}`;
  }, { first: item(a, "1080p", [item(b, "720p")]) });
  await page.waitForSelector("#app .player video");
  const t0 = Date.now();
  await page.waitForFunction((h) => decodeURIComponent(location.hash).includes(h), b, { timeout: 45000 });
  const took = Date.now() - t0;
  assert.ok(took >= 20000 && took < 40000, `moved on after ${took} ms`);
  assert.match(await page.textContent("body"), /trying another 720p/);
  // the history holds one player entry: Back leaves it
  await page.goBack();
  await page.waitForFunction(() => !location.hash.startsWith("#/play/"), null, { timeout: 15000 });
});

ui.run({ concurrency: 1 });
