// Invisible performance work (tools/webperf, docs/qa/webperf/REPORT.md): the
// page does less on the main thread and shows exactly what it showed before.
// What is checked here is the "exactly": the parts that were changed keep
// what a person sees â€” the greeting's shine where it would have been, the
// glass sky painting at its own pace.
const assert = require("node:assert/strict");
const { suite, DESKTOP, PHONE } = require("./helpers");

const ui = suite();

// Home's greeting shine (screens.css greet-shine) is a CSS animation that
// never ends. ui.js holdWhileOffscreen holds it while the greeting is a
// screen away and gives it back its own start time when it comes near again.
for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  for (const look of ["glass", "legacy"]) {
    ui.test(`${name}, ${look} look: the greeting's shine rests while scrolled a screen away and is back at its own phase before it comes into view`, { viewport }, async ({ page, goto, signIn, freshProfile, api }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      await signIn(me);
      await goto("#/");
      await page.locator(".greet-name").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.look || "legacy"), look);
      const shine = () => page.evaluate(() => {
        const a = document.querySelector(".greet-name").getAnimations().find((x) => x.animationName === "greet-shine");
        return a ? { state: a.playState, start: a.startTime, current: a.currentTime, now: document.timeline.currentTime } : null;
      });
      await page.waitForFunction(() => {
        const a = document.querySelector(".greet-name").getAnimations()[0];
        return a && a.playState === "running" && a.startTime != null;
      });
      const before = await shine();
      assert.equal(before.state, "running");
      // the test library's Home is short: room to scroll the greeting far away
      await page.evaluate(() => {
        const pad = document.createElement("div");
        pad.id = "ui-pad";
        pad.style.height = `${innerHeight * 4}px`;
        document.querySelector("#app .screen").append(pad);
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      });
      await page.waitForFunction(() => document.querySelector(".greet-name").getAnimations()[0].playState === "paused");
      await page.waitForTimeout(700);
      // back up to half a screen below it: inside the margin, so it is
      // running again already, while still out of view above the screen
      await page.evaluate(() => {
        const g = document.querySelector(".greet-name");
        window.scrollTo({ top: window.scrollY + g.getBoundingClientRect().bottom + innerHeight * 0.5, behavior: "instant" });
      });
      await page.waitForFunction(() => document.querySelector(".greet-name").getAnimations()[0].playState === "running");
      const back = await shine();
      const bottom = await page.evaluate(() => document.querySelector(".greet-name").getBoundingClientRect().bottom / innerHeight);
      assert.ok(bottom < 0, `the greeting is still out of view when its shine runs again (its bottom at ${bottom.toFixed(2)} screens)`);
      assert.equal(back.start, before.start, "the same start time: the shine is where it would have been had it never stopped");
      assert.ok(Math.abs(back.current - (back.now - back.start)) < 1, `phase ${back.current} = time since its start ${back.now - back.start}`);
      // leaving Home lets the watcher go (nothing left behind to throw)
      await goto("#/movies");
      await goto("#/");
      await page.locator(".greet-name").waitFor();
    });
  }
}

// The glass sky paints every 33–83 ms (aurora-sky-core.js, by what a paint
// costs here) and between two paints sleeps on a timer instead of asking for
// every frame. It must still paint at its own pace: never stalled, never
// faster than its cadence. On a computer the painting is done in a worker
// (aurora-sky.js — the page cannot see a worker's canvas being drawn, so the
// sky itself says when it has painted, to whoever set __auroraSkyWatch).
const watchSky = (page, { noWorker = false } = {}) =>
  page.addInitScript((noWorker) => {
    if (noWorker) delete HTMLCanvasElement.prototype.transferControlToOffscreen;
    window.__auroraSkyWatch = true;
    window.__skyPaints = [];
    // (`at`: the painter's own clock — a worker's word can reach a busy page late)
    window.addEventListener("aurora-sky-paint", (e) => window.__skyPaints.push(e.detail.at));
  }, noWorker);
// is the sky's canvas drawn somewhere else? (a canvas handed to a worker refuses a context)
const inWorker = (page) =>
  page.evaluate(() => {
    try {
      document.getElementById("glass-sky").getContext("2d");
      return false;
    } catch {
      return true;
    }
  });
const paints = async (page, ms, during = () => page.waitForTimeout(ms)) => {
  await page.waitForFunction(() => window.__skyPaints.length > 3, null, { timeout: 15000 });
  await page.evaluate(() => { window.__skyPaints.length = 0; });
  await during();
  const t = await page.evaluate(() => window.__skyPaints.slice());
  return { t, gaps: t.slice(1).map((x, i) => x - t[i]) };
};
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

for (const [where, noWorker] of [["in its worker", false], ["on the page's thread, where a canvas cannot go to a worker", true]]) {
  ui.test(`glass look: the page sky keeps painting at its own pace ${where} — a paint every 33–83 ms, no stall, none early`, async ({ page, goto, signIn, freshProfile }) => {
    await watchSky(page, { noWorker });
    await signIn(await freshProfile());
    await goto("#/");
    const { t, gaps } = await paints(page, 3000);
    assert.equal(await inWorker(page), !noWorker);
    assert.ok(t.length >= 15, `${t.length} paints in 3 s`);
    // (a frame is ~16.7 ms: a paint lands on the first frame at or after its due time)
    assert.ok(Math.min(...gaps) >= 33 - 17, `no paint early: the shortest gap is ${Math.round(Math.min(...gaps))} ms`);
    assert.ok(median(gaps) <= 83 + 34, `the usual gap is the cadence: median ${Math.round(median(gaps))} ms`);
  });
}

// elia, 2026-11-10: "when scrolling on desktop the background stops and then
// comes back". A sky whose paint is dear held its frame for as long as the
// page was scrolled — on a computer that was every scroll, whole seconds
// without a paint. In a worker it has nothing to wait for.
ui.test("glass look, on a computer: the sky goes on painting while the page is scrolled", async ({ page, goto, signIn, freshProfile }) => {
  await watchSky(page);
  await signIn(await freshProfile());
  await goto("#/");
  await page.locator(".greet-name").waitFor();
  // (a new profile's Home is short: room to scroll for three seconds)
  await page.evaluate(() => document.getElementById("app").appendChild(Object.assign(document.createElement("div"), { style: "height:9000px" })));
  await page.mouse.move(640, 400);
  let y = 0;
  const { t, gaps } = await paints(page, 0, async () => {
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(75); }
    y = await page.evaluate(() => Math.round(window.scrollY || document.body.scrollTop || 0));
  });
  assert.equal(await inWorker(page), true, "the sky is painted in a worker");
  assert.ok(y > 3000, `the page was not scrolled (${y})`);
  assert.ok(t.length >= 15, `${t.length} paints through a three-second scroll`);
  assert.ok(Math.max(...gaps) < 400, `no stop: the longest wait between two paints was ${Math.round(Math.max(...gaps))} ms`);
});

// A worker that does not come (its file refused, an old browser's module
// workers): the sky paints on the page's thread, as it did before.
ui.test("glass look: a sky worker that fails to start leaves the sky painting on the page", async ({ page, goto, signIn, freshProfile }) => {
  await watchSky(page);
  await page.route(/\/js\/aurora-sky-worker\.js/, (r) => r.abort());
  await signIn(await freshProfile());
  await goto("#/");
  const { t } = await paints(page, 2000);
  assert.equal(await inWorker(page), false);
  assert.ok(t.length >= 10, `${t.length} paints in 2 s`);
});

// A canvas goes to a worker once and for good: leaving the glass look puts
// that worker to sleep, coming back wakes the same one.
ui.test("glass look: the sky's worker rests in the classic look and paints again when glass is back", async ({ page, goto, signIn, freshProfile }) => {
  await watchSky(page);
  await signIn(await freshProfile());
  await goto("#/");
  await paints(page, 300);
  const look = (name) => page.evaluate((name) => {
    document.documentElement.dataset.look = name;
    window.dispatchEvent(new Event("aurora-look"));
  }, name);
  await look("legacy");
  await page.waitForTimeout(400); // (a paint already under way lands)
  await page.evaluate(() => { window.__skyPaints.length = 0; });
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.__skyPaints.length), 0, "no paint while the sky is not shown");
  await look("glass");
  const { t } = await paints(page, 2000);
  assert.equal(await inWorker(page), true);
  assert.ok(t.length >= 10, `${t.length} paints in 2 s after coming back`);
});

ui.run();
