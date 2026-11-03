// The calm admin (2026-11-03, elia: "I should not scroll for 20 seconds just
// to reach the restart btn … I only care to see if everything works … all
// other stats I only need the option to copy them to you"):
//   - one state on top: Everything works / N things need you / Down
//   - Restart reachable without scrolling, on every screen, desktop and phone
//   - everything else under "Details", closed by default, each with a Copy for Claude
//   - the downloads list does not move when its numbers tick
// The state is stubbed (GET /api/admin/summary) — its rules are pinned in
// test/adminsummary.test.js; the private instance is healthy and a fault
// cannot be staged from here.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { suite, openDetails, PHONE, DESKTOP } = require("./helpers");

const SHOTS = path.join(__dirname, "artifacts", "admin-simple");
const ui = suite();

const enter = async (page, srv, hash = "") => {
  await page.goto(`${srv.url}/admin${hash}`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const area = (id, label, line, level = "ok") => ({ id, label, line, level });
const AREAS = [
  area("site", "Site", "up 3 d 4 h · v1.15.7 · kept running by keeper"),
  area("playback", "Playback", "2 watching now · 41 plays today · starts in 1.8 s"),
  area("streaming", "Streaming", "1 encoding · 25 % of capacity · answers at once"),
  area("disk", "Disk", "812 GB free"),
  area("downloads", "Downloads", "1 downloading · 4.0 MB/s"),
];
const WAITING = { people: [], resets: [], downloads: [], reports: 0, requests: 0, update: null };
const works = (o = {}) => ({
  at: Date.now(), version: "1.15.7", uptimeSec: 3 * 86400, state: "works", headline: "Everything works", reason: "People can watch normally.", fix: null,
  needs: [], minor: [
    { id: "health:backup-stale", area: "data", title: "Backups", why: "There has been no working backup for 2 d." },
    { id: "loop", area: "site", title: "The server is slow to answer", why: "Requests wait up to 240 ms (p99) before they are handled." },
  ],
  areas: AREAS, waiting: WAITING, restart: { supervised: true, by: "keeper" }, ...o,
});
const needsYou = () => works({
  state: "needs-you", headline: "1 thing needs you",
  reason: "A drive is almost full: 2.0 GB free on D:\\Movies. Downloads and recordings fail when it runs out.",
  fix: { label: "Free up space", kind: "tab", tab: "downloads", more: "d-disk" },
  needs: [{ id: "disk", area: "disk", title: "A drive is almost full", why: "2.0 GB free on D:\\Movies. Downloads and recordings fail when it runs out.", fix: { label: "Free up space", kind: "tab", tab: "downloads", more: "d-disk" } }],
  areas: AREAS.map((a) => (a.id === "disk" ? { ...a, line: "2.0 GB free", level: "bad" } : a)),
});
const stubSummary = async (page, body) => {
  let current = body;
  await page.unroute("**/api/admin/summary").catch(() => {});
  await page.route("**/api/admin/summary", (route) => (typeof current === "function" ? current(route) : route.fulfill({ json: current })));
  return (next) => { current = next; };
};
const SCREENS = [["overview"], ["moderation"], ["downloads"], ["profiles"], ["analytics"], ["analytics", "telemetry"], ["analytics", "history"], ["server"], ["server", "actions"], ["server", "logs"]];
const open = async (page, tab, sub) => {
  await page.click(`.tab[data-tab="${tab}"]`);
  if (sub) await page.click(`#subtabs [data-sub="${sub}"]`);
  await page.waitForFunction((t) => document.getElementById(`pane-${t}`).classList.contains("active"), sub || tab);
};

ui.test("Everything works: one calm line on top, five lines on whether people can watch, the minor notes only when asked for", async ({ page, srv }) => {
  await stubSummary(page, works());
  await enter(page, srv);
  await page.waitForFunction(() => document.getElementById("sum").dataset.state === "works");
  assert.equal(await page.textContent("#sum-headline"), "Everything works");
  assert.equal(await page.textContent("#sum-reason"), "People can watch normally.");
  assert.ok(await page.locator("#sum-fix").evaluate((b) => b.classList.contains("hidden")), "nothing to fix: no button");
  assert.equal(await page.getAttribute("#hstate", "data-state"), "works");
  assert.equal(await page.textContent("#hstate-long"), "Everything works");
  const areas = await page.locator("#sum-areas .sum-area").evaluateAll((els) => els.map((e) => [e.dataset.area, e.dataset.level, e.innerText.replace(/\s+/g, " ").trim()]));
  assert.deepEqual(areas.map((a) => a[0]), ["site", "playback", "streaming", "disk", "downloads"]);
  assert.ok(areas.every((a) => a[1] === "ok"));
  assert.match(areas[1][2], /PLAYBACK 2 watching now · 41 plays today/i);
  // minor notes: counted, not shown, never red
  assert.equal(await page.textContent("#sum-minor-btn"), "2 minor notes");
  assert.equal(await page.locator("#sum-minor").isVisible(), false);
  assert.doesNotMatch(await page.innerText("#sum"), /Backups|slow to answer/);
  await page.click("#sum-minor-btn");
  await page.waitForSelector("#sum-minor .sum-item");
  assert.match(await page.innerText("#sum-minor"), /Backups[\s\S]*no working backup for 2 d[\s\S]*slow to answer/);
  assert.equal(await page.getAttribute("#sum", "data-state"), "works", "a minor note does not change the state");
  await shot(page, "works-desktop");
});

ui.test("1 thing needs you: the reason in one line and the button that fixes it — it lands on the right Details, opened", async ({ page, srv }) => {
  await stubSummary(page, needsYou());
  await enter(page, srv);
  await page.waitForFunction(() => document.getElementById("sum").dataset.state === "needs-you");
  assert.equal(await page.textContent("#sum-headline"), "1 thing needs you");
  assert.match(await page.textContent("#sum-reason"), /^A drive is almost full: 2\.0 GB free on D:\\Movies/);
  assert.equal(await page.getAttribute('#sum-areas [data-area="disk"]', "data-level"), "bad");
  assert.equal(await page.getAttribute("#hstate", "data-state"), "needs-you");
  assert.equal(await page.textContent("#hstate-long"), "1 thing needs you");
  await shot(page, "needs-you-desktop");
  // the header says it on every other screen too
  await open(page, "server");
  assert.equal(await page.getAttribute("#hstate", "data-state"), "needs-you");
  await open(page, "overview");
  await page.click("#sum-fix");
  await page.waitForFunction(() => document.getElementById("pane-downloads").classList.contains("active"));
  await page.waitForFunction(() => document.querySelector('details.more[data-more="d-disk"]').open);
  // and the header pill goes back to Home
  await page.click("#hstate");
  await page.waitForFunction(() => document.getElementById("pane-overview").classList.contains("active"));
});

ui.test("Down: two unanswered checks in a row say so, with Try again; when it answers again it is back", { allow: [/Failed to load resource/] }, async ({ page, srv }) => {
  const set = await stubSummary(page, works());
  await enter(page, srv);
  await page.waitForFunction(() => document.getElementById("sum").dataset.state === "works");
  set((route) => route.abort("connectionrefused"));
  await page.evaluate(() => loadSummary());
  // one miss is a blip: nothing changes yet, it asks again by itself
  assert.equal(await page.getAttribute("#sum", "data-state"), "works");
  await page.waitForFunction(() => document.getElementById("sum").dataset.state === "down", null, { timeout: 10000 });
  assert.equal(await page.textContent("#sum-headline"), "Aurora is not answering");
  assert.match(await page.textContent("#sum-reason"), /No answer since \d\d:\d\d:\d\d\. The keeper starts it again by itself within a minute/);
  assert.equal(await page.textContent("#sum-fix"), "Try again");
  assert.equal(await page.getAttribute("#hstate", "data-state"), "down");
  assert.equal(await page.textContent("#hstate-long"), "Down");
  assert.ok(await page.locator("#sum-areas .sum-area").count() === 5, "the last lines stay, greyed");
  await shot(page, "down-desktop");
  set(works());
  await page.click("#sum-fix");
  await page.waitForFunction(() => document.getElementById("sum").dataset.state === "works");
  assert.equal(await page.getAttribute("#hstate", "data-state"), "works");
});

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`Restart is on screen without scrolling on every screen, and asks before it does anything (${name})`, { viewport }, async ({ page, srv }) => {
    await stubSummary(page, works());
    const posts = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/update\/restart/.test(r.url())) posts.push(r.url()); });
    await enter(page, srv);
    for (const [tab, sub] of SCREENS) {
      await open(page, tab, sub);
      await page.evaluate(() => scrollTo(0, 0));
      const box = await page.locator("#restart-btn").boundingBox();
      const vh = await page.evaluate(() => innerHeight);
      assert.ok(box && box.y >= 0 && box.y + box.height <= vh, `${tab}${sub ? "/" + sub : ""}: Restart at ${box && box.y}–${box && box.y + box.height} of ${vh}`);
      assert.ok(await page.locator("#restart-btn").isVisible());
      assert.ok(await page.locator("#hstate").isVisible(), "the state is beside it");
      const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(sw <= 1, `${tab}${sub ? "/" + sub : ""}: the page scrolls sideways by ${sw}px`);
    }
    await open(page, "overview");
    await page.click("#restart-btn");
    const ask = page.locator("dialog.ask");
    await ask.waitFor();
    assert.match(await ask.innerText(), /Restart Aurora now\?/);
    assert.match(await ask.locator(".ask-yes").innerText(), /Yes, restart/);
    await ask.locator(".ask-no").click();
    await page.waitForTimeout(300);
    assert.deepEqual(posts, [], "Never mind restarts nothing");
    await shot(page, `restart-ask-${name}`);
    // the summary is above the fold too, on Home
    const sum = await page.locator("#sum-headline").boundingBox();
    assert.ok(sum.y + sum.height <= (await page.evaluate(() => innerHeight)));
  });
}

ui.test("every Details is closed when the page opens, and loads only once it is opened", async ({ page, srv }) => {
  await stubSummary(page, works());
  const asked = new Set();
  page.on("request", (r) => asked.add(new URL(r.url()).pathname));
  await enter(page, srv);
  for (const [tab, sub] of SCREENS) {
    await open(page, tab, sub);
    await page.waitForTimeout(250);
  }
  const all = await page.locator("details.more").evaluateAll((ds) => ds.map((d) => [d.dataset.more, d.open]));
  assert.ok(all.length >= 30, `${all.length} Details`);
  assert.deepEqual(all.filter(([, o]) => o), [], "nothing is open by default");
  // closed sections asked the server nothing
  for (const p of ["/api/admin/healer", "/api/admin/metrics", "/api/admin/analytics", "/api/admin/usage", "/api/admin/telemetry", "/api/admin/sessions", "/api/admin/library/tree", "/api/admin/backups"]) {
    assert.ok(![...asked].some((a) => a.startsWith(p)), `${p} was asked for while its Details was closed`);
  }
  // each has a title, a line of what is inside, and (but one) a Copy for Claude
  const rows = await page.locator("details.more > summary").evaluateAll((ss) => ss.map((s) => [s.querySelector(".more-t b").textContent.trim(), s.querySelector(".more-sub").textContent.trim(), !!s.querySelector("[data-copy-for]")]));
  for (const [t, sub] of rows) assert.ok(t && sub, `${t}: ${sub}`);
  assert.equal(rows.filter((r) => !r[2]).map((r) => r[0]).join(), "Maintenance", "only Maintenance has nothing to copy");
  // opening one loads it
  await open(page, "server");
  const healer = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/healer");
  await openDetails(page, "sv-healer");
  await healer;
  await page.waitForSelector("#hl-checks .hl-group");
  // the Copy button inside a row copies; it does not fold the row
  await page.click('details.more[data-more="sv-env"] [data-copy-for="sv-env"]');
  assert.equal(await page.locator('details.more[data-more="sv-env"]').evaluate((d) => d.open), false);
});

ui.test("Copy for Claude: the state, one section, and everything — plain markdown with the numbers", { permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
  await stubSummary(page, needsYou());
  const job = { id: "aaaaaaaaaaa1", title: "The Long Film", label: "The Long Film (2021)", type: "movie", quality: "1080p", sizeBytes: 8.2e9, status: "downloading", phase: "downloading", progress: 0.31, downloadSpeed: 4.1 * 1024 ** 2, by: "Anna", at: new Date().toISOString() };
  await page.route("**/api/downloads", (route) => route.fulfill({ json: [job, { ...job, id: "aaaaaaaaaaa2", label: "Big Film (2024)", status: "pending", holdReason: "Held back: under 10% free" }] }));
  await enter(page, srv);
  await page.waitForFunction(() => document.getElementById("sum").dataset.state === "needs-you");
  // (Windows hands the clipboard back with CRLF line ends)
  const clip = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  const toasted = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("toasts").innerText), re.source);

  await page.click('#sum [data-copy-for="summary"]');
  await toasted(/Copied for Claude/);
  const s = await clip();
  assert.match(s, /^## Aurora — 1 thing needs you\n_Aurora admin · .+ · v1\.15\.7_\n/);
  assert.match(s, /- NEEDS YOU · Disk · A drive is almost full: 2\.0 GB free on D:\\Movies\. .*\(fix: Free up space\)/);
  assert.match(s, /- Playback: 2 watching now · 41 plays today · starts in 1\.8 s/);
  assert.match(s, /- Disk: 2\.0 GB free \(broken\)/);
  assert.match(s, /Minor notes \(2\):\n- Data · Backups: There has been no working backup for 2 d\./);
  assert.match(s, /Waiting for a person: 0 to let in, 0 password resets, 0 downloads to approve, 0 open reports, 0 title requests/);

  await open(page, "downloads");
  await page.click('[data-copy-for="d-flight"]');
  await toasted(/Copied for Claude/);
  const d = await clip();
  assert.match(d, /^## Downloads in flight\n_Aurora admin · .+_\n\n\| title \| by \| state \| done \| size \| speed \| left \| note \|\n\|---\|/);
  assert.match(d, /\| The Long Film \(2021\) \| Anna \| downloading \| 31% \| 7\.6 GB \| 4\.1 MB\/s \| ~\d+m left \|  \|/);
  assert.match(d, /Waiting for approval:\n\| title \| by \| size \| why held \|[\s\S]*Big Film \(2024\) \| Anna \| 7\.6 GB \| Held back: under 10% free/);

  await open(page, "overview");
  await page.click("#copy-all");
  await page.waitForFunction(() => /Everything copied for Claude/.test(document.getElementById("toasts").innerText), null, { timeout: 30000 });
  const all = await clip();
  assert.match(all, /^# Aurora admin — everything\n/);
  for (const h of ["## Aurora — 1 thing needs you", "## Activity", "## Problem reports (open)", "## Downloads in flight", "## On disk", "## People", "## Watching", "## How Aurora is used", "## Errors on people's devices", "## Healer", "## Health", "## Encoding", "## Environment", "## Backups", "## Server log (warnings and errors)"]) {
    assert.ok(all.includes(h + "\n"), `${h} is in Copy everything`);
  }
  assert.ok(!/## Maintenance/.test(all), "nothing to copy, not copied");
  assert.ok(!/undefined|\[object Object\]|NaN/.test(all), all.match(/.{0,60}(undefined|\[object Object\]|NaN).{0,60}/));
  // App health's three sections share one report: it is in there once
  assert.equal(all.split("Errors and warnings from devices").length - 1 <= 2, true);
});

ui.test("someone waiting shows on Home with its buttons: Approve there makes the profile", async ({ page, srv, api }) => {
  await api.requestProfile("Wren");
  await enter(page, srv);
  const row = page.locator("#wait-list .wait-row", { hasText: "Wren wants to join" });
  await row.waitFor();
  assert.match(await row.innerText(), /Wren Tester/);
  assert.equal(await page.textContent("#badge-profiles"), "1");
  await row.locator("[data-req-ok]").click();
  await page.waitForFunction(() => /Approved "Wren"/.test(document.getElementById("toasts").innerText));
  await page.waitForFunction(() => !/Wren wants to join/.test(document.getElementById("wait-list").innerText));
  assert.ok((await api.profiles()).some((p) => p.name === "Wren"));
});

// ---------- the downloads list does not move while it ticks ----------
const flightJobs = (t) => {
  const at = new Date(Date.now() - 3600e3).toISOString();
  const speeds = [96 * 1024, 12.6 * 1024 ** 2, 0, 812 * 1024, 4.1 * 1024 ** 2];
  const phase = ["downloading", "verifying", "copying", "downloading", "downloading"][t % 5];
  return [
    { id: "aaaaaaaaaaa1", title: "The Long Film", label: "The Long Film (2021)", type: "movie", quality: "1080p", sizeBytes: 8.2e9, status: "downloading", phase: "downloading", progress: 0.31 + t * 0.017, downloadSpeed: speeds[t % 5], by: "Anna", at },
    { id: "aaaaaaaaaaa2", title: "Test Show", label: "Test Show · S2 E4 — a long episode title that runs on and on past the edge", type: "show", quality: "720p", sizeBytes: 1.1e9, status: "downloading", phase, copyProgress: phase === "copying" ? 0.34 : null, progress: 0.72 + t * 0.02, downloadSpeed: speeds[(t + 2) % 5], by: "Ben", at },
    {
      id: "aaaaaaaaaaa3", title: "Slow Film", label: "Slow Film", type: "movie", quality: "1080p", sizeBytes: 4e9, status: "downloading", phase: "downloading", progress: 0.12 + t * 0.004, downloadSpeed: speeds[(t + 1) % 5], by: "Anna", at,
      race: { state: "racing", why: "projected to take 6.8 h more", attempts: [
        { role: "original", provider: "FirstProvider", progress: 0.12 + t * 0.004, downloadSpeed: speeds[(t + 1) % 5], etaSec: 24500 - t * 900 },
        { role: "challenger", provider: "SecondProvider", progress: 0.03 + t * 0.05, downloadSpeed: speeds[(t + 3) % 5], etaSec: t % 2 ? 930 : 86000 },
      ] },
    },
    { id: "aaaaaaaaaaa4", title: "Queued Film", label: "Queued Film (2019)", type: "movie", sizeBytes: 3.4e9, status: "approved", progress: 0, downloadSpeed: 0, at },
  ];
};
for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`In flight does not move across ticks: same height, same rows, no layout shift (${name})`, { viewport }, async ({ page, srv }) => {
    await stubSummary(page, works());
    let tick = 0;
    await page.route("**/api/downloads", (route) => route.fulfill({ json: flightJobs(tick) }));
    await enter(page, srv);
    await open(page, "downloads");
    await page.waitForSelector("#dl-jobs .fl-row");
    // the list in the middle of the screen, the way it is read (a layout
    // shift only counts on screen; the old panel scored about 1.1 here on a phone)
    await page.evaluate(() => scrollBy(0, document.querySelector("#dl-jobs").getBoundingClientRect().top - 200));
    await page.waitForTimeout(700); // (the first paint and the bars' first ease settle)
    await page.evaluate(() => {
      window.__shift = 0;
      window.__shifts = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) { window.__shift += e.value; window.__shifts.push(e.sources ? e.sources.map((s) => s.node && (s.node.className || s.node.nodeName)).join(",") : ""); }
      }).observe({ type: "layout-shift", buffered: false });
    });
    const measure = () => page.evaluate(() => ({
      flight: Math.round(document.getElementById("dl-flight").getBoundingClientRect().height * 10) / 10,
      page: document.documentElement.scrollHeight,
      rows: [...document.querySelectorAll("#dl-jobs .fl-row")].map((r) => { const b = r.getBoundingClientRect(); return [r.dataset.dlId, Math.round(b.top * 10) / 10, Math.round(b.height * 10) / 10]; }),
      details: document.querySelector(".mores-h").getBoundingClientRect().top,
    }));
    const first = await measure();
    await page.evaluate(() => { for (const r of document.querySelectorAll("#dl-jobs .fl-row")) r.__first = true; });
    for (tick = 1; tick <= 10; tick++) {
      await page.evaluate(() => loadDownloads());
      await page.waitForTimeout(120);
      const now = await measure();
      assert.deepEqual(now, first, `tick ${tick}: the panel moved`);
    }
    // the rows are the same elements, updated in place
    assert.ok(await page.evaluate(() => [...document.querySelectorAll("#dl-jobs .fl-row")].every((r) => r.__first === true)), "the same row elements, never rebuilt");
    await page.waitForTimeout(300);
    const shift = await page.evaluate(() => window.__shift);
    console.log(`[admin-simple] ${name}: cumulative layout shift over 10 ticks = ${shift}`);
    assert.equal(shift, 0, `layout shift ${shift}: ${await page.evaluate(() => window.__shifts.join(" | "))}`);
    // the numbers did change
    assert.match(await page.innerText("#dl-jobs"), /copying 34%|verifying|downloading/);
    await page.locator("#dl-flight").screenshot({ path: path.join(fs.mkdirSync(SHOTS, { recursive: true }) || SHOTS, `flight-${name}.png`) });
  });
}

// downloads-v2 (docs/downloads-v2.md §5, branch downloads-v2): the new fields
// show only when the server sends them — and an older server's jobs still read.
ui.test("In flight reads the downloads-v2 fields: stalled, switching, paused for the next episode, waiting for a copy, the priority, the copy count, the sentence", async ({ page, srv }) => {
  await stubSummary(page, works());
  const at = new Date().toISOString();
  const base = { type: "movie", quality: "1080p", sizeBytes: 3e9, status: "downloading", phase: "downloading", progress: 0.4, downloadSpeed: 1e6, at };
  const retryAt = new Date(Date.now() + 40 * 60000).toISOString();
  await page.route("**/api/downloads", (route) => route.fulfill({ json: [
    { ...base, id: "v2aaaaaaaaa1", label: "Stalled Film", downloadSpeed: 0, health: { state: "stalled", code: "no-bytes", why: "no one is sharing it right now", countsAsRunning: false, since: at }, priority: { cls: 1, base: 1, label: "Asked for", urgent: false }, note: "No one is sharing it right now — Aurora keeps looking." },
    { ...base, id: "v2aaaaaaaaa2", label: "Dead Film", health: { state: "dead", code: "unavailable", why: "no one was sharing it", since: at }, sources: { tried: 2, max: 4, retries: 1, given: [{ infoHash: "x", release: "Dead.Film.2020.1080p.WEB", quality: "1080p", why: "no one was sharing it" }] } },
    { ...base, id: "v2aaaaaaaaa3", label: "Next Show · S2 E3", priority: { cls: 0, base: 2, label: "Watching now", urgent: true }, health: { state: "ok", code: "ok", why: "", since: at } },
    { ...base, id: "v2aaaaaaaaa4", label: "Held Film", heldBack: { since: at, for: "Next Show · S2 E3" }, priority: { cls: 3, base: 3, label: "Background", urgent: false } },
    { ...base, id: "v2aaaaaaaaa5", label: "Lost Film", status: "approved", progress: 0, downloadSpeed: 0, retryAt },
    { ...base, id: "v2aaaaaaaaa6", label: "Old Server Film" },
  ] }));
  await page.route("**/api/admin/aria2-limits", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const body = await (await route.fetch()).json();
    body.slots = { ...body.slots, maxActive: 4, counted: 3, notCounted: 2 };
    await route.fulfill({ json: body });
  });
  await enter(page, srv);
  await open(page, "downloads");
  await page.waitForSelector('#dl-jobs .fl-row[data-dl-id="v2aaaaaaaaa6"]');
  const row = (id) => page.locator(`#dl-jobs .fl-row[data-dl-id="${id}"]`);
  const state = (id) => row(id).locator(".fl-state").innerText();
  assert.equal(await state("v2aaaaaaaaa1"), "stalled");
  assert.equal(await row("v2aaaaaaaaa1").locator(".fl-state").getAttribute("title"), "no one is sharing it right now");
  assert.match(await row("v2aaaaaaaaa1").locator(".fl-note").innerText(), /No one is sharing it right now — Aurora keeps looking\./);
  assert.match(await row("v2aaaaaaaaa1").locator(".fl-by").innerText(), /Asked for/);
  assert.equal(await state("v2aaaaaaaaa2"), "switching copy");
  assert.match(await row("v2aaaaaaaaa2").locator(".fl-note").innerText(), /no one is sharing this copy — moving to the next one \(no one was sharing it\)/);
  assert.match(await row("v2aaaaaaaaa2").locator(".fl-by").innerText(), /copy 2 of 4/);
  assert.match(await row("v2aaaaaaaaa2").locator(".fl-note").innerText(), /gave up on: Dead\.Film\.2020\.1080p\.WEB \(no one was sharing it\)/);
  assert.equal(await state("v2aaaaaaaaa3"), "downloading");
  assert.equal(await row("v2aaaaaaaaa3").locator(".fl-by .pill.live").innerText(), "Watching now");
  assert.equal(await state("v2aaaaaaaaa4"), "paused");
  assert.match(await row("v2aaaaaaaaa4").locator(".fl-note").innerText(), /paused for “Next Show · S2 E3”, which goes first/);
  assert.equal(await state("v2aaaaaaaaa5"), "waiting for a copy");
  assert.match(await row("v2aaaaaaaaa5").locator(".fl-note").innerText(), /no copy could be found yet — tries again at \d\d:\d\d/);
  assert.equal(await state("v2aaaaaaaaa6"), "downloading", "an older server's job");
  assert.equal(await row("v2aaaaaaaaa6").locator(".fl-note").innerText(), "");
  assert.equal(await row("v2aaaaaaaaa1").getAttribute("data-tone"), "warn");
  await page.waitForFunction(() => /3 of 4 running \+ 2 stalled, still looking/.test(document.getElementById("dl-hold").textContent));
  await page.locator("#dl-flight").screenshot({ path: path.join(fs.mkdirSync(SHOTS, { recursive: true }) || SHOTS, "flight-v2-states.png") });
});

ui.run({ concurrency: 1 });
