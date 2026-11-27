// Admin → Server → Network for streaming (routes/nettune.js). On the test
// machine nothing can change: Windows says "Only a Linux server", Linux (CI)
// has no root helper installed, so the one setup line is shown with Copy and
// the BBR button waits for it. Real routes of the private instance.
const assert = require("node:assert/strict");
const { suite, openDetails, assertNoHorizontalOverflow, PHONE } = require("./helpers");

const ui = suite({});
const LINUX = process.platform === "linux";
const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.click('.tab[data-tab="server"]');
};

for (const [vp, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", PHONE]]) {
  ui.test(`${vp}: Network for streaming shows what is in force and how to turn on BBR`, { viewport, permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
    await enter(page, srv);
    await openDetails(page, "sv-net");
    if (!LINUX) {
      await page.waitForFunction(() => !document.getElementById("net-unsupported").classList.contains("hidden"), undefined, { timeout: 15000 });
      assert.match(await page.locator("#net-unsupported").textContent(), /Only a Linux server/);
      assert.ok(await page.locator("#net-body").isHidden());
    } else {
      await page.waitForFunction(() => document.getElementById("net-rows").children.length === 4, undefined, { timeout: 15000 });
      const rows = await page.locator("#net-rows").innerText();
      assert.match(rows, /Way of sending/);
      assert.match(rows, /Data sent twice/);
      assert.ok(await page.locator("#net-setup").isVisible(), "no helper on CI: the setup line shows");
      const cmd = await page.locator("#net-setup-cmd").textContent();
      assert.match(cmd, /^sudo install -o root -g root -m 0755 .*aurora-net-helper \/usr\/local\/sbin\/aurora-net-helper && /);
      assert.ok(await page.locator("#net-apply").isDisabled(), "BBR waits for the setup");
      await page.click("#net-setup-copy");
      await page.waitForFunction((c) => navigator.clipboard.readText().then((t) => t === c), cmd, { timeout: 15000 });
    }
    await assertNoHorizontalOverflow(page);
    await page.click('[data-copy-for="sv-net"]');
    await page.waitForFunction(() => navigator.clipboard.readText().then((t) => /congestion control|network for streaming/.test(t)), undefined, { timeout: 15000 });
  });
}

ui.test("the routes are the admin's only", {}, async ({ srv }) => {
  for (const [method, p] of [["GET", "/api/admin/net"], ["POST", "/api/admin/net/apply"], ["POST", "/api/admin/net/undo"]]) {
    const r = await fetch(`${srv.url}${p}`, { method });
    assert.ok([401, 403].includes(r.status), `${method} ${p}: ${r.status}`);
  }
});

ui.run();
