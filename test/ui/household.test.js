// Household recommendations on the website (desktop and phone, both looks):
// Recommend from a title page → the faces → a note → Send, the kid greyed,
// the limit said in the sheet; the recipient's Home row ("From Dana"), + to
// My List, the peek sheet's note and Not for me (Undo), the title page's
// "Recommended by"; "Show all recommended" only past 15 → the page and its
// filter; "You sent" with what became of each; the toast when one arrives;
// Settings → Recommendations (mute, off); a film's credits card.
// The rules are pinned in test/household.test.js and test/household-server.test.js.
//
// HH_SHOTS=1 also writes the screenshots to docs/qa/household-recs/.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, PHONE, DESKTOP, assertNoHorizontalOverflow, certificatesSeed, player } = require("./helpers");

const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "household-recs");
const shot = async (page, name) => {
  if (!process.env.HH_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(450); // (sheets and toasts finish arriving)
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
};

const ui = suite({
  server: { seed: { "cache/certificates.json": certificatesSeed({ film1: 0, film2: 18, show: 7 }) } },
});

let n = 0;
const NAMES = ["Dana", "Avi", "Noa", "Ben", "Eve", "Fay", "Gil", "Hod", "Ido", "Lea"];
// a fresh open profile with a readable name ("Dana", "Dana2", …)
const seenNames = new Map();
const person = (api, name, o = {}) => {
  n++;
  const k = (seenNames.get(name) || 0) + 1;
  seenNames.set(name, k);
  return api.createProfile(k === 1 ? name : `${name}${k}`, { open: true, ...o });
};
const cat = (i) => ({ imdbId: `tt${8100000 + i}`, type: i % 2 ? "movie" : "show", title: `Catalogue ${i}`, year: 2024, poster: null });
const send = (api, from, to, title, note = "") => api.post(`/api/profiles/${from.id}/recommend`, { to: [].concat(to).map((p) => p.id), title, note });
const setLook = async (api, p, look) => { if (look === "legacy") await api.ok("PUT", `/api/profiles/${p.id}`, { look: "legacy" }); };
const toastSays = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll("#toasts .toast")].some((t) => new RegExp(src).test(t.innerText.replace(/\s+/g, " "))), re.source, { timeout: 15000 });
const HH_ROW = '#app section.row[data-row-id="household"]';
const rowCards = (page) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} .row-scroller > .card`)].map((c) => c.getAttribute("aria-label")), HH_ROW);

const LOOKS = [["glass", DESKTOP], ["glass", PHONE], ["legacy", DESKTOP], ["legacy", PHONE]];
for (const [look, viewport] of LOOKS) {
  const tag = `${viewport.width < 600 ? "phone" : "desktop"}-${look}`;

  ui.test(`${tag}: Recommend on a title page — faces, a note, Send; the kid greyed; the limit said`, { viewport }, async ({ page, goto, signIn, api, lib }) => {
    const dana = await person(api, "Dana");
    const avi = await person(api, "Avi");
    const noa = await person(api, "Noa", { kids: { maxAge: 7 } });
    await setLook(api, dana, look);
    await signIn(dana);
    await goto(`#/movie/${lib.film2.id}`);
    const btn = page.locator('#app [data-ui="detail.recommend"]').first();
    await btn.waitFor();
    await btn.click();
    await page.waitForSelector(".rec-sheet .rec-person");
    const sheet = page.locator(".rec-sheet");
    assert.match(await sheet.innerText(), /Recommend “Test Film Two”/);
    assert.match(await sheet.innerText(), /Pick who should see it/);
    // the kid is greyed with why (Test Film Two is 18+); Send waits for a pick
    const kid = page.locator(".rec-person", { hasText: noa.name });
    assert.equal(await kid.getAttribute("aria-disabled"), "true");
    assert.match(await kid.innerText(), new RegExp(`Not for ${noa.name}'s age`));
    const sendBtn = page.locator('.rec-sheet [data-ui="recommend.send"]');
    assert.equal(await sendBtn.isDisabled(), true);
    assert.equal((await sendBtn.innerText()).trim(), "Send");
    await page.locator(".rec-person", { hasText: avi.name }).click();
    await kid.click({ force: true });
    assert.equal(await kid.getAttribute("aria-pressed"), "false", "a greyed face can't be picked");
    assert.equal((await sendBtn.innerText()).trim(), "Send to 1");
    await page.locator(".rec-note").fill("The second half is wild — stay till the end");
    assert.equal((await page.locator(".rec-count").innerText()).trim(), `${Array.from("The second half is wild — stay till the end").length}/140`);
    await assertNoHorizontalOverflow(page, "the Recommend sheet");
    await shot(page, `${tag}-1-recommend-sheet`);
    await sendBtn.click();
    await toastSays(page, new RegExp(`Recommended to ${avi.name}`));
    await page.waitForSelector(".rec-wrap", { state: "detached" });
    await shot(page, `${tag}-2-sent-toast`);
    // stored for Avi, with the note
    const got = await api.get(`/api/profiles/${avi.id}/household`);
    assert.equal(got.items[0].id, lib.film2.id);
    assert.equal(got.items[0].hh.note, "The second half is wild — stay till the end");

    // three more to Avi this hour: the fifth is refused — the sheet says until when
    for (const i of [1, 2, 3]) await send(api, dana, avi, cat(100 * LOOKS.length + i + n));
    await goto(`#/movie/${lib.film1.id}`);
    await page.locator('#app [data-ui="detail.recommend"]').first().click();
    await page.waitForSelector(".rec-sheet .rec-person");
    const a = page.locator(".rec-person", { hasText: avi.name });
    assert.equal(await a.getAttribute("aria-disabled"), "true");
    assert.match(await a.innerText(), /More in \d+ min/);
    await shot(page, `${tag}-3-limit-greyed`);
    // Back closes it
    await page.keyboard.press("Escape");
    await page.waitForSelector(".rec-wrap", { state: "detached" });
  });

  ui.test(`${tag}: the recipient's row — From…, + to My List, the peek's note, Not for me and Undo, the title page's line`, { viewport }, async ({ page, goto, signIn, api, lib }) => {
    const dana = await person(api, "Dana");
    const ben = await person(api, "Ben");
    const avi = await person(api, "Avi");
    await setLook(api, avi, look);
    await send(api, dana, avi, { id: lib.film1.id }, "Short, sweet and very odd");
    await send(api, ben, avi, { id: lib.film1.id });
    const c = cat(500 + n);
    await send(api, ben, avi, c);
    await signIn(avi);
    await goto("#/");
    await page.waitForSelector(HH_ROW);
    assert.equal((await page.locator(`${HH_ROW} .row-title`).first().innerText()).split("\n")[0].trim(), "Recommended by your household");
    const labels = await rowCards(page);
    assert.match(labels[0], new RegExp(`^Test Film One.*From ${ben.name} and ${dana.name}`), "two people: first, newest first");
    assert.match(labels[1], new RegExp(`^${c.title}.*From ${ben.name}`));
    // the row sits right under Recommended for You (when there is one)
    const order = await page.evaluate(() => [...document.querySelectorAll("#app section.row[data-row-id]")].map((s) => s.dataset.rowId));
    const rec = order.indexOf("recommended");
    if (rec !== -1) assert.equal(order.indexOf("household"), rec + 1);
    // no Show all for 2
    assert.equal(await page.locator(`${HH_ROW} .hh-all`).count(), 0);
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "center" }), HH_ROW);
    await shot(page, `${tag}-4-home-row`);

    // + on the catalogue card: on My List, the card says so
    const second = page.locator(`${HH_ROW} .row-scroller > .card`).nth(1);
    await second.locator('[data-ui="card.hh.add"]').click();
    await toastSays(page, /Added to My List/);
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .row-scroller > .card`)[1].classList.contains("hh-added"), HH_ROW);
    const list = await api.get(`/api/profiles/${avi.id}/watchlist`);
    assert.ok(list.items.some((i) => i.imdbId === c.imdbId), "the title is on Avi's list");
    await shot(page, `${tag}-5-added`);

    // hold (right-click) the first: who, the note, Add to My List, Recommend, Not for me
    await page.locator(`${HH_ROW} .row-scroller > .card`).first().click({ button: "right" });
    await page.waitForSelector(".peek .peek-hh");
    const peek = await page.locator(".peek").innerText();
    assert.match(peek, new RegExp(`From ${ben.name} and ${dana.name}`));
    assert.match(peek, new RegExp(`“Short, sweet and very odd” — ${dana.name}`));
    assert.match(peek, /Add to My List/);
    assert.match(peek, /Recommend/);
    await shot(page, `${tag}-6-peek`);
    await page.locator('.peek [data-ui="peek.hh.dismiss"]').click();
    await toastSays(page, /Hidden from your recommendations/);
    await page.waitForFunction((sel) => ![...document.querySelectorAll(`${sel} .row-scroller > .card`)].some((x) => /^Test Film One/.test(x.getAttribute("aria-label"))), HH_ROW);
    assert.ok(!(await api.get(`/api/profiles/${avi.id}/household`)).items.some((i) => i.id === lib.film1.id));
    await shot(page, `${tag}-7-not-for-me`);
    await page.locator("#toasts .toast", { hasText: "Hidden from your recommendations" }).locator(".toast-act").click();
    await page.waitForFunction(async (u) => (await (await fetch(u)).json()).items.some((i) => /^Test Film One$/.test(i.title)), `/api/profiles/${avi.id}/household`);
    await page.waitForFunction((sel) => [...document.querySelectorAll(`${sel} .row-scroller > .card`)].some((x) => /^Test Film One/.test(x.getAttribute("aria-label"))), HH_ROW);

    // the title page: who, the note, Not for me
    await goto(`#/movie/${lib.film1.id}`);
    await page.waitForSelector("#app .rec-banner:not(.hidden)");
    const banner = await page.locator("#app .rec-banner").innerText();
    assert.match(banner, new RegExp(`Recommended by ${ben.name} and ${dana.name}`));
    assert.match(banner, /“Short, sweet and very odd”/);
    assert.match(banner, /Not for me/);
    await assertNoHorizontalOverflow(page, "the title page with its line");
    await page.locator("#app .rec-banner").scrollIntoViewIfNeeded();
    await page.evaluate(() => { for (const t of document.querySelectorAll("#toasts .toast")) t.remove(); });
    await shot(page, `${tag}-8-title-banner`);
  });

  ui.test(`${tag}: Show all recommended — only past 15; the page, its filter, You sent`, { viewport }, async ({ page, goto, signIn, api }) => {
    const avi = await person(api, "Avi");
    await setLook(api, avi, look);
    const senders = [];
    for (let i = 0; i < 5; i++) senders.push(await person(api, NAMES[(i + 3) % NAMES.length]));
    const base = 1000 + n * 40;
    // 17 titles: four each from four people, one from a fifth — and that
    // fifth also sends two the others sent, so those rank first
    let k = 0;
    for (const s of senders.slice(0, 4)) for (let j = 0; j < 4; j++) await send(api, s, avi, cat(base + k++));
    await send(api, senders[4], avi, cat(base + 16));
    await send(api, senders[4], avi, cat(base + 5));
    await send(api, senders[4], avi, cat(base + 9));
    await signIn(avi);
    await goto("#/");
    await page.waitForSelector(HH_ROW);
    const labels = await rowCards(page);
    assert.ok(labels.length <= 15, `the row holds ${labels.length}`);
    assert.match(labels[0], /^Catalogue (\d+).*and/, "a title two people recommended is first");
    const all = page.locator(`${HH_ROW} [data-ui="home.hh.all"]`);
    await all.waitFor();
    assert.equal((await all.innerText()).trim(), "Show all recommended");
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "center" }), `${HH_ROW} .hh-all`);
    await shot(page, `${tag}-9-show-all-link`);
    await all.click();
    await page.waitForSelector("#app .screen.household .hh-grid .card");
    assert.equal((await page.locator("#app .screen.household h1").innerText()).trim(), "Recommended by your household");
    assert.equal((await page.locator("#app .screen.household .browse-head .count").innerText()).trim(), "17");
    assert.equal(await page.locator("#app .screen.household .hh-grid .card").count(), 17);
    // looked at: nothing is new any more
    await page.waitForFunction(async (u) => (await (await fetch(u)).json()).unseen === 0, `/api/profiles/${avi.id}/household`);
    await assertNoHorizontalOverflow(page, "the Show all page");
    await shot(page, `${tag}-10-show-all-page`);
    // one person
    await page.locator('#app [data-ui="household.filter"]', { hasText: senders[4].name }).click();
    await page.waitForFunction(() => document.querySelectorAll("#app .screen.household .hh-grid .card").length === 3);
    await shot(page, `${tag}-11-filtered`);
    // "You sent": Avi sent nothing
    await page.locator('#app [data-ui="household.tab"]', { hasText: "You sent" }).click();
    await page.waitForSelector("#app .screen.household .hh-empty");
    assert.match(await page.locator("#app .screen.household .hh-empty").innerText(), /You haven't recommended anything yet/);
    assert.match(page.url(), /#\/household\/sent$/);
  });

  ui.test(`${tag}: You sent — what became of each; Settings → Recommendations: mute, off, What you sent`, { viewport }, async ({ page, goto, signIn, api, lib }) => {
    const dana = await person(api, "Dana");
    const avi = await person(api, "Avi");
    const ben = await person(api, "Ben");
    const eve = await person(api, "Eve");
    await setLook(api, dana, look);
    await send(api, dana, [avi, ben, eve], { id: lib.film1.id }, "Tiny and great");
    await api.post(`/api/profiles/${avi.id}/watchlist`, { itemId: lib.film1.id });
    await api.setProgress(ben, lib.film1.id, 59, 60);
    await signIn(dana);
    await goto("#/preferences");
    const more = page.locator(".pref-more-toggle");
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    const section = page.locator(".pref-section", { has: page.locator(".hh-prefs") });
    await section.scrollIntoViewIfNeeded();
    assert.match(await section.innerText(), /Recommendations from the household/);
    assert.match(await section.innerText(), /Mute someone and their recommendations stop reaching you\. They aren't told\./);
    // mute Avi
    await section.locator('[data-ui="settings.hh.mute"]', { hasText: avi.name }).click();
    await page.waitForFunction((name) => [...document.querySelectorAll('.hh-prefs [data-ui="settings.hh.mute"]')].some((b) => b.textContent === `${name} · Muted`), avi.name);
    const s1 = await api.get(`/api/profiles/${dana.id}/household/settings`);
    assert.ok(s1.people.find((p) => p.id === avi.id).muted);
    await shot(page, `${tag}-12-settings`);
    // off, and on again
    const sw = section.locator('[role="switch"]');
    await sw.click();
    await page.waitForFunction(() => document.querySelector('.hh-prefs [role="switch"]').getAttribute("aria-checked") === "false");
    assert.equal((await api.get(`/api/profiles/${dana.id}/household/settings`)).on, false);
    await sw.click();
    await page.waitForFunction(() => document.querySelector('.hh-prefs [role="switch"]').getAttribute("aria-checked") === "true");
    // What you sent
    await section.locator(".pref-link", { hasText: "What you sent" }).click();
    await page.waitForSelector("#app .screen.household .hh-sent .hh-st");
    const st = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".hh-st")].map((li) => [li.querySelector(".hh-st-name").textContent, li.querySelector(".hh-st-word").textContent])));
    assert.equal(st[avi.name], "In their list");
    assert.equal(st[ben.name], "Watched");
    assert.equal(st[eve.name], "Sent");
    await assertNoHorizontalOverflow(page, "You sent");
    await shot(page, `${tag}-13-you-sent`);
  });

  ui.test(`${tag}: something arrives — a toast with Show, and the row takes it in`, { viewport }, async ({ page, goto, signIn, api }) => {
    const avi = await person(api, "Avi");
    const ben = await person(api, "Ben");
    await setLook(api, avi, look);
    await signIn(avi);
    // the live socket has said who it is: only then can a ping reach it
    const hello = new Promise((resolve) => page.on("websocket", (ws) => ws.on("framesent", (f) => { if (/"type":"hello"/.test(String(f.payload))) resolve(); })));
    await goto("#/");
    await page.waitForSelector("#app .screen .row");
    await hello;
    await page.waitForTimeout(300);
    const c = cat(3000 + n);
    await send(api, ben, avi, c, "Trust me");
    await toastSays(page, new RegExp(`${ben.name} recommended ${c.title}`));
    await page.waitForSelector(HH_ROW);
    await shot(page, `${tag}-14-arrival-toast`);
    // Show opens the title (here a catalogue title, whose page cannot load
    // offline and goes back — the address it went to is what counts)
    await page.evaluate(() => { window.__hashes = []; addEventListener("hashchange", () => window.__hashes.push(location.hash)); });
    await page.locator("#toasts .toast", { hasText: "recommended" }).locator(".toast-act").click();
    await page.waitForFunction((id) => window.__hashes.some((h) => h.includes(id)), c.imdbId);
  });
}

ui.test("desktop: a film's credits — Enjoyed it? Recommend", { viewport: DESKTOP }, async ({ page, signIn, api, lib, srv }) => {
  const dana = await person(api, "Dana");
  await person(api, "Avi");
  await signIn(dana);
  await player.open(page, srv, lib.film1.id);
  // into the last half minute (the test film is a minute long)
  await page.evaluate(() => { const v = document.querySelector(".player video"); v.currentTime = 40; });
  await page.waitForSelector(".player .film-end", { timeout: 20000 });
  const card = await page.locator(".player .film-end").innerText();
  assert.match(card, /Enjoyed it\?/i); // (the card's small heading is drawn in capitals)
  assert.match(card, /Recommend “Test Film One” to someone in your household/);
  await shot(page, "desktop-glass-15-credits-card");
  await page.locator('.player [data-ui="player.recommend"]').click();
  await page.waitForSelector(".rec-sheet .rec-person");
  await shot(page, "desktop-glass-16-credits-sheet");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".rec-wrap", { state: "detached" });
  assert.ok(await page.locator(".player video").count(), "the player is still there");
});

ui.run();
