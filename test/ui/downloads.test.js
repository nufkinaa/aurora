// "My downloads" in the web app while the server tries a second source for a
// slow download (src/media/dlrace.js): the card stays ONE card and gains one
// calm note — nothing else about it changes.
//
// The private instance cannot download anything (no network, no torrent), so
// the queue's answer is stubbed in the browser: these are the exact fields
// publicJob() sends. The queue itself is tested in test/dlrace-queue.test.js.
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();

const job = (over = {}) => ({
  id: "aaaaaaaaaaaa", infoHash: "a".repeat(40), fileIdx: 0, imdbId: "tt9100001", title: "Slow Film", label: "Slow Film", type: "movie",
  season: null, episode: null, quality: "1080p", sizeBytes: 4e9, poster: null, provider: null,
  status: "downloading", phase: "downloading", copyProgress: null, progress: 0.12, downloadSpeed: 2100000, peers: 4,
  error: null, at: new Date().toISOString(), approvedAt: new Date().toISOString(), doneAt: null,
  holdReason: null, autoApproved: true, seenAt: null, smart: false, resolvedAt: null, libraryId: null,
  race: null, raceNote: null, mine: true, ...over,
});
const racing = { state: "racing", why: "projected to take 6.8 h more", attempts: [] };

ui.test("a download trying a second source says so on its one card, and nothing else changes", async ({ page, goto, signIn, freshProfile }) => {
  const jobs = [
    job({ race: racing }),
    job({ id: "bbbbbbbbbbbb", title: "Plain Film", label: "Plain Film" }),
    job({ id: "cccccccccccc", title: "Stuck Film", label: "Stuck Film", raceNote: "No healthy source was found at 1080p — still trying the original." }),
    job({ id: "dddddddddddd", title: "Landing Film", label: "Landing Film", phase: "copying", copyProgress: 0.5, progress: 1, race: racing }),
  ];
  await page.route((url) => url.pathname === "/api/downloads", (route) => route.fulfill({ json: jobs }));
  await signIn(await freshProfile());
  await goto("#/downloads");
  await page.waitForSelector('.dl-row[data-id="aaaaaaaaaaaa"]');

  assert.equal(await page.locator(".dl-row").count(), 4, "one card per download — a race does not add one");
  const text = (id) => page.locator(`.dl-row[data-id="${id}"] .dl-status`).innerText();
  const raced = await text("aaaaaaaaaaaa");
  assert.match(raced, /Downloading · 12%/);
  assert.match(raced, /2\.1 MB\/s/);
  assert.match(raced, /· trying a second source$/, "the note is last, after the usual speed and time left");
  const plain = await text("bbbbbbbbbbbb");
  assert.doesNotMatch(plain, /second source/);
  assert.equal(raced.replace(" · trying a second source", ""), plain, "apart from the note, the two cards read the same");
  assert.match(await text("cccccccccccc"), /No healthy source was found at 1080p — still trying the original\./);
  assert.doesNotMatch(await text("dddddddddddd"), /second source/, "once it is being copied in, the race is over");
  // same bar, same buttons
  const shape = (id) => page.locator(`.dl-row[data-id="${id}"]`).evaluate((r) => [r.className, r.querySelectorAll(".dl-bar").length, r.querySelectorAll("button").length]);
  assert.deepEqual(await shape("aaaaaaaaaaaa"), await shape("bbbbbbbbbbbb"));
});

// The live messages are the only way a tab hears about a download. While the
// socket is down they are lost, so when it comes back the list is asked for
// again and every open screen catches up.
ui.test("a download that finished while the connection was down is caught up on reconnect: the card, the pill and \"ready to watch\"", async ({ page, goto, signIn, freshProfile, lib }) => {
  // every socket the page opens, so the test can drop the live one
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Real {
      constructor(...a) { super(...a); window.__sockets.push(this); }
    };
  });
  let jobs = [
    job({ id: "eeeeeeeeeeee", title: "Outage Film", label: "Outage Film", progress: 0.4 }),
    job({ id: "ffffffffffff", title: "Removed Film", label: "Removed Film", status: "pending", phase: null, progress: 0 }),
  ];
  let asks = 0;
  await page.route((url) => url.pathname === "/api/downloads", (route) => { asks++; route.fulfill({ json: jobs }); });
  await signIn(await freshProfile());
  await goto("#/downloads");
  await page.waitForSelector('.dl-row[data-id="eeeeeeeeeeee"]');
  assert.match(await page.locator('.dl-row[data-id="eeeeeeeeeeee"] .dl-status').innerText(), /Downloading · 40%/);
  assert.equal(await page.locator('.dl-row[data-id="ffffffffffff"]').count(), 1);
  await page.waitForFunction(() => window.__sockets.some((s) => s.readyState === 1));

  // while the tab is blind: one download lands in the library, the admin removes the other
  jobs = [job({ id: "eeeeeeeeeeee", title: "Outage Film", label: "Outage Film", status: "done", phase: null, progress: 1, downloadSpeed: 0, doneAt: new Date().toISOString(), libraryId: lib.film1.id })];
  const before = asks;
  await page.evaluate(() => window.__sockets.filter((s) => s.readyState === 1).forEach((s) => s.close()));

  // the socket comes back by itself; nothing is reloaded
  await page.waitForFunction(() => document.getElementById("toasts").innerText.includes("“Outage Film” is ready to watch"), null, { timeout: 15000 });
  assert.ok(asks > before, "the list was asked for again");
  await page.waitForFunction(() => /Ready/i.test((document.querySelector('.dl-row[data-id="eeeeeeeeeeee"]') || {}).innerText || ""));
  assert.equal(await page.locator('.dl-row[data-id="ffffffffffff"]').count(), 0, "the removed request is still on the page");
  await page.waitForFunction(() => document.getElementById("nav-dl").classList.contains("ready"));
});

// My List downloads (and their "on hold") are gone (2026-10-26): a job the
// old feature left in the queue is sent as an ordinary automatic download —
// `smart`, no tag — and a queued one reads as every queued one does.
ui.test("a leftover automatic download in the queue is an ordinary queued one: AUTO, no My List tag, no 'on hold'", async ({ page, goto, signIn, freshProfile }) => {
  const jobs = [
    job({ id: "333333333333", title: "Left Film", label: "Left Film", status: "approved", phase: null, progress: 0, downloadSpeed: 0, smart: true }),
    job({ id: "444444444444", title: "Plain Queued Film", label: "Plain Queued Film", status: "approved", phase: null, progress: 0, downloadSpeed: 0 }),
    job({ id: "555555555555", title: "Moving Film", label: "Moving Film" }),
  ];
  await page.route((url) => url.pathname === "/api/downloads", (route) => route.fulfill({ json: jobs }));
  await signIn(await freshProfile());
  await goto("#/downloads");
  await page.waitForSelector('.dl-row[data-id="333333333333"]');
  const text = async (id) => (await page.locator(`.dl-row[data-id="${id}"] .dl-status`).innerText()).split(/\s+/).join(" ").trim();
  assert.match(await text("333333333333"), /^Queued · Starts when a download slot frees up$/);
  assert.match(await text("444444444444"), /^Queued · Starts when a download slot frees up$/);
  assert.equal(await page.locator('.dl-row[data-id="333333333333"] .dl-auto').innerText(), "AUTO");
  assert.doesNotMatch(await page.locator(".dl-list, body").first().innerText(), /MY LIST|On hold|Starts after the other downloads/);
  assert.equal(await page.locator(".dl-row.held").count(), 0);
  assert.equal(await page.locator(".dl-queued .dl-row").count(), 2);
  assert.equal(await page.locator('.dl-row[data-id="333333333333"] button', { hasText: "Cancel" }).count(), 1);
});

// A first read that fails (the server restarting as the page opened) is asked
// again by itself: the page used to say "Nothing downloading yet" until a
// reload — the TV app said "Could not load your downloads" for good.
ui.test("the list is read again by itself after a failed read, and fills My downloads in", { allow: [/status of 503 .*\/api\/downloads/] }, async ({ page, goto, signIn, freshProfile }) => {
  const jobs = [job({ id: "999999999999", title: "Back Again Film", label: "Back Again Film" })];
  const p = await freshProfile();
  let failed = 0;
  let served = 0;
  await page.route((url) => url.pathname === "/api/downloads", (route) => {
    if (failed < 2) { failed++; return route.fulfill({ status: 503, json: { error: "restarting" } }); }
    served++;
    return route.fulfill({ json: jobs });
  });
  await signIn(p);
  await goto("#/downloads");
  // while it fails the page says so — not "Nothing downloading yet"
  await page.waitForSelector(".dl-retrying");
  assert.match(await page.locator(".dl-retrying").innerText(), /Couldn't load your downloads[\s\S]*trying again/);
  await page.waitForSelector('.dl-row[data-id="999999999999"]', { timeout: 20000 });
  assert.equal(await page.locator(".dl-retrying").count(), 0, "the message goes once the list is in");
  assert.equal(failed, 2, "two reads failed first");
  assert.ok(served >= 1);
  assert.match(await page.locator('.dl-row[data-id="999999999999"] .dl-status').innerText(), /Downloading · 12%/);
  assert.equal(await page.locator(".dl-empty").count(), 0, "not the empty page");
});

ui.run({ concurrency: 1 });
