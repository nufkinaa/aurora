// Invisible performance work (tools/webperf, docs/qa/webperf/REPORT.md): the
// page does less on the main thread and shows exactly what it showed before.
// What is checked here is the "exactly": the parts that were changed keep
// what a person sees — the greeting's shine where it would have been, the
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

// The glass sky paints every 33–83 ms (aurora-sky.js, by what a paint costs
// here) and between two paints now sleeps on a timer instead of asking for
// every frame. It must still paint at its own pace: never stalled, never
// faster than its cadence.
ui.test("glass look: the page sky keeps painting at its own pace — a paint every 33–83 ms, no stall, none early", async ({ page, goto, signIn, freshProfile }) => {
  await page.addInitScript(() => {
    const real = CanvasRenderingContext2D.prototype.clearRect;
    window.__skyPaints = [];
    CanvasRenderingContext2D.prototype.clearRect = function (...a) {
      if (this.canvas && this.canvas.id === "glass-sky") window.__skyPaints.push(performance.now());
      return real.apply(this, a);
    };
  });
  await signIn(await freshProfile());
  await goto("#/");
  await page.waitForFunction(() => window.__skyPaints.length > 3, null, { timeout: 15000 });
  await page.evaluate(() => { window.__skyPaints.length = 0; });
  await page.waitForTimeout(3000);
  const t = await page.evaluate(() => window.__skyPaints.slice());
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  assert.ok(t.length >= 15, `${t.length} paints in 3 s`);
  // (a frame is ~16.7 ms: a paint lands on the first frame at or after its due time)
  assert.ok(Math.min(...gaps) >= 33 - 17, `no paint early: the shortest gap is ${Math.round(Math.min(...gaps))} ms`);
  const sorted = [...gaps].sort((a, b) => a - b);
  assert.ok(sorted[Math.floor(sorted.length / 2)] <= 83 + 34, `the usual gap is the cadence: median ${Math.round(sorted[Math.floor(sorted.length / 2)])} ms`);
});

ui.run();
