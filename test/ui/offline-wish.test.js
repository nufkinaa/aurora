// "Save it to this device too" — before the server has it (elia, 2026-11-10:
// "…schedule download to phone before it downloaded to the server").
// docs/offline-wishes.md; the server side is test/offline-wish*.test.js.
//
// A download is STAGED on the private instance with a fake engine
// (support/wish-stage.js — nothing leaves the machine) and made to land; the
// page, opened or not, saves the title by itself. These pages have a service
// worker, so they make their own contexts (as offline.test.js does).
const path = require("path");
const fs = require("fs");
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite({
  server: { preload: [path.join(__dirname, "support", "wish-stage.js")], env: { UI_WISH_STAGE: "1" } },
});

let n = 0;
const stage = async (srv, cmd) => {
  const dir = path.join(srv.root, "wish-stage");
  for (let i = 0; i < 100 && !fs.existsSync(dir); i++) await new Promise((r) => setTimeout(r, 100));
  const name = `${Date.now()}${String(++n).padStart(3, "0")}`;
  fs.writeFileSync(path.join(dir, `${name}.tmp`), JSON.stringify(cmd));
  fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, `${name}.json`));
  const done = path.join(dir, `${name}.done.json`);
  for (let i = 0; i < 300; i++) {
    if (fs.existsSync(done)) {
      const out = JSON.parse(fs.readFileSync(done, "utf-8"));
      assert.ok(out.ok, `stage ${cmd.op}: ${out.error}`);
      return out;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`stage ${cmd.op}: no answer`);
};
const hashOf = (s) => require("crypto").createHash("sha1").update(s + Date.now() + Math.random()).digest("hex");
const filmFile = (srv) => path.join(srv.media, "movies", "Test Film One (2020)", "Test Film One (2020).mp4");
const episodeFile = (srv, e) => path.join(srv.media, "shows", "Test Show", "Season 1", `Test Show S01E0${e}.mp4`);

const seedSignIn = async (page, profile) => {
  await page.addInitScript(({ id }) => {
    try {
      if (sessionStorage.getItem("ui-test-seeded")) return;
      sessionStorage.setItem("ui-test-seeded", "1");
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-kbd-hint", "1");
      localStorage.setItem("aurora-nav-hinted", "1");
    } catch {}
  }, { id: profile.id });
};
const open = async (srv, profile, viewport, context = null) => {
  const phone = viewport.width < 600;
  const ctx = context || await ui.browser.newContext({ viewport, serviceWorkers: "allow", ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  if (!context) await ctx.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.stack) || e)));
  await seedSignIn(page, profile);
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
  await page.waitForSelector(".offline-sheet", { state: "detached" });
};
const savedHere = (page, title) => page.evaluate(async (t) => (await (await import("/js/offline.js")).listSaved()).some((s) => s.title === t), title);
const until = async (fn, what, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};
const wishesOf = async (srv, profile) => (await srv.api.get(`/api/profiles/${profile.id}/offline-wishes`, await srv.api.as(profile))).wishes;

ui.test("phone: a film on its way → 'This device too' on My downloads → it lands → saved here by itself, and plays with the network cut", { allow: [/Failed to load resource/, /ERR_INTERNET_DISCONNECTED/, /WebSocket/] }, async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const hash = hashOf("film");
  await stage(srv, { op: "create", hash, src: filmFile(srv), fields: { type: "movie", imdbId: "tt9810001", title: "Wish Film", year: 2024, quality: "1080p", profile: profile.id } });
  const { context, page, errors, go } = await open(srv, profile, PHONE);
  try {
    await go("#/downloads", '[data-ui="downloads.offline.wish"]');
    await controlled(page);
    const btn = page.locator('[data-ui="downloads.offline.wish"]').first();
    assert.match(await btn.innerText(), /This device too/);
    await btn.click();
    await page.waitForSelector(".offline-sheet .offline-opt");
    assert.match(await page.locator(".offline-sheet").innerText(), /isn't on the server yet[\s\S]*saved inside Aurora on this device as soon as it arrives/);
    await pick(page, "Original");
    await page.waitForFunction(() => /Will be saved here/.test(document.querySelector('[data-ui="downloads.offline.wish"]').innerText));
    // the row that says what this device waits for
    const row = page.locator('.device-wish[data-state="wish-waiting"]');
    await row.waitFor();
    assert.match(await row.innerText(), /Wish Film[\s\S]*Waiting for the server's copy[\s\S]*saved here by itself/);
    const w = await wishesOf(srv, profile);
    assert.equal(w.length, 1);
    assert.equal(w[0].state, "waiting");
    assert.equal(w[0].quality, "original");
    await go("#/saved", '.device-wish[data-state="wish-waiting"]');
    // it lands: saved here with nobody pressing anything
    await stage(srv, { op: "land", hash });
    await until(() => savedHere(page, "Wish Film"), "the title to be saved by itself");
    await page.waitForSelector(".device-jobs.hidden", { state: "attached", timeout: 30000 });
    await until(async () => (await wishesOf(srv, profile)).length === 0, "the wish to end");
    await page.locator("#toasts .toast", { hasText: "arrived and is saved on this device" }).first().waitFor();
    await page.locator(".saved-section .dl-row", { hasText: "Wish Film" }).waitFor();
    // and it plays from here, with no network
    await context.setOffline(true);
    await page.locator(".saved-section .dl-row", { hasText: "Wish Film" }).locator('[data-ui="saved.play"]').click();
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 1 && /\/offline\/media\//.test(v.currentSrc); }, null, { timeout: 30000 });
    await context.setOffline(false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("desktop: the wish is made, the page is closed, the film lands — the next time Aurora is opened it saves by itself", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const hash = hashOf("closed");
  await stage(srv, { op: "create", hash, src: filmFile(srv), fields: { type: "movie", imdbId: "tt9810002", title: "Later Film", year: 2024, quality: "720p", profile: profile.id } });
  const first = await open(srv, profile, DESKTOP);
  const { context } = first;
  try {
    await first.go("#/downloads", '[data-ui="downloads.offline.wish"]');
    await controlled(first.page);
    await first.page.locator('[data-ui="downloads.offline.wish"]').first().click();
    await pick(first.page, "Original");
    await until(async () => (await wishesOf(srv, profile)).length === 1, "the wish");
    await first.page.close();
    await stage(srv, { op: "land", hash });
    await until(async () => (await wishesOf(srv, profile))[0].state === "ready", "the wish to be ready on the server");
    // Aurora opened again, on Home: nothing to press
    const again = await open(srv, profile, DESKTOP, context);
    await again.go("#/", "#app .screen");
    await until(() => savedHere(again.page, "Later Film"), "saved by itself on opening", 60000);
    await until(async () => (await wishesOf(srv, profile)).length === 0, "the wish to end");
    assert.deepEqual(again.errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("phone: a download that is cancelled — the wish says it won't arrive, Dismiss clears it here and on the server", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const hash = hashOf("cancel");
  const { jobId } = await stage(srv, { op: "create", hash, src: filmFile(srv), fields: { type: "movie", imdbId: "tt9810003", title: "Gone Film", year: 2024, quality: "720p", profile: profile.id } });
  const { context, page, errors, go } = await open(srv, profile, PHONE);
  try {
    await go("#/downloads", '[data-ui="downloads.offline.wish"]');
    await controlled(page);
    await page.locator('[data-ui="downloads.offline.wish"]').first().click();
    await pick(page, "720p");
    await page.locator('.device-wish[data-state="wish-waiting"]').waitFor();
    await go("#/saved", '.device-wish[data-state="wish-waiting"]');
    await stage(srv, { op: "fail", jobId });
    const row = page.locator('.device-wish[data-state="wish-failed"]');
    await row.waitFor({ timeout: 30000 });
    assert.match(await row.innerText(), /Won't arrive[\s\S]*cancelled — there is nothing to save/);
    await row.locator('[data-ui="saved.wish.dismiss"]').click();
    await page.waitForSelector(".device-jobs.hidden", { state: "attached" });
    await until(async () => (await wishesOf(srv, profile)).length === 0, "the wish gone on the server");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("phone: 'and every new episode of season 1' — each episode that lands is saved by itself; Cancel ends it", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const h1 = hashOf("e1");
  await stage(srv, { op: "create", hash: h1, src: episodeFile(srv, 1), fields: { type: "show", imdbId: "tt9810004", title: "Wish Show", season: 1, episode: 1, quality: "720p", profile: profile.id } });
  const { context, page, errors, go } = await open(srv, profile, PHONE);
  try {
    await go("#/downloads", '[data-ui="downloads.offline.wish"]');
    await controlled(page);
    await page.locator('[data-ui="downloads.offline.wish"]').first().click();
    await page.waitForSelector(".offline-sheet .offline-toggle");
    assert.deepEqual(await page.locator(".offline-sheet .offline-toggle").allInnerTexts(), ["And every new episode of season 1", "And every new episode of this show"]);
    await page.locator(".offline-sheet .offline-toggle", { hasText: "season 1" }).click();
    await pick(page, "Original");
    await go("#/saved", '.device-wish[data-state="wish-season"]');
    assert.match(await page.locator('.device-wish[data-state="wish-season"]').innerText(), /Wish Show · S1[\s\S]*Every new episode of season 1/);
    const w = await wishesOf(srv, profile);
    assert.equal(w.length, 1);
    assert.equal(w[0].scope, "season");
    await stage(srv, { op: "land", hash: h1 });
    await until(() => page.evaluate(async () => (await (await import("/js/offline.js")).listSaved()).filter((s) => s.showTitle === "Wish Show").length === 1), "episode 1 saved by itself");
    // a second episode, downloaded later by anybody, lands too
    const h2 = hashOf("e2");
    await stage(srv, { op: "create", hash: h2, src: episodeFile(srv, 2), fields: { type: "show", imdbId: "tt9810004", title: "Wish Show", season: 1, episode: 2, quality: "720p" } });
    await stage(srv, { op: "land", hash: h2 });
    await until(() => page.evaluate(async () => (await (await import("/js/offline.js")).listSaved()).filter((s) => s.showTitle === "Wish Show").length === 2), "episode 2 saved by itself");
    // the season wish waits on; Cancel ends it
    const season = page.locator('.device-wish[data-state="wish-season"]');
    await season.waitFor();
    await season.locator('[data-ui="saved.wish.cancel"]').click();
    await until(async () => (await wishesOf(srv, profile)).length === 0, "the season wish gone");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("phone: Save & watch on a film's title page — the 'Downloading now!' sheet offers 'This device too', and the page then says it will be saved to this device", async ({ srv, freshProfile }) => {
  // (no network here: the film's metadata and its sources are answered in the
  // browser, and the download request is caught — test/ui/release.test.js's way)
  const FILM = "tt9810009";
  const profile = await freshProfile();
  // (no service worker here: the answers below are given to the page itself,
  // and a worker would ask the server instead — the wish needs none)
  const own = await ui.browser.newContext({ viewport: PHONE, serviceWorkers: "block", hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await own.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const { context, page, errors, go } = await open(srv, profile, PHONE, own);
  try {
    const H = "e".repeat(40);
    await page.route(`**/api/discover/meta/movie/${FILM}`, (route) =>
      route.fulfill({ json: { imdbId: FILM, type: "movie", title: "Plane Film", year: 2025, runtime: "100 min", synopsis: "For the flight.", genres: ["Drama"], cast: [], trailers: [] } }));
    const best = {
      infoHash: H, fileIdx: 0, filename: "Plane.Film.2025.1080p.WEB-DL.mkv", release: "Plane.Film.2025.1080p.WEB-DL", provider: "test", quality: "1080p", qualityLabel: "1080p", tags: [], cam: false,
      prerelease: null, hardsub: false, badge: null, warning: null, dubbed: false, seeders: 40, sizeString: "2.0 GB", sizeBytes: 2e9, languages: ["EN"], pack: false, recommended: true,
    };
    await page.route(/\/api\/torrents\/sources\?/, (route) => route.fulfill({ json: { imdbId: FILM, streams: [best], best } }));
    await page.route(/\/api\/downloads(\?|$)/, (route) => {
      if (route.request().method() !== "POST") return route.fulfill({ json: [] });
      const b = route.request().postDataJSON();
      return route.fulfill({ json: { job: { id: "abcabcabcabc", status: "approved", progress: 0, infoHash: b.infoHash, fileIdx: 0, imdbId: b.imdbId, title: b.title, type: "movie", mine: true } } });
    });
    await go(`#/discover/movie/${FILM}`, '[data-ui="detail.save"]');
    await page.locator(".sources-section .src-card").first().waitFor({ state: "attached" });
    await page.locator('[data-ui="detail.save"]').click();
    const sheetBtn = page.locator('.dl-confirm [data-ui="detail.offline.wish"]');
    await sheetBtn.waitFor();
    assert.match(await sheetBtn.innerText(), /This device too/);
    if (process.env.UI_SHOTS) await page.screenshot({ path: path.join(process.env.UI_SHOTS, "wish-downloading-now-sheet.png") });
    await sheetBtn.click();
    await page.waitForSelector(".offline-sheet .offline-opt");
    // a 100-minute film: the sizes are estimated from its running time
    assert.match(await page.locator(".offline-sheet .offline-opt", { hasText: "720p" }).innerText(), /GB|MB/);
    await pick(page, "720p");
    await until(async () => (await wishesOf(srv, profile)).length === 1, "the wish on the server");
    const w = (await wishesOf(srv, profile))[0];
    assert.equal(w.imdbId, FILM);
    assert.equal(w.jobId, "abcabcabcabc");
    assert.equal(w.quality, "720");
    await page.waitForFunction(() => /Will be saved to this device/.test((document.querySelector('.dl-confirm [data-ui="detail.offline.wish"]') || {}).innerText || ""));
    // the sheet closed: the title page says it too, beside the download
    await page.locator(".dl-confirm .btn-primary").click();
    const hero = page.locator('.detail-actions [data-ui="detail.offline.wish"], .screen [data-ui="detail.offline.wish"]').first();
    await hero.waitFor();
    assert.match(await hero.getAttribute("title"), /Will be saved to this device when it arrives/);
    if (process.env.UI_SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: path.join(process.env.UI_SHOTS, "wish-title-hero.png") }); }
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("phone: 'and every new episode of this show' — an episode of ANOTHER season that lands later is saved here by itself; the row says so; Cancel ends it", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const h1 = hashOf("show-e1");
  await stage(srv, { op: "create", hash: h1, src: episodeFile(srv, 1), fields: { type: "show", imdbId: "tt9810005", title: "Long Show", season: 1, episode: 1, quality: "720p", profile: profile.id } });
  const { context, page, errors, go } = await open(srv, profile, PHONE);
  try {
    await go("#/downloads", '[data-ui="downloads.offline.wish"]');
    await controlled(page);
    await page.locator('[data-ui="downloads.offline.wish"]').first().click();
    await page.waitForSelector(".offline-sheet .offline-toggle");
    // the two choices exclude each other
    await page.locator(".offline-sheet .offline-toggle", { hasText: "season 1" }).click();
    await page.locator(".offline-sheet .offline-toggle", { hasText: "this show" }).click();
    assert.deepEqual(await page.$$eval(".offline-sheet .offline-toggle", (els) => els.map((e) => e.getAttribute("aria-pressed"))), ["false", "true"]);
    await pick(page, "Original");
    await go("#/saved", '.device-wish[data-state="wish-show"]');
    assert.match(await page.locator('.device-wish[data-state="wish-show"]').innerText(), /Long Show[\s\S]*Every new episode/);
    const w = await wishesOf(srv, profile);
    assert.equal(w.length, 1);
    assert.equal(w[0].scope, "show");
    assert.equal(w[0].season, null);
    // episode 1 lands, then — later, downloaded by anybody — season 2's first
    await stage(srv, { op: "land", hash: h1 });
    const h2 = hashOf("show-s2e1");
    await stage(srv, { op: "create", hash: h2, src: episodeFile(srv, 2), fields: { type: "show", imdbId: "tt9810005", title: "Long Show", season: 2, episode: 1, quality: "720p" } });
    await stage(srv, { op: "land", hash: h2 });
    await until(() => page.evaluate(async () => (await (await import("/js/offline.js")).listSaved()).filter((s) => s.showTitle === "Long Show").map((s) => `${s.season}x${s.episode}`).sort().join(",") === "1x1,2x1"), "both saved by themselves", 90000);
    const row = page.locator('.device-wish[data-state="wish-show"]');
    await row.locator('[data-ui="saved.wish.cancel"]').click();
    await until(async () => (await wishesOf(srv, profile)).length === 0, "the show wish gone");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.run({ concurrency: 2 });
