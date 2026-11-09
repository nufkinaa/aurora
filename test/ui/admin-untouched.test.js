// Admin → Downloads → Free up space, with the 45-day rule (media/untouched.js):
// the calm line on top ("Suggested to delete: … — … nobody touched for 45
// days"), and behind Details the groups with their reasons — Nobody watched
// for 45+ days, Never played, Watched by everyone, Extra copies — each row with
// its size, drive and who asked for it, Select all per group, the total
// selected and ONE question; Kept for people who are away (Remove anyway asks
// the stronger, typed question), Kept by you (Keep / Unpin), Not offered right
// now, the settings and Removed recently. Nothing is removed without a yes.
//
// The first tests hand the page a made-up answer and catch every write, at
// desktop and phone width; the last runs on the private instance's real
// library with a throwaway film 70 days old.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, openDetails, DESKTOP, PHONE } = require("./helpers");

const OLD = "Old Forgotten Film (2001)";
const ui = suite({
  setup: async (srv) => {
    // a throwaway copy of a test film, 70 days in the library, never played
    const src = path.join(srv.library.movies, "Test Film One (2020)", "Test Film One (2020).mp4");
    const dir = path.join(srv.library.movies, OLD);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${OLD}.mp4`);
    fs.copyFileSync(src, dest);
    const t = (Date.now() - 70 * 86400e3) / 1000;
    fs.utimesSync(dest, t, t);
    await srv.api.rescan();
    await new Promise((r) => setTimeout(r, 1500));
  },
});

const SHOTS = process.env.UT_SHOTS || path.join(os.tmpdir(), "aurora-agents", "auto-cleanup", "shots");
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
const FORECAST = { state: "filling", line: "about 40 days until full at this week's pace", short: "about 40 days until full", detail: "70.0 GB added in the last 7 days.", daysLeft: 40 };
const SHOW = { id: "sh1", title: "Heart of the Beast", cover: null };
const row = (o) => ({ title: null, show: null, season: null, episode: null, cover: null, drive: "Media", askedBy: null, upload: false, lastPlayed: null, landedAt: 1, lastTouch: 1, idleDays: 50, inUse: false, ...o, fileBytes: o.fileBytes ?? o.sizeBytes });
const fixture = (o = {}) => ({
  days: 60,
  safe: [],
  duplicates: [],
  idle: [
    row({ key: "x:f1", id: "f1", group: "idle", kind: "movie", name: "Slow Film (2004)", sizeBytes: 8 * GB, askedBy: "Niso", why: "Nobody watched for 52 days · last played by Niso on Sep 18" }),
    row({ key: "x:e1", id: "e1", group: "idle", kind: "episode", name: "Heart of the Beast S01E01", title: "Pilot", show: SHOW, season: 1, episode: 1, sizeBytes: 2 * GB, why: "Nobody watched for 60 days · last played by Dana on Sep 10" }),
    row({ key: "x:e2", id: "e2", group: "idle", kind: "episode", name: "Heart of the Beast S01E02", title: "Two", show: SHOW, season: 1, episode: 2, sizeBytes: 2 * GB, why: "Nobody watched for 58 days · last played by Dana on Sep 12" }),
  ],
  never: [
    row({ key: "x:f2", id: "f2", group: "never", kind: "movie", name: "Unplayed Film (2010)", sizeBytes: 4 * GB, drive: "Big Disk", askedBy: "Dana", why: "Never played · arrived Sep 10" }),
    row({ key: "x:f3", id: "f3", group: "never", kind: "movie", name: "Playing Now (2011)", sizeBytes: 0, fileBytes: 3 * GB, inUse: true, why: "Never played · arrived Sep 1" }),
  ],
  away: [
    row({ key: "a:e3", id: "e3", group: "away", kind: "episode", name: "Heart of the Beast S01E03", show: SHOW, season: 1, episode: 3, sizeBytes: 2 * GB, people: ["Maya"], awaySince: 1, reason: "Nobody watched for 50 days · last played by Maya on Oct 2", why: "Kept for Maya — away since Oct 2 · the last thing they watched" }),
  ],
  pinned: [{ key: "k:f9", id: "f9", kind: "movie", name: "Family Film (1999)", cover: null, sizeBytes: 5 * GB, episodes: null, onDisk: true, at: 1, why: "Kept by you on Nov 2 — never suggested" }],
  held: [{ id: "f8", name: "Moving Film (2008)", why: "being moved to another drive" }],
  removed: [{ at: Date.parse("2026-11-01T12:00:00Z"), name: "Gone Film (2000)", kind: "movie", sizeBytes: 6 * GB, why: "Never played · arrived Aug 1", group: "never" }],
  untouched: { ok: true, days: 45, settings: { untouchedDays: 45, untouchedUploads: false, untouchedKeepMyList: false }, exempt: { uploads: 0, mylist: 0 } },
  totals: { safe: { count: 0, bytes: 0 }, duplicates: { count: 0, bytes: 0 }, idle: { count: 3, bytes: 12 * GB }, never: { count: 1, bytes: 4 * GB }, all: { count: 4, bytes: 16 * GB } },
  disk: { free: 400 * GB, total: 512 * GB },
  forecast: FORECAST,
  ...o,
});
const stub = async (page, answer = fixture()) => {
  const writes = [];
  await page.route((u) => u.pathname === "/api/admin/disk", (route) => route.fulfill({ json: { disks: [{ root: "D:\\Media\\Movies", free: 400 * GB, total: 512 * GB }], minFreePct: 0, forecast: FORECAST } }));
  await page.route((u) => u.pathname === "/api/admin/library/freeup", (route) => route.fulfill({ json: answer }));
  for (const p of ["/api/admin/library/freeup/delete", "/api/admin/library/keep", "/api/admin/library/freeup/settings"]) {
    await page.route((u) => u.pathname === p, (route) => {
      writes.push({ path: p, body: JSON.parse(route.request().postData() || "{}") });
      const json = p.endsWith("delete") ? { ok: true, deleted: [], skipped: [], freedBytes: 0 } : { ok: true };
      return route.fulfill({ json });
    });
  }
  return writes;
};
const openFree = async (page) => {
  await page.click('.tab[data-tab="downloads"]');
  await openDetails(page, "d-free");
  await page.waitForFunction(() => /Suggested to delete|Nothing to suggest/.test(document.getElementById("fs-line").textContent));
};
const check = (page, key) => page.locator(`#fs-card .fs-check[data-key="${key}"]`);

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`the calm line, the groups with their reasons, Select all per group, one question (${name})`, { viewport }, async ({ page, srv }) => {
    const writes = await stub(page);
    await enter(page, srv);
    await openFree(page);
    assert.equal(await page.innerText("#fs-line"), "Suggested to delete: 4 items · 16.0 GB — nobody touched them for 45 days · 1 kept for people who are away · about 40 days until full at this week's pace");
    assert.equal(await page.locator("#fs-body").isVisible(), false, "the groups are behind Details");
    await shot(page, `ut-calm-${name}`, 'details.more[data-more="d-free"]');
    await page.click("#fs-toggle");
    // the groups, in plain words, with each row's why, size, drive and who asked
    const idle = await page.innerText("#fs-idle");
    assert.match(idle, /Slow Film \(2004\)[\s\S]*Nobody watched for 52 days · last played by Niso on Sep 18[\s\S]*8\.0 GB · on Media · asked for by Niso/);
    assert.match(idle, /Heart of the Beast[\s\S]*2 episodes · 4\.0 GB[\s\S]*S01E01 · Pilot[\s\S]*Nobody watched for 60 days/);
    assert.match(await page.innerText("#fs-never"), /Unplayed Film \(2010\)[\s\S]*Never played · arrived Sep 10[\s\S]*4\.0 GB · on Big Disk · asked for by Dana/);
    assert.match(await page.innerText("#fs-never"), /Playing Now \(2011\)[\s\S]*being watched[\s\S]*right now — kept/);
    assert.equal(await check(page, "x:f3").isDisabled(), true);
    assert.match(await page.innerText("#fs-away"), /Heart of the Beast S01E03[\s\S]*Kept for Maya — away since Oct 2 · the last thing they watched[\s\S]*Remove anyway/);
    assert.match(await page.innerText("#fs-pinned"), /Family Film \(1999\)[\s\S]*Kept by you on Nov 2 — never suggested[\s\S]*Unpin/);
    assert.match(await page.innerText("#fs-held"), /Moving Film \(2008\) — being moved to another drive/);
    assert.match(await page.innerText("#fs-removed"), /Gone Film \(2000\) · 6\.0 GB[\s\S]*Never played · arrived Aug 1/);
    assert.equal(await page.inputValue("#fs-udays"), "45");
    assert.equal(await page.isChecked("#fs-uploads"), false);
    assert.equal(await page.isChecked("#fs-mylist"), false);
    for (const k of ["x:f1", "x:e1", "x:e2", "x:f2"]) assert.equal(await check(page, k).isChecked(), false, `${k} not ticked at first`);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(sw <= 1, `the page scrolls sideways by ${sw}px`);
    await shot(page, `ut-details-${name}`, 'details.more[data-more="d-free"]');

    // Select all of one group ticks that group only; the show's tick follows
    await page.click('[data-fs-gall="idle"]');
    for (const k of ["x:f1", "x:e1", "x:e2"]) assert.equal(await check(page, k).isChecked(), true);
    assert.equal(await check(page, "x:f2").isChecked(), false, "another group is left alone");
    assert.equal(await page.locator('.fs-show-check[data-show="idle|sh1"]').isChecked(), true);
    assert.equal(await page.textContent('[data-fs-gall="idle"]'), "Select none");
    assert.equal(await page.textContent("#fs-total"), "3 ticked · 12.0 GB");
    // one episode off: the show box is mixed
    await check(page, "x:e2").click();
    assert.equal(await page.locator('.fs-show-check[data-show="idle|sh1"]').evaluate((b) => b.indeterminate), true);
    await check(page, "x:f2").click();
    assert.equal(await page.textContent("#fs-remove"), "Remove 3 (14.0 GB)");
    // Never mind removes nothing; yes sends exactly the ticked keys, once
    await page.click("#fs-remove");
    let ask = page.locator("dialog.ask");
    await ask.waitFor();
    assert.match(await ask.innerText(), /Remove 3 items — 14\.0 GB\?/);
    assert.match(await ask.innerText(), /Each one was suggested for the reason beside it/);
    await ask.locator(".ask-no").click();
    await page.waitForTimeout(200);
    assert.deepEqual(writes, [], "Never mind sends nothing");
    await page.click("#fs-remove");
    ask = page.locator("dialog.ask");
    await ask.waitFor();
    await ask.locator(".ask-yes").click();
    await page.waitForSelector("#fs-result:not(.hidden)");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/api/admin/library/freeup/delete");
    assert.deepEqual(writes[0].body.keys.sort(), ["x:e1", "x:f1", "x:f2"]);
    assert.equal(writes[0].body.confirmAway, undefined, "never the away person's title with them");
  });
}

ui.test("Keep, Unpin, the stronger question for an away person's title, and the settings", async ({ page, srv }) => {
  const writes = await stub(page);
  await enter(page, srv);
  await openFree(page);
  await page.click("#fs-toggle");
  // Keep on a film, and on a show
  await page.click('[data-fs-keep="f1"]');
  await page.waitForFunction(() => document.querySelectorAll("#toasts .toast").length > 0);
  await page.click('[data-fs-keep="sh1"]');
  await page.click('[data-fs-unpin="f9"]');
  for (let i = 0; i < 30 && writes.length < 3; i++) await page.waitForTimeout(100);
  assert.deepEqual(writes.map((w) => [w.path, w.body]), [
    ["/api/admin/library/keep", { id: "f1", on: true }],
    ["/api/admin/library/keep", { id: "sh1", on: true }],
    ["/api/admin/library/keep", { id: "f9", on: false }],
  ]);
  writes.length = 0;
  // Remove anyway: a typed REMOVE, or nothing happens
  await page.click('[data-fs-away="a:e3"]');
  let ask = page.locator("dialog.ask");
  await ask.waitFor();
  assert.match(await ask.innerText(), /Remove "Heart of the Beast S01E03" — 2\.0 GB\?[\s\S]*Maya has not been on Aurora since[\s\S]*Type REMOVE/);
  await ask.locator("input").fill("yes");
  await ask.locator(".ask-yes").click();
  await page.waitForTimeout(250);
  assert.deepEqual(writes, [], "the wrong word removes nothing");
  await page.click('[data-fs-away="a:e3"]');
  ask = page.locator("dialog.ask");
  await ask.waitFor();
  await ask.locator("input").fill("REMOVE");
  await ask.locator(".ask-yes").click();
  for (let i = 0; i < 30 && !writes.length; i++) await page.waitForTimeout(100);
  assert.deepEqual(writes.map((w) => w.body), [{ keys: ["a:e3"], days: 60, confirmAway: true }]);
  writes.length = 0;
  // settings
  await page.fill("#fs-udays", "60");
  await page.check("#fs-mylist");
  await page.click("#fs-set-save");
  for (let i = 0; i < 30 && !writes.length; i++) await page.waitForTimeout(100);
  assert.deepEqual(writes.map((w) => [w.path, w.body]), [["/api/admin/library/freeup/settings", { untouchedDays: 60, untouchedUploads: false, untouchedKeepMyList: true }]]);
});

ui.test("Copy for Claude carries every group, the settings and Removed recently", { permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
  await stub(page);
  await enter(page, srv);
  await page.click('.tab[data-tab="downloads"]');
  await page.click('details.more[data-more="d-free"] [data-copy-for="d-free"]');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).startsWith("## Free up space"), null, { timeout: 15000 });
  const text = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  assert.match(text, /- suggested to delete: 4 items, 16\.0 GB\n- nobody touched for: 45 days \(uploads never suggested; My List does not keep a title\)/);
  assert.match(text, /Nobody watched for 45\+ days:\n\| title \| size \| drive \| why \|\n\|---\|---\|---\|---\|\n\| Slow Film \(2004\) \| 8\.0 GB \| Media \| Nobody watched for 52 days · last played by Niso on Sep 18 \|/);
  assert.match(text, /Never played:\n[\s\S]*\| Unplayed Film \(2010\) \| 4\.0 GB \| Big Disk \| Never played · arrived Sep 10 \|/);
  assert.match(text, /Kept for people who are away \(never suggested\):\n[\s\S]*Kept for Maya — away since Oct 2/);
  assert.match(text, /Kept by you \(never suggested\):\n[\s\S]*Family Film \(1999\)/);
  assert.match(text, /Not offered right now:\n[\s\S]*Moving Film \(2008\) \| being moved to another drive/);
  assert.match(text, /Removed recently:\n[\s\S]*Gone Film \(2000\) \| 6\.0 GB \| Never played · arrived Aug 1/);
  assert.ok(!/undefined|NaN|\[object Object\]/.test(text), text);
});

ui.test("the real thing: a film 70 days in the library, never played, is suggested; Keep takes it out; removed only after the yes", async ({ page, srv, api }) => {
  const tree0 = await api.adminGet("/api/admin/library/tree");
  const film = tree0.movies.find((m) => m.title === "Old Forgotten Film");
  assert.ok(film, "the throwaway film is in the library");
  const file = path.join(srv.library.movies, OLD, `${OLD}.mp4`);
  await enter(page, srv);
  await openFree(page);
  await page.click("#fs-toggle");
  await page.waitForSelector(`#fs-never [data-fs-key="x:${film.id}"]`);
  assert.match(await page.locator(`#fs-never [data-fs-key="x:${film.id}"]`).innerText(), /Old Forgotten Film \(2001\)[\s\S]*Never played · arrived \w+ \d+/);
  assert.ok(fs.existsSync(file), "listing removed nothing");
  // Keep: it leaves the suggestions and shows under Kept by you
  await page.click(`[data-fs-keep="${film.id}"]`);
  await page.waitForSelector(`#fs-pinned [data-fs-pin="${film.id}"]`);
  assert.equal(await page.locator(`#fs-never [data-fs-key="x:${film.id}"]`).count(), 0);
  await page.click(`[data-fs-unpin="${film.id}"]`);
  await page.waitForSelector(`#fs-never [data-fs-key="x:${film.id}"]`);
  // tick it, Never mind: still there; yes: gone, and in Removed recently
  await check(page, `x:${film.id}`).click();
  await page.click("#fs-remove");
  await page.locator("dialog.ask").waitFor();
  await page.click("dialog.ask .ask-no");
  await page.waitForTimeout(300);
  assert.ok(fs.existsSync(file), "Never mind removed nothing");
  await page.click("#fs-remove");
  await page.locator("dialog.ask").waitFor();
  await page.click("dialog.ask .ask-yes");
  await page.waitForSelector("#fs-result:not(.hidden)");
  assert.match(await page.innerText("#fs-result"), /Removed 1 of 1/);
  assert.ok(!fs.existsSync(file), "the file is gone");
  await page.waitForFunction(() => /Old Forgotten Film \(2001\)/.test(document.getElementById("fs-removed").textContent));
  assert.match(await page.innerText("#fs-removed"), /Old Forgotten Film \(2001\)[\s\S]*Never played · arrived/);
  const tree = await api.adminGet("/api/admin/library/tree");
  assert.ok(!tree.movies.some((m) => m.id === film.id), "gone from the library index");
  assert.ok(tree.movies.some((m) => m.title === "Test Film One"), "the rest stays");
  await shot(page, "ut-real-desktop", 'details.more[data-more="d-free"]');
});

ui.run({ concurrency: 1 });
