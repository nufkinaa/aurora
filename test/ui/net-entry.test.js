// The connection measure at page entry (public/js/net.js), in real Chrome on
// emulated lines (2026-10-26: "The network detection almost always says when
// I get into the site that I have a slow connection — an annoying message").
//
// What was wrong: every response was timed alone, so the first screenful —
// modules, posters, answers, all arriving at once, each with a share of the
// line — read as dozens of slow lines. A 10 Mbit/s line 150 ms away was
// "slow" within seconds of every visit, and a toast said so.
//
// What must hold now:
//   - a good line is never called slow at entry, and no toast says it is
//   - a line that really is slow is still found slow (after sustained
//     evidence), and Data Saver still counts at once
//   - the viewer is told at most once a session, and not for a day after OK
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { suite, PHONE } = require("./helpers");

const ui = suite({});

const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "search-net");
const shot = async (page, name) => {
  if (process.env.UI_SHOTS !== "1") return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
// a line, as Chrome's own network emulation makes it
const line = async (context, page, { kbps, latency }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: (kbps * 1000) / 8, uploadThroughput: (kbps * 1000) / 8 });
};
// what the page called the line, and every toast it showed, as they happen
const watchNet = (page) => page.addInitScript(() => {
  window.__tiers = [];
  window.__toasts = [];
  const t0 = performance.now();
  const note = () => {
    const v = document.documentElement.dataset.net;
    if (v && window.__tiers[window.__tiers.length - 1]?.v !== v) window.__tiers.push({ t: Math.round(performance.now() - t0), v });
    for (const n of document.querySelectorAll("#toasts .toast")) {
      const text = n.textContent;
      if (!window.__toasts.includes(text)) window.__toasts.push(text);
    }
  };
  new MutationObserver(note).observe(document, { attributes: true, subtree: true, childList: true, attributeFilter: ["data-net", "class"] });
  setInterval(note, 200);
});
const seen = (page) => page.evaluate(() => ({ tiers: window.__tiers, toasts: window.__toasts }));
const tierNow = (page) => page.evaluate(() => document.documentElement.dataset.net);

ui.test("a good line far away (10 Mbit/s, 150 ms): never 'slow' at entry, and no toast about it", { timeout: 90000 }, async ({ page, context, goto, signIn, freshProfile }) => {
  await line(context, page, { kbps: 10000, latency: 150 });
  await watchNet(page);
  await signIn(await freshProfile());
  await goto("#/");
  await page.waitForTimeout(8000);
  await goto("#/movies"); // a second screenful of posters
  await page.waitForTimeout(14000);
  const s = await seen(page);
  assert.ok(!s.tiers.some((x) => x.v === "slow"), `called slow: ${JSON.stringify(s.tiers)}`);
  assert.ok(!s.toasts.some((t) => /slow connection/i.test(t)), `toasts: ${JSON.stringify(s.toasts)}`);
  const m = await page.evaluate(async () => (await import("/js/net.js")).measured());
  assert.ok(m.kbps == null || m.kbps > 4000, `measured ${m.kbps} kbit/s on a 10 Mbit/s line`);
  await shot(page, "desktop-entry-good-line-no-toast");
});

ui.test("on a phone, a good line (20 Mbit/s, 80 ms): never 'slow' at entry", { viewport: PHONE, timeout: 90000 }, async ({ page, context, goto, signIn, freshProfile }) => {
  await line(context, page, { kbps: 20000, latency: 80 });
  await watchNet(page);
  await signIn(await freshProfile());
  await goto("#/");
  await page.waitForTimeout(12000);
  const s = await seen(page);
  assert.ok(!s.tiers.some((x) => x.v === "slow"), `called slow: ${JSON.stringify(s.tiers)}`);
  assert.ok(!s.toasts.some((t) => /slow connection/i.test(t)), `toasts: ${JSON.stringify(s.toasts)}`);
  await shot(page, "phone-entry-good-line-no-toast");
});

ui.test("a line that really is slow (800 kbit/s) is still found slow — on sustained evidence, not at entry", { timeout: 120000 }, async ({ page, context, goto, signIn, freshProfile }) => {
  await line(context, page, { kbps: 800, latency: 200 });
  await watchNet(page);
  await signIn(await freshProfile());
  await goto("#/");
  await page.waitForTimeout(10000);
  assert.notEqual(await tierNow(page), "slow", "not from the first readings");
  await page.waitForFunction(() => document.documentElement.dataset.net === "slow", null, { timeout: 75000, polling: 500 });
  const s = await seen(page);
  const at = s.tiers.find((x) => x.v === "slow").t;
  assert.ok(at >= 20000, `slow after ${at} ms: sustained, not the first sample`);
  assert.ok(!s.toasts.some((t) => /slow connection/i.test(t)), "lighter pictures alone are not worth a toast");
  const m = await page.evaluate(async () => (await import("/js/net.js")).measured());
  assert.ok(m.kbps > 400 && m.kbps < 1200, `measured ${m.kbps} kbit/s on an 800 kbit/s line`);
});

ui.test("Data Saver still counts at once", async ({ page, goto, signIn, freshProfile }) => {
  await page.addInitScript(() => { try { localStorage.setItem("aurora-data-mode", "saver"); } catch {} });
  await signIn(await freshProfile());
  await goto("#/");
  assert.equal(await tierNow(page), "slow");
  const playCap = await page.evaluate(async () => (await import("/js/net.js")).playCap());
  assert.ok(playCap === 720 || playCap === 480, `a lighter stream: ${playCap}`);
});

ui.test("the viewer is told at most once a session, and not for a day after OK", async ({ page, context, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/");
  const due = () => page.evaluate(async () => (await import("/js/net.js")).slowNoteDue());
  assert.equal(await due(), true);
  await page.evaluate(async () => (await import("/js/net.js")).slowNoteShown());
  assert.equal(await due(), false, "said once in this session");
  await page.reload();
  assert.equal(await due(), false, "a reload is the same session");
  // a new tab is a new session…
  const other = await context.newPage();
  await other.goto(page.url());
  assert.equal(await other.evaluate(async () => (await import("/js/net.js")).slowNoteDue()), true);
  // …unless OK was pressed: then quiet for a day, in every tab
  await other.evaluate(async () => (await import("/js/net.js")).slowNoteDismissed());
  const third = await context.newPage();
  await third.goto(page.url());
  assert.equal(await third.evaluate(async () => (await import("/js/net.js")).slowNoteDue()), false);
  const until = await third.evaluate(() => Number(localStorage.getItem("aurora-net-quiet-until")));
  assert.ok(until - Date.now() > 23 * 3600 * 1000, "for a day");
  await other.close();
  await third.close();
});

ui.run();
