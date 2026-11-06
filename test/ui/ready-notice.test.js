// "Tell me when it's ready" in the web app (public/js/readyNotice.js, main.js):
// a download the person asked for lands and the app says the SERVER's sentence
// (publicJob readyLine, plus langLine from the language check, the same words
// the TV and the phone say) — and says nothing when the person switched it off
// under Settings, except what the language check found.
//
// The private instance cannot download anything, so the queue's answer is
// stubbed in the browser (the exact fields publicJob() sends) and the landing
// is seen the way a tab sees it after its socket comes back (the catch-up in
// main.js — test/ui/downloads.test.js has the same rig).
const assert = require("node:assert/strict");
const path = require("path");
const { suite, PHONE } = require("./helpers");

const ui = suite();
const SHOTS = process.env.AURORA_SHOTS || null; // a folder to keep screenshots in (looked at by hand)

const LANG = "This copy doesn't say its language — report it again if it's wrong.";
const job = (over = {}) => ({
  id: "aaaaaaaaaaaa", infoHash: "a".repeat(40), fileIdx: 0, imdbId: "tt9100001", title: "Ready Film", label: "Ready Film", type: "movie",
  season: null, episode: null, quality: "1080p", sizeBytes: 4e9, poster: null, provider: null,
  status: "downloading", phase: "downloading", copyProgress: null, progress: 0.4, downloadSpeed: 2100000, peers: 4,
  error: null, at: new Date().toISOString(), approvedAt: new Date().toISOString(), doneAt: null,
  holdReason: null, autoApproved: true, seenAt: null, smart: false, resolvedAt: null, libraryId: null,
  race: null, raceNote: null, mine: true, readyLine: null, langLine: null, ...over,
});

// Load My downloads with `first`, drop the socket, answer `then` when the list
// is asked for again: the landing the tab catches up on.
const land = async ({ page, goto }, first, then) => {
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Real {
      constructor(...a) { super(...a); window.__sockets.push(this); }
    };
  });
  let jobs = first;
  let asks = 0;
  await page.route((url) => url.pathname === "/api/downloads", (route) => { asks++; route.fulfill({ json: jobs }); });
  await goto("#/downloads");
  await page.waitForSelector(`.dl-row[data-id="${first[0].id}"]`);
  await page.waitForFunction(() => window.__sockets.some((s) => s.readyState === 1));
  jobs = then;
  const before = asks;
  await page.evaluate(() => window.__sockets.filter((s) => s.readyState === 1).forEach((s) => s.close()));
  await page.waitForFunction(() => window.__sockets.some((s) => s.readyState === 1) && window.__sockets.length > 1, null, { timeout: 15000 });
  for (let i = 0; i < 100 && asks <= before; i++) await page.waitForTimeout(100);
  assert.ok(asks > before, "the list was asked for again");
  await page.waitForFunction((id) => /Ready/i.test((document.querySelector(`.dl-row[data-id="${id}"]`) || {}).innerText || ""), then[0].id);
};
const toasts = (page) => page.evaluate(() => document.getElementById("toasts").innerText);

for (const [size, viewport] of [["desktop", undefined], ["phone", PHONE]]) {
  ui.test(`the server's sentence and the language line, when it lands (${size})`, { viewport }, async ({ page, goto, signIn, freshProfile, lib }) => {
    await signIn(await freshProfile());
    const done = { status: "done", phase: null, progress: 1, downloadSpeed: 0, doneAt: new Date().toISOString(), libraryId: lib.film1.id };
    await land({ page, goto }, [job()], [job({ ...done, readyLine: "The new version of “Ready Film” is in — ready to watch", langLine: LANG })]);
    const want = `The new version of “Ready Film” is in — ready to watch. ${LANG}`;
    await page.waitForFunction((w) => document.getElementById("toasts").innerText.includes(w), want, { timeout: 15000 });
    assert.equal(await page.locator('#toasts button:has-text("Play")').count() > 0, true, "Play is on it");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `ready-toast-${size}.png`) });
  });
}

ui.test("switched off: no ready notice — but the language line is still said", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { readyNotice: false } }, await api.as(me));
  assert.equal((await api.profile(me.id)).prefs.readyNotice, false, "the switch is the person's, on the server");
  await signIn(me);
  const done = { status: "done", phase: null, progress: 1, downloadSpeed: 0, doneAt: new Date().toISOString(), libraryId: lib.film1.id };
  await land({ page, goto },
    [job(), job({ id: "bbbbbbbbbbbb", title: "Quiet Film", label: "Quiet Film" })],
    [job({ ...done, langLine: LANG, readyLine: "“Ready Film” is ready to watch" }), job({ ...done, id: "bbbbbbbbbbbb", title: "Quiet Film", label: "Quiet Film", readyLine: "“Quiet Film” is ready to watch" })]);
  await page.waitForFunction((w) => document.getElementById("toasts").innerText.includes(w), `“Ready Film”: ${LANG}`, { timeout: 15000 });
  await page.waitForTimeout(500);
  const said = await toasts(page);
  assert.doesNotMatch(said, /is ready to watch/, "nothing about being ready");
});

ui.test("Settings: Tell me when it's ready is the person's switch, beside this device's notifications (desktop and phone)", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  for (const [size, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", PHONE]]) {
    await page.setViewportSize(vp);
    await goto("#/preferences");
    const more = page.locator(".pref-more-toggle");
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    const sw = page.locator(`#app button[role="switch"][aria-label="Tell me when it's ready"]`);
    await sw.waitFor();
    await sw.scrollIntoViewIfNeeded();
    const row = sw.locator("xpath=ancestor::div[contains(@class,'pref-item')][1]");
    assert.match(await row.innerText(), /When something you asked for has downloaded, Aurora says so — on every device you use\./);
    assert.equal(await page.locator(`#app button[role="switch"][aria-label="Notifications on this device"]`).count(), 1);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `ready-settings-${size}.png`) });
  }
  const sw = page.locator(`#app button[role="switch"][aria-label="Tell me when it's ready"]`);
  assert.equal(await sw.getAttribute("aria-checked"), "true", "on unless switched off");
  await sw.click();
  await page.waitForFunction(() => document.querySelector(`#app button[role="switch"][aria-label="Tell me when it's ready"]`).getAttribute("aria-checked") === "false");
  for (let i = 0; i < 50 && (await api.profile(me.id)).prefs.readyNotice !== false; i++) await page.waitForTimeout(100);
  assert.equal((await api.profile(me.id)).prefs.readyNotice, false);
});

ui.run({ concurrency: 1 });
