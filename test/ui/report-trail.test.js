// "Report a problem" carries what the viewer did before (docs/report-trail.md):
// the last steps, facts about the device, the player's state and the last
// requests — and never anything typed but the search that was run. The sheet
// says so, shows it under "See what will be sent", and the admin reads it as
// a timeline (and in Copy for Claude).
const assert = require("node:assert/strict");
const path = require("path");
const { suite, player, PHONE } = require("./helpers");

const ui = suite();
const shot = (page, name) => page.screenshot({ path: path.join(__dirname, "artifacts", `report-trail-${name}.png`) }).catch(() => {});
const SECRET = "hunter2Secret";
const TYPED = "my-private-words";

const openSheet = async (page) => {
  await page.evaluate(() => document.dispatchEvent(new Event("aurora-report")));
  await page.waitForSelector(".report-wrap .report");
};
const sent = async (srv, startsWith) => {
  const { reports } = await srv.api.adminGet("/api/admin/reports");
  return reports.find((x) => x.text.startsWith(startsWith));
};

ui.test("what the viewer did comes along: screens, presses, the search run — and nothing typed anywhere else", async ({ page, srv, signIn, freshProfile, goto, lib }) => {
  await signIn(await freshProfile());
  await goto(`#/movie/${lib.film1.id}`);
  // a press on a tagged control and on an untagged one
  await page.locator("[data-ui]").first().waitFor();
  // fields that must never be read: a password, a plain text box, a text area
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.id = "rt-fields";
    box.innerHTML = '<input type="password" id="rt-pw" aria-label="Password"><input type="text" id="rt-name" aria-label="Name"><textarea id="rt-msg" aria-label="Message"></textarea>';
    document.body.append(box);
  });
  await page.fill("#rt-pw", "");
  await page.click("#rt-pw");
  await page.keyboard.type(SECRET);
  await page.keyboard.press("Enter");
  await page.click("#rt-name");
  await page.keyboard.type(TYPED);
  await page.click("#rt-msg");
  await page.keyboard.type("dear diary");
  await page.evaluate(() => document.getElementById("rt-fields").remove());
  // the search the viewer runs is the one thing typed that goes
  await goto("#/search");
  await page.click('input[aria-label="Search"]');
  await page.keyboard.type("zebra crossing");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Escape").catch(() => {});

  await openSheet(page);
  const sheet = page.locator(".report-wrap .report");
  assert.match(await sheet.innerText(), /your last steps in the app and facts about this device come along by themselves — never anything you typed, except a search you ran\./);
  // the sheet is as quick as it was: one box and Send, the disclosure closed
  assert.equal(await page.locator(".report-peek").evaluate((d) => d.open), false);
  await page.locator(".report-peek > summary").click();
  await page.waitForFunction(() => /Last steps/.test(document.querySelector(".report-peek-text").textContent));
  const peek = await page.locator(".report-peek-text").textContent();
  assert.match(peek, /opened \/movie\/:id/);
  assert.match(peek, /searched “zebra crossing”/);
  assert.match(peek, /opened \/search/);
  assert.match(peek, /Device and app:/);
  assert.match(peek, /language: /);
  assert.match(peek, /Last requests:/);
  for (const bad of [SECRET, TYPED, "dear diary", "hunter2"]) assert.ok(!peek.includes(bad), `"${bad}" is not in what will be sent`);
  await shot(page, "sheet-desktop");

  await page.fill(".report-text", "the search found nothing");
  await page.fill(".report-doing", "looking for a film");
  await page.click('[data-ui="report.send"]');
  await page.waitForSelector(".report-wrap", { state: "detached" });
  const r = await sent(srv, "the search found nothing");
  assert.ok(r, "the report landed");
  const ctx = JSON.stringify(r.context);
  for (const bad of [SECRET, TYPED, "dear diary"]) assert.ok(!ctx.includes(bad), `"${bad}" never reaches the server: ${ctx.slice(0, 400)}`);
  // and not a single character of it as a key
  assert.ok(!r.context.trail.some((e) => e.k === "key" && e.key.length === 1), "no single character among the keys");
  assert.ok(r.context.trail.some((e) => e.k === "key" && e.key === "Enter"), "Enter is named");
  assert.ok(r.context.trail.some((e) => e.k === "search" && e.q === "zebra crossing"));
  assert.ok(r.context.trail.some((e) => e.k === "nav" && e.s === "/movie/:id" && e.id === lib.film1.id));
  assert.ok(r.context.trail.some((e) => e.k === "sheet" && /Report a problem/.test(e.s) && e.on === true));
  assert.equal(r.context.env.app, "web");
  assert.ok(r.context.env.tz && r.context.env.screen && r.context.env.server === srv.url);
  assert.ok(Array.isArray(r.context.reqs) && r.context.reqs.length > 0);
  assert.ok(r.context.reqs.every((q) => !q.p.includes("?")), "no query strings");
  assert.ok(r.context.srv && r.context.srv.v, "the server's side is attached");
  // what was shown is what was sent
  assert.equal(r.context.trail.length >= 5, true);
});

ui.test("a report from inside the player, in full screen: its seeks, waits and state come along", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id, { min: 1 });
  // full screen, as a viewer does it (a key press is a gesture)
  await player.wake(page);
  await page.evaluate(() => document.querySelector(".player").requestFullscreen().catch(() => {}));
  await page.waitForFunction(() => !!document.fullscreenElement).catch(() => {});
  await page.evaluate(() => { const v = document.querySelector(".player video"); v.currentTime = Math.min(v.duration - 5, 20); });
  await player.playing(page, { min: 20 });
  await player.press(page, "Settings");
  await page.locator(".player .menu .menu-item", { hasText: "Report a problem" }).click();
  await page.waitForSelector(".report-wrap .report");
  const inFs = await page.evaluate(() => !!document.fullscreenElement && document.fullscreenElement.contains(document.querySelector(".report-wrap")));
  await page.locator(".report-peek > summary").click();
  await page.waitForFunction(() => /The player at the time:/.test(document.querySelector(".report-peek-text").textContent));
  const peek = await page.locator(".report-peek-text").textContent();
  assert.match(peek, /seek \d+:\d\d → 0:2\d/);
  assert.match(peek, /title id: /);
  assert.match(peek, /buffered ahead: /);
  await shot(page, "sheet-player");
  await page.fill(".report-text", "picture froze in the player");
  await page.click('[data-ui="report.send"]');
  await page.waitForSelector(".report-wrap", { state: "detached" });
  const r = await sent(srv, "picture froze in the player");
  assert.ok(r);
  const seek = r.context.trail.find((e) => e.k === "play" && e.e === "seek");
  assert.ok(seek && seek.to >= 19, `the seek: ${JSON.stringify(r.context.trail.filter((e) => e.k === "play"))}`);
  assert.ok(r.context.trail.some((e) => e.k === "play" && e.e === "mark" && e.mk === "path"), "the path the player took");
  assert.ok(r.context.trail.some((e) => e.k === "app" && e.e === "fullscreen-on") || !inFs, "full screen is a step");
  assert.equal(r.context.player.id, lib.film1.id);
  assert.ok(r.context.player.pos >= 19);
  assert.ok(["jit", "ladder", "direct", "transcode"].includes(r.context.player.path));
  assert.equal(r.context.itemId, lib.film1.id);
});

ui.test("phone: the sheet keeps its one box and Send; the disclosure scrolls inside itself", { viewport: PHONE }, async ({ page, signIn, freshProfile, goto }) => {
  await signIn(await freshProfile());
  await goto("#/movies");
  await openSheet(page);
  await page.locator(".report-peek > summary").click();
  await page.waitForFunction(() => /Last steps/.test(document.querySelector(".report-peek-text").textContent));
  const box = await page.locator(".report-peek-text").boundingBox();
  const vw = PHONE.width;
  assert.ok(box.x >= 0 && box.x + box.width <= vw, "inside the screen");
  assert.ok(box.height <= 320.5, `no taller than its cap: ${box.height}`);
  // the card stays on the screen and scrolls inside itself: Send is a scroll away, never lost
  const card = await page.locator(".look-notice.report").boundingBox();
  assert.ok(card.y >= 0 && card.y + card.height <= PHONE.height + 1, `the card fits the screen: ${JSON.stringify(card)}`);
  await page.locator('[data-ui="report.send"]').scrollIntoViewIfNeeded();
  const send = await page.locator('[data-ui="report.send"]').boundingBox();
  assert.ok(send && send.y >= 0 && send.y + send.height <= PHONE.height + 1, "Send can be reached");
  await shot(page, "sheet-phone");
});

ui.test("the admin: the steps as a timeline (escaped, the bad ones marked), the facts as tables, and Copy for Claude carries them", { permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
  // a hostile client's report, straight to the server
  const res = await fetch(`${srv.url}/api/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "trail for the admin",
      profile: "nobody",
      context: {
        route: "#/movie/abc",
        trail: [
          { t: 64000, k: "nav", s: "/movie/:id", id: "abc" },
          { t: 60000, k: "tap", ui: "detail.play" },
          { t: 50000, k: "toast", m: "<img src=x onerror=window.__pwned=1>" },
          { t: 40000, k: "req", m: "GET", p: "/api/item/abc", s: 500, ms: 3100 },
          { t: 30000, k: "play", e: "stall", ms: 4200, at: 612 },
          { t: 1000, k: "tap", ui: "report.send" },
          { t: 500, k: "bogus", m: "dropped" },
        ],
        env: { app: "web", v: "1.15.27", screen: "1920×1080 @1x", tz: "Asia/Jerusalem" },
        player: { id: "abc", pos: 612, path: "jit", ahead: 0 },
        reqs: [{ t: 40000, m: "GET", p: "/api/item/abc", s: 500, ms: 3100 }],
      },
    }),
  });
  assert.equal(res.status, 200);
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.click('.tab[data-tab="moderation"]');
  const row = page.locator("#reports tr", { hasText: "trail for the admin" });
  await row.waitFor();
  await row.locator("details.report-trail > summary").click();
  const steps = row.locator("details.report-trail li");
  await steps.first().waitFor();
  const lines = await steps.allInnerTexts();
  assert.deepEqual(lines.map((l) => l.replace(/\s+/g, " ").trim().replace(/^(−\d+:\d\d) ?/, "$1 ")), [
    "−1:04 opened /movie/:id (abc)",
    "−1:00 pressed detail.play",
    "−0:50 was shown: “‹img src=x onerror=window.__pwned=1›”",
    "−0:40 GET /api/item/abc → 500 in 3.1 s",
    "−0:30 stalled 4.2 s at 10:12",
    "−0:01 pressed report.send",
  ]);
  assert.equal(await page.evaluate(() => window.__pwned), undefined, "no markup ran");
  assert.match(await row.locator("details.report-trail > summary").innerText(), /6 steps · 2 flagged/);
  const red = await steps.nth(3).evaluate((li) => getComputedStyle(li).color);
  const plain = await steps.nth(1).evaluate((li) => getComputedStyle(li).color);
  assert.notEqual(red, plain, "a failed request stands out");
  await row.locator("summary", { hasText: "device and app" }).click();
  assert.match(await row.innerText(), /time zone\s+Asia\/Jerusalem/);
  await row.locator("summary", { hasText: "the player at the time" }).click();
  assert.match(await row.innerText(), /position\s+10:12/);
  await row.locator("summary", { hasText: "the server's side" }).click();
  assert.match(await row.innerText(), /server \d+\.\d+\.\d+ · up /);
  await row.screenshot({ path: path.join(__dirname, "artifacts", "report-trail-admin.png") }).catch(() => {});
  // Copy for Claude, this report
  await row.locator("[data-report-copy]").click();
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => /trail for the admin/.test(t)));
  const text = (await page.evaluate(() => navigator.clipboard.readText())).split("\r").join("");
  assert.match(text, /Last steps \(oldest first; time before the report was sent\):/);
  assert.match(text, /−0:40  !! GET \/api\/item\/abc → 500 in 3\.1 s/);
  assert.match(text, /Device and app:\n  app: web/);
  assert.match(text, /The player at the time:/);
  assert.match(text, /What the server knew then:/);
  // …and the section's Copy for Claude (the open reports) carries the same
  await page.locator('[data-copy-for="in-reports"]').click();
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => /Problem reports \(open\)/.test(t)));
  const all = (await page.evaluate(() => navigator.clipboard.readText())).split("\r").join("");
  assert.match(all, /trail for the admin[\s\S]*−0:30  !! stalled 4\.2 s at 10:12/);
});

ui.run({ concurrency: 1 });
