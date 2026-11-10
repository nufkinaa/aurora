// The Calendar's month on the website (public/js/screens/calendar.js,
// calgrid.js): a real month — the weekdays from the viewer's first day of the
// week, the releases on their days in the viewer's time zone (a zone ahead of
// UTC and one behind), today marked, a day picked and its releases in full
// beside the grid (under it on a phone), month by month with the arrows, the
// keyboard and a swipe, Next up, the Month / List switch kept on the device,
// Play and Save & watch from the picked day, the empty month and the failed
// load; nothing sideways or clipped at 320, 360 and 414 px.
// Data: the showcase seed (support/calendar-showcase.js — titles with
// posters, dates relative to today).
//
// CALG_SHOTS=1 also writes the QA pictures to docs/qa/calendar-grid/.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, DESKTOP, assertNoHorizontalOverflow, certificatesSeed } = require("./helpers");
const show = require("./support/calendar-showcase");
const base = require("./support/calendar-seed");

const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "calendar-grid");
const shot = async (page, name) => {
  if (!process.env.CALG_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(1500); // (the entrance, the pictures)
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
};

const ui = suite({
  server: { seed: { ...show.seed(), "cache/certificates.json": certificatesSeed({ film1: 0, film2: 18, show: 7 }) } },
});

const WIDE = { width: 1440, height: 900 };
const TABLET = { width: 768, height: 1024 };
const PHONES = [{ width: 320, height: 640 }, { width: 360, height: 780 }, { width: 414, height: 896 }];

// the day key n days from the machine's today (what the seed's dates are relative to)
const dayKey = (n) => base.day(n).slice(0, 10);
// today in a time zone
const todayIn = (tz) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
};
const filled = async (api, lib, look = "glass") => {
  const p = await api.createProfile(`Grid${Math.random().toString(36).slice(2, 7)}`, { open: true });
  await show.fill(api, p, lib.show.id);
  if (look === "legacy") await api.ok("PUT", `/api/profiles/${p.id}`, { look: "legacy" });
  return p;
};
const open = async ({ page, goto, signIn }, p) => {
  await signIn(p);
  await goto("#/calendar");
  await page.waitForSelector("#app .calg-day");
};
const shownMonth = (page) => page.$eval("#app .calg-sheet", (s) => {
  const days = [...s.querySelectorAll(".calg-day:not(.other)")].map((b) => b.dataset.day);
  return days[0].slice(0, 7);
});
// page through the months to the one holding `key`, and pick it
const pickKey = async (page, key) => {
  for (let i = 0; i < 6; i++) {
    const m = await shownMonth(page);
    if (m === key.slice(0, 7)) break;
    await page.click(`#app .calg-arrow[aria-label="${m < key.slice(0, 7) ? "Next month" : "Previous month"}"]`);
    await page.waitForFunction((want) => [...document.querySelectorAll("#app .calg-day:not(.other)")][0]?.dataset.day.startsWith(want), key.slice(0, 7));
  }
  await page.click(`#app .calg-day[data-day="${key}"]`);
  await page.waitForFunction((k) => document.querySelector(`#app .calg-day[data-day="${k}"]`)?.classList.contains("sel"), key);
};
const panelTitles = (page) => page.$$eval("#app .calg-panel .cal-title", (n) => n.map((x) => x.textContent));
const dayTitles = (page, key) => page.$eval(`#app .calg-day[data-day="${key}"]`, (b) => b.getAttribute("aria-label"));

ui.test("desktop: a real month — weekdays, the releases on their days, today marked and picked, its releases beside; Next up; the legend", { viewport: WIDE, device: { locale: "en-GB" } }, async (h) => {
  const { page, api, lib } = h;
  const p = await filled(api, lib);
  await open(h, p);
  // en-GB: Monday first
  assert.deepEqual(await page.$$eval("#app .calg-wd-short", (n) => n.map((x) => x.textContent)), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(await page.$eval("#app .calg-day.today", (b) => b.dataset.day), today);
  assert.equal(await page.$eval("#app .calg-day.today", (b) => b.getAttribute("aria-current")), "date");
  // the seed: The Ninth Hour airs today → today is picked and its releases are beside the grid
  assert.equal(await page.$eval("#app .calg-day.sel", (b) => b.dataset.day), today);
  assert.deepEqual(await panelTitles(page), ["The Ninth Hour"]);
  assert.match(await page.textContent("#app .calg-panel-head"), /^Today/);
  // the grid's weeks: the first cell is the month's first week's Monday, rows of seven, consecutive days
  const cells = await page.$$eval("#app .calg-sheet .calg-day", (n) => n.map((b) => b.dataset.day));
  assert.equal(cells.length % 7, 0);
  assert.ok(cells.length >= 28 && cells.length <= 42);
  assert.equal(new Date(`${cells[0]}T00:00:00Z`).getUTCDay(), 1);
  for (let i = 1; i < cells.length; i++) assert.equal(new Date(Date.parse(`${cells[i - 1]}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), cells[i]);
  // a day's releases are ON it: posters (a fan of up to three), its kind on the edge, "+N" beyond three
  await pickKey(page, dayKey(3)); // Kingdom of Ash (premiere, two episodes), Small Hours, Test Show's S2 premiere
  const three = await page.$eval(`#app .calg-day[data-day="${dayKey(3)}"]`, (b) => ({ pics: b.querySelectorAll(".calg-pic").length, kinds: [...b.querySelectorAll(".calg-pic")].map((x) => x.className), more: b.querySelector(".calg-more")?.textContent || null, prem: b.classList.contains("prem") }));
  assert.equal(three.pics, 3);
  assert.ok(three.kinds.some((k) => /k-premiere/.test(k)));
  assert.equal(three.prem, true);
  assert.deepEqual((await panelTitles(page)).sort(), ["Kingdom of Ash", "Small Hours", "Test Show"]);
  // what the server has: a tick on the poster, "On the server" and Play in the panel
  await pickKey(page, dayKey(-2));
  assert.ok(await page.$(`#app .calg-day[data-day="${dayKey(-2)}"] .calg-pic.s-have .calg-st`));
  const ts = page.locator("#app .calg-panel .cal-entry", { hasText: "Test Show" });
  assert.equal(await ts.locator(".cal-badge").textContent(), "On the server");
  assert.equal(await ts.locator('[data-ui="calendar.play"]').count(), 1);
  // days gone by read as out
  assert.ok(await page.$eval(`#app .calg-day[data-day="${dayKey(-2)}"]`, (b) => b.classList.contains("past")));
  // Next up: the next release that is not out, and how far off — a press picks its day
  assert.match(await page.textContent("#app .calg-next"), /Next up.*Tomorrow/);
  await page.click('#app [data-ui="calendar.next"]');
  await page.waitForFunction((k) => document.querySelector("#app .calg-day.sel")?.dataset.day === k, dayKey(1));
  assert.deepEqual((await panelTitles(page)).sort(), ["Night Harbour", "Northern Static", "הבית ברחוב הירקון"]);
  // the legend
  assert.equal(await page.textContent("#app .calg-legend"), "PremiereNew episodeIn cinemasOut to stream or buyOn the server");
  // the month's heading and its line
  assert.match(await page.textContent("#app .calg-month"), /^[A-Z][a-z]+ \d{4}$/);
  await assertNoHorizontalOverflow(page, "desktop month");
  await page.click(`#app .calg-day[data-day="${dayKey(0)}"]`);
  // at the top of the page, as it opens: the whole month and its legend in a 1440 × 900 window
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => (window.scrollY || document.body.scrollTop || 0) === 0);
  const legendBottom = await page.$eval("#app .calg-legend", (n) => n.getBoundingClientRect().bottom);
  assert.ok(legendBottom <= 900, `the month and its legend fit 1440 × 900 (legend ends at ${legendBottom})`);
  const head = await page.$eval("#app .cal-head h1", (n) => n.getBoundingClientRect().top);
  const nav = await page.$eval("#nav", (n) => n.getBoundingClientRect().bottom).catch(() => 0);
  assert.ok(head >= nav, `the page title (${head}) starts under the nav (${nav}), not behind it`);
  await shot(page, "1440-glass");
});

ui.test("desktop: the arrows, Today, the keyboard (arrows, PageUp/PageDown, Home/End, Enter into the day)", { viewport: DESKTOP, device: { locale: "en-US" } }, async (h) => {
  const { page, api, lib } = h;
  const p = await filled(api, lib);
  await open(h, p);
  // en-US: Sunday first
  assert.equal(await page.$eval("#app .calg-wd-short", (x) => x.textContent), "Sun");
  const m0 = await shownMonth(page);
  await page.click('#app .calg-arrow[aria-label="Next month"]');
  await page.waitForFunction((m) => [...document.querySelectorAll("#app .calg-day:not(.other)")][0].dataset.day.slice(0, 7) !== m, m0);
  const m1 = await shownMonth(page);
  assert.ok(m1 > m0);
  assert.notEqual(await page.textContent("#app .calg-month"), "");
  await page.click('#app [data-ui="calendar.today"]');
  await page.waitForFunction((m) => [...document.querySelectorAll("#app .calg-day:not(.other)")][0].dataset.day.slice(0, 7) === m, m0);
  // the month before this one is the first: its arrow back stops there
  await page.click('#app .calg-arrow[aria-label="Previous month"]');
  await page.waitForFunction(() => document.querySelector('#app .calg-arrow[aria-label="Previous month"]').disabled);
  await page.click('#app [data-ui="calendar.today"]');
  await page.waitForFunction((m) => [...document.querySelectorAll("#app .calg-day:not(.other)")][0].dataset.day.slice(0, 7) === m, m0);

  // the keyboard, from the picked day
  const sel = () => page.$eval("#app .calg-day.sel", (b) => b.dataset.day);
  const focused = () => page.evaluate(() => document.activeElement?.dataset?.day || null);
  // (polled: a loaded machine may answer a key a frame late)
  const selIs = (k) => page.waitForFunction((k) => document.querySelector("#app .calg-day.sel")?.dataset.day === k && document.activeElement?.dataset?.day === k, k);
  const focusDay = async (k) => {
    await page.focus(`#app .calg-day[data-day="${k}"]`);
    await page.waitForFunction((k) => document.activeElement?.dataset?.day === k, k);
  };
  await pickKey(page, `${m0}-15`);
  await focusDay(`${m0}-15`);
  await page.keyboard.press("ArrowRight");
  await selIs(`${m0}-16`);
  assert.equal(await focused(), `${m0}-16`);
  await page.keyboard.press("ArrowDown");
  await selIs(`${m0}-23`);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowLeft");
  await selIs(`${m0}-15`);
  const selWeekday = (d) => page.waitForFunction((d) => new Date(`${document.querySelector("#app .calg-day.sel").dataset.day}T00:00:00Z`).getUTCDay() === d, d);
  await page.keyboard.press("Home"); // the week's first day (Sunday)
  await selWeekday(0);
  await page.keyboard.press("End");
  await selWeekday(6);
  await pickKey(page, `${m0}-15`);
  await focusDay(`${m0}-15`);
  await page.keyboard.press("PageDown"); // the same day, the month after
  await selIs(`${m1}-15`);
  await page.keyboard.press("PageUp");
  await selIs(`${m0}-15`);
  // Enter on the picked day: into its releases
  await pickKey(page, dayKey(5)); // Salt Road S2 E3 and Midnight Signal
  await page.focus(`#app .calg-day[data-day="${dayKey(5)}"]`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.classList.contains("cal-open"));
  assert.ok(await page.evaluate(() => !!document.activeElement.closest(".calg-panel")));
});

for (const [zone, label] of [["Pacific/Kiritimati", "a zone 14 hours ahead of UTC"], ["America/Los_Angeles", "a zone 8 hours behind it"]]) {
  ui.test(`the viewer's time zone: ${label} — its today, and an air time on its own day`, { viewport: DESKTOP, device: { timezoneId: zone, locale: "en-GB" } }, async (h) => {
    const { page, api, lib } = h;
    const p = await filled(api, lib);
    const asked = page.waitForRequest((r) => /\/calendar\?/.test(r.url()));
    await open(h, p);
    assert.match((await asked).url(), new RegExp(`tz=${encodeURIComponent(zone).replace(/[/]/g, "%2F")}`));
    assert.equal(await page.$eval("#app .calg-day.today", (b) => b.dataset.day), todayIn(zone));
    // Midnight Signal airs at 02:00 UTC five days from the machine's today: that
    // date at 16:00 in Kiritimati, the evening before (18:00) in Los Angeles
    const want = zone === "Pacific/Kiritimati" ? dayKey(5) : dayKey(4);
    await pickKey(page, want);
    assert.ok((await panelTitles(page)).includes("Midnight Signal"), `${want} in ${zone}: ${await panelTitles(page)}`);
    const other = zone === "Pacific/Kiritimati" ? dayKey(4) : dayKey(5);
    assert.doesNotMatch(await dayTitles(page, other), /Midnight Signal/);
    // a plain date (Low Orbit's season, six days on) is that date in every zone
    assert.match(await dayTitles(page, dayKey(6)), /Low Orbit, Series premiere/);
  });
}

ui.test("the picked day in full: Save & watch and Play work as in the list", { viewport: WIDE }, async (h) => {
  const { page, api, lib } = h;
  const p = await filled(api, lib);
  await open(h, p);
  // Arcadia Bay came out to stream three days ago: Save & watch (a stand-in answer — nothing is ever downloaded here)
  let asked = null;
  await page.route(/\/calendar\/save$/, (route) => {
    asked = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, state: "saving", line: "Saving — My downloads shows how far it has got" }) });
  });
  await pickKey(page, dayKey(-3));
  const arcadia = page.locator("#app .calg-panel .cal-entry", { hasText: "Arcadia Bay" });
  await arcadia.locator('[data-ui="calendar.save"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll("#app .calg-panel .cal-entry")].some((e) => /Arcadia Bay/.test(e.textContent) && e.querySelector(".cal-badge")?.textContent === "Saving"));
  assert.deepEqual(asked, { imdbId: show.IDS["Arcadia Bay"], type: "movie" });
  // the day itself now says so: the saving mark on its poster
  assert.ok(await page.$(`#app .calg-day[data-day="${dayKey(-3)}"] .calg-pic.s-saving`));
  // Play: the library's episode
  await pickKey(page, dayKey(-2));
  await page.locator("#app .calg-panel .cal-entry", { hasText: "Test Show" }).locator('[data-ui="calendar.play"]').click();
  await page.waitForFunction(() => location.hash.startsWith("#/play/"));
  assert.ok(decodeURIComponent(page.url()).includes(lib.e1.id), page.url());
  // Back: the same month view and the same day
  await page.goBack();
  await page.waitForSelector("#app .calg-day.sel");
  assert.equal(await page.$eval("#app .calg-day.sel", (b) => b.dataset.day), dayKey(-2));
});

ui.test("Month / List: the switch shows the agenda, and the choice stays on this device", { viewport: DESKTOP }, async (h) => {
  const { page, api, lib, goto } = h;
  const p = await filled(api, lib);
  await open(h, p);
  const views = () => page.$$eval('#app [data-ui="calendar.view"]', (n) => n.map((b) => [b.textContent, b.getAttribute("aria-selected")]));
  assert.deepEqual(await views(), [["Month", "true"], ["List", "false"]]);
  assert.equal(await page.isVisible('#app [data-ui="calendar.tab"]'), false);
  await page.click('#app [data-ui="calendar.view"]:has-text("List")');
  await page.waitForSelector("#app .cal-entry");
  assert.equal(await page.$("#app .calg-day"), null);
  assert.match(await page.textContent('#app [data-ui="calendar.tab"]'), /^Coming up · \d+$/);
  await goto("#/");
  await page.reload();
  await page.waitForSelector("#app");
  await goto("#/calendar");
  await page.waitForSelector("#app .cal-entry");
  assert.deepEqual(await views(), [["Month", "false"], ["List", "true"]]);
  await page.click('#app [data-ui="calendar.view"]:has-text("Month")');
  await page.waitForSelector("#app .calg-day");
});

for (const viewport of PHONES) {
  ui.test(`${viewport.width} px: the month on top (one poster filling a day), the day's releases under it; nothing sideways or clipped; a swipe changes month`, { viewport }, async (h) => {
    const { page, api, lib } = h;
    const p = await filled(api, lib);
    await open(h, p);
    assert.ok(await page.$("#app .calg-sheet.fill"), "phone days are poster tiles");
    assert.equal(await page.$$eval("#app .calg-day.has", (n) => Math.max(...n.map((b) => b.querySelectorAll(".calg-pic").length))), 1);
    // the panel under the grid
    const order = await page.evaluate(() => {
      const g = document.querySelector("#app .calg-grid").getBoundingClientRect();
      const pn = document.querySelector("#app .calg-panel").getBoundingClientRect();
      return pn.top >= g.bottom;
    });
    assert.ok(order, "the day's releases are under the month");
    await assertNoHorizontalOverflow(page, `${viewport.width} month`);
    // nothing clipped: the month's name, the weekdays, the switch, the next-up line
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll("#app .calg-month, #app .calg-wd-narrow, #app .cal-views .chip, #app .calg-next-when, #app .calg-today, #app .calg-line")]
        .filter((n) => n.offsetParent && (n.scrollWidth > n.clientWidth + 1 || n.getBoundingClientRect().right > window.innerWidth + 1))
        .map((n) => `${n.className}: ${n.textContent}`));
    assert.deepEqual(clipped, []);
    // the cells: seven to a row, inside the page
    const row = await page.$eval("#app .calg-row", (r) => { const b = r.getBoundingClientRect(); return { left: b.left, right: b.right, n: r.children.length }; });
    assert.equal(row.n, 7);
    assert.ok(row.left >= 0 && row.right <= viewport.width);
    // a tap picks a day
    await pickKey(page, dayKey(1));
    assert.ok((await panelTitles(page)).includes("Northern Static"));
    // a sideways swipe: the month after, then back
    const m0 = await shownMonth(page);
    const swipe = (dx) => page.evaluate((dx) => {
      const g = document.querySelector("#app .calg-grid");
      const r = g.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const x0 = r.left + r.width / 2 - dx / 2;
      const t = (x) => new Touch({ identifier: 1, target: g, clientX: x, clientY: y });
      g.dispatchEvent(new TouchEvent("touchstart", { touches: [t(x0)], changedTouches: [t(x0)], bubbles: true }));
      g.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [t(x0 + dx)], bubbles: true }));
    }, dx);
    await swipe(-140);
    await page.waitForFunction((m) => [...document.querySelectorAll("#app .calg-day:not(.other)")][0].dataset.day.slice(0, 7) > m, m0);
    await swipe(140);
    await page.waitForFunction((m) => [...document.querySelectorAll("#app .calg-day:not(.other)")][0].dataset.day.slice(0, 7) === m, m0);
    await page.click(`#app .calg-day[data-day="${dayKey(0)}"]`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, `${viewport.width}-glass`);
  });
}

ui.test("768 px and the classic look: one column, the day's releases under the month", { viewport: TABLET }, async (h) => {
  const { page, api, lib } = h;
  const p = await filled(api, lib, "legacy");
  await open(h, p);
  assert.ok(await page.$("#app .calg-sheet.fan"), "wide days fan their posters");
  await assertNoHorizontalOverflow(page, "768");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "768-legacy");
});

ui.test("1440 px, the classic look", { viewport: WIDE }, async (h) => {
  const { page, api, lib } = h;
  const p = await filled(api, lib, "legacy");
  await open(h, p);
  await assertNoHorizontalOverflow(page, "1440 legacy");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "1440-legacy");
});

ui.test("less motion: the month comes in without its entrance", { viewport: DESKTOP }, async (h) => {
  const { page, api, lib } = h;
  await page.emulateMedia({ reducedMotion: "reduce" });
  const p = await filled(api, lib);
  await open(h, p);
  assert.equal(await page.$("#app .calg-sheet.enter"), null);
  await page.click('#app .calg-arrow[aria-label="Next month"]');
  assert.equal(await page.$("#app .calg-sheet.from-next"), null);
});

ui.test("empty: no titles at all — the month waits with the words to fill it; a failed load offers Try again", { viewport: PHONES[0] }, async (h) => {
  const { page, freshProfile, signIn, goto, allow } = h;
  const p = await freshProfile();
  await signIn(p);
  await goto("#/calendar");
  await page.waitForSelector("#app .calg-blank");
  assert.match(await page.textContent("#app .calg-blank"), /Add films and shows to My List, or follow a show/);
  assert.equal(await page.$("#app .calg-next"), null);
  assert.match(await page.textContent("#app .calg-panel"), /Add films and shows to My List/);
  await assertNoHorizontalOverflow(page, "empty");
  await shot(page, "320-empty");
  allow(/calendar/, /500/);
  let fail = true;
  await page.route(/\/api\/profiles\/[^/]+\/calendar(\?|$)/, (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' }) : route.continue()));
  await goto("#/");
  await goto("#/calendar");
  await page.waitForSelector('#app [data-ui="calendar.retry"]');
  assert.match(await page.textContent("#app .screen.calendar"), /Couldn't load the calendar right now\./);
  await shot(page, "320-failed");
  fail = false;
  await page.click('#app [data-ui="calendar.retry"]');
  await page.waitForSelector("#app .calg-blank");
});

ui.test("a month with nothing in it says so; a day with nothing says so", { viewport: DESKTOP }, async (h) => {
  const { page, api, lib } = h;
  const p = await filled(api, lib);
  await open(h, p);
  // the last month the calendar reaches has (almost) nothing in the seed: walk to it
  for (let i = 0; i < 4; i++) {
    const next = await page.$('#app .calg-arrow[aria-label="Next month"]:not([disabled])');
    if (!next) break;
    await next.click();
  }
  const empties = await page.$$eval("#app .calg-day:not(.other):not(.has)", (n) => n.map((b) => b.dataset.day));
  await page.click(`#app .calg-day[data-day="${empties[0]}"]`);
  assert.equal(await page.textContent("#app .calg-panel-empty"), "Nothing out on this day.");
  const line = await page.textContent("#app .calg-line");
  assert.ok(line === "Nothing out this month for the titles in your list." || /^\d+ releases?/.test(line), line);
});

ui.run({ concurrency: 3 });
