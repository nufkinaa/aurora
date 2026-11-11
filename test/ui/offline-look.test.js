// What a person SEES of offline watching on the website (offline-look, 2026-11-10):
//   · "On this device" as a home of its own — nothing yet: two lines that
//     teach and what is worth having, one press each; with copies: a show's
//     episodes together and in order, the next one first, the room on the
//     device, "Remove watched" in one press, Remove with Undo, the "Keep the
//     next episode ready" switch
//   · "Pack for a trip": pick how long, what Aurora proposes (what you are in
//     the middle of — ticked; what is only new — offered, never ticked by
//     itself), the total, one press saves
//   · the one mark on a poster card, only when the device has a copy
// The machinery (js/offline.js) has its own tests: offline*.test.js.
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite();

const open = async (srv, profile, viewport, hash = "#/saved") => {
  const phone = viewport.width < 600;
  const context = await ui.browser.newContext({ viewport, serviceWorkers: "allow", ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.stack) || e)));
  // (the private instance has no way out: its routes that ask the outside world answer 502/404 — as helpers.js allows)
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const where = (m.location() && m.location().url) || "";
    if (where && !where.startsWith(srv.url) && /Failed to load resource/.test(m.text())) return;
    if (/Failed to load resource.*\/(api\/(discover|catalog|torrents|xray|segments|subtitles|popular|ai)\b|img\/(ext|poster|meta)\b)/.test(`${m.text()} ${where}`)) return;
    errors.push(`console: ${m.text()} (${where})`);
  });
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
// a copy on the device, the way a press makes it (Original: the file as it is)
const save = (page, id) => page.evaluate(async (x) => {
  const o = await import("/js/offline.js");
  const { api } = await import("/js/api.js");
  const s = await o.saveItem(await api.item(x), () => {}, async (opts) => (opts.some((q) => q.quality === "original") ? "original" : opts[0].quality));
  return !!s;
}, id);
const savedIds = (page) => page.evaluate(async () => (await (await import("/js/offline.js")).listSaved()).map((s) => s.id));
const repaint = async (page) => {
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForSelector("#app .screen:not(.saved-screen)", { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => { location.hash = "#/saved"; });
  await page.waitForSelector(".saved-section", { timeout: 20000 });
};
const pickOriginal = async (page) => {
  await page.waitForSelector(".offline-sheet .offline-opt");
  await page.locator(".offline-sheet .offline-opt", { hasText: "Original" }).first().click();
};

ui.test("nothing saved yet: two lines that teach, the room on the device, and what is worth having — one press saves it and it lands on the screen", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  // in the middle of a film, and one episode into a show
  await srv.api.setProgress(profile, srv.lib.film1.id, 20, 60);
  await srv.api.setProgress(profile, srv.lib.e1.id, 44, 45);
  const { context, page, errors } = await open(srv, profile, DESKTOP);
  try {
    await page.waitForSelector(".dev-empty .dev-empty-title");
    assert.equal(await page.locator(".browse-head h1").innerText(), "On this device");
    assert.equal(await page.locator(".dev-empty-title").innerText(), "Nothing saved for offline yet");
    const words = await page.locator(".dev-empty").innerText();
    assert.match(words, /Save to this device[\s\S]*lands here/);
    assert.match(words, /plays anywhere/);
    assert.match(words, /Room on this device: ≈ /);
    assert.doesNotMatch(words, /null|undefined|cache|quota|service worker/i);
    // what is worth having: the film stopped in, the next episode — never the one already watched
    await page.waitForSelector(".dev-offers:not(.hidden) .dev-offer");
    const offers = await page.locator(".dev-offer").allInnerTexts();
    assert.ok(offers.some((t) => /Test Film One[\s\S]*Carry on/.test(t)), offers.join(" | "));
    assert.ok(offers.some((t) => /Test Show\s*S1 E2[\s\S]*Next up/.test(t)), offers.join(" | "));
    assert.ok(!offers.some((t) => /S1 E1/.test(t)), "the watched episode is not offered");
    // each offer's button has a name a screen reader can say
    const btn = page.locator(".dev-offer", { hasText: "Test Film One" }).locator('[data-ui="saved.offer.save"]');
    assert.match(await btn.getAttribute("aria-label"), /Save .*Test Film One.* to this device/i);
    // one press (and the size): it is saved, and the screen shows it with Play
    await btn.click();
    await pickOriginal(page);
    await until(async () => (await savedIds(page)).includes(srv.lib.film1.id), "the film is saved");
    await page.waitForSelector(`.saved-section .dl-row[data-id="${srv.lib.film1.id}"] [data-ui="saved.play"]`);
    assert.equal(await page.locator(".saved-empty").count(), 0);
    assert.match(await page.locator(".saved-head").innerText(), /Saved for offline\s*1/);
    assert.match(await page.locator(`.dl-row[data-id="${srv.lib.film1.id}"]`).innerText(), /Resume/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("with copies: a show's episodes together and in order with the next one first; the room; Remove watched in one press with Undo; the next-episode switch", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  await srv.api.setProgress(profile, srv.lib.e1.id, 44, 45); // watched to the end
  const { context, page, errors } = await open(srv, profile, PHONE);
  try {
    // saved out of order, on purpose
    assert.ok(await save(page, srv.lib.e2.id));
    assert.ok(await save(page, srv.lib.film2.id));
    assert.ok(await save(page, srv.lib.e1.id));
    await repaint(page);
    await page.waitForSelector(".dev-group .dev-ep");
    // the show: one group, episodes in order, the one to watch next marked and offered on top
    assert.equal(await page.locator(".dev-group").count(), 1);
    const eps = await page.locator(".dev-group .dev-ep").allInnerTexts();
    assert.equal(eps.length, 2);
    assert.match(eps[0], /S1 E1[\s\S]*Watched/);
    assert.match(eps[1], /S1 E2[\s\S]*Next up/);
    assert.match(await page.locator('.dev-group [data-ui="saved.play.next"]').innerText(), /Play S1 E2/);
    assert.match(await page.locator(".dev-group-head").innerText(), /Test Show[\s\S]*2 episodes[\s\S]*1 watched/);
    // the film beside it, with what it carries
    assert.match(await page.locator(`.dev-row[data-id="${srv.lib.film2.id}"]`).innerText(), /Test Film Two[\s\S]*Original quality/);
    // the room: what is here against what is free — a guess, said as one
    assert.match(await page.locator(".dev-room").innerText(), /saved here[\s\S]*≈/);
    // the episode after the last one here is one press away
    await page.waitForSelector('.dev-group [data-ui="saved.next.save"]');
    assert.match(await page.locator('.dev-group [data-ui="saved.next.save"]').innerText(), /Save the next/);
    // every round button says what it does
    for (const b of await page.locator(".dev-group .dev-round").all()) assert.ok((await b.getAttribute("aria-label")) || (await b.innerText()), "a named button");

    // Remove watched: one press, nothing asked — and Undo brings it back
    const clear = page.locator('[data-ui="saved.clear.watched"]');
    assert.match(await clear.innerText(), /Remove watched · 1 · /);
    await clear.click();
    const undo = page.locator(".toast .toast-act", { hasText: "Undo" });
    await undo.waitFor();
    assert.match(await page.locator(".toast", { hasText: "Undo" }).innerText(), /Removed[\s\S]*Undo/);
    await until(async () => (await page.locator(".dev-group").count()) === 0, "one episode left: a row of its own", 8000);
    assert.ok((await savedIds(page)).includes(srv.lib.e1.id), "nothing leaves the device while Undo is up");
    await undo.click();
    await page.waitForSelector(".dev-group .dev-ep");
    assert.equal(await page.locator(".dev-group .dev-ep").count(), 2);
    // …and left alone, it goes for real
    await page.locator('[data-ui="saved.clear.watched"]').click();
    await until(async () => !(await savedIds(page)).includes(srv.lib.e1.id), "the watched episode left the device", 20000);
    assert.deepEqual((await savedIds(page)).sort(), [srv.lib.e2.id, srv.lib.film2.id].sort());
    assert.equal(await page.locator('[data-ui="saved.clear.watched"]').count(), 0, "nothing watched is left to remove");

    // "Keep the next episode ready": off until asked, a real switch, kept across a reload
    const sw = page.locator('[data-ui="saved.smartnext"]');
    assert.equal(await sw.getAttribute("role"), "switch");
    assert.equal(await sw.getAttribute("aria-checked"), "false");
    assert.match(await page.locator(".dev-next").innerText(), /Keep the next episode ready[\s\S]*When you finish a saved episode, the next one saves itself\. Nothing is removed\./);
    await sw.click();
    assert.equal(await sw.getAttribute("aria-checked"), "true");
    assert.equal(await page.evaluate(async () => (await import("/js/offline.js")).smartNext.get()), true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-ui="saved.smartnext"]');
    assert.equal(await page.locator('[data-ui="saved.smartnext"]').getAttribute("aria-checked"), "true");
    // nothing wider than the phone
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("Pack for a trip: the length that is chosen has the keyboard; what you are in the middle of is ticked, what is only new is offered; the total follows; one press packs", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  await srv.api.setProgress(profile, srv.lib.film1.id, 20, 60);
  const { context, page, errors } = await open(srv, profile, PHONE);
  try {
    await page.locator('[data-ui="saved.pack"]').click();
    await page.waitForSelector(".trip-sheet .trip-row");
    assert.equal(await page.locator(".trip-sheet").getAttribute("role"), "dialog");
    assert.match(await page.locator(".trip-sheet").innerText(), /Going somewhere\?/);
    // "A flight" until the person says otherwise — pressed, and where the keyboard is
    const pressed = page.locator('.trip-len[aria-pressed="true"]');
    assert.equal(await pressed.count(), 1);
    assert.match(await pressed.innerText(), /A flight/);
    assert.match(await page.evaluate(() => document.activeElement && document.activeElement.textContent), /A flight/);
    // the film stopped in: ticked. A film that is only new: there, not ticked.
    const mine = page.locator(".trip-row", { hasText: "Test Film One" });
    assert.match(await mine.innerText(), /Carry on/);
    assert.equal(await mine.getAttribute("aria-checked"), "true");
    const extra = page.locator(".trip-row", { hasText: "New on Aurora" }).first();
    assert.equal(await extra.getAttribute("aria-checked"), "false");
    assert.match(await page.locator(".trip-total").innerText(), /^1 title · 1 min to watch · up to /);
    assert.match(await page.locator(".trip-room").innerText(), /Room on this device: ≈ /);
    assert.equal(await page.locator('[data-ui="saved.pack.go"]').innerText(), "Pack 1 title");
    // ticking follows in the total and on the button
    await extra.click();
    assert.equal(await extra.getAttribute("aria-checked"), "true");
    assert.match(await page.locator(".trip-total").innerText(), /^2 titles · 2 min to watch/);
    assert.equal(await page.locator('[data-ui="saved.pack.go"]').innerText(), "Pack 2 titles");
    await extra.click();
    await mine.click();
    assert.match(await page.locator(".trip-total").innerText(), /Nothing ticked/);
    assert.ok(await page.locator('[data-ui="saved.pack.go"]').isDisabled());
    // another length is remembered for the next trip
    await page.locator(".trip-len", { hasText: "A weekend" }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem("aurora-offline-trip")), "weekend");
    assert.equal(await mine.getAttribute("aria-checked"), "true", "the proposal is made again for the new length");
    assert.equal(await extra.getAttribute("aria-checked"), "false", "…and still never ticks what nobody asked for");
    // Pack: the size once, then it is on the device and on the screen
    await page.locator('[data-ui="saved.pack.go"]').click();
    await pickOriginal(page);
    await until(async () => (await savedIds(page)).includes(srv.lib.film1.id), "the film is packed");
    await page.waitForSelector(`.saved-section .dl-row[data-id="${srv.lib.film1.id}"]`);
    assert.equal(await page.locator(".trip-sheet").count(), 0);
    // packed already: the sheet says so, with nothing to press but Close… unless something new is offered
    await page.locator('[data-ui="saved.pack"]').click();
    await page.waitForFunction(() => document.querySelector(".trip-sheet .trip-row, .trip-sheet.trip-none"));
    assert.equal(await page.locator(".trip-row", { hasText: "Test Film One" }).count(), 0, "what is here is not offered again");
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("the mark on a poster: only on what is on this device, with words a screen reader says; Home asks the server nothing more for it", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile, DESKTOP);
  try {
    assert.ok(await save(page, srv.lib.film1.id));
    const asked = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.origin === srv.url && u.pathname.startsWith("/api/")) asked.push(u.pathname); });
    await page.evaluate(() => { location.hash = "#/movies"; });
    await page.waitForSelector(`.card[data-id="${srv.lib.film1.id}"], .card`);
    await until(() => page.evaluate(() => !!document.querySelector(".card .dev-mark")), "a mark on the saved film's card");
    const marks = await page.evaluate(() => [...document.querySelectorAll(".card")].filter((c) => c.querySelector(".dev-mark")).map((c) => ({ state: c.querySelector(".dev-mark").dataset.state, label: c.getAttribute("aria-label") })));
    assert.equal(marks.length, 1, JSON.stringify(marks));
    assert.equal(marks[0].state, "saved");
    // (the mark is decoration: the card itself says it)
    assert.match(marks[0].label || "", /Test Film One[\s\S]*on this device/i);
    // the nav leads there once the device holds something
    assert.ok(await page.locator("#nav-saved").isVisible());
    assert.ok(!asked.some((p) => /watchlist|\/api\/item\//.test(p)), `asked: ${asked.join(", ")}`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("in the player: Settings has Save to this device — one press, the size, and the row then says the film is here", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile, DESKTOP);
  try {
    await page.evaluate((id) => { location.hash = `#/play/${id}`; }, srv.lib.film2.id);
    await page.waitForSelector(".player");
    const openSettings = async () => {
      await until(() => page.evaluate(() => {
        if (document.querySelector('.player [data-ui="player.offline"]')) return true;
        const b = document.querySelector('.player [data-ui="player.settings.open"]');
        if (b) b.click();
        return false;
      }), "the Settings menu with its Save row");
    };
    await openSettings();
    const row = page.locator('.player [data-ui="player.offline"]');
    assert.equal(await row.getAttribute("data-state"), "none");
    assert.match(await row.innerText(), /Save to this device[\s\S]*plays with no connection/);
    await row.click();
    // the menu steps aside for the size sheet
    await pickOriginal(page);
    await until(async () => (await savedIds(page)).includes(srv.lib.film2.id), "the film on the device");
    assert.equal(await page.locator('.player [data-ui="player.offline"]').count(), 0, "the menu closed on the press");
    await openSettings();
    await until(async () => (await row.getAttribute("data-state")) === "saved", "the row says saved");
    assert.match(await row.innerText(), /Saved on this device[\s\S]*Remove/);
    assert.match((await row.getAttribute("aria-label")) || (await row.innerText()), /Saved on this device|Remove from this device/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("a kids profile on the same device: the grown-up's copy is not on its place, not on a poster, not in its nav — and is still there for the grown-up afterwards", async ({ srv, freshProfile }) => {
  const grown = await freshProfile();
  const kid = await freshProfile({ kids: { maxAge: 7 } });
  const { context, page, errors } = await open(srv, grown, DESKTOP);
  const as = async (profile, hash) => {
    await page.evaluate((id) => { localStorage.setItem("aurora-profile", id); }, profile.id);
    await page.goto(`${srv.url}/${hash}`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app .screen", { timeout: 30000 });
  };
  try {
    assert.ok(await save(page, srv.lib.film1.id));
    await repaint(page);
    await page.waitForSelector(".dev-row");
    // the same browser, the child's profile
    await as(kid, "#/saved");
    await page.waitForSelector(".saved-section, .dev-empty", { timeout: 20000 });
    await until(() => page.evaluate(() => !!document.querySelector(".dev-empty")), "the child's place is empty");
    assert.deepEqual(await page.evaluate(async () => { const { state } = await import("/js/state.js"); return state.profile && { id: state.profile.id, kids: !!state.profile.kids }; }), { id: kid.id, kids: true }, "the page is the child's");
    assert.equal(await page.locator(".dev-row, .dev-group").count(), 0, "none of the grown-up's copies");
    const words = await page.locator(".saved-screen").innerText();
    assert.doesNotMatch(words, /Test Film One/);
    assert.doesNotMatch(words, /saved here/, "no count of somebody else's copies");
    await page.evaluate(() => { location.hash = "#/movies"; });
    await page.waitForSelector("#app .screen:not(.saved-screen)");
    await page.waitForTimeout(1500); // (the marks come a moment after the cards)
    assert.equal(await page.locator('#app .dev-mark[data-state="saved"]').count(), 0, "no mark on a poster");
    assert.equal(await page.locator('#nav-saved .dev-mark[data-state="saved"], .nav-dev-ring[data-state="saved"]').count(), 0, "no mark in the nav");
    // nothing was taken away: the grown-up still has it
    await as(grown, "#/saved");
    await page.waitForSelector(".dev-row", { timeout: 20000 });
    assert.match(await page.locator(".dev-row").first().innerText(), /Test Film One/);
    assert.deepEqual(await savedIds(page), [srv.lib.film1.id]);
    // (the test changes profile by hand, not through the picker: on the way back the
    // first questions for the grown-up go out before its door is opened again)
    assert.deepEqual(errors.filter((e) => !(/403/.test(e) && e.includes(`/api/profiles/${grown.id}/`))), []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.test("reduced motion and the keyboard: nothing of the mark moves; Tab reaches Play, Remove, the switch and Pack for a trip, each with a ring to see", async ({ srv, freshProfile }) => {
  const profile = await freshProfile();
  const { context, page, errors } = await open(srv, profile, DESKTOP);
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // the place with nothing on it: its mark settles without moving
    await page.waitForSelector(".dev-empty-mark");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".dev-empty-mark")).animationName), "none");
    // the mark while a save is prepared, and as it lands
    const still = await page.evaluate(async () => {
      const ui = await import("/js/offlineUi.js");
      const a = ui.mark("preparing");
      const b = ui.mark("saved");
      b.classList.add("landed");
      document.body.append(a, b);
      const spin = a.querySelector(".dm-spin");
      const out = {
        spin: spin ? getComputedStyle(spin).animationName : "none",
        land: getComputedStyle(b.querySelector("svg")).animationName,
        ring: getComputedStyle(b, "::after").animationName,
      };
      a.remove(); b.remove();
      return out;
    });
    assert.deepEqual(still, { spin: "none", land: "none", ring: "none" });
    // the keyboard: everything on the place within reach, and seen
    assert.ok(await save(page, srv.lib.film1.id));
    assert.ok(await save(page, srv.lib.e1.id)); // (an episode: the switch has something to say)
    await repaint(page);
    await page.waitForSelector(".dev-row");
    await page.waitForSelector('[data-ui="saved.smartnext"]');
    await page.evaluate(() => { document.getElementById("toasts").replaceChildren(); if (document.activeElement) document.activeElement.blur(); });
    const reached = {};
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      const at = await page.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        const cs = getComputedStyle(e);
        return { ui: e.getAttribute("data-ui") || "", name: (e.getAttribute("aria-label") || e.innerText || e.title || "").trim().slice(0, 60), ring: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" };
      });
      if (at && at.ui && !(at.ui in reached)) reached[at.ui] = at;
    }
    for (const id of ["saved.pack", "saved.play", "saved.remove", "saved.smartnext"]) {
      assert.ok(reached[id], `Tab reaches ${id} (reached: ${Object.keys(reached).join(", ")})`);
      assert.ok(reached[id].ring, `${id} shows where the keyboard is`);
      assert.ok(reached[id].name || id === "saved.smartnext", `${id} has a name`);
    }
    // the switch says what it is and what it does to a screen reader
    const sw = page.locator('[data-ui="saved.smartnext"]');
    assert.equal(await sw.getAttribute("role"), "switch");
    assert.match(await page.locator(`#${await sw.getAttribute("aria-labelledby")}`).innerText(), /Keep the next episode ready/);
    assert.match(await page.locator(`#${await sw.getAttribute("aria-describedby")}`).innerText(), /Nothing is removed/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
  }
});

ui.run({ concurrency: 1 });
