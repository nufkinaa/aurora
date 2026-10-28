// A film played as it is (the file itself, no hls.js) whose browser keeps
// only a few seconds in hand. The line watcher in player.js reads the buffer
// ("under 8 s ahead and not gaining for two seconds") as a line falling
// behind — a reading made for hls.js, which keeps 45 s. With a file, the
// browser decides that buffer itself: measured on the 2.5-hour stall rig
// (2026-10-28), half an hour into a 2 Mbit/s film on a LAN, with 1,500 s held
// behind the playhead after a seek, Chrome kept a few seconds ahead and
// fetched at the film's own rate; a scene a little above the average read as
// "not gaining", and the step-down took a healthy direct play onto a 480p CPU
// encode (on 1.13.0 the 0:00 bug then froze it for five minutes).
//
// The browser's buffer is played here by the page (the element's `buffered`,
// for the player's <video> only): a few seconds ahead, growing at 0.7x. With
// the line known to be fast nothing changes; with the line known to be thin
// for this file the step-down still comes before the freeze does.
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const ui = suite();

const fakeBuffer = (page, lineKbps) => page.addInitScript((kbps) => {
  try { localStorage.setItem("aurora-line-kbps", JSON.stringify({ kbps, at: Date.now() })); } catch {}
  const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "buffered");
  Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
    configurable: true,
    get() {
      const f = window.__fakeBuf;
      if (!f || !this.closest || !this.closest(".player")) return real.get.call(this);
      const end = f.end0 + (f.rate * (performance.now() - f.t0)) / 1000;
      return { length: 1, start: () => 0, end: () => end };
    },
  });
}, lineKbps);
// from now on: 7.5 s ahead, growing at 0.7 s a second
const thinBuffer = (page) => page.evaluate(() => {
  const v = document.querySelector(".player video");
  window.__fakeBuf = { t0: performance.now(), end0: v.currentTime + 7.5, rate: 0.7 };
});

const run = async ({ page, srv, signIn, freshProfile, lib }, lineKbps) => {
  await fakeBuffer(page, lineKbps);
  await signIn(await freshProfile());
  const capped = [];
  page.on("request", (r) => { if (/[?&]v=h264-(480|720)/.test(r.url())) capped.push(r.url().replace(srv.url, "")); });
  const marks = player.marks(page);
  await player.open(page, srv, lib.film1.id, { min: 1 });
  assert.equal((await marks.wait((m) => m.name === "path", 5000)).path, "direct");
  await page.waitForTimeout(6500); // (the watcher lets a start settle for 6 s)
  await thinBuffer(page);
  await page.waitForTimeout(12000);
  return { capped, downs: marks.named("step-down").concat(marks.all.filter((m) => m.name === "client_switch")) };
};

ui.test("a file played as it is, a browser that keeps only a few seconds in hand, a fast line: no step-down onto an encode", async (ctx) => {
  const { capped, downs } = await run(ctx, 200000);
  assert.deepEqual(capped, [], "the player asked the server for a smaller re-encode");
  assert.deepEqual(downs, []);
  assert.equal(await ctx.page.evaluate(() => document.querySelector(".player video").paused), false);
});

ui.test("…and with the line known to be thin for that file the step-down still comes before the freeze", async (ctx) => {
  const { capped } = await run(ctx, 1);
  assert.ok(capped.length >= 1, "no smaller re-encode was asked for");
});

ui.run({ concurrency: 2 });
