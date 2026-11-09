// Franchise order on the website (desktop and phone, both looks, 320 px):
//   · the title page's "Part of the Test Saga · 1 of 3 — Watch in order"
//   · the franchise page: every entry in order, what is on the server, what
//     this person watched, Play / Save & watch / Open, the order switch (kept
//     for the person, followed by the title page's "2 of 3")
//   · the end of a film: "Next in the Test Saga" — on the server, Play now
//     counting down; not on the server, Save & watch (its page presses its own
//     Save & watch once — the ★ Best, nothing else) and no countdown
//   · Home's "Continue the franchise"
//   · a kids profile's franchise page shows only what it may see
// The franchise is the household's own file (data/franchises/test-saga.json)
// over the test library; its sources and the missing film's page are answered
// here, and every POST to the downloads API is caught — none is real.
// FR_SHOTS=1 also writes screenshots to docs/qa/franchise/ (or FR_SHOTS_DIR).
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE, player, assertNoHorizontalOverflow, certificatesSeed } = require("./helpers");

const SHOTS = process.env.FR_SHOTS_DIR || path.join(__dirname, "..", "..", "docs", "qa", "franchise");
const shot = async (page, name) => {
  if (!process.env.FR_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
};

// release: Film One → Film Two → (Test Show, optional) → Film Three (not on the server)
// story:   Film Two → Test Show → Film One → Film Three
const SAGA = {
  id: "test-saga", name: "Test Saga", the: true, priority: 10,
  sources: ["made up for the browser tests"],
  entries: [
    { imdbId: "tt9000001", tmdbId: 9000001, type: "movie", title: "Test Film One", year: 2020, date: "2020-01-10" },
    { imdbId: "tt9000002", tmdbId: 9000002, type: "movie", title: "Test Film Two", year: 2021, date: "2021-03-01" },
    { imdbId: "tt9000003", tmdbId: 9000003, type: "series", title: "Test Show", year: 2021, date: "2021-06-01", optional: true },
    { imdbId: "tt9000004", tmdbId: 9000004, type: "movie", title: "Test Film Three", year: 2022, date: "2022-05-01" },
  ],
  story: ["tt9000002", "tt9000003", "tt9000001", "tt9000004"],
};

const ui = suite({
  server: {
    seed: {
      "franchises/test-saga.json": SAGA,
      "cache/certificates.json": certificatesSeed({ film1: 0, film2: 18, show: 7, film3: 0 }),
    },
  },
});

const FILM3 = "tt9000004";
const H = (c) => String(c).repeat(40);
// the missing film's page: its metadata and one good source, a caught download
const stageFilm3 = async (page) => {
  const posted = [];
  await page.route(`**/api/discover/meta/movie/${FILM3}`, (route) =>
    route.fulfill({ json: { imdbId: FILM3, type: "movie", title: "Test Film Three", year: 2022, synopsis: "The third one.", genres: ["Drama"], cast: [], trailers: [] } }));
  await page.route(/\/api\/torrents\/sources\?/, (route) =>
    route.fulfill({ json: { imdbId: FILM3, streams: [{
      infoHash: H("a"), fileIdx: 0, filename: "Test.Film.Three.2022.1080p.mkv", release: "Test.Film.Three.2022.WEB-DL", provider: "test",
      quality: "1080p", qualityLabel: "1080p", tags: [], cam: false, prerelease: null, hardsub: false, badge: null, warning: null,
      dubbed: false, seeders: 40, sizeString: "2.0 GB", sizeBytes: 2e9, languages: ["EN"], pack: false, recommended: true,
    }], release: { state: "good", line: null, note: null } } }));
  await page.route(/\/api\/downloads(\?|$)/, (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fulfill({ json: [] });
    const body = req.postDataJSON();
    posted.push(body);
    return route.fulfill({ json: { job: { id: `job${posted.length}`, status: "approved", progress: 0, infoHash: body.infoHash, fileIdx: body.fileIdx, imdbId: body.imdbId, title: body.title, mine: true } } });
  });
  return posted;
};
const setLook = async (api, p, look) => { if (look === "legacy") await api.ok("PUT", `/api/profiles/${p.id}`, { look: "legacy" }, await api.as(p)); };
const lineOf = (page) => page.locator('#app [data-ui="detail.franchise"]');
const entries = (page) => page.evaluate(() => [...document.querySelectorAll(".fr-entries > .fr-entry")].map((li) => ({
  pos: li.querySelector(".fr-pos").textContent.trim(),
  title: li.querySelector(".fr-title").childNodes[0].textContent.trim(),
  tags: li.querySelector(".fr-tags").innerText.replace(/\s+/g, " ").trim(),
  act: li.querySelector(".fr-act").innerText.trim(),
})));

const SIZES = [["desktop", DESKTOP, "glass"], ["phone", PHONE, "glass"], ["desktop classic", DESKTOP, "legacy"], ["phone classic", PHONE, "legacy"], ["320", { width: 320, height: 640 }, "glass"]];
for (const [tag, viewport, look] of SIZES) {
  ui.test(`${tag}: the title page's line opens the franchise page — in order, what's on the server, one action each`, { viewport }, async ({ page, goto, signIn, freshProfile, api, lib }) => {
    const me = await freshProfile();
    await setLook(api, me, look);
    await signIn(me);
    await goto(`#/movie/${lib.film1.id}`);
    const line = lineOf(page);
    await line.waitFor();
    assert.equal((await line.locator(".franchise-line-text").innerText()).trim(), "Part of the Test Saga · 1 of 3");
    assert.match(await line.locator(".franchise-line-go").innerText(), /Watch in order/);
    await assertNoHorizontalOverflow(page, "the title page");
    if (process.env.FR_SHOTS) await page.evaluate(() => { const n = document.querySelector(".franchise-line"); n.scrollIntoView({ block: "center" }); });
    await shot(page, `${tag.replace(/ /g, "-")}-1-title-line`);
    await line.click();
    await page.waitForFunction(() => location.hash === "#/franchise/test-saga");
    await page.locator(".fr-entries > .fr-entry").first().waitFor();
    assert.equal(await page.locator(".franchise-head h1").innerText(), "Test Saga");
    assert.equal(await page.locator(".franchise-summary").innerText(), "3 films · 1 optional · 2 on the server");
    assert.deepEqual(await entries(page), [
      { pos: "1", title: "Test Film One", tags: "On the server", act: "Play" },
      { pos: "2", title: "Test Film Two", tags: "On the server", act: "Play" },
      { pos: "", title: "Test Show", tags: "Optional Series On the server", act: "Open" },
      { pos: "3", title: "Test Film Three", tags: "Not on the server", act: "Save & watch" },
    ]);
    // the order switch: both orders, release order on
    const chips = page.locator('.franchise-orders [data-ui="franchise.order"]');
    assert.deepEqual(await chips.allInnerTexts(), ["Release order", "Story order"]);
    assert.equal(await chips.nth(0).getAttribute("aria-checked"), "true");
    await assertNoHorizontalOverflow(page, "the franchise page");
    await shot(page, `${tag.replace(/ /g, "-")}-2-franchise-page`);
    // Play plays the server's copy
    await page.locator('.fr-entry:nth-child(2) [data-ui="franchise.play"]').click();
    await page.waitForFunction((id) => location.hash === `#/play/${id}`, lib.film2.id);
  });
}

ui.test("the order switch is the person's: kept on the server, the title page's number follows, somebody else's is theirs", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  const other = await freshProfile();
  await signIn(me);
  await goto("#/franchise/test-saga");
  await page.locator(".fr-entries > .fr-entry").first().waitFor();
  await page.locator('[data-ui="franchise.order"]', { hasText: "Story order" }).click();
  await page.waitForFunction(() => document.querySelector(".fr-entries .fr-title") && document.querySelector(".fr-entries .fr-title").textContent.startsWith("Test Film Two") &&
    document.querySelector('[data-ui="franchise.order"][aria-checked="true"]').textContent === "Story order");
  assert.deepEqual((await entries(page)).map((e) => `${e.pos} ${e.title}`), ["1 Test Film Two", " Test Show", "2 Test Film One", "3 Test Film Three"]);
  // kept for the person: the server says so, and a fresh visit opens in it
  for (let i = 0; i < 40; i++) {
    const r = await api.get(`/api/franchises/test-saga?profile=${me.id}`);
    if (r.savedOrder === "story") break;
    await page.waitForTimeout(100);
  }
  assert.equal((await api.get(`/api/franchises/test-saga?profile=${me.id}`)).order, "story");
  assert.equal((await api.get(`/api/franchises/test-saga?profile=${other.id}`)).order, "release", "somebody else's order is theirs");
  await goto(`#/movie/${lib.film1.id}`);
  await lineOf(page).waitFor();
  assert.equal((await lineOf(page).locator(".franchise-line-text").innerText()).trim(), "Part of the Test Saga · 2 of 3");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#app .screen"));
  await goto("#/franchise/test-saga");
  await page.locator(".fr-entries > .fr-entry").first().waitFor();
  assert.equal(await page.locator('[data-ui="franchise.order"][aria-checked="true"]').innerText(), "Story order");
  // a title in no franchise has no line
  await goto(`#/show/${lib.show.id}`);
  await page.waitForTimeout(600);
  assert.equal((await lineOf(page).count()), 1, "the show is in the saga (optional)");
  assert.equal((await lineOf(page).locator(".franchise-line-text").innerText()).trim(), "Part of the Test Saga", "an optional entry has no number");
});

ui.test("watched shows on the franchise page, and Home offers the next one: Continue the franchise", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.film1.id, 60, 60);
  await signIn(me);
  await goto("#/");
  const row = page.locator('#app section.row[data-row-id="franchise"]');
  await row.waitFor({ timeout: 20000 });
  assert.match(await row.locator(".row-title, h2").first().innerText(), /Continue the franchise/);
  const labels = await row.locator(".card").evaluateAll((cs) => cs.map((c) => c.getAttribute("aria-label") || c.innerText));
  assert.equal(labels.length, 1);
  assert.match(labels[0], /Test Film Two/);
  if (process.env.FR_SHOTS) await row.scrollIntoViewIfNeeded();
  await shot(page, "desktop-3-home-row");
  await goto("#/franchise/test-saga");
  await page.locator(".fr-entries > .fr-entry").first().waitFor();
  const first = (await entries(page))[0];
  assert.equal(first.title, "Test Film One");
  assert.match(first.tags, /Watched/);
  assert.equal(await page.locator(".franchise-summary").innerText(), "3 films · 1 optional · 2 on the server · 1 watched");
});

for (const [tag, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`${tag}: the end of a film offers the next on the server — Play now, counting down; Dismiss stops it`, { viewport }, async ({ page, srv, signIn, freshProfile, lib }) => {
    const me = await freshProfile();
    await signIn(me);
    await player.open(page, srv, lib.film1.id);
    await player.jump(page, 40); // the last half minute (the film is a minute long)
    const card = page.locator(".player .franchise-next");
    await card.waitFor({ timeout: 20000 });
    const text = await card.innerText();
    assert.match(text, /Next in the Test Saga/i);
    assert.match(text, /Test Film Two · 2 of 3/);
    assert.match(await card.locator('[data-ui="player.franchise.play"]').innerText(), /Play now/);
    const dismiss = card.locator('[data-ui="player.franchise.dismiss"]');
    await page.waitForFunction(() => { const r = document.querySelector(".player .franchise-next .ring"); return r && Number(r.textContent) < 15; });
    await assertNoHorizontalOverflow(page, "the end card");
    await shot(page, `${tag}-4-end-card-countdown`);
    await dismiss.click();
    await card.waitFor({ state: "detached" });
    await page.waitForTimeout(1500);
    assert.ok((await page.evaluate(() => location.hash)).includes(lib.film1.id), "nothing started after Dismiss");
  });
}

ui.test("the countdown plays the next film by itself; Play now does it at once", async ({ page, srv, signIn, freshProfile, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await player.open(page, srv, lib.film1.id);
  await player.jump(page, 36);
  await page.locator(".player .franchise-next").waitFor({ timeout: 20000 });
  await page.waitForFunction((id) => location.hash === `#/play/${id}`, lib.film2.id, { timeout: 25000 });
  // and Play now, from the start of the next run
  await player.open(page, srv, lib.film1.id);
  await player.jump(page, 40);
  await page.locator(".player .franchise-next").waitFor({ timeout: 20000 });
  await page.locator('[data-ui="player.franchise.play"]').click();
  await page.waitForFunction((id) => location.hash === `#/play/${id}`, lib.film2.id);
});

ui.test("not on the server: Save & watch, no countdown — its page saves the ★ Best once, and only once", async ({ page, srv, signIn, freshProfile, api, lib, goto }) => {
  const me = await freshProfile();
  await api.post(`/api/franchises/test-saga/order`, { profile: me.id, order: "story" });
  const posted = await stageFilm3(page);
  await signIn(me);
  await player.open(page, srv, lib.film1.id);
  await player.jump(page, 40);
  const card = page.locator(".player .franchise-next");
  await card.waitFor({ timeout: 20000 });
  assert.match(await card.innerText(), /Test Film Three · 3 of 3/);
  assert.equal(await card.locator(".ring").innerText().catch(() => ""), "", "no countdown");
  await shot(page, "desktop-5-end-card-save");
  await card.locator('[data-ui="player.franchise.save"]').click();
  await page.waitForFunction((id) => location.hash === `#/discover/movie/${id}?save=1`, FILM3);
  for (let i = 0; i < 100 && !posted.length; i++) await page.waitForTimeout(100);
  assert.equal(posted.length, 1, "Save & watch was pressed for the person, once");
  assert.equal(posted[0].infoHash, H("a"));
  await page.waitForFunction(() => /Queued|Starting|Waiting|Downloading/.test((document.querySelector('[data-ui="detail.save"]') || {}).innerText || ""));
  // Back and forward again, a reload: never a second time
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#app .screen .detail-title"));
  await page.waitForTimeout(1500);
  assert.equal(posted.length, 1, "a reload does not press it again");
});

ui.test("the franchise page's Save & watch goes through the film's own page", async ({ page, signIn, freshProfile, goto }) => {
  const me = await freshProfile();
  const posted = await stageFilm3(page);
  await signIn(me);
  await goto("#/franchise/test-saga");
  await page.locator('[data-ui="franchise.save"]').click();
  await page.waitForFunction((id) => location.hash === `#/discover/movie/${id}?save=1`, FILM3);
  for (let i = 0; i < 100 && !posted.length; i++) await page.waitForTimeout(100);
  assert.equal(posted.length, 1);
});

ui.test("a kids profile's franchise page lists only what it may see", async ({ page, signIn, freshProfile, goto }) => {
  const kid = await freshProfile({ kids: { maxAge: 12 } });
  await signIn(kid);
  await goto("#/franchise/test-saga");
  await page.locator(".fr-entries > .fr-entry").first().waitFor();
  const titles = (await entries(page)).map((e) => e.title);
  assert.deepEqual(titles, ["Test Film One", "Test Show", "Test Film Three"], "Test Film Two is 18+");
  assert.equal(await page.locator(".franchise-summary").isVisible(), false);
});

ui.test("a franchise that does not exist says so", { allow: [/Failed to load resource.*404/] }, async ({ page, signIn, freshProfile, goto }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/franchise/no-such-one");
  await page.locator(".franchise-page .empty").waitFor();
  assert.match(await page.locator(".franchise-page .empty").innerText(), /That franchise isn't on this server/);
});

ui.run({ concurrency: 2 });
