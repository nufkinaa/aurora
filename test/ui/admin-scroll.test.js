// The admin scrolls with a mouse wheel on a PC (elia 2026-11-08: "scroll in
// admin pc does not work well"). html is overflow-x: clip, so body's own
// overflow-x (base.css: hidden) stayed on body instead of going to the window:
// body became a scroll box as tall as the page that never scrolled, its
// overscroll-behavior: none swallowed every wheel turn, and the sticky title
// row stuck to body, not the window. Real Chrome, real wheel events, every
// Details open so the screen is long.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { suite, openDetails, PHONE } = require("./helpers");

const SHOTS = path.join(__dirname, "artifacts", "admin-scroll");
const ui = suite();

const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const open = async (page, tab) => {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.waitForFunction((t) => document.getElementById(`pane-${t}`).classList.contains("active"), tab);
  const keys = await page.locator(`#pane-${tab} details.more`).evaluateAll((els) => els.filter((d) => d.checkVisibility()).map((d) => d.dataset.more));
  for (const k of keys) await openDetails(page, k);
  await page.waitForTimeout(300);
  await page.evaluate(() => scrollTo(0, 0));
};
const at = (page) => page.evaluate(() => {
  const head = document.querySelector(".page-head").getBoundingClientRect();
  const title = document.getElementById("page-title").getBoundingClientRect();
  const hit = document.elementFromPoint(title.left + 4, title.top + title.height / 2);
  return {
    y: scrollY, max: document.scrollingElement.scrollHeight - innerHeight,
    headTop: head.top, headH: head.height, headOnTop: !!hit && !!hit.closest(".page-head"),
  };
});
// wheel until the bottom (or until it stops moving), with the mouse at (x, y)
const wheelDown = async (page, x, y) => {
  await page.mouse.move(x, y);
  let s = await at(page);
  for (let still = 0, i = 0; i < 120 && s.y < s.max - 1 && still < 6; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(40);
    const n = await at(page);
    still = n.y === s.y ? still + 1 : 0;
    s = n;
  }
  return s;
};
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  const size = `${viewport.width}x${viewport.height}`;
  ui.test(`the mouse wheel scrolls the long admin screens to the bottom, the title row stays on top (${size})`, { viewport }, async ({ page, srv }) => {
    await enter(page, srv);
    for (const tab of ["server", "downloads", "analytics"]) {
      await open(page, tab);
      const start = await at(page);
      assert.ok(start.max > 200, `${tab}: long enough to scroll (${start.max} px)`);
      // over the cards in the middle of the main column
      const main = await page.locator("main.wrap").boundingBox();
      const end = await wheelDown(page, main.x + main.width / 2, viewport.height * 0.6);
      assert.ok(end.y >= end.max - 2, `${tab}: the wheel reached the bottom (scrollY ${end.y} of ${end.max})`);
      assert.ok(Math.abs(end.headTop) < 1 && end.headH > 30, `${tab}: the title row is stuck to the top (top ${end.headTop}, height ${end.headH})`);
      assert.ok(end.headOnTop, `${tab}: the title row is visible above the content`);
      await shot(page, `${tab}-bottom-${size}`);
    }
  });
}

ui.test("the wheel over the On disk catalog goes on to the page — the short catalog does not hold it", { viewport: { width: 1280, height: 720 } }, async ({ page, srv }) => {
  await enter(page, srv);
  await open(page, "downloads");
  // room below the catalog, so the page has somewhere to go
  await page.addStyleTag({ content: "main.wrap { padding-bottom: 1500px; }" });
  const tree = page.locator("#lib-tree");
  await tree.evaluate((el) => scrollTo(0, el.getBoundingClientRect().top + scrollY - 200));
  const box = await tree.boundingBox();
  const before = await at(page);
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height, 100) / 2);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(60); }
  const after = await at(page);
  assert.ok(after.y > before.y + 200, `the page scrolled under the wheel (${before.y} -> ${after.y})`);
});

ui.test("a phone still scrolls to the bottom with the title row on top", { viewport: PHONE }, async ({ page, srv }) => {
  await enter(page, srv);
  await open(page, "server");
  const end = await wheelDown(page, PHONE.width / 2, PHONE.height / 2);
  assert.ok(end.y >= end.max - 2, `the phone reached the bottom (scrollY ${end.y} of ${end.max})`);
  assert.ok(Math.abs(end.headTop) < 1 && end.headOnTop, `the title row is on top (top ${end.headTop})`);
  await shot(page, "server-bottom-phone");
});

ui.run({ concurrency: 1 });
