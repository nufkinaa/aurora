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

// ---------- not all at once (the stampede: docs/qa/capacity/REPORT.md §3a) ----------
// Every "the library changed" used to be answered by every device in the same
// instant. The server now sends ONE message per burst of changes, and a tab
// waits a random 0.5–5 s before asking again — unless Home is on its screen.

// Watch this tab's socket: when each library_updated ARRIVES, and when the
// app's listeners HEAR it (after the wait).
const watch = (page) => page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  const { onMessage } = await import("/js/ws.js");
  const w = (window.__lu = { arrived: [], heard: [] });
  state.ws.addEventListener("message", (e) => { try { if (JSON.parse(e.data).type === "library_updated") w.arrived.push(performance.now()); } catch {} });
  onMessage("library_updated", () => w.heard.push(performance.now()));
});

ui.test("one rescan is ONE message, and a tab that is not on Home answers it after a random wait, once", async ({ page, goto, signIn, freshProfile, api }) => {
  await signIn(await freshProfile());
  await goto("#/shows");
  await socketUp(page);
  await watch(page);
  const requests = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname === "/api/library" || u.pathname === "/api/home") requests.push(u.pathname); });
  // what used to be two messages (the route and the scan) — asked for twice over, for good measure
  await api.rescan();
  await api.rescan();
  await page.waitForFunction(() => window.__lu.heard.length >= 1, null, { timeout: 20000 });
  await page.waitForTimeout(7000); // a second message, or a second refresh, would show by now
  const w = await page.evaluate(() => window.__lu);
  assert.equal(w.arrived.length, 1, `the server sent ${w.arrived.length} messages for one burst of changes`);
  assert.equal(w.heard.length, 1, "the tab refreshed more than once");
  const waited = w.heard[0] - w.arrived[0];
  assert.ok(waited >= 450 && waited <= 5600, `the tab waited ${Math.round(waited)} ms before asking again (0.5–5 s)`);
  assert.deepEqual(requests, ["/api/library"], "a grid asks for the library once, and never for Home");
});

ui.test("a tab with Home on its screen does not wait; a hidden tab waits until it is looked at", async ({ page, goto, signIn, freshProfile, api }) => {
  await signIn(await freshProfile());
  await goto("#/");
  await socketUp(page);
  await page.waitForSelector(".screen .hero-title");
  await watch(page);
  await api.rescan();
  await page.waitForFunction(() => window.__lu.heard.length >= 1, null, { timeout: 20000 });
  let w = await page.evaluate(() => window.__lu);
  assert.ok(w.heard[0] - w.arrived[0] < 450, `Home was refreshed ${Math.round(w.heard[0] - w.arrived[0])} ms after the message (at once: within 0.3 s)`);

  // the tab goes to the background: it hears nothing until it is seen again
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.__lu.arrived.length = 0; window.__lu.heard.length = 0;
  });
  await api.rescan();
  await page.waitForFunction(() => window.__lu.arrived.length >= 1, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  assert.equal((await page.evaluate(() => window.__lu)).heard.length, 0, "a tab nobody is looking at refreshed anyway");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => window.__lu.heard.length >= 1, null, { timeout: 10000 });
});

ui.test("Home is never fetched twice at once, a 429 is waited out and tried again, and the waits are the documented ones", async ({ page, goto, signIn, freshProfile, allow }) => {
  allow(/status of 429/); // the browser's own note about the refusal this test stages
  const me = await freshProfile();
  await signIn(me);
  await goto("#/shows");
  // one request in flight per profile, whoever asks
  let homes = 0;
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/home") homes++; });
  const same = await page.evaluate(async (pid) => {
    const { api } = await import("/js/api.js");
    const [a, b, c] = await Promise.all([api.home(pid), api.home(pid), api.home(pid)]);
    return a === b && b === c && Array.isArray(a.rows);
  }, me.id);
  assert.equal(same, true);
  assert.equal(homes, 1, "three callers, one request");

  // "too many at once": the client waits what it is told (plus a little) and asks again
  let n = 0;
  await page.route("**/api/server-info", async (route) => {
    n++;
    if (n === 1) return route.fulfill({ status: 429, headers: { "Retry-After": "1", "Content-Type": "application/json" }, body: JSON.stringify({ error: "Too many requests at once" }) });
    return route.continue();
  });
  const retried = await page.evaluate(async () => {
    const { api } = await import("/js/api.js");
    const t0 = performance.now();
    const info = await api.serverInfo();
    return { ms: performance.now() - t0, ok: !!(info && info.authMode) };
  });
  await page.unroute("**/api/server-info");
  assert.equal(retried.ok, true, "the second try's answer is what the caller gets");
  assert.equal(n, 2);
  assert.ok(retried.ms >= 950 && retried.ms < 4000, `waited ${Math.round(retried.ms)} ms (Retry-After 1 s, plus up to 1.5 s)`);

  // the two waits, as functions: a refresh, and a reconnect
  const waits = await page.evaluate(async () => {
    const ws = await import("/js/ws.js");
    return {
      gridMin: ws.refreshDelay({ home: false, caused: false, random: () => 0 }),
      gridMax: ws.refreshDelay({ home: false, caused: false, random: () => 1 }),
      home: [ws.refreshDelay({ home: true, caused: false, random: () => 0 }), ws.refreshDelay({ home: true, caused: false, random: () => 1 })],
      mine: ws.refreshDelay({ home: false, caused: true, random: () => 1 }),
      reconnect: [ws.reconnectWait(1000, () => 0), ws.reconnectWait(1000, () => 1), ws.reconnectWait(30000, () => 0), ws.reconnectWait(30000, () => 1)],
    };
  });
  assert.deepEqual(waits, { gridMin: 500, gridMax: 5000, home: [0, 300], mine: 300, reconnect: [500, 1000, 15000, 30000] });
});

// one at a time: these tests change the library on disk, which every page sees
ui.run({ concurrency: 1 });
