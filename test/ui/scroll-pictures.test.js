// The pictures further down the page, before the scroll gets there (warm.js):
// on a desktop, once the pictures on screen are in, the posters of the
// shelves below are asked for a few at a time, and a mouse resting on a
// shelf builds the rest of it — so a brisk scroll meets pictures, not tiles
// sharpening one after the other. Not on a phone, and not under Data saver.
// And a picture comes into focus only when it lands in front of the person;
// once it has, nothing of the effect is left on it.
// (tools/webperf/scrollview.js measures the gain; docs/web-scroll-pictures.md.)
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite();

// Made-up titles warm their pages on hover/focus (prefetch.js): those reads
// are refused by the private server, and that is fine here.
const ALLOW = [/Failed to load resource.*\/api\/(item|discover|library\/for)\b/, /Failed to load resource.*404/];

// A tiny real PNG, so a test picture "arrives" like any poster.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// Home as ten shelves of thirty made-up titles, every one with a picture of
// its own (so "has this one been asked for?" has one answer).
const ROWS = ["recs", "because", "new-movies", "trending", "upcoming", "genre-drama", "genre-comedy", "genre-crime", "genre-action", "movies"];
const PER_ROW = 30;
const LAST = ROWS[ROWS.length - 1];
const home = (lib) => ({
  hero: [lib.film1, lib.film2].map((x) => ({ id: x.id, type: "movie", title: x.title, year: x.year, cover: x.cover, backdrop: x.backdrop || null })),
  rows: ROWS.map((id) => ({
    id,
    title: `Shelf ${id}`,
    items: Array.from({ length: PER_ROW }, (_, i) => ({ id: `fake-${id}-${i}`, type: "movie", title: `${id.toUpperCase()} Title ${i}`, year: 2001 + (i % 20), cover: `/img/warm-${id}-${i}` })),
  })),
});
const openHome = async ({ page, goto, signIn, freshProfile, lib }, { saver = false } = {}) => {
  await signIn(await freshProfile());
  if (saver) await page.addInitScript(() => { try { localStorage.setItem("aurora-data-mode", "saver"); } catch {} });
  const asked = [];
  await page.route("**/img/warm-*", async (route) => {
    asked.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  await page.route(/\/api\/home\?/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(home(lib)) }));
  await goto("#/");
  await page.waitForSelector(`#app [data-row-id="${LAST}"] .card`, { state: "attached" });
  return asked;
};
// One shelf, as the browser has it.
const shelf = (page, id) => page.evaluate((id) => {
  const s = document.querySelector(`#app [data-row-id="${id}"] .row-scroller`);
  const imgs = [...s.querySelectorAll("img")];
  const done = (i) => i.complete && i.naturalWidth > 0;
  return {
    cards: s.children.length,
    imgs: imgs.length,
    done: imgs.filter(done).length,
    lazy: imgs.filter((i) => i.loading === "lazy").length,
    // arrived out of sight: set to be simply there when scrolled to
    quiet: imgs.filter((i) => done(i) && i.classList.contains("img-in") && i.classList.contains("img-now")).length,
    tailDone: imgs.slice(-5).filter(done).length,
    top: Math.round(s.getBoundingClientRect().top),
    y: Math.round(window.scrollY || document.body.scrollTop || 0),
    vh: innerHeight,
  };
}, id);
// (the shelf is brought on screen first: under the billboard, Home's first
// shelf starts below a 720 px window)
const restOn = async (page, id) => {
  await page.evaluate((id) => document.querySelector(`#app [data-row-id="${id}"]`).scrollIntoView({ block: "center", behavior: "instant" }), id);
  await page.waitForTimeout(150);
  const box = await page.locator(`#app [data-row-id="${id}"] .row-scroller`).boundingBox();
  await page.mouse.move(box.x + 300, box.y + box.height / 2 - 30);
  await page.mouse.move(box.x + 320, box.y + box.height / 2);
};

ui.test("desktop: the shelves below the screen get their pictures before any scroll, and a mouse resting on a shelf builds the rest of it", { viewport: DESKTOP, allow: ALLOW }, async (h) => {
  const { page } = h;
  const asked = await openHome(h);
  const first = await shelf(page, LAST);
  assert.ok(first.top > first.vh * 2, `the last shelf is not far below the screen (top ${first.top})`);
  assert.ok(first.cards < PER_ROW, `the last shelf was built whole (${first.cards} cards)`);
  // nothing scrolled, nothing touched: its posters arrive all the same
  await page.waitForFunction((id) => {
    const imgs = [...document.querySelectorAll(`#app [data-row-id="${id}"] .row-scroller img`)];
    return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0 && i.classList.contains("img-in"));
  }, LAST, { timeout: 15000 });
  const far = await shelf(page, LAST);
  assert.equal(far.y, 0, "the page was scrolled");
  assert.equal(far.done, far.imgs);
  assert.equal(far.quiet, far.imgs, "a picture that arrived out of sight is set to fade in when it is scrolled to");
  assert.ok(asked.some((p) => p === `/img/warm-${LAST}-0`), "the last shelf's first poster was never requested");
  // (what is not built is not asked for)
  assert.ok(!asked.some((p) => p === `/img/warm-${LAST}-${PER_ROW - 1}`), "a card that was never built had its picture requested");

  // a mouse comes to rest on the first shelf: the rest of it is built, and
  // its pictures are there before the shelf is paged
  const top = ROWS[0];
  const before = await shelf(page, top);
  assert.ok(before.cards < PER_ROW);
  await restOn(page, top);
  await page.waitForFunction(([id, n]) => document.querySelector(`#app [data-row-id="${id}"] .row-scroller`).children.length === n, [top, PER_ROW], { timeout: 5000 });
  await page.waitForFunction((id) => {
    const imgs = [...document.querySelectorAll(`#app [data-row-id="${id}"] .row-scroller img`)];
    return imgs.slice(-5).every((i) => i.complete && i.naturalWidth > 0);
  }, top, { timeout: 15000 });
  const after = await page.evaluate((id) => {
    const s = document.querySelector(`#app [data-row-id="${id}"] .row-scroller`);
    const last = s.lastElementChild.getBoundingClientRect();
    return { left: Math.round(s.scrollLeft), lastLeft: Math.round(last.left), vw: innerWidth };
  }, top);
  assert.equal(after.left, 0, "the shelf was paged");
  assert.ok(after.lastLeft > after.vw, "the shelf's last card is on screen: this proves nothing");
  assert.ok(asked.includes(`/img/warm-${top}-${PER_ROW - 1}`), "the shelf's last poster was never requested");
});

ui.test("desktop: shelves wheeled past under a pointer standing still are not built — the one it comes to rest on is", { viewport: DESKTOP, allow: ALLOW }, async (h) => {
  const { page } = h;
  await openHome(h);
  // every shelf that gets the rest of its cards says when: how long after
  // the page last moved, and whether the pointer was on it
  await page.evaluate(() => {
    window.__built = [];
    let moved = -1e9;
    window.addEventListener("scroll", () => { moved = performance.now(); }, { capture: true, passive: true });
    for (const s of document.querySelectorAll("#app [data-row-id] .row-scroller")) {
      let n = s.children.length;
      const shelf = s.closest("[data-row-id]");
      new MutationObserver(() => {
        if (s.children.length <= n) return;
        n = s.children.length;
        window.__built.push({ id: shelf.dataset.rowId, rest: Math.round(performance.now() - moved), hover: shelf.matches(":hover") });
      }).observe(s, { childList: true });
    }
  });
  const now = () => page.evaluate((ids) => ({
    cards: ids.map((id) => document.querySelector(`#app [data-row-id="${id}"] .row-scroller`).children.length),
    y: Math.round(window.scrollY || document.body.scrollTop || 0),
    under: ((document.elementFromPoint(640, 400) || document.body).closest("[data-row-id]") || { dataset: {} }).dataset.rowId || null,
    built: window.__built,
  }), ROWS);
  const before = await now();
  assert.ok(before.cards.every((n) => n < PER_ROW), `a shelf was built whole at the start (${before.cards})`);
  await page.mouse.move(620, 380);
  await page.mouse.move(640, 400);
  // a steady hand on the wheel: every shelf is under the pointer for a
  // quarter of a second on its way up — longer than a rest
  for (let i = 0; i < 26; i++) { await page.waitForTimeout(80); await page.mouse.wheel(0, 100); }
  // the wheel stops: the shelf under the pointer now is the one being looked at
  await page.waitForTimeout(1200);
  const after = await now();
  assert.ok(after.y > 1800, `the page was not scrolled (${after.y})`);
  assert.ok(after.under, "the pointer came to rest between shelves: this proves nothing");
  assert.equal(after.cards[ROWS.indexOf(after.under)], PER_ROW, `the shelf the pointer rests on (${after.under}) was not built`);
  // (a busy machine may pause the wheel for a moment — that is a rest too;
  // what must never happen is cards being built while the page moves)
  for (const b of after.built) {
    assert.ok(b.rest >= 190, `shelf ${b.id} was built ${b.rest} ms after the page last moved`);
    assert.equal(b.hover, true, `shelf ${b.id} was built though the pointer was not on it`);
  }
});

for (const [name, viewport, saver] of [["desktop under Data saver", DESKTOP, true], ["phone", PHONE, false]]) {
  ui.test(`${name}: nothing is asked for ahead, and a shelf is built only when it is paged`, { viewport, allow: ALLOW }, async (h) => {
    const { page } = h;
    const asked = await openHome(h, { saver });
    // the pictures on screen are in
    await page.waitForFunction((id) => {
      const imgs = [...document.querySelectorAll(`#app [data-row-id="${id}"] .row-scroller img`)];
      return imgs.some((i) => i.complete && i.naturalWidth > 0);
    }, ROWS[0], { timeout: 15000 });
    await page.waitForTimeout(2000);
    await restOn(page, ROWS[0]);
    await page.waitForTimeout(800);
    const far = await shelf(page, LAST);
    assert.ok(far.top > far.vh * 2, `the last shelf is not far below the screen (top ${far.top})`);
    assert.equal(far.done, 0, "posters far below the screen arrived before the scroll reached them");
    assert.equal(far.lazy, far.imgs, "posters far below the screen were taken off the browser's lazy-load");
    assert.deepEqual(asked.filter((p) => p.startsWith(`/img/warm-${LAST}-`)), [], "posters far below the screen were requested");
    const top = await shelf(page, ROWS[0]);
    assert.ok(top.cards < PER_ROW, `a pointer on the shelf built the rest of it (${top.cards} cards)`);
    // …and paging it still does, as before
    await page.evaluate((id) => { document.querySelector(`#app [data-row-id="${id}"] .row-scroller`).scrollLeft = 200; }, ROWS[0]);
    await page.waitForFunction(([id, n]) => document.querySelector(`#app [data-row-id="${id}"] .row-scroller`).children.length === n, [ROWS[0], PER_ROW], { timeout: 5000 });
  });
}

ui.test("a picture that lands in front of the person comes into focus, and nothing of the effect is left on it afterwards", { viewport: DESKTOP }, async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const cover = lib.film1.cover;
  const img = page.locator('.grid .card[aria-label^="Test Film One"] img.card-poster');
  // (the server makes a poster's blurred placeholder the first time it is
  // asked about: open Movies until the answer carries it)
  await goto("#/movies");
  for (let i = 0; i < 20; i++) {
    await img.waitFor({ state: "attached" });
    if (await img.evaluate((el) => el.classList.contains("img-blurup"))) break;
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  // hold Film One's poster back until the test lets it through
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route(`**${cover}*`, async (route) => { await gate; await route.continue(); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await img.waitFor({ state: "attached" });
  assert.equal(await img.evaluate((el) => el.classList.contains("img-blurup") && !el.classList.contains("img-in")), true, "the poster did not come with its placeholder, still waiting");
  await page.waitForTimeout(400); // (well past "it was there at once")
  await img.evaluate((i) => {
    window.__seen = { names: [] };
    i.addEventListener("animationstart", (e) => window.__seen.names.push(e.animationName));
  });
  release();
  await page.waitForFunction((i) => i.classList.contains("img-in"), await img.elementHandle());
  const landed = await img.evaluate((i) => ({ now: i.classList.contains("img-now"), look: document.documentElement.dataset.look || "" }));
  assert.equal(landed.now, false, "a poster that arrived late, in view, was shown without coming into focus");
  // the effect runs, ends, and leaves nothing behind: no animation still
  // holding a filter (which kept every poster on a layer of its own)
  await page.waitForFunction((i) => {
    const cs = getComputedStyle(i);
    return i.getAnimations().length === 0 && cs.opacity === "1" && !i.style.backgroundImage;
  }, await img.elementHandle(), { timeout: 8000 });
  const end = await img.evaluate((i) => ({ filter: getComputedStyle(i).filter, names: window.__seen.names, late: i.classList.contains("img-late"), isolation: getComputedStyle(i).isolation }));
  assert.equal(end.filter, "none", `a filter is left on a poster that has finished appearing (${end.filter})`);
  // (what the held filter also did — the poster painted over its card's
  // hairline — is kept, by name: glass.css `img-late`)
  assert.equal(end.late, true, "a poster that arrived late is not marked as late");
  assert.equal(end.isolation, "isolate");
  assert.equal(landed.look, "glass");
  assert.deepEqual(end.names, ["blurup-in"], "the poster did not sharpen in");
});

ui.run({ concurrency: 2 });
