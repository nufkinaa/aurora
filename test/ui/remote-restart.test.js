// The remote across a server restart: the private instance runs under its
// keeper (as an installed server does), the phone has the remote open on a
// (simulated) TV, the admin restarts Aurora — the TV announces itself again,
// the phone's list comes back by itself, and the next press works. Nothing is
// reloaded by hand.
const assert = require("node:assert/strict");
const { suite } = require("./helpers");
const { SimTV } = require("./support/sim-tv");

const ui = suite({ server: { keeper: { set: { probeEveryMs: 500, baseDelayMs: 200 } } } });
const PHONE = { width: 390, height: 844 };
const until = async (what, fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

ui.test("a server restart: the TV and the phone find each other again, and the remote goes on working", {
  viewport: PHONE,
  // the page sees the server go away and come back
  allow: [/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource|net::ERR/],
}, async ({ page, srv, api, lib, signIn, freshProfile }) => {
  const profile = await freshProfile();
  const tv = new SimTV({ url: srv.url, profile, name: "Living room TV" });
  await tv.start();
  try {
    await signIn(profile);
    await page.goto(`${srv.url}/#/movie/${lib.film1.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".rm-playon:not([hidden])", { timeout: 20000 });
    await page.locator(".rm-playon").click();
    await page.waitForSelector('.remote-screen[data-state="playing"]');
    await until("watched", () => tv.watched);
    const connects = tv.connects;

    const r = await api.call("POST", "/api/admin/update/restart", {}, api.admin);
    assert.equal(r.status, 200);
    // the phone says it is reconnecting, then the TV is back on its own
    await until("the TV reconnected and announced again", () => tv.connects > connects && tv.announces >= 2, 60000);
    await page.waitForSelector('.remote-screen[data-state="playing"] .rm-dot.live', { timeout: 60000 });
    await until("watched again after the restart", () => tv.watched, 30000);
    // a press after the restart reaches the TV and is answered
    tv.log.length = 0;
    await page.locator(".rm-play").click();
    await until("the pause after the restart", () => tv.log.some((l) => l.cmd === "toggle") && tv.now.paused);
    await until("the phone shows it paused", async () => (await page.locator(".rm-play").getAttribute("aria-label")) === "Play");
  } finally {
    await tv.stop();
  }
});

ui.run({ concurrency: 1 });
