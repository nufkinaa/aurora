// Writing less (server round 2026-10-18, STORAGE): a playback tick no
// longer rewrites profiles.json — it waits in the watch journal — and
// nothing a person sees may change for it. In a real browser: a film watched
// on a desktop resumes on a phone at the same second straight after, Continue
// Watching on the phone has it, and profiles.json was not rewritten by the
// ticks while the journal holds the row.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { suite, player, signIn, goto, PHONE, ARTIFACTS } = require("./helpers");

const ui = suite();

ui.test("watched on a desktop, picked up on a phone at the same second; the ticks went to the journal, not profiles.json", async ({ page, context, srv, signIn: signInHere, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signInHere(me);
  await player.open(page, srv, lib.film1.id);
  await player.advancing(page, { by: 1 });
  const writes = async () => Object.fromEntries((await api.adminGet("/api/admin/stores")).stores.map((s) => [s.name, s.writes]));
  const before = await writes();
  // thirty seconds of watching: six of the player's 5-second saves
  await page.waitForFunction((t0) => (document.querySelector(".player video") || {}).currentTime > t0 + 30, await page.evaluate(() => document.querySelector(".player video").currentTime), { timeout: 60000 });
  await page.waitForTimeout(500);
  const saved = (await api.state(me)).progress[lib.film1.id];
  assert.ok(saved && saved.position >= 25, `the desktop's saves reached the server (${JSON.stringify(saved)})`);
  const during = await writes();
  // (before this round: one rewrite of the whole profiles.json per save)
  assert.ok((during["profiles.json"] || 0) - (before["profiles.json"] || 0) <= 1, `profiles.json was not rewritten by the playback ticks (${JSON.stringify({ before, during })})`);
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, "storage-sync--desktop-playing.png") });
  await player.press(page, "Back");
  await page.waitForSelector(".player", { state: "detached" });
  const atStop = (await api.state(me)).progress[lib.film1.id];

  // the journal on disk holds the row (the stop has it written at once)
  const jfile = path.join(srv.dataDir, "watch-journal.json");
  const deadline = Date.now() + 8000;
  let row = null;
  while (Date.now() < deadline) {
    try { row = JSON.parse(fs.readFileSync(jfile, "utf8")).rows[me.id].progress[lib.film1.id]; } catch { row = null; }
    if (row && row.position >= saved.position) break;
    await page.waitForTimeout(250);
  }
  assert.ok(row && row.position >= saved.position, `the journal on disk holds the row soon after the stop (${JSON.stringify(row)})`);

  // the phone: another device, the same person, right away
  const phone = await context.browser().newContext({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  await phone.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  try {
    const p2 = await phone.newPage();
    p2.setDefaultTimeout(15000);
    await signIn(p2, srv, me);
    await goto(p2, srv, "#/");
    await p2.waitForSelector(`.card[data-id="${lib.film1.id}"], [data-id="${lib.film1.id}"]`, { timeout: 20000 }).catch(() => null);
    await p2.screenshot({ path: path.join(ARTIFACTS, "storage-sync--phone-home.png") });
    const state = await api.state(me);
    assert.equal(state.progress[lib.film1.id].position, atStop.position, "the phone is served the very position the desktop stopped at");
    await player.open(p2, srv, lib.film1.id, { min: 5 });
    const pill = await p2.textContent(".player .resume-pill");
    await p2.screenshot({ path: path.join(ARTIFACTS, "storage-sync--phone-resumed.png") });
    const m = /Resumed at (\d+):(\d\d)/.exec(pill || "");
    assert.ok(m, `a resume pill (${pill})`);
    const at = +m[1] * 60 + +m[2];
    // the player resumes four seconds early (see player-episodes)
    assert.ok(Math.abs(at - (atStop.position - 4)) <= 1, `resumed at ${at} s for a stop at ${atStop.position} s`);
  } finally {
    await phone.close().catch(() => {});
  }
});

ui.run();
