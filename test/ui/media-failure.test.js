// When the browser's media pipeline fails under an hls.js stream, the
// picture must not stand still for minutes. Seen on the stall rig
// (2026-10-28): a switch from a long direct play onto the 480p encode, the
// element's own error five seconds in, then hls.js's "bufferAppendError" on
// every level and a still picture for over five minutes — the element's
// error had paused it, and a paused film is the viewer's doing to every
// recovery the player has.
//
// Both states are forced here, in the page:
//  - every append into the MediaSource refused (a pipeline gone bad, which
//    hls.js's own mend does not mend — and which hls.js can go on reporting
//    as not fatal for ever): the player tries the stream again a bounded
//    number of times, then says so — the card, with Try again — within half
//    a minute. Try again, once the pipeline works again, plays on from the
//    same spot.
//  - the element's own decode error, which pauses it, on a stream it has
//    been playing: the player builds the same stream again where it was and
//    the film moves on — not "this device refuses the copy" (the full encode
//    for the rest of the film), and not a card waiting for the viewer.
const assert = require("node:assert/strict");
const { suite, player, warmJit, FILM_SECONDS } = require("./helpers");

const ui = suite({
  setup: async (srv) => { await warmJit(srv, srv.lib.film2.id); },
});

// every append into a MediaSource refused while window.__media.refuse is on
const breakMedia = (page) => page.addInitScript(() => {
  const real = SourceBuffer.prototype.appendBuffer;
  window.__media = { refuse: false, refused: 0 };
  SourceBuffer.prototype.appendBuffer = function (data) {
    if (window.__media.refuse) { window.__media.refused++; throw new DOMException("the media pipeline is gone (test)", "InvalidStateError"); }
    return real.call(this, data);
  };
});
const cardShown = (page) => page.locator(".player .player-error").count().then((n) => n > 0);
const clock = (page) => page.evaluate(() => document.querySelector(".player video").currentTime);

ui.test("every append refused after a change of level: tried again, then the card with Try again inside half a minute — and Try again plays on from there", async ({ page, srv, signIn, freshProfile, lib }) => {
  await breakMedia(page);
  await signIn(await freshProfile());
  const marks = player.marks(page);
  await player.open(page, srv, lib.film2.id, { min: 1 });
  await page.waitForTimeout(1500);
  const want = await clock(page);
  await page.evaluate(() => { window.__media.refuse = true; });
  const t0 = Date.now();
  // a change of level now (480p, from the player's own menu): hls.js drops
  // what it has ahead and asks for the new level's segments — all refused
  await player.press(page, "Settings");
  await page.waitForSelector(".player .menu .menu-title");
  await page.locator(".player .menu .menu-item", { hasText: "480p" }).first().click();
  // a bounded time: the card, not a still picture for minutes
  await page.waitForSelector(".player .player-error", { timeout: 30000 }).catch(async () => {
    const st = await page.evaluate(() => { const v = document.querySelector(".player video"); return { media: window.__media, ct: v && v.currentTime, paused: v && v.paused, rs: v && v.readyState }; });
    throw new Error(`no card inside 30 s: ${JSON.stringify(st)}, marks ${JSON.stringify(marks.all.slice(-8))}`);
  });
  const took = Date.now() - t0;
  assert.ok(took < 30000, `the card after ${took} ms`);
  assert.match(await page.textContent(".player .player-error"), /Try again/);
  assert.ok(await page.evaluate(() => window.__media.refused) > 0, "appends were refused");
  const tries = marks.all.filter((m) => m.name === "media-error" && m.did === "rebuild");
  assert.ok(tries.length >= 1, `the stream was tried again before the card: ${JSON.stringify(marks.all.filter((m) => m.name === "media-error"))}`);
  // the pipeline is back: Try again plays on from the same spot
  await page.evaluate(() => { window.__media.refuse = false; });
  await page.click('.player .player-error [data-ui="player.retry"]');
  await player.playing(page, { timeout: 30000, min: want - 10 });
  const at = await clock(page);
  assert.ok(Math.abs(at - want) < 10, `after Try again the film plays at ${at.toFixed(1)} s — it was at ${want.toFixed(1)} s`);
  assert.equal(await cardShown(page), false);
});

// The element's own error, as Chrome gives it: the element errs and pauses
// itself. (Played by the page: the element's `error` says a decode error,
// the "error" event fires, the element pauses — until the next load.)
const elementError = (page) => page.evaluate(() => {
  const v = document.querySelector(".player video");
  Object.defineProperty(v, "error", { configurable: true, get: () => ({ code: 3, message: "PIPELINE_ERROR_DECODE (test)" }) });
  const clear = () => { delete v.error; v.removeEventListener("emptied", clear); v.removeEventListener("loadstart", clear); };
  v.addEventListener("emptied", clear);
  v.addEventListener("loadstart", clear);
  v.dispatchEvent(new Event("error"));
  v.pause();
});
const movingNear = async (page, at, what) => {
  await page.waitForFunction((from) => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > from - 3; }, at, { timeout: 30000 });
  const a = await clock(page);
  await page.waitForTimeout(1500);
  const b = await clock(page);
  assert.ok(b > a + 0.5, `${what}: moving again (${a.toFixed(1)} → ${b.toFixed(1)})`);
  assert.ok(b > at - 5 && b < at + 20, `${what}: at ${b.toFixed(1)} s, it was at ${at.toFixed(1)} s`);
  assert.equal(await cardShown(page), false, `${what}: no card`);
};

ui.test("the element's own error, twice, on a stream it has been playing (the element pauses itself): the same stream again at that spot each time — moving within seconds, no card, not the full encode", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const marks = player.marks(page);
  const encodes = [];
  page.on("request", (r) => { if (/\/stream\/transcode\/[^/]+\/\d+\/index\.m3u8\?v=h264/.test(r.url())) encodes.push(r.url()); });
  await player.open(page, srv, lib.film2.id, { min: 3 });
  let at = await clock(page);
  await elementError(page);
  await movingNear(page, at, "after the first error");
  await page.waitForTimeout(3000);
  at = await clock(page);
  await elementError(page);
  await movingNear(page, at, "after the second error");
  const said = marks.all.filter((m) => m.name === "media-error");
  assert.ok(said.filter((m) => m.did === "rebuild").length >= 2, `the same stream again: ${JSON.stringify(said)}`);
  assert.deepEqual(encodes, [], "it went to the full encode");
});

ui.run({ concurrency: 1 });
