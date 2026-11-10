// Saving to this device survives what browsers and phones do to pages
// (audit 2026-11-10, docs/offline-audit.md): a copy is saved in PARTS
// (js/offline.js); a reload, a closed tab or a dropped line no longer throws
// away what has landed — the save carries on by itself from the first missing
// part. Then: the copy plays and seeks with the network cut (the worker
// streams it from the parts), the minutes watched on a cold offline start are
// kept for the right profile and reach the server when it is back, and a
// kids profile on the same device sees and plays only what it saved itself.
//
// The test films are small: they are saved in 128 KB parts here (the
// "aurora-offline-part-bytes" knob), so a 2.6 MB film is 20 parts.
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite();
const PART = 131072;

// `bg`: let the browser's Background Fetch take the parts (off: the page's own loop, which these tests watch)
const open = async (srv, profile, viewport, context = null, { bg = false, part = PART } = {}) => {
  const phone = viewport.width < 600;
  const ctx = context || await ui.browser.newContext({ viewport, serviceWorkers: "allow", ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  if (!context) await ctx.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.stack) || e)));
  await page.addInitScript(({ id, part, bg }) => {
    try {
      localStorage.setItem("aurora-offline-part-bytes", String(part));
      localStorage.setItem("aurora-offline-bg", bg ? "1" : "0");
      if (sessionStorage.getItem("ui-test-seeded")) return;
      sessionStorage.setItem("ui-test-seeded", "1");
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-kbd-hint", "1");
      localStorage.setItem("aurora-nav-hinted", "1");
    } catch {}
  }, { id: profile.id, part, bg });
  const go = async (hash, selector = "#app .screen") => {
    if (!page.url().startsWith(srv.url)) await page.goto(`${srv.url}/${hash}`, { waitUntil: "domcontentloaded" });
    else await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForSelector(selector, { timeout: 30000 });
  };
  return { context: ctx, page, errors, go };
};
const controlled = (page) => page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
const pick = async (page, label) => {
  await page.waitForSelector(".offline-sheet .offline-opt");
  await page.locator(".offline-sheet .offline-opt", { hasText: label }).first().click();
};
const until = async (fn, what, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};
// (a record still `pending` is a save whose parts are landing — not a saved copy)
const savedRecord = (page, id) => page.evaluate(async (x) => { const r = await (await import("/js/offline.js")).getSaved(x); return r && !r.pending ? r : null; }, id);
const partCount = (page) => page.evaluate(async () => (await (await caches.open("aurora-media")).keys()).filter((r) => r.url.includes("/offline/part/")).length);
const jobState = (page) => page.evaluate(() => (JSON.parse(localStorage.getItem("aurora-offline-jobs") || "[]")[0] || {}).state || null);

ui.test("phone: a reload in the middle of a save — it carries on by itself from the parts already here, not from zero; the copy then plays and seeks with the network cut", { allow: [/Failed to load resource/, /ERR_INTERNET_DISCONNECTED/, /WebSocket/, /net::ERR/] }, async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const film = srv.lib.film1;
  const { context, page, errors, go } = await open(srv, profile, PHONE);
  try {
    await go(`#/movie/${film.id}`, '[data-ui="detail.offline"]');
    await controlled(page);
    // the parts' requests: counted, and after six the line "freezes"
    const ranges = [];
    let release;
    const held = new Promise((r) => { release = r; });
    await context.route("**/stream/video/**", async (route) => {
      const r = route.request().headers().range || "";
      ranges.push({ r, afterReload: reloaded });
      // the seventh part on: held (the line "freezes") until the page is gone
      if (!reloaded && ranges.length > 6) { await held; return route.abort("connectionreset").catch(() => {}); }
      route.continue().catch(() => {});
    });
    let reloaded = false;
    await page.locator('[data-ui="detail.offline"]').first().click();
    await pick(page, "Original");
    await until(async () => (await partCount(page)) >= 6, "six parts in");
    const before = await partCount(page);
    assert.equal(before, 6, `${before} parts in before the reload`);
    reloaded = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    release();
    // nobody presses anything: it carries on
    await until(async () => !!(await savedRecord(page, film.id)), "the save to finish by itself", 60000);
    const rec = await savedRecord(page, film.id);
    assert.equal(rec.format, 2);
    assert.equal(rec.profileId, profile.id);
    assert.equal(await partCount(page), 20, "every part, once");
    const again = ranges.filter((x) => x.afterReload).map((x) => x.r);
    for (let n = 0; n < before; n++) {
      const r = `bytes=${n * PART}-${(n + 1) * PART - 1}`;
      // (a part held when the line froze may be asked again; one that had landed never is)
      assert.ok(!again.includes(r) || n >= before, `part ${n} was not fetched again (after the reload: ${again.join(", ")})`);
    }
    assert.ok(again.length <= 20 - before + 3, `${again.length} parts asked after the reload for ${20 - before} missing`);
    await context.unroute("**/stream/video/**");
    // played from the device, network cut: far ahead and back
    await go("#/saved", '[data-ui="saved.play"]');
    await context.setOffline(true);
    await page.locator('[data-ui="saved.play"]').first().click();
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 0.5 && /\/offline\/media\//.test(v.currentSrc); }, null, { timeout: 30000 });
    const seeks = await page.evaluate(async () => {
      const v = document.querySelector(".player video");
      const seek = (t) => new Promise((r) => { v.addEventListener("seeked", () => r(v.currentTime), { once: true }); v.currentTime = t; setTimeout(() => r(-1), 15000); });
      return [await seek(v.duration - 3), await seek(2)];
    });
    assert.ok(seeks[0] > 50, `seeked near the end (${seeks[0]})`);
    assert.ok(seeks[1] >= 1 && seeks[1] < 5, `and back (${seeks[1]})`);
    await context.setOffline(false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("desktop: the line drops in the middle of a save — 'Waiting for the connection', then it carries on by itself", { allow: [/Failed to load resource/, /net::ERR/] }, async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const film = srv.lib.film1;
  const { context, page, errors, go } = await open(srv, profile, DESKTOP);
  try {
    await go(`#/movie/${film.id}`, '[data-ui="detail.offline"]');
    await controlled(page);
    let down = false;
    let seen = 0;
    await context.route("**/stream/video/**", (route) => {
      if (++seen === 5) down = true;
      if (down) return route.abort("connectionreset").catch(() => {});
      route.continue().catch(() => {});
    });
    await page.locator('[data-ui="detail.offline"]').first().click();
    await pick(page, "Original");
    await go("#/saved", '.device-job[data-state="retrying"]');
    const row = page.locator('.device-job[data-state="retrying"]');
    assert.match(await row.innerText(), /Waiting for the connection · \d+%[\s\S]*(trying again|carries on by itself)/);
    assert.equal(await row.locator("button", { hasText: "Cancel" }).count(), 1);
    down = false; // the line is back
    await until(async () => !!(await savedRecord(page, film.id)), "the save to carry on and finish", 60000);
    await page.waitForSelector(".device-jobs.hidden", { state: "attached" });
    assert.equal(await partCount(page), 20);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("phone: minutes watched after a cold start with no server are kept for the right person and reach the server when it is back; a kids profile on the same phone sees only its own copies", { allow: [/Failed to load resource/, /ERR_INTERNET_DISCONNECTED/, /WebSocket/, /net::ERR/] }, async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const film = srv.lib.film1;
  const first = await open(srv, profile, PHONE);
  const { context } = first;
  try {
    // saved on a first visit, with nothing else done online
    await first.go(`#/movie/${film.id}`, '[data-ui="detail.offline"]');
    await controlled(first.page);
    await first.page.locator('[data-ui="detail.offline"]').first().click();
    await pick(first.page, "Original");
    await until(async () => !!(await savedRecord(first.page, film.id)), "saved");
    await first.page.waitForTimeout(800); // (the worker keeps the profiles and the history for an offline boot)
    await first.page.close();
    // the next morning, on a plane: Aurora opened from cold, no network at all
    await context.setOffline(true);
    const plane = await open(srv, profile, PHONE, context);
    await plane.page.goto(`${srv.url}/`, { waitUntil: "domcontentloaded" });
    await plane.page.waitForSelector('[data-ui="saved.play"]', { timeout: 30000 });
    await plane.page.locator('[data-ui="saved.play"]').first().click();
    await plane.page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 0.5; }, null, { timeout: 30000 });
    await plane.page.evaluate(() => { document.querySelector(".player video").currentTime = 30; });
    await plane.page.waitForTimeout(6000);
    await plane.page.evaluate(() => { location.hash = "#/saved"; });
    await until(async () => (await plane.page.evaluate(async () => (await import("/js/offline.js")).queuedProgress())).some((r) => r.position >= 30), "the minutes queued on the device");
    const q = await plane.page.evaluate(async () => (await import("/js/offline.js")).queuedProgress());
    assert.equal(q[0].profileId, profile.id, "kept for the person who watched");
    // landed: the line is back, the minutes reach the server
    await context.setOffline(false);
    await plane.page.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(async () => { const st = await srv.api.state(profile); return st.progress[film.id] && st.progress[film.id].position >= 30; }, "the server to have the minutes", 30000);
    // a kids profile on the same phone: none of the grown-up's copies
    const kid = await srv.api.createProfile(`K${Date.now().toString(36).slice(-5)}`, { open: true, kids: { maxAge: 7 } });
    const kidPage = await open(srv, kid, PHONE, context);
    await kidPage.go("#/saved", ".saved-section");
    await kidPage.page.waitForTimeout(800);
    assert.equal(await kidPage.page.locator(".saved-section .dl-row").count(), 0, "the kids profile sees no grown-up's copy");
    await kidPage.go(`#/play/${film.id}?offline=1`, "#app .screen");
    await kidPage.page.waitForTimeout(1500);
    assert.ok(!/#\/play\//.test(kidPage.page.url()), "and cannot play it by its address");
    assert.deepEqual(plane.errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("phone with Background Fetch: Aurora goes to the background mid-save and the tab is then closed — the browser finishes the save with no Aurora page open", { allow: [/Failed to load resource/, /net::ERR/] }, async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const film = srv.lib.film1;
  const { context, page, go } = await open(srv, profile, PHONE, null, { bg: true });
  try {
    await go(`#/movie/${film.id}`, '[data-ui="detail.offline"]');
    await controlled(page);
    if (!(await page.evaluate(() => "BackgroundFetchManager" in window))) return; // (a browser without it: the page's own loop, tested above)
    // the page's own requests: four parts, then the line "freezes" for the page
    let seen = 0;
    await page.route("**/stream/video/**", (route) => { if (++seen <= 4) route.continue().catch(() => {}); });
    await page.locator('[data-ui="detail.offline"]').first().click();
    await pick(page, "Original");
    await until(async () => (await partCount(page)) >= 4, "four parts in");
    // the phone's screen goes off: Aurora is in the background
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await until(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).backgroundFetch.getIds()).length > 0), "the browser to take the rest", 30000);
    await page.close();
    // a page of the same address that does not run Aurora: only its storage is looked at
    const look = await context.newPage();
    await look.goto(`${srv.url}/sw-manifest.json`);
    const state = () => look.evaluate(async (id) => {
      const c = await caches.open("aurora-media");
      const parts = (await c.keys()).filter((r) => r.url.includes(`/offline/part/${id}/`)).length;
      const manifest = !!(await c.match(`/offline/manifest/${id}`));
      const rec = await new Promise((res) => { const r = indexedDB.open("aurora-offline", 1); r.onsuccess = () => { const g = r.result.transaction("items").objectStore("items").get(id); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); }; r.onerror = () => res(null); });
      return { parts, manifest, pending: rec ? !!rec.pending : null, byBrowser: rec ? !!rec.byBrowser : null, subs: rec ? (rec.subtitles || []).length : 0 };
    }, film.id);
    let last = null;
    await until(async () => { last = await state(); return last.manifest; }, "the browser and the worker to finish the save", 90000).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(last)}`); });
    const st = await state();
    assert.equal(st.parts, 20, "every part");
    assert.equal(st.pending, false, "the copy's record is a saved title now");
    assert.equal(st.byBrowser, true, "finished by the worker, with no page");
    assert.ok(st.subs >= 1, "its subtitles went with it (taken before the bytes)");
    // and Aurora, opened again, lists it and plays it with the network cut
    const back = await open(srv, profile, PHONE, context, { bg: true });
    await back.go("#/saved", '[data-ui="saved.play"]');
    await context.setOffline(true);
    await back.page.locator('[data-ui="saved.play"]').first().click();
    await back.page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 0.5; }, null, { timeout: 30000 });
    await context.setOffline(false);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("desktop: an MKV's Original (repackaged on the server) saved in many parts — its copy keeps one identity while it is fetched, so the parts fit together", async ({ srv, freshProfile }) => {
  // (the server moves the copy's date on every request to keep it from the
  // sweep; its validator used to move with it, and every part read as "the
  // file changed" — the save started over and over)
  const profile = await freshProfile();
  const film = srv.lib.film2;
  const { context, page, errors, go } = await open(srv, profile, DESKTOP);
  try {
    await go(`#/movie/${film.id}`, '[data-ui="detail.offline"]');
    await controlled(page);
    await page.locator('[data-ui="detail.offline"]').first().click();
    await pick(page, "Original");
    await until(async () => !!(await savedRecord(page, film.id)), "the repackaged copy to be saved", 120000);
    const rec = await savedRecord(page, film.id);
    const parts = await partCount(page);
    assert.equal(parts, Math.ceil(rec.sizeBytes / PART), `${parts} parts for ${rec.sizeBytes} bytes`);
    assert.ok(parts > 10);
    // the server's answers for two parts: one identity
    const tags = await page.evaluate(async (id) => {
      const a = await fetch(`/offline/file/${id}?q=original`, { headers: { Range: "bytes=0-9" }, cache: "no-store" });
      await new Promise((r) => setTimeout(r, 1100));
      const b = await fetch(`/offline/file/${id}?q=original`, { headers: { Range: "bytes=10-19" }, cache: "no-store" });
      return [a.headers.get("etag"), b.headers.get("etag"), a.headers.get("last-modified"), b.headers.get("last-modified")];
    }, film.id);
    assert.ok(tags[0] && tags[0] === tags[1], `one ETag: ${tags}`);
    // and it plays from the device
    await go("#/saved", '[data-ui="saved.play"]');
    await context.setOffline(true);
    await page.locator('[data-ui="saved.play"]').first().click();
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 0.5 && /\/offline\/media\//.test(v.currentSrc); }, null, { timeout: 30000 });
    await context.setOffline(false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.run({ concurrency: 2 });
