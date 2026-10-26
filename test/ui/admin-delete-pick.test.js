// "Suggest what to delete" as a list to choose from (admin → Downloads → On
// disk, elia 2026-10-26: "a place to SELECT what to delete from the
// suggestions"): a tick per item (all ticked at first), episodes under their
// show with a show tick that can be mixed, Select all / none, the live
// "N items · X GB will be freed", Delete selected with a confirm that names
// the count and the size, then what was deleted and what was kept, and the
// list refreshes. One being watched right now is greyed: "being watched".
//
// The first tests hand the page a made-up list (GET /api/admin/library/suggest)
// and catch the delete (POST …/suggest/delete), so every shape is on screen;
// the last one goes through the private instance's real library, real watch
// state, a real "playing" file and a real delete.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, PHONE } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    srv.profiles.anna = await srv.api.createProfile("Anna", { open: true });
  },
});

const SHOTS = process.env.FP_SHOTS || path.join(os.tmpdir(), "aurora-agents", "feat-admin-delete-pick", "shots");
const shot = async (page, name, opts = {}) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts });
};

const GB = 1024 ** 3;
const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const onDisk = async (page) => {
  await page.click('.tab[data-tab="downloads"]');
  await page.waitForSelector("#lib-tree .lib-row");
};
const toastSays = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll("#toasts .toast")].some((t) => new RegExp(src).test(t.textContent)), re.source);

// What the server would answer: a stale My List film, a finished film, a show
// with three finished episodes — one of them being watched right now.
const SHOW = { id: "s-fix", title: "Fixture Show", cover: null };
const fixture = () => ({
  items: [
    { id: "m-stale", kind: "movie", name: "Stale Film (2020)", title: "Stale Film", year: 2020, cover: null, sizeBytes: 4 * GB, reason: "mylist", why: "My List download — added to My List on 2026-09-20, never watched", inUse: false },
    { id: "e-1", kind: "episode", name: "Fixture Show S01E01", title: "Pilot", cover: null, show: SHOW, season: 1, episode: 1, sizeBytes: 1 * GB, reason: "finished", why: "Finished by 2 people, last watched 3 months ago · nobody is part-way through", inUse: false },
    { id: "m-done", kind: "movie", name: "Watched Film (2019)", title: "Watched Film", year: 2019, cover: null, sizeBytes: 2 * GB, reason: "finished", why: "Finished by 1 person, last watched 2 months ago · nobody is part-way through", inUse: false },
    { id: "e-2", kind: "episode", name: "Fixture Show S01E02", title: "Second", cover: null, show: SHOW, season: 1, episode: 2, sizeBytes: 1 * GB, reason: "finished", why: "Finished by 2 people, last watched 2 months ago · nobody is part-way through", inUse: false },
    { id: "e-3", kind: "episode", name: "Fixture Show S01E03", title: "Third", cover: null, show: SHOW, season: 1, episode: 3, sizeBytes: 1 * GB, reason: "finished", why: "Finished by 1 person, last watched 2 months ago · nobody is part-way through", inUse: true },
  ],
  totalBytes: 8 * GB, targetBytes: 20 * GB, short: true, availableBytes: 8 * GB, available: 4,
});
// The page asks for the list; after a delete it asks again (the refresh).
const stubList = async (page, lists) => {
  const asked = [];
  await page.route((url) => url.pathname === "/api/admin/library/suggest", (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("gb"));
    const body = lists[Math.min(asked.length - 1, lists.length - 1)];
    return route.fulfill({ json: body });
  });
  return asked;
};
const total = (page) => page.locator("#fp-total").innerText();
const box = (page, id) => page.locator(`#fp-list .fp-check[data-id="${id}"]`);
const showBox = (page) => page.locator(`#fp-list .fp-show-check[data-show="${SHOW.id}"]`);
const showState = (page) => showBox(page).evaluate((b) => ({ checked: b.checked, mixed: b.indeterminate }));

ui.test("the suggestions are a list to tick: all ticked, the show tick follows its episodes (mixed), Select none / all, the live total", async ({ page, srv }) => {
  const asked = await stubList(page, [fixture()]);
  let posts = 0;
  await page.route("**/api/admin/library/suggest/delete", (route) => { posts++; return route.fulfill({ status: 500, json: { error: "not in this test" } }); });
  await enter(page, srv);
  await onDisk(page);
  assert.ok(await page.locator("#free-pick").evaluate((p) => p.classList.contains("hidden")), "no list before it is asked for");
  await page.fill("#free-gb", "20");
  await page.click("#free-suggest");
  await page.waitForSelector("#free-pick:not(.hidden) #fp-list .fp-row");
  assert.deepEqual(asked, ["20"]);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "fp-title", "focus moves to the list");

  // the order of the server, episodes under their show (in season order), each with why
  const rows = await page.locator("#fp-list > .fp-row, #fp-list > .fp-show").evaluateAll((els) => els.map((e) => e.dataset.fpId || `show:${e.dataset.fpShow}`));
  assert.deepEqual(rows, ["m-stale", "show:s-fix", "m-done"]);
  assert.match(await page.locator('#fp-list [data-fp-id="m-stale"]').innerText(), /Stale Film \(2020\)[\s\S]*My List download — added to My List on 2026-09-20, never watched[\s\S]*4\.0 GB/);
  assert.match(await page.locator('#fp-list [data-fp-show="s-fix"] .fp-show-row').innerText(), /Fixture Show[\s\S]*3 episodes suggested[\s\S]*2\.0 GB/);
  assert.match(await page.locator('#fp-list [data-fp-id="e-1"]').innerText(), /S01E01 · Pilot[\s\S]*Finished by 2 people, last watched 3 months ago · nobody is part-way through[\s\S]*1\.0 GB/);
  assert.match(await page.locator("#fp-note").innerText(), /less than the 20\.0 GB asked for/);

  // every one ticked, except the one being watched: greyed, cannot be ticked
  for (const id of ["m-stale", "e-1", "m-done", "e-2"]) assert.equal(await box(page, id).isChecked(), true, `${id} ticked`);
  assert.equal(await box(page, "e-3").isChecked(), false);
  assert.equal(await box(page, "e-3").isDisabled(), true);
  assert.match(await page.locator('#fp-list [data-fp-id="e-3"]').innerText(), /being watched/);
  assert.match(await page.locator("#fp-note").innerText(), /One is being watched right now and cannot be chosen/);
  assert.equal(await total(page), "4 items · 8.0 GB will be freed");
  assert.deepEqual(await showState(page), { checked: true, mixed: false });

  // untick one episode: the show is mixed, the total drops
  await box(page, "e-1").click();
  assert.deepEqual(await showState(page), { checked: false, mixed: true });
  assert.equal(await total(page), "3 items · 7.0 GB will be freed");
  // the other: the show is unticked
  await box(page, "e-2").click();
  assert.deepEqual(await showState(page), { checked: false, mixed: false });
  assert.equal(await total(page), "2 items · 6.0 GB will be freed");
  // the show tick ticks both (never the one being watched)
  await showBox(page).click();
  assert.equal(await box(page, "e-1").isChecked(), true);
  assert.equal(await box(page, "e-2").isChecked(), true);
  assert.equal(await box(page, "e-3").isChecked(), false);
  assert.deepEqual(await showState(page), { checked: true, mixed: false });
  // mixed → a click ticks all (as a native checkbox does)
  await box(page, "e-2").click();
  await showBox(page).click();
  assert.deepEqual(await showState(page), { checked: true, mixed: false });
  assert.equal(await total(page), "4 items · 8.0 GB will be freed");

  // the keyboard: Space on the show tick unticks its episodes
  await showBox(page).focus();
  await page.keyboard.press("Space");
  assert.equal(await box(page, "e-1").isChecked(), false);
  assert.equal(await total(page), "2 items · 6.0 GB will be freed");
  await page.keyboard.press("Space");
  assert.equal(await total(page), "4 items · 8.0 GB will be freed");

  // Select none / Select all
  await page.click("#fp-none");
  assert.equal(await total(page), "Nothing selected");
  assert.equal(await page.locator("#fp-delete").isDisabled(), true);
  assert.deepEqual(await showState(page), { checked: false, mixed: false });
  await page.click("#fp-all");
  assert.equal(await total(page), "4 items · 8.0 GB will be freed");
  assert.equal(await box(page, "e-3").isChecked(), false, "Select all leaves the one being watched alone");

  // the show folds and unfolds (a button that says so)
  const fold = page.locator('#fp-list [data-fp-show="s-fix"] .fp-fold');
  assert.equal(await fold.getAttribute("aria-expanded"), "true");
  await fold.click();
  assert.equal(await fold.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator('#fp-list [data-fp-id="e-1"]').isVisible(), false);
  assert.equal(await total(page), "4 items · 8.0 GB will be freed", "folding changes nothing that is ticked");
  await fold.click();
  assert.equal(await page.locator('#fp-list [data-fp-id="e-1"]').isVisible(), true);
  await shot(page, "desktop-list", { fullPage: false });
  await page.locator("#free-pick").screenshot({ path: path.join(SHOTS, "desktop-list-card.png") });

  // Close puts the list away and focus back on the button
  await page.click("#fp-close");
  assert.ok(await page.locator("#free-pick").evaluate((p) => p.classList.contains("hidden")));
  assert.equal(await page.evaluate(() => document.activeElement.id), "free-suggest");
  assert.equal(posts, 0, "nothing was deleted");
});

ui.test("Delete selected: a confirm with the count and the size; Never mind deletes nothing; yes sends only the ticked ids, then says what was kept and the list refreshes", async ({ page, srv }) => {
  const after = { ...fixture(), items: fixture().items.filter((i) => ["m-done", "e-3"].includes(i.id)), totalBytes: 2 * GB };
  const asked = await stubList(page, [fixture(), after]);
  const posted = [];
  await page.route("**/api/admin/library/suggest/delete", (route) => {
    posted.push(JSON.parse(route.request().postData()));
    return route.fulfill({ json: {
      ok: true,
      deleted: [{ id: "m-stale", name: "Stale Film (2020)", sizeBytes: 4 * GB }, { id: "e-2", name: "Fixture Show S01E02", sizeBytes: 1 * GB }],
      skipped: [{ id: "e-1", name: "Fixture Show S01E01", reason: "in-use", why: "Being watched right now — kept" }],
      freedBytes: 5 * GB,
    } });
  });
  await enter(page, srv);
  await onDisk(page);
  await page.click("#free-suggest");
  await page.waitForSelector("#fp-list .fp-row");
  await box(page, "m-done").click(); // keep the watched film
  assert.equal(await total(page), "3 items · 6.0 GB will be freed");

  await page.click("#fp-delete");
  const dlg = page.locator("dialog.ask");
  await dlg.waitFor();
  const text = await dlg.innerText();
  assert.match(text, /Delete 3 items — 6\.0 GB\?/);
  assert.match(text, /• Stale Film \(2020\) — 4\.0 GB/);
  assert.match(text, /• Fixture Show S01E01 — 1\.0 GB/);
  assert.match(text, /• Fixture Show S01E02 — 1\.0 GB/);
  assert.doesNotMatch(text, /Watched Film|S01E03/);
  assert.match(text, /cannot be undone/);
  assert.equal((await dlg.locator(".ask-yes").innerText()).trim(), "Yes, delete");
  await dlg.locator(".ask-no").click();
  await dlg.waitFor({ state: "detached" });
  assert.equal(posted.length, 0, "nothing is deleted without a yes");

  await page.click("#fp-delete");
  await dlg.waitFor();
  await dlg.locator(".ask-yes").click();
  await page.waitForSelector("#fp-result:not(.hidden)");
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].ids.sort(), ["e-1", "e-2", "m-stale"]);
  const result = await page.locator("#fp-result").innerText();
  assert.match(result, /Deleted 2 of 3 — 5\.0 GB freed\./);
  assert.match(result, /1 kept:\s*Fixture Show S01E01 — Being watched right now — kept/);
  await toastSays(page, /Deleted 2 of 3 — 5\.0 GB freed\. 1 kept/);
  // the list refreshed, for the same target
  await page.waitForFunction(() => document.querySelectorAll("#fp-list .fp-check").length === 2);
  assert.deepEqual(asked, ["20", "20"]);
  assert.equal(await total(page), "1 item · 2.0 GB will be freed");
  await page.locator("#free-pick").screenshot({ path: path.join(SHOTS, "desktop-after-delete.png") });
});

ui.test("on a phone: the list fits the screen, ticks are thumb-sized, and Delete selected is a full-width button", { viewport: PHONE }, async ({ page, srv }) => {
  await stubList(page, [fixture()]);
  await enter(page, srv);
  await onDisk(page);
  await page.locator("#free-suggest").scrollIntoViewIfNeeded();
  await page.click("#free-suggest");
  await page.waitForSelector("#fp-list .fp-row");
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(sw <= iw, `the page is ${sw}px wide on a ${iw}px screen`);
  const card = await page.locator("#free-pick").boundingBox();
  const boxes = await page.locator("#free-pick .fp-row, #free-pick .fp-foot, #free-pick .fp-head").evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => { const b = e.getBoundingClientRect(); return [b.left, b.right]; }));
  for (const [l, r] of boxes) assert.ok(l >= card.x - 1 && r <= card.x + card.width + 1, `a row sticks out: ${l}–${r} of ${card.x}–${card.x + card.width}`);
  const tick = await box(page, "m-stale").boundingBox();
  assert.ok(tick.width >= 20 && tick.height >= 20, `the tick is ${tick.width}×${tick.height}`);
  const del = await page.locator("#fp-delete").boundingBox();
  assert.ok(del.width >= card.width - 40 && del.height >= 40, `Delete selected is ${del.width}×${del.height} in a ${card.width}px card`);
  // a tap on the row's text ticks it (the whole row is the label)
  await page.locator('#fp-list [data-fp-id="m-done"] .fp-text b').tap();
  assert.equal(await box(page, "m-done").isChecked(), false);
  assert.equal(await total(page), "3 items · 6.0 GB will be freed");
  // one episode off: the show tick is mixed
  await box(page, "e-1").tap();
  assert.deepEqual(await showState(page), { checked: false, mixed: true });
  assert.equal(await total(page), "2 items · 5.0 GB will be freed");
  await page.locator("#fp-list").evaluate((l) => { l.scrollTop = 0; });
  await page.locator("#free-pick").scrollIntoViewIfNeeded();
  await shot(page, "phone-list");
  await page.locator("#free-pick").screenshot({ path: path.join(SHOTS, "phone-list-card.png") });
});

ui.test("the real thing: finished items are suggested, one being played is greyed, and only the ticked one is deleted", async ({ page, srv, api, lib, profiles }) => {
  const anna = profiles.anna;
  // Anna finished film one, and episodes one and two (a 60 s film, 45 s episodes)
  await api.setProgress(anna, lib.film1.id, 59, 60);
  await api.setProgress(anna, lib.e1.id, 44, 45);
  await api.setProgress(anna, lib.e2.id, 44, 45);
  // somebody is playing episode two right now (the stream route stamps it in use)
  const r = await fetch(`${srv.url}/stream/video/${lib.e2.id}`, { headers: { Range: "bytes=0-4095" } });
  await r.arrayBuffer();
  assert.ok(r.status === 206 || r.status === 200);

  await enter(page, srv);
  await onDisk(page);
  await page.fill("#free-gb", "50");
  await page.click("#free-suggest");
  await page.waitForSelector("#fp-list .fp-row");
  assert.equal(await box(page, lib.film1.id).isChecked(), true);
  assert.equal(await box(page, lib.e1.id).isChecked(), true);
  assert.equal(await box(page, lib.e2.id).isDisabled(), true, "the one being played");
  assert.match(await page.locator(`#fp-list [data-fp-id="${lib.e2.id}"]`).innerText(), /being watched/);
  assert.equal(await box(page, lib.film2.id).count(), 0, "nobody finished film two");
  assert.equal(await box(page, lib.e3.id).count(), 0);
  assert.match(await page.locator(`#fp-list [data-fp-id="${lib.film1.id}"]`).innerText(), /Finished by 1 person, last watched today · nobody is part-way through/);
  assert.match(await total(page), /^2 items · /);
  await page.locator("#free-pick").screenshot({ path: path.join(SHOTS, "desktop-real.png") });

  // keep the film, delete the episode
  await box(page, lib.film1.id).click();
  assert.match(await total(page), /^1 item · /);
  await page.click("#fp-delete");
  await page.locator("dialog.ask").waitFor();
  assert.match(await page.locator("dialog.ask").innerText(), /Delete 1 item — [\d.]+ [KMG]?B\?/);
  await page.click("dialog.ask .ask-yes");
  await page.waitForSelector("#fp-result:not(.hidden)");
  assert.match(await page.locator("#fp-result").innerText(), /Deleted 1 of 1 — [\d.]+ [KMG]?B freed\./);
  // the list refreshed: the film is still offered, the episode is gone
  await page.waitForFunction((id) => !document.querySelector(`#fp-list .fp-check[data-id="${id}"]`), lib.e1.id);
  assert.equal(await box(page, lib.film1.id).count(), 1);
  const tree = await api.adminGet("/api/admin/library/tree");
  const eps = tree.shows.flatMap((s) => s.seasons.flatMap((se) => se.episodes.map((e) => e.id)));
  assert.ok(!eps.includes(lib.e1.id), "episode one is off the disk");
  assert.ok(eps.includes(lib.e2.id), "episode two (being played) stays");
  assert.ok(tree.movies.some((m) => m.id === lib.film1.id), "the film that was unticked stays");
});
ui.run();
