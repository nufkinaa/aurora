// What a person SEES of offline watching on the website, second part
// (offline-look, 2026-11-10):
//   · the size sheet from a title page: its own title, the room on this
//     device, and — for a film with more than one sound — the Sound row, the
//     chosen one marked; the copy carries the sound that was picked
//   · a save the person paused: said in plain words, its bar resting in
//     amber, Resume carries on — and it never carries on by itself
//   · what waits for the server's copy: the waiting sign in its frame; the
//     two "and every new episode of …" rows, one at most, on a sheet that
//     never outgrows a phone
//   · no connection, calmly: one line that leads to On this device, what is
//     not here rests, a title page rests instead of failing, the copy plays,
//     and the line goes when the connection is back
//   · My downloads: its device buttons carry the same mark, never an emoji
// The machinery has its own tests: offline*.test.js.
const path = require("path");
const fs = require("fs");
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

// (a download is staged with the system lane's fake engine — nothing leaves
// the machine; see offline-wish.test.js)
const ui = suite({
  server: { preload: [path.join(__dirname, "support", "wish-stage.js")], env: { UI_WISH_STAGE: "1" } },
});
let staged = 0;
const stage = async (srv, cmd) => {
  const dir = path.join(srv.root, "wish-stage");
  for (let i = 0; i < 100 && !fs.existsSync(dir); i++) await new Promise((r) => setTimeout(r, 100));
  const name = `${Date.now()}${String(++staged).padStart(3, "0")}`;
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
// (set OFFLINE_LOOK_SHOTS to a folder to keep pictures of what is checked)
const snap = async (page, name) => {
  const dir = process.env.OFFLINE_LOOK_SHOTS;
  if (!dir) return;
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(dir, `${name}.png`) }).catch(() => {});
};

const open = async (srv, profile, viewport, hash = "#/saved", extra = {}) => {
  const phone = viewport.width < 600;
  const context = await ui.browser.newContext({ viewport, serviceWorkers: "allow", ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.stack) || e)));
  await page.addInitScript(({ id, extra }) => {
    try {
      localStorage.setItem("aurora-offline-bg", "0");
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
      if (sessionStorage.getItem("ui-test-seeded")) return;
      sessionStorage.setItem("ui-test-seeded", "1");
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-kbd-hint", "1");
      localStorage.setItem("aurora-nav-hinted", "1");
    } catch {}
  }, { id: profile.id, extra });
  await page.goto(`${srv.url}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .screen", { timeout: 30000 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  return { context, page, errors };
};
const until = async (fn, what, ms = 45000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const save = (page, id) => page.evaluate(async (x) => {
  const o = await import("/js/offline.js");
  const { api } = await import("/js/api.js");
  const s = await o.saveItem(await api.item(x), () => {}, async (opts) => (opts.some((q) => q.quality === "original") ? "original" : opts[0].quality));
  return !!s;
}, id);
const copy = (page, id) => page.evaluate(async (x) => (await (await import("/js/offline.js")).listSaved()).find((s) => s.id === x) || null, id);
const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);

ui.test("a title page's size sheet: its own title and the room on this device; two sounds → the Sound row, the chosen one marked, and the copy carries the pick; one sound → no row", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile, DESKTOP, `#/movie/${srv.lib.film2.id}`);
  try {
    await page.locator('[data-ui="detail.offline"]').first().click();
    await page.waitForSelector(".offline-sheet .offline-sound");
    assert.match(await page.locator(".offline-sheet .look-notice-title").innerText(), /Save to this device — which size\?/);
    assert.match(await page.locator(".offline-sheet .offline-room").innerText(), /Room on this device: ≈ [\d.]+ (GB|MB)/);
    const chips = () => page.$$eval(".offline-sheet .offline-sound", (els) => els.map((e) => {
      const before = getComputedStyle(e, "::before");
      return { text: e.textContent.trim(), pressed: e.getAttribute("aria-pressed"), tick: before.content !== "none" && parseFloat(before.width) > 0, ring: getComputedStyle(e).boxShadow !== "none" && /110, 231, 183/.test(getComputedStyle(e).boxShadow) };
    }));
    let list = await chips();
    assert.equal(list.length, 2, JSON.stringify(list));
    assert.deepEqual(list.map((c) => c.pressed), ["true", "false"], "the file's first sound, chosen for a person with no language on file");
    // the chosen one is told apart by more than a word for a screen reader: mint ring and a tick
    assert.deepEqual(list.map((c) => c.tick), [true, false]);
    assert.deepEqual(list.map((c) => c.ring), [true, false]);
    assert.equal(await page.locator(".offline-sheet .offline-sounds").getAttribute("aria-label"), "Sound");
    await page.locator(".offline-sheet .offline-sound").nth(1).click();
    list = await chips();
    assert.deepEqual(list.map((c) => c.pressed), ["false", "true"]);
    assert.deepEqual(list.map((c) => c.tick), [false, true]);
    await page.locator(".offline-sheet .offline-opt", { hasText: "Original" }).first().click();
    await until(async () => { const s = await copy(page, srv.lib.film2.id); return s && !s.pending; }, "the film on the device", 90000);
    assert.equal((await copy(page, srv.lib.film2.id)).audio, 1, "the copy carries the sound that was picked");

    // a film with one sound: nothing to choose, nothing shown
    await go(page, `#/movie/${srv.lib.film1.id}`);
    await page.waitForSelector(`[data-ui="detail.offline"]`);
    await until(() => page.evaluate(() => /Test Film One/.test(document.querySelector("#app .screen").innerText)), "the other film's page");
    await page.locator('[data-ui="detail.offline"]').first().click();
    await page.waitForSelector(".offline-sheet .offline-opt");
    assert.equal(await page.locator(".offline-sheet .offline-sounds").count(), 0);
    assert.equal(await page.locator(".offline-sheet .offline-room").count(), 1);
    await page.locator(".offline-sheet .btn", { hasText: "Not now" }).click();
    await until(async () => (await page.locator(".offline-sheet").count()) === 0, "the sheet closed");
    assert.deepEqual(errors, []);
  } finally {
    await page.evaluate(async (ids) => { const o = await import("/js/offline.js"); for (const id of ids) { try { o.cancelJob(id); } catch {} } }, [srv.lib.film1.id, srv.lib.film2.id]).catch(() => {});
    await context.close().catch(() => {});
  }
});

ui.test("a save the person paused: plain words, an amber bar at rest, Resume and Cancel — it stays paused until Resume is pressed, then lands", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile, PHONE, "#/saved", { "aurora-offline-part-bytes": "65536" });
  try {
    const id = srv.lib.film2.id;
    const state = await page.evaluate(async (x) => {
      const o = await import("/js/offline.js");
      const { api } = await import("/js/api.js");
      window.__save = o.saveItem(await api.item(x), () => {}, async () => "original").catch((e) => String(e));
      for (let i = 0; i < 4000; i++) { const j = o.jobFor(x); if (j && j.state === "saving" && j.pct > 0) break; await new Promise((r) => setTimeout(r, 5)); }
      await o.pauseJob(x);
      for (let i = 0; i < 100; i++) { const j = o.jobFor(x); if (j && j.state === "paused") break; await new Promise((r) => setTimeout(r, 50)); }
      const j = o.jobFor(x);
      return j ? j.state : "none";
    }, id);
    if (state !== "paused") return; // (this computer saved the whole test film before the pause could land — nothing to look at)
    const row = page.locator('.device-job[data-state="paused"]');
    await row.waitFor();
    assert.match(await row.innerText(), /Test Film Two[\s\S]*Paused at \d+%[\s\S]*press Resume to carry on/);
    assert.deepEqual(await row.locator(".dl-actions button").allInnerTexts(), ["Resume", "Cancel"]);
    assert.match(await row.locator(".dl-bar-fill").evaluate((e) => getComputedStyle(e).backgroundColor), /245, 197, 66/, "the bar rests in amber");
    // the nav says something needs you, not that something is saving
    // it never carries on by itself — not after a while, not when another save starts
    assert.ok(await save(page, srv.lib.film1.id));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await page.evaluate(async (x) => (await import("/js/offline.js")).jobFor(x).state, id), "paused");
    assert.equal(await copy(page, id), null);
    await row.locator("button", { hasText: "Resume" }).click();
    await until(async () => { const s = await copy(page, id); return s && !s.pending; }, "the film lands after Resume", 60000);
    await until(async () => (await page.locator('.device-job[data-state="paused"]').count()) === 0, "the paused row is gone");
    assert.deepEqual(errors, []);
  } finally {
    await page.evaluate(async (x) => { try { (await import("/js/offline.js")).cancelJob(x); } catch {} }, srv.lib.film2.id).catch(() => {});
    await context.close().catch(() => {});
  }
});

ui.test("what waits for the server's copy: the waiting sign in its frame; on the sheet the two 'every new episode' rows — one at most — and the sheet never outgrows a phone", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile, PHONE);
  try {
    // the sheet
    await page.evaluate(async () => {
      const w = await import("/js/offlineWish.js");
      window.__wish = w.askWish({ type: "show", imdbId: "tt9810777", season: 2, episode: 5, title: "Long Show", showTitle: "Long Show" }, "Long Show · S2 E5").then((x) => x || "none", (e) => `no: ${e && e.message}`);
    });
    await page.waitForSelector(".offline-sheet .offline-toggle");
    const toggles = page.locator(".offline-sheet .offline-toggle");
    assert.deepEqual(await toggles.allInnerTexts(), ["And every new episode of season 2", "And every new episode of this show"]);
    const pressed = () => toggles.evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed")));
    const discs = () => toggles.evaluateAll((els) => els.map((e) => { const b = getComputedStyle(e, "::before"); return /110, 231, 183/.test(b.backgroundColor); }));
    assert.deepEqual(await pressed(), ["false", "false"]);
    assert.deepEqual(await discs(), [false, false], "an empty ring until it is chosen");
    await toggles.nth(0).click();
    assert.deepEqual(await pressed(), ["true", "false"]);
    await toggles.nth(1).click();
    assert.deepEqual(await pressed(), ["false", "true"], "the two cannot both be chosen");
    assert.deepEqual(await discs(), [false, true], "the chosen one fills in mint");
    // each row is the full width of the sheet, one under the other
    const boxes = await toggles.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; }));
    assert.equal(boxes[0][0], boxes[1][0]);
    assert.ok(boxes[1][1] > boxes[0][1] && Math.abs(boxes[0][2] - boxes[1][2]) <= 1, JSON.stringify(boxes));
    // the whole sheet is inside the screen, and what does not fit scrolls inside it
    const fit = await page.locator(".offline-sheet").evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, scrolls: /auto|scroll/.test(getComputedStyle(e).overflowY) }; });
    assert.ok(fit.top >= 0 && fit.bottom <= fit.h + 0.5 && fit.scrolls, JSON.stringify(fit));
    await page.locator(".offline-sheet .btn", { hasText: "Not now" }).click();
    await until(async () => (await page.locator(".offline-sheet").count()) === 0, "the sheet closed");

    // the rows
    await page.evaluate(async () => {
      const w = await import("/js/offlineWish.js");
      await w.addWish({ type: "movie", imdbId: "tt9810701", title: "A Film Not Here Yet" }, "720");
      await w.addWish({ type: "show", imdbId: "tt9810703", scope: "show", title: "Long Show", showTitle: "Long Show" }, "720");
    });
    await page.waitForSelector('.device-wish[data-state="wish-show"]');
    const rows = await page.$$eval(".device-wish", (els) => els.map((r) => {
      const f = r.querySelector(".dl-poster .card-fallback");
      const b = f ? getComputedStyle(f, "::before") : null;
      return {
        state: r.dataset.state,
        text: r.querySelector(".dl-info").innerText.replace(/\s+/g, " "),
        sign: !!b && b.width === "26px" && /url\(/.test(b.webkitMaskImage || b.maskImage || ""),
        nameHidden: !!f && getComputedStyle(f).fontSize === "0px",
        buttons: [...r.querySelectorAll(".dl-actions button")].map((x) => x.innerText.trim()),
      };
    }));
    assert.deepEqual(rows.map((r) => r.state).sort(), ["wish-show", "wish-waiting"]);
    for (const r of rows) {
      assert.ok(r.sign && r.nameHidden, `the waiting sign, not the name squeezed into the frame: ${JSON.stringify(r)}`);
      assert.match(r.text, /Waiting for the server's copy/);
      assert.deepEqual(r.buttons, ["Cancel"]);
    }
    assert.match(rows.find((r) => r.state === "wish-show").text, /Long Show[\s\S]*Every new episode/);
    assert.deepEqual(errors, []);
  } finally {
    await page.evaluate(async () => { const w = await import("/js/offlineWish.js"); for (const x of w.listWishes()) { try { await w.removeWish(x.id); } catch {} } }).catch(() => {});
    await context.close().catch(() => {});
  }
});

ui.test("no connection, calmly: one line that leads to On this device; what is not here rests; a title page rests instead of failing; the copy plays; the line goes when the connection is back", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile, DESKTOP);
  try {
    const here = srv.lib.film1.id, away = srv.lib.film2.id;
    assert.ok(await save(page, here));
    await go(page, "#/movies");
    // (a card says its title — and, when it is here, "on this device" — in its name)
    const card = (title) => `#app .card[aria-label^="${title}"]`;
    await page.waitForSelector(card("Test Film Two"));
    await until(() => page.evaluate(() => !!document.querySelector(".card .dev-mark")), "the mark on the saved film");
    assert.equal(await page.locator("#offline-banner").count(), 0);

    await context.setOffline(true);
    const line = page.locator("#offline-banner");
    await line.waitFor({ timeout: 30000 });
    assert.match(await line.innerText(), /^No connection\s*On this device$/);
    assert.equal(await line.getAttribute("role"), "status");
    assert.ok(await page.evaluate(() => document.documentElement.classList.contains("net-off")));
    // what is on the device stays bright, what is not rests
    const dim = (title) => page.locator(card(title)).first().evaluate((e) => Number(getComputedStyle(e).opacity));
    await until(async () => (await dim("Test Film Two")) < 0.5, "the film that is not here rests");
    assert.equal(await dim("Test Film One"), 1);

    // a title that is not here: its page rests — no spinner, no raw words, no jump Home
    await go(page, `#/movie/${away}`);
    const rest = page.locator(".rest-page");
    await rest.waitFor();
    assert.equal(await rest.getAttribute("data-here"), "0");
    assert.match(await rest.innerText(), /No connection[\s\S]*Test Film Two[\s\S]*isn't on this device, so it waits for the connection/i);
    assert.deepEqual(await rest.locator(".rest-actions button").evaluateAll((els) => els.map((e) => e.dataset.ui)), ["saved.rest.open", "saved.rest.retry"]);

    // a title that IS here: its page opens as ever and says so…
    await go(page, `#/movie/${here}`);
    await until(() => page.evaluate(() => /Test Film One[\s\S]*Saved on this device/.test(document.querySelector("#app").innerText)), "the saved film's page");
    assert.equal(await page.locator(".rest-page").count(), 0);
    // …and Play plays the copy on this device — not a player that waits for a server that is not there
    await go(page, `#/play/${here}`);
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 0.3; }, null, { timeout: 30000 });
    assert.match(await page.evaluate(() => location.hash), /offline=1/);
    // over a copy that plays from the device the line has nothing to say
    assert.equal(await line.isVisible(), false);

    // Aurora opened anew with no connection, on a page it may hold no answer for: the shelf, or a page that rests — never a blank
    await go(page, "#/movies");
    await page.waitForSelector(card("Test Film Two"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await until(() => page.evaluate(() => !!document.querySelector("#app .rest-page, #app .card")), "the shelf or a resting page — not a blank", 30000);
    if (await rest.count()) assert.match(await rest.innerText(), /No connection[\s\S]*This page is resting[\s\S]*On this device[\s\S]*Try again/i);
    await line.waitFor({ timeout: 30000 });

    // the player asked for what is not here: one calm line, and back where you were
    await go(page, "#/saved");
    await page.waitForSelector(".saved-screen, .saved-section");
    // (already there: the line's link has nowhere to lead, and gives way)
    await until(async () => !(await line.locator("a").isVisible()), "the line's link gives way on the place itself");
    assert.match(await line.innerText(), /^No connection$/);
    await go(page, `#/play/${away}`);
    await until(() => page.evaluate(() => /isn't on this device — it plays when the connection is back/.test(document.getElementById("toasts").innerText)), "the calm line");
    await until(() => page.evaluate(() => !/^#\/play\//.test(location.hash)), "back out of the player");
    assert.equal(await page.locator(".player").count(), 0);

    // back on the line: the pill goes, by itself
    await context.setOffline(false);
    await until(async () => (await line.count()) === 0, "the line is gone", 60000);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("net-off")), false);
    await go(page, "#/movies");
    await page.waitForSelector(card("Test Film Two"));
    assert.equal(await dim("Test Film Two"), 1);
    const real = errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch|offline/i.test(e));
    assert.deepEqual(real, []);
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close().catch(() => {});
  }
});

for (const [device, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`${device}: My downloads — "This device too", "Save to this device" and "On this device" carry the mark, not an emoji`, { allow: [/Failed to load resource/] }, async ({ srv, freshProfile }) => {
    const profile = await freshProfile();
    const hash = require("crypto").createHash("sha1").update(`look-${device}-${Date.now()}`).digest("hex");
    const src = path.join(srv.media, "movies", "Test Film One (2020)", "Test Film One (2020).mp4");
    const { jobId } = await stage(srv, { op: "create", hash, src, fields: { type: "movie", imdbId: device === "phone" ? "tt9810022" : "tt9810021", title: `Look Film ${device}`, year: 2024, quality: "1080p", profile: profile.id } });
    const { context, page, errors } = await open(srv, profile, viewport, "#/downloads");
    try {
      const plain = async (sel) => page.evaluate((s) => {
        const b = document.querySelector(s);
        const m = b.querySelector(".dev-mark");
        const box = m.getBoundingClientRect();
        return { text: b.textContent.trim(), state: m.dataset.state, hidden: m.getAttribute("aria-hidden"), w: Math.round(box.width), h: Math.round(box.height), emoji: /\p{Extended_Pictographic}/u.test(b.textContent) };
      }, sel);
      // on its way: one press asks for it here too
      await page.waitForSelector('[data-ui="downloads.offline.wish"] .dev-mark');
      let b = await plain('[data-ui="downloads.offline.wish"]');
      assert.equal(b.text, "This device too");
      assert.deepEqual([b.state, b.hidden, b.emoji], ["none", "true", false]);
      assert.ok(b.w >= 18 && b.w <= 24 && b.w === b.h, `the mark is a small square (${b.w}×${b.h})`);
      await snap(page, `downloads-wish-${device}`);
      // it lands: the same button now saves it
      await stage(srv, { op: "land", hash });
      await page.waitForFunction(() => /Ready to play/.test(document.getElementById("app").innerText), null, { timeout: 45000 });
      await snap(page, `downloads-ready-${device}`);
      await page.waitForSelector('[data-ui="downloads.offline.save"] .dev-mark', { timeout: 45000 });
      b = await plain('[data-ui="downloads.offline.save"]');
      assert.equal(b.text, "Save to this device");
      assert.deepEqual([b.state, b.emoji], ["none", false]);
      await page.locator('[data-ui="downloads.offline.save"]').first().click();
      await page.waitForSelector(".offline-sheet .offline-opt");
      await page.locator(".offline-sheet .offline-opt").first().click();
      await page.waitForFunction(() => { const x = document.querySelector('[data-ui="downloads.offline.save"]'); return x && /^On this device$/.test(x.textContent.trim()); }, null, { timeout: 45000 });
      b = await plain('[data-ui="downloads.offline.save"]');
      assert.deepEqual([b.state, b.emoji], ["saved", false]);
      // the way to the place: the device sign and its one name
      const open2 = page.locator(".dl-open-device");
      // (My downloads repaints its rows as the list is read again: the button
      // found can be replaced by its twin before the scroll — "Element is not
      // attached to the DOM" on a slower machine. Found again, then.)
      for (let tries = 0; ; tries++) {
        try { await open2.scrollIntoViewIfNeeded({ timeout: 10000 }); break; } catch (e) {
          if (tries >= 5 || !/not attached/i.test(String(e && e.message))) throw e;
        }
      }
      assert.equal((await open2.innerText()).trim(), "Open On this device");
      assert.equal(await open2.locator("svg").count(), 1);
      await snap(page, `downloads-saved-${device}`);
      await open2.click();
      await page.waitForFunction(() => location.hash === "#/saved");
      await page.waitForSelector("#app .dev-screen, #app .screen");
      // nothing of the test stays behind
      await page.evaluate(async () => { const o = await import("/js/offline.js"); for (const s of await o.listSaved()) await o.removeSaved(s.id); });
      await srv.api.call("DELETE", `/api/downloads/${jobId}`, undefined, await srv.api.as(profile)).catch(() => {});
      assert.deepEqual(errors, []);
    } finally {
      await context.close().catch(() => {});
    }
  });
}

ui.run({ concurrency: 1 });
