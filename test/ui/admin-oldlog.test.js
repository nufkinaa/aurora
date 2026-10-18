// An old log the keeper's rotation did not make (the live server has an
// 891 MB server-stdout.log.1 from before it) is never deleted by Aurora: the
// healer's data-growth check names it on the admin page, Server tab, with
// the exact command to delete it — and the file is still there afterwards.
// (A private instance; its own made-up admin password, never the real one.)
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { suite, PHONE, ARTIFACTS } = require("./helpers");

const OLD = "server-stdout.log.1";
const ui = suite({
  setup: async (srv) => {
    // 60 MB, sparse: only its size matters here
    const fd = fs.openSync(path.join(srv.dataDir, OLD), "w");
    fs.ftruncateSync(fd, 60 * 1024 * 1024);
    fs.closeSync(fd);
    await srv.api.adminPost("/api/admin/healer/run");
  },
});

const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};

for (const [name, viewport] of [["desktop", null], ["phone", PHONE]]) {
  ui.test(`${name}: an old log is named on the Server tab with how to delete it, and left alone`, viewport ? { viewport } : {}, async ({ page, srv }) => {
    await enter(page, srv);
    await page.click('.tab[data-tab="server"]');
    await page.waitForFunction(() => /An old log of 60(\.0)? MB in data\/ — you can delete it/.test(document.body.innerText), null, { timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /server-stdout\.log\.1 \(60(\.0)? MB\) is an old log/);
    assert.match(text, process.platform === "win32" ? /del ".*server-stdout\.log\.1"/ : /rm '.*server-stdout\.log\.1'/);
    const el = page.locator("text=/An old log of 60/").first();
    await el.scrollIntoViewIfNeeded();
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS, `admin-oldlog--${name}.png`) });
    assert.ok(fs.existsSync(path.join(srv.dataDir, OLD)), "the old log is still there");
  });
}

ui.run();
