// A server with "torrents": false in config.json: the library plays as ever,
// nothing that streams or downloads from a source is offered, the routes
// refuse in one clear sentence, no engine is started (not even for a job that
// was queued before the switch), and the health watch does not call that a
// dead download engine.
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const MESSAGE = "Torrents are switched off on this server.";
const HASH = "c".repeat(40);

// A download approved before the owner switched torrents off. With torrents on
// this is resumed four seconds after boot (the engine is spawned for it).
const QUEUED = {
  id: "0ff0ff0ff0ff",
  infoHash: HASH,
  fileIdx: 0,
  magnet: `magnet:?xt=urn:btih:${HASH}`,
  announce: [],
  type: "movie",
  imdbId: "tt9999999",
  title: "Queued Before The Switch",
  label: "Queued Before The Switch",
  status: "approved",
  autoApproved: false,
  progress: 0,
  at: new Date().toISOString(),
  approvedAt: new Date().toISOString(),
};

const ui = suite({ server: { config: { torrents: false }, seed: { "downloads.json": [QUEUED] } } });

ui.test("the server says so, and refuses every torrent entry point in one sentence", async ({ api, srv }) => {
  const info = await api.call("GET", "/api/server-info");
  assert.equal(info.body.torrents, false);

  const refused = [
    ["GET", "/api/torrents/sources?type=movie&title=tt9000001"],
    ["GET", `/api/torrents/status/${HASH}`],
    ["GET", `/api/torrents/probe/${HASH}/0`],
    ["GET", `/stream/torrent/${HASH}/0`],
    ["GET", `/stream/torrent/hls/${HASH}/0/jit/index.m3u8`],
    ["POST", "/api/downloads", { infoHash: HASH, type: "movie", title: "Anything" }],
  ];
  for (const [method, url, body] of refused) {
    const r = await api.call(method, url, body);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.deepEqual(r.body, { error: MESSAGE }, `${method} ${url}`);
  }

  // the queue is still readable, and the job from before the switch is as it was
  const list = await api.call("GET", "/api/downloads");
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].status, "approved");

  // past the moment a queued job would have been resumed (boot + 4 s)
  await new Promise((r) => setTimeout(r, 5500));
  const log = srv.log().join("\n");
  assert.doesNotMatch(log, /\[aria2\]/, "the download engine was started");
  assert.doesNotMatch(log, /\[download\] .* started/, "a download was started");
  assert.equal((await api.call("GET", "/api/downloads")).body[0].status, "approved");
});

ui.test("the health watch and the healer report 'off', not a dead engine with a job waiting", async ({ api }) => {
  const healer = await api.adminPost("/api/admin/healer/run");
  const text = JSON.stringify(healer);
  assert.match(text, /switched off in config\.json/);
  assert.doesNotMatch(text, /engine was down|stopped answering|pumped/);
  const health = JSON.stringify(await api.adminGet("/api/admin/health"));
  assert.doesNotMatch(health, /download engine has stopped|is not responding/i);
});

ui.test("a film on disk: Play, and none of the source buttons or lists", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const asked = [];
  page.on("request", (r) => { if (/\/api\/torrents\/sources|\/stream\/torrent\//.test(r.url())) asked.push(r.url()); });
  await goto(`#/movie/${lib.film1.id}`);
  await page.locator(".detail-actions .btn-xray").waitFor(); // the late buttons are in
  assert.equal((await page.textContent(".detail-actions > .btn-primary")).trim(), "Play");
  assert.match(await page.textContent(".detail-server"), /On disk/);
  assert.equal(await page.locator(".detail-actions .btn-sources").count(), 0, '"Other versions" is offered');
  assert.equal(await page.locator(".sources-section").count(), 0, "a sources list is on the page");
  assert.equal(await page.locator(".sources-title, .sources-fold").count(), 0);
  assert.doesNotMatch(await page.innerText("#app .screen"), /Sources|Other versions|Stream instead|Save & watch/);
  assert.deepEqual(asked, [], "the page asked for sources");

  await player.open(page, { url: new URL(page.url()).origin }, lib.film1.id);
  await player.advancing(page);
});

ui.test("a show: no Follow, and an episode on disk plays straight from its card", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const asked = [];
  page.on("request", (r) => { if (/\/api\/torrents\/sources/.test(r.url())) asked.push(r.url()); });
  await goto(`#/show/${lib.show.id}`, { selector: "#app .screen .episode-list .episode" });
  await page.locator(".detail-actions .btn-xray").waitFor();
  assert.equal(await page.locator(".btn-follow").count(), 0, "Follow promises downloads this server will not make");
  // (below 1080p this card opens a sources list on a server with torrents on)
  await page.click('.episode-list .episode[data-ep="1x2"]');
  await page.waitForFunction((id) => location.hash === `#/play/${id}`, lib.e2.id);
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.3; }, null, { timeout: 20000 });
  assert.deepEqual(asked, []);
});

ui.test("a stream item left in Continue Watching is refused politely, not opened", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/");
  await page.evaluate((h) => { location.hash = `#/play/torrent|${h}|0`; }, HASH);
  await page.waitForFunction(() => /switched off on this server/.test(document.getElementById("toasts").innerText));
  assert.equal(await page.locator(".player").count(), 0);
});

ui.run({ concurrency: 1 });
