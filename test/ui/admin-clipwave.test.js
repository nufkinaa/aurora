// Admin → Server → Clipwave access: make a key (shown once, copied with one
// press), see it listed by name and its first characters only, remove it —
// and the key works on /clipwave/v1 between the two (routes/clipwave.js).
// Real routes of the private instance; nothing is stubbed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, openDetails, assertNoHorizontalOverflow, PHONE } = require("./helpers");

const ui = suite({});
const SHOTS = process.env.CLIPWAVE_SHOTS || path.join(os.tmpdir(), "aurora-agents", "clipwave", "shots");
const shot = async (page, name, el = null) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (el ? page.locator(el) : page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.click('.tab[data-tab="server"]');
};

for (const [vp, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", PHONE]]) {
  ui.test(`${vp}: Clipwave access makes a key shown once, lists it, and removes it`, { viewport, permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
    await enter(page, srv);
    await openDetails(page, "sv-clipwave");
    await page.waitForFunction(() => document.getElementById("cw-url").textContent.endsWith("/clipwave"));
    assert.equal(await page.locator("#cw-url").textContent(), `${srv.url}/clipwave`);
    assert.match(await page.locator("#cw-https").textContent(), /https/, "an http address is called out");
    assert.ok(await page.locator("#cw-empty").isVisible());

    await page.fill("#cw-name", `Laptop ${vp}`);
    await page.click("#cw-create");
    await page.waitForSelector("#cw-new:not(.hidden)");
    const key = (await page.locator("#cw-new-key").textContent()).trim();
    assert.match(key, /^cw_[A-Za-z0-9_-]{40,}$/);
    await page.waitForFunction((n) => document.getElementById("cw-rows").innerText.includes(n), `Laptop ${vp}`);
    const row = await page.locator("#cw-rows tr").first().innerText();
    assert.ok(row.includes(key.slice(0, 7)) && !row.includes(key), "the list shows only the start of the key");
    assert.match(row, /never/);
    await assertNoHorizontalOverflow(page);
    await shot(page, `admin-clipwave-${vp}`, 'details[data-more="sv-clipwave"]');

    await page.click("#cw-new-copy");
    await page.waitForFunction((k) => navigator.clipboard.readText().then((t) => t === k), key);
    // Copy for Claude: the names and dates, never the key
    await page.click('[data-copy-for="sv-clipwave"]');
    await page.waitForFunction((n) => navigator.clipboard.readText().then((t) => t.includes(n)), `Laptop ${vp}`);
    const md = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(!md.includes(key) && md.includes(key.slice(0, 7)), md);

    // the key opens the API…
    const ping = await fetch(`${srv.url}/clipwave/v1/ping`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(ping.status, 200);
    // …and the list says it was used once the section reloads
    await openDetails(page, "sv-clipwave");
    await page.evaluate(() => { const d = document.querySelector('details[data-more="sv-clipwave"]'); d.open = false; d.open = true; });
    await page.waitForFunction(() => !/never/.test(document.querySelector("#cw-rows tr").innerText));

    await page.click("#cw-rows [data-cw-remove]");
    await page.click("dialog.ask .ask-yes");
    await page.waitForSelector("#cw-empty:not(.hidden)");
    assert.ok(await page.locator("#cw-new").isHidden(), "the shown key goes away with it");
    const after = await fetch(`${srv.url}/clipwave/v1/ping`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(after.status, 401);
  });
}
ui.run({ concurrency: 1 });
