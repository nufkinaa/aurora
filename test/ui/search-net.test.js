// Search when the outside catalogue is slow or down (2026-10-26: "Sometimes
// the search doesn't find. It says it doesn't find. I leave the search and
// come back and then it finds. Example: La Cocina").
//
// Cinemeta's search is a stand-in here (support/slow-catalogue.js): it knows
// "La Cocina", and the test makes it slower than the page waits (2.5 s) or
// refuses it. What the screen must do:
//   - never "No results" for an answer that came from a timeout or a failure
//   - the local cards at once, "Still searching…" while the catalogue is
//     slow, ONE retry, and the title filled in when it lands
//   - a catalogue that stays down: "Couldn't reach the catalogue — try
//     again" with a button, which finds it once the catalogue is back
// Screenshots (real Chrome, desktop and phone) go to docs/qa/search-net/.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { suite, PHONE } = require("./helpers");

const ui = suite({
  server: {
    preload: [path.join(__dirname, "support", "slow-catalogue.js")],
    env: { UI_SLOW_CATALOGUE: "1" },
    // (the breaker stays out of these: a catalogue that comes back is asked
    // at once, not after its cooldown — test/upstream.test.js has the breaker)
    config: { upstream: { hosts: { "v3-cinemeta.strem.io": { failThreshold: 1000 } } } },
  },
});

const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "search-net");
const shot = async (page, name) => {
  if (process.env.UI_SHOTS !== "1") return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // (the posters on screen loaded and faded in)
  await page.waitForFunction(() => [...document.querySelectorAll("#app .screen .card img")].every((i) => i.complete), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const BOX = '.screen input[type="search"]';
const setCatalogue = (srv, c) => fs.writeFileSync(path.join(srv.root, "slow-catalogue.json"), JSON.stringify(c));
const titles = (page) => page.evaluate(() => [...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0]));
// Everything the screen SAID while the search ran (the message under the
// cards and the busy line), recorded as it changes — a "No results" that
// flashed and went is caught too.
const record = (page) => page.evaluate(() => {
  window.__said = [];
  const note = () => {
    const status = document.querySelector("#app .screen > .empty:not(.hidden)");
    const hint = document.querySelector("#app .screen .search-hint");
    const busy = document.querySelector("#app .search-busy:not(.hidden) .search-busy-text");
    for (const t of [status && status.textContent, hint && hint.textContent, busy && busy.textContent]) {
      if (t && window.__said[window.__said.length - 1] !== t) window.__said.push(t);
    }
  };
  new MutationObserver(note).observe(document.getElementById("app"), { subtree: true, childList: true, characterData: true, attributes: true });
});
const said = (page) => page.evaluate(() => window.__said);

ui.test("a catalogue slower than the page waits: 'Still searching…', then La Cocina — never 'No results'", async ({ page, srv, goto, signIn, freshProfile }) => {
  setCatalogue(srv, { mode: "slow", delayMs: 3500 });
  await signIn(await freshProfile());
  await goto("#/search");
  await record(page);
  const box = page.locator(BOX);
  await box.fill("la cocina");
  await box.press("Enter");
  await page.waitForFunction(() => /Still searching/.test((document.querySelector("#app .search-busy:not(.hidden) .search-busy-text") || {}).textContent || ""), null, { timeout: 8000 });
  await shot(page, "desktop-still-searching");
  await page.waitForFunction(() => [...document.querySelectorAll("#app .screen > .grid .card")].some((c) => /^La Cocina/.test(c.getAttribute("aria-label") || "")), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("#app .search-busy").classList.contains("hidden"));
  await shot(page, "desktop-found-after-retry");
  assert.deepEqual(await titles(page), ["La Cocina"]);
  const words = await said(page);
  assert.ok(words.some((t) => /Still searching/.test(t)), `said: ${JSON.stringify(words)}`);
  assert.ok(!words.some((t) => /No results|Couldn't reach/.test(t)), `never "No results" for a slow catalogue — said: ${JSON.stringify(words)}`);
  assert.equal(await page.locator("#app .screen > .empty:not(.hidden)").count(), 0, "nothing to say once it is found");
});

ui.test("a catalogue that stays down: 'Couldn't reach the catalogue — try again' with a button, which finds it once it is back (phone)", { viewport: PHONE, allow: [/Failed to load resource/] }, async ({ page, srv, goto, signIn, freshProfile }) => {
  setCatalogue(srv, { mode: "down" });
  await signIn(await freshProfile());
  await goto("#/search");
  await record(page);
  const box = page.locator(BOX);
  await box.fill("tampopo");
  await box.press("Enter");
  const fail = page.locator("#app .screen > .empty:not(.hidden) .search-fail");
  await fail.waitFor({ timeout: 15000 });
  assert.equal(await fail.textContent(), "Couldn't reach the catalogue — try again");
  const retry = page.locator('#app .screen > .empty [data-ui="search.retry"]');
  assert.equal(await retry.textContent(), "Try again");
  await page.waitForTimeout(1200); // (the message fades in)
  await shot(page, "phone-catalogue-down");
  let words = await said(page);
  assert.ok(!words.some((t) => /No results/.test(t)), `a failure is never "No results" — said: ${JSON.stringify(words)}`);
  assert.ok(words.some((t) => /Still searching/.test(t)), `it tried once more first — said: ${JSON.stringify(words)}`);
  const asked = JSON.parse(fs.readFileSync(path.join(srv.root, "slow-catalogue-asked.json"), "utf-8")).filter((a) => a.q === "tampopo" && a.type === "movie");
  assert.ok(asked.length >= 2, `asked, then asked once more (${asked.length})`);

  setCatalogue(srv, { mode: "ok" });
  await retry.click();
  await page.waitForFunction(() => [...document.querySelectorAll("#app .screen > .grid .card")].some((c) => /^Tampopo/.test(c.getAttribute("aria-label") || "")), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("#app .search-busy").classList.contains("hidden"));
  await shot(page, "phone-found-after-try-again");
  assert.equal(await page.locator("#app .screen > .empty:not(.hidden)").count(), 0);
  words = await said(page);
  assert.equal(words.filter((t) => /No results/.test(t)).length, 0);
});

ui.test("the library answers while the catalogue is down: its cards stay up, and the screen says there may be more", async ({ page, srv, goto, signIn, freshProfile }) => {
  setCatalogue(srv, { mode: "down" });
  await signIn(await freshProfile());
  await goto("#/search");
  const box = page.locator(BOX);
  await box.fill("test film one");
  await box.press("Enter");
  const hint = page.locator("#app .screen > .empty:not(.hidden) .search-hint");
  await hint.waitFor({ timeout: 15000 });
  assert.match(await hint.textContent(), /^Couldn't reach the catalogue — there may be more\. Try again$/);
  assert.equal((await titles(page))[0], "Test Film One", "the library's card never left");
  // (a library_updated push re-runs the search on screen: the line comes back with it)
  await page.waitForTimeout(4000);
  await hint.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200); // (the line fades in)
  await shot(page, "desktop-library-catalogue-down");
});

ui.test("a catalogue that answered and found nothing: a real 'No results for …', with what the house is watching", async ({ page, srv, goto, signIn, freshProfile }) => {
  setCatalogue(srv, { mode: "ok" });
  await signIn(await freshProfile());
  await goto("#/search");
  await record(page);
  const box = page.locator(BOX);
  await box.fill("zzqqxxyy");
  await box.press("Enter");
  await page.waitForFunction(() => /No results for “zzqqxxyy”/.test(document.querySelector("#app .screen > .empty:not(.hidden)")?.innerText || ""), null, { timeout: 15000 });
  const words = await said(page);
  assert.ok(!words.some((t) => /Still searching|Couldn't reach/.test(t)), `answered at once, no retry — said: ${JSON.stringify(words)}`);
});

ui.run();
