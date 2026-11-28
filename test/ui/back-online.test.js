// The device's Wi-Fi switched off and back on (streaming round 2,
// 2026-11-28 — docs/qa/streaming-round-2/web.md): while it is offline every
// request fails at once and hls.js asks again on its back-off (2, 4, then 8 s
// apart); the moment the browser is online again the stream asks for what it
// needs, instead of waiting out the rest of that back-off.
const assert = require("node:assert/strict");
const { suite, player, warmJit } = require("./helpers");

const ui = suite({ setup: async (srv) => { await warmJit(srv, srv.lib.film2.id); } });

ui.test("back online, the stream asks for its next segment at once", { allow: [/ERR_INTERNET_DISCONNECTED/] }, async ({ page, context, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const segs = [];
  page.on("request", (r) => { if (/\/jit\/seg\d+\.ts/.test(r.url())) segs.push(Date.now()); });
  // (a line, not a LAN: from the fourth segment on each answer takes a second,
  // so hls.js is still fetching when the Wi-Fi goes)
  await page.route(/\/jit\/seg000(0[3-9]|[1-9]\d)\.ts/, async (route) => { await new Promise((r) => setTimeout(r, 1000)); try { await route.continue(); } catch {} });
  const marks = player.marks(page);
  await player.open(page, srv, lib.film2.id, { min: 0.3 });
  // offline while hls.js is still fetching: its next asks fail and it backs off
  await context.setOffline(true);
  await page.waitForTimeout(9000);
  const back = Date.now();
  await context.setOffline(false);
  const until = back + 6000;
  while (!segs.some((t) => t >= back) && Date.now() < until) await page.waitForTimeout(100);
  const first = segs.find((t) => t >= back);
  assert.ok(first, "no segment was asked for in the 6 s after the device came back online");
  assert.ok(first - back < 1500, `the first ask after coming back online was ${first - back} ms later`);
  await marks.wait((m) => m.name === "online", 5000, "the online mark");
  await player.advancing(page);
});

ui.run();
