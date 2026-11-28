// Seeks that cost nothing land at once, and a segment whose connection went
// silent is asked for again in seconds (streaming round 2, 2026-11-28 —
// docs/qa/streaming-round-2/web.md).
//
// The film is Test Film Two (repackaged, played by hls.js): its 60 s are all
// buffered a moment after the start, so every skip below lands inside what
// the browser already holds.
const assert = require("node:assert/strict");
const { suite, player, warmJit, FILM_SECONDS } = require("./helpers");

const ui = suite({ setup: async (srv) => { await warmJit(srv, srv.lib.film2.id); } });

// ms from the trusted input to the element's own "seeking"
const armSeekClock = (page) => page.evaluate(() => {
  const v = document.querySelector(".player video");
  window.__seekLag = [];
  let at = 0;
  const t = (e) => { if (e.isTrusted) at = performance.now(); };
  addEventListener("keydown", t, true);
  addEventListener("pointerup", t, true);
  v.addEventListener("seeking", () => { if (at) window.__seekLag.push(performance.now() - at); at = 0; });
});
const lags = (page) => page.evaluate(() => window.__seekLag.slice());
const fullyBuffered = (page) => page.waitForFunction(() => {
  const v = document.querySelector(".player video");
  return v && v.buffered.length && v.buffered.end(v.buffered.length - 1) >= v.duration - 1 && v.buffered.start(0) <= 1;
}, null, { timeout: 30000 });

ui.test("a skip inside what is buffered lands at once, and three in a row add up", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film2.id, { min: 1 });
  await fullyBuffered(page);
  await armSeekClock(page);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());

  const before = (await player.state(page)).t;
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => window.__seekLag.length >= 1);
  const [lag] = await lags(page);
  // (it used to wait out a 250 ms debounce before touching the element)
  assert.ok(lag < 150, `the skip reached the element ${Math.round(lag)} ms after the press`);
  const at = (await player.state(page)).t;
  assert.ok(Math.abs(at - (before + 10)) < 2, `after one skip at ${at}, expected ${before + 10}`);

  // a burst still adds up: 10 + 10 + 10
  await page.waitForTimeout(1500);
  const b2 = (await player.state(page)).t;
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((want) => Math.abs(document.querySelector(".player video").currentTime - want) < 2.5, b2 + 30, { timeout: 5000 });
  await player.advancing(page);
  assert.ok(b2 + 30 < FILM_SECONDS);
});

ui.test("a click on the timeline lands at once", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film2.id, { min: 1 });
  await fullyBuffered(page);
  await armSeekClock(page);
  await player.scrubTo(page, 0.7);
  await page.waitForFunction(() => window.__seekLag.length >= 1);
  const [lag] = await lags(page);
  assert.ok(lag < 150, `the click reached the element ${Math.round(lag)} ms after the release`);
  await page.waitForFunction((want) => Math.abs(document.querySelector(".player video").currentTime - want) < 3, FILM_SECONDS * 0.7);
  await player.advancing(page);
});
