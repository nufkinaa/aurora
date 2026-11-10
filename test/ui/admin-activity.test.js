// Admin › Home › Activity (docs/watch-time.md): who is watching, every open
// screen, real watch time, recent plays — and it keeps itself up to date
// without a reload, without anything on the page jumping.
//   - the numbers and rows from a stubbed /api/admin/activity (fixture data)
//   - live: a screen that connects makes the page ask again; the changed
//     answer is painted into the SAME nodes; a playing card's clock runs on by
//     itself between answers; nothing shifts (layout-shift entries = 0)
//   - the real endpoint, end to end, with fake screens over the socket
//   - phone width: nothing wider than the screen
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { suite, openDetails, assertNoHorizontalOverflow, PHONE } = require("./helpers");

const SHOTS = path.join(__dirname, "artifacts", "admin-activity");
const ui = suite();

const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const shot = async (page, name, sel) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (sel ? page.locator(sel) : page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const NOW = () => Date.now();
const fixture = (o = {}) => {
  const now = NOW();
  const iso = (ms) => new Date(ms).toISOString();
  return {
    at: now,
    now: [
      { key: "c-ann", clientId: "c-ann", profile: "Ann", content: "Silo S3E2", title: "Silo", episode: "S3 E2", position: 1260, duration: 2820, posAt: now, state: "playing", rate: 1,
        device: { device: "TV", browser: "Aurora TV 5.8.4", os: "Xiaomi MiTV" }, app: "tv", ip: "10.0.0.5", since: iso(now - 21 * 60000), sittingSec: 1250 },
      { key: "c-kim", clientId: "c-kim", profile: "Kim", content: "Arrival", title: "Arrival", episode: null, position: 3912, duration: 6983, posAt: now, state: "paused", rate: 1,
        device: { device: "Mobile", browser: "Aurora phone 1.0.4", os: "Pixel 9" }, app: "phone", ip: "10.0.0.6", since: iso(now - 70 * 60000), sittingSec: 3100 },
    ],
    screens: [
      { key: "c-ann", ids: ["c-ann"], tabs: 1, profile: "Ann", device: { device: "TV", browser: "Aurora TV 5.8.4", os: "Xiaomi MiTV" }, ip: "10.0.0.5", app: "tv", presence: "watching", doing: "Silo S3E2", since: iso(now - 25 * 60000) },
      { key: "c-kim", ids: ["c-kim"], tabs: 1, profile: "Kim", device: { device: "Mobile", browser: "Aurora phone 1.0.4", os: "Pixel 9" }, ip: "10.0.0.6", app: "phone", presence: "paused", doing: "Arrival", since: iso(now - 80 * 60000) },
      { key: "c-bob1", ids: ["c-bob1", "c-bob2"], tabs: 2, profile: "Bob", device: { device: "Desktop", browser: "Chrome", os: "Windows" }, ip: "10.0.0.7", app: "web", presence: "browsing", doing: null, since: iso(now - 3 * 3600000) },
      { key: "c-zed", ids: ["c-zed"], tabs: 1, profile: "Zed", device: { device: "Desktop", browser: "Chrome", os: "macOS" }, ip: "10.0.0.8", app: "web", presence: "away", doing: null, since: iso(now - 5 * 3600000) },
    ],
    counts: { watching: 1, paused: 1, screens: 3, away: 1 },
    today: { watchSec: 9720, plays: 4, people: [{ name: "Bob", watchSec: 5400, plays: 1 }, { name: "Ann", watchSec: 3770, plays: 2 }, { name: "Kim", watchSec: 550, plays: 1 }],
      titles: [{ content: "Inception", title: "Inception", episode: null, watchSec: 5400, plays: 1, viewers: ["Bob"] }, { content: "Silo S3E1", title: "Silo", episode: "S3 E1", watchSec: 2520, plays: 1, viewers: ["Ann"] }] },
    week: { watchSec: 61200, plays: 19, people: [{ name: "Ann", watchSec: 30000, plays: 9 }, { name: "Bob", watchSec: 20000, plays: 6 }, { name: "Kim", watchSec: 11200, plays: 4 }],
      titles: [{ content: "Only Murders in the Building S2E10", title: "Only Murders in the Building", episode: "S2 E10", watchSec: 2480, plays: 1, viewers: ["Dana"] }] },
    recent: [
      { id: "s1", profile: "Ann", content: "Silo S3E2", title: "Silo", episode: "S3 E2", startedAt: iso(now - 21 * 60000), endedAt: null, watchedSec: 1250, position: 1260, duration: 2820, device: { device: "TV" }, live: true, state: "playing" },
      { id: "s2", profile: "Bob", content: "Inception", title: "Inception", episode: null, startedAt: iso(now - 3 * 3600000), endedAt: iso(now - 1.5 * 3600000), watchedSec: 5400, position: 5500, duration: 8888, device: { device: "Desktop" }, live: false },
    ],
    ...o,
  };
};
const stubActivity = async (page, first) => {
  let current = first;
  let asked = 0;
  await page.route("**/api/admin/activity", (route) => { asked++; return route.fulfill({ json: typeof current === "function" ? current() : current }); });
  return { set: (next) => { current = next; }, asked: () => asked };
};

ui.test("Activity: the numbers on top, who is watching, every screen, watch time today and this week, recent plays", { permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
  await stubActivity(page, fixture());
  await enter(page, srv);
  await openDetails(page, "ov-activity");
  await page.waitForFunction(() => document.querySelectorAll("#act-now > .act-card").length === 2);
  assert.equal(await page.textContent("#act-n-watching"), "1");
  assert.equal(await page.textContent("#act-n-paused"), "1");
  assert.equal(await page.textContent("#act-n-screens"), "3");
  assert.equal(await page.textContent("#act-n-screens-k"), "screens · 1 away");
  assert.equal(await page.textContent("#act-n-today"), "2h 42m");
  const cards = await page.locator("#act-now > .act-card").evaluateAll((cs) => cs.map((c) => [c.dataset.state, c.querySelector(".act-name").textContent, c.querySelector(".act-title b").textContent, c.querySelector(".act-title span").textContent, c.querySelector(".act-chip").textContent.trim()]));
  assert.deepEqual(cards, [["playing", "Ann", "Silo", "S3 E2", "Playing"], ["paused", "Kim", "Arrival", "Film", "Paused"]]);
  assert.match(await page.textContent('#act-now > [data-key="c-ann"] .sit'), /20 min this sitting/);
  const screens = await page.locator("#act-screens > .act-scr").evaluateAll((rs) => rs.map((r) => [r.dataset.p, r.querySelector(".two b").textContent, r.querySelector(".act-chip").textContent.trim()]));
  assert.deepEqual(screens, [["watching", "Ann", "Watching"], ["paused", "Kim", "Paused"], ["browsing", "Bob", "Browsing"], ["away", "Zed", "In the background"]]);
  assert.match(await page.textContent('#act-screens > [data-key="c-bob1"] .two .dl'), /2 tabs/);
  // watch time: today, then 7 days
  assert.equal(await page.textContent("#act-total"), "2 h 42 min");
  assert.deepEqual(await page.locator("#act-people .nm").allTextContents(), ["Bob", "Ann", "Kim"]);
  await page.click("#act-span-week");
  assert.equal(await page.getAttribute("#act-span-week", "aria-selected"), "true");
  assert.equal(await page.textContent("#act-total"), "17 h 00 min");
  assert.deepEqual(await page.locator("#act-people .nm").allTextContents(), ["Ann", "Bob", "Kim"]);
  assert.deepEqual(await page.locator("#act-titles .two b").allTextContents(), ["Only Murders in the Building"]);
  assert.match(await page.textContent("#act-titles .v"), /41m/);
  // recent plays
  const rec = await page.locator("#act-recent > .act-rec").evaluateAll((rs) => rs.map((r) => [r.dataset.live, r.querySelector(".when").textContent, r.querySelector(".got span").textContent]));
  assert.deepEqual(rec[0], ["1", "Now", "20 min of 47 min"]);
  assert.equal(rec[1][2], "1 h 30 min of 2 h 28 min");
  // the closed section's summary line says the state too
  assert.match(await page.textContent("#sub-ov-activity"), /^1 watching · 1 paused · 3 screens open · 2h 42m watched today$/);
  // Copy for Claude: the same answer as text
  await page.click('[data-copy-for="ov-activity"]');
  // (asked from here until the text is in: a waitForFunction whose function
  // is async is over at once — a promise counts as true — so the read after
  // it raced the copy, which asks the server first)
  let clip = "";
  for (let i = 0; i < 150 && !clip.startsWith("## Activity"); i++) {
    clip = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
    if (!clip.startsWith("## Activity")) await page.waitForTimeout(100);
  }
  assert.match(clip, /## Activity/);
  assert.match(clip, /Watch time counts only real play/);
  assert.match(clip, /\| Ann \| Silo S3 E2 \| playing \| 21:00 \/ 47:00 \| 20 min \|/);
  assert.match(clip, /\| Bob \| Chrome · Windows \(2 tabs\) \|/);
  await shot(page, "desktop", 'details.more[data-more="ov-activity"]');
});

ui.test("live: a screen that connects makes the page ask again; changes land in the same nodes; nothing on the page moves; no reload", async ({ page, srv }) => {
  const first = fixture();
  const stub = await stubActivity(page, first);
  await enter(page, srv);
  await openDetails(page, "ov-activity");
  await page.waitForFunction(() => document.querySelectorAll("#act-now > .act-card").length === 2);
  await page.waitForFunction(() => document.getElementById("act-live").dataset.on === "1");
  await page.evaluate(() => {
    window.__noReload = true;
    window.__shifts = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shifts.push(e.value); }).observe({ type: "layout-shift", buffered: false });
    window.__ann = document.querySelector('#act-now > [data-key="c-ann"]');
    window.__rect = () => [...document.querySelectorAll("#act-now > .act-card, #act-screens > .act-scr, #act-recent > .act-rec")].map((n) => { const r = n.getBoundingClientRect(); return [n.dataset.key, Math.round(r.top), Math.round(r.height), Math.round(r.width)]; });
    window.__before = window.__rect();
  });
  // the playing card's clock runs on by itself between answers
  const t0 = await page.textContent('#act-now > [data-key="c-ann"] .pos b');
  await page.waitForFunction((t) => document.querySelector('#act-now > [data-key="c-ann"] .pos b').textContent !== t, t0, { timeout: 4000 });
  assert.equal(await page.textContent('#act-now > [data-key="c-kim"] .pos b'), "1:05:12", "a paused one stands still");

  // the next answer: Kim plays again, Ann's sitting moved on, the same screens
  const asked = stub.asked();
  const next = fixture();
  next.now[1] = { ...next.now[1], state: "playing", posAt: Date.now() };
  next.now[0] = { ...next.now[0], position: 1330, sittingSec: 1320 };
  next.counts = { watching: 2, paused: 0, screens: 3, away: 1 };
  next.screens[1] = { ...next.screens[1], presence: "watching" };
  stub.set(next);
  // a real screen connecting is what makes the page ask (the admin socket's client_connected)
  const ws = new WebSocket(srv.url.replace(/^http/, "ws"));
  await new Promise((r) => ws.once("open", r));
  try {
    await page.waitForFunction((n) => document.getElementById("act-n-watching").textContent === "2", null, { timeout: 8000 });
    assert.ok(stub.asked() > asked, "asked again");
    assert.equal(await page.getAttribute('#act-now > [data-key="c-kim"]', "data-state"), "playing");
    assert.equal(await page.textContent('#act-screens > [data-key="c-kim"] .act-chip'), "Watching");
    assert.ok(await page.evaluate(() => window.__ann === document.querySelector('#act-now > [data-key="c-ann"]')), "Ann's card is the same node, updated in place");
    assert.ok(await page.evaluate(() => window.__noReload === true), "no reload");
    await page.waitForTimeout(2500); // a few clock ticks more
    const after = await page.evaluate(() => window.__rect());
    const before = await page.evaluate(() => window.__before);
    assert.deepEqual(after, before, "every row where it was, the same size");
    const shifts = await page.evaluate(() => window.__shifts);
    assert.equal(shifts.reduce((a, b) => a + b, 0), 0, `layout shifts: ${shifts.join(", ")}`);
  } finally { ws.close(); }
});

ui.test("the real thing: screens over the socket show up, play, pause and leave — live", async ({ page, srv }) => {
  await enter(page, srv);
  await openDetails(page, "ov-activity");
  await page.waitForFunction(() => document.getElementById("act-live").dataset.on === "1");
  const ws = new WebSocket(srv.url.replace(/^http/, "ws"));
  await new Promise((r) => ws.once("message", r)); // welcome
  ws.send(JSON.stringify({ type: "hello", profile: "Tester", app: "tv", build: "Aurora TV 5.8.4", model: "Test TV", hb: 60 }));
  let pos = 100;
  const report = (playing) => ws.send(JSON.stringify({ type: "activity", action: "Watching", details: "Test Show S1E2", position: playing ? (pos += 5) : pos, duration: 45, played: playing ? 5 : 0, state: playing ? "playing" : "paused", rate: 1, visible: true }));
  try {
    report(true);
    await page.waitForFunction(() => [...document.querySelectorAll("#act-now .act-name")].some((n) => n.textContent === "Tester"), null, { timeout: 8000 });
    assert.equal(await page.textContent("#act-now > .act-card .act-title b"), "Test Show");
    assert.equal(await page.textContent("#act-now > .act-card .act-title span"), "S1 E2");
    assert.equal(await page.textContent("#act-now > .act-card .act-dev span"), "Aurora TV 5.8.4 · Test TV");
    report(false);
    await page.waitForFunction(() => document.querySelector("#act-now > .act-card").dataset.state === "paused", null, { timeout: 8000 });
    assert.equal(await page.textContent("#act-n-paused"), "1");
    ws.close();
    await page.waitForFunction(() => document.querySelectorAll("#act-now > .act-card").length === 0, null, { timeout: 8000 });
    assert.equal(await page.isVisible("#act-now-empty"), true);
  } finally { try { ws.close(); } catch {} }
});

ui.test("phone width: the Activity section fits the screen", { viewport: PHONE }, async ({ page, srv }) => {
  await stubActivity(page, fixture());
  await enter(page, srv);
  await openDetails(page, "ov-activity");
  await page.waitForFunction(() => document.querySelectorAll("#act-screens > .act-scr").length === 4);
  await assertNoHorizontalOverflow(page, "Activity on a phone");
  const strip = await page.locator(".act-strip").boundingBox();
  assert.ok(strip.width <= PHONE.width, "the strip fits");
  for (const sel of ["#act-now > .act-card", "#act-screens > .act-scr", "#act-recent > .act-rec", ".act-col"]) {
    const wide = await page.locator(sel).evaluateAll((ns) => ns.filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).length);
    assert.equal(wide, 0, `${sel} inside the screen`);
  }
  await page.evaluate(() => { const el = document.querySelector('details.more[data-more="ov-activity"]'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 60); });
  await shot(page, "phone");
});

ui.run({ concurrency: 1 });
