// A screen that was left is let go. Title pages, Search, the grids and the
// player used to stay in memory for good: a listener on window/document or a
// subscription to the live socket that was written to remove itself "the
// next time its event arrives" — and the event never arrived (router.js
// untilLeave); for the player, subtitle tracks the browser keeps on a list of
// the document's (player.js cleanup). Measured the way tools/mobile-perf/
// holders.js measures it, in small: a weak reference to each visit's screen,
// a forced collection, and how many are still there.
const assert = require("node:assert/strict");
const { suite, player, waitForScreen } = require("./helpers");

const ui = suite();

const remember = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`nothing matches ${sel}`);
  (window.__left = window.__left || []).push({ ref: new WeakRef(el), at: location.hash.replace(/[0-9a-f]{8,}/, ":id") });
}, selector);
// (what a screen was still waiting for when it was left — a picture on its
// way, an idle callback, a timer of a second or two — holds it a moment
// longer: those are given time to run out before the count)
const collect = async (cdp) => {
  for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 1200)); await cdp.send("HeapProfiler.collectGarbage"); }
};
// -> the routes whose left screens are still alive (empty: none)
const alive = (page) => page.evaluate(() => (window.__left || []).filter((r) => { const el = r.ref.deref(); return el && !el.isConnected; }).map((r) => r.at));
const hung = (page) => page.evaluate(async () => {
  const ws = await import("/js/ws.js");
  const router = await import("/js/router.js");
  return { socket: Object.fromEntries([...ws._listeners].map(([type, set]) => [type, set.size]).filter(([, n]) => n)), untilLeave: router._leaving.size };
});

ui.test("title pages, Search and the grids: after five visits each, none of the screens that were left is still in memory", async ({ page, context, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const cdp = await context.newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const routes = [`#/movie/${lib.film1.id}`, `#/show/${lib.show.id}`, "#/search", "#/movies", "#/"];
  // once round first: a screen's code subscribes to a few things for good the first time it loads
  for (const hash of routes) await goto(hash);
  await goto("#/downloads");
  // (and the screens the app warms in the background once it is idle — the player brings the watch party's handlers)
  await page.evaluate(() => Promise.all(["player", "discover-detail", "search", "browse", "preferences"].map((s) => import(`/js/screens/${s}.js`))));
  // (the same settle as before the count below: sampled at once, the screens
  // just left were sometimes still letting go — untilLeave 5 → 2 — and the
  // count AFTER came out lower than this one, a failure with nothing leaked)
  await page.waitForTimeout(500);
  const before = await hung(page);
  for (let round = 0; round < 5; round++) {
    for (const hash of routes) {
      await goto(hash);
      if (hash === "#/search") {
        await page.locator('.screen input[type="search"]').fill("Test");
        // (a locator, not waitForSelector: that hands back a handle, and a handle the test holds keeps the card — and its screen — alive)
        await page.locator("#app .screen > .grid .card").first().waitFor();
      }
      await remember(page, "#app .screen");
    }
  }
  await goto("#/downloads");
  await page.waitForTimeout(500);
  await collect(cdp);
  assert.equal(await page.evaluate(() => window.__left.length), 25);
  assert.deepEqual(await alive(page), [], "screens that were left are still alive");
  // and what they had hung on the socket and on the page is gone with them
  // (nothing GREW: a count lower than the first one is a listener of the
  // first count that has since let go — the downloads screen's own
  // subscription ends at the next download event once its screen is gone —
  // which on a fresh server's first minutes, a library walk landing mid-test,
  // was sometimes still waiting when the first count was taken)
  const after = await hung(page);
  const grew = Object.entries(after.socket).filter(([type, n]) => n > (before.socket[type] || 0)).map(([type, n]) => `${type} ${before.socket[type] || 0} → ${n}`);
  if (after.untilLeave > before.untilLeave) grew.push(`untilLeave ${before.untilLeave} → ${after.untilLeave}`);
  assert.deepEqual(grew, [], `left behind on the socket / the router: ${JSON.stringify({ before, after })}`);
});

ui.test("the player: after four films, none of the players that were left is still in memory", async ({ page, context, srv, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const cdp = await context.newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await goto("#/movies");
  for (let i = 0; i < 4; i++) {
    await player.open(page, srv, lib.film1.id, { query: "?restart=1" });
    await remember(page, "#app .player");
    assert.ok(await page.evaluate(() => document.querySelectorAll(".player video track").length) >= 1, "this film has subtitle tracks (they are what held the player)");
    await player.press(page, "Back");
    await page.waitForSelector(".player", { state: "detached" });
    await waitForScreen(page);
  }
  await goto("#/downloads");
  await page.evaluate(() => { window.__uiRun = null; }); // (the helpers' own note of the last <video> they watched)
  await collect(cdp);
  assert.deepEqual(await alive(page), [], "players that were left are still alive");
});

ui.run({ concurrency: 1 });
