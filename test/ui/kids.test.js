// Kids profiles — Children mode since 2026-11-11 (docs/children-mode.md;
// test/ui/children-mode.test.js has its own flows): an account limited to an
// age only gets titles rated at or under it; a blocked title's page says so
// and its stream is refused; leaving takes the passcode; everyone else is
// unaffected.
//
// The ratings come from where the server keeps them (data/cache/
// certificates.json, by IMDb id), seeded before boot — nothing is asked of
// TMDB:   Test Film One  all ages      Test Show  7+      Test Film Two  18+
// The kids profile is limited to 7: Film One and the show are in, Film Two is out.
const assert = require("node:assert/strict");
const { suite, waitForScreen, certificatesSeed } = require("./helpers");

const PIN = "4321";
let available = true;

const ui = suite({
  server: { seed: { "cache/certificates.json": certificatesSeed({ film1: 0, show: 7, film2: 18 }) } },
  setup: async (srv) => {
    // an older server has no kids profiles at all: every test here skips
    const status = await srv.api.call("GET", "/api/kids/status");
    available = status.status === 200 && Array.isArray(status.body.ages);
    if (!available) return;
    srv.profiles.parent = await srv.api.createProfile("Parent");
    srv.profiles.kid = await srv.api.createProfile("Kiddo", { open: true });
    await srv.api.adminPost("/api/admin/kids-pin", { pin: PIN });
    await srv.api.adminPost(`/api/admin/profiles/${srv.profiles.kid.id}/kids`, { kids: { maxAge: 7 } });
    srv.profiles.kid.kids = { maxAge: 7 };
    // more kids profiles, for hopping between them: stricter (all ages),
    // the same limit, looser (12+), and a stricter one with its own password
    srv.profiles.tiny = await srv.api.createProfile("Tiny", { open: true, kids: { maxAge: 0 } });
    srv.profiles.twin = await srv.api.createProfile("Twin", { open: true, kids: { maxAge: 7 } });
    srv.profiles.teen = await srv.api.createProfile("Teen", { open: true, kids: { maxAge: 12 } });
    srv.profiles.tinyPw = await srv.api.createProfile("Tinylock", { kids: { maxAge: 0 } });
  },
});

// ui.test, skipped cleanly where the server has no kids routes
const kidsTest = (name, options, fn) => {
  if (typeof options === "function") { fn = options; options = {}; }
  ui.test(name, options, async (h) => {
    if (!available) return h.t.skip("this server has no kids profiles (GET /api/kids/status)");
    await fn(h);
  });
};

const REFUSED = /Failed to load resource.*403/; // the browser's line for each refusal the gate makes
const tile = (name) => `.profiles-gate .profile-tile[title="${name}"]`;
const cards = (page) => page.evaluate(() => [...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]));
const gridIs = (page, want) =>
  page.waitForFunction((w) => JSON.stringify([...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0])) === JSON.stringify(w), want);

kidsTest("the wall marks the kids profile, and the server reports the PIN is set", async ({ page, goto, api }) => {
  await goto("#/", { wait: false });
  await page.waitForSelector(tile("Kiddo"));
  const badge = page.locator(`${tile("Kiddo")} .profile-kids`);
  assert.equal(await badge.textContent(), "Kids");
  assert.match(await badge.getAttribute("title"), /titles up to 7\+/);
  assert.equal(await page.locator(`${tile("Parent")} .profile-kids`).count(), 0);
  const status = await api.get("/api/kids/status");
  assert.equal(status.pinSet, true);
  assert.equal((await api.profile((await api.profiles()).find((p) => p.name === "Kiddo").id)).kids.maxAge, 7);
});

kidsTest("a kids profile sees only the titles its age allows: grids, Home and Search", async ({ page, goto, signIn, profiles, lib }) => {
  await signIn(profiles.kid);
  await goto("#/movies");
  await gridIs(page, ["Test Film One"]);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-kids")), true, "the page does not know it is a kids profile");

  await goto("#/shows");
  await gridIs(page, ["Test Show"]);

  await goto("#/");
  await page.waitForSelector("#app .screen .hero-title, #app .screen .card");
  await page.waitForTimeout(600);
  const home = await page.evaluate(() => document.querySelector("#app .screen").innerText + " " + [...document.querySelectorAll("#app .card")].map((c) => c.getAttribute("aria-label")).join(" "));
  assert.doesNotMatch(home, /Test Film Two/, "the 18+ film is on the kids profile's Home");
  assert.match(home, /Test Film One|Test Show/);

  await goto("#/search");
  await page.locator('.screen input[type="search"]').fill("Test Film");
  await page.waitForSelector('#app .screen > .grid .card[aria-label^="Test Film One"]');
  assert.deepEqual((await cards(page)).filter((t) => t.startsWith("Test")), ["Test Film One"]);

  // and the server agrees, whatever the page does
  const names = await page.evaluate(async (id) => {
    const lib = await (await fetch(`/api/library?profile=${id}`)).json();
    return [...lib.movies, ...lib.shows].map((x) => x.title).sort();
  }, profiles.kid.id);
  assert.deepEqual(names, ["Test Film One", "Test Show"]);
  assert.ok(lib.film2.id);
});

kidsTest("a direct link to a blocked title does not open it, and its stream is refused with 403", { allow: [REFUSED] }, async ({ page, goto, signIn, profiles, lib }) => {
  await signIn(profiles.kid);
  await goto("#/movies");
  await gridIs(page, ["Test Film One"]);

  // the typed (or shared) address of the 18+ film's page: the app backs out
  await goto(`#/movie/${lib.film2.id}`, { wait: false });
  await page.waitForFunction((id) => !location.hash.includes(id), lib.film2.id);
  await waitForScreen(page);
  assert.equal(await page.locator(".detail-title", { hasText: "Test Film Two" }).count(), 0, "the blocked film's page rendered");

  // its player
  await goto(`#/play/${lib.film2.id}`, { wait: false });
  await page.waitForFunction((id) => !location.hash.includes(id), lib.film2.id);
  assert.equal(await page.locator(".player video").count(), 0, "a player opened for the blocked film");

  // and the bytes themselves: the browser carries the kids lock on every request
  const status = (url, headers = {}) => page.evaluate(async ([u, h]) => (await fetch(u, { headers: h })).status, [url, headers]);
  assert.equal(await status(`/stream/video/${lib.film2.id}`, { Range: "bytes=0-99" }), 403, "the blocked film's file");
  assert.equal(await status(`/stream/transcode/${lib.film2.id}/jit/index.m3u8`), 403, "the blocked film's repackaged stream");
  assert.equal(await status(`/stream/hls/${lib.film2.id}/index.m3u8`), 403, "the blocked film's HLS playlist");
  assert.equal(await status(`/stream/download/${lib.film2.id}`), 403, "the blocked film as a download");
  assert.equal(await status(`/api/item/${lib.film2.id}`), 403, "the blocked film's details");
  assert.equal(await status(`/img/still/${lib.film2.id}`), 403, "a frame from the blocked film");
  // the refusal says why, in the server's words
  assert.match(await page.evaluate(async (id) => (await (await fetch(`/api/item/${id}`)).json()).error, lib.film2.id), /isn't available in Children mode/);
  // what it may see is served
  assert.equal(await status(`/stream/video/${lib.film1.id}`, { Range: "bytes=0-99" }), 206);
  assert.equal(await status(`/api/item/${lib.show.id}`), 200);
});

// APPLICATION BUG (reported, not fixed here). The server answers a kids
// profile's request for a blocked title with 403 and a sentence written for
// the viewer ("That one isn't available in a kids profile."). The catalogue
// page (#/discover/...) shows it as a toast. The LIBRARY page and the player
// do not: renderDetail (discover-detail.js) and renderPlayer (player.js) both
// do `api.item(id).catch(() => null)` / `catch { return navigate("#/") }`,
// so the child is dropped on Home with no word of why.
for (const [what, hash] of [["title page", (lib) => `#/movie/${lib.film2.id}`], ["player", (lib) => `#/play/${lib.film2.id}`]]) {
  kidsTest(`a direct link to a blocked title's ${what} says it isn't available in Children mode`, { allow: [REFUSED] }, async ({ page, goto, signIn, profiles, lib }) => {
    await signIn(profiles.kid);
    await goto("#/movies");
    await goto(hash(lib), { wait: false });
    await page.waitForFunction(() => /isn't available in Children mode/.test(document.getElementById("toasts").innerText + " " + document.getElementById("app").innerText), null, { timeout: 4000 });
  });
}

kidsTest("an allowed title plays in the kids profile", async ({ page, goto, signIn, profiles, lib }) => {
  await signIn(profiles.kid);
  await goto("#/movies");
  await page.click('.grid .card[aria-label^="Test Film One"]');
  await page.waitForFunction((id) => location.hash === `#/movie/${id}`, lib.film1.id);
  await page.click(".detail-actions > .btn-primary");
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.5; }, null, { timeout: 20000 });
});

// Children mode (2026-11-11) replaced kids profiles: a profile marked by the
// admin's older route is an account in children mode now, its passcode the
// household PIN (copied — src/routes/admin.js). Inside it the menu has no
// "Switch profile": leaving it, with the passcode, is the way back.
const leaveSheet = (page) => page.locator(".child-sheet");
const openLeave = async (page) => {
  await page.click("#nav-profile");
  await page.click('.nav-menu button:has-text("Leave Children mode")');
  await leaveSheet(page).waitFor();
};

kidsTest("leaving Children mode asks for the passcode: a wrong one is refused, the right one turns it off for the account", { allow: [REFUSED, /Failed to load resource.*401/] }, async ({ page, goto, signIn, freshProfile }) => {
  const kid = await freshProfile({ kids: { maxAge: 7 } }); // its passcode: the household PIN
  await signIn(kid);
  await goto("#/movies");
  await gridIs(page, ["Test Film One"]);
  await page.click("#nav-profile");
  assert.equal(await page.locator('.nav-menu button:has-text("Switch profile")').count(), 0, "no profile switching in Children mode");
  assert.equal(await page.locator('.nav-menu button:has-text("Sign out")').count(), 0);
  assert.equal(await page.locator(".nav-menu-dl").count(), 0, "no downloads in Children mode");
  await page.keyboard.press("Escape");
  await openLeave(page);
  const sheet = leaveSheet(page);
  assert.match(await sheet.textContent(), /Enter the passcode to leave Children mode/);

  await sheet.locator("input.child-code").fill("0000");
  await sheet.locator('[data-ui="child.off"]').click();
  const err = sheet.locator(".pw-error");
  await err.waitFor({ state: "visible" });
  assert.match(await err.textContent(), /not the passcode/);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-kids")), true, "still in Children mode");

  await sheet.locator("input.child-code").fill(PIN);
  await sheet.locator('[data-ui="child.off"]').click();
  await sheet.waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-kids"));
  assert.equal((await page.evaluate(async (id) => (await (await fetch(`/api/profiles/${id}/child-mode`)).json()).on, kid.id)), false, "off for the account");
  // the whole library — the list is asked for again, not reused
  await goto("#/movies");
  await gridIs(page, ["Test Film One", "Test Film Two"]);
});

kidsTest("closing the passcode sheet stays in Children mode", async ({ page, goto, signIn, profiles }) => {
  await signIn(profiles.kid);
  await goto("#/movies");
  await openLeave(page);
  await leaveSheet(page).locator("button", { hasText: "Cancel" }).click();
  await leaveSheet(page).waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-kids")), true);
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), profiles.kid.id);
  await gridIs(page, ["Test Film One"]);
});

// A browser locked to an account in children mode that lands on the wall
// (nothing remembered — a cleared tab): picking someone else takes the
// passcode first; closing the sheet stays put, the lock untouched.
kidsTest("the wall's way out of a locked browser takes the passcode", async ({ page, goto, signIn, profiles }) => {
  await signIn(profiles.kid);
  await goto("#/movies");
  await gridIs(page, ["Test Film One"]);
  await page.evaluate(() => { localStorage.removeItem("aurora-profile"); });
  await page.reload();
  await page.waitForSelector(tile("Parent"));
  await page.click(tile("Parent"));
  const sheet = page.locator(".modal", { hasText: "Enter the passcode to leave Children mode" });
  await sheet.waitFor();
  await sheet.locator("button", { hasText: "Cancel" }).click();
  await sheet.waitFor({ state: "detached" });
  assert.equal(await page.locator('.modal input[type="password"]').count(), 0, "the parent's password is asked for without the passcode");
  assert.deepEqual(await page.evaluate(async () => (await (await fetch("/api/kids/status")).json()).lock), { profile: profiles.kid.id, maxAge: 7 });
});

kidsTest("a normal profile is unaffected: the whole library, and the 18+ film plays", async ({ page, goto, signIn, profiles, lib }) => {
  await signIn(profiles.parent);
  await goto("#/movies");
  await gridIs(page, ["Test Film One", "Test Film Two"]);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-kids")), false);
  await goto(`#/movie/${lib.film2.id}`);
  assert.equal(await page.textContent(".detail-title"), "Test Film Two");
  assert.equal(await page.evaluate(async (id) => (await fetch(`/stream/video/${id}`, { headers: { Range: "bytes=0-99" } })).status, lib.film2.id), 206);
  await page.click(".detail-actions > .btn-primary");
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.5; }, null, { timeout: 30000 });
});

kidsTest("a kids profile's Settings leave out what is not a child's to change", async ({ page, goto, signIn, profiles }) => {
  await signIn(profiles.kid);
  await goto("#/preferences");
  await waitForScreen(page);
  await page.waitForSelector("#app .pref-section");
  const heads = await page.evaluate(() => [...document.querySelectorAll("#app .pref-section .pref-head")].map((h) => h.textContent.trim()));
  assert.ok(heads.includes("Appearance"));
  assert.ok(!heads.includes("Downloads"), `a kids profile is offered the Downloads settings: ${JSON.stringify(heads)}`);
});

// An empty Home on a kids profile says why — nothing rated for its age — and
// not the admin's "Point config.json at your Movies and Shows folders" (the
// TV's Home said "the server may still be warming up"; both say this now).
kidsTest("a kids profile with nothing for its age: Home says so, in the TV's words", async ({ page, goto, signIn, profiles }) => {
  await page.route((url) => url.pathname === "/api/home", (route) => route.fulfill({ json: { hero: [], rows: [] } }));
  await signIn(profiles.tiny);
  await goto("#/");
  const empty = page.locator("#app .screen .empty");
  await empty.waitFor();
  assert.match(await empty.innerText(), /Nothing for this age here yet\./);
  assert.match(await empty.innerText(), /rated for all ages — none are in the library yet/);
  assert.doesNotMatch(await empty.innerText(), /config\.json/);
});

ui.run({ concurrency: 3 });
