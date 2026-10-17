// The admin page, Downloads → "More than one copy" (media/copies.js): a film
// with a second file in its folder, an episode on disk twice, and a film on
// disk once with a second download waiting — grouped, each copy described,
// and one SPECIFIC copy deleted, with the safety rules seen from the page
// (a copy being played cannot be deleted, the last copy needs the typed
// confirm) and from the API (admin only, refs that leave the library are
// refused). Last: the admin page at phone width stays inside the screen on
// every tab.
//
// Its own private instance (scripts/ui-test-server.js): this file deletes
// library files.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { suite } = require("./helpers");
const { IDS } = require("../../scripts/ui-test-server");

const FILM1 = "Test Film One (2020)";
// The show's episodes as the title page gets them (/api/library lists shows without them).
async function episodes(api) {
  const lib = await api.library();
  return (await api.item(lib.shows.find((s) => s.title === "Test Show").id)).seasons[0].episodes;
}
const EXTRA_FILM = `${FILM1}.WEB.720p.mp4`; // sorts after "Test Film One (2020).mp4": the original stays the indexed one
const EXTRA_EP = "Test Show S01E02.1080p.WEB.mp4";
const WAITING = "bbbbbbbbbbbb";

const ui = suite({
  server: {
    seed: {
      // A second download of Film Two, waiting for approval (never starts:
      // nothing approves it, and the instance has no download engine).
      "downloads.json": [{
        id: WAITING, infoHash: "c".repeat(40), fileIdx: 0, type: "movie", imdbId: IDS.film2,
        title: "Test Film Two", year: 2021, quality: "720p", sizeBytes: 900 * 1024 * 1024,
        provider: "TestTracker", release: "Test.Film.Two.2021.720p.WEB", profile: null, profileName: "Ben",
        status: "pending", holdReason: "Low disk", autoApproved: false, progress: 0, at: new Date(Date.now() - 3 * 3600e3).toISOString(),
      }],
    },
  },
  setup: async (srv) => {
    const filmDir = path.join(srv.library.movies, FILM1);
    fs.copyFileSync(path.join(filmDir, `${FILM1}.mp4`), path.join(filmDir, EXTRA_FILM));
    fs.writeFileSync(path.join(filmDir, `${FILM1}.WEB.720p.English.srt`), "1\n00:00:01,000 --> 00:00:02,000\nx\n");
    const season = path.join(srv.library.shows, "Test Show", "Season 1");
    fs.copyFileSync(path.join(season, "Test Show S01E02.mp4"), path.join(season, EXTRA_EP));
    await srv.api.rescan();
    // (the rescan answers before it has finished)
    for (let i = 0; i < 50; i++) {
      if ((await episodes(srv.api)).length === 4) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  },
});

const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const downloadsTab = async (page) => {
  await page.click('.tab[data-tab="downloads"]');
  await page.waitForSelector("#cp-card:not(.hidden) #cp-groups .cp-group");
};
const group = (page, key) => page.locator(`#cp-groups .cp-group[data-cp-group="${key}"]`);
const toastSays = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("toasts").innerText), re.source);
const copiesNow = async (api) => (await api.adminGet("/api/admin/library/copies")).groups;
const noSidewaysScroll = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
const epId = async (api, fileName) => (await episodes(api)).find((e) => e.fileName === fileName).id;

ui.test("the copies are listed: a film twice in its folder, an episode twice, a film once with a second download waiting", async ({ page, srv, api }) => {
  const groups = await copiesNow(api);
  assert.deepEqual(groups.map((g) => g.key).sort(), [IDS.film1, IDS.film2, `${IDS.show}:1:2`].sort());
  const film = groups.find((g) => g.key === IDS.film1);
  assert.equal(film.files, 2);
  assert.deepEqual(film.copies.map((c) => [c.fileName, c.indexed]), [[`${FILM1}.mp4`, true], [EXTRA_FILM, false]]);
  assert.equal(film.copies[1].quality, "720p", "read off the name of a file that was never probed");
  assert.ok(film.copies.every((c) => !("abs" in c)), "no absolute path leaves the server");
  const two = groups.find((g) => g.key === IDS.film2);
  assert.equal(two.files, 1);
  assert.deepEqual(two.downloads.map((j) => [j.id, j.by, j.release]), [[WAITING, "Ben", "Test.Film.Two.2021.720p.WEB"]]);

  await enter(page, srv);
  await downloadsTab(page);
  assert.equal(await page.textContent("#cp-count"), "3");
  assert.match(await page.innerText("#cp-summary"), /3 titles are here more than once/);
  // the film: two copies, the one the app plays first, the other marked as only taking space
  const g = group(page, IDS.film1);
  assert.match(await g.locator("summary").innerText(), /Test Film One \(2020\).*2 copies on disk/s);
  await g.locator("summary").click();
  const rows = g.locator(".cp-row");
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).innerText(), new RegExp(`${FILM1.replace(/[()]/g, "\\$&")}\\.mp4[\\s\\S]*the one the app plays`));
  assert.match(await rows.nth(1).innerText(), /WEB\.720p\.mp4[\s\S]*720p[\s\S]*no download record — put there by hand[\s\S]*not shown in the app/);
  // the episode, and the waiting download with who asked for it
  assert.match(await group(page, `${IDS.show}:1:2`).locator("summary").innerText(), /Test Show · S1 E2.*2 copies on disk/s);
  const w = group(page, IDS.film2);
  assert.match(await w.locator("summary").innerText(), /1 on disk \+ 1 downloading/);
  await w.locator("summary").click();
  assert.match(await w.locator(`[data-cp-job="${WAITING}"]`).innerText(), /waiting for your approval[\s\S]*by Ben · Test\.Film\.Two\.2021\.720p\.WEB · started 3h ago/);

  // ON DISK says so on the film's row, and the pill jumps to the group
  const lib = await api.library();
  const filmId = lib.movies.find((m) => m.title === "Test Film One").id;
  await page.waitForSelector(`#lib-tree [data-cp-jump="${IDS.film1}"]`);
  await page.click("#cp-card > summary"); // fold the card: the jump opens it again
  await page.click(`#lib-tree [data-cp-jump="${IDS.film1}"]`);
  await page.waitForFunction(() => document.getElementById("cp-card").open);
  await page.waitForFunction((key) => { const d = document.querySelector(`#cp-groups .cp-group[data-cp-group="${key}"]`); return d && d.open && d.classList.contains("cp-hot"); }, IDS.film1);
  assert.ok(filmId);
});

ui.test("deleting one copy of the film asks with the file's name, removes that file and its own subtitles only, and the group is gone", async ({ page, srv, api }) => {
  const dir = path.join(srv.library.movies, FILM1);
  await enter(page, srv);
  await downloadsTab(page);
  const g = group(page, IDS.film1);
  await g.locator("summary").click();
  await g.locator(".cp-row", { hasText: EXTRA_FILM }).locator("[data-cp-del]").click();
  const dlg = page.locator("dialog.ask");
  await dlg.waitFor();
  assert.match(await dlg.innerText(), /Delete this copy of "Test Film One \(2020\)"\?/);
  assert.match(await dlg.innerText(), new RegExp(EXTRA_FILM.replace(/[().]/g, "\\$&")));
  assert.match(await dlg.innerText(), /The other copy stays/);
  // "Never mind" leaves everything
  await dlg.locator(".ask-no").click();
  assert.ok(fs.existsSync(path.join(dir, EXTRA_FILM)));
  await g.locator(".cp-row", { hasText: EXTRA_FILM }).locator("[data-cp-del]").click();
  await page.click("dialog.ask .ask-yes");
  await toastSays(page, /Deleted Test Film One \(2020\)\.WEB\.720p\.mp4/);
  assert.ok(!fs.existsSync(path.join(dir, EXTRA_FILM)), "the copy is gone");
  assert.ok(!fs.existsSync(path.join(dir, `${FILM1}.WEB.720p.English.srt`)), "with its own subtitles");
  for (const keep of [`${FILM1}.mp4`, `${FILM1}.English.srt`, `${FILM1}.Hebrew.srt`, "cover.jpg"]) {
    assert.ok(fs.existsSync(path.join(dir, keep)), `${keep} stays`);
  }
  await page.waitForFunction((key) => !document.querySelector(`#cp-groups .cp-group[data-cp-group="${key}"]`), IDS.film1);
  assert.ok(!(await copiesNow(api)).some((x) => x.key === IDS.film1));
  assert.ok((await api.library()).movies.some((m) => m.title === "Test Film One"), "the film is still in the library");
});

ui.test("a copy someone is playing cannot be deleted (button and API); the other copy of that episode can", async ({ page, srv, api }) => {
  const playing = await epId(api, "Test Show S01E02.mp4");
  const res = await fetch(`${srv.url}/stream/video/${playing}`, { headers: { Range: "bytes=0-1023" } });
  assert.equal(res.status, 206);
  await res.arrayBuffer();
  const key = `${IDS.show}:1:2`;
  const grp = (await copiesNow(api)).find((x) => x.key === key);
  const live = grp.copies.find((c) => c.libraryId === playing);
  assert.equal(live.streaming, true);
  const refused = await api.call("POST", "/api/admin/library/copies/delete", { ref: live.ref }, api.admin);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "streaming");

  await enter(page, srv);
  await downloadsTab(page);
  const g = group(page, key);
  await g.locator("summary").click();
  const liveRow = g.locator(".cp-row", { hasText: "Test Show S01E02.mp4" });
  assert.match(await liveRow.innerText(), /playing now/);
  assert.ok(await liveRow.locator("[data-cp-del]").isDisabled());
  await g.locator(".cp-row", { hasText: EXTRA_EP }).locator("[data-cp-del]").click();
  assert.match(await page.innerText("dialog.ask"), /Delete this copy of "Test Show · S1 E2[^"]*"\?/);
  await page.click("dialog.ask .ask-yes");
  await toastSays(page, /Deleted Test Show S01E02\.1080p\.WEB\.mp4/);
  const season = path.join(srv.library.shows, "Test Show", "Season 1");
  assert.ok(!fs.existsSync(path.join(season, EXTRA_EP)));
  assert.ok(fs.existsSync(path.join(season, "Test Show S01E02.mp4")));
  assert.ok(fs.existsSync(path.join(season, "Test Show S01E02.English.srt")), "the subtitles of the copy that stays");
  await page.waitForFunction((k) => !document.querySelector(`#cp-groups .cp-group[data-cp-group="${k}"]`), key);
});

ui.test("the API is admin-only and refuses refs outside the library or files that are not a copy", async ({ srv, api }) => {
  assert.equal((await api.call("GET", "/api/admin/library/copies")).status, 403);
  const two = (await copiesNow(api)).find((x) => x.key === IDS.film2);
  assert.equal((await api.call("POST", "/api/admin/library/copies/delete", { ref: two.copies[0].ref })).status, 403, "no password, no delete");
  // a file outside the library, next to it
  const outside = path.join(path.dirname(srv.library.movies), "outside.mp4");
  fs.writeFileSync(outside, "not a film");
  for (const ref of ["movies:0:../outside.mp4", "movies:0:Test Film Two (2021)/../../outside.mp4", `movies:0:${outside}`, "movies:0:Test Film Two (2021)/cover.jpg", "movies:7:x.mp4", "nope"]) {
    const r = await api.call("POST", "/api/admin/library/copies/delete", { ref }, api.admin);
    assert.equal(r.status, 400, `${ref} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.ok(fs.existsSync(outside));
  // a library video that has no other copy
  const three = await api.call("POST", "/api/admin/library/copies/delete", { ref: "shows:0:Test Show/Season 1/Test Show S01E01.mp4" }, api.admin);
  assert.equal(three.status, 409);
  assert.equal(three.body.code, "not-a-copy");
  assert.ok(fs.existsSync(path.join(srv.library.shows, "Test Show", "Season 1", "Test Show S01E01.mp4")));
  // the last copy on disk, without the stronger confirm
  const last = await api.call("POST", "/api/admin/library/copies/delete", { ref: two.copies[0].ref }, api.admin);
  assert.equal(last.status, 409);
  assert.equal(last.body.code, "last-copy");
  assert.ok(fs.existsSync(path.join(srv.library.movies, "Test Film Two (2021)", "Test Film Two (2021).mkv")));
});

ui.test("the admin page at 390 px: nothing runs off the side on any tab, with the copies card open", { viewport: { width: 390, height: 844 } }, async ({ page, srv }) => {
  await enter(page, srv);
  await downloadsTab(page);
  await group(page, IDS.film2).locator("summary").click();
  const tabs = await page.locator(".tab[data-tab]").evaluateAll((els) => els.map((e) => e.dataset.tab));
  assert.ok(tabs.length >= 6);
  for (const tab of tabs) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForTimeout(400);
    const subs = await page.locator("#subtabs [data-sub]:visible").evaluateAll((els) => els.map((e) => e.dataset.sub));
    for (const sub of subs.length ? subs : [null]) {
      if (sub) { await page.click(`#subtabs [data-sub="${sub}"]`); await page.waitForTimeout(300); }
      const { sw, iw } = await noSidewaysScroll(page);
      assert.ok(sw <= iw, `${tab}${sub ? "/" + sub : ""}: the page is ${sw}px wide on a ${iw}px screen`);
    }
  }
  // the copies card itself: every row inside the card
  await page.click('.tab[data-tab="downloads"]');
  const card = await page.locator("#cp-card").boundingBox();
  const boxes = await page.locator("#cp-groups .cp-row, #cp-groups summary").evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => { const b = e.getBoundingClientRect(); return [b.left, b.right]; }));
  assert.ok(boxes.length > 0);
  for (const [l, r] of boxes) assert.ok(l >= card.x - 1 && r <= card.x + card.width + 1, `a row sticks out: ${l}–${r} of ${card.x}–${card.x + card.width}`);
});

ui.test("the last copy on disk needs DELETE typed; a wrong word deletes nothing", async ({ page, srv, api }) => {
  const film = path.join(srv.library.movies, "Test Film Two (2021)", "Test Film Two (2021).mkv");
  await enter(page, srv);
  await downloadsTab(page);
  const g = group(page, IDS.film2);
  await g.locator("summary").click();
  await g.locator("[data-cp-del]").click();
  const dlg = page.locator("dialog.ask");
  await dlg.waitFor();
  assert.match(await dlg.innerText(), /Delete the LAST copy of "Test Film Two \(2021\)"\?/);
  assert.match(await dlg.innerText(), /only copy on disk.*until the download in flight lands/s);
  assert.equal((await dlg.locator(".ask-yes").innerText()).trim(), "Yes, delete the last copy");
  await dlg.locator("input").fill("yes");
  await dlg.locator(".ask-yes").click();
  await toastSays(page, /Nothing was deleted — type DELETE to confirm/);
  assert.ok(fs.existsSync(film));
  await g.locator("[data-cp-del]").click();
  await page.locator("dialog.ask input").fill("delete");
  await page.click("dialog.ask .ask-yes");
  await toastSays(page, /Deleted Test Film Two \(2021\)\.mkv/);
  assert.ok(!fs.existsSync(film));
  // the waiting download is still there (it was not the file)
  assert.ok((await api.get("/api/downloads")).some((j) => j.id === WAITING));
});

ui.run({ concurrency: 1 });
