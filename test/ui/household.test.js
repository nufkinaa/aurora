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

  // The design (2026-10-28, elia: "on mobile the Add to List button does not
  // look that great — make sure it really looks good"): the + owns the
  // card's top-right corner with a finger-sized press area, nothing on the
  // card overlaps, who-recommended takes up to two lines, Hebrew keeps its
  // own direction; a picker with many people keeps its title and Send on
  // screen; the title page's line stacks on a phone.
  ui.test(`${tag}: the design — the card's corners, press sizes, two-line who, Hebrew; many faces; the banner`, { viewport }, async ({ page, goto, signIn, api, lib }) => {
    const phone = viewport.width < 600;
    const maya = await person(api, "Maya");
    const max = await person(api, "Maximiliana Josephine");
    const heb = await person(api, "דנה");
    const ben = await person(api, "Ben");
    await setLook(api, maya, look);
    const hebTitle = { ...cat(7000 + n), title: "השוטר הטוב — סרט ארוך מאוד עם שם ארוך" };
    const longTitle = { ...cat(7100 + n), title: "Dr. Strangelove or: How I Learned to Stop Worrying and Love the Bomb" };
    await send(api, ben, maya, longTitle);
    await send(api, heb, maya, longTitle);
    await send(api, max, maya, longTitle, "Watch it with the lights off and the sound up — the last twenty minutes are the best thing I've seen all year. Don't read a thing.");
    await send(api, heb, maya, hebTitle, "חובה לראות! הסוף מטורף");
    await send(api, ben, maya, { id: lib.film1.id }, "Short");
    await signIn(maya);
    await goto("#/");
    await page.waitForSelector(HH_ROW);
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "center" }), HH_ROW);
    await page.waitForTimeout(300);
    const facts = await page.evaluate((sel) => {
      const box = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return b.width ? { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height } : null; };
      const hit = (a, b) => !!(a && b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5);
      // the cards wholly on screen
      return [...document.querySelectorAll(`${sel} .row-scroller > .card`)].filter((c) => { const b = c.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; }).map((c) => {
        const add = c.querySelector(".card-hhadd");
        const meta = c.querySelector(".card-meta");
        const label = c.querySelector(".card-label");
        const parts = { card: box(c), add: box(add), new: box(c.querySelector(".card-new")), label: box(label), meta: box(meta) };
        // the press area: a 44 px square around the +'s centre all lands on it
        let pressed = 0;
        const cx = (parts.add.l + parts.add.r) / 2, cy = (parts.add.t + parts.add.b) / 2;
        for (let dx = -21; dx <= 21; dx += 7) for (let dy = -21; dy <= 21; dy += 7) {
          const e = document.elementFromPoint(cx + dx, cy + dy);
          if (e && e.closest(".card-hhadd") === add) pressed++;
        }
        const lh = parseFloat(getComputedStyle(meta).lineHeight);
        return {
          name: c.getAttribute("aria-label"),
          parts, pressed,
          kindTags: c.querySelectorAll(".card-tag.kind").length,
          overlaps: [["add", "new"], ["add", "label"], ["new", "label"]].filter(([a, b]) => hit(parts[a], parts[b])).map((x) => x.join("/")),
          metaLines: Math.round(parts.meta.h / lh),
          // "and 2 others" is never the part that is cut
          countCut: (() => { const b = meta.querySelector(".who-b"); return b ? b.scrollWidth > b.clientWidth + 1 : false; })(),
          metaParts: [...meta.children].map((x) => x.className),
          labelDir: getComputedStyle(label).unicodeBidi,
        };
      });
    }, HH_ROW);
    for (const f of facts) {
      const { card: c, add, label } = f.parts;
      assert.ok(add, `${f.name}: a + on the card`);
      assert.equal(f.kindTags, 0, `${f.name}: the + owns the corner (no kind tag)`);
      assert.ok(c.r - add.r >= 4 && c.r - add.r <= 12 && add.t - c.t >= 4 && add.t - c.t <= 12, `${f.name}: the + sits in the top-right corner (${JSON.stringify(add)} in ${JSON.stringify(c)})`);
      assert.ok(add.w >= 26 && add.w <= 32 && Math.abs(add.w - add.h) < 1, `${f.name}: a round disc of 26–32 px (${add.w})`);
      if (phone) assert.equal(f.pressed, 49, `${f.name}: a finger's 44 px press area (${f.pressed}/49 points)`);
      assert.deepEqual(f.overlaps, [], `${f.name}: nothing on the card overlaps`);
      assert.ok(label.l >= c.l && label.r <= c.r && label.b <= c.b, `${f.name}: the words stay on the card`);
      assert.ok(f.metaLines >= 1 && f.metaLines <= 2, `${f.name}: who takes one or two lines (${f.metaLines})`);
      assert.equal(f.countCut, false, `${f.name}: the count is never cut`);
      assert.equal(f.labelDir, "plaintext", "each line in the direction of its own words");
    }
    assert.ok(facts.length >= 2, `cards on screen: ${facts.length}`);
    const strange = facts.find((f) => /^Dr\. Strangelove/.test(f.name));
    assert.match(strange.name, new RegExp(`From ${max.name} and 2 others`));
    assert.deepEqual(strange.metaParts, ["who-a", "who-b"], "who, then how many more, in two parts");
    // a right-to-left name or title inside an English line is isolated
    // (invisible FSI…PDI marks, as the TV does); a left-to-right one is not
    const bidi = await page.evaluate(async () => {
      const m = await import("/js/recommend.js");
      return [m.arrivalLine([{ title: "Dune", hh: { from: [{ name: "נועם" }] } }]), m.arrivalLine([{ title: "הלהקה", hh: { from: [{ name: "Dana" }] } }]), m.fromLine(["Dana", "Avi"]), m.fromLine(["נועם", "Avi", "Eve"])];
    });
    assert.deepEqual(bidi, ["\u2068נועם\u2069 recommended Dune", "Dana recommended \u2068הלהקה\u2069", "From Dana and Avi", "From \u2068נועם\u2069 and 2 others"]);
    const hebCard = facts.find((f) => /^השוטר/.test(f.name));
    if (hebCard) assert.deepEqual(hebCard.metaParts, ["who-a"], "a Hebrew sender's card still draws its who line");
    // a + press: In My List, and the card does not take the focus (no lifted, ringed card)
    const first = page.locator(`${HH_ROW} .row-scroller > .card`).first();
    await first.locator('[data-ui="card.hh.add"]').click();
    await page.waitForFunction((sel) => document.querySelector(`${sel} .row-scroller > .card`).classList.contains("hh-added"), HH_ROW);
    // (a pointer focuses what it is over — focus.js — so only a finger's tap is the question)
    if (phone) assert.equal(await first.evaluate((n) => document.activeElement === n), false, "the card did not take the focus");
    assert.equal(await first.locator(".card-hhadd").getAttribute("aria-label"), "In My List");

    // the picker with many people: the title and Send stay on screen, the faces scroll
    for (const nm of ["Avi", "Eve", "Gil", "Hod", "Ido", "Lea", "Omer", "Tal", "Ziv"]) await person(api, nm);
    await goto(`#/movie/${lib.film2.id}`);
    await page.locator('#app [data-ui="detail.recommend"]').first().click();
    await page.waitForSelector(".rec-sheet .rec-person");
    await page.locator(".rec-person", { hasText: max.name }).first().click();
    const sheet = await page.evaluate(() => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { t: b.top, b: b.bottom, h: b.height }; };
      const list = document.querySelector(".rec-people");
      const name = [...document.querySelectorAll(".rec-person .rec-name")].find((x) => /^Maximiliana/.test(x.textContent));
      return { vh: innerHeight, head: r(".rec-head"), send: r('.rec-sheet [data-ui="recommend.send"]'), scrolls: list.scrollHeight > list.clientHeight + 2, people: document.querySelectorAll(".rec-person").length,
        nameLines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)) };
    });
    assert.ok(sheet.people >= 12, `many people (${sheet.people})`);
    assert.ok(sheet.head.t >= 0 && sheet.send.b <= sheet.vh, `the title and Send are on screen (${JSON.stringify(sheet)})`);
    assert.ok(sheet.scrolls, "the faces scroll between them");
    assert.equal(sheet.nameLines, 2, "a long name takes two lines, not an ellipsis");
    if (phone) assert.ok(sheet.send.h >= 44, "Send is a finger's size");
    // a greyed face: the face fades, its reason stays readable
    const off = await page.evaluate(() => {
      const p = document.querySelector(".rec-person.off");
      if (!p) return null;
      return { face: Number(getComputedStyle(p.querySelector(".rec-face")).opacity), cell: Number(getComputedStyle(p).opacity), line: p.querySelector(".rec-line") ? Number(getComputedStyle(p.querySelector(".rec-line")).opacity) : null };
    });
    if (off) {
      assert.equal(off.cell, 1, "the greyed cell itself is not faded…");
      assert.ok(off.face < 0.6, "…its face is");
    }
    await page.locator(".rec-note").fill("x".repeat(140));
    const grown = await page.evaluate(() => { const t = document.querySelector(".rec-note"); return t.scrollHeight <= t.clientHeight + 2; });
    assert.ok(grown, "the note grows to show what was typed");
    await assertNoHorizontalOverflow(page, "the Recommend sheet with many people");
    await shot(page, `${tag}-17-design-picker-many`);
    await page.locator('.rec-sheet [data-ui="recommend.close"]').click();
    await page.waitForSelector(".rec-wrap", { state: "detached" });

    // the title page's line: on a phone Not for me goes under the words
    await goto(`#/movie/${lib.film1.id}`);
    await page.waitForSelector("#app .rec-banner:not(.hidden)");
    const ban = await page.evaluate(() => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, h: b.height }; };
      return { text: r("#app .rec-banner-body > div"), no: r("#app .rec-banner-no"), body: r("#app .rec-banner-body") };
    });
    if (phone) assert.ok(ban.no.t >= ban.text.b - 1, `Not for me under the words on a phone (${JSON.stringify(ban)})`);
    else assert.ok(ban.no.l >= ban.text.r - 1, "Not for me beside the words");
    assert.ok(ban.no.r <= ban.body.r + 0.5, "inside its box");
    if (phone) assert.ok(ban.no.h >= 44, "a finger's size");
    await assertNoHorizontalOverflow(page, "the title page's line");
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
    // where it sits: a wide screen, at the right end of the title line; a
    // phone, under the shelf — never over a card or the title
    const where = await page.evaluate((sel) => {
      const r = (n) => { const b = n.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, h: b.height }; };
      const s = document.querySelector(sel);
      const title = s.querySelector(".row-title");
      const range = document.createRange();
      range.selectNodeContents(title);
      return { link: r(s.querySelector(".hh-all")), title: r(title), words: r(range), shelf: r(s.querySelector(".row-scroller > .card")), vw: innerWidth };
    }, HH_ROW);
    if (viewport.width < 600) {
      assert.ok(where.link.t >= where.shelf.b, `under the shelf on a phone (${JSON.stringify(where)})`);
      assert.ok(where.link.h >= 44, "a finger's size");
    } else {
      assert.ok(where.link.b <= where.shelf.t && where.link.l > where.words.r, `at the end of the title line (${JSON.stringify(where)})`);
      assert.ok(where.link.r <= where.vw, "on screen");
    }
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
