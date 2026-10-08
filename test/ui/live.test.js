// Live data: a change in the library reaches an open grid without a reload,
// and the grid keeps the filter it had. The change is a real one — a film
// folder dropped into the private instance's library, then the rescan the
// admin page's button asks for (POST /api/admin/rescan), which is what tells
// every connected browser (WebSocket: library_updated).
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();
const FOLDER = "Test Film Three (2022)";

const add = (srv) => fs.cpSync(path.join(srv.extras, "movies", FOLDER), path.join(srv.library.movies, FOLDER), { recursive: true });
const remove = async (srv) => {
  const dir = path.join(srv.library.movies, FOLDER);
  // (Windows: the server may still be reading the file it just probed)
  for (let i = 0; i < 40 && fs.existsSync(dir); i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (fs.existsSync(dir)) await new Promise((r) => setTimeout(r, 150));
  }
};
const gridIs = (page, want) =>
  page.waitForFunction((w) => {
    const got = [...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]);
    return JSON.stringify(got) === JSON.stringify(w);
  }, want);
const socketUp = (page) => page.waitForFunction(async () => (await import("/js/state.js")).state.ws?.readyState === 1);

ui.test("a film added to the library appears in the open Movies grid, filter kept, no reload; removed, it goes", async ({ page, srv, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.film1.id, 59, 60); // watched: the Unwatched filter hides it
  await signIn(me);
  await goto("#/movies");
  await socketUp(page);
  const chip = page.locator('.filter-bar .chip:has-text("Unwatched")');
  await chip.click();
  await gridIs(page, ["Test Film Two"]);
  await page.evaluate(() => { window.__sameDocument = true; });

  try {
    add(srv);
    await api.rescan();
    await gridIs(page, ["Test Film Three", "Test Film Two"]);
    assert.equal(await page.evaluate(() => window.__sameDocument), true, "the page was reloaded to show the new film");
    assert.ok(await page.locator('.filter-bar .chip:has-text("Unwatched")').evaluate((c) => c.classList.contains("on")), "the Unwatched filter was dropped by the update");
    assert.equal(await page.evaluate(() => location.hash), "#/movies");

    // with the filter off, all three — the watched one included
    await page.locator('.filter-bar .chip:has-text("Unwatched")').click();
    await gridIs(page, ["Test Film One", "Test Film Three", "Test Film Two"]);
    assert.match(await page.textContent(".browse-head .count"), /^3 downloaded/);
  } finally {
    await remove(srv);
    await api.rescan();
  }
  await gridIs(page, ["Test Film One", "Test Film Two"]);
  assert.equal(await page.evaluate(() => window.__sameDocument), true);
});

ui.test("a grid whose own titles did not change is left alone", async ({ page, srv, goto, signIn, freshProfile, api }) => {
  await signIn(await freshProfile());
  await goto("#/shows");
  await socketUp(page);
  await page.waitForSelector('.grid .card[aria-label^="Test Show"]');
  // mark the very node: a rebuild would replace it
  await page.evaluate(() => { document.querySelector('.grid .card[aria-label^="Test Show"]').dataset.uiKept = "1"; });
  const heard = page.evaluate(() => new Promise((resolve) => {
    import("/js/ws.js").then(({ onMessage }) => onMessage("library_updated", () => resolve(true)));
  }));
  try {
    add(srv); // a FILM: nothing the Shows grid lists
    await api.rescan();
    assert.equal(await heard, true, "the page never heard about the library change");
    await page.waitForTimeout(800); // (time for a rebuild to have happened, if one was going to)
    assert.equal(await page.locator('.grid .card[data-ui-kept="1"]').count(), 1, "the Shows grid was rebuilt for a change that was not its own");
  } finally {
    await remove(srv);
    await api.rescan();
  }
});

ui.test("Home takes the new film in as well, without a reload", async ({ page, srv, goto, signIn, freshProfile, api }) => {
  await signIn(await freshProfile());
  await goto("#/");
  await socketUp(page);
  await page.waitForSelector(".screen .hero-title");
  await page.evaluate(() => { window.__sameDocument = true; });
  const has = () => page.evaluate(() => [...document.querySelectorAll('#app .card[aria-label^="Test Film Three"]')].length);
  assert.equal(await has(), 0);
  try {
    add(srv);
    await api.rescan();
    await page.waitForFunction(() => document.querySelectorAll('#app .card[aria-label^="Test Film Three"]').length > 0);
    assert.equal(await page.evaluate(() => window.__sameDocument), true);
  } finally {
    await remove(srv);
    await api.rescan();
  }
  await page.waitForFunction(() => document.querySelectorAll('#app .card[aria-label^="Test Film Three"]').length === 0);
});

// one at a time: these tests change the library on disk, which every page sees
ui.run({ concurrency: 1 });
