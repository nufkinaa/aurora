// The Calendar on the website (desktop and a 320 px phone, both looks): the
// nav link (desktop) and the profile menu (phone) lead to it; Coming up and
// Recently out, grouped by day with the server's words; the badge for what
// the server has, Play for it, Save & watch for what it has not (its answer
// changes the card; nothing is saved without a press); a card opens its
// title; the empty calendar; a failed load and Try again. The data comes
// from seeded caches (support/calendar-seed.js); the rules are pinned in
// test/calendar.test.js and test/calendar-server.test.js.
//
// CAL_SHOTS=1 also writes the screenshots to docs/qa/calendar/.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, PHONE, DESKTOP, assertNoHorizontalOverflow, certificatesSeed } = require("./helpers");
const cal = require("./support/calendar-seed");

const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "calendar");
const shot = async (page, name, o = {}) => {
  if (!process.env.CAL_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(1500); // (the screen's fade, pictures, toasts)
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...o }).catch(() => {});
};

const ui = suite({
  server: { seed: { ...cal.seed(), "cache/certificates.json": certificatesSeed({ film1: 0, film2: 18, show: 7 }) } },
});

const SMALL = { width: 320, height: 640 };
const setLook = async (api, p, look) => { if (look === "legacy") await api.ok("PUT", `/api/profiles/${p.id}`, { look: "legacy" }); };
const filled = async (api, lib, look) => {
  const p = await api.createProfile(`Cal${Math.random().toString(36).slice(2, 7)}`, { open: true });
  await cal.fill(api, p, lib.show.id);
  await setLook(api, p, look);
  return p;
};
const toastSays = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll("#toasts .toast")].some((t) => new RegExp(src).test(t.innerText.replace(/\s+/g, " "))), re.source, { timeout: 15000 });
const heads = (page) => page.$$eval("#app .cal-day-head", (n) => n.map((x) => x.textContent));
const entries = (page) => page.$$eval("#app .cal-entry", (n) => n.map((x) => ({
  title: x.querySelector(".cal-title")?.textContent,
  what: x.querySelector(".cal-what")?.textContent,
  detail: x.querySelector(".cal-detail")?.textContent || null,
  badge: x.querySelector(".cal-badge")?.textContent || null,
  why: x.querySelector(".cal-why")?.textContent || null,
  buttons: [...x.querySelectorAll(".cal-actions button")].map((b) => b.textContent),
})));
const tab = (page, words) => page.locator('#app [data-ui="calendar.tab"]', { hasText: words });

for (const [look, viewport] of [["glass", DESKTOP], ["legacy", DESKTOP], ["glass", SMALL], ["legacy", SMALL]]) {
  const phone = viewport.width < 600;
  const tag = `${phone ? "320" : "desktop"}-${look}`;

  ui.test(`${tag}: reached from the nav, Coming up by day, Recently out with badges, Play and Save & watch`, { viewport }, async ({ page, goto, signIn, api, lib }) => {
    const p = await filled(api, lib, look);
    await signIn(p);
    await goto("#/");
    if (!phone) {
      const link = page.locator('#nav [data-ui="nav.calendar"]');
      await link.waitFor({ state: "visible" });
      await link.click();
    } else {
      // a phone: the bar has no room — the profile menu has it
      assert.equal(await page.locator('#nav [data-ui="nav.calendar"]').isVisible(), false);
      await page.locator("#nav-profile").click();
      await page.locator(".nav-menu .nav-menu-item", { hasText: "Calendar" }).click();
    }
    await page.waitForFunction(() => location.hash === "#/calendar");
    await page.waitForSelector("#app .cal-entry");
    assert.equal(await page.locator("#app .browse-head h1").textContent(), "Calendar");
    assert.match(await tab(page, "Coming up").textContent(), /^Coming up · 5$/);
    assert.match(await tab(page, "Recently out").textContent(), /^Recently out · 4$/);
    const h = await heads(page);
    assert.match(h[0], /^Tomorrow · /);
    assert.equal(h.length, 5);
    const up = await entries(page);
    assert.deepEqual(up.map((e) => e.title), ["Night Harbour", "Test Show", "Quiet Fields", "Glass Orchard", "Glass Orchard"]);
    assert.deepEqual(up[0], { title: "Night Harbour", what: "New episode", detail: "S1 E5 · The Lighthouse", badge: null, why: "In My List", buttons: [] });
    assert.equal(up[2].what, "Season 2 premiere");
    assert.equal(up[2].detail, "S2 E1–E8 · 8 episodes");
    assert.equal(up[2].why, "Following");
    assert.deepEqual(up.slice(3).map((e) => e.what), ["In cinemas", "Out to stream or buy"]);
    await assertNoHorizontalOverflow(page, `${tag} Coming up`);
    await shot(page, `${tag}-coming-up`);

    await tab(page, "Recently out").click();
    await page.waitForFunction(() => document.querySelector("#app .cal-day-head")?.textContent.startsWith("Yesterday"));
    const recent = await entries(page);
    assert.deepEqual(recent.map((e) => [e.title, e.badge, e.buttons]), [
      ["Night Harbour", null, ["Save & watch"]],
      ["Test Show", "On the server", ["Play"]],
      ["Paper Moons", null, ["Save & watch"]],
      ["Night Harbour", null, ["Save & watch"]],
    ]);
    assert.equal(recent[1].what, "Series premiere");
    assert.equal(recent[1].detail, "S1 E1–E3 · 3 episodes");
    await assertNoHorizontalOverflow(page, `${tag} Recently out`);
    await shot(page, `${tag}-recently-out`);

    // Save & watch: the server's answer (a stand-in — nothing is ever
    // downloaded in a test) turns the card; the request is the entry's own
    let asked = null;
    await page.route(/\/calendar\/save$/, (route) => {
      asked = JSON.parse(route.request().postData() || "{}");
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, state: "saving", line: "Saving — My downloads shows how far it has got" }) });
    });
    const paper = page.locator("#app .cal-entry", { hasText: "Paper Moons" });
    await paper.locator('[data-ui="calendar.save"]').click();
    await toastSays(page, /Saving — My downloads shows how far it has got/);
    await page.waitForFunction(() => [...document.querySelectorAll("#app .cal-entry")].some((e) => /Paper Moons/.test(e.textContent) && e.querySelector(".cal-badge")?.textContent === "Saving"));
    assert.deepEqual(asked, { imdbId: cal.IDS.moons, type: "movie" });
    assert.equal(await paper.locator('[data-ui="calendar.save"]').count(), 0, "no second Save");
    await shot(page, `${tag}-saved`);

    // Play: the library episode
    await page.locator("#app .cal-entry", { hasText: "Test Show" }).locator('[data-ui="calendar.play"]').click();
    await page.waitForFunction(() => location.hash.startsWith("#/play/"));
    assert.ok(decodeURIComponent(page.url()).includes(lib.e1.id), page.url());
  });

  ui.test(`${tag}: a card opens its title; Back lands on the same tab`, { viewport }, async ({ page, goto, signIn, api, lib }) => {
    const p = await filled(api, lib, look);
    await signIn(p);
    await goto("#/calendar");
    await page.waitForSelector("#app .cal-entry");
    await tab(page, "Recently out").click();
    await page.locator("#app .cal-entry", { hasText: "Test Show" }).locator('[data-ui="calendar.open"]').click();
    await page.waitForFunction((id) => location.hash === `#/show/${id}`, lib.show.id);
    await page.goBack();
    await page.waitForFunction(() => location.hash === "#/calendar");
    await page.waitForSelector("#app .cal-entry");
    assert.equal(await tab(page, "Recently out").getAttribute("aria-selected"), "true");
    // a catalogue title opens its catalogue page
    await page.locator("#app .cal-entry", { hasText: "Paper Moons" }).locator('[data-ui="calendar.open"]').click();
    await page.waitForFunction((id) => location.hash === `#/discover/movie/${id}`, cal.IDS.moons);
  });
}

ui.test("320: an empty calendar says how to fill it; a failed load offers Try again", { viewport: SMALL }, async ({ page, goto, signIn, freshProfile, allow }) => {
  const p = await freshProfile();
  await signIn(p);
  await goto("#/calendar");
  await page.waitForSelector("#app .cal-empty");
  assert.match(await page.locator("#app .cal-empty").textContent(), /Add films and shows to My List, or follow a show/);
  assert.equal(await tab(page, "Coming up").textContent(), "Coming up");
  await assertNoHorizontalOverflow(page, "empty");
  await shot(page, "320-empty");

  allow(/calendar/, /500/);
  let fail = true;
  await page.route(/\/api\/profiles\/[^/]+\/calendar(\?|$)/, (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' }) : route.continue()));
  await goto("#/");
  await goto("#/calendar");
  await page.waitForSelector('#app [data-ui="calendar.retry"]');
  assert.match(await page.locator("#app .screen.calendar").textContent(), /Couldn't load the calendar right now\./);
  await shot(page, "320-failed");
  fail = false;
  await page.locator('#app [data-ui="calendar.retry"]').click();
  await page.waitForSelector("#app .cal-empty");
});

ui.test("desktop: a Save & watch that finds nothing says why and keeps the button", { viewport: DESKTOP }, async ({ page, goto, signIn, api, lib }) => {
  const p = await filled(api, lib, "glass");
  await signIn(p);
  await goto("#/calendar");
  await page.waitForSelector("#app .cal-entry");
  await tab(page, "Recently out").click();
  // the real route: the private instance cannot reach a source provider
  const harbour = page.locator("#app .cal-entry", { hasText: "Low Tide" });
  await harbour.locator('[data-ui="calendar.save"]').click();
  await toastSays(page, /source provider|No good copy/);
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("#app .cal-entry")].find((e) => /Low Tide/.test(e.textContent))?.querySelector('[data-ui="calendar.save"]');
    return b && !b.disabled && b.textContent === "Save & watch";
  });
  assert.equal((await api.get("/api/downloads")).length, 0, "nothing was queued");
});

ui.run({ concurrency: 3 });
