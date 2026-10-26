// The admin page refuses to delete a file somebody is playing, and says so
// (src/lib/fileinuse.js, the 409 from routes/admin.js) — on the private
// instance, in the real browser: the file is "played" by asking the real
// stream route for some of its bytes, exactly what a player does every few
// seconds; then the On disk card's Delete buttons are pressed.
//
// The tests that end in a real delete go last: the library is the
// instance's own (scripts/ui-test-server.js), shared by this file only.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();

const SHOTS = path.join(os.tmpdir(), "aurora-agents", "fix-dl-overwrite", "shots");
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

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
// A player asking for the file's bytes (the stream route stamps it in use).
const play = async (srv, id, route = "video") => {
  const r = await fetch(`${srv.url}/stream/${route}/${id}`, { headers: { Range: "bytes=0-4095" } });
  await r.arrayBuffer();
  assert.ok(r.status === 206 || r.status === 200, `the stream route served ${id}: ${r.status}`);
};
const toastSays = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll("#toasts .toast")].some((t) => new RegExp(src).test(t.textContent)), re.source);
const treeHas = async (api, id) => {
  const t = await api.adminGet("/api/admin/library/tree");
  return t.movies.some((m) => m.id === id) || t.shows.some((s) => s.seasons.some((se) => se.episodes.some((e) => e.id === id)));
};

// ("Suggest what to delete" greys out what somebody is playing right now, and its
// delete skips it: test/ui/admin-delete-pick.test.js, test/admin-free-pick.test.js)

ui.test("deleting an episode somebody is playing: refused with a sentence, and the episode stays (desktop)", { allow: [/Failed to load resource.*409/] }, async ({ page, srv, api, lib }) => {
  const ep = lib.e1;
  await play(srv, ep.id);
  await enter(page, srv);
  await onDisk(page);
  const responses = [];
  page.on("response", (r) => { if (/\/api\/admin\/library\/file\//.test(r.url())) responses.push(r.status()); });
  await page.click('#lib-tree details.lib-show > summary');
  await page.click('#lib-tree details.lib-season > summary');
  await page.click(`#lib-tree [data-file-id="${ep.id}"]`);
  await page.waitForSelector("dialog.ask");
  assert.match(await page.locator("dialog.ask").innerText(), /Delete this episode from disk\?/);
  await page.click("dialog.ask .ask-yes");
  await toastSays(page, /^Someone is playing this right now — try again when they have stopped\.$/);
  await shot(page, "admin-delete-refused-1280");
  assert.deepEqual(responses, [409]);
  // the button is back to what it was, the row is still there, the file too
  await page.waitForFunction((id) => { const b = document.querySelector(`#lib-tree [data-file-id="${id}"]`); return b && !b.disabled && b.textContent === "Delete"; }, ep.id);
  assert.ok(await treeHas(api, ep.id), "the episode is still in the library");
});

ui.test("deleting a film somebody is playing, on a phone: refused with a sentence, and the film stays", { viewport: { width: 390, height: 844 }, allow: [/Failed to load resource.*409/] }, async ({ page, srv, api, lib }) => {
  const film = lib.film2;
  await play(srv, film.id);
  await enter(page, srv);
  await onDisk(page);
  const btn = page.locator(`#lib-tree [data-del-type="movie"][data-del-id="${film.id}"]`);
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.waitForSelector("dialog.ask");
  await page.click("dialog.ask .ask-yes");
  await toastSays(page, /^Someone is playing a file in this folder right now — try again when they have stopped\.$/);
  await shot(page, "admin-delete-refused-390");
  // the toast fits the phone: nothing runs off the side
  const fits = await page.evaluate(() => [...document.querySelectorAll("#toasts .toast")].every((t) => t.getBoundingClientRect().right <= window.innerWidth + 1));
  assert.ok(fits, "the message is readable on the phone");
  assert.ok(await treeHas(api, film.id), "the film is still in the library");
});

ui.test("Delete selected with one episode being played: the other goes, the played one stays, and the toast says why", { allow: [/Failed to load resource.*409/] }, async ({ page, srv, api, lib }) => {
  const busy = lib.e2;
  const idle = lib.e3;
  await play(srv, busy.id);
  await enter(page, srv);
  await onDisk(page);
  await page.click('#lib-tree details.lib-show > summary');
  await page.click('#lib-tree details.lib-season > summary');
  await page.check(`#lib-tree .lib-ep-check[data-id="${busy.id}"]`);
  await page.check(`#lib-tree .lib-ep-check[data-id="${idle.id}"]`);
  await page.click("#lib-batch-delete");
  await page.waitForSelector("dialog.ask");
  await page.click("dialog.ask .ask-yes");
  await toastSays(page, /^Deleted 1 of 2 — .* freed; 1 is being played right now and kept — try again when they have stopped$/);
  await shot(page, "admin-batch-refused-1280");
  assert.ok(await treeHas(api, busy.id), "the one being played is still in the library");
  assert.equal(await treeHas(api, idle.id), false, "the other one was deleted");
});

ui.run({ concurrency: 1 });
