// A film played as the file steps down onto the capped offset encode (no jit
// stream for it: every jit request is refused here), and that encode is then
// refused — its job died on a damaged stretch, its segments are gone (404).
// The player goes back to the file, which was playing, once, and steps down no
// more for this film: no rebuilding the dead stream until the error card.
// (tools/stream-net-rig, 2026-11-28: a damaged MP4 on 1.5 Mbit/s stood still
// for two minutes; its server restarted the dying encode 36 and 47 times.)
// The browser's buffer is played by the page, as in direct-buffer.test.js.
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const ui = suite();

ui.test("stepped down off the file, the encode refused: back to the file, no error card, no second step-down", { allow: [/Failed to load resource.*404/] }, async ({ page, srv, signIn, freshProfile, lib }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem("aurora-ladder-first", "0"); } catch {}
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "buffered");
    Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
      configurable: true,
      get() {
        const f = window.__fakeBuf;
        if (!f || !this.closest || !this.closest(".player") || this.currentSrc.includes("blob:")) return real.get.call(this);
        const end = f.end0 + (f.rate * (performance.now() - f.t0)) / 1000;
        return { length: 1, start: () => 0, end: () => end };
      },
    });
  });
  await signIn(await freshProfile(), { line: 1 });
  await page.route(/\/stream\/transcode\/[^/]+\/jit\//, (route) => route.fulfill({ status: 404, body: "no jit for this file" }));
  const segs = [];
  await page.route(/\/stream\/transcode\/[^/]+\/\d+\/seg\d+\.ts/, (route) => {
    segs.push(route.request().url());
    return route.fulfill({ status: 404, body: "Not found" });
  });
  const marks = player.marks(page);
  await player.open(page, srv, lib.film1.id, { min: 1 });
  assert.equal((await marks.wait((m) => m.name === "path", 5000)).path, "direct");
  await page.waitForTimeout(6500); // (the watcher lets a start settle for 6 s)
  await page.evaluate(() => {
    const v = document.querySelector(".player video");
    window.__fakeBuf = { t0: performance.now(), end0: v.currentTime + 7.5, rate: 0.7 };
  });
  await marks.wait((m) => m.name === "step-down", 20000, "the step-down");
  const refused = await marks.wait((m) => m.name === "jit-refused", 15000, "the refused encode noticed");
  await page.evaluate(() => { window.__fakeBuf = null; });
  const back = await marks.wait((m) => m.name === "path" && m.path === "direct" && m.ms >= refused.ms, 5000, "back to the file");
  assert.ok(back, "the file again");
  assert.ok(segs.length > 0, "the encode's segments were asked for (and refused)");
  await player.advancing(page, { by: 1, timeout: 15000 });
  await page.waitForTimeout(4000);
  assert.equal(marks.named("step-down").length, 1, "one step-down, not another onto the same refusal");
  assert.equal(await page.locator(".player .error-card, .player-error").count(), 0, "no error card");
});

ui.run();
