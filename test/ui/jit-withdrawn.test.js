// The server withdraws a film's full-timeline (jit) stream mid-film — its
// index turned out not to describe the file and media/jit.js declined it, so
// every further segment answers 404 and so does its playlist. The website's
// player goes on from the picture on the offset path — at the first 404 on
// the stream's own picture (jitFallback, 2026-11-28; it used to take the stall
// ladder ~9 s, and a stream refused that way could also loop for good).
// (The TV app never plays jit.)
// Test Film Two (MKV, AC-3) plays on jit in this browser; the 404s are put in
// the way here, after the first few segments.
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const ui = suite();

ui.test("a jit stream withdrawn mid-film: playback goes on, from where it was, on the offset path", { allow: [/Failed to load resource.*404/] }, async ({ page, srv, signIn, freshProfile, lib, t }) => {
  await signIn(await freshProfile());
  // segments 0 and 1 come through; from segment 2 on the stream is gone
  // (a 60 s film is otherwise in the buffer before anything can fail)
  let jitSegs = 0;
  let refused = 0;
  let firstRefusal = 0;
  let movedAt = 0;
  const offsets = [];
  await page.route(/\/stream\/transcode\/[^/]+\/jit\/seg(\d+)\./, (route) => {
    const k = Number(/seg(\d+)\./.exec(route.request().url())[1]);
    if (k >= 2) { if (!refused) firstRefusal = Date.now(); refused++; return route.fulfill({ status: 404, body: "No usable index in this file" }); }
    jitSegs++;
    return route.continue();
  });
  // …and, as on the server, once the file is declined its playlist is gone too
  await page.route(/\/stream\/transcode\/[^/]+\/jit\/(index|master)\.m3u8/, (route) => (refused ? route.fulfill({ status: 404, body: "No usable index in this file" }) : route.continue()));
  let posAtMove = null;
  page.on("request", (req) => {
    const m = /\/stream\/transcode\/[^/]+\/(\d+)\/index\.m3u8/.exec(req.url());
    if (m) {
      if (!offsets.length) {
        movedAt = Date.now();
        page.evaluate(() => { const v = document.querySelector(".player video"); return v ? v.currentTime : null; }).then((p) => { posAtMove = p; }, () => {});
      }
      offsets.push(Number(m[1]));
    }
  });
  await player.open(page, srv, lib.film2.id, { min: 0.5 });
  assert.ok(jitSegs > 0, "it was playing the jit stream");
  const t0 = Date.now();
  for (;;) {
    if (offsets.length) break;
    if (Date.now() - t0 > 60000) throw new Error(`the player never moved to the offset path (${refused} segments refused)`);
    await page.waitForTimeout(250);
  }
  for (let i = 0; posAtMove == null && i < 20; i++) await page.waitForTimeout(100);
  assert.ok(refused > 0, "the 404s were met");
  t.diagnostic(`moved to the offset path ${movedAt - firstRefusal} ms after the first 404 (${refused} refused), at ${posAtMove}`);
  // (an offset job begins at the whole second two before the picture — startTranscodeAt)
  assert.ok(posAtMove != null && offsets[0] >= Math.floor(posAtMove) - 3, `it went on from the picture (${posAtMove}), not from the start (asked ${offsets[0]})`);
  assert.ok(movedAt - firstRefusal < 8000, `it left the refused stream at once, not after the stall ladder (${movedAt - firstRefusal} ms)`);
  await player.advancing(page, { by: 1, timeout: 30000 });
  assert.equal(await page.locator(".player .error-card, .player-error").count(), 0, "no error card");
});

ui.run();
