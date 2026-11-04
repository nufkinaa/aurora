// Real watch time, end to end in real Chrome (docs/watch-time.md): a film
// plays in the app while the admin's Activity is open in another tab of the
// same browser. Playing counts; a pause does not; a hidden tab says so; a
// page frozen by the browser (what a closed laptop lid does to it) counts
// nothing and the server closes its viewing; closing the tab ends it all —
// and the admin follows every step without a reload.
const assert = require("node:assert/strict");
const { suite, player, openDetails } = require("./helpers");

const ui = suite();

const enterAdmin = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await openDetails(page, "ov-activity");
};
const activity = (srv) => fetch(`${srv.url}/api/admin/activity`, { headers: { "X-Admin-Password": srv.adminPassword } }).then((r) => r.json());
const sessionsOf = (srv, name) => fetch(`${srv.url}/api/admin/sessions?profile=${encodeURIComponent(name)}`, { headers: { "X-Admin-Password": srv.adminPassword } }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ui.test("play, pause, hide, freeze, close: only the playing seconds count, and the admin follows live", { timeout: 180000 }, async ({ page, context, srv, signIn, freshProfile, lib }) => {
  const who = await freshProfile();
  await signIn(who);
  const admin = await context.newPage();
  await enterAdmin(admin, srv);

  // 1. playing
  await player.open(page, srv, lib.film1.id);
  const startedAt = Date.now();
  await admin.waitForFunction((n) => [...document.querySelectorAll("#act-now .act-card")].some((c) => c.querySelector(".act-name").textContent === n && c.dataset.state === "playing"), who.name, { timeout: 15000 });
  await sleep(12000);
  const playedFor = (Date.now() - startedAt) / 1000;

  // 2. paused for 15 s: the card says so, and the time stands still
  await page.evaluate(() => document.querySelector(".player video").pause());
  await admin.waitForFunction((n) => [...document.querySelectorAll("#act-now .act-card")].some((c) => c.querySelector(".act-name").textContent === n && c.dataset.state === "paused"), who.name, { timeout: 15000 });
  const atPause = (await activity(srv)).now.find((r) => r.profile === who.name).sittingSec;
  assert.ok(atPause >= playedFor - 7 && atPause <= playedFor + 2, `about ${Math.round(playedFor)} s played, the server says ${atPause}`);
  await sleep(15000);
  const afterPause = (await activity(srv)).now.find((r) => r.profile === who.name).sittingSec;
  assert.ok(afterPause - atPause <= 1, `a pause counts nothing (${atPause} → ${afterPause})`);

  // 3. the tab hidden (as when another tab is chosen — headless Chrome keeps
  // every tab "visible", so the change is told to the page by hand): the
  // server hears it at once
  const setVisible = (v) => page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (v ? "visible" : "hidden") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !v });
    document.dispatchEvent(new Event("visibilitychange"));
  }, v);
  await setVisible(false);
  await sleep(1500);
  const clients = await fetch(`${srv.url}/api/admin/clients`, { headers: { "X-Admin-Password": srv.adminPassword } }).then((r) => r.json());
  const mine = clients.find((c) => c.profile === who.name);
  assert.equal(mine.visible, false, "the hidden tab said so");
  assert.equal(mine.hb, 60, "and it keeps a heartbeat");
  await setVisible(true);

  // 4. playing again, then the page's JavaScript STOPPED for 50 s — what a
  // closed lid (or Chrome freezing a background tab) does to it: no timers,
  // no reports, while the socket stays open (the debugger holds the page;
  // headless Chrome does not freeze a tab it shows)
  await page.evaluate(() => document.querySelector(".player video").play());
  await player.advancing(page, { by: 2 });
  await sleep(4000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.pause");
  const frozenAt = Date.now();
  // the server stops counting: the viewing goes quiet, then is closed at its last report
  await admin.waitForFunction((n) => {
    const row = [...document.querySelectorAll("#act-screens .act-scr")].find((r) => r.querySelector(".two b").textContent === n);
    return row && row.dataset.p === "quiet";
  }, who.name, { timeout: 70000 });
  assert.equal(await admin.evaluate((n) => [...document.querySelectorAll("#act-now .act-card")].some((c) => c.querySelector(".act-name").textContent === n), who.name), false,
    "not in Right now while it is not answering");
  await sleep(Math.max(0, 50000 - (Date.now() - frozenAt)));
  const closed = (await sessionsOf(srv, who.name)).find((s) => s.content === "Test Film One" || /Test Film One/i.test(s.content));
  assert.ok(closed, "the viewing is on record");
  assert.equal(closed.live, false, "closed by the server while the page was frozen");
  assert.equal(closed.endReason, "silent");
  const totalFrozen = closed.watchedSec;
  assert.ok(totalFrozen <= playedFor + 12, `the frozen 50 s did not count (${totalFrozen} s on record)`);
  await cdp.send("Debugger.resume");
  await cdp.send("Debugger.disable");

  // 5. the tab closes: the screen is gone from the admin, live
  await admin.waitForFunction((n) => [...document.querySelectorAll("#act-screens .act-scr .two b")].some((b) => b.textContent === n), who.name, { timeout: 20000 });
  await page.close();
  await admin.waitForFunction((n) => ![...document.querySelectorAll("#act-screens .act-scr .two b")].some((b) => b.textContent === n), who.name, { timeout: 20000 });
  const all = await sessionsOf(srv, who.name);
  const sum = all.reduce((a, s) => a + (s.watchedSec || 0), 0);
  const wall = (Date.now() - startedAt) / 1000;
  assert.ok(all.every((s) => !s.live), "nothing left open");
  assert.ok(sum < wall / 2, `only the playing parts: ${sum} s of ${Math.round(wall)} s with the tab open`);
  assert.ok(sum >= playedFor - 8, `and those counted (${sum} s)`);
});

ui.run({ concurrency: 1 });
