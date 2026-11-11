// Continue Watching on Home (elia, 2026-11-11): one card per series — its
// newest episode, whether played from disk or streamed — and nothing the
// person has finished; up next steps over episodes already watched, and the
// ✕ on an episode card takes the whole series off. The rules are the
// server's (media/continuerow.js); this checks the row the website draws.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");
const { IDS } = require("../../scripts/ui-test-server");

const ui = suite();

const SHOTS = process.env.UI_SHOTS_DIR || null;
const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => { const r = document.querySelector('[data-kind="continue"]'); if (r) r.scrollIntoView({ block: "center" }); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const cards = (page) => page.locator('[data-kind="continue"] .card');
const labels = async (page) => (await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") || e.innerText))).map((s) => s.replace(/\s+/g, " "));
const home = async (api, profile) => {
  const h = await api.get(`/api/home?profile=${profile.id}`, await api.as(profile));
  const row = (h.rows || []).find((r) => r.id === "continue");
  return row ? row.items : [];
};
const save = async (api, profile, itemId, position, duration, item) =>
  api.post(`/api/profiles/${profile.id}/progress`, { itemId, position, duration, ...(item ? { item } : {}) }, await api.as(profile));
const tick = () => new Promise((r) => setTimeout(r, 15)); // each save its own updatedAt

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`${name}: finished film gone, finished episodes step over to the next unwatched one`, { viewport }, async ({ page, api, lib, signIn, freshProfile, goto }) => {
    const p = await freshProfile();
    // E2 finished, then E1 watched again to the end: up next is E3, not E2
    await save(api, p, lib.e2.id, 45, 45); await tick();
    await save(api, p, lib.e1.id, 45, 45); await tick();
    await save(api, p, lib.film1.id, 60, 60); await tick(); // finished film
    await save(api, p, lib.film2.id, 20, 60); // half-watched film, newest
    const items = await home(api, p);
    assert.deepEqual(items.map((i) => i.id), [lib.film2.id, lib.e3.id]);
    assert.equal(items[1].upNext, true);

    await signIn(p);
    await goto("#/");
    await page.locator('[data-kind="continue"] .card').first().waitFor({ timeout: 20000 });
    const seen = await labels(page);
    assert.equal(seen.length, 2, `two cards: ${JSON.stringify(seen)}`);
    assert.match(seen[0], /Test Film Two/);
    assert.match(seen[1], /S1 E3/);
    await shot(page, `${name}-finished-and-upnext`);
  });

  ui.test(`${name}: one card per series — half-watched E2 on disk, then a newer stream of S2 E1`, { viewport }, async ({ page, api, lib, signIn, freshProfile, goto }) => {
    const p = await freshProfile();
    await save(api, p, lib.e2.id, 20, 45); await tick();
    await save(api, p, lib.e3.id, 20, 45); await tick(); // newer: E3 wins over E2
    let items = await home(api, p);
    assert.deepEqual(items.map((i) => i.id), [lib.e3.id]);
    // a stream of an episode the library has not got, same show by IMDb id
    const meta = {
      id: "torrent|0123456789abcdef0123456789abcdef01234567|0",
      type: "movie",
      title: "Test Show · S2 E1",
      imdbId: IDS.show,
      season: 2,
      episode: 1,
      cover: lib.show.cover,
      duration: 2700,
      _isTorrent: true,
    };
    await save(api, p, meta.id, 600, 2700, meta);
    items = await home(api, p);
    assert.deepEqual(items.map((i) => i.id), [meta.id], "the stream is the show's newest: the only card");

    await signIn(p);
    await goto("#/");
    await page.locator('[data-kind="continue"] .card').first().waitFor({ timeout: 20000 });
    assert.equal(await cards(page).count(), 1);
    await shot(page, `${name}-one-card-per-series`);
  });
}

ui.test("the ✕ on an episode card takes the whole series off, and watching brings it back", { viewport: DESKTOP }, async ({ page, api, lib, signIn, freshProfile, goto }) => {
  const p = await freshProfile();
  await save(api, p, lib.e1.id, 20, 45); await tick();
  await save(api, p, lib.e2.id, 20, 45); await tick();
  await save(api, p, lib.film2.id, 20, 60);
  await signIn(p);
  await goto("#/");
  const ep = page.locator('[data-kind="continue"] .card', { hasText: "S1 E2" });
  await ep.waitFor({ timeout: 20000 });
  assert.equal(await cards(page).count(), 2);
  await ep.hover();
  await ep.locator(".card-remove").click();
  await page.waitForFunction(() => /Removed from Continue Watching/.test(document.getElementById("toasts").innerText));
  // on the server: E1 (older) does not take E2's place
  const after = await home(api, p);
  assert.deepEqual(after.map((i) => i.id), [lib.film2.id]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-kind="continue"] .card').first().waitFor({ timeout: 20000 });
  // (Home may paint its kept copy first and merge the new answer in)
  await page.waitForFunction(() => document.querySelectorAll('[data-kind="continue"] .card').length === 1, null, { timeout: 15000 });
  assert.doesNotMatch((await labels(page)).join(" | "), /S1 E1/);
  await shot(page, "desktop-after-remove");
  // watching something of the show again brings it back
  await save(api, p, lib.e3.id, 20, 45);
  assert.deepEqual((await home(api, p)).map((i) => i.id), [lib.e3.id, lib.film2.id]);
});

ui.run({ concurrency: 1 });
