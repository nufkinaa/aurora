// A title page's strip of round buttons on a phone says that it goes on
// (elia, 2026-11-10, his iPhone at 402 pt: five whole buttons ended flush
// with the screen's edge — "not clear enough that this has more elements and
// can be scrolled horizontally"). At every phone width the last tile in view
// is cut by the edge (about half of it shows), the side with more fades
// (.more-end / .more-start, js/edgefade.js), and a wide screen is untouched.
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();

const measure = (page) => page.evaluate(() => {
  const s = document.querySelector(".detail-actions-more");
  const r = s.getBoundingClientRect();
  const tiles = [...s.children].filter((c) => c.getClientRects().length).map((c) => c.getBoundingClientRect());
  const cut = tiles.find((t) => t.left < r.right - 1 && t.right > r.right + 1);
  return {
    vw: innerWidth, overflows: s.scrollWidth > s.clientWidth + 1, display: getComputedStyle(s).display,
    first: tiles[0] ? tiles[0].left : null, cutShown: cut ? (r.right - cut.left) / cut.width : null,
    cls: s.className,
  };
});

for (const width of [320, 360, 375, 390, 402, 430]) {
  ui.test(`phone ${width} px: half a tile is cut by the edge, and the strip fades on the side that has more`, { viewport: { width, height: 860 } }, async ({ page, goto, signIn, freshProfile, lib }) => {
    await signIn(await freshProfile());
    await goto(`#/show/${lib.show.id}`);
    await page.waitForSelector(".detail-actions-more");
    await page.waitForFunction(() => document.querySelector(".detail-actions-more").classList.contains("fade-strip"));
    const m = await measure(page);
    assert.ok(m.overflows, `${width}: the test show's seven buttons should run past the edge (${JSON.stringify(m)})`);
    assert.ok(m.cutShown != null, `${width}: the last tile in view ends flush with the edge (${JSON.stringify(m)})`);
    assert.ok(m.cutShown > 0.3 && m.cutShown < 0.7, `${width}: ${Math.round(m.cutShown * 100)}% of the cut tile shows, not about half`);
    assert.ok(m.first >= 4 && m.first <= 16, `${width}: the first tile starts at ${m.first}px, off the page's gutter`);
    await page.waitForFunction(() => document.querySelector(".detail-actions-more").classList.contains("more-end"));
    assert.ok(!/more-start/.test((await measure(page)).cls), "at the start nothing fades on the left");
    await page.evaluate(() => { const s = document.querySelector(".detail-actions-more"); s.scrollLeft = s.scrollWidth; });
    await page.waitForFunction(() => { const c = document.querySelector(".detail-actions-more").classList; return c.contains("more-start") && !c.contains("more-end"); });
  });
}

ui.test("a computer: the buttons are one row, nothing is cut and nothing fades", async ({ page, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto(`#/show/${lib.show.id}`);
  await page.waitForSelector(".detail-actions-more");
  await page.waitForTimeout(300);
  const m = await measure(page);
  assert.equal(m.display, "contents");
  assert.doesNotMatch(m.cls, /more-|fade-strip/);
});

ui.run({ concurrency: 3 });
