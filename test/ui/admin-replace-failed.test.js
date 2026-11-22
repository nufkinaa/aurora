// Admin → Inbox → Problem reports: a "Get another version" that FAILED says
// why on the report itself, and in its Copy for Claude (Haven S3E7, Dor
// 2026-11-21: the report read "another version: failed" and nothing else —
// the reason was only under Details → Replaced copies).
//
// The page is handed a made-up report and replacements list; everything else
// is the private instance's.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, openDetails, assertNoHorizontalOverflow, PHONE } = require("./helpers");

const ui = suite({});
const SHOTS = process.env.REPLACE_SHOTS || path.join(os.tmpdir(), "aurora-agents", "replace-fix", "shots");
const shot = async (page, name, el = null) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (el ? page.locator(el) : page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const WHY = "the finished file went missing before it could take the old copy's place";
const REPORT = {
  id: "rep000000001", at: Date.now() - 3600e3, profile: "Tester", status: "open", kind: "replace",
  text: "Problem with this copy: Bad sound\nGetting another version: Test Show 2010 Season 3 Complete BDRip 720p x264 (720p · 0.7 GB)\nReplacing: Тайны / Test Show [S01-05] WEB-DLRip",
  context: { route: "tv:Player", title: "Test Show · S3 E7", itemId: "257285b14aae", version: "1.15.40" },
  replace: { id: "rpl000000001", reason: "sound", libraryId: "257285b14aae", status: "failed", error: WHY, endedAt: Date.now() - 60e3 },
};
const OK_REPORT = { ...REPORT, id: "rep000000002", text: "Problem with this copy: Wrong language", replace: { id: "rpl000000002", reason: "language", libraryId: "257285b14aae", status: "done", error: null } };
const REPLACED = [{
  id: "rpl000000001", at: Date.now() - 3600e3, byName: "Tester", display: "Test Show · S3 E7", reason: "sound", reasonLabel: "Bad sound",
  old: { release: "Тайны / Test Show [S01-05] WEB-DLRip" }, new: { release: "Test Show 2010 Season 3 Complete BDRip 720p x264", quality: "720p" },
  status: "failed", error: WHY, progress: 0,
}];
const stub = async (page) => {
  await page.route((u) => u.pathname === "/api/admin/reports", (route) => route.fulfill({ json: { reports: [REPORT, OK_REPORT] } }));
  await page.route((u) => u.pathname === "/api/admin/replacements", (route) => route.fulfill({ json: { replacements: REPLACED } }));
};
const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.click('.tab[data-tab="moderation"]');
  await page.waitForSelector("#reports tr");
};

for (const [vp, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", PHONE]]) {
  ui.test(`${vp}: a failed replacement's report says why it failed; one that landed says only "done"`, { viewport, permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
    await stub(page);
    await enter(page, srv);
    const rows = page.locator("#reports tr");
    const failed = await rows.nth(0).innerText();
    assert.match(failed, /another version: failed/);
    assert.ok(failed.includes(WHY), failed);
    const done = await rows.nth(1).innerText();
    assert.match(done, /another version: done/);
    assert.ok(!done.includes(WHY));
    await assertNoHorizontalOverflow(page);
    await shot(page, `admin-report-failed-${vp}`, "#pane-moderation > section:first-of-type");
    // the report's own Copy for Claude carries it too
    await rows.nth(0).locator("[data-report-copy]").click();
    await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.length > 0));
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(text.includes(`another version: failed (${WHY})`), text);
    // …and Replaced copies still has it, as before
    await openDetails(page, "in-replaced");
    await page.waitForFunction((why) => document.getElementById("replacements").innerText.includes(why), WHY);
  });
}
ui.run({ concurrency: 1 });
