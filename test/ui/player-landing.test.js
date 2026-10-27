// A second change made while the first one's stream is still landing keeps
// the film's place. Every change that restarts the stream "from here" (a step
// down, a quality or sound change, a fall-back to the encode) read the place
// off the element — which says 0 while a new stream is being put on it — and
// opened the film at 0:00 far into it (the web ladder "sitting at 0:00 while
// segments are rebuilt" after a step-down; player.js `landing`).
const assert = require("node:assert/strict");
const { suite, player, warmJit, FILM_SECONDS } = require("./helpers");

const ui = suite({
  setup: async (srv) => { await warmJit(srv, srv.lib.film2.id); },
});

const menuPick = async (page, label) => {
  await player.press(page, "Settings");
  await page.waitForSelector(".player .menu .menu-title");
  await page.locator(".player .menu .menu-item", { hasText: label }).first().click();
};

ui.test("two sound switches in a row, the second before the first stream has landed: the film stays where it was", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  // the second track's segments are slow to come: its stream lands late
  await page.route(/\/jit\/seg\d+\.ts\?.*a=1/, async (route) => { await new Promise((r) => setTimeout(r, 4000)); route.continue(); });
  const asked = [];
  page.on("request", (r) => { if (/\/jit\/seg\d+/.test(r.url())) asked.push(r.url().replace(srv.url, "")); });
  await player.open(page, srv, lib.film2.id, { min: 1 });
  await player.scrubTo(page, 0.5);
  await player.waitClock(page, FILM_SECONDS * 0.5 - 4, FILM_SECONDS * 0.5 + 4);
  await player.playing(page);
  const at = await page.evaluate(() => document.querySelector(".player video").currentTime);
  assert.ok(at > FILM_SECONDS * 0.4, `playing at ${at}`);

  await menuPick(page, "Hebrew");
  // (the new stream is on the element and has not landed: its clock reads 0)
  await page.waitForFunction(() => (document.querySelector(".player video").currentTime || 0) < 0.5, null, { timeout: 5000 });
  asked.length = 0;
  await menuPick(page, "English");
  await player.playing(page, { timeout: 30000, min: 0.3 });
  const now = await page.evaluate(() => document.querySelector(".player video").currentTime);
  assert.ok(Math.abs(now - at) < 15, `after the second switch the film plays at ${now.toFixed(1)} s — it was at ${at.toFixed(1)} s`);
  // and the first segment asked for after it was the one at that place, not the film's first
  const first = asked.find((u) => !/a=1/.test(u)) || "";
  assert.doesNotMatch(first, /seg00000\.ts/, `the second switch asked for ${first}`);
});
ui.run({ concurrency: 1 });
