// Admin → Downloads: WHO asked for every download and WHEN (elia 2026-11-08:
// "I need to see on downloads which user has downloaded what … and when").
// In flight and Needs you say who and "asked 2h ago" (the date as tooltip);
// Finished says who and "landed Nov 6, 21:14" (how long ago as tooltip); the
// On-disk rows that came from a download say who downloaded them and when.
// Smart downloads and followed shows read "Automatic" with whose they were;
// old records with nobody or no time recorded read "Unknown", never a guess.
// A chip per person filters the lists, "Who downloaded what" (behind Details)
// has a line per person, and Copy for Claude carries all of it. Dates are in
// the household's clock: the server's time zone (GET /api/admin/summary
// `clock`), English words whatever the server's language.
//
// The page is handed a made-up queue (GET /api/downloads) and library (GET
// /api/admin/library/tree); everything else is the private instance's.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, openDetails, assertNoHorizontalOverflow, PHONE } = require("./helpers");

const ui = suite({});
const DESK = { width: 1440, height: 900 };
const SHOTS = process.env.WHO_SHOTS || path.join(os.tmpdir(), "aurora-agents", "storage-drives-who", "shots");
const shot = async (page, name, el = null) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (el ? page.locator(el) : page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const GB = 1024 ** 3;
const TZ = "Asia/Jerusalem";
const ago = (ms) => new Date(Date.now() - ms).toISOString();
// "Nov 8" for now, in the household's zone (the per-person lines' "last …")
const today = () => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date());

const base = { type: "movie", quality: "1080p", sizeBytes: GB, progress: 0, downloadSpeed: 0, alsoBy: [], auto: null };
const JOBS = () => [
  { ...base, id: "fl1", label: "Flight One", status: "downloading", phase: "downloading", progress: 0.4, downloadSpeed: 2e6, by: "Niso", at: ago(2 * 3600e3 + 60e3) },
  { ...base, id: "fl2", label: "Next Show · S1 E3", type: "show", status: "downloading", phase: "downloading", progress: 0.1, by: "Niso", smart: true, auto: "next", at: ago(30 * 60e3) },
  // an old record: nobody and no time were kept
  { ...base, id: "fl3", label: "Queued Unknown", status: "approved", by: null },
  { ...base, id: "pe1", label: "Dor Film", status: "pending", holdReason: "Held back: under 10% free", by: "Dor", at: ago(3 * 3600e3 + 60e3) },
  { ...base, id: "dn1", label: "Niso Film", status: "done", progress: 1, sizeBytes: 4 * GB, by: "Niso", at: "2026-11-06T17:00:00.000Z", doneAt: "2026-11-06T19:14:00.000Z", libraryId: "mov1" },
  { ...base, id: "dn2", label: "Some Show · S1 E1", type: "show", status: "done", progress: 1, by: "Dor", smart: true, auto: "follow", at: "2026-11-05T07:00:00.000Z", doneAt: "2026-11-05T08:05:00.000Z", libraryId: "ep1" },
  { ...base, id: "dn3", label: "Some Show · S1 E2", type: "show", status: "done", progress: 1, sizeBytes: 2 * GB, by: "Niso", alsoBy: ["Dor"], at: "2026-11-07T18:00:00.000Z", doneAt: "2026-11-07T20:00:00.000Z", libraryId: "ep2" },
  { ...base, id: "er1", label: "Broken Film", status: "error", error: "no source", by: null },
];
const TREE = {
  movies: [
    { id: "mov1", title: "Niso Film", year: 2020, cover: null, sizeBytes: 4 * GB, addedAt: Date.parse("2026-11-06T19:14:00Z"), watched: 0 },
    { id: "mov2", title: "Hand Film", year: 2001, cover: null, sizeBytes: 3 * GB, addedAt: Date.parse("2026-01-01T00:00:00Z"), watched: 0 },
  ],
  shows: [{
    id: "sh1", title: "Some Show", cover: null, sizeBytes: 3 * GB, addedAt: Date.parse("2026-11-07T20:00:00Z"),
    seasons: [{ season: 1, sizeBytes: 3 * GB, episodes: [
      { id: "ep1", season: 1, episode: 1, title: "Pilot", fileName: "Some Show S01E01.mkv", sizeBytes: GB, watched: 0 },
      { id: "ep2", season: 1, episode: 2, title: "Second", fileName: "Some Show S01E02.mkv", sizeBytes: 2 * GB, watched: 0 },
    ] }],
  }],
  totalBytes: 10 * GB,
  disk: { free: 400 * GB, total: 512 * GB },
};

const stub = async (page, locale = "en-US") => {
  await page.route("**/api/downloads", (route) => route.fulfill({ json: JOBS() }));
  await page.route((u) => u.pathname === "/api/admin/library/tree", (route) => route.fulfill({ json: TREE }));
  await page.route((u) => u.pathname === "/api/admin/summary", async (route) => {
    const body = await (await route.fetch()).json();
    body.clock = { tz: TZ, locale, hourCycle: "h23" };
    await route.fulfill({ json: body });
  });
};
const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.waitForFunction(() => typeof HOUSE_CLOCK !== "undefined" && HOUSE_CLOCK && HOUSE_CLOCK.tz);
  await page.click('.tab[data-tab="downloads"]');
  await page.waitForSelector('#dl-jobs .fl-row[data-dl-id="fl3"]');
};
const flight = (page, id) => page.locator(`#dl-jobs .fl-row[data-dl-id="${id}"]`);
const done = (page, id) => page.locator(`#dl-done tr[data-dl-id="${id}"]`);
const chip = (page, key) => page.locator(`#dl-who-chips [data-dl-who="${key}"]`);
const shown = (page) => page.evaluate(() => ({
  flight: [...document.querySelectorAll("#dl-jobs .fl-row")].map((r) => r.dataset.dlId),
  done: [...document.querySelectorAll("#dl-done tr")].map((r) => r.dataset.dlId),
  pending: document.getElementById("dl-needs").classList.contains("hidden") ? [] : [...document.querySelectorAll("#dl-pending .now-card .name")].map((n) => n.textContent),
}));

for (const [name, viewport, locale] of [["desktop", DESK, "en-US"], ["phone", PHONE, "he-IL"]]) {
  ui.test(`who and when on every list, Automatic, Unknown, the person chips and lines (${name}, server locale ${locale})`, { viewport }, async ({ page, srv }) => {
    await stub(page, locale);
    await enter(page, srv);

    // IN FLIGHT: who, and "asked … ago" with the date as its tooltip
    assert.equal(await flight(page, "fl1").locator(".fl-who").innerText(), "Niso · asked 2h ago");
    assert.match(await flight(page, "fl1").locator(".fl-who .dl-when").getAttribute("title"), /^[A-Z][a-z]{2} \d+, \d\d:\d\d$/);
    assert.equal(await flight(page, "fl2").locator(".fl-who").innerText(), "Automatic · Niso's next episode · asked 30m ago");
    assert.equal(await flight(page, "fl3").locator(".fl-who").innerText(), "Unknown · asked: Unknown");
    // NEEDS YOU: who and when
    const card = page.locator("#dl-pending .now-card", { hasText: "Dor Film" });
    assert.equal(await card.locator(".dl-whowhen").innerText(), "Dor · asked 3h ago");
    // FINISHED: who, and "landed Nov 6, 21:14" in the household's zone (19:14 UTC), how long ago as its tooltip
    await openDetails(page, "d-done");
    assert.equal(await done(page, "dn1").locator(".dl-who").innerText(), "Niso");
    assert.match(await done(page, "dn1").locator(".dl-end").innerText(), /^landed Nov 6(, 2026)?, 21:14$/);
    assert.match(await done(page, "dn1").locator(".dl-end .dl-when").getAttribute("title"), /^\d+d ago · asked Nov 6(, 2026)?, 19:00$/);
    assert.equal(await done(page, "dn2").locator(".dl-who").innerText(), "Automatic · a new episode of a show Dor follows");
    assert.match(await done(page, "dn2").locator(".dl-end").innerText(), /^landed Nov 5(, 2026)?, 10:05$/);
    assert.equal(await done(page, "dn3").locator(".dl-who").innerText(), "Niso + Dor");
    assert.equal(await done(page, "er1").locator(".dl-who").innerText(), "Unknown");
    assert.equal(await done(page, "er1").locator(".dl-end").innerText(), "failed: Unknown");

    // ON DISK: the rows that came from a download say who and when; the rest say nothing
    await openDetails(page, "d-disk");
    await page.waitForSelector("#lib-tree .lib-dl");
    const movie = (t) => page.locator("#lib-tree > .lib-row", { hasText: t });
    assert.match(await movie("Niso Film").locator(".lib-dl").innerText(), /^↓\sNiso · Nov 6(, 2026)?$/);
    assert.match(await movie("Niso Film").locator(".lib-dl").getAttribute("title"), /Niso Film: downloaded by Niso — landed Nov 6(, 2026)?, 21:14 \(\d+d ago\)/);
    assert.equal(await movie("Hand Film").locator(".lib-dl").count(), 0, "not from a download: nothing is made up");
    const show = page.locator('#lib-tree details.lib-show[data-key="sh1"]');
    assert.match(await show.locator(":scope > summary .lib-dl").innerText(), /^↓\sNiso \+ Dor, Automatic · last Nov 7(, 2026)?$/);
    await show.locator(":scope > summary").click();
    await show.locator('details.lib-season > summary').click();
    assert.match(await show.locator(".lib-row", { hasText: "Pilot" }).locator(".lib-dl").innerText(), /^↓\sAutomatic \(Dor\) · Nov 5(, 2026)?$/);
    await shot(page, `disk-${name}`, 'details.more[data-more="d-disk"]');

    // THE PEOPLE: a chip each (newest first, the people before Automatic on a tie), and a line each behind Details
    assert.deepEqual(await page.locator("#dl-who-chips button").evaluateAll((bs) => bs.map((b) => [b.dataset.dlWho, b.firstChild.textContent, b.querySelector(".n").textContent])),
      [["all", "Everyone", "8"], ["p:Niso", "Niso", "4"], ["auto", "Automatic", "2"], ["p:Dor", "Dor", "3"], ["unknown", "Unknown", "2"]]);
    await openDetails(page, "d-who");
    const d = today();
    assert.deepEqual(await page.locator("#dl-who-lines .dl-who-line").allInnerTexts(), [
      `Niso — 4 downloads (1 automatic) · 6.0 GB · last ${d}`,
      `Automatic — 2 downloads · 1.0 GB · last ${d}`,
      `Dor — 3 downloads (1 automatic) · 3.0 GB · last ${d}`,
      "Unknown — 2 downloads · last: Unknown",
    ]);
    assert.equal(await page.locator('#dl-who-lines [data-who="p:Niso"]').getAttribute("title"), "2 finished · 2 in flight");
    assert.equal(await page.textContent("#dl-who-count"), "2");
    assert.match(await page.textContent("#dl-who-zone"), /Times are in Asia\/Jerusalem, the server's clock/);
    await shot(page, `who-${name}`, "#pane-downloads");

    // the chips filter all three lists
    await chip(page, "p:Niso").click();
    assert.deepEqual(await shown(page), { flight: ["fl1", "fl2"], done: ["dn1", "dn3"], pending: [] });
    assert.equal(await chip(page, "p:Niso").getAttribute("aria-pressed"), "true");
    await shot(page, `filter-niso-${name}`, "#pane-downloads");
    await chip(page, "p:Dor").click();
    assert.deepEqual(await shown(page), { flight: [], done: ["dn2", "dn3"], pending: ["Dor Film"] });
    assert.equal(await page.innerText("#dl-jobs-empty"), "Nothing of theirs is downloading right now.");
    await chip(page, "auto").click();
    assert.deepEqual(await shown(page), { flight: ["fl2"], done: ["dn2"], pending: [] });
    await chip(page, "unknown").click();
    assert.deepEqual(await shown(page), { flight: ["fl3"], done: ["er1"], pending: [] });
    // a tick keeps the chosen person
    await page.evaluate(() => loadDownloads());
    await page.waitForTimeout(200);
    assert.deepEqual(await shown(page), { flight: ["fl3"], done: ["er1"], pending: [] });
    await chip(page, "all").click();
    assert.deepEqual((await shown(page)).flight, ["fl1", "fl2", "fl3"]);
    await assertNoHorizontalOverflow(page, name);
    await page.evaluate(() => scrollTo(0, 0));
    await shot(page, `top-${name}`);
  });
}

ui.test("Copy for Claude: who and when on every download line, and the line per person", { viewport: DESK, permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
  await stub(page);
  await enter(page, srv);
  const clip = async (head) => {
    await page.waitForFunction(async (h) => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n").startsWith(h), head, { timeout: 15000 });
    return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  };
  const d = today();
  await page.click('[data-copy-for="d-flight"]');
  const fl = await clip("## Downloads in flight");
  assert.match(fl, /\| title \| by \| asked \| state \|/);
  assert.match(fl, /\| Flight One \| Niso \| asked [A-Z][a-z]{2} \d+, \d\d:\d\d \(2h ago\) \| downloading \|/);
  assert.match(fl, /\| Next Show · S1 E3 \| Automatic · Niso's next episode \| asked .+ \(30m ago\) \| downloading \|/);
  assert.match(fl, /\| Queued Unknown \| Unknown \| asked: Unknown \| queued \|/);
  assert.match(fl, /Waiting for approval:\n\| title \| by \| asked \| size \| why held \|\n\|---\|---\|---\|---\|---\|\n\| Dor Film \| Dor \| asked .+ \(3h ago\) \| 1\.0 GB \| Held back: under 10% free \|/);
  assert.ok(fl.includes(`By person (times in Asia/Jerusalem):\n- Niso — 4 downloads (1 automatic) · 6.0 GB · last ${d}\n- Automatic — 2 downloads · 1.0 GB · last ${d}\n- Dor — 3 downloads (1 automatic) · 3.0 GB · last ${d}\n- Unknown — 2 downloads · last: Unknown`), fl);

  await page.click('details.more[data-more="d-done"] [data-copy-for="d-done"]');
  const dn = await clip("## Finished");
  assert.match(dn, /\| title \| by \| asked \| ended \| quality \| size \| status \| error \|/);
  assert.match(dn, /\| Niso Film \| Niso \| asked Nov 6(, 2026)?, 19:00 \(\d+d ago\) \| landed Nov 6(, 2026)?, 21:14 \(\d+d ago\) \| 1080p \| 4\.0 GB \| done \|/);
  assert.match(dn, /\| Some Show · S1 E1 \| Automatic · a new episode of a show Dor follows \| asked .+ \| landed Nov 5(, 2026)?, 10:05 \(\d+d ago\) \|/);
  assert.match(dn, /\| Some Show · S1 E2 \| Niso \+ Dor \|/);
  assert.match(dn, /\| Broken Film \| Unknown \| asked: Unknown \| failed: Unknown \| 1080p \| 1\.0 GB \| error \| no source \|/);
  assert.match(dn, /Times are in Asia\/Jerusalem\.$/);

  await page.click('details.more[data-more="d-who"] [data-copy-for="d-who"]');
  const who = await clip("## Who downloaded what");
  assert.ok(who.includes(`- Niso — 4 downloads (1 automatic) · 6.0 GB · last ${d} (2 finished · 2 in flight)\n- Automatic — 2 downloads · 1.0 GB · last ${d} (1 finished · 1 in flight)\n- Dor — 3 downloads (1 automatic) · 3.0 GB · last ${d} (2 finished · 1 waiting for approval)\n- Unknown — 2 downloads · last: Unknown (1 in flight · 1 failed, declined or canceled)`), who);
  assert.ok(!/undefined|NaN|\[object Object\]/.test(fl + dn + who));
});

ui.run({ concurrency: 1 });
