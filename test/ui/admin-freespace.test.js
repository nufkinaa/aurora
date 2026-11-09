// Admin → Downloads: the disk forecast on top ("about 40 days until full at
// this week's pace") and "Free up space" — what is SAFE to remove (finished
// by everyone who started it, on nobody's My List, old enough, plus extra
// copies), a calm line with the list behind "Details", each row with why and
// its own Remove, ticked rows removed together under ONE question, and a
// Copy for Claude. Nothing is removed without a yes.
//
// The first tests hand the page a made-up answer (GET /api/admin/library/freeup,
// GET /api/admin/disk) and catch the remove (POST …/freeup/delete), at desktop
// and phone width; the last goes through the private instance's real library,
// real watch state and a real delete.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, openDetails, DESKTOP, PHONE } = require("./helpers");

const FILM1 = "Test Film One (2020)";
const EXTRA_FILM = `${FILM1}.WEB.720p.mp4`; // sorts after the original: the original stays the indexed one
const ui = suite({
  setup: async (srv) => {
    srv.profiles.anna = await srv.api.createProfile("Anna", { open: true });
    const filmDir = path.join(srv.library.movies, FILM1);
    fs.copyFileSync(path.join(filmDir, `${FILM1}.mp4`), path.join(filmDir, EXTRA_FILM));
    await srv.api.rescan();
    await new Promise((r) => setTimeout(r, 1500));
  },
});

const SHOTS = process.env.FS_SHOTS || path.join(os.tmpdir(), "aurora-agents", "downloads-next-disk", "shots");
const shot = async (page, name, el = null) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (el ? page.locator(el) : page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const GB = 1024 ** 3;
const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const toastSays = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll("#toasts .toast")].some((t) => new RegExp(src).test(t.textContent)), re.source);

const FORECAST = { state: "filling", line: "about 40 days until full at this week's pace", short: "about 40 days until full", detail: "70.0 GB added in the last 7 days (about 10.0 GB a day); 400 GB free.", daysLeft: 40 };
const fixture = (o = {}) => ({
  days: 60,
  safe: [
    { key: "m:f1", kind: "movie", name: "Old Film (2001)", title: "Old Film", cover: null, ids: ["f1"], sizeBytes: 8 * GB, fileBytes: 8 * GB, watchedBy: ["Dor", "jn"], ageDays: 94, inUse: false, why: "watched by Dor and jn, nobody's My List, 94 days old" },
    { key: "s:s1", kind: "show", name: "Long Show", title: "Long Show", cover: null, ids: ["e1", "e2"], episodes: [{ id: "e1", season: 1, episode: 1, sizeBytes: 2 * GB, inUse: false }, { id: "e2", season: 1, episode: 2, sizeBytes: 2 * GB, inUse: false }],
      sizeBytes: 4 * GB, fileBytes: 4 * GB, watchedBy: ["Anna"], ageDays: 120, inUse: false, why: "2 episodes (S01E01–S01E02) watched by Anna, nobody's My List, 120+ days old" },
    { key: "m:f2", kind: "movie", name: "Playing Film (2003)", title: "Playing Film", cover: null, ids: ["f2"], sizeBytes: 0, fileBytes: 3 * GB, watchedBy: ["Anna"], ageDays: 70, inUse: true, why: "watched by Anna, nobody's My List, 70 days old" },
  ],
  duplicates: [
    { key: "c:movies:0:Twice/b.mkv", kind: "copy", ref: "movies:0:Twice/b.mkv", name: "Twice Film (2010)", quality: "720p", fileName: "Twice.Film.720p.mkv", cover: null, sizeBytes: 2 * GB, fileBytes: 2 * GB, inUse: false, why: "an extra 720p copy — the 1080p copy (8.0 GB) stays and is the one the app plays" },
  ],
  totals: { safe: { count: 2, bytes: 12 * GB }, duplicates: { count: 1, bytes: 2 * GB }, all: { count: 3, bytes: 14 * GB } },
  disk: { free: 400 * GB, total: 512 * GB },
  forecast: FORECAST,
  ...o,
});
const stubDisk = (page) => page.route((u) => u.pathname === "/api/admin/disk", (route) => route.fulfill({ json: { disks: [{ root: "D:\\Media\\Movies", free: 400 * GB, total: 512 * GB }], minFreePct: 0, forecast: FORECAST } }));
const stubList = async (page, lists) => {
  const asked = [];
  await page.route((u) => u.pathname === "/api/admin/library/freeup", (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("days"));
    // (a function: the answer for what has happened so far — a list asked
    // again after a "library changed" broadcast must not jump ahead)
    return route.fulfill({ json: typeof lists === "function" ? lists() : lists[Math.min(asked.length - 1, lists.length - 1)] });
  });
  return asked;
};
const openFree = async (page) => {
  await page.click('.tab[data-tab="downloads"]');
  await openDetails(page, "d-free");
  await page.waitForFunction(() => /Suggested to delete|Nothing to suggest/.test(document.getElementById("fs-line").textContent));
};
const check = (page, key) => page.locator(`#fs-card .fs-check[data-key="${key}"]`);

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`the forecast on top, the calm line, Details, why per row, one question for the ticked ones (${name})`, { viewport }, async ({ page, srv }) => {
    await stubDisk(page);
    const posts = [];
    const afterRemove = fixture({ safe: fixture().safe.slice(1), totals: { safe: { count: 1, bytes: 4 * GB }, duplicates: { count: 0, bytes: 0 }, all: { count: 1, bytes: 4 * GB } }, duplicates: [] });
    const asked = await stubList(page, () => (posts.length ? afterRemove : fixture()));
    await page.route("**/api/admin/library/freeup/delete", async (route) => {
      const body = JSON.parse(route.request().postData());
      posts.push(body);
      return route.fulfill({ json: { ok: true, deleted: body.keys.map((key) => ({ key, name: key, sizeBytes: GB })), skipped: [], freedBytes: 10 * GB } });
    });
    await enter(page, srv);
    await page.click('.tab[data-tab="downloads"]');
    // the forecast beside the free space, on top of the Downloads screen
    await page.waitForSelector("#disk-forecast");
    assert.equal(await page.textContent("#disk-forecast"), "about 40 days until full at this week's pace");
    assert.match(await page.textContent("#disk-headline"), /^400\.0 GB free · about 40 days until full at this week's pace$/);
    assert.equal(asked.length, 0, "the list is asked for only once Free up space is opened");

    await openFree(page);
    assert.deepEqual(asked, ["60"]);
    assert.equal(await page.innerText("#fs-line"), "Suggested to delete: 3 items · 14.0 GB · about 40 days until full at this week's pace");
    assert.equal(await page.textContent("#fs-count"), "3");
    // the list is behind Details
    assert.equal(await page.locator("#fs-body").isVisible(), false);
    await shot(page, `calm-${name}`, 'details.more[data-more="d-free"]');
    await page.click("#fs-toggle");
    assert.equal(await page.getAttribute("#fs-toggle", "aria-expanded"), "true");
    assert.equal(await page.locator("#fs-body").isVisible(), true);
    assert.match(await page.innerText("#fs-forecast"), /Forecast: about 40 days until full at this week's pace\. 70\.0 GB added in the last 7 days/);
    // rows: why, size, its own Remove; nothing ticked at first
    assert.match(await page.locator('#fs-safe [data-fs-key="m:f1"]').innerText(), /Old Film \(2001\)[\s\S]*watched by Dor and jn, nobody's My List, 94 days old[\s\S]*8\.0 GB[\s\S]*Remove/);
    assert.match(await page.locator('#fs-dups [data-fs-key="c:movies:0:Twice/b.mkv"]').innerText(), /Twice Film \(2010\) · 720p[\s\S]*Twice\.Film\.720p\.mkv[\s\S]*the 1080p copy \(8\.0 GB\) stays/);
    assert.match(await page.locator('#fs-safe [data-fs-key="m:f2"]').innerText(), /being watched[\s\S]*right now — kept/);
    assert.equal(await check(page, "m:f2").isDisabled(), true);
    assert.equal(await page.locator('[data-fs-one="m:f2"]').isDisabled(), true);
    for (const k of ["m:f1", "s:s1", "c:movies:0:Twice/b.mkv"]) assert.equal(await check(page, k).isChecked(), false, `${k} not ticked at first`);
    assert.equal(await page.locator("#fs-remove").isDisabled(), true);
    assert.equal(await page.textContent("#fs-total"), "Nothing ticked");
    // no sideways scroll
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(sw <= 1, `the page scrolls sideways by ${sw}px`);

    // tick two: the button says how many and how much
    await check(page, "m:f1").click();
    await check(page, "c:movies:0:Twice/b.mkv").click();
    assert.equal(await page.textContent("#fs-remove"), "Remove 2 (10.0 GB)");
    assert.equal(await page.textContent("#fs-total"), "2 ticked · 10.0 GB");
    await shot(page, `details-${name}`, 'details.more[data-more="d-free"]');
    // Never mind removes nothing
    await page.click("#fs-remove");
    let ask = page.locator("dialog.ask");
    await ask.waitFor();
    assert.match(await ask.innerText(), /Remove 2 items — 10\.0 GB\?/);
    assert.match(await ask.innerText(), /• Old Film \(2001\) — 8\.0 GB\n• Twice Film \(2010\) — 2\.0 GB/);
    assert.match(await ask.locator(".ask-yes").innerText(), /Yes, remove/);
    await shot(page, `ask-${name}`);
    await ask.locator(".ask-no").click();
    await page.waitForTimeout(250);
    assert.deepEqual(posts, [], "Never mind removes nothing");
    // yes: one request with the two keys, the result, the list again
    await page.click("#fs-remove");
    ask = page.locator("dialog.ask");
    await ask.waitFor();
    await ask.locator(".ask-yes").click();
    await page.waitForSelector("#fs-result:not(.hidden)");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], { keys: ["m:f1", "c:movies:0:Twice/b.mkv"], days: 60 });
    assert.match(await page.innerText("#fs-result"), /Removed 2 of 2 — 10\.0 GB freed\./);
    await page.waitForFunction(() => !document.querySelector('#fs-card [data-fs-key="m:f1"]'));
    assert.equal(await page.innerText("#fs-line"), "Suggested to delete: 1 item · 4.0 GB · about 40 days until full at this week's pace");
    assert.match(await page.innerText("#fs-dups"), /No title is on the disk twice/);
  });
}

ui.test("a row's own Remove asks once, for that row only; the days are adjustable and remembered", async ({ page, srv }) => {
  await stubDisk(page);
  const asked = await stubList(page, [fixture()]);
  const posts = [];
  await page.route("**/api/admin/library/freeup/delete", async (route) => {
    posts.push(JSON.parse(route.request().postData()));
    return route.fulfill({ json: { ok: true, deleted: [], skipped: [{ key: "s:s1", name: "Long Show", reason: "not-safe", why: "Not safe to remove any more — somebody started it, put it on My List, or it is gone. Reload the list." }], freedBytes: 0 } });
  });
  await enter(page, srv);
  await openFree(page);
  await page.click("#fs-toggle");
  await page.click('[data-fs-one="s:s1"]');
  const ask = page.locator("dialog.ask");
  await ask.waitFor();
  assert.match(await ask.innerText(), /Remove 2 episode files of "Long Show" — 4\.0 GB\?/);
  assert.match(await ask.innerText(), /Safe because: 2 episodes \(S01E01–S01E02\) watched by Anna, nobody's My List, 120\+ days old\./);
  await ask.locator(".ask-yes").click();
  await page.waitForSelector("#fs-result:not(.hidden)");
  assert.deepEqual(posts, [{ keys: ["s:s1"], days: 60 }]);
  assert.match(await page.innerText("#fs-result"), /Nothing was removed\. 1 kept:[\s\S]*Long Show — Not safe to remove any more/);
  // days: asked again with the new number, and remembered on this browser
  await page.fill("#fs-days", "30");
  await page.press("#fs-days", "Enter");
  for (let i = 0; i < 30 && !asked.includes("30"); i++) await page.waitForTimeout(100);
  assert.ok(asked.includes("30"), `asked: ${asked}`);
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-admin-fs-days")), "30");
});

ui.test("Copy for Claude: the forecast and every candidate with why, as plain text", { permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
  await stubDisk(page);
  await stubList(page, [fixture()]);
  await enter(page, srv);
  await page.click('.tab[data-tab="downloads"]');
  await page.click('details.more[data-more="d-free"] [data-copy-for="d-free"]');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).startsWith("## Free up space"), null, { timeout: 15000 });
  const text = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  assert.match(text, /^## Free up space\n_Aurora admin · .+_\n\n- forecast: about 40 days until full at this week's pace\n- behind it: 70\.0 GB added in the last 7 days/);
  assert.match(text, /- free: 400\.0 GB of 512\.0 GB\n- suggested to delete: 3 items, 14\.0 GB\n- nobody touched for: 45 days \(uploads never suggested; My List does not keep a title\)\n- watched by everyone: titles in the library at least 60 days/);
  assert.match(text, /\| Old Film \(2001\) \| 8\.0 GB \| watched by Dor and jn, nobody's My List, 94 days old \|/);
  assert.match(text, /\| Playing Film \(2003\) \| 3\.0 GB \| BEING WATCHED NOW, kept · watched by Anna/);
  assert.match(text, /Extra copies:\n\| title \| copy \| size \| why it is safe \|\n\|---\|---\|---\|---\|\n\| Twice Film \(2010\) \| 720p · Twice\.Film\.720p\.mkv \| 2\.0 GB \|/);
  assert.match(text, /Nothing is removed automatically/);
  assert.ok(!/undefined|NaN|\[object Object\]/.test(text), text);
  assert.equal(await page.locator('details.more[data-more="d-free"]').evaluate((d) => d.open), false, "copying does not open it");
});

ui.test("the real thing: a film Anna finished and the extra copy are offered and removed under one question; the rest stays", async ({ page, srv, api, lib, profiles }) => {
  const anna = profiles.anna;
  await api.setProgress(anna, lib.film2.id, 59, 60);
  // …and last she started film one (her last title is kept for her while she
  // is away and never suggested — media/untouched.js; film one is not finished)
  await api.setProgress(anna, lib.film1.id, 5, 60);
  await enter(page, srv);
  await page.click('.tab[data-tab="downloads"]');
  await openDetails(page, "d-free");
  await page.click("#fs-toggle");
  await page.waitForFunction(() => /Suggested to delete|Nothing to suggest/.test(document.getElementById("fs-line").textContent));
  await page.fill("#fs-days", "0");
  await page.press("#fs-days", "Enter");
  await page.waitForSelector(`#fs-card .fs-check[data-key="m:${lib.film2.id}"]`);
  assert.match(await page.locator(`#fs-safe [data-fs-key="m:${lib.film2.id}"]`).innerText(), /Test Film Two[\s\S]*watched by Anna, nobody's My List, \d+ days? old/);
  assert.equal(await page.locator(`#fs-card .fs-check[data-key="m:${lib.film1.id}"]`).count(), 0, "nobody finished film one");
  const dup = page.locator("#fs-dups .fs-row");
  assert.equal(await dup.count(), 1);
  assert.match(await dup.innerText(), new RegExp(`${EXTRA_FILM.replace(/[.()]/g, "\\$&")}[\\s\\S]*stays`));
  await shot(page, "real-desktop", 'details.more[data-more="d-free"]');
  await page.click("#fs-all");
  assert.match(await page.textContent("#fs-remove"), /^Remove 2 \(/);
  await page.click("#fs-remove");
  await page.locator("dialog.ask").waitFor();
  await page.click("dialog.ask .ask-yes");
  await page.waitForSelector("#fs-result:not(.hidden)");
  assert.match(await page.innerText("#fs-result"), /Removed 2 of 2 — [\d.]+ [KMG]?B freed\./);
  await toastSays(page, /Removed 2 of 2/);
  const tree = await api.adminGet("/api/admin/library/tree");
  assert.ok(!tree.movies.some((m) => m.id === lib.film2.id), "film two is off the disk");
  assert.ok(tree.movies.some((m) => m.id === lib.film1.id), "film one stays");
  assert.ok(!fs.existsSync(path.join(srv.library.movies, FILM1, EXTRA_FILM)), "the extra copy is gone");
  assert.ok(fs.existsSync(path.join(srv.library.movies, FILM1, `${FILM1}.mp4`)), "the copy that stays, stays");
});

ui.run({ concurrency: 1 });
