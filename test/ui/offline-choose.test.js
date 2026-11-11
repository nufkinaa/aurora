// "Choose episodes" (js/offlineChoose.js) — elia, 2026-11-11: "save next 3 is confusing, why
// not just give the user the ability to choose which episodes to download?"
//
// A show's page has ONE button for this device: Choose episodes. Its sheet lists the season's
// episodes with a tick box each, the season switch inside it; the saved one is shown saved and
// cannot be ticked; one the server does not have yet says it saves here when it arrives (a
// wish); the next unwatched ones come ticked; Select all / Clear; the size once for all; the
// running total and the room; one Save. The catalogue's answer (what the show has beyond the
// files on the server) is given by the test: the private instance has no way out.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite();
const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "phone-1.1.3", "offline-phone", "choose");
const shot = async (page, name) => {
  if (!process.env.UI_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
};
const until = async (fn, what, ms = 45000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
// the catalogue: season 1 has a 4th episode the server does not hold; season 2 is not out yet
const meta = (show) => ({
  imdbId: show.imdbId, type: "series", title: "Test Show", year: 2020, poster: null,
  seasons: [
    { number: 1, episodes: [1, 2, 3, 4].map((n) => ({ episode: n, title: `Episode ${n}`, released: `2020-01-0${n}` })) },
    { number: 2, episodes: [{ episode: 1, title: "Next Year", released: "2099-01-01" }] },
  ],
});

const open = async (srv, profile, viewport) => {
  const phone = viewport.width < 600;
  const context = await ui.browser.newContext({ viewport, serviceWorkers: "allow", ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const show = await srv.api.get(`/api/item/${srv.lib.show.id}`);
  await context.route(/\/api\/discover\/meta\/series\//, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(meta(show)) }));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.stack) || e)));
  await page.addInitScript(({ id }) => {
    try {
      localStorage.setItem("aurora-offline-bg", "0");
      if (sessionStorage.getItem("ui-test-seeded")) return;
      sessionStorage.setItem("ui-test-seeded", "1");
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-kbd-hint", "1");
      localStorage.setItem("aurora-nav-hinted", "1");
    } catch {}
  }, { id: profile.id });
  await page.goto(`${srv.url}/#/saved`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .screen", { timeout: 30000 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  return { context, page, errors, show };
};
const save = (page, id) => page.evaluate(async (x) => {
  const o = await import("/js/offline.js");
  const { api } = await import("/js/api.js");
  return !!(await o.saveItem(await api.item(x), () => {}, async (opts) => (opts.some((q) => q.quality === "original") ? "original" : opts[0].quality)));
}, id);
const savedIds = (page) => page.evaluate(async () => (await (await import("/js/offline.js")).listSaved()).map((s) => s.id));
const rowText = (page, key) => page.locator(`.choose-row[data-key="${key}"]`).innerText();
const ticked = (page) => page.$$eval(".choose-row.on", (rows) => rows.map((r) => r.dataset.key));

for (const [name, viewport] of [["phone", PHONE], ["desktop", DESKTOP]]) {
  ui.test(`${name}: Choose episodes — saved, on the server, not yet; the next ones ticked; Select all / Clear; the size once; Save saves and wishes`, async ({ srv, freshProfile }) => {
    const profile = await freshProfile();
    await srv.api.setProgress(profile, srv.lib.e1.id, 44, 45); // the first one watched
    const { context, page, errors } = await open(srv, profile, viewport);
    try {
      assert.ok(await save(page, srv.lib.e2.id), "E2 is on this device");
      await page.evaluate((id) => { location.hash = `#/show/${id}`; }, srv.lib.show.id);
      const btn = page.locator('[data-ui="detail.offline.choose"]').first();
      await btn.waitFor();
      assert.match(await btn.innerText(), /Choose episodes/);
      // the old buttons are gone
      assert.equal(await page.locator('[data-ui="detail.offline.season"], [data-ui="detail.offline.seasonall"]').count(), 0);
      assert.equal(await page.getByText(/Save (the )?next 3/).count(), 0);
      await btn.click();
      await page.waitForSelector(".choose-sheet .choose-row");
      const sheet = page.locator(".choose-sheet");
      assert.match(await sheet.innerText(), /Choose episodes[\s\S]*Test Show/);
      // each row says where it stands
      assert.match(await rowText(page, "1x2"), /E2[\s\S]*Saved on this device/);
      assert.equal(await page.locator('.choose-row[data-key="1x2"]').evaluate((n) => n.tagName), "DIV", "a saved one cannot be ticked");
      assert.match(await rowText(page, "1x4"), /E4[\s\S]*Not on the server yet — saves here when it arrives/);
      assert.match(await rowText(page, "1x3"), /E3[\s\S]*min[\s\S]*(MB|GB)/);
      // ticked to begin with: the next ones not watched (E1 is, E2 is here) — across the season end
      assert.deepEqual(await ticked(page), ["1x3", "1x4"]);
      assert.match(await page.locator(".choose-total").innerText(), /^3 episodes · ≈ .* · 2 when they arrive$/);
      assert.match(await page.locator(".choose-season.on").innerText(), /Season 1 · 2/);
      await shot(page, `after-${name}-chooser-open`);
      // season 2 inside the sheet: not out yet, ticked
      await page.locator(".choose-season", { hasText: "Season 2" }).click();
      assert.match(await rowText(page, "2x1"), /Not out yet — saves here when it arrives/);
      assert.deepEqual(await ticked(page), ["2x1"]);
      await page.locator('[data-ui="offline.choose.clear"]').click();
      await page.locator(".choose-season", { hasText: "Season 1" }).click();
      // Select all: every one that can be ticked (not the saved one); Clear: none
      await page.locator('[data-ui="offline.choose.all"]').click();
      assert.deepEqual(await ticked(page), ["1x1", "1x3", "1x4"]);
      await page.locator('[data-ui="offline.choose.clear"]').click();
      assert.deepEqual(await ticked(page), []);
      assert.equal(await page.locator(".choose-total").innerText(), "No episodes ticked");
      assert.ok(await page.locator('[data-ui="offline.choose.save"]').isDisabled());
      // tick E3 and E4, the size once: Original
      await page.locator('.choose-row[data-key="1x3"]').click();
      await page.locator('.choose-row[data-key="1x4"]').click();
      await page.locator(".choose-size", { hasText: "Original" }).click();
      assert.match(await page.locator(".choose-total").innerText(), /^2 episodes · ≈ .* · 1 when it arrives$/);
      assert.match(await page.locator('[data-ui="offline.choose.save"]').innerText(), /^Save 2 episodes$/);
      if (name === "phone") assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "no sideways scroll");
      await page.locator('[data-ui="offline.choose.save"]').click();
      await page.waitForSelector(".choose-sheet", { state: "detached" });
      // E3 saved here at Original (nothing more asked), E4 a wish at Original
      await until(async () => (await savedIds(page)).includes(srv.lib.e3.id), "E3 saved");
      assert.equal(await page.locator(".offline-sheet:not(.choose-sheet)").count(), 0, "the size was asked once — in the chooser");
      const w = (await srv.api.get(`/api/profiles/${profile.id}/offline-wishes`, await srv.api.as(profile))).wishes;
      assert.equal(w.length, 1);
      assert.equal(w[0].season, 1);
      assert.equal(w[0].episode, 4);
      assert.equal(w[0].quality, "original");
      // open again: E3 is saved, E4 waits for the server's copy — neither can be ticked now
      await page.locator('[data-ui="detail.offline.choose"]').first().click();
      await page.waitForSelector(".choose-sheet .choose-row");
      assert.match(await rowText(page, "1x3"), /Saved on this device/);
      assert.match(await rowText(page, "1x4"), /Will be saved when it arrives/);
      await shot(page, `after-${name}-chooser-after-save`);
      await page.locator('[data-ui="offline.choose.cancel"]').click();
      await page.waitForSelector(".choose-sheet", { state: "detached" });
      assert.deepEqual(errors, []);
    } finally {
      await context.close().catch(() => {});
    }
  });
}
