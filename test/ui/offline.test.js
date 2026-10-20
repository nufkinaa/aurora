// Saving to a PHONE (elia, 2026-10-20: "phone is the second most popular
// platform so it has to be fast, stable and polished").
//
// The report: on his iPhone, an episode's offline button → Original "just
// says 'Preparing on the server' and does not start the download". The
// server had ONE slot for every copy, and a play-ready copy made ahead of
// time after a download held it while somebody's stream was being encoded;
// the person's ten-second repackaging waited behind it, saying nothing
// (src/media/offline.js, test/offline-queue.test.js). This server is put in
// that state on purpose (support/offline-busy.js): a viewer encode that does
// not end, and a made-ahead copy of Test Film Two waiting for the encoder.
//
// And what a phone is offered: Save offline (kept inside Aurora, playable with
// no server) wherever it used to be handed the raw file (on an iPhone that
// went to Files, outside Aurora, with no progress here) — the episode card,
// the title page, the season bar, a sources sheet. A computer keeps both.
//
// These pages have a service worker (it is what plays a saved copy), so they
// make their own contexts instead of the suite's.
const path = require("path");
const fs = require("fs");
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite({
  server: { preload: [path.join(__dirname, "support", "offline-busy.js")], env: { UI_OFFLINE_BUSY: "1" } },
});
const SMALL = { width: 375, height: 667 };
const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "phone-offline");
const shot = async (page, name) => {
  if (!process.env.UI_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `test-${name}.png`) }).catch(() => {});
};

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

// A page with its service worker, as a phone (touch, coarse pointer) or a computer.
const open = async (srv, profile, viewport, { look = "glass", init = null } = {}) => {
  if (look !== "glass") await srv.api.ok("PUT", `/api/profiles/${profile.id}`, { look }, await srv.api.as(profile));
  const phone = viewport.width < 600;
  const context = await ui.browser.newContext({ viewport, serviceWorkers: "allow", ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.stack) || e)));
  await seedSignIn(page, profile);
  if (init) await page.addInitScript(init);
  const go = async (hash, selector = "#app .screen") => {
    if (!page.url().startsWith(srv.url)) await page.goto(`${srv.url}/${hash}`, { waitUntil: "domcontentloaded" });
    else await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForSelector(selector, { timeout: 30000 });
  };
  return { context, page, errors, go };
};
const controlled = (page) => page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
const pick = async (page, label) => {
  await page.waitForSelector(".offline-sheet .offline-opt");
  await page.locator(".offline-sheet .offline-opt", { hasText: label }).first().click();
};

ui.test("the iPhone report: Original is saved in seconds while the server is busy with somebody's stream and a copy made ahead of time — never 'Preparing' for ever", async ({ srv, freshProfile }) => {
  const { context, page, errors, go } = await open(srv, await freshProfile(), PHONE);
  try {
    // the server is in the reported state: a made-ahead copy of this very film waits for the encoder
    const film = srv.lib.film2; // an MKV: Original is a repackaging (video copied, sound to AAC)
    await go(`#/movie/${film.id}`, '[data-ui="detail.offline"]');
    await controlled(page);
    const btn = page.locator('[data-ui="detail.offline"]').first();
    const t0 = Date.now();
    await btn.click();
    await pick(page, "Original");
    await page.waitForFunction(() => /Saved/.test(document.querySelector('[data-ui="detail.offline"]').textContent), null, { timeout: 30000 });
    const secs = (Date.now() - t0) / 1000;
    assert.ok(secs < 25, `saved in ${secs.toFixed(1)} s`);
    assert.ok(srv.log().some((l) => /\[offline\] ready \w+ at original/.test(l)), "the server made the copy");
    // it is on the device, and the made-ahead copy is still waiting (nothing was lost)
    await go("#/saved", ".saved-section");
    await page.locator(".saved-section .dl-row", { hasText: film.title }).waitFor();
    const ahead = await srv.api.get(`/api/offline/status/${film.id}?q=1080`);
    assert.equal(ahead.state, "queued");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("a save that has to wait says why — on the title, My downloads and On this device, with a moving bar and Cancel; Cancel stops it on the server too", async ({ srv, freshProfile }) => {
  const { context, page, errors, go } = await open(srv, await freshProfile(), PHONE);
  try {
    const film = srv.lib.film1;
    await go(`#/movie/${film.id}`, '[data-ui="detail.offline"]');
    await controlled(page);
    const btn = page.locator('[data-ui="detail.offline"]').first();
    await btn.click();
    await pick(page, "480p"); // an encode: it waits while somebody's stream is being encoded
    await page.waitForFunction(() => /Waiting/.test(document.querySelector('[data-ui="detail.offline"]').textContent), null, { timeout: 15000 });
    const row = page.locator('.device-job[data-state="preparing"]');
    for (const [hash, heading] of [["#/downloads", /Saving to this device/], ["#/saved", /Saving now/]]) {
      await go(hash, ".device-jobs:not(.hidden) .device-job");
      assert.match(await page.locator(".device-jobs .row-title").innerText(), heading);
      const text = await row.innerText();
      assert.match(text, /Waiting for the server/);
      assert.match(text, /converting somebody's stream/);
      const bar = await row.locator(".dl-bar.dl-bar-idle").boundingBox();
      assert.ok(bar && bar.height >= 2 && bar.width > 100, "a bar that shows it is alive");
      const cancel = await row.locator("button", { hasText: "Cancel" }).boundingBox();
      assert.ok(cancel && cancel.height >= 40, "Cancel is a real tap target");
      await shot(page, `waiting-${hash.slice(2)}`);
    }
    // On this device: the save under way comes before Your files' picker (it was below the fold)
    const order = await page.evaluate(() => [".saving-host", ".lf"].map((s) => (document.querySelector(s) || { getBoundingClientRect: () => ({ top: -1 }) }).getBoundingClientRect().top));
    assert.ok(order[0] >= 0 && order[0] < order[1], `Saving now above Your files (${order})`);
    assert.ok(order[0] < 844, "and on the first screen");
    const status = await srv.api.get(`/api/offline/status/${film.id}?q=480`);
    assert.equal(status.state, "queued");
    assert.equal(status.wait.reason, "viewers");
    await row.locator("button", { hasText: "Cancel" }).click();
    await page.waitForSelector(".device-jobs.hidden", { state: "attached" });
    await page.waitForFunction(async (id) => (await (await fetch(`/api/offline/status/${id}?q=480`)).json()).state === "idle", film.id, { timeout: 10000 });
    assert.ok(srv.log().some((l) => new RegExp(`${film.id} at 480: cancelled`).test(l)), "the server was told");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

for (const [name, viewport, look] of [["phone 390 glass", PHONE, "glass"], ["phone 375 classic", SMALL, "legacy"], ["desktop", DESKTOP, "glass"]]) {
  const phone = viewport.width < 600;
  ui.test(`${name}: what each download button does — ${phone ? "Save offline inside Aurora on the episode card, the title page, the season bar and the sources sheet" : "the file to this computer, and Save offline beside it"}`, async ({ srv, freshProfile }) => {
    const { context, page, errors, go } = await open(srv, await freshProfile(), viewport, { look });
    try {
      await go(`#/show/${srv.lib.show.id}`, ".episode-wrap");
      await page.waitForTimeout(800);
      const count = (sel) => page.locator(sel).count();
      if (phone) {
        assert.equal(await count('.episode-wrap [data-ui="detail.episode.offline"]'), 3, "every episode on disk: Save offline");
        assert.equal(await count('[data-ui="detail.episode.download"]'), 0, "no raw file on a phone's card");
        const pill = page.locator('[data-ui="detail.offline.seasonall"]');
        assert.match(await pill.innerText(), /Save season offline \(3\)/);
        assert.equal(await count(".season-pill:has-text('Download season to device')"), 0);
        // 40 px to the finger, nothing on top of them, nothing past the edge
        await page.evaluate(() => document.querySelector(".episode-wrap").scrollIntoView({ block: "center", inline: "nearest" }));
        await page.waitForTimeout(400);
        const boxes = await page.evaluate(() => [...document.querySelectorAll(".episode-wrap")].slice(0, 1).flatMap((w) => [...w.querySelectorAll(":scope > .ep-action")].filter((b) => !b.hidden).map((b) => { const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { ui: b.dataset.ui, w: r.width, h: r.height, hit: !!at && (at === b || b.contains(at)) }; })));
        for (const b of boxes) assert.ok(b.w >= 40 && b.h >= 40 && b.hit, `${b.ui}: ${Math.round(b.w)}×${Math.round(b.h)}, tappable ${b.hit}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "no sideways scroll");
        await shot(page, `buttons-${name.replace(/ /g, "-")}-show`);
        // the hold sheet (a long press on the card opens its sources): the "Yours" row keeps it inside Aurora
        await page.locator('.episode-wrap .episode[data-ep="1x1"]').dispatchEvent("contextmenu");
        await page.waitForSelector(".src-card.owned");
        assert.equal(await count('.src-card.owned [data-ui="detail.source.download"]'), 0);
        assert.equal(await count('.src-card.owned [data-ui="detail.offline"]'), 1);
        await shot(page, `buttons-${name.replace(/ /g, "-")}-sheet`);
      } else {
        assert.equal(await count('[data-ui="detail.episode.download"]'), 3, "a computer: the file, from each card");
        assert.equal(await count('[data-ui="detail.episode.offline"]'), 0);
        assert.match(await page.locator(".season-pill", { hasText: "Download season to device" }).innerText(), /\(3\)/);
      }
      await go(`#/movie/${srv.lib.film1.id}`, '[data-ui="detail.offline"]');
      assert.equal(await count('[data-ui="detail.download.device"]'), phone ? 0 : 1);
      assert.ok(await count('[data-ui="detail.offline"]') >= 1, "Save offline on the title page");
      assert.deepEqual(errors, []);
    } finally {
      await context.close().catch(() => {});
    }
  });
}

ui.test("phone 375: an episode saved from its card (progress on the card and in My downloads), played with the network cut, and removed from its card only after asking", { allow: [/Failed to load resource/, /ERR_INTERNET_DISCONNECTED/, /WebSocket/] }, async ({ srv, freshProfile }) => {
  const { context, page, errors, go } = await open(srv, await freshProfile(), SMALL);
  try {
    await go(`#/show/${srv.lib.show.id}`, '.episode-wrap [data-ui="detail.episode.offline"]');
    await controlled(page);
    // the bytes held back: the save is seen under way
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route("**/stream/video/**", async (route) => { await held; route.continue().catch(() => {}); });
    const epBtn = page.locator('.episode-wrap:has(.episode[data-ep="1x1"]) [data-ui="detail.episode.offline"]');
    await epBtn.click();
    await pick(page, "Original");
    await page.waitForFunction(() => /%/.test((document.querySelector('.episode-wrap:has(.episode[data-ep="1x1"]) [data-ui="detail.episode.offline"]') || {}).textContent || ""));
    assert.match(await epBtn.getAttribute("aria-label"), /episode 1: Saving \d+%/);
    await go("#/downloads", '.device-job[data-state="saving"]');
    assert.match(await page.locator(".device-job").innerText(), /Test Show · S1 E1[\s\S]*Saving to this device · \d+%/);
    assert.equal(await page.locator(".device-job .dl-bar").count(), 1);
    assert.match(await page.locator(".dl-empty h2").innerText(), /Nothing downloading to the server/, "the server's empty list does not contradict the save above it");
    await shot(page, "episode-saving-downloads");
    release();
    await page.unroute("**/stream/video/**");
    await page.waitForSelector(".device-jobs.hidden", { state: "attached", timeout: 30000 });
    // played from the device, with no network at all
    await go("#/saved", '[data-ui="saved.play"]');
    assert.match(await page.locator(".saved-section .dl-row").innerText(), /Test Show · S1 E1/);
    await context.setOffline(true);
    await page.locator('[data-ui="saved.play"]').first().click();
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 1; }, null, { timeout: 30000 });
    assert.match(await page.evaluate(() => document.querySelector(".player video").currentSrc), /\/offline\/media\//);
    await shot(page, "episode-offline-playing");
    await context.setOffline(false);
    // the card says it is here; one tap asks before anything is removed
    await go(`#/show/${srv.lib.show.id}`, '.episode-wrap [data-ui="detail.episode.offline"]');
    await page.waitForFunction(() => document.querySelector('.episode-wrap:has(.episode[data-ep="1x1"]) [data-ui="detail.episode.offline"]').classList.contains("saved"));
    await epBtn.click();
    const ask = page.locator("#toasts .toast:has(button:has-text('Remove'))");
    await ask.waitFor();
    assert.equal(await epBtn.evaluate((b) => b.classList.contains("saved")), true, "nothing removed by the tap itself");
    await ask.locator("button", { hasText: "Remove" }).click();
    await page.waitForFunction(() => !document.querySelector('.episode-wrap:has(.episode[data-ep="1x1"]) [data-ui="detail.episode.offline"]').classList.contains("saved"));
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("phone: no room on the device says so before anything is fetched; a save cancelled half-way leaves nothing behind", async ({ srv, freshProfile }) => {
  // a browser with 1 MB to spare
  const tight = () => {
    try {
      if (!sessionStorage.getItem("tight")) return;
      navigator.storage.estimate = async () => ({ quota: 4 * 1024 * 1024, usage: 3 * 1024 * 1024 });
    } catch {}
  };
  const { context, page, errors, go } = await open(srv, await freshProfile(), PHONE, { init: tight });
  try {
    const film = srv.lib.film1;
    await go(`#/movie/${film.id}`, '[data-ui="detail.offline"]');
    await controlled(page);
    await page.evaluate(() => sessionStorage.setItem("tight", "1"));
    await page.reload({ waitUntil: "domcontentloaded" });
    const btn = page.locator('[data-ui="detail.offline"]').first();
    await btn.waitFor();
    await btn.click();
    await pick(page, "Original");
    await page.locator("#toasts .toast", { hasText: "not enough browser storage" }).first().waitFor();
    await go("#/saved", '.device-job[data-state="failed"]');
    assert.match(await page.locator(".device-job").innerText(), /Didn't save[\s\S]*not enough browser storage[\s\S]*Try a smaller size/);
    assert.equal(await page.locator(".device-job button", { hasText: "Retry" }).count(), 1);
    await shot(page, "storage-full");
    await page.locator(".device-job button", { hasText: "Dismiss" }).click();
    await page.evaluate(() => sessionStorage.removeItem("tight"));
    await page.reload({ waitUntil: "domcontentloaded" });
    // cancelled while the bytes come in
    await page.route("**/stream/video/**", () => {}); // never answered
    await go(`#/movie/${film.id}`, '[data-ui="detail.offline"]');
    await btn.click();
    await pick(page, "Original");
    await go("#/saved", '.device-job[data-state="saving"]');
    await page.locator(".device-job button", { hasText: "Cancel" }).click();
    await page.waitForSelector(".device-jobs.hidden", { state: "attached" });
    await page.locator("#toasts .toast", { hasText: "Save cancelled" }).first().waitFor();
    assert.equal(await page.evaluate(async () => (await caches.open("aurora-media").then((c) => c.keys())).length), 0, "no half a film in the cache");
    assert.equal(await page.locator(".saved-section .dl-row").count(), 0);
    await page.unroute("**/stream/video/**");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.run({ concurrency: 2 });
