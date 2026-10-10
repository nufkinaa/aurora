// The person sheet (public/js/personSheet.js): press an actor or a director —
// in X-Ray on a title page, in X-Ray over a film, in a title page's cast line
// — and their photos and titles open on top of what is there, instead of the
// jump to Search this used to be. A press on a title puts it on My List, a
// second press takes it off, Details is the title's page.
//
// The private instance has no network, so the people are seeded where the
// server keeps them (data/cache/xray.json, person.json, person-titles.json —
// the shapes src/media/xray.js and person.js write): the SERVER answers
// /api/person from its cache, with its real per-profile marks and its real
// kids gate. Only pictures are answered by the browser stub (a 1×1 PNG).
//
//   Nora Chris (tmdb:525), a director:
//     Directed   Test Film One (in the library, all ages) · Test Film Two (in
//                the library, 18+) · Stars Between (not in the library, 6+)
//     Created    Test Show (in the library, 7+)
//     Appears in Unrated Thing (no age rating)
//   Ada Actor (tmdb:600): nobody the server knows — it has no key to ask with.
const assert = require("node:assert/strict");
const { suite, player, assertNoHorizontalOverflow, IDS, PHONE } = require("./helpers");
const { seed, STARS } = require("./support/person-seed");

const ui = suite({ server: { seed: seed() } });

// a 1×1 PNG for every proxied picture (the portraits): the instance cannot fetch them
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const pictures = (page) => page.route("**/img/ext**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));

const sheet = ".person-wrap .person-sheet";
const titleCard = (page, title) => page.locator(`${sheet} .pt:has(.pt-title:text-is("${title}"))`);
const titles = (page) => page.evaluate(() => [...document.querySelectorAll(".person-wrap .person-section")].map((s) => `${s.querySelector("h3").childNodes[0].textContent}: ${[...s.querySelectorAll(".pt-title")].map((t) => t.textContent).join(", ")}`));
const listed = async (api, me) => (await api.get(`/api/profiles/${me.id}/watchlist`, await api.as(me))).items.map((i) => i.imdbId || i.id);
const toastSays = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("toasts").innerText), re.source);
const openXrayOnFilm = async ({ page, goto, lib }) => {
  await goto(`#/movie/${lib.film1.id}`);
  await page.locator(".detail-actions .btn-xray").click();
  await page.locator('.xray-panel .xr-person:has(.xr-name:text-is("Nora Chris"))').first().waitFor();
};
const pressPerson = (page, name, role) =>
  page.locator(`.xray-panel .xr-person:has(.xr-name:text-is("${name}"))${role ? `:has(.xr-role:text-is("${role}"))` : ""}`).first().click();

ui.test("X-Ray → press a person → their sheet, titles by department; press a title → on My List; press again → off; Escape closes the sheet, then X-Ray", async (h) => {
  const { page, signIn, freshProfile, api, lib } = h;
  const me = await freshProfile();
  await signIn(me);
  await pictures(page);
  await openXrayOnFilm(h);
  const hashBefore = await page.evaluate(() => location.hash);

  await pressPerson(page, "Nora Chris", "Director");
  await page.locator(`${sheet} .person-section`).first().waitFor();
  assert.equal(await page.evaluate(() => location.hash), hashBefore, "a press on a person no longer jumps to Search");
  assert.equal(await page.locator(`${sheet} .person-name`).textContent(), "Nora Chris");
  assert.match(await page.locator(`${sheet} .person-sub`).textContent(), /Director · born 1970/);
  assert.equal(await page.locator(sheet).getAttribute("aria-modal"), "true");
  // what the household can play leads its group; the director's own department leads the sheet
  assert.deepEqual(await titles(page), [
    "Directed: Test Film One, Test Film Two, Stars Between",
    "Created: Test Show",
    "Appears in: Unrated Thing",
  ]);
  assert.equal(await titleCard(page, "Test Film One").locator(".pt-flag").textContent(), "In library");
  assert.equal(await titleCard(page, "Stars Between").locator(".pt-flag").isVisible(), false);
  assert.match(await titleCard(page, "Stars Between").locator(".pt-sub").textContent(), /2014 · Director · Writer/);
  assert.match(await page.locator(`${sheet} .person-how`).textContent(), /Press a title to put it on My List — press again to take it off/);
  assert.match(await page.locator(`${sheet} .person-bio`).textContent(), /filmmaker/);
  // the IMDb reference: the photos are not IMDb's, the page is one link away
  assert.equal(await page.locator(`${sheet} .person-imdb`).getAttribute("href"), "https://www.imdb.com/name/nm0634240/");
  assert.equal(await page.locator(`${sheet} .person-photo`).count(), 3);

  // a press adds…
  const stars = titleCard(page, "Stars Between");
  const card = stars.locator(".pt-card");
  assert.equal(await card.getAttribute("aria-pressed"), "false");
  assert.match(await card.getAttribute("aria-label"), /Press to add it to My List/);
  await card.click();
  await page.waitForFunction(() => document.querySelector('.person-wrap .pt.listed .pt-title')?.textContent === "Stars Between");
  assert.equal(await card.getAttribute("aria-pressed"), "true");
  await toastSays(page, /Stars Between: Added to My List/);
  assert.equal(await page.locator('#toasts .toast-act:text-is("Undo")').count(), 1, "the toast carries Undo");
  await page.waitForFunction(() => !document.querySelector(".person-wrap .pt.busy"));
  assert.deepEqual(await listed(api, me), [STARS]);
  // …it is a real My List entry, with what the list's filters need
  const entry = (await api.get(`/api/profiles/${me.id}/watchlist`, await api.as(me))).items[0];
  assert.deepEqual({ title: entry.title, type: entry.type, year: entry.year, genres: entry.genres }, { title: "Stars Between", type: "movie", year: 2014, genres: ["Sci-Fi", "Adventure"] });

  // …a second press takes it off again
  await card.click();
  await page.waitForFunction(() => !document.querySelector(".person-wrap .pt.listed"));
  await toastSays(page, /Stars Between: removed from My List/);
  await page.waitForFunction(() => !document.querySelector(".person-wrap .pt.busy"));
  assert.deepEqual(await listed(api, me), []);

  // the keyboard: Enter on a focused card is the same press
  await card.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !!document.querySelector(".person-wrap .pt.listed") && !document.querySelector(".person-wrap .pt.busy"));
  assert.deepEqual(await listed(api, me), [STARS]);
  // Tab never leaves the sheet
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement.closest(".person-wrap")), true, "Tab left the sheet");
  }

  // Escape: the sheet goes, X-Ray stays, focus is back on the person pressed
  await page.keyboard.press("Escape");
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  assert.equal(await page.locator(".xray-panel").count(), 1, "X-Ray closed with the sheet");
  assert.equal(await page.evaluate(() => document.activeElement.querySelector(".xr-name")?.textContent), "Nora Chris");
  assert.equal(await page.evaluate(() => location.hash), hashBefore);
  // Escape again: X-Ray, and still the same page
  await page.keyboard.press("Escape");
  await page.locator(".xray-panel").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => location.hash), hashBefore);
  // the sheet's history entry is gone: one Back leaves the title page
  await page.waitForTimeout(150);
  await page.goBack();
  await page.waitForFunction((b) => location.hash !== b, hashBefore);
});

ui.test("the toast says when the add started a download, the card says Downloading, and Undo takes the title off the list again", async (h) => {
  const { page, signIn, freshProfile, api } = h;
  const me = await freshProfile();
  await signIn(me);
  // (the instance cannot download: the server's answer to the add is made up
  // here, as in library.test.js — what is tested is what the sheet does with it)
  await page.route("**/api/profiles/*/watchlist", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    if (JSON.parse(route.request().postData() || "{}").add) body.download = { queued: true, what: "film" };
    await route.fulfill({ json: body });
  });
  await openXrayOnFilm(h);
  await pressPerson(page, "Nora Chris", "Director");
  const stars = titleCard(page, "Stars Between");
  await stars.locator(".pt-card").click();
  await toastSays(page, /Stars Between: Added to My List — downloading the film/);
  await page.waitForFunction(() => document.querySelector(".person-wrap .pt.listed .pt-flag")?.textContent === "Downloading");
  assert.match(await stars.locator(".pt-card").getAttribute("aria-label"), /downloading\. On My List: press to take it off/);
  assert.deepEqual(await listed(api, me), [STARS]);

  await page.locator('#toasts .toast-act:text-is("Undo")').click();
  await page.waitForFunction(() => !document.querySelector(".person-wrap .pt.listed") && !document.querySelector(".person-wrap .pt.busy"));
  assert.equal(await stars.locator(".pt-flag").isVisible(), false, "the Downloading mark stayed after the undo");
  assert.deepEqual(await listed(api, me), []);
});

ui.test("the title page's own My List button follows a press made in the sheet", async (h) => {
  const { page, signIn, freshProfile } = h;
  await signIn(await freshProfile());
  await openXrayOnFilm(h);
  const mine = page.locator(".detail-actions button:has(span:text-is('My List'))");
  const mineOn = page.locator(".detail-actions button:has(span:text-is('In My List'))");
  await mine.waitFor();
  await pressPerson(page, "Nora Chris", "Director");
  await titleCard(page, "Test Film One").locator(".pt-card").click();
  await mineOn.waitFor();
  await titleCard(page, "Test Film One").locator(".pt-card").click();
  await mine.waitFor();
});

ui.test("Details opens the title's page (button, the I key, a right-click) — and Back from it returns to where the sheet was opened", async (h) => {
  const { page, signIn, freshProfile, api, lib } = h;
  const me = await freshProfile();
  await signIn(me);
  // (the catalogue page of a title that is not in the library needs its
  // metadata, which this instance cannot fetch — without it that page gives
  // up and goes back by itself; a minimal answer lets it stand)
  await page.route(`**/api/discover/meta/movie/${STARS}`, (route) => route.fulfill({ json: { imdbId: STARS, type: "movie", title: "Stars Between", year: 2014, synopsis: "A film.", genres: ["Sci-Fi"] } }));
  await openXrayOnFilm(h);
  const from = `#/movie/${lib.film1.id}`;
  const there = (hash) => page.waitForFunction((x) => location.hash === x, hash);
  const backToSheet = async () => {
    await page.goBack();
    await there(from);
    await page.locator(".detail-actions .btn-xray").waitFor();
    await page.locator(".person-wrap").waitFor({ state: "detached" }); // (it fades for a fifth of a second)
    if (!(await page.locator(".xray-panel").count())) await page.locator(".detail-actions .btn-xray").click();
    await pressPerson(page, "Nora Chris", "Director");
    await page.locator(`${sheet} .person-section`).first().waitFor();
  };

  await pressPerson(page, "Nora Chris", "Director");
  // a title that is not in the library: its catalogue page
  await titleCard(page, "Stars Between").locator(".pt-more").click();
  await there(`#/discover/movie/${STARS}`);
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector("#app .screen .detail-title")?.textContent === "Stars Between");
  await backToSheet();
  // a title in the library: its library page — by the keyboard
  await titleCard(page, "Test Show").locator(".pt-card").focus();
  await page.keyboard.press("i");
  await there(`#/show/${lib.show.id}`);
  await backToSheet();
  // …and a right-click (a hold, on a touch screen) is Details too, never an add
  await titleCard(page, "Test Film Two").locator(".pt-card").click({ button: "right" });
  await there(`#/movie/${lib.film2.id}`);
  assert.deepEqual(await listed(api, me), [], "opening a title's page must not put it on the list");
});

ui.test("a photo enlarges inside the sheet; arrows step through; Escape closes the photo, then the sheet", async (h) => {
  const { page, signIn, freshProfile } = h;
  await signIn(await freshProfile());
  await pictures(page);
  await openXrayOnFilm(h);
  await pressPerson(page, "Nora Chris", "Director");
  // no layout shift: the strip is as tall with its placeholders as with its photos
  const strip = page.locator(`${sheet} .person-photos`);
  await page.locator(`${sheet} .person-photo.in`).first().waitFor();
  const height = (await strip.boundingBox()).height;
  assert.ok(height > 100, `the photo strip is ${height}px tall`);
  await page.locator(`${sheet} .person-photo`).nth(0).click();
  const viewer = page.locator(`${sheet} .person-viewer`);
  await viewer.waitFor();
  assert.equal(await viewer.locator(".person-viewer-count").textContent(), "1 / 3");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".person-viewer-count")?.textContent === "2 / 3");
  await viewer.locator(".person-viewer-nav.next").click();
  await page.waitForFunction(() => document.querySelector(".person-viewer-count")?.textContent === "3 / 3");
  assert.equal(await viewer.locator(".person-viewer-nav.next").isDisabled(), true);
  // the sharp picture is asked for through the server's image proxy, sized
  await page.waitForFunction(() => [...document.querySelectorAll(".person-viewer-slide img")].some((i) => /^\/img\/ext\?u=.*original.*&w=960$/.test(i.getAttribute("src"))));
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  assert.equal(await page.locator(sheet).count(), 1, "Escape on the photo closed the whole sheet");
  await page.keyboard.press("Escape");
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  assert.equal(await page.locator(".xray-panel").count(), 1);
});

ui.test("a title page's cast line: each name opens that person's sheet (the director too), found by name through the title", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  // (the instance has no catalogue: the page's metadata — where the cast line
  // comes from — is answered here; the person is the server's own answer)
  await page.route("**/api/discover/meta/**", (route) => route.fulfill({ json: {
    imdbId: IDS.film1, type: "movie", title: "Test Film One", year: 2020, synopsis: "A test.", cast: ["Ada Actor", "Nora Chris"], director: "Nora Chris", genres: ["Drama"],
  } }));
  const hash = `#/movie/${lib.film1.id}`;
  await goto(hash);
  const line = page.locator(".detail-cast");
  await line.waitFor();
  assert.match(await line.textContent(), /Cast Ada Actor · Nora Chris/);
  assert.match(await line.textContent(), /Director Nora Chris/);
  assert.doesNotMatch(await page.textContent(".detail-meta"), /Dir\./, "the director is in the cast line now, once");
  await line.locator('.cast-group:has(.cast-label:text-is("Director ")) .cast-name').click();
  await page.locator(`${sheet} .person-section`).first().waitFor();
  assert.equal(await page.evaluate(() => location.hash), hash);
  assert.equal(await page.locator(`${sheet} .person-name`).textContent(), "Nora Chris");
  assert.equal((await titles(page))[0], "Directed: Test Film One, Test Film Two, Stars Between");
  await page.locator(`${sheet} .person-close`).click();
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("cast-name")), true, "focus returns to the name pressed");
});

ui.test("someone the server cannot look up: the sheet says so and offers the old way (Search), instead of a spinner", { allow: [/Failed to load resource.*\/api\/person\//] }, async (h) => {
  const { page, signIn, freshProfile } = h;
  await signIn(await freshProfile());
  await openXrayOnFilm(h);
  await pressPerson(page, "Ada Actor");
  const empty = page.locator(`${sheet} .xr-empty`);
  await empty.waitFor();
  assert.match(await empty.textContent(), /can't look people up yet/);
  assert.equal(await page.locator(`${sheet} .skeleton`).count(), 0, "a placeholder was left behind");
  await empty.locator('button:has-text("Search for Ada Actor")').click();
  await page.waitForFunction(() => location.hash === "#/search" || location.hash.startsWith("#/search/"));
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  assert.equal(await page.inputValue('.screen input[type="search"], .screen input[type="text"]'), "Ada Actor");
});

ui.test("phone: the sheet rises over X-Ray's own sheet, fits the screen, and the Back gesture closes the top layer only", { viewport: PHONE }, async (h) => {
  const { page, goto, signIn, freshProfile, api, lib } = h;
  const me = await freshProfile();
  await signIn(me);
  await pictures(page);
  const hash = `#/movie/${lib.film1.id}`;
  await goto(hash);
  await page.locator(".detail-actions .btn-xray").click();
  await page.locator(".xray-sheet-page.in").waitFor();
  await page.locator('.xray-sheet-page .xr-person:has(.xr-name:text-is("Nora Chris"))').first().tap();
  await page.locator(`${sheet} .person-section`).first().waitFor();
  await page.waitForFunction(() => document.querySelector(".person-wrap .person-sheet").getAnimations().every((a) => a.playState === "finished")); // risen
  await assertNoHorizontalOverflow(page, "the person sheet on a phone");
  // a bottom sheet: full width, flush with the foot of the screen, over X-Ray
  const box = await page.locator(sheet).boundingBox();
  assert.equal(Math.round(box.width), PHONE.width);
  assert.ok(Math.abs(box.y + box.height - PHONE.height) <= 1, `the sheet ends at ${box.y + box.height}, the screen at ${PHONE.height}`);
  assert.ok(box.y >= 40, "the sheet leaves the top of the screen clear");
  assert.equal(await page.evaluate(() => {
    const r = document.querySelector(".person-wrap .person-close").getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).classList.contains("person-close");
  }), true, "X-Ray's sheet is drawn over the person sheet");
  // three posters a row, each wide enough to read
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector(".person-wrap .person-grid")).gridTemplateColumns.split(" ").length);
  assert.equal(cols, 3);
  // the sheet scrolls by itself; the page under it does not move
  const y0 = await page.evaluate(() => window.scrollY + document.body.scrollTop);
  await page.locator(`${sheet} .person-body`).evaluate((b) => { b.scrollTop = 400; });
  assert.ok(await page.locator(`${sheet} .person-body`).evaluate((b) => b.scrollTop) > 0, "the sheet's own list scrolls");
  assert.equal(await page.evaluate(() => window.scrollY + document.body.scrollTop), y0);
  assert.match(await page.locator(`${sheet} .person-how`).textContent(), /Hold one, or tap Details, for its page/);

  // a tap adds, a tap removes
  const card = titleCard(page, "Stars Between").locator(".pt-card");
  await card.tap();
  await page.waitForFunction(() => !!document.querySelector(".person-wrap .pt.listed") && !document.querySelector(".person-wrap .pt.busy"));
  assert.deepEqual(await listed(api, me), [STARS]);
  await card.tap();
  await page.waitForFunction(() => !document.querySelector(".person-wrap .pt.listed") && !document.querySelector(".person-wrap .pt.busy"));

  // an enlarged photo, then Back three times: the photo, the sheet, and only then the page
  await page.locator(`${sheet} .person-photo`).first().tap();
  await page.locator(`${sheet} .person-viewer`).waitFor();
  await page.goBack();
  await page.locator(`${sheet} .person-viewer`).waitFor({ state: "detached" });
  assert.equal(await page.locator(sheet).count(), 1);
  await page.goBack();
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  assert.equal(await page.locator(".xray-sheet-page").count(), 1, "Back closed X-Ray together with the person sheet");
  assert.equal(await page.evaluate(() => location.hash), hash);
});

ui.test("over a film: the sheet opens on top of X-Ray, the film stays paused under it, Escape peels one layer at a time and the film resumes", async (h) => {
  const { page, srv, signIn, freshProfile, api, lib } = h;
  const me = await freshProfile();
  await signIn(me);
  await player.open(page, srv, lib.film1.id);
  await player.press(page, "X-Ray");
  await page.locator('.player .xray-sheet .xr-person:has(.xr-name:text-is("Nora Chris"))').first().waitFor();
  assert.equal((await player.state(page)).paused, true, "X-Ray pauses the film");
  const hash = await page.evaluate(() => location.hash);

  await page.locator('.player .xray-sheet .xr-person:has(.xr-name:text-is("Nora Chris"))').first().click();
  await page.locator(`${sheet} .person-section`).first().waitFor();
  assert.equal(await page.evaluate(() => location.hash), hash, "the press left the player");
  assert.equal((await player.state(page)).paused, true);
  assert.equal(await page.locator(`${sheet} .person-imdb`).count(), 0, "nothing links out of the app over a film");
  assert.equal(await titleCard(page, "Stars Between").locator(".pt-more").getAttribute("title"), "Open its page (leaves the film)");
  // the sheet is the top layer: its close button is what a click there reaches
  assert.equal(await page.evaluate(() => {
    const r = document.querySelector(".person-wrap .person-close").getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).classList.contains("person-close");
  }), true);

  await titleCard(page, "Stars Between").locator(".pt-card").click();
  await page.waitForFunction(() => !!document.querySelector(".person-wrap .pt.listed") && !document.querySelector(".person-wrap .pt.busy"));
  assert.deepEqual(await listed(api, me), [STARS]);
  assert.equal((await player.state(page)).paused, true, "adding a title must not touch the film");

  await page.keyboard.press("Escape");
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  assert.equal(await page.locator(".player .xray-sheet").count(), 1, "Escape closed X-Ray together with the sheet");
  assert.equal((await player.state(page)).paused, true, "the film resumed while X-Ray is still open");
  assert.equal(await page.evaluate(() => location.hash), hash);
  await page.keyboard.press("Escape");
  await page.locator(".player .xray-sheet").waitFor({ state: "detached" });
  await player.playing(page, { id: lib.film1.id });
});

ui.test("over a FULLSCREEN film the sheet is inside the fullscreen element (visible), and says what a press did inside itself", async (h) => {
  const { page, srv, signIn, freshProfile, lib, t } = h;
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  await player.press(page, "Fullscreen");
  const full = await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 4000 }).then(() => true, () => false);
  if (!full) return t.skip("this browser refused element fullscreen");
  await player.press(page, "X-Ray");
  await page.locator('.player .xray-sheet .xr-person:has(.xr-name:text-is("Nora Chris"))').first().click();
  await page.locator(`${sheet} .person-section`).first().waitFor();
  assert.equal(await page.evaluate(() => !!document.fullscreenElement && document.fullscreenElement.contains(document.querySelector(".person-wrap"))), true,
    "an overlay outside the fullscreen element is not drawn");
  assert.equal(await page.locator(sheet).isVisible(), true);
  // toasts live outside the fullscreen element: the sheet says it itself
  await titleCard(page, "Stars Between").locator(".pt-card").click();
  await page.waitForFunction(() => /Stars Between: Added to My List/.test(document.querySelector(".person-wrap .person-status.on")?.textContent || ""));
  await page.locator('.person-status .toast-act:text-is("Undo")').click();
  await page.waitForFunction(() => !document.querySelector(".person-wrap .pt.listed") && !document.querySelector(".person-wrap .pt.busy"));
  await page.keyboard.press("Escape");
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  assert.equal(await page.locator(".player .xray-sheet").count(), 1);
});

// LAST, and the file runs one test at a time: making a kids profile changes
// the household for everyone (see kids.test.js).
ui.test("a kids profile sees only the titles within its age — unrated ones hidden too — and no biography", async (h) => {
  const { page, signIn, api, t } = h;
  const status = await api.call("GET", "/api/kids/status");
  if (!(status.status === 200 && Array.isArray(status.body.ages))) return t.skip("this server has no kids profiles");
  const kid = await api.createProfile("Kiddo", { open: true });
  await api.adminPost(`/api/admin/profiles/${kid.id}/kids`, { kids: { maxAge: 7 } });
  kid.kids = { maxAge: 7 };
  await signIn(kid);
  await openXrayOnFilm(h);
  await pressPerson(page, "Nora Chris", "Director");
  await page.locator(`${sheet} .person-section`).first().waitFor();
  // Test Film Two (18+) and the unrated one are not there; 0, 6 and 7 are
  assert.deepEqual(await titles(page), ["Directed: Test Film One, Stars Between", "Created: Test Show"]);
  assert.equal(await page.locator(`${sheet} .person-bio`).isVisible(), false);
  // …and that is the server's doing, not the page's
  const direct = await api.get(`/api/person/tmdb:525?profile=${kid.id}`);
  assert.deepEqual(direct.credits.map((c) => c.title).sort(), ["Stars Between", "Test Film One", "Test Show"]);
  assert.equal(direct.bio, null);
  assert.equal(direct.kids, true);
  const grownUp = await api.get("/api/person/tmdb:525");
  assert.equal(grownUp.credits.length, 5);
});

ui.run({ concurrency: 1 });
