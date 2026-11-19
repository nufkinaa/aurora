// Continue Watching after real playback (cw-fix, 2026-11-19 — elia: "continue
// watching is full of bugs and very unreliable … only 1 episode of a series
// can be there"). Real files, the website's own player, then Home:
//   - an episode played to its end from its card: back on Home the series is
//     ONE card, the next episode — the row used to keep the played episode
//     beside its up next for good (the merge held the card the answer had
//     dropped, and the focused card was never redrawn);
//   - a title opened and left at once keeps its resume point (every
//     open-and-back walked it four seconds back);
//   - watched on another device meanwhile: the card shows that device's
//     spot (the server's row), not "new" with no bar;
//   - the ✕ and its Undo: the card comes back in its place, on the server too.
const assert = require("node:assert/strict");
const { suite, player, DESKTOP, PHONE } = require("./helpers");
const { IDS } = require("../../scripts/ui-test-server");

const ui = suite();

const CARDS = '[data-kind="continue"] .card';
const labels = (page) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((c) => (c.getAttribute("aria-label") || c.innerText).replace(/\s+/g, " ")), CARDS);
const serverRow = async (api, p) => {
  const h = await api.get(`/api/home?profile=${p.id}`, await api.as(p));
  const r = (h.rows || []).find((x) => x.id === "continue");
  return r ? r.items : [];
};
const save = async (api, p, id, position, duration) => {
  await new Promise((r) => setTimeout(r, 15)); // each save its own updatedAt
  return api.post(`/api/profiles/${p.id}/progress`, { itemId: id, position, duration }, await api.as(p));
};
// the row on screen settles on `want` (Home paints its kept copy first and
// merges the server's answer in)
const rowIs = (page, test, what, timeout = 15000) =>
  page.waitForFunction(({ sel, src }) => {
    const ls = [...document.querySelectorAll(sel)].map((c) => (c.getAttribute("aria-label") || c.innerText).replace(/\s+/g, " "));
    return new Function("ls", `return (${src})(ls)`)(ls);
  }, { sel: CARDS, src: test.toString() }, { timeout }).catch(async () => {
    throw new Error(`${what}: the row shows ${JSON.stringify(await labels(page))}`);
  });

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`${name}: an episode played to its end from its card — back on Home the series is one card, the next episode`, { viewport }, async ({ page, api, lib, signIn, freshProfile, goto }) => {
    const p = await freshProfile();
    await save(api, p, lib.film1.id, 20, 60);
    await save(api, p, lib.e1.id, 20, 45);
    await signIn(p);
    await goto("#/");
    await page.locator(CARDS).first().waitFor({ timeout: 20000 });
    assert.match((await labels(page))[0], /S1 E1/);
    await page.locator(CARDS).first().click();
    await page.waitForSelector(".player video", { timeout: 20000 });
    await player.playing(page, { min: 0.3 });
    // to the end of the episode
    await page.evaluate(() => { document.querySelector(".player video").currentTime = 43.5; });
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return !v || v.ended || v.currentTime > 44.2; }, null, { timeout: 15000 });
    await player.press(page, "Back");
    await page.waitForSelector(".player", { state: "detached", timeout: 15000 });
    if (!/^#\/?$/.test(await page.evaluate(() => location.hash))) await goto("#/");
    await page.locator(CARDS).first().waitFor({ timeout: 20000 });
    await rowIs(page, (ls) => ls.filter((l) => /Test Show/.test(l)).length === 1 && ls.some((l) => /S1 E2/.test(l)) && ls.length === 2, "one card for the series, E2");
    // …and it stays that way once the viewer has been idle (the merge's "idle" moment)
    await page.waitForTimeout(6000);
    const seen = await labels(page);
    assert.equal(seen.filter((l) => /Test Show/.test(l)).length, 1, JSON.stringify(seen));
    assert.ok(!seen.some((l) => /S1 E1/.test(l)), `E1 still drawn: ${JSON.stringify(seen)}`);
    const items = await serverRow(api, p);
    assert.deepEqual(items.map((i) => i.id), [lib.e2.id, lib.film1.id]);
    assert.equal(items[0].upNext, true);
    assert.equal(items[0].seriesKey, `s:${IDS.show}`);
  });
}

ui.test("a title opened and left at once keeps its resume point", async ({ page, api, lib, signIn, freshProfile, goto }) => {
  const p = await freshProfile();
  await save(api, p, lib.film1.id, 30, 60);
  await signIn(p);
  await goto("#/");
  await page.locator(CARDS).first().waitFor({ timeout: 20000 });
  for (let i = 0; i < 3; i++) {
    await page.evaluate((id) => { location.hash = `#/play/${id}`; }, lib.film1.id);
    await page.waitForSelector(".player video", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector(".player video").readyState >= 1, null, { timeout: 15000 });
    await page.evaluate(() => history.back());
    await page.waitForSelector(".player", { state: "detached", timeout: 15000 });
  }
  await page.waitForTimeout(1500); // (any save on its way)
  const st = await api.state(p);
  assert.equal(st.progress[lib.film1.id].position, 30, "three opens and backs, the resume point where it was (it walked 4 s back each time)");
});

ui.test("watched on another device meanwhile: the card shows that device's spot, and its press starts there", async ({ page, api, lib, signIn, freshProfile, goto }) => {
  const p = await freshProfile();
  await save(api, p, lib.e1.id, 20, 45);
  await signIn(p);
  await goto("#/");
  await page.locator(CARDS).first().waitFor({ timeout: 20000 });
  await goto("#/movies");
  // the TV finishes E1 and is 20 s into E2
  await save(api, p, lib.e1.id, 45, 45);
  await save(api, p, lib.e2.id, 20, 45);
  await goto("#/");
  await rowIs(page, (ls) => ls.length === 1 && /S1 E2/.test(ls[0]) && /min left/.test(ls[0]) && !/new/.test(ls[0]), "E2 with the TV's spot");
  await page.locator(CARDS).first().click();
  await page.waitForSelector(".player video", { timeout: 20000 });
  await player.playing(page, { min: 0.3 });
  const t = await page.evaluate(() => document.querySelector(".player video").currentTime);
  assert.ok(t >= 15 && t <= 22, `E2 started at ${t.toFixed(1)} s, not at the TV's 20 s (less the 4 s run-up)`);
});

ui.test("the ✕ and its Undo: the card comes back in its place, and stays there", async ({ page, api, lib, signIn, freshProfile, goto }) => {
  const p = await freshProfile();
  await save(api, p, lib.e2.id, 20, 45);
  await save(api, p, lib.film1.id, 20, 60); // newest: first
  await signIn(p);
  await goto("#/");
  const ep = page.locator(CARDS, { hasText: "S1 E2" });
  await ep.waitFor({ timeout: 20000 });
  await ep.hover();
  await ep.locator(".card-remove").click();
  await page.waitForFunction(() => /Removed from Continue Watching/.test(document.getElementById("toasts").innerText));
  assert.deepEqual((await serverRow(api, p)).map((i) => i.id), [lib.film1.id]);
  await page.locator("#toasts button", { hasText: "Undo" }).click();
  await rowIs(page, (ls) => ls.length === 2 && /Test Film One/.test(ls[0]) && /S1 E2/.test(ls[1]), "both cards, the film first");
  // the server agrees: the series is back, behind the film (it was first after an Undo before)
  for (let i = 0; i < 20; i++) {
    const ids = (await serverRow(api, p)).map((x) => x.id);
    if (ids.length === 2) { assert.deepEqual(ids, [lib.film1.id, lib.e2.id]); break; }
    await page.waitForTimeout(150);
    assert.ok(i < 19, "the Undo never reached the server");
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await rowIs(page, (ls) => ls.length === 2 && /Test Film One/.test(ls[0]) && /S1 E2/.test(ls[1]), "after a reload: both, in their places");
});

ui.run({ concurrency: 1 });
