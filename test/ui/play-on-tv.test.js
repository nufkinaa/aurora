// Play on TV / Continue on this phone — the handoff round, in real Chrome
// against a private instance and a simulated TV (test/ui/support/sim-tv.js):
//   - a TV on its profile wall: the one-press confirmation, the TV asks for
//     the PIN ("Enter your PIN on Living room TV to play …"), the remote
//     opens on it, and carries on once the TV is in the profile and playing;
//   - Continue on this phone / computer: the TV is paused, this device plays
//     the same title from the TV's second;
//   - a TV that does not answer: "Living room TV didn't answer".
// (Screenshots for docs/qa/play-on-tv only with PLAYONTV_SHOTS=1: a test run
// must not rewrite tracked files.)
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite } = require("./helpers");
const { SimTV } = require("./support/sim-tv");

const ui = suite();
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };
const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "play-on-tv");
const shot = async (page, name) => {
  if (process.env.PLAYONTV_SHOTS !== "1") return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
};
const until = async (what, fn, ms = 10000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 60));
  }
};
const lastCmd = (tv, cmd) => [...tv.log].reverse().find((l) => l.cmd === cmd) || null;
const toastSays = async (page, text, timeout = 10000) => {
  try {
    await page.waitForFunction((t) => [...document.querySelectorAll("#toasts .toast")].some((n) => n.textContent.includes(t)), text, { timeout });
  } catch (e) {
    const seen = await page.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map((n) => n.textContent)).catch(() => []);
    throw new Error(`no toast "${text}" — on screen: ${JSON.stringify(seen)}`);
  }
};
const goto = async (page, srv, hash, selector) => {
  if (!page.url().startsWith(srv.url)) await page.goto(`${srv.url}/${hash}`, { waitUntil: "domcontentloaded" });
  else await page.evaluate((h) => { location.hash = h; }, hash);
  if (selector) await page.waitForSelector(selector, { timeout: 20000 });
};

ui.test("phone: Play on TV to a TV on its profile wall — one press and a confirmation, the TV asks for the PIN, the remote carries on once it is in", { viewport: PHONE }, async ({ page, srv, lib, signIn, freshProfile }) => {
  const profile = await freshProfile();
  const tv = new SimTV({ url: srv.url, profile, name: "Living room TV", wall: true, wallDoor: "needs-pin" });
  await tv.start();
  try {
    await signIn(profile);
    await goto(page, srv, `#/movie/${lib.film2.id}`, ".rm-playon:not([hidden])");
    assert.match(await page.locator(".rm-playon").innerText(), /Play on Living room TV/);
    await page.locator(".rm-playon").click();
    // one TV: the sheet comes up all the same, to confirm
    const row = page.locator(".rm-sheet-wrap.on .rm-sheet-row", { hasText: "Living room TV" }).first();
    await row.waitFor();
    assert.equal(await page.locator(".rm-sheet-wrap.on .rm-sheet-title").textContent(), "Play “Test Film Two” on Living room TV?");
    assert.match(await row.innerText(), /On “Who's watching\?”/);
    assert.equal(tv.log.length, 0, "nothing is sent before the confirmation");
    await shot(page, "web-phone-confirm-wall-tv");
    await row.click();
    await until("the TV to be told", () => lastCmd(tv, "play_item"));
    const play = lastCmd(tv, "play_item");
    assert.equal(play.args.item.id, lib.film2.id);
    assert.equal(play.from.profileId, profile.id, "the server says whose profile to open");
    await toastSays(page, "Enter your PIN on Living room TV to play Test Film Two").catch((e) => {
      throw new Error(`${e.message}; the TV: connects ${tv.connects}, announces ${tv.announces}, error ${tv.lastError || "-"}, log ${JSON.stringify(tv.log.map((l) => l.cmd))}`);
    });
    await page.waitForFunction((id) => location.hash === `#/remote/${id}`, tv.deviceId);
    await page.waitForSelector('.remote-screen[data-state="idle"]');
    assert.match(await page.locator(".rm-idle .rm-subtitle").innerText(), /On “Who's watching\?”/);
    await shot(page, "web-phone-remote-tv-asks-pin");
    // the PIN is typed on the TV: the same box, now this profile's, playing it
    await tv.enterProfile(profile);
    await page.waitForSelector('.remote-screen[data-state="playing"]', { timeout: 15000 });
    assert.equal(await page.locator(".rm-playing .rm-title").innerText(), "Test Film Two");
    await page.locator(".rm-play").click();
    await until("the remote steers it now", () => tv.now && tv.now.paused);
    await shot(page, "web-phone-remote-after-pin");
  } finally {
    await tv.stop();
  }
});

ui.test("Continue on this computer: the TV is paused and this browser plays the same film from the TV's second", { viewport: DESKTOP }, async ({ page, srv, lib, signIn, freshProfile }) => {
  const profile = await freshProfile();
  const tv = new SimTV({ url: srv.url, profile, name: "Living room TV" });
  await tv.start();
  try {
    await tv.open_(lib.film1.id, { position: 30 });
    tv.report();
    await signIn(profile);
    await goto(page, srv, `#/remote/${tv.deviceId}`, '.remote-screen[data-state="playing"]');
    const here = page.locator('[data-ui="remote.continuehere"]');
    assert.equal(await here.innerText(), "Continue on this computer");
    await shot(page, "web-desktop-remote-continue");
    await here.click();
    await until("the TV paused", () => lastCmd(tv, "pause") && tv.now.paused);
    await page.waitForFunction((id) => location.hash.startsWith(`#/play/${id}`), lib.film1.id);
    await toastSays(page, "Paused on Living room TV — carrying on here");
    // (the first frames can read 0 before the start position lands)
    await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v && v.currentTime > 25; }, null, { timeout: 20000 })
      .catch(() => {});
    const t = await page.evaluate(() => document.querySelector(".player video").currentTime);
    assert.ok(t >= 29 && t < 40, `from the TV's second: ${t}`);
    await shot(page, "web-desktop-continued-here");
  } finally {
    await tv.stop();
  }
});

ui.test("phone: Continue on this phone names this phone; a TV that does not answer is said in so many words", { viewport: PHONE }, async ({ page, srv, lib, signIn, freshProfile }) => {
  const profile = await freshProfile();
  const tv = new SimTV({ url: srv.url, profile, name: "Living room TV" });
  await tv.start();
  try {
    await tv.open_(lib.film1.id, { position: 12 });
    tv.report();
    await signIn(profile);
    await goto(page, srv, `#/remote/${tv.deviceId}`, '.remote-screen[data-state="playing"]');
    assert.equal(await page.locator('[data-ui="remote.continuehere"]').innerText(), "Continue on this phone");
    // the TV stops answering (a TV that froze): the server answers for it
    tv.silent = true;
    await goto(page, srv, `#/movie/${lib.film2.id}`, ".rm-playon:not([hidden])");
    await page.locator(".rm-playon").click();
    await page.locator(".rm-sheet-wrap.on .rm-sheet-row", { hasText: "Living room TV" }).first().click();
    await toastSays(page, "Living room TV didn't answer", 12000);
    assert.match(page.url(), new RegExp(`#/movie/${lib.film2.id}`), "no remote for a TV that did not answer");
  } finally {
    await tv.stop();
  }
});

ui.run({ concurrency: 1 });
