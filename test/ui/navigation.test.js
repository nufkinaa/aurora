// Navigation and the shell: every route renders, at a desktop and a phone
// size, with no console errors, no sideways scroll and no skeleton left
// behind; Back and Forward work.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { suite, waitForScreen, assertNoHorizontalOverflow, DESKTOP, PHONE } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    srv.profiles.open = await srv.api.createProfile("Open", { open: true });
  },
});

// One entry per route() in public/js/main.js: where to go, and what "it
// rendered" means there. The first test below fails when main.js gains a
// route this table does not know, so the list cannot silently go stale.
//   hash      what to open
//   lands     the hash the app should end on (default: the one opened)
//   selector  what must be in #app (default: a .screen)
//   text      a string the screen must show
//   toast     a toast the app must raise
const ROUTES = (lib) => ({
  "/": { hash: "#/", selector: ".screen .hero" },
  "/movies": { hash: "#/movies", text: "Movies" },
  "/shows": { hash: "#/shows", text: "Shows" },
  "/list": { hash: "#/list", text: "My List" },
  "/search": { hash: "#/search", selector: '.screen input[type="search"]' },
  "/search/:q": { hash: "#/search/Test%20Film", lands: "#/search", selector: '.screen input[type="search"]' },
  "/movie/:id": { hash: `#/movie/${lib.film1.id}`, text: "Test Film One" },
  "/show/:id": { hash: `#/show/${lib.show.id}`, selector: ".screen .episode-list", text: "Test Show" },
  "/play/:id": { hash: `#/play/${lib.film1.id}`, selector: ".player video" },
  "/requests": { hash: "#/requests" },
  "/downloads": { hash: "#/downloads", text: "My downloads" },
  "/saved": { hash: "#/saved", text: "On this device" },
  // no such party: a toast, and Home
  "/party/:code": { hash: "#/party/ZZZZ", lands: "#/", toast: "No party with that code" },
  // A catalogue title needs the outside world for everything it shows. With
  // none in reach the page must say so and leave, not hang or throw.
  "/discover/:type/:id": { hash: "#/discover/movie/tt0000001", lands: null, toast: "Couldn't load that title" },
  "/preferences": { hash: "#/preferences", text: "Settings" },
  "/wrapped": { hash: "#/wrapped", text: "Aurora Wrapped" },
  "/taste": { hash: "#/taste", text: "What's your taste?" },
  "/taste/list": { hash: "#/taste/list", text: "What do you love?" },
  "/pick": { hash: "#/pick" },
  "/new": { hash: "#/new", text: "New in Aurora" },
  // a pairing code nobody issued
  "/pair/:code": { hash: "#/pair/ABCD12", text: "That code expired" },
  // {host}/link with no code: the field to type the TV's code into
  "/pair": { hash: "#/pair", selector: ".screen .pair-code-input", text: "Sign in a TV" },
  // the phone as a remote [phone-remote]. (The walks run side by side as the
  // same profile, so the other walk's desktop page can be a device in the
  // list — the remote then picks it and names it in the address: no fixed
  // landing and no fixed words.)
  "/remote": { hash: "#/remote", lands: null, selector: ".remote-screen .rm-picker" },
  "/remote/:id": { hash: "#/remote/tv-gone-000000", lands: null, selector: ".remote-screen .rm-picker" },
});
// The browser's own "Failed to load resource" line for the answers above
// that are SUPPOSED to be a 404.
const EXPECTED_404 = [/Failed to load resource.*404.*\/api\/(party|auth\/device\/describe)\//];

test("the route table covers every route in public/js/main.js", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "public", "js", "main.js"), "utf-8");
  const declared = [...src.matchAll(/^route\(\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 15, `only found ${declared.length} route() calls — did main.js change shape?`);
  const known = Object.keys(ROUTES({ film1: {}, show: {} }));
  assert.deepEqual(declared.filter((r) => !known.includes(r)), [], "routes in main.js that navigation.test.js does not visit");
  assert.deepEqual(known.filter((r) => !declared.includes(r)), [], "routes this test visits that main.js no longer has");
});

const walk = (viewport, label) =>
  ui.test(`every route renders at ${label} (${viewport.width}×${viewport.height})`, { viewport, allow: EXPECTED_404 }, async ({ page, goto, signIn, profiles, lib, problems }) => {
    await signIn(profiles.open);
    await goto("#/");
    const failures = [];
    for (const [pattern, r] of Object.entries(ROUTES(lib))) {
      const before = problems.length;
      try {
        // each from a known place, so "the page left" is distinguishable
        await goto("#/new");
        await goto(r.hash, { selector: `#app ${r.selector || ".screen"}` });
        if (r.toast) await page.waitForFunction((t) => document.getElementById("toasts").innerText.includes(t), r.toast);
        const lands = r.lands === undefined ? r.hash : r.lands;
        if (lands) await page.waitForFunction((h) => location.hash === h, lands);
        if (r.text) await page.waitForFunction((t) => document.getElementById("app").innerText.includes(t), r.text);
        await waitForScreen(page);
        // the skeleton must not come back once the screen is up
        await page.waitForTimeout(250);
        assert.equal(await page.locator(".route-skel").count(), 0, "the route skeleton is still on the page");
        await assertNoHorizontalOverflow(page, pattern);
        if (pattern === "/play/:id") {
          // the player stacks over everything; leave it the way a viewer does
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          await page.waitForSelector(".player", { state: "detached" });
        }
      } catch (e) {
        failures.push(`${pattern} (${r.hash}): ${String(e.message).split("\n")[0]}`);
      }
      for (const p of problems.slice(before)) failures.push(`${pattern} (${r.hash}): ${p}`);
      problems.length = before; // reported above, with the route's name on it
    }
    assert.deepEqual(failures, [], `${failures.length} route problem(s) at ${label}`);
  });

walk(DESKTOP, "desktop");
walk(PHONE, "phone");

ui.test("deep links open straight on their screen after a cold load", async ({ page, signIn, profiles, lib, srv }) => {
  await signIn(profiles.open);
  for (const [hash, text] of [
    [`#/show/${lib.show.id}`, "Test Show"],
    [`#/movie/${lib.film2.id}`, "Test Film Two"],
    ["#/preferences", "Settings"],
    ["#/list", "My List"],
  ]) {
    await page.goto(`${srv.url}/${hash}`);
    await waitForScreen(page);
    await page.waitForFunction((t) => document.getElementById("app").innerText.includes(t), text);
    assert.equal(await page.evaluate(() => location.hash), hash);
    assert.equal(await page.locator(".route-skel").count(), 0);
  }
});

ui.test("Back and Forward walk the history; the Back key leaves a sub-page", async ({ page, goto, signIn, profiles, lib }) => {
  await signIn(profiles.open);
  await goto("#/");
  await page.click('#nav a[data-route="#/movies"]');
  await page.waitForSelector('.grid .card[aria-label^="Test Film One"]');
  await page.click('.grid .card[aria-label^="Test Film One"]');
  await page.waitForFunction((id) => location.hash === `#/movie/${id}`, lib.film1.id);
  await page.waitForSelector(".detail-title");

  await page.goBack();
  await page.waitForFunction(() => location.hash === "#/movies");
  await page.waitForSelector('.grid .card[aria-label^="Test Film One"]');
  assert.equal(await page.locator("#nav a.active[data-route='#/movies']").count(), 1, "the nav marks the screen you came back to");

  await page.goForward();
  await page.waitForFunction((id) => location.hash === `#/movie/${id}`, lib.film1.id);
  assert.equal(await page.textContent(".detail-title"), "Test Film One");

  // Escape is "Back" on a keyboard (and on a TV remote)
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => location.hash === "#/movies");
  await page.waitForSelector(".grid .card");
});

ui.test("an unknown route and a malformed one both fall back to Home", async ({ page, goto, signIn, profiles }) => {
  await signIn(profiles.open);
  await goto("#/movies");
  await goto("#/no-such-screen", { wait: false });
  await page.waitForFunction(() => location.hash === "#/");
  await page.waitForSelector(".screen .hero");
  await goto("#/search/%", { wait: false }); // a broken %-escape
  await page.waitForFunction(() => location.hash === "#/");
  await page.waitForSelector(".screen .hero");
});

ui.test("the phone shell keeps the nav reachable and the page inside the screen", { viewport: PHONE }, async ({ page, goto, signIn, profiles }) => {
  await signIn(profiles.open);
  await goto("#/");
  await assertNoHorizontalOverflow(page, "Home");
  for (const route of ["#/movies", "#/shows", "#/list"]) {
    const link = page.locator(`#nav a[data-route="${route}"]`);
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await page.waitForFunction((h) => location.hash === h, route);
    await waitForScreen(page);
    await assertNoHorizontalOverflow(page, route);
  }
});

// Two renders at once (router.js): Back to Search while the title page is
// still waiting for its data used to leave BOTH screens in #app — two
// Search boxes, the late title page drawn under it. The title's own answer
// is held here so the overlap happens every time.
ui.test("Back while a title page is still loading leaves one screen: the one Back went to", async ({ page, goto, signIn, profiles, lib }) => {
  await signIn(profiles.open);
  await goto("#/search");
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route(`**/api/item/${lib.film1.id}*`, async (route) => { await held; await route.continue(); });
  await page.evaluate((id) => { location.hash = `#/movie/${id}`; }, lib.film1.id);
  await page.waitForFunction(() => /^#\/movie\//.test(location.hash));
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#/search");
  await waitForScreen(page, { selector: '.screen input[type="search"]' });
  release(); // the title page's answer arrives after Search is up
  await page.waitForTimeout(1500);
  await page.unroute(`**/api/item/${lib.film1.id}*`);
  assert.equal(await page.locator('.screen input[type="search"]').count(), 1, "one Search box");
  assert.equal(await page.locator("#app .screen").count(), 1, "one screen in #app");
  assert.equal(await page.locator("#app .detail-hero, #app .detail-head").count(), 0, "the late title page is not drawn");
  // and the Search that stayed works
  await page.locator('.screen input[type="search"]').fill("test film");
  await page.waitForSelector("#app .screen > .grid .card");
});

ui.run({ concurrency: 2 });
