// Library and search: the Movies / Shows grids, their filters, finding a
// title and opening it, My List.
const assert = require("node:assert/strict");
const { suite, waitForScreen } = require("./helpers");

const ui = suite();

const card = (title) => `.grid .card[aria-label^="${title}"]`;
// The newest toast says exactly this (its words, without the icon); null: no toast is up.
const lastToastIs = (page, text) => page.waitForFunction((t) => {
  const all = [...document.querySelectorAll("#toasts .toast")];
  if (t === null) return all.length === 0;
  const last = all[all.length - 1];
  return !!last && last.children[1].textContent === t;
}, text, { timeout: 15000 });
const titles = (page, scope = "#app .screen > .grid") =>
  page.evaluate((sel) => [...document.querySelectorAll(`${sel} .card`)].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]), scope);
const gridIs = (page, want) =>
  page.waitForFunction((w) => {
    const got = [...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]);
    return JSON.stringify(got) === JSON.stringify(w);
  }, want);

ui.test("Movies and Shows list the library's titles", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/movies");
  await gridIs(page, ["Test Film One", "Test Film Two"]);
  assert.match(await page.textContent(".browse-head .count"), /^2 downloaded/);

  await page.click('#nav a[data-route="#/shows"]');
  await page.waitForFunction(() => location.hash === "#/shows");
  await gridIs(page, ["Test Show"]);
  assert.match(await page.textContent(".browse-head .count"), /^1 downloaded/);
});

ui.test("Unwatched hides what has been watched, and comes off again", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.film1.id, 59, 60); // seen to the end
  await signIn(me);
  await goto("#/movies");
  await gridIs(page, ["Test Film One", "Test Film Two"]);

  const chip = page.locator('.filter-bar .chip:has-text("Unwatched")');
  await chip.click();
  await gridIs(page, ["Test Film Two"]);
  assert.ok(await chip.evaluate((c) => c.classList.contains("on")), "the chip shows it is on");

  await chip.click();
  await gridIs(page, ["Test Film One", "Test Film Two"]);
});

ui.test("the category pills change the grid: Downloaded is the library, a catalogue shelf is empty offline, All brings it back", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/movies");
  await gridIs(page, ["Test Film One", "Test Film Two"]);
  const pill = (name) => page.locator(`.cat-row .cat-pill:text-is("${name}")`);

  await pill("Downloaded").click();
  await page.waitForFunction(() => document.querySelector(".cat-row .cat-pill.on").textContent === "Downloaded");
  await gridIs(page, ["Test Film One", "Test Film Two"]);

  // "Top rated" is a catalogue shelf: it needs the outside world. With none
  // in reach it must come up empty (or say so), never throw or spin forever.
  await pill("Top rated").click();
  await page.waitForFunction(() => document.querySelector(".cat-row .cat-pill.on").textContent === "Top rated");
  await page.waitForFunction(() => !document.querySelector("#app .screen > .grid .skeleton, #app .screen > .grid .grid-skel"));

  await pill("All").click();
  await gridIs(page, ["Test Film One", "Test Film Two"]);
});

ui.test("the box above the grid narrows it as you type", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/movies");
  await gridIs(page, ["Test Film One", "Test Film Two"]);
  const box = page.locator('.screen input[aria-label="Search Movies"]');
  await box.fill("film two");
  await gridIs(page, ["Test Film Two"]);
  await page.click('.screen .search-clear');
  await gridIs(page, ["Test Film One", "Test Film Two"]);
});

ui.test("Search finds a title, and opening the result lands on its page", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto("#/search");
  const box = page.locator('.screen input[type="search"]');
  await box.fill("Test Film One");
  await page.waitForSelector(`#app .screen > ${card("Test Film One")}`);
  assert.deepEqual((await titles(page)).filter((t) => t.startsWith("Test")), ["Test Film One"]);

  await page.click(`#app .screen > ${card("Test Film One")}`);
  await page.waitForFunction((id) => location.hash === `#/movie/${id}`, lib.film1.id);
  await waitForScreen(page);
  assert.equal(await page.textContent(".detail-title"), "Test Film One");
});

ui.test("Search finds a show by part of its name; nonsense finds nothing and says so", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto("#/search");
  const box = page.locator('.screen input[type="search"]');
  await box.fill("test sho");
  await page.waitForSelector(`#app .screen > ${card("Test Show")}`);
  await page.click(`#app .screen > ${card("Test Show")}`);
  await page.waitForFunction((id) => location.hash === `#/show/${id}`, lib.show.id);
  await page.waitForSelector(".episode-list .episode");

  await page.goBack();
  await page.waitForFunction(() => location.hash === "#/search");
  await page.locator('.screen input[type="search"]').fill("zzqqxxyy");
  await page.waitForFunction(() => !document.querySelector("#app .screen > .grid .card") && /zzqqxxyy|Nothing|No /i.test(document.querySelector("#app .screen").innerText));
});

ui.test("My List: add from a title page, see it in the list, survive a reload, remove it", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto(`#/movie/${lib.film2.id}`);
  const add = page.locator('.detail-actions button:has(span:text-is("My List"))');
  const added = page.locator('.detail-actions button:has(span:text-is("In My List"))');
  await add.click();
  await added.waitFor();
  // the TV app's words, on both clients
  await lastToastIs(page, "Added to My List");

  await goto("#/list");
  await gridIs(page, ["Test Film Two"]);

  // the server has it, so a reload (or another device) does too
  const headers = await api.as(me);
  const { items } = await api.get(`/api/profiles/${me.id}/watchlist`, headers);
  assert.deepEqual(items.map((i) => i.id), [lib.film2.id]);
  await page.reload();
  await waitForScreen(page);
  await gridIs(page, ["Test Film Two"]);

  // and off again, from the title's page
  await page.click(`#app .screen > ${card("Test Film Two")}`);
  await added.click();
  await add.waitFor();
  await lastToastIs(page, "Removed from My List");
  await goto("#/list");
  await page.waitForSelector(".screen .empty");
  assert.match(await page.textContent(".screen .empty"), /My List is empty/);
  assert.deepEqual((await api.get(`/api/profiles/${me.id}/watchlist`, headers)).items, []);
});

// My List downloads (src/media/mylistdl.js): the add's answer says what the
// server started fetching, and the toast says it. The private instance has no
// network and its whole library is already on disk, so the server's answer is
// made up here — what is tested is the page's wording for each answer.
ui.test("My List: the toast says what the add started downloading — and nothing more when it started nothing", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  let download = null;
  await page.route("**/api/profiles/*/watchlist", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    if (JSON.parse(route.request().postData() || "{}").add && download) body.download = download;
    await route.fulfill({ json: body });
  });
  const add = page.locator('.detail-actions button:has(span:text-is("My List"))');
  const added = page.locator('.detail-actions button:has(span:text-is("In My List"))');
  // each line word for word: the newest toast is exactly it
  const cycle = async (id, expected) => {
    await goto(id);
    await add.click();
    await added.waitFor();
    await lastToastIs(page, expected);
    await added.click();
    await add.waitFor();
    await lastToastIs(page, "Removed from My List");
  };

  // the real answer here: the film is in the library, nothing is fetched (an older server: no field at all)
  await cycle(`#/movie/${lib.film1.id}`, "Added to My List");

  // the same three lines the TV app prints
  download = { queued: true, what: "film" };
  await cycle(`#/movie/${lib.film1.id}`, "Added to My List — downloading the film");
  download = { queued: true, what: "episode", season: 1, episode: 1 };
  await cycle(`#/show/${lib.show.id}`, "Added to My List — downloading the first episode");
  // asked for nothing (already started, already queued, switched off…): the plain line
  download = { queued: false, reason: "started" };
  await cycle(`#/movie/${lib.film2.id}`, "Added to My List");
});

ui.test("My List: an add or a removal that fails puts the button back and says so", {
  allow: [/Failed to load resource.*\/watchlist/],
}, async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  let fail = true;
  await page.route("**/api/profiles/*/watchlist", (route) => {
    if (route.request().method() !== "POST" || !fail) return route.continue();
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "" }) });
  });
  const add = page.locator('.detail-actions button:has(span:text-is("My List"))');
  const added = page.locator('.detail-actions button:has(span:text-is("In My List"))');
  const headers = await api.as(me);
  const listed = async () => (await api.get(`/api/profiles/${me.id}/watchlist`, headers)).items.map((i) => i.id);

  // the add fails: the button is "My List" again, and nothing claims it was added
  await goto(`#/movie/${lib.film2.id}`);
  await add.click();
  await lastToastIs(page, "Couldn't add to My List — try again");
  await add.waitFor();
  assert.equal(await added.count(), 0, "the button still says it is in the list");
  assert.doesNotMatch(await page.evaluate(() => document.getElementById("toasts").innerText), /Added to My List/);
  assert.deepEqual(await listed(), []);

  // it works: added for real
  fail = false;
  await add.click();
  await added.waitFor();
  await lastToastIs(page, "Added to My List");
  assert.deepEqual(await listed(), [lib.film2.id]);

  // the removal fails: the button is "In My List" again, and the title is still listed
  fail = true;
  await added.click();
  await lastToastIs(page, "Couldn't remove from My List — try again");
  await added.waitFor();
  assert.equal(await add.count(), 0);
  assert.deepEqual(await listed(), [lib.film2.id]);

  // the peek sheet (hold a card, or right-click it) has the same button with the same manners
  await goto("#/movies");
  await page.click(`#app .screen > ${card("Test Film Two")}`, { button: "right" });
  const peekSays = (label) => page.waitForFunction((l) => [...document.querySelectorAll(".peek button")].some((b) => b.textContent.trim() === l), label);
  await peekSays("In My List");
  await lastToastIs(page, null); // the earlier lines have gone
  await page.locator(".peek button", { hasText: "In My List" }).click();
  await lastToastIs(page, "Couldn't remove from My List — try again");
  await peekSays("In My List");
  fail = false;
  await page.locator(".peek button", { hasText: "In My List" }).click();
  await lastToastIs(page, "Removed from My List");
  await peekSays("My List");
  assert.deepEqual(await listed(), []);
});

ui.test("My List sorts and filters what is in it", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  const headers = await api.as(me);
  // listed in this order, so "Recently listed" shows the show first
  for (const id of [lib.film2.id, lib.film1.id, lib.show.id]) {
    await api.post(`/api/profiles/${me.id}/watchlist`, { itemId: id, add: true }, headers);
  }
  await signIn(me);
  await goto("#/list");
  await gridIs(page, ["Test Show", "Test Film One", "Test Film Two"]);

  await page.click('.filter-bar .picker-btn:has-text("Sort")');
  await page.click('.dropdown .dropdown-item:text-is("A – Z")');
  await gridIs(page, ["Test Film One", "Test Film Two", "Test Show"]);

  await page.click('.filter-bar .chip:text-is("Series")');
  await gridIs(page, ["Test Show"]);
  await page.click('.filter-bar .chip:text-is("Series")');
  await gridIs(page, ["Test Film One", "Test Film Two", "Test Show"]);
});

ui.run({ concurrency: 4 });
