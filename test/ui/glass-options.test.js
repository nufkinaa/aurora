// The glass versions to choose from (review only — public/index.html boot,
// public/css/glass-opt-*.css, docs/qa/glass-options/README.md):
//   · nothing asked: no version on the page and none of their files fetched
//     (what every real visitor gets)
//   · ?glass=c: version C on the page, its sheet and its script fetched, and
//     the choice stays with the tab across loads; ?glass=a goes back
//   · every version draws: the tab bar takes that version's body
const assert = require("node:assert/strict");
const { suite, PHONE } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    srv.profiles.p = await srv.api.createProfile("Glassy", { open: true });
  },
});

const fetched = (page) => {
  const seen = [];
  page.on("request", (r) => { if (/glass-opt-|glass-lens/.test(r.url())) seen.push(r.url().replace(/^https?:\/\/[^/]+/, "")); });
  return seen;
};
const version = (page) => page.evaluate(() => document.documentElement.dataset.glass || null);
const barBody = (page) => page.evaluate(() => getComputedStyle(document.querySelector(".nav-items")).backgroundImage);

ui.test("no version asked: today's glass, nothing extra loaded", { viewport: PHONE }, async ({ page, signIn, goto, profiles }) => {
  const seen = fetched(page);
  await signIn(profiles.p);
  await goto("#/");
  await page.waitForSelector(".nav-items");
  assert.equal(await version(page), null);
  assert.deepEqual(seen, []);
});

ui.test("?glass=c: version C for this tab, kept across loads; ?glass=a goes back", { viewport: PHONE }, async ({ page, srv, signIn, goto, profiles }) => {
  await signIn(profiles.p);
  await goto("#/");
  await page.waitForSelector(".nav-items");
  const today = await barBody(page);
  const seen = fetched(page);
  await page.goto(`${srv.url}/?glass=c#/`, { waitUntil: "load" });
  await page.waitForSelector(".nav-items");
  assert.equal(await version(page), "c");
  await page.waitForFunction(() => [...document.styleSheets].some((s) => /glass-opt-c\.css/.test(s.href || "")));
  assert.ok(seen.some((u) => u.startsWith("/css/glass-opt-c.css")), `fetched: ${seen}`);
  assert.ok(seen.some((u) => u.startsWith("/js/glass-lens.js")), `fetched: ${seen}`);
  assert.notEqual(await barBody(page), today, "the tab bar takes version C's body");
  // the next load, without the query: still C
  await page.goto(`${srv.url}/#/movies`, { waitUntil: "load" });
  await page.waitForSelector(".nav-items");
  assert.equal(await version(page), "c");
  // back to today's
  await page.goto(`${srv.url}/?glass=a#/`, { waitUntil: "load" });
  await page.waitForSelector(".nav-items");
  assert.equal(await version(page), null);
  assert.equal(await barBody(page), today);
});

ui.test("every version draws its own body on the tab bar", { viewport: PHONE }, async ({ page, srv, signIn, goto, profiles }) => {
  await signIn(profiles.p);
  await goto("#/");
  await page.waitForSelector(".nav-items");
  const bodies = new Set([await barBody(page)]);
  for (const v of ["b", "c", "d", "e"]) {
    await page.goto(`${srv.url}/?glass=${v}#/`, { waitUntil: "load" });
    await page.waitForSelector(".nav-items");
    await page.waitForFunction((g) => [...document.styleSheets].some((s) => (s.href || "").includes(`glass-opt-${g}.css`)), v);
    assert.equal(await version(page), v);
    bodies.add(await barBody(page));
  }
  assert.equal(bodies.size, 5, "five different bodies");
});
