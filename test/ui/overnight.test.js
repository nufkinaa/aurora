// Overnight (src/media/overnight.js) in the real browser, on a private
// instance:
//   - Admin → Downloads → Overnight: the one calm line, readable with the
//     section closed; Details behind it; the switch, the hours, the disk
//     budget and the downloads ahead saved (and a wrong value refused);
//     Copy for Claude — at desktop and phone width.
//   - The real thing: this Chrome is seen with a person, the person is in the
//     middle of "Test Film Two" (MKV, two AC-3 tracks: Chrome repackages it
//     live), Run now prepares a copy for this browser, and the next start
//     plays that copy as a file — no live repackaging, no encoder.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, openDetails, goto, signIn, assertNoHorizontalOverflow, DESKTOP, PHONE } = require("./helpers");

const ui = suite({
  server: { config: { overnight: { quietStartMs: 500, resumeQuietMs: 500, tickMs: 300, planEveryMs: 2000 } } },
});

const SHOTS = process.env.ON_SHOTS || path.join(os.tmpdir(), "aurora-agents", "overnight-prep", "shots");
const shot = async (page, name, el = null) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (el ? page.locator(el) : page).screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
};
const toastSays = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll("#toasts .toast")].some((t) => new RegExp(src).test(t.textContent)), re.source);

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  ui.test(`admin: the calm line, Details, the settings saved and checked (${name})`, { viewport }, async ({ page, srv }) => {
    await enter(page, srv);
    await page.click('.tab[data-tab="downloads"]');
    // closed, the section's own line already says it
    await page.waitForFunction(() => /^Overnight: .+ · next run \d\d:\d\d$/.test(document.getElementById("sub-d-overnight").textContent));
    assert.equal(await page.locator('details.more[data-more="d-overnight"]').evaluate((d) => d.open), false);
    await openDetails(page, "d-overnight");
    const line = await page.textContent("#on-line");
    assert.match(line, /^Overnight: nothing prepared yet · next run 02:00$/);
    assert.equal(await page.locator("#on-body").isHidden(), true, "Details stay closed until asked");
    await page.click("#on-toggle");
    await page.waitForSelector("#on-body", { state: "visible" });
    assert.equal(await page.isChecked("#on-on"), true, "on by default");
    assert.equal(await page.inputValue("#on-from"), "02:00");
    assert.equal(await page.inputValue("#on-to"), "07:00");
    assert.equal(await page.inputValue("#on-pct"), "10");
    assert.match(await page.textContent("#on-budget"), /Disk budget [\d.]+ [GMK]?B \(10% of the free space\)/);
    assert.match(await page.textContent("#on-plan"), /No plan yet/);
    assert.match(await page.textContent("#on-runs"), /No run yet/);
    await assertNoHorizontalOverflow(page, `overnight ${name}`);
    await shot(page, `admin-overnight-${name}`, "#on-card");
    // a wrong budget is refused, in words
    await page.fill("#on-pct", "90");
    await page.click("#on-save");
    await toastSays(page, /Disk budget: a whole number from 1 to 50/);
    // a good one is kept
    await page.fill("#on-pct", "20");
    await page.fill("#on-from", "01:30");
    await page.selectOption("#on-ahead-n", "1");
    await page.click("#on-save");
    await toastSays(page, /^Saved$/);
    const st = await srv.api.adminGet("/api/admin/overnight");
    assert.deepEqual(st.settings, { on: true, from: "01:30", to: "07:00", budgetPct: 20, aheadEpisodes: 1 });
    await page.waitForFunction(() => /next run 01:30$/.test(document.getElementById("on-line").textContent));
    // (back to the defaults for the other tests)
    await srv.api.adminPost("/api/admin/overnight/settings", { on: true, from: "02:00", to: "07:00", budgetPct: 10, aheadEpisodes: 2 });
  });
}

ui.test("admin: Copy for Claude — the line, the settings and every list, as plain text", { permissions: ["clipboard-read", "clipboard-write"] }, async ({ page, srv }) => {
  await enter(page, srv);
  await page.click('.tab[data-tab="downloads"]');
  await page.click('details.more[data-more="d-overnight"] [data-copy-for="d-overnight"]');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).startsWith("## Overnight"), null, { timeout: 15000 });
  const text = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  assert.match(text, /^## Overnight\n_Aurora admin · .+_\n\nOvernight: .+ · next run \d\d:\d\d\n- switch: on\n- quiet hours: 02:00–07:00 \(server time\)/);
  assert.match(text, /- disk budget: [\d.]+ [GMK]?B \(10% of the free space\)/);
  assert.match(text, /- downloaded ahead: the next two episodes/);
  assert.match(text, /\nPrepared:\n\(none\)/);
  assert.match(text, /Tonight's plan: none yet/);
  assert.match(text, /Devices by person:/);
  assert.ok(!/undefined|NaN|\[object Object\]/.test(text), text);
});

ui.test("the real thing: Run now prepares a copy for this Chrome, and the next start plays it as a file — no live repackaging", async ({ page, srv, api, lib, freshProfile }) => {
  const film = lib.film2; // MKV, H.264 + two AC-3 tracks: Chrome repackages it live
  const viewer = await freshProfile();
  await signIn(page, srv, viewer);
  const streams = [];
  page.on("request", (r) => { const u = r.url(); if (/\/stream\//.test(u)) streams.push(u.replace(srv.url, "")); });
  // the title read carries this browser's report and the profile: the device is seen with the person
  await goto(page, srv, `#/movie/${film.id}`);
  const until = async (fn, what, ms = 60000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 300)); } };
  await until(async () => {
    const st = await api.adminGet("/api/admin/overnight");
    return (st.devices || []).some((d) => d.person === viewer.name && d.devices.some((x) => /^web/.test(x)));
  }, "this Chrome seen with the person");
  // part-way through it: the top of their Continue watching
  await api.setProgress(viewer, film.id, 20, 60);
  const r = await api.adminPost("/api/admin/overnight/run");
  assert.equal(r.ok, true);
  const st = await until(async () => {
    const s = await api.adminGet("/api/admin/overnight");
    return s.prepared.some((p) => p.id === film.id) && !s.making ? s : null;
  }, "the copy prepared", 90000);
  const prep = st.prepared.find((p) => p.id === film.id);
  assert.equal(prep.kind, "copy", "the picture copied, the sound made AAC: Chrome decodes H.264");
  assert.equal(prep.reason, "continue");
  assert.deepEqual(prep.people, [viewer.name]);
  assert.match(st.line, /^Overnight: 1 film prepared/);
  // the title read for this browser now names it
  const before = streams.length;
  const logFrom = srv.log().length;
  await goto(page, srv, `#/play/${film.id}`, { selector: ".player" });
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return !!v && v.currentTime > 0.5 && !v.paused; }, null, { timeout: 30000 });
  const src = await page.evaluate(() => document.querySelector(".player video").currentSrc);
  assert.match(src, /\/stream\/prepared\/[^?]+\?k=copy$/, src);
  const asked = streams.slice(before);
  assert.ok(!asked.some((u) => /\/stream\/(transcode|hls)\//.test(u)), `no live conversion was asked for: ${asked.join(", ")}`);
  const enc = await api.adminGet("/api/admin/encoding");
  assert.equal((enc.cpu && enc.cpu.viewers || []).length, 0, "no viewer encoder is running");
  await until(() => srv.log().slice(logFrom).some((l) => l.includes(`[play] ${film.id.slice(0, 12)}`) && /decision why=prepared overnight \(copy\)/.test(l)), "the decide step in the server's start-up marks", 10000);
  // the prepared file seeks natively, as a file
  await page.evaluate(() => { const v = document.querySelector(".player video"); v.currentTime = 40; });
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v.currentTime >= 40 && !v.seeking; }, null, { timeout: 15000 });
  await shot(page, "player-prepared");
  // the admin's line says it was played
  await until(async () => (await api.adminGet("/api/admin/overnight")).prepared.find((p) => p.id === film.id).usedAt, "the copy marked as played", 10000);
});

ui.run({ concurrency: 1 });
