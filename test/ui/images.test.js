// Pictures: blur-up placeholders give way to the real poster (none is left
// blurred), and a poster that cannot be loaded becomes the titled tile.
const assert = require("node:assert/strict");
const { suite, PHONE } = require("./helpers");

const ui = suite();

// Every poster on the page, as the browser has it.
const posters = (page, scope = "#app") =>
  page.evaluate((scope) => [...document.querySelectorAll(`${scope} img.card-poster, ${scope} img.detail-poster`)].map((img) => ({
    src: img.getAttribute("src"),
    loaded: img.complete && img.naturalWidth > 0,
    in: img.classList.contains("img-in"),
    blurup: img.classList.contains("img-blurup"),
    placeholder: img.style.backgroundImage || "",
    filter: getComputedStyle(img).filter,
    opacity: getComputedStyle(img).opacity,
    shown: img.offsetParent !== null, // (a poster the layout hides at this size is not judged)
    cls: img.className,
  })).filter((p) => p.shown), scope);
// "Sharp": no blur left on it (a finished blur-up transition reads blur(0px)).
const blurPx = (filter) => { const m = /blur\(([\d.]+)px\)/.exec(filter || ""); return m ? Number(m[1]) : 0; };
// Every poster has arrived AND finished appearing: loaded, marked in, its
// placeholder taken off (half a second after the picture is in), no blur and
// full opacity once the fade has run. A poster that never gets there is the
// bug this file is for, and shows up as a timeout here.
const settled = async (page, n, where = "the page") => {
  // lazy pictures only load near the viewport: bring each one there first
  await page.waitForFunction((n) => document.querySelectorAll("#app img.card-poster, #app img.detail-poster").length >= n, n);
  for (const img of await page.locator("#app img.card-poster, #app img.detail-poster").all()) {
    if (await img.isVisible()) await img.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  }
  try {
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll("#app img.card-poster, #app img.detail-poster")].filter((i) => i.offsetParent !== null);
      return imgs.every((i) => {
        const cs = getComputedStyle(i);
        const blur = /blur\(([\d.]+)px\)/.exec(cs.filter || "");
        return i.complete && i.naturalWidth > 0 && i.classList.contains("img-in") && !i.style.backgroundImage &&
          (!blur || Number(blur[1]) === 0) && cs.opacity === "1";
      });
    }, null, { timeout: 8000 });
  } catch {
    const stuck = (await posters(page)).filter((p) => p.shown && !(p.loaded && p.in && !p.placeholder && blurPx(p.filter) === 0 && p.opacity === "1"));
    assert.fail(`${where}: ${stuck.length} poster(s) never finished appearing: ${JSON.stringify(stuck)}`);
  }
};
const assertSharp = (list, where, { min = 1 } = {}) => {
  assert.ok(list.length >= min, `${where}: ${list.length} poster(s) on show, expected at least ${min}`);
  for (const p of list) {
    assert.ok(p.loaded && p.in, `${where}: ${p.src} is not in its loaded state`);
    assert.equal(p.placeholder, "", `${where}: ${p.src} still shows its placeholder behind it`);
    assert.equal(blurPx(p.filter), 0, `${where}: ${p.src} is still blurred (${p.filter})`);
    assert.equal(p.opacity, "1", `${where}: ${p.src} is not fully faded in`);
  }
};

for (const [label, viewport] of [["desktop", undefined], ["phone", PHONE]]) {
  ui.test(`posters end sharp on Movies, Shows, Home and a title page (${label})`, viewport ? { viewport } : {}, async ({ page, goto, signIn, freshProfile, lib }) => {
    await signIn(await freshProfile());
    await goto("#/movies");
    await settled(page, 2, "Movies");
    assertSharp(await posters(page), "Movies");
    await goto("#/shows");
    await settled(page, 1, "Shows");
    assertSharp(await posters(page), "Shows");
    await goto(`#/movie/${lib.film2.id}`);
    await settled(page, 1, "the film's page");
    // (a phone's title page drops the poster: the backdrop is the picture there)
    assertSharp(await posters(page), "the film's page", { min: viewport ? 0 : 1 });
    await goto("#/");
    await page.waitForSelector("#app .card img.card-poster");
    await settled(page, 1, "Home");
    assertSharp(await posters(page), "Home");
  });
}

ui.test("while a poster is still coming, its slot shows the blurred placeholder; then the real one takes over", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  // hold Film One's poster back until the test lets it through
  const cover = lib.film1.cover; // "/img/<id>"
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route(`**${cover}*`, async (route) => { await gate; await route.continue(); });

  await goto("#/movies");
  const img = page.locator('.grid .card[aria-label^="Test Film One"] img.card-poster');
  await img.waitFor({ state: "attached" });
  const waiting = await img.evaluate((i) => ({
    blurup: i.classList.contains("img-blurup"), in: i.classList.contains("img-in"),
    placeholder: i.style.backgroundImage, loaded: i.complete && i.naturalWidth > 0,
  }));
  assert.equal(waiting.loaded, false);
  assert.equal(waiting.in, false, "the poster is marked loaded before it has arrived");
  assert.equal(waiting.blurup, true, "this poster came without a blur-up placeholder (the server sends them beside /api/library)");
  assert.match(waiting.placeholder, /^url\("data:image\//, "the slot is not showing the placeholder");

  release();
  await settled(page, 2);
  assertSharp((await posters(page)).filter((p) => p.src.startsWith(cover)), "Film One, once it arrived");
});

ui.test("a poster that cannot be loaded falls back to the tile with the title on it", {
  allow: [/Failed to load resource.*404.*\/img\//],
}, async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const cover = lib.film1.cover;
  let asked = 0;
  await page.route(`**${cover}*`, (route) => { asked++; route.fulfill({ status: 404, body: "" }); });

  await goto("#/movies");
  const card = page.locator('.grid .card[aria-label^="Test Film One"]');
  // (one retry after a second and a half, then the tile)
  const tile = card.locator(".card-fallback");
  await tile.waitFor({ timeout: 10000 });
  assert.equal(await tile.textContent(), "Test Film One");
  assert.equal(await card.locator("img.card-poster").count(), 0, "the broken <img> is still in the card");
  assert.ok(asked >= 2, `the poster was asked for ${asked} time(s): a transient failure deserves one retry`);

  // the card still works, and its neighbour is untouched
  await settled(page, 1);
  assertSharp((await posters(page)).filter((p) => !p.src.startsWith(cover)), "the other poster");
  await card.click();
  await page.waitForFunction((id) => location.hash === `#/movie/${id}`, lib.film1.id);
});

ui.run({ concurrency: 2 });
