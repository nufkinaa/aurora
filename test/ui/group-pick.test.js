// "What do we watch tonight?" in real browsers: a TV-sized page is the room's
// screen (the code, the QR code, the progress, the pick), three phone-sized
// pages are the people. Everyone joins the way the QR code takes them
// (#/group/<code>), the first-timers see the four-step explanation once,
// someone adds a title by search, everyone swipes (buttons and a drag), the
// pick shows on the big screen with its why, "Something else" moves the room
// on, and Play on a phone starts the film on the big screen.
//
// The catalogue's well-known list is seeded with twenty films whose posters
// are served by the instance itself (nothing leaves the machine). The
// screenshots go to docs/qa/group-pick/ when UI_GROUP_SHOTS=1.
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, PHONE, signIn, goto, assertNoHorizontalOverflow } = require("./helpers");

const SHOTS = process.env.UI_GROUP_SHOTS === "1" ? path.join(__dirname, "..", "..", "docs", "qa", "group-pick") : null;
const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(450); // (the step's fade)
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const FILMS = [
  ["The Long Weekend", ["Comedy"], 2019], ["Paper Moons", ["Drama", "Romance"], 2016], ["North of Nowhere", ["Thriller"], 2021],
  ["Small Hours", ["Mystery", "Thriller"], 2018], ["Kitchen Rules", ["Comedy", "Family"], 2022], ["The Quiet Harbour", ["Drama"], 2015],
  ["Glass Garden", ["Sci-Fi"], 2020], ["Two for the Road Again", ["Comedy", "Romance"], 2017], ["Night Shift", ["Crime", "Thriller"], 2019],
  ["Lantern Festival", ["Animation", "Family"], 2021], ["The Last Orchard", ["Drama", "History"], 2014], ["Signal Lost", ["Sci-Fi", "Thriller"], 2023],
  ["Brass Band", ["Comedy", "Music"], 2016], ["Deep Water Blue", ["Documentary"], 2020], ["High Tide", ["Action", "Adventure"], 2018],
];
const COLORS = ["#5b4bd6", "#2c7fb8", "#c0563b", "#2f8f6b", "#8a3fb0", "#b8862c", "#3b6fc0", "#a43b5e", "#407a3a", "#6a4fc2"];
const imdb = (i) => `tt80${String(100 + i).padStart(5, "0")}`;
const known = () => ({
  v: 1, at: Date.now(), tried: Date.now(),
  titles: FILMS.map(([title, genres, year], i) => ({
    imdbId: imdb(i), type: "movie", title, year, poster: `/qa-posters/${i}.svg`, rating: 6.4 + (i % 7) * 0.35, genres, cast: [], director: [], k: i * 20,
  })),
});
const posterSvg = (title, color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#0b0c14"/></linearGradient></defs><rect width="300" height="450" fill="url(#g)"/><circle cx="230" cy="90" r="46" fill="#ffffff" opacity=".14"/><text x="24" y="380" font-family="Segoe UI, Arial" font-size="30" font-weight="800" fill="#ffffff">${title.replace(/&/g, "&amp;")}</text></svg>`;

const ui = suite({
  server: {
    seed: { "cache/search-known.json": known() },
  },
  setup: async (srv) => {
    const dir = path.join(srv.root, "public", "qa-posters");
    fs.mkdirSync(dir, { recursive: true });
    FILMS.forEach(([title], i) => fs.writeFileSync(path.join(dir, `${i}.svg`), posterSvg(title, COLORS[i % COLORS.length])));
    srv.profiles.dana = await srv.api.createProfile("Dana", { open: true });
    srv.profiles.avi = await srv.api.createProfile("Avi", { open: true });
    srv.profiles.ben = await srv.api.createProfile("Ben", { open: true });
    srv.profiles.noa = await srv.api.createProfile("Noa", { open: true });
  },
});

// Another page in its own browser context (its own storage: its own person and device).
const pageFor = async (srv, profile, viewport) => {
  const phone = viewport.width < 600;
  const context = await ui.browser.newContext({
    viewport, serviceWorkers: "block",
    ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  });
  await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message)));
  await signIn(page, srv, profile);
  return { page, context, errors };
};
const skipTutorial = async (page) => {
  await page.waitForSelector(".gp-tutorial");
  await page.click('[data-ui="group.tutorial.skip"]');
  await page.waitForSelector(".gp-tutorial", { state: "detached" });
};
const topTitle = (page) => page.$eval(".gp-card.top .ts-title", (n) => n.textContent).catch(() => null);

// ---- the game around the vote ----
// Every reveal curtain and every meteor burst put on the page from now on is
// counted (both take themselves off when they are over).
const countShow = (page) => page.evaluate(() => {
  window.__game = { shows: 0, bursts: 0 };
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches(".pg-show") || n.querySelector(".pg-show")) window.__game.shows++;
      if (n.matches(".play-burst") || n.querySelector(".play-burst")) window.__game.bursts++;
    }
  }).observe(document.body, { childList: true, subtree: true });
});
const game = (page) => page.evaluate(() => window.__game);
const stepOf = (page) => page.$eval(".screen.gp", (n) => n.dataset.step || null);
const tally = (page) => page.$$eval(".gp-result .pg-tally .pg-tmark", (list) => list.map((n) => n.className.replace("pg-tmark", "").trim()));
// What the game left running: its own animations, its sky, a curtain, a burst.
const leftovers = (page) => page.evaluate(() => ({
  nodes: document.querySelectorAll(".screen.gp, .pg-show, .play-burst, .play-room, .pg-room").length,
  anims: document.getAnimations().filter((a) => a.playState === "running" && /^(play|pg)-/.test(a.animationName || "")).map((a) => a.animationName),
}));
// One person alone on a phone: start a room, deal, and answer the whole hand
// (yes to the first `yes` cards, no to the rest).
const playAlone = async (page, srv, { yes = 1 } = {}) => {
  await page.click('[data-ui="group.deal"]');
  await page.waitForSelector(".gp-card.top");
  for (let n = 0; n < 80; n++) {
    const t = await topTitle(page);
    if (!t) break;
    await page.click(`[data-ui="group.${n < yes ? "yes" : "no"}"]`);
    await page.waitForFunction((was) => (document.querySelector(".gp-card.top:not(.leaving) .ts-title")?.textContent || null) !== was || !!document.querySelector(".gp-waiting, .gp-result"), t);
  }
  await page.waitForSelector(".gp-result", { state: "attached" });
};

ui.test("the room: a big screen and three phones pick a film together", { viewport: { width: 1920, height: 1080 }, timeout: 240000 }, async ({ page, srv, signIn: signInHere }) => {
  const { dana, avi, ben } = srv.profiles;
  const pages = [];
  try {
    // ---------- the big screen starts it (Dana's TV) ----------
    await signInHere(dana);
    await goto(page, srv, "#/group", { selector: "#app .screen.gp" });
    await page.waitForSelector(".gp-tutorial");
    await shot(page, "tv-1-tutorial");
    assert.equal(await page.$eval(".gp-tut-title", (n) => n.textContent), "Start it on the TV");
    for (let i = 0; i < 3; i++) await page.click('[data-ui="group.tutorial.next"]');
    assert.equal(await page.$eval(".gp-tut-title", (n) => n.textContent), "The pick shows on the TV");
    await page.click('[data-ui="group.tutorial.next"]'); // "Let's go"
    await page.waitForSelector(".gp-tutorial", { state: "detached" });
    await page.waitForSelector(".gp-start");
    assert.equal(await page.isChecked('.gp-start [data-ui="group.screen"]'), true, "a big screen offers to be the room's screen");
    await page.click('.gp-start [role="radio"]:has-text("Feel-good")').catch(() => {}); // (a mood; the deck here is small, so "Anything" below)
    await page.click('.gp-start [role="radio"]:has-text("Anything")');
    await page.click('.gp-start [role="radio"]:has-text("Under 2 h")');
    await shot(page, "tv-2-start");
    await page.click('[data-ui="group.start"]');
    await page.waitForSelector(".gp-code");
    const code = (await page.$eval(".gp-code", (n) => n.textContent)).trim();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(await page.$(".gp-qr svg"), "a QR code");
    assert.match(page.url(), new RegExp(`#/group/${code}$`));

    // ---------- three phones join the way the QR code takes them ----------
    const phones = [];
    for (const [who, p] of [["dana", dana], ["avi", avi], ["ben", ben]]) {
      const ph = await pageFor(srv, p, PHONE);
      pages.push(ph);
      await goto(ph.page, srv, `#/group/${code}`, { selector: "#app .screen.gp" });
      if (who !== "dana") await skipTutorial(ph.page); // Dana saw it on the TV: once per person, not per device
      await ph.page.waitForSelector(".gp-lobby .gp-code-pill"); // (a guest: the code small, the room first)
      phones.push({ who, ...ph });
    }
    await page.waitForFunction(() => /3 people are in/.test(document.querySelector(".gp-joined")?.textContent || ""));
    // the lobby is a table: a seat for everyone who came (a person on two devices sits once),
    // chairs left free for more
    assert.equal(await stepOf(page), "lobby");
    assert.deepEqual(await page.evaluate(() => ({
      taken: document.querySelectorAll(".pg-seats .pg-seat:not(.pg-seat--free)").length,
      free: document.querySelectorAll(".pg-seats .pg-seat--free").length,
    })), { taken: 3, free: 2 });
    await shot(phones[1].page, "phone-1-lobby");
    await assertNoHorizontalOverflow(phones[1].page, "phone lobby");

    // ---------- Avi adds a film by search ----------
    const aviP = phones[1].page;
    await aviP.click('[data-ui="group.add"]');
    await aviP.fill(".gp-search-input", "test film");
    await aviP.waitForSelector(".gp-hit");
    await shot(aviP, "phone-2-search");
    await aviP.click('.gp-hit:has-text("Test Film One")');
    await aviP.waitForSelector('.gp-hit:has-text("Test Film One") .gp-hit-state:has-text("Added")');
    await aviP.click('.gp-search .btn-primary');
    await page.waitForSelector('.gp-added-item:has-text("Test Film One")');
    await shot(page, "tv-3-lobby");

    // ---------- the screen deals ----------
    await page.click('[data-ui="group.deal"]');
    await page.waitForSelector(".gp-waiting");
    for (const ph of phones) await ph.page.waitForSelector(".gp-card.top");
    await shot(phones[0].page, "phone-3-swipe");
    // a phone: which card of its own hand this is, and the room beside the clock
    assert.equal(await stepOf(phones[0].page), "swipe");
    assert.match(await phones[0].page.$eval(".pg-hand", (n) => n.textContent), /^Card 1 of \d+$/);
    assert.equal(await phones[0].page.locator(".pg-minis .pg-mini").count(), 3);
    // the big screen: every voter's seat with a ribbon of how far they are
    assert.equal(await stepOf(page), "waiting");
    assert.equal(await page.locator(".gp-waiting .pg-seat").count(), 3);
    assert.equal(await page.locator(".gp-waiting .pg-seat .pg-seat-ribbon").count(), 3);
    await countShow(page);

    // Glass Garden: yes, yes, maybe. Test Film One: yes, yes (Avi's add), no. Everything else: no.
    // Dana answers one card with a drag (right = yes) to prove the gesture.
    // (Avi added Test Film One: that is already his yes, and his deck does not ask him again)
    const plan = { dana: { yes: ["Test Film One", "Glass Garden"] }, avi: { yes: ["Glass Garden"] }, ben: { maybe: ["Glass Garden"] } };
    let dragged = false;
    for (const ph of phones) {
      for (let n = 0; n < 60; n++) {
        const t = await topTitle(ph.page);
        if (!t) break;
        const p = plan[ph.who];
        const verdict = (p.yes || []).includes(t) ? "yes" : (p.maybe || []).includes(t) ? "maybe" : "no";
        if (verdict === "yes" && ph.who === "dana" && !dragged) {
          dragged = true;
          const box = await ph.page.$eval(".gp-card.top", (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
          await ph.page.mouse.move(box.x, box.y);
          await ph.page.mouse.down();
          for (let k = 1; k <= 8; k++) await ph.page.mouse.move(box.x + k * 30, box.y + k * 2);
          await ph.page.mouse.up();
        } else {
          await ph.page.click(`[data-ui="group.${verdict}"]`);
        }
        await ph.page.waitForFunction((was) => (document.querySelector(".gp-card.top:not(.leaving) .ts-title")?.textContent || null) !== was || !!document.querySelector(".gp-waiting, .gp-result"), t);
        if (ph.who === "dana" && n === 1) {
          // Undo takes the last answer back
          const before = await topTitle(ph.page);
          await ph.page.click('[data-ui="group.undo"]');
          await ph.page.waitForFunction((b) => document.querySelector(".gp-card.top .ts-title")?.textContent !== b, before);
        }
        if (ph.who === "dana" && n === 3) await shot(page, "tv-4-progress");
      }
      if (ph.who !== "ben") await ph.page.waitForSelector(".gp-waiting");
    }
    assert.ok(dragged, "a card was answered by dragging");
    await shot(phones[0].page, "phone-4-waiting").catch(() => {});

    // ---------- the pick, on the big screen ----------
    await page.waitForSelector(".gp-result .gp-result-title", { timeout: 20000 });
    assert.equal(await page.$eval(".gp-result-title", (n) => n.textContent), "Glass Garden");
    assert.equal(await page.$eval(".gp-why", (n) => n.textContent.replace(/^✓\s*/, "")), "2 of 3 said yes · 1 maybe");
    // the screen watched the votes come in: the curtain played once, lifted by itself,
    // and the one reward of the night went off — no tie-break (the votes were not level)
    await page.waitForSelector(".pg-show", { state: "detached", timeout: 15000 });
    await page.waitForFunction(() => window.__game.bursts === 1, null, { timeout: 5000 });
    assert.deepEqual(await game(page), { shows: 1, bursts: 1 });
    assert.equal(await stepOf(page), "result");
    assert.deepEqual(await tally(page), ["yes", "yes", "maybe"], "the tally is drawn as it was counted");
    assert.equal(await page.locator(".pg-tie-line").count(), 0);
    await shot(page, "tv-5-result");
    for (const ph of phones) await ph.page.waitForSelector(".gp-result .gp-result-title");
    assert.equal(await phones[2].page.$eval('[data-ui="group.play"]', (n) => n.textContent.trim()), "▶ Play on the big screen");
    await shot(phones[2].page, "phone-5-result");
    await assertNoHorizontalOverflow(phones[2].page, "phone result");

    // "Something else" on a phone moves the whole room
    await phones[0].page.click('[data-ui="group.next"]');
    await page.waitForFunction(() => document.querySelector(".gp-result-title")?.textContent === "Test Film One");
    assert.equal(await page.$eval(".gp-why", (n) => n.textContent.replace(/^✓\s*/, "")), "2 of 3 said yes · 1 no");
    // (the next pick turns over quietly: its own tally, no second curtain, no second reward)
    assert.deepEqual(await tally(page), ["yes", "yes", "no"]);
    assert.deepEqual(await game(page), { shows: 1, bursts: 1 });
    await phones[0].page.waitForFunction(() => document.querySelector(".gp-result-title")?.textContent === "Test Film One");

    // Play on a phone: the big screen starts it
    await phones[2].page.click('[data-ui="group.play"]');
    await phones[2].page.waitForSelector(".gp-chosen");
    assert.match(await phones[2].page.$eval(".gp-chosen", (n) => n.textContent), /Starting on the big screen/);
    await shot(phones[2].page, "phone-6-chosen");
    await page.waitForFunction(() => /^#\/play\//.test(location.hash), null, { timeout: 15000 });
    for (const ph of phones) assert.deepEqual(ph.errors, [], `${ph.who}'s page had no errors`);
  } finally {
    for (const ph of pages) await ph.context.close().catch(() => {});
  }
});

ui.test("phone: start it here, the 320 px layout, a wrong code, How it works", { viewport: { width: 320, height: 640 }, allow: [/status of 404 .*\/group\/join/] }, async ({ page, srv, signIn: signInHere }) => {
  await signInHere(srv.profiles.noa);
  await goto(page, srv, "#/group", { selector: "#app .screen.gp" });
  await skipTutorial(page);
  await page.waitForSelector(".gp-start");
  await assertNoHorizontalOverflow(page, "chooser at 320");
  assert.equal(await page.isChecked('.gp-start [data-ui="group.screen"]'), false, "a phone swipes");
  // a wrong code is answered next to the field
  await page.fill(".gp-code-input", "zz1");
  await page.click('[data-ui="group.join"]');
  assert.equal(await page.$eval(".gp-error", (n) => n.textContent), "The code is four letters and numbers.");
  await page.fill(".gp-code-input", "ZZZZ");
  await page.click('[data-ui="group.join"]');
  await page.waitForSelector(".gp-note");
  assert.match(await page.$eval(".gp-note", (n) => n.textContent), /No session with that code/);
  // How it works opens the explanation again, any time
  await page.click('[data-ui="group.howto"]');
  await page.waitForSelector(".gp-tutorial");
  await page.click('[data-ui="group.tutorial.skip"]');
  await page.waitForSelector(".gp-tutorial", { state: "detached" });
  // start one here, alone: the phone is the voter and the deal is its own
  await page.click('[data-ui="group.start"]');
  await page.waitForSelector(".gp-lobby .gp-code");
  await assertNoHorizontalOverflow(page, "lobby at 320");
  await shot(page, "phone-320-lobby");
  await page.click('[data-ui="group.deal"]');
  await page.waitForSelector(".gp-card.top");
  await assertNoHorizontalOverflow(page, "swipe at 320");
  await shot(page, "phone-320-swipe");
  // keyboard: → yes, ← no, ↓ maybe
  const first = await topTitle(page);
  await page.focus(".gp-card.top");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((was) => document.querySelector(".gp-card.top:not(.leaving) .ts-title")?.textContent !== was, first);
  const r = await srv.api.get(`/api/profiles/${srv.profiles.noa.id}/group/options`);
  assert.equal(r.tutorialSeen, true, "skipping counts as seen");
});

ui.test("alone on a phone: the curtain plays once, Skip ends it, and nothing of the game stays after leaving", { viewport: PHONE }, async ({ page, srv, signIn: signInHere, freshProfile }) => {
  await signInHere(await freshProfile());
  await goto(page, srv, "#/group", { selector: "#app .screen.gp" });
  await skipTutorial(page);
  await page.click('[data-ui="group.start"]');
  await page.waitForSelector(".gp-lobby .gp-code");
  await countShow(page);
  await playAlone(page, srv, { yes: 2 });

  // the votes are in: the curtain is up, Skip is where the keys are, the result waits under it
  await page.waitForSelector(".pg-show");
  assert.equal(await page.$eval(".pg-show-words", (n) => n.textContent), "The votes are in…");
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.className), "pg-show-skip focusable");
  assert.equal(await page.$eval(".gp-result", (n) => n.inert), true, "the result can be pressed under the curtain");
  await page.click(".pg-show-skip");
  await page.waitForSelector(".pg-show", { state: "detached" });
  // the pick is there, Play has the keys, the one voter's yes is one gold star
  assert.equal(await page.$eval(".gp-result", (n) => n.inert), false);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.ui), "group.play");
  assert.deepEqual(await tally(page), ["yes"]);
  const fit = await page.evaluate(() => ({ bottom: Math.round(document.querySelector('[data-ui="group.play"]').getBoundingClientRect().bottom), h: window.innerHeight }));
  assert.ok(fit.bottom <= fit.h, `Play is under the fold: ${JSON.stringify(fit)}`);
  await assertNoHorizontalOverflow(page, "the result on a phone");
  assert.equal((await game(page)).shows, 1);

  // away: no curtain, no sky, no burst, nothing of the game still moving
  await goto(page, srv, "#/movies");
  await page.waitForTimeout(500);
  assert.deepEqual(await leftovers(page), { nodes: 0, anims: [] });
});

ui.test("a phone that asked for less motion: the pick is simply there — no curtain, no burst, nothing moving", { viewport: PHONE, device: { reducedMotion: "reduce" } }, async ({ page, srv, signIn: signInHere, freshProfile }) => {
  await signInHere(await freshProfile());
  await goto(page, srv, "#/group", { selector: "#app .screen.gp" });
  await skipTutorial(page);
  await page.click('[data-ui="group.start"]');
  await page.waitForSelector(".gp-lobby .gp-code");
  await countShow(page);
  await playAlone(page, srv, { yes: 1 });
  await page.waitForSelector(".gp-result .gp-result-title");
  await page.waitForTimeout(700);
  assert.deepEqual(await game(page), { shows: 0, bursts: 0 }, "a show for someone who asked for less motion");
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.ui), "group.play");
  assert.deepEqual(await tally(page), ["yes"]);
  const moving = await page.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === "running" && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".screen.gp"))
    .map((a) => a.animationName || a.transitionProperty));
  assert.deepEqual(moving, [], "something is still moving on the page");
  await assertNoHorizontalOverflow(page, "the still result on a phone");
});

ui.test("nobody said yes: 'No match' under the feature's own name, and no show for it", { viewport: PHONE }, async ({ page, srv, signIn: signInHere, freshProfile }) => {
  await signInHere(await freshProfile());
  await goto(page, srv, "#/group", { selector: "#app .screen.gp" });
  await skipTutorial(page);
  await page.click('[data-ui="group.start"]');
  await page.waitForSelector(".gp-lobby .gp-code");
  await countShow(page);
  await playAlone(page, srv, { yes: 0 });
  await page.waitForSelector(".gp-nomatch");
  // (the line over it used to say "Tonight's pick" — over no pick at all)
  assert.equal(await page.$eval(".gp-nomatch .play-eyebrow", (n) => n.textContent.trim()), "What do we watch tonight?");
  assert.equal(await page.$eval(".gp-nomatch h1", (n) => n.textContent), "No match this time");
  assert.equal(await page.locator(".gp-result .pg-tally").count(), 0);
  assert.equal(await page.locator('[data-ui="group.again"]').isVisible(), true);
  await page.waitForTimeout(500);
  assert.deepEqual(await game(page), { shows: 0, bursts: 0 });
  await assertNoHorizontalOverflow(page, "no match on a phone");
});

ui.run();
