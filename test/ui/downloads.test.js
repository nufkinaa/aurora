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

// Downloads v2 (docs/downloads-v2.md): the server's plain sentence (`note`)
// on the card, "Waiting for a copy" between rounds, the server's own
// time left (`etaSec`) — at desktop and phone width.
ui.test("downloads v2: a stalled copy, another copy, held back, waiting for a copy — said in words on the card", async ({ page, goto, signIn, freshProfile }) => {
  const shots = require("path").join(require("os").tmpdir(), "aurora-agents", "downloads-v2", "shots");
  require("fs").mkdirSync(shots, { recursive: true });
  const jobs = [
    job({ id: "a1a1a1a1a1a1", title: "Stalled Film", label: "Stalled Film", phase: "starting", progress: 0, downloadSpeed: 0, peers: 0, note: "No one is sharing this copy right now — still looking", health: { state: "stalled", code: "no-peers", countsAsRunning: false } }),
    job({ id: "b2b2b2b2b2b2", title: "Switched Film", label: "Switched Film", progress: 0.31, note: "No one was sharing that copy — now trying another (1080p · 1.4 GB)", etaSec: 125 }),
    job({ id: "c3c3c3c3c3c3", title: "Held Film", label: "Held Film", progress: 0.5, downloadSpeed: 24000, note: "Paused for a moment — an episode someone is watching goes first", heldBack: { since: new Date().toISOString(), for: "Show · S1 E3" } }),
    job({ id: "d4d4d4d4d4d4", title: "Waiting Film", label: "Waiting Film", status: "approved", phase: null, progress: 0, note: "No one is sharing any copy of this right now (3 copies tried) — trying again in about 30 min", retryAt: new Date(Date.now() + 30 * 60e3).toISOString() }),
  ];
  await page.route((url) => url.pathname === "/api/downloads", (route) => route.fulfill({ json: jobs }));
  await signIn(await freshProfile());
  await goto("#/downloads");
  await page.waitForSelector('.dl-row[data-id="d4d4d4d4d4d4"]');
  const text = (id) => page.locator(`.dl-row[data-id="${id}"]`).innerText();
  assert.match(await text("a1a1a1a1a1a1"), /No one is sharing this copy right now — still looking/);
  const sw = await text("b2b2b2b2b2b2");
  assert.match(sw, /Downloading · 31%/);
  assert.match(sw, /2 min left/, "the server's own time left");
  assert.match(sw, /No one was sharing that copy — now trying another \(1080p · 1\.4 GB\)/);
  const held = await text("c3c3c3c3c3c3");
  assert.match(held, /Paused for a moment — an episode someone is watching goes first/);
  assert.doesNotMatch(held, /MB\/s|left/, "no trickle speed or time left while held back");
  const w = await text("d4d4d4d4d4d4");
  assert.match(w, /Waiting for a copy/);
  assert.match(w, /3 copies tried\) — trying again in about 30 min/);
  await page.waitForTimeout(1500); // (the page's entry animation)
  const list = page.locator('.dl-row[data-id="a1a1a1a1a1a1"]').locator("xpath=..");
  await list.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: require("path").join(shots, "downloads-v2-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  await list.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: require("path").join(shots, "downloads-v2-phone.png") });
  // nothing wider than the phone
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll on a phone");
});

// elia, 2026-11-11: "on desktop sometimes the downloads page btn beside the
// settings disappears". On a computer the button stays: a plain icon to My
// downloads when nothing moves, the progress while something downloads, the
// icon and its count once ready — and that one no longer rests out of sight.
// A phone shows it only while there is something to say; kids never.
ui.test("the Downloads button on a computer: always there, idle → progress → ready, never resting out of sight", async ({ page, goto, signIn, freshProfile, lib }) => {
  let jobs = [];
  await page.route((url) => url.pathname === "/api/downloads", (route) => route.fulfill({ json: jobs }));
  await signIn(await freshProfile());
  await goto("#/");
  const pill = page.locator("#nav-dl");
  await page.waitForFunction(() => document.getElementById("nav-dl").classList.contains("idle"));
  assert.ok(await pill.isVisible(), "idle on a computer: the button is there");
  assert.equal(await pill.getAttribute("aria-label"), "My downloads");
  assert.equal(await pill.getAttribute("href"), "#/downloads");
  // a download starts
  jobs = [job({ id: "999999999999", title: "Busy Film", label: "Busy Film", progress: 0.5 })];
  await page.reload();
  await page.waitForFunction(() => /⬇ 1 · 50%/.test(document.getElementById("nav-dl").textContent));
  // it lands: the icon with its count, and twelve seconds later it is still in sight
  jobs = [job({ id: "999999999999", title: "Busy Film", label: "Busy Film", status: "done", phase: null, progress: 1, downloadSpeed: 0, doneAt: new Date().toISOString(), seenAt: null, libraryId: lib.film1.id })];
  await page.reload();
  await page.waitForFunction(() => document.getElementById("nav-dl").classList.contains("ready"));
  await page.mouse.move(5, 600);
  await page.waitForTimeout(12000);
  assert.equal(await pill.evaluate((n) => getComputedStyle(n).opacity), "1", "the ready button rested out of sight");
});

ui.test("the Downloads button on a computer: a kids profile has none (no downloads at all)", async ({ page, goto, signIn, api }) => {
  await page.route((url) => url.pathname === "/api/downloads", (route) => route.fulfill({ json: [] }));
  const kid = await api.createProfile("Dl Kid", { open: true, kids: { maxAge: 7 } });
  await signIn(kid);
  await goto("#/");
  await page.locator(".home-greeting").waitFor();
  await page.waitForTimeout(800);
  assert.equal(await page.locator("#nav-dl").isVisible(), false, "a kids profile has a Downloads button");
});

ui.test("the Downloads button on a phone: only while something downloads or is ready", { viewport: { width: 390, height: 844 } }, async ({ page, goto, signIn, freshProfile }) => {
  await page.route((url) => url.pathname === "/api/downloads", (route) => route.fulfill({ json: [] }));
  await signIn(await freshProfile());
  await goto("#/");
  await page.waitForTimeout(1200);
  assert.equal(await page.locator("#nav-dl").isVisible(), false);
});

ui.run({ concurrency: 1 });
