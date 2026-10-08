// Title pages: a film's Play / Resume states, a show's episode list and the
// states of its episode cards, X-Ray with no network, Follow.
const assert = require("node:assert/strict");
const { suite, waitForScreen, IDS } = require("./helpers");

const ui = suite();

const primary = ".detail-actions > .btn-primary";
const playing = (page) =>
  page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.3; }, null, { timeout: 20000 });

ui.test("a film nobody has started offers Play, and Play opens the player", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto(`#/movie/${lib.film1.id}`);
  assert.equal(await page.textContent(".detail-title"), "Test Film One");
  assert.match(await page.textContent(".detail-meta"), /2020/);
  assert.equal((await page.textContent(primary)).trim(), "Play");
  assert.equal(await page.locator('.detail-actions button:has-text("Start over")').count(), 0);
  assert.match(await page.textContent(".detail-server"), /On disk/);

  await page.click(primary);
  await page.waitForFunction((id) => location.hash === `#/play/${id}`, lib.film1.id);
  await playing(page);
});

ui.test("a film left part-way offers Resume at that time, and Start over really starts over", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.film1.id, 30, 60);
  await signIn(me);
  await goto(`#/movie/${lib.film1.id}`);
  assert.equal((await page.textContent(primary)).trim(), "Resume 0:30");
  const over = page.locator('.detail-actions button:has-text("Start over")');
  await over.click();
  await page.waitForFunction((id) => location.hash === `#/play/${id}?restart=1`, lib.film1.id);
  await playing(page);
  const at = await page.evaluate(() => document.querySelector(".player video").currentTime);
  assert.ok(at < 8, `"Start over" began at ${at}s, not at the top`);
});

ui.test("a finished film is marked watched, and the mark can be taken off", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.film1.id, 59, 60);
  await signIn(me);
  await goto(`#/movie/${lib.film1.id}`);
  assert.equal((await page.textContent(primary)).trim(), "Play", "a finished film plays from the top, it does not resume");
  const mark = page.locator('.detail-actions button[aria-label="Toggle watched"]');
  assert.equal(await mark.getAttribute("title"), "Mark unwatched");
  await mark.click();
  // (the page repaints its actions: wait for the new button, not the old node)
  await page.waitForFunction(() => { const b = document.querySelector('.detail-actions button[aria-label="Toggle watched"]'); return !!b && b.title === "Mark watched"; });
  const progress = (await api.state(me)).progress[lib.film1.id];
  assert.ok(!progress || !progress.finished, "the server still has it as watched");
});

ui.test("a show lists its season's episodes, and an episode opens in the player", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto(`#/show/${lib.show.id}`, { selector: "#app .screen .episode-list .episode" });
  assert.equal(await page.textContent(".detail-title"), "Test Show");
  assert.match(await page.textContent(".detail-meta"), /1 season/);
  const rows = await page.evaluate(() => [...document.querySelectorAll(".episode-list .episode")].map((e) => ({
    ep: e.dataset.ep,
    name: e.querySelector(".episode-name").textContent,
    owned: e.classList.contains("owned"),
    cc: [...e.querySelectorAll(".badge")].some((b) => b.textContent === "CC"),
    watched: [...e.querySelectorAll(".badge")].some((b) => b.textContent === "Watched"),
  })));
  assert.deepEqual(rows, [
    // (the three are on disk; "owned" is the card's own class for that)
    { ep: "1x1", name: "Episode 1", owned: true, cc: true, watched: false },
    { ep: "1x2", name: "Episode 2", owned: true, cc: true, watched: false },
    { ep: "1x3", name: "Episode 3", owned: true, cc: true, watched: false },
  ]);
  assert.equal((await page.textContent(primary)).trim(), "Play");

  // the hero's Play starts the first episode
  await page.click(primary);
  await page.waitForFunction((id) => location.hash === `#/play/${id}`, lib.e1.id);
  await playing(page);
  assert.match(await page.textContent(".player-subtitle"), /S1 E1/);
});

ui.test("the card of a downloaded 1080p episode plays it", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto(`#/show/${lib.show.id}`, { selector: "#app .screen .episode-list .episode" });
  await page.locator(".detail-actions .btn-xray").waitFor(); // the page has settled (the show's id is in)
  await page.click('.episode-list .episode[data-ep="1x3"]');
  await page.waitForFunction((id) => location.hash === `#/play/${id}`, lib.e3.id);
  await playing(page);
  assert.match(await page.textContent(".player-subtitle"), /S1 E3/);
});

// APPLICATION BUG (reported, not fixed here). A downloaded episode below
// 1080p opens its sources list instead of playing, "where your copy sits
// first". When the source provider cannot be reached, loadSources' catch
// branch (public/js/screens/discover-detail.js, "Couldn't reach the source
// provider.") drops the owned row: the card of an episode that is on disk
// offers nothing to play. The success and the empty branches both keep it.
ui.test("the card of a downloaded episode below 1080p still offers the copy on disk when the source provider is down", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto(`#/show/${lib.show.id}`, { selector: "#app .screen .episode-list .episode" });
  await page.locator(".detail-actions .btn-xray").waitFor();
  await page.click('.episode-list .episode[data-ep="1x2"]');
  await page.waitForFunction(() => /Sources · S1 E2/.test(document.querySelector("#app .screen").innerText));
  await page.waitForFunction(() => /Couldn't reach the source provider|No other sources/.test(document.querySelector("#app .screen").innerText));
  await page.waitForFunction(() => /in your library/i.test(document.querySelector("#app .screen").innerText), null, { timeout: 3000 });
});

ui.test("episode cards show watched, in-progress and up-next; the hero continues where you are", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.e1.id, 44, 45); // finished
  await api.setProgress(me, lib.e2.id, 15, 45); // a third of the way in
  await signIn(me);
  await goto(`#/show/${lib.show.id}`, { selector: "#app .screen .episode-list .episode" });

  const row = (n) => page.locator(`.episode-wrap:has(.episode[data-ep="1x${n}"])`);
  await row(1).locator('.badge:text-is("Watched")').waitFor();
  assert.equal(await row(1).locator('.ep-action[aria-label="Mark unwatched"]').count(), 1);
  assert.equal(await row(1).locator(".episode-bar").count(), 0, "a watched episode shows no progress bar");

  const width = await row(2).locator(".episode-bar > div").evaluate((d) => parseFloat(d.style.width));
  assert.ok(width > 25 && width < 42, `episode 2's bar is ${width}% wide, expected about a third`);
  assert.equal(await row(2).locator(".ep-up-next").count(), 1, "the episode you are on is tagged UP NEXT");
  assert.equal(await row(3).locator(".badge:text-is('Watched')").count(), 0);

  assert.match((await page.textContent(primary)).trim(), /^Continue S1 E2 · 0:15$/);
});

ui.test("Mark watched on an episode sticks: the card, the server, and after a reload", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto(`#/show/${lib.show.id}`, { selector: "#app .screen .episode-list .episode" });
  const row3 = page.locator('.episode-wrap:has(.episode[data-ep="1x3"])');
  await row3.locator('.ep-action[aria-label="Mark watched"]').click();
  await row3.locator('.badge:text-is("Watched")').waitFor();
  await row3.locator('.ep-action[aria-label="Mark unwatched"]').waitFor();
  const p = (await api.state(me)).progress[lib.e3.id];
  assert.ok(p && p.finished, "the server does not have episode 3 as watched");

  await page.reload();
  await waitForScreen(page, { selector: "#app .screen .episode-list .episode" });
  await page.locator('.episode-wrap:has(.episode[data-ep="1x3"]) .badge:text-is("Watched")').waitFor();

  await page.locator('.episode-wrap:has(.episode[data-ep="1x3"]) .ep-action[aria-label="Mark unwatched"]').click();
  await page.locator('.episode-wrap:has(.episode[data-ep="1x3"]) .ep-action[aria-label="Mark watched"]').waitFor();
});

for (const [what, hash, sub] of [
  ["a film", (lib) => `#/movie/${lib.film1.id}`, null],
  ["a show", (lib) => `#/show/${lib.show.id}`, "the whole series"],
]) {
  ui.test(`X-Ray on ${what} opens with nothing known (no network) and closes again`, async ({ page, goto, signIn, freshProfile, lib }) => {
    await signIn(await freshProfile());
    await goto(hash(lib));
    const btn = page.locator(".detail-actions .btn-xray");
    await btn.waitFor(); // it appears once the title's IMDb id is known
    assert.equal(await btn.getAttribute("aria-pressed"), "false");

    await btn.click();
    const panel = page.locator(".xray-panel");
    await panel.waitFor();
    assert.equal(await btn.getAttribute("aria-pressed"), "true");
    // The lookup has nowhere to go. The panel has to settle on its "nothing
    // known" line: not a spinner that never ends, not an exception.
    await panel.locator(".xr-empty").waitFor();
    assert.equal(await panel.locator(".xr-loading").count(), 0);
    if (sub) assert.equal(await panel.locator(".xr-sub").textContent(), sub);

    await panel.locator(".xr-close").click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await btn.getAttribute("aria-pressed"), "false");

    // and the Back key closes it too, without leaving the page
    await btn.click();
    await panel.waitFor();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => location.hash), hash(lib));
    assert.equal(await page.locator("#app .screen.xray-on").count(), 0);
  });
}

ui.test("Follow is offered on a show, toggles, and persists on the profile", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto(`#/show/${lib.show.id}`);
  const follow = page.locator(".detail-actions .btn-follow");
  await follow.waitFor();
  assert.equal((await follow.textContent()).trim(), "Follow");
  assert.equal(await follow.getAttribute("aria-pressed"), "false");

  await follow.click();
  await page.waitForFunction(() => document.querySelector(".btn-follow").getAttribute("aria-pressed") === "true");
  assert.equal((await follow.textContent()).trim(), "Following");
  await page.waitForFunction(() => /Following Test Show/.test(document.getElementById("toasts").innerText));
  assert.deepEqual((await api.profile(me.id)).follows, [IDS.show]);

  await page.reload();
  await waitForScreen(page);
  await page.waitForFunction(() => { const b = document.querySelector(".btn-follow"); return b && b.getAttribute("aria-pressed") === "true"; });

  await page.locator(".detail-actions .btn-follow").click();
  await page.waitForFunction(() => document.querySelector(".btn-follow").getAttribute("aria-pressed") === "false");
  assert.deepEqual((await api.profile(me.id)).follows, []);
});

ui.test("a film has no Follow button", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto(`#/movie/${lib.film2.id}`);
  await page.locator(".detail-actions .btn-xray").waitFor(); // the late buttons are in
  assert.equal(await page.locator(".btn-follow").count(), 0);
});

ui.test("a rating given on the title page is kept", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto(`#/movie/${lib.film2.id}`);
  await page.click('.star-rating .star[aria-label="4 stars"]');
  await page.waitForFunction(() => document.querySelectorAll(".star-rating .star.on").length === 4);
  const { ratings } = await api.state(me);
  assert.deepEqual(Object.values(ratings), [4]);
  await page.reload();
  await waitForScreen(page);
  await page.waitForFunction(() => document.querySelectorAll(".star-rating .star.on").length === 4);
});

ui.run({ concurrency: 4 });
