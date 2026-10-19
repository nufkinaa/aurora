// A faster first Home, without the screen changing under the viewer
// (elia, 2026-10-19). screens/home.js paints Home from the copy of the last
// answer this browser kept, before /api/home has answered; the new answer is
// then merged in by public/js/homeMerge.js's rule: the shelves on screen and
// their cards keep their places, the focused card stays, shelves off screen
// take the new answer, and the held parts catch up when the viewer scrolls,
// is idle, or leaves Home.
//
// Home's answers here are made up (page.route) so they can be big and can
// change in every way the server's do: shelves reordered, one dropped, a new
// one on top, cards re-ranked, a NEW tag. Desktop and phone, both looks.
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    // the kids switch needs the household PIN
    const kids = await srv.api.call("GET", "/api/kids/status");
    srv.kidsAvailable = kids.status === 200 && Array.isArray(kids.body.ages);
    if (srv.kidsAvailable) await srv.api.adminPost("/api/admin/kids-pin", { pin: "2468" });
  },
});

// Made-up titles warm their pages on hover/focus (prefetch.js): those reads
// are refused by the private server, and that is fine here.
const ALLOW = [/Failed to load resource.*\/api\/(item|discover|library\/for)\b/, /Failed to load resource.*404/];

// ---------- the two answers ----------
const covers = (lib) => [lib.film1.cover, lib.film2.cover, lib.film3 && lib.film3.cover, lib.show.cover].filter(Boolean);
const title = (rowId, i) => `${rowId.toUpperCase()} Title ${i}`;
const item = (lib, rowId, i, extra = {}) => ({
  id: `fake-${rowId}-${i}`,
  type: i % 3 === 0 ? "show" : "movie",
  title: title(rowId, i),
  year: 2000 + (i % 20),
  cover: covers(lib)[i % covers(lib).length],
  ...extra,
});
const ROW_IDS = ["recs", "because", "new-movies", "trending", "upcoming", "genre-drama", "genre-comedy", "genre-crime", "genre-action", "movies"];
const answerA = (lib) => ({
  hero: [lib.film1, lib.film2, lib.show].map((x) => ({ id: x.id, type: x.type || (x.seasons ? "show" : "movie"), title: x.title, year: x.year, cover: x.cover, backdrop: x.backdrop || null })),
  rows: ROW_IDS.map((id) => ({ id, title: `Shelf ${id}`, items: Array.from({ length: 18 }, (_, i) => item(lib, id, i)) })),
});
// The server's next answer: a new shelf on top, the first two shelves'
// cards re-ranked (reversed), the third shelf dropped, the rest of the
// shelves in reverse order, one title in the first shelf tagged NEW.
const answerB = (lib) => {
  const a = answerA(lib);
  const rows = a.rows.map((r) => ({ ...r, items: r.items.slice() }));
  rows[0].items.reverse();
  rows[1].items.reverse();
  rows[0].items = rows[0].items.map((x) => (x.id === "fake-recs-1" ? { ...x, badge: { text: "NEW", tone: "new" } } : x));
  rows[rows.length - 1].items.reverse(); // "movies", far below the screen
  const [r0, r1, , ...rest] = rows;
  return { hero: a.hero, rows: [{ id: "party", title: "Shelf party", items: Array.from({ length: 6 }, (_, i) => item(lib, "party", i)) }, r0, r1, ...rest.reverse()] };
};

// Serve Home's answer from `state.body`; while `state.hold` is a promise, the
// answer waits for it (and `state.waiting` says so).
const serveHome = async (page) => {
  const st = { body: null, hold: null, waiting: 0, served: 0 };
  await page.route(/\/api\/home\?/, async (route) => {
    st.waiting++;
    if (st.hold) await st.hold;
    st.waiting--;
    st.served++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(st.body) }).catch(() => {});
  });
  return st;
};
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};

// ---------- what is on screen ----------
const onScreen = (page) =>
  page.evaluate(() => {
    const vh = innerHeight;
    const vw = innerWidth;
    const out = { rows: [], cards: [] };
    for (const row of document.querySelectorAll("#app [data-row-id]")) {
      const r = row.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh || !r.height) continue;
      out.rows.push({ id: row.dataset.rowId, top: Math.round(r.top) });
      [...row.querySelectorAll(".row-scroller > .card")].forEach((c, i) => {
        const b = c.getBoundingClientRect();
        if (!(b.width > 0 && b.right > 0 && b.left < vw)) return;
        out.cards.push({ row: row.dataset.rowId, i, title: (c.getAttribute("aria-label") || "").split(",")[0], x: Math.round(b.left), y: Math.round(b.top) });
      });
    }
    return out;
  });
const shelfTitles = (page, rowId) =>
  page.evaluate((id) => [...document.querySelectorAll(`#app [data-row-id="${id}"] .row-scroller > .card`)].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]), rowId);
const rowOrder = (page) => page.evaluate(() => [...document.querySelectorAll("#app [data-row-id]")].map((r) => r.dataset.rowId));
const homeData = (page, key) => page.evaluate((k) => (document.querySelector("#app .screen") || {}).dataset?.[k] || null, key);

// The first visit, so this browser keeps a copy: answer A, at once.
const firstVisit = async (page, goto, st, lib, profile) => {
  st.body = answerA(lib);
  await goto("#/");
  await page.waitForSelector('#app [data-row-id="recs"] .card');
  await page.waitForFunction((pid) => !!localStorage.getItem(`aurora-home-${pid}`), profile.id, { timeout: 10000 });
};
// Reload with answer B held back: Home must paint from the copy first.
const reloadHeld = async (page, st, lib) => {
  const g = gate();
  st.body = answerB(lib);
  st.hold = g.p;
  st.servedAtReload = st.served; // (the first visit may have asked twice: a library change at the server's start)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('#app [data-row-id="recs"] .card', { timeout: 15000 });
  // the viewer scrolls the first shelves into view (on a desktop the
  // billboard fills the first screen): the first shelf a quarter of the way down
  await page.evaluate(() => {
    const r = document.querySelector('#app [data-row-id="recs"]');
    window.scrollTo({ top: Math.max(0, r.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.25), behavior: "instant" });
  });
  await page.waitForTimeout(250);
  return g;
};

for (const [vp, label] of [[DESKTOP, "desktop"], [PHONE, "phone"]]) {
  for (const look of ["glass", "legacy"]) {
    ui.test(`${label}, ${look}: Home paints from the kept copy before /api/home answers, and the new answer moves nothing on screen`, { viewport: vp, allow: ALLOW }, async ({ page, signIn, freshProfile, goto, lib, api }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.call("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      await signIn(me);
      const st = await serveHome(page);
      await firstVisit(page, goto, st, lib, me);

      const g = await reloadHeld(page, st, lib);
      // painted from the copy while the server's answer is still held back
      assert.equal(await homeData(page, "homeSrc"), "snapshot");
      assert.ok(st.waiting >= 1 && st.served === st.servedAtReload, `the answer is still on its way (waiting ${st.waiting}, served ${st.served - st.servedAtReload} since the reload)`);
      assert.deepEqual((await rowOrder(page)).slice(0, 3), ["recs", "because", "new-movies"]);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.look || "legacy"), look);
      // desktop: a card has focus (the keyboard / a TV-style remote)
      let focused = null;
      if (label === "desktop") {
        focused = await page.evaluate(() => {
          const c = document.querySelectorAll('#app [data-row-id="recs"] .row-scroller > .card')[2];
          c.dataset.testMark = "focused";
          c.focus({ preventScroll: true });
          return (c.getAttribute("aria-label") || "").split(",")[0];
        });
      }
      await page.waitForTimeout(500); // pictures, fonts and the focus ring settle
      const before = await onScreen(page);
      assert.ok(before.cards.length >= 3, `cards on screen: ${before.cards.length}`);

      // the server answers
      g.open();
      st.hold = null;
      await page.waitForFunction(() => /^(pending|merged)$/.test(document.querySelector("#app .screen").dataset.homeFresh || ""));
      await page.waitForTimeout(300);
      const after = await onScreen(page);

      // nothing on screen moved: the same cards, in the same places
      assert.deepEqual(after.rows, before.rows, "the shelves on screen are where they were");
      assert.deepEqual(after.cards.map((c) => [c.row, c.i, c.title, c.x, c.y]), before.cards.map((c) => [c.row, c.i, c.title, c.x, c.y]), "a card on screen moved or changed");
      assert.equal(await homeData(page, "homeMoved"), "0");
      if (focused) {
        assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.testMark), "focused", "the focused card is still the focused node");
      }
      // the data on screen updated in place: the NEW tag on "RECS Title 1"
      const tagged = await page.evaluate(() => {
        const c = [...document.querySelectorAll('#app [data-row-id="recs"] .row-scroller > .card')].find((x) => /^RECS Title 1\b/.test(x.getAttribute("aria-label") || ""));
        return c ? !!c.querySelector('.card-tag[data-t="NEW"]') : null;
      });
      if (before.cards.some((c) => c.title === "RECS Title 1")) assert.equal(tagged, true, "the NEW tag is drawn in place");
      // the new shelf did not push in on top: it waits below the shelves on screen
      const order = await rowOrder(page);
      assert.notEqual(order[0], "party");
      assert.ok(order.includes("party"), `the new shelf is on the page: ${order.join(",")}`);
      // a shelf below the screen already has the new answer's order
      const offscreen = "movies";
      assert.ok(!after.rows.some((r) => r.id === offscreen));
      const b = answerB(lib);
      const want = b.rows.find((r) => r.id === offscreen);
      if (want) {
        const got = await page.evaluate((id) => { const s = document.querySelector(`#app [data-row-id="${id}"] .row-scroller`); if (s && s._fillRow) s._fillRow(); return [...s.children].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]); }, offscreen);
        assert.deepEqual(got, want.items.map((x) => x.title), `${offscreen} (off screen) takes the new answer at once`);
      }

      // a later scroll: the shelves that were on screen take the new answer
      // once they have left it — so coming back shows the new data
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
      await page.waitForTimeout(700);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.waitForTimeout(500);
      const recsNow = await shelfTitles(page, "recs");
      const recsB = b.rows.find((r) => r.id === "recs").items.map((x) => x.title);
      if (focused) {
        // (the focused card stays where it was, the rest follow the new answer)
        assert.equal(recsNow[2], focused);
      } else {
        assert.deepEqual(recsNow.slice(0, 6), recsB.slice(0, 6), "after the scroll, the shelf shows the new order");
      }
      // the shelf the server dropped is gone now that it has been off screen
      assert.ok(!(await rowOrder(page)).includes("new-movies"), "the dropped shelf went once it was off screen");
    });
  }
}

ui.test("idle for a few seconds: the shelves on screen update in place — same rows, same slots, no shift", { allow: ALLOW }, async ({ page, signIn, freshProfile, goto, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  const st = await serveHome(page);
  await firstVisit(page, goto, st, lib, me);
  const g = await reloadHeld(page, st, lib);
  await page.waitForTimeout(300);
  const before = await onScreen(page);
  g.open();
  st.hold = null;
  await page.waitForFunction(() => document.querySelector("#app .screen").dataset.homeFresh === "pending");
  // nothing touched: after ~5 s the slots take the new order
  // (it may stay "pending" after that: a shelf the answer dropped is held
  // while it is on screen — here the third one, at the bottom edge)
  const t0 = Date.now();
  await page.waitForFunction(() => /^RECS Title 17\b/.test(document.querySelector('#app [data-row-id="recs"] .row-scroller > .card').getAttribute("aria-label") || ""), null, { timeout: 15000 });
  const waited = Date.now() - t0;
  assert.ok(waited > 3500, `the shelf on screen changed after ${waited} ms — "idle" is five seconds without a touch`);
  await page.waitForTimeout(600); // the cross-fade
  const after = await onScreen(page);
  assert.deepEqual(after.rows, before.rows, "no shelf on screen moved");
  // same slots (positions), new titles where the answer re-ranked them
  const slots = (v) => v.cards.filter((c) => c.row === "recs").map((c) => [c.i, c.x, c.y]);
  assert.deepEqual(slots(after), slots(before), "the slots did not move");
  const b = answerB(lib).rows.find((r) => r.id === "recs").items.map((x) => x.title);
  const shownNow = after.cards.filter((c) => c.row === "recs").map((c) => c.title);
  assert.deepEqual(shownNow, b.slice(0, shownNow.length), "the visible shelf now shows the new order, in place");
});

ui.test("leaving Home and coming back: the new answer, with its new shelf on top", { allow: ALLOW }, async ({ page, signIn, freshProfile, goto, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  const st = await serveHome(page);
  await firstVisit(page, goto, st, lib, me);
  const g = await reloadHeld(page, st, lib);
  g.open();
  st.hold = null;
  await page.waitForFunction(() => document.querySelector("#app .screen").dataset.homeFresh === "pending");
  assert.notEqual((await rowOrder(page))[0], "party");
  await goto("#/movies");
  await goto("#/");
  await page.waitForSelector('#app [data-row-id="party"] .card');
  assert.equal((await rowOrder(page))[0], "party", "away: the new shelf takes its place on top");
});

ui.test("another profile on the same browser never gets the first one's copy", { allow: ALLOW }, async ({ page, signIn, freshProfile, goto, lib }) => {
  const one = await freshProfile();
  const two = await freshProfile();
  await signIn(one);
  const st = await serveHome(page);
  await firstVisit(page, goto, st, lib, one);
  // the same browser, now the second profile, its Home answer held back
  const g = gate();
  st.hold = g.p;
  await page.evaluate((id) => localStorage.setItem("aurora-profile", id), two.id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .screen");
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.querySelectorAll("#app [data-row-id]").length), 0, "no shelves before the second profile's own answer");
  g.open();
  st.hold = null;
  await page.waitForSelector('#app [data-row-id="recs"] .card');
  assert.equal(await homeData(page, "homeSrc"), "network");
});

ui.test("a profile made a kids one since the copy was kept is not painted from it; nor is a copy over a day old", { allow: ALLOW }, async ({ page, signIn, freshProfile, goto, lib, api, srv }) => {
  const me = await freshProfile();
  await signIn(me);
  const st = await serveHome(page);
  await firstVisit(page, goto, st, lib, me);
  // over a day old
  await page.evaluate((pid) => {
    const k = `aurora-home-${pid}`;
    const v = JSON.parse(localStorage.getItem(k));
    v.at = Date.now() - 25 * 3600 * 1000;
    localStorage.setItem(k, JSON.stringify(v));
  }, me.id);
  let g = gate();
  st.hold = g.p;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .screen");
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.querySelectorAll("#app [data-row-id]").length), 0, "a day-old copy is not painted");
  g.open();
  st.hold = null;
  await page.waitForSelector('#app [data-row-id="recs"] .card');
  await page.waitForFunction((pid) => { const v = JSON.parse(localStorage.getItem(`aurora-home-${pid}`) || "null"); return v && Date.now() - v.at < 60000; }, me.id, { timeout: 10000 });
  if (!srv.kidsAvailable) return;
  // made a kids profile: its copy (kept as a grown-up's) must not be painted
  await api.adminPost(`/api/admin/profiles/${me.id}/kids`, { kids: { maxAge: 7 } });
  g = gate();
  st.hold = g.p;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .screen");
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.querySelectorAll("#app [data-row-id]").length), 0, "the grown-up copy is not painted for the kids profile");
  g.open();
  st.hold = null;
});

ui.run({ concurrency: 2 });
