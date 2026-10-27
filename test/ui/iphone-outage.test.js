// An iPhone's stream while the SERVER is away for a few seconds (a restart:
// a deploy, the admin's Restart, the watchdog — about ten seconds), or the
// phone's line is (a Wi-Fi hand-over, a mobile line changing cells).
//
// Measured before (tools/stall-rig, an iPhone user agent, the server
// restarted under it): the native stream errored, the player tried the same
// stream three times one, two and three seconds apart — all inside the
// outage — then took the error for a device refusing the copy and put the
// film on the full encode, from 0:00 (the failed reloads had left the clock at
// 0), where it sat. Now: the same stream again for about a minute, from where
// the film was, and it plays on where it stopped once the server answers.
"use strict";
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const IPHONE = { width: 430, height: 745 };
const asIPhone = (page) => page.addInitScript((ua) => { Object.defineProperty(navigator, "userAgent", { get: () => ua }); }, UA);
const srcOf = (page) => page.evaluate(() => document.querySelector(".player video").getAttribute("src") || "");

const ui = suite();

ui.test("the server away for ten seconds under an iPhone: the same stream at the same spot afterwards — not the full encode from 0:00", {
  viewport: IPHONE,
  allow: [/Failed to load resource/, /net::ERR_FAILED/],
  timeout: 150000,
}, async ({ page, srv, lib, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await asIPhone(page);
  const marks = player.marks(page);
  const encodes = [];
  page.on("request", (req) => { if (/[?&]v=h264/.test(req.url())) encodes.push(req.url()); });
  await player.open(page, srv, lib.film2.id, { min: 1 });
  const plain = await srcOf(page);
  assert.match(plain, /\/jit\/index\.m3u8\?seg=fmp4$/);
  // half a minute of the copy, played here: this device decodes it
  await player.waitClock(page, 33, 50, 60000);
  const at = await player.clock(page);
  // the server goes away: every stream request fails…
  const outage = /\/stream\//;
  await page.route(outage, (route) => route.abort("connectionrefused"));
  // …and the phone's player says so (Safari's way: the element's error)
  await page.evaluate(() => document.querySelector(".player video").dispatchEvent(new Event("error")));
  await page.waitForTimeout(10000);
  await page.unroute(outage);
  // back: the film plays on, the same stream, where it was
  await player.advancing(page, { by: 1, timeout: 60000 });
  const now = await player.clock(page);
  assert.ok(now >= at - 3, `the same spot: ${at}s before the outage, ${now}s after`);
  assert.equal(await srcOf(page), plain, "the same stream (no offset job, no encode)");
  assert.deepEqual(encodes, [], "nothing asked of the full encode");
  assert.equal(marks.all.filter((m) => m.name === "media-error" && m.did === "h264").length, 0, JSON.stringify(marks.all));
  assert.equal(await page.locator("#toasts .toast", { hasText: "re-encoding" }).count(), 0);
});

ui.run({ concurrency: 1 });
