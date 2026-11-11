// "Keep the next episode ready" (js/offline.js smartNext, 2026-11-10 round 2):
// opt-in per device, off by default. An episode saved here and watched to the
// end → the next one is saved here by itself, at the same quality; when the
// server does not have it yet, a wish is made (saved by itself when it lands).
// It only ADDS — nothing saved here is ever removed by itself.
const assert = require("node:assert/strict");
const { suite, PHONE } = require("./helpers");

const ui = suite();

const open = async (srv, profile) => {
  const ctx = await ui.browser.newContext({ viewport: PHONE, serviceWorkers: "allow", hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await ctx.newPage();
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
      // what the device hears, for the test to read
      window.__smart = [];
    } catch {}
  }, { id: profile.id });
  await page.goto(`${srv.url}/#/saved`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .screen", { timeout: 30000 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  await page.evaluate(async () => { const o = await import("/js/offline.js"); o.smartNext.on((e) => window.__smart.push(e)); });
  return { context: ctx, page, errors };
};
const until = async (fn, what, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};
const saveEp = (page, id, quality) => page.evaluate(async ({ id, quality }) => {
  const o = await import("/js/offline.js");
  const { api } = await import("/js/api.js");
  const it = await api.item(id);
  const s = await o.saveItem(it, () => {}, async (opts) => (opts.some((x) => x.quality === quality) ? quality : opts[0].quality));
  return s && s.quality;
}, { id, quality });
const savedIds = (page) => page.evaluate(async () => (await (await import("/js/offline.js")).listSaved()).map((s) => [s.id, s.quality]));
// watched to the end, the way the player does it: the episode played from
// this device, its last seconds, then away from the player
const finishInPlayer = async (page, id) => {
  await page.evaluate((x) => { location.hash = `#/play/${x}?offline=1`; }, id);
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 0.3 && v.duration > 0; }, null, { timeout: 30000 });
  await page.evaluate(() => { const v = document.querySelector(".player video"); v.currentTime = v.duration - 1.5; });
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return !v || v.ended || v.currentTime >= v.duration - 0.6; }, null, { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { location.hash = "#/saved"; });
};

ui.test("off by default: an episode watched to the end saves nothing more", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile);
  try {
    assert.equal(await page.evaluate(async () => (await import("/js/offline.js")).smartNext.get()), false);
    assert.equal(await saveEp(page, srv.lib.e1.id, "original"), "original");
    await finishInPlayer(page, srv.lib.e1.id);
    await page.waitForTimeout(4000);
    assert.deepEqual((await savedIds(page)).map((x) => x[0]), [srv.lib.e1.id]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("on: episode 1 watched to the end → episode 2 is saved here by itself, at the same quality; episode 1 stays", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile);
  try {
    assert.equal(await saveEp(page, srv.lib.e1.id, "480"), "480");
    await page.evaluate(async () => (await import("/js/offline.js")).smartNext.set(true));
    assert.equal(await page.evaluate(async () => (await import("/js/offline.js")).smartNext.get()), true);
    await finishInPlayer(page, srv.lib.e1.id);
    await until(async () => (await savedIds(page)).some((x) => x[0] === srv.lib.e2.id), "episode 2 saved by itself", 120000);
    const saved = new Map(await savedIds(page));
    assert.equal(saved.get(srv.lib.e2.id), "480", "the same quality");
    assert.ok(saved.has(srv.lib.e1.id), "nothing removed by itself");
    const events = await page.evaluate(() => window.__smart.map((e) => [e.type, e.next && e.next.episode]));
    assert.ok(events.some((e) => e[0] === "saving" && e[1] === 2), JSON.stringify(events));
    assert.ok(events.some((e) => e[0] === "saved" && e[1] === 2), JSON.stringify(events));
    // the in-memory index knows it at once
    assert.equal(await page.evaluate(async (id) => (await import("/js/offline.js")).stateOf(id), srv.lib.e2.id), "saved");
    // and a second look does not save it again
    await page.evaluate(async () => (await import("/js/offline.js")).smartNext.check());
    assert.equal((await savedIds(page)).length, 2);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("on: the next episode is not on the server yet → a wish for it, at the same quality", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile);
  try {
    // (what the server says comes after episode 3: one that is not downloaded yet)
    await context.route("**/api/next-episode?**", (route) => route.fulfill({ json: { next: { kind: "stream", imdbId: "tt9000003", season: 1, episode: 4, title: "Episode 4" }, why: "test" } }));
    assert.equal(await saveEp(page, srv.lib.e3.id, "original"), "original");
    await page.evaluate(async () => (await import("/js/offline.js")).smartNext.set(true));
    await finishInPlayer(page, srv.lib.e3.id);
    await until(async () => {
      const w = await srv.api.get(`/api/profiles/${profile.id}/offline-wishes`, await srv.api.as(profile));
      return w.wishes.length === 1 && w.wishes[0].episode === 4;
    }, "a wish for episode 4");
    const w = (await srv.api.get(`/api/profiles/${profile.id}/offline-wishes`, await srv.api.as(profile))).wishes[0];
    assert.equal(w.quality, "original");
    assert.equal(w.imdbId, "tt9000003");
    assert.equal(w.season, 1);
    const events = await page.evaluate(() => window.__smart.map((e) => e.type));
    assert.ok(events.includes("wished"), JSON.stringify(events));
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.run({ concurrency: 2 });
