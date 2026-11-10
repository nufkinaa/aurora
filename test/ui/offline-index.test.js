// What the offline screens are built on (js/offline.js, 2026-11-10 round 2):
// savedNow / stateOf answered from memory (cheap per card), kept fresh by
// saves, removals and the other tabs; watchSaves — every save, copy and wish
// with its state, percent, bytes, speed and time left; watchedCopies for a
// "Remove watched" button; storageSummary.
const assert = require("node:assert/strict");
const { suite, DESKTOP } = require("./helpers");

const ui = suite();

const open = async (srv, profile, context = null) => {
  const ctx = context || await ui.browser.newContext({ viewport: DESKTOP, serviceWorkers: "allow" });
  if (!context) await ctx.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.stack) || e)));
  await page.addInitScript(({ id }) => {
    try {
      localStorage.setItem("aurora-offline-part-bytes", "131072");
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
  return { context: ctx, page, errors };
};
const until = async (fn, what, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

ui.test("one live list of everything on the device (state, percent, bytes, speed, time left); stateOf per card from memory; the other tab hears it", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile);
  try {
    const film = srv.lib.film1;
    // every row the screen would be given, as it comes
    await page.evaluate(async () => {
      const o = await import("/js/offline.js");
      window.__rows = [];
      o.watchSaves((rows) => window.__rows.push(rows.map((r) => ({ ...r }))));
    });
    // the bytes held back a moment, so the save is seen under way
    let release;
    const held = new Promise((r) => { release = r; });
    let n = 0;
    await context.route("**/stream/video/**", async (route) => { if (++n > 4) await held; route.continue().catch(() => {}); });
    await page.evaluate(async (id) => {
      const o = await import("/js/offline.js");
      const { api } = await import("/js/api.js");
      window.__done = o.saveItem(await api.item(id), () => {}, async () => "original");
    }, film.id);
    await until(() => page.evaluate((id) => (window.__rows.at(-1) || []).some((r) => r.id === id && r.state === "saving" && r.bytes > 0), film.id), "a saving row with bytes");
    const saving = await page.evaluate((id) => window.__rows.at(-1).find((r) => r.id === id), film.id);
    assert.equal(saving.kind, "save");
    assert.ok(saving.totalBytes > 2e6, `total ${saving.totalBytes}`);
    assert.ok(saving.pct > 0 && saving.pct < 1);
    assert.ok(Math.abs(saving.bytes - saving.pct * saving.totalBytes) < 2, "bytes = pct × total");
    assert.ok("speed" in saving && "eta" in saving);
    assert.equal(await page.evaluate(async (id) => (await import("/js/offline.js")).stateOf(id), film.id), "saving");
    // a second tab of the same browser
    const other = await open(srv, profile, context);
    release();
    await page.evaluate(() => window.__done);
    const copy = await page.evaluate((id) => window.__rows.at(-1).find((r) => r.id === id), film.id);
    assert.equal(copy.kind, "copy");
    assert.equal(copy.state, "saved");
    assert.equal(copy.pct, 1);
    assert.ok(copy.bytes > 2e6);
    await until(() => other.page.evaluate(async (id) => (await import("/js/offline.js")).savedNow(id), film.id), "the other tab knows it is saved");
    // per card: thousands of answers in a few milliseconds (no IndexedDB per card)
    const ms = await page.evaluate(async (id) => {
      const o = await import("/js/offline.js");
      const t = performance.now();
      let k = 0;
      for (let i = 0; i < 5000; i++) if (o.stateOf(i % 2 ? id : `nope${i}`) === "saved") k++;
      return { ms: performance.now() - t, k };
    }, film.id);
    assert.equal(ms.k, 2500);
    assert.ok(ms.ms < 50, `5000 answers in ${ms.ms.toFixed(1)} ms`);
    // removed: everywhere at once
    await page.evaluate(async (id) => (await import("/js/offline.js")).removeSaved(id), film.id);
    assert.equal(await page.evaluate(async (id) => (await import("/js/offline.js")).stateOf(id), film.id), null);
    await until(async () => !(await other.page.evaluate(async (id) => (await import("/js/offline.js")).savedNow(id), film.id)), "the other tab hears the removal");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("watchedCopies lists what was watched to the end (with sizes, removing nothing); storageSummary adds it up", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile);
  try {
    for (const id of [srv.lib.e1.id, srv.lib.e2.id]) {
      await page.evaluate(async (x) => {
        const o = await import("/js/offline.js");
        const { api } = await import("/js/api.js");
        await o.saveItem(await api.item(x), () => {}, async () => "original");
      }, id);
    }
    // episode 1 watched to the end (the history the app holds), episode 2 half
    await srv.api.setProgress(profile, srv.lib.e1.id, 44, 45);
    await srv.api.setProgress(profile, srv.lib.e2.id, 20, 45);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app .screen");
    await until(() => page.evaluate(async () => { const { state } = await import("/js/state.js"); return Object.keys(state.progress || {}).length >= 2; }), "the history read");
    const w = await page.evaluate(async () => { const r = await (await import("/js/offline.js")).watchedCopies(); return { ids: r.copies.map((c) => c.id), total: r.totalBytes, sizes: r.copies.map((c) => c.sizeBytes) }; });
    assert.deepEqual(w.ids, [srv.lib.e1.id]);
    assert.ok(w.total > 0 && w.total === w.sizes[0]);
    assert.equal((await page.evaluate(async () => (await (await import("/js/offline.js")).listSaved()).length)), 2, "nothing removed by asking");
    const s = await page.evaluate(async () => (await import("/js/offline.js")).storageSummary());
    assert.equal(s.count, 2);
    assert.ok(s.bytes > 0 && s.usage >= s.bytes * 0.9, JSON.stringify(s));
    assert.ok(s.quota > s.usage && s.free > 0);
    assert.ok(s.persisted === false || s.persisted === true);
    assert.equal(s.safariMayClear, false, "Chrome");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.run({ concurrency: 2 });
