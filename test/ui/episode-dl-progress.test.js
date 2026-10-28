// A show's episode list while episodes download (elia, 2026-10-28: "when you
// download an episode and go to browse the seasons, it keeps flashing every %
// the episode is advancing"). Each progress tick must change only that card's
// words and bar, in place: no card or picture rebuilt, no picture loaded
// again, the page and the phone's episode rail where they were, the focus
// where it was — with one and with several episodes downloading, on another
// season than the downloads', and with an episode's sources (the hold) open.
// When the download lands, the card turns into a "Play" card.
//
// The ticks are the server's own message (download_update), handed to the
// page's socket; the catalogue, the sources and the stills are answered here.
// Desktop and phone, both looks.
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE, IDS } = require("./helpers");

const ui = suite();

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const CAPS = "0123456789abcdef";
const eps = (season, n) => Array.from({ length: n }, (_, i) => ({
  season, episode: i + 1, title: `S${season} Episode ${i + 1}`, released: "2020-01-01T00:00:00.000Z",
  thumbnail: `/img/still-test/s${season}e${i + 1}.png`,
}));
const job = (episode, progress, o = {}) => ({
  id: `job-${episode}`, status: "downloading", phase: "downloading", progress, imdbId: IDS.show, type: "show",
  season: 1, episode, title: "Test Show", label: `Test Show · S1 E${episode}`, mine: true, ...o,
});

const stage = async (page, lib, jobs) => {
  // a browser that has been here before: its playback report's id is known
  // from the first read on, so the show is asked for at one address all along
  // (a first visit's id arrives later and changes the address, which hid a
  // stale answer when the episode landed)
  await page.route(/\/api\/caps(\?|$)/, (route) => route.fulfill({ json: { id: CAPS } }));
  await page.addInitScript((id) => { try { localStorage.setItem("aurora-caps-id", id); } catch {} }, CAPS);
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Real {
      constructor(...a) { super(...a); window.__sockets.push(this); }
    };
  });
  await page.route(/\/img\/still-test\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.route(`**/api/discover/meta/*/${IDS.show}`, (route) =>
    route.fulfill({ json: { type: "show", imdbId: IDS.show, title: "Test Show", year: 2020, genres: [], cast: [], trailers: [], seasons: [{ number: 1, episodes: eps(1, 10) }, { number: 2, episodes: eps(2, 6) }] } }));
  await page.route(/\/api\/torrents\/sources\?/, (route) =>
    route.fulfill({ json: { imdbId: IDS.show, streams: [
      { infoHash: "a".repeat(40), fileIdx: 0, name: "Test.Show.S01.1080p", title: "Test.Show.S01.1080p", quality: "1080p", sizeBytes: 2e9, sizeString: "2.0 GB", seeders: 25, provider: "test", recommended: true },
      { infoHash: "b".repeat(40), fileIdx: 0, name: "Test.Show.S01.720p", title: "Test.Show.S01.720p", quality: "720p", sizeBytes: 7e8, sizeString: "700 MB", seeders: 40, provider: "test" },
    ] } }));
  await page.route(/\/api\/downloads(\?|$)/, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: jobs }) : route.fulfill({ status: 400, json: { error: "not in this test" } }));
  // The show as the server tells it — with episode 5 on disk once it has landed.
  const landed = new Set();
  await page.route(new RegExp(`/api/item/${lib.show.id}(\\?|$)`), async (route) => {
    const res = await route.fetch();
    const item = await res.json();
    for (const n of landed) {
      const s1 = item.seasons.find((s) => Number(s.number) === 1);
      s1.episodes.push({ ...lib.e3, episode: n, title: `S1 Episode ${n}` });
    }
    route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(item) });
  });
  return landed;
};

const send = (page, j) => page.evaluate((job) => {
  const msg = { type: "download_update", job };
  for (const s of window.__sockets || []) if (s.readyState === 1) s.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(msg) }));
}, j);

// What the list did since `watch`: cards / pictures taken out or put in, and
// pictures (re)loaded. Every <img> also carries a mark, so a picture rebuilt
// with the same address is still seen as a new one.
const watch = (page) => page.evaluate(() => {
  const list = document.querySelector(".episode-list");
  const w = (window.__epWatch = { removed: 0, added: 0, loads: 0, imgs: [...list.querySelectorAll("img")] });
  w.imgs.forEach((img, i) => { img.__mark = i + 1; });
  const big = (n) => n.nodeType === 1 && (n.matches("img, .episode, .episode-wrap, .sources-empty") || n.querySelector("img, .episode"));
  w.mo = new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.removedNodes) if (big(n)) w.removed++;
      for (const n of r.addedNodes) if (big(n)) w.added++;
    }
  });
  w.mo.observe(list, { childList: true, subtree: true });
  w.onLoad = (e) => { if (e.target.tagName === "IMG") w.loads++; };
  list.addEventListener("load", w.onLoad, true);
  w.list = list;
});
const seen = (page) => page.evaluate(() => {
  const w = window.__epWatch;
  w.mo.takeRecords().forEach(() => {});
  const same = w.imgs.every((img) => img.isConnected && img.__mark);
  return { removed: w.removed, added: w.added, loads: w.loads, sameImgs: same, sameList: w.list.isConnected };
});
// The list is still: no picture has loaded for half a second (lazy ones come
// in as the page or the rail scrolls; a hidden one never does).
const settle = (page) => page.evaluate(() => new Promise((resolve) => {
  const list = document.querySelector(".episode-list");
  let t = null;
  const done = () => { list.removeEventListener("load", bump, true); resolve(); };
  const bump = () => { clearTimeout(t); t = setTimeout(done, 500); };
  list.addEventListener("load", bump, true);
  bump();
  setTimeout(done, 6000);
}));
const card = (page, ep) => page.locator(`.episode-list .episode[data-ep="${ep}"]`);
const words = (page, ep) => card(page, ep).locator(".episode-dl").innerText();
const width = (page, ep) => card(page, ep).locator(".episode-bar.dl > div").evaluate((d) => parseFloat(d.style.width));
const where = (page) => page.evaluate(() => {
  const list = document.querySelector(".episode-list");
  return { y: Math.round(window.scrollY), x: Math.round(list.scrollLeft), ep: document.activeElement && document.activeElement.dataset.ep };
});

for (const [name, viewport, look] of [["desktop", DESKTOP, "glass"], ["desktop classic", DESKTOP, "legacy"], ["phone", PHONE, "glass"], ["phone classic", PHONE, "legacy"]]) {
  ui.test(`${name}: download progress repaints the episode card in place — no rebuild, no picture reload, nothing moves; the landed episode turns into Play`, { viewport }, async ({ page, goto, signIn, freshProfile, api, lib }) => {
    const me = await freshProfile();
    if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
    const landed = await stage(page, lib, [job(5, 0.1), job(7, 0.2)]);
    await signIn(me);
    await goto(`#/show/${lib.show.id}`, { selector: '#app .screen .episode-list .episode[data-ep="1x10"]' });
    await page.waitForFunction(() => window.__sockets.some((s) => s.readyState === 1));
    // the two downloads are on their cards
    await page.waitForFunction(() => ["1x5", "1x7"].every((k) => document.querySelector(`.episode-list .episode[data-ep="${k}"]`)?.classList.contains("dl")));
    assert.equal(await words(page, "1x5"), " · Downloading 10%");
    // the page has settled (late metadata, the library's own answer) before anything is counted
    await settle(page);
    const phoneRail = await page.evaluate(() => getComputedStyle(document.querySelector(".episode-list")).flexDirection === "row");
    if (look === "glass" && viewport === PHONE) assert.ok(phoneRail, "the phone's glass look has its episode rail");

    // somewhere down the page / along the rail, the focus on a card, as a person would be
    await card(page, "1x6").evaluate((c) => c.scrollIntoView({ block: "center", inline: "center" }));
    await card(page, "1x6").focus();
    await settle(page);
    const before = await where(page);
    if (phoneRail) assert.ok(before.x > 0, "the rail did not scroll: the test would prove nothing about it");
    else assert.ok(before.y > 0, "the page did not scroll: the test would prove nothing about it");

    // ONE episode advancing, then SEVERAL
    await watch(page);
    for (let p = 11; p <= 20; p++) await send(page, job(5, p / 100));
    await page.waitForFunction(() => /Downloading 20%/.test(document.querySelector('.episode-list .episode[data-ep="1x5"] .episode-dl').textContent));
    for (let p = 21; p <= 30; p++) { await send(page, job(5, p / 100)); await send(page, job(7, (p + 10) / 100)); }
    await page.waitForFunction(() => /Downloading 40%/.test(document.querySelector('.episode-list .episode[data-ep="1x7"] .episode-dl').textContent));
    assert.equal(await words(page, "1x5"), " · Downloading 30%");
    assert.equal(await width(page, "1x5"), 30);
    assert.equal(await width(page, "1x7"), 40);
    // a download started somewhere else (the TV, another tab) shows on its card the same way
    await send(page, job(8, 0.05));
    await page.waitForFunction(() => /Downloading 5%/.test(document.querySelector('.episode-list .episode[data-ep="1x8"] .episode-dl')?.textContent || ""));
    assert.ok(await card(page, "1x8").evaluate((c) => c.classList.contains("dl")));
    assert.equal(await width(page, "1x8"), 5);
    let s = await seen(page);
    assert.deepEqual(s, { removed: 0, added: 0, loads: 0, sameImgs: true, sameList: true }, "progress ticks rebuilt the episode list");
    assert.deepEqual(await where(page), before, "the page, the rail or the focus moved");

    // the hold: an episode's sources open below — ticks leave the list (and the sources) be
    await card(page, "1x5").dispatchEvent("contextmenu");
    await page.locator(".sources-section .src-list > *").first().waitFor();
    await page.waitForTimeout(300);
    await watch(page);
    const srcRows = await page.evaluate(() => { const r = [...document.querySelectorAll(".sources-section .src-list > *")]; r.forEach((n) => { n.__mark = 1; }); return r.length; });
    for (let p = 31; p <= 40; p++) { await send(page, job(5, p / 100)); await send(page, job(7, (p + 10) / 100)); }
    await page.waitForFunction(() => /Downloading 40%/.test(document.querySelector('.episode-list .episode[data-ep="1x5"] .episode-dl').textContent));
    s = await seen(page);
    assert.deepEqual(s, { removed: 0, added: 0, loads: 0, sameImgs: true, sameList: true }, "with the sources open, progress ticks rebuilt the episode list");
    assert.ok(await page.evaluate((n) => { const r = [...document.querySelectorAll(".sources-section .src-list > *")]; return r.length === n && r.every((x) => x.__mark); }, srcRows), "the sources list was rebuilt by the ticks");

    // ANOTHER SEASON while they download: the ticks are for cards not on screen
    // — nothing at all happens to the list on screen (it was rebuilt every tick)
    await page.evaluate(() => {
      const pill = [...document.querySelectorAll(".season-pill")].find((p) => p.textContent.trim() === "Season 2");
      pill.click();
    });
    await page.waitForFunction(() => document.querySelector('.episode-list .episode[data-ep="2x6"]') && !document.querySelector('.episode-list .episode[data-ep="1x1"]'));
    await settle(page);
    await card(page, "2x4").evaluate((c) => c.scrollIntoView({ block: "center", inline: "center" }));
    await card(page, "2x4").focus();
    await settle(page);
    const onS2 = await where(page);
    await watch(page);
    for (let p = 41; p <= 60; p++) { await send(page, job(5, p / 100)); await send(page, job(7, (p + 10) / 100)); }
    await page.waitForTimeout(500);
    s = await seen(page);
    assert.deepEqual(s, { removed: 0, added: 0, loads: 0, sameImgs: true, sameList: true }, "on another season, the downloads' ticks rebuilt the list on screen");
    assert.deepEqual(await where(page), onS2, "on another season, the page, the rail or the focus moved");
    // back to season 1: the cards say where the downloads are now
    await page.evaluate(() => {
      const pill = [...document.querySelectorAll(".season-pill")].find((p) => p.textContent.trim() === "Season 1");
      pill.click();
    });
    await card(page, "1x5").locator(".episode-dl").waitFor({ state: "attached" });
    assert.equal(await words(page, "1x5"), " · Downloading 60%");
    assert.equal(await words(page, "1x7"), " · Downloading 70%");
    assert.equal(await width(page, "1x7"), 70);

    // it LANDS: the card is a Play card (on disk, plays the file), the bar is gone
    assert.ok(!(await card(page, "1x5").evaluate((c) => c.classList.contains("owned"))));
    landed.add(5);
    await send(page, job(5, 1, { status: "done", phase: null, libraryId: lib.e3.id, doneAt: new Date().toISOString() }));
    await page.waitForFunction(() => {
      const c = document.querySelector('.episode-list .episode[data-ep="1x5"]');
      return c && c.classList.contains("owned") && !c.classList.contains("dl") && !c.querySelector(".episode-dl") && /DOWNLOADED/.test(c.textContent);
    }, null, { timeout: 10000 });
    assert.equal(await words(page, "1x7"), " · Downloading 70%", "the other download lost its state");
    await card(page, "1x5").click();
    await page.waitForFunction((id) => location.hash === `#/play/${id}`, lib.e3.id);
  });
}

ui.run();
