// Search: the title you typed is the first card, a related row follows the
// matches, suggestions (titles, people, genres) with the matched letters
// marked, recent searches kept on the server, an answer for an older query
// never painted over a newer one, and a kids profile only ever shown what it
// may see.
//
// The instance is offline, so everything the search knows beyond the three
// library titles is seeded where the server keeps what its title pages have
// fetched (data/cache/meta.json): a cast, genres and episode names.
//   Test Film One   Comedy, Drama   Tessa Example, Omar Sample
//   Test Film Two   Comedy          Tessa Example
//   Test Show       Mystery         Pat Person      S1 E2 "The Lighthouse"
const assert = require("node:assert/strict");
const { suite, waitForScreen, certificatesSeed } = require("./helpers");

const meta = (imdbId, type, title, year, genres, cast, extra = {}) => ({
  at: Date.now(),
  v: 4,
  data: {
    id: imdbId, type, imdbId, title, year, poster: null, backdrop: null, logo: null, synopsis: "", genres, rating: null,
    runtime: null, cast, director: null, seasons: null, episodeCount: null, tmdbId: null, trailers: [],
    certificate: null, kidsAge: null, originalLanguage: null, ...extra,
  },
});
const ui = suite({
  server: {
    seed: {
      "cache/meta.json": {
        "movie|tt9000001": meta("tt9000001", "movie", "Test Film One", 2020, ["Comedy", "Drama"], ["Tessa Example", "Omar Sample"]),
        "movie|tt9000002": meta("tt9000002", "movie", "Test Film Two", 2021, ["Comedy"], ["Tessa Example"]),
        "series|tt9000003": meta("tt9000003", "show", "Test Show", null, ["Mystery"], ["Pat Person"], {
          seasons: [{ number: 1, episodes: [
            { season: 1, episode: 1, title: "Arrival at the Coast" },
            { season: 1, episode: 2, title: "The Lighthouse" },
            { season: 1, episode: 3, title: "Low Tide" },
          ] }],
          episodeCount: 3,
        }),
      },
      "cache/certificates.json": certificatesSeed({ film1: 0, show: 7, film2: 18 }),
    },
  },
  setup: async (srv) => {
    srv.profiles.kid = await srv.api.createProfile("Kiddo", { open: true });
    await srv.api.adminPost("/api/admin/kids-pin", { pin: "4321" }); // PIN, below
    await srv.api.adminPost(`/api/admin/profiles/${srv.profiles.kid.id}/kids`, { kids: { maxAge: 7 } });
    srv.profiles.kid.kids = { maxAge: 7 };
  },
});

const PIN = "4321";
const BOX = '.screen input[type="search"]';
const results = (page) => page.evaluate(() => [...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]));
const related = (page) => page.evaluate(() => [...document.querySelectorAll("#app .search-related:not(.hidden) .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]));
const resultsAre = (page, want) =>
  page.waitForFunction((w) => JSON.stringify([...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0])) === JSON.stringify(w), want);
const suggestions = (page) => page.evaluate(() => [...document.querySelectorAll("#app .suggest-list:not(.hidden) .suggest-item")].map((r) => ({
  kind: r.classList.contains("suggest-person") ? "person" : r.classList.contains("suggest-genre") ? "genre" : "title",
  text: r.querySelector(".suggest-title").textContent,
  marked: [...r.querySelectorAll(".suggest-title mark")].map((m) => m.textContent).join("|"),
  meta: r.querySelector(".suggest-meta").textContent,
})));
const suggestionsShow = (page, text) =>
  page.waitForFunction((t) => [...document.querySelectorAll("#app .suggest-list:not(.hidden) .suggest-title")].some((n) => n.textContent === t), text);
const settled = (page) => page.waitForFunction(() => document.querySelector("#app .search-busy").classList.contains("hidden"));

ui.test("the title you typed is the first card; a 'More like' row follows the matches under its own heading", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/search");
  const box = page.locator(BOX);

  await box.fill("test film one");
  await resultsAre(page, ["Test Film One"]);
  await page.waitForSelector("#app .search-related:not(.hidden) .card");
  assert.equal(await page.textContent("#app .search-related .row-title"), "More like Test Film One");
  assert.deepEqual(await related(page), ["Test Film Two"], "shares its cast and a genre; the show shares nothing");

  // every spelling of it: capitals, punctuation, no article, a typo
  for (const q of ["TEST FILM TWO", "test-film: two!", "tset film two"]) {
    await box.fill(q);
    await resultsAre(page, ["Test Film Two"]);
  }
  // "2" for "Two" — and, read as the start of a year, the 2020 film right after it
  await box.fill("test film 2");
  await resultsAre(page, ["Test Film Two", "Test Film One"]);

  // three titles start with the letters: all of them (the shortest name first, then the newer) —
  // and no related row padded under an open question
  await box.fill("test");
  await resultsAre(page, ["Test Show", "Test Film Two", "Test Film One"]);
  assert.deepEqual(await related(page), []);
  assert.equal(await page.locator("#app .search-related").evaluate((n) => n.classList.contains("hidden")), true);
});

ui.test("an episode's name finds its show, and the card says which episode", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto("#/search");
  await page.locator(BOX).fill("the lighthouse");
  await resultsAre(page, ["Test Show"]);
  assert.match(await page.textContent("#app .screen > .grid .card .card-label"), /S1 E2 · The Lighthouse/);
  await page.click("#app .screen > .grid .card");
  await page.waitForFunction((id) => location.hash === `#/show/${id}`, lib.show.id);
});

ui.test("suggestions: titles with the typed letters marked, then a person and a genre as rows of their own; arrow keys reach them", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto("#/search");
  const box = page.locator(BOX);

  // one letter is enough
  await box.pressSequentially("t");
  await suggestionsShow(page, "Test Film One");
  let rows = await suggestions(page);
  assert.deepEqual(rows.filter((r) => r.kind === "title").map((r) => r.text), ["Test Show", "Test Film Two", "Test Film One"]);
  assert.ok(rows.every((r) => r.kind !== "title" || r.marked === "T"), JSON.stringify(rows));

  await box.pressSequentially("es");
  await suggestionsShow(page, "Tessa Example");
  rows = await suggestions(page);
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.text}`), ["title:Test Show", "title:Test Film Two", "title:Test Film One", "person:Tessa Example"]);
  assert.deepEqual(rows[2], { kind: "title", text: "Test Film One", marked: "Tes", meta: "2020 · Film" });
  assert.deepEqual(rows[3], { kind: "person", text: "Tessa Example", marked: "Tes", meta: "Person · 2 titles" });
  assert.equal(new Set(rows.map((r) => r.text)).size, rows.length, "a suggestion is listed twice");

  // the keyboard: down from the box lands on the first row, Enter opens it
  await box.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.querySelector(".suggest-title")?.textContent), "Test Show");
  await page.keyboard.press("Enter");
  await page.waitForFunction((id) => location.hash === `#/show/${id}`, lib.show.id);

  // a person: picking it searches for them, and each card says why it is there
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#/search");
  await waitForScreen(page);
  await page.locator(BOX).fill("");
  await page.locator(BOX).pressSequentially("tessa");
  await suggestionsShow(page, "Tessa Example");
  await page.click("#app .suggest-list .suggest-person");
  await resultsAre(page, ["Test Film Two", "Test Film One"]);
  assert.equal(await page.inputValue(BOX), "Tessa Example");
  assert.deepEqual(
    await page.evaluate(() => [...document.querySelectorAll("#app .screen > .grid .card .card-meta")].map((n) => n.textContent)),
    ["With Tessa Example", "With Tessa Example"],
  );
  assert.equal(await page.locator("#app .suggest-list").evaluate((n) => n.classList.contains("hidden")), true, "the list closes once picked");

  // a genre: its titles are the related row, under the genre's name
  await page.locator(BOX).fill("");
  await page.locator(BOX).pressSequentially("com");
  await suggestionsShow(page, "Comedy");
  assert.deepEqual((await suggestions(page)).map((r) => `${r.kind}:${r.text}:${r.marked}`), ["genre:Comedy:Com"]);
  await page.click("#app .suggest-list .suggest-genre");
  await page.waitForSelector("#app .search-related:not(.hidden) .card");
  assert.equal(await page.textContent("#app .search-related .row-title"), "Comedy");
  assert.deepEqual((await related(page)).sort(), ["Test Film One", "Test Film Two"]);
  assert.deepEqual(await results(page), []);
});

ui.test("recent searches are the profile's, kept on the server: they come back on a device that never typed them, and can be removed or cleared", async ({ page, goto, signIn, freshProfile, api }) => {
  // (this instance has a household PIN — the kids test needs one — and an open profile's token is asked with it)
  const me = { ...(await freshProfile()), pin: PIN };
  await signIn(me);
  await goto("#/search");
  const box = page.locator(BOX);
  const chips = () => page.evaluate(() => [...document.querySelectorAll("#app .filter-bar .recent-chip .chip")].map((c) => c.textContent));
  const server = async () => (await api.get(`/api/profiles/${me.id}/searches`, await api.as(me))).items;

  for (const q of ["test show", "test film two"]) {
    await box.fill(q);
    await box.press("Enter");
    await page.waitForSelector("#app .screen > .grid .card");
    await settled(page);
  }
  for (let i = 0; i < 40 && (await server()).length < 2; i++) await page.waitForTimeout(50);
  assert.deepEqual(await server(), ["test film two", "test show"]);

  // another device: nothing of this in its own storage
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("aurora-recent-searches")) localStorage.removeItem(k); });
  await page.reload();
  await waitForScreen(page);
  await page.waitForSelector("#app .filter-bar .recent-chip");
  assert.deepEqual(await chips(), ["test film two", "test show"]);

  // a chip runs its search
  await page.click('#app .filter-bar .recent-chip .chip:text-is("test show")');
  await resultsAre(page, ["Test Show"]);
  assert.equal(await page.inputValue(BOX), "test show");

  // the small ✕ forgets one; Clear forgets the rest
  await page.click("#app .screen .search-clear");
  await page.waitForSelector("#app .filter-bar .recent-chip");
  await page.click('#app .filter-bar .recent-x[aria-label="Remove test film two from recent searches"]');
  await page.waitForFunction(() => document.querySelectorAll("#app .filter-bar .recent-chip").length === 1);
  assert.deepEqual(await chips(), ["test show"]);
  await page.click("#app .filter-bar .recent-clear");
  await page.waitForFunction(() => document.querySelectorAll("#app .filter-bar .recent-chip").length === 0);
  for (let i = 0; i < 40 && (await server()).length; i++) await page.waitForTimeout(50);
  assert.deepEqual(await server(), []);
});

ui.test("a slow answer for an older query never paints over the newer one", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/search");
  const box = page.locator(BOX);
  let held = 0;
  await page.route(/\/api\/search\?[^#]*q=test%20film/, async (route) => {
    held++;
    await new Promise((r) => setTimeout(r, 900));
    route.continue().catch(() => {});
  });
  await box.fill("test film");
  await box.press("Enter"); // asked at once
  await box.fill("test show");
  await box.press("Enter");
  await resultsAre(page, ["Test Show"]);
  const seen = [];
  for (let i = 0; i < 14; i++) {
    seen.push((await results(page)).join("|"));
    await page.waitForTimeout(100);
  }
  assert.ok(held >= 1, "the older query was really asked");
  assert.deepEqual([...new Set(seen)], ["Test Show"], "the older query's answer showed up");
  assert.equal(await page.inputValue(BOX), "test show");
});

ui.test("nothing found: it says so, and what the house is watching sits under the message instead of a dead end", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const other = { ...(await freshProfile()), pin: PIN };
  await api.setProgress(other, lib.film2.id, 20, 60); // someone is half-way through Film Two
  await signIn(await freshProfile());
  await goto("#/search");
  const box = page.locator(BOX);
  await box.fill("zzqqxxyy");
  await box.press("Enter");
  await page.waitForFunction(() => /zzqqxxyy/.test(document.querySelector("#app .screen .empty:not(.hidden)")?.innerText || ""));
  await page.waitForSelector("#app .search-popular:not(.hidden) .card");
  assert.match(await page.textContent("#app .search-popular .row-title"), /Popular in this house/);
  assert.deepEqual(await results(page), []);
  assert.ok((await page.evaluate(() => [...document.querySelectorAll("#app .search-popular .card")].map((c) => c.getAttribute("aria-label")))).some((t) => /^Test Film Two/.test(t)));

  // typing again: the shelf steps aside for the results
  await box.fill("test show");
  await resultsAre(page, ["Test Show"]);
  assert.equal(await page.locator("#app .search-popular").evaluate((n) => n.classList.contains("hidden")), true);

  // and an empty box brings it back, with no stale cards
  await page.click("#app .screen .search-clear");
  await page.waitForSelector("#app .search-popular:not(.hidden) .card");
  assert.deepEqual(await results(page), []);
});

ui.test("a kids profile: results, the related row and suggestions hold only what it may see", { allow: [/Failed to load resource.*403/] }, async ({ page, goto, signIn, profiles }) => {
  await signIn(profiles.kid);
  await goto("#/search");
  const box = page.locator(BOX);

  await box.pressSequentially("tes");
  await suggestionsShow(page, "Test Film One");
  const rows = await suggestions(page);
  assert.deepEqual(rows.filter((r) => r.kind === "title").map((r) => r.text), ["Test Show", "Test Film One"], "the 18+ film is suggested to a kids profile");
  assert.deepEqual(rows.find((r) => r.kind === "person"), { kind: "person", text: "Tessa Example", marked: "Tes", meta: "Person" }, "one title it may see, not two");

  await box.fill("test film");
  await resultsAre(page, ["Test Film One"]);
  await box.fill("tessa example");
  await resultsAre(page, ["Test Film One"]);
  await box.fill("test film one");
  await resultsAre(page, ["Test Film One"]);
  await settled(page);
  assert.deepEqual(await related(page), [], "the related row offers the 18+ film");
  await box.fill("comedy");
  await page.waitForSelector("#app .search-related:not(.hidden) .card");
  assert.deepEqual(await related(page), ["Test Film One"]);
  await box.fill("test film two");
  await page.waitForFunction(() => !document.querySelector("#app .screen .empty").classList.contains("hidden"));
  assert.deepEqual(await results(page), []);
});

ui.test("phone: the same search in one column of suggestions, nothing wider than the screen", { viewport: { width: 390, height: 844 } }, async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/search");
  const box = page.locator(BOX);
  await box.pressSequentially("tes");
  await suggestionsShow(page, "Tessa Example");
  assert.ok((await suggestions(page)).length <= 5);
  await box.press("Enter");
  await resultsAre(page, ["Test Show", "Test Film Two", "Test Film One"]);
  await box.fill("test film one");
  await resultsAre(page, ["Test Film One"]);
  await page.waitForSelector("#app .search-related:not(.hidden) .card");
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(m.sw <= m.iw + 1, `the page overflows sideways: ${m.sw} > ${m.iw}`);
});

ui.run();
