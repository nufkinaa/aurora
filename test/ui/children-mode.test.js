// Children mode (2026-11-11, docs/children-mode.md) on the website: the
// account's own switch, from the profile menu (desktop), More (phone) and
// Settings.
//   - the first time on: who is watching + a passcode chosen twice; after that
//     ONE click (an age and Turn on), no passcode asked;
//   - on: the feed is filtered, the mint mark is on, the menu has no Switch
//     profile / downloads / Sign out; every other device signed in to the
//     account follows LIVE (the socket), and other accounts are untouched;
//   - a younger age is a tap; an older one, or leaving, takes the passcode;
//   - "Forgot the passcode?": the account's password turns it off.
// Ratings: Test Film One all ages, Test Show 7+, Test Film Two 18+.
const assert = require("node:assert/strict");
const { suite, signIn, waitForScreen, certificatesSeed, PHONE, assertNoHorizontalOverflow } = require("./helpers");

const ui = suite({
  server: { seed: { "cache/certificates.json": certificatesSeed({ film1: 0, show: 7, film2: 18 }) } },
  setup: async (srv) => {
    srv.profiles.dad = await srv.api.createProfile("Dad", { open: true });
  },
});

const gridIs = (page, want) =>
  page.waitForFunction((w) => JSON.stringify([...document.querySelectorAll("#app .screen > .grid .card")].map((c) => (c.getAttribute("aria-label") || "").split(",")[0])) === JSON.stringify(w), want, { timeout: 20000 });
// a picture or title the grown-up page asked for just before the switch, refused once it is on (the gate doing its job)
const REFUSED = /Failed to load resource.*403/;
const kidsOn = (page) => page.evaluate(() => document.documentElement.hasAttribute("data-kids"));
// The switch has been applied on this page (it says so: "Children mode is on — 7+" / "…is off")
const told = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("toasts").innerText), re.source, { timeout: 20000 });
const sheet = (page) => page.locator(".child-sheet");
const openFromMenu = async (page, line = /Children mode/) => {
  await page.click("#nav-profile");
  await page.locator(".nav-menu-child").filter({ hasText: line }).click();
  await sheet(page).waitFor();
};
// Another browser (its own storage) signed in to a profile.
const pageFor = async (srv, profile) => {
  const context = await ui.browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  await context.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await signIn(page, srv, profile);
  return { page, context };
};

ui.test("turning on: the first time asks who is watching and a passcode; the second time it is one click", { allow: [REFUSED] }, async ({ page, goto, signIn: enter, freshProfile, api }) => {
  const mum = await freshProfile();
  await enter(mum);
  await goto("#/movies");
  await gridIs(page, ["Test Film One", "Test Film Two"]);
  await openFromMenu(page);
  const s = sheet(page);
  assert.match(await s.textContent(), /Who is watching\?/);
  assert.deepEqual(await s.locator(".child-ages .chip").allTextContents(), ["All ages", "7+", "12+", "16+"]);
  assert.equal(await s.locator('[data-ui="child.on"]').isDisabled(), true, "Turn on waits for an age");
  await s.locator('.child-ages .chip[data-age="7"]').click();
  // the passcode, twice: a mismatch is caught here
  await s.locator(".child-code").nth(0).fill("2468");
  await s.locator(".child-code").nth(1).fill("2469");
  await s.locator('[data-ui="child.on"]').click();
  assert.match(await s.locator(".pw-error").textContent(), /don't match/);
  await s.locator(".child-code").nth(1).fill("2468");
  await s.locator('[data-ui="child.on"]').click();
  await s.waitFor({ state: "detached" });
  await told(page, /Children mode is on — 7+/);
  await goto("#/movies");
  await gridIs(page, ["Test Film One"]);

  // leave, then on again: no passcode asked
  await openFromMenu(page, /Leave Children mode/);
  await sheet(page).locator(".child-code").fill("2468");
  await sheet(page).locator('[data-ui="child.off"]').click();
  await told(page, /Children mode is off/);
  await openFromMenu(page);
  assert.equal(await sheet(page).locator(".child-code").count(), 0, "the passcode is remembered — not asked again");
  await sheet(page).locator('.child-ages .chip[data-age="0"]').click();
  await sheet(page).locator('[data-ui="child.on"]').click();
  await told(page, /Children mode is on — All ages/);
  const view = await page.evaluate(async (id) => (await fetch(`/api/profiles/${id}/child-mode`)).json(), mum.id);
  assert.deepEqual([view.on, view.maxAge, view.passcodeSet], [true, 0, true]);
  await goto("#/movies");
  await gridIs(page, ["Test Film One"]);
  assert.ok(api);
});

ui.test("live on every device of the account — and only that account", { allow: [REFUSED] }, async ({ page, goto, signIn: enter, freshProfile, srv, profiles }) => {
  const mum = await freshProfile();
  await enter(mum);
  await goto("#/movies");
  await gridIs(page, ["Test Film One", "Test Film Two"]);
  const other = await pageFor(srv, mum);   // mum's second device
  const dad = await pageFor(srv, profiles.dad);
  try {
    for (const p of [other.page, dad.page]) {
      await p.goto(`${srv.url}/#/movies`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await waitForScreen(p, { timeout: 30000 });
      await gridIs(p, ["Test Film One", "Test Film Two"]);
    }
    // on, from the first device
    await openFromMenu(page);
    await sheet(page).locator('.child-ages .chip[data-age="7"]').click();
    await sheet(page).locator(".child-code").nth(0).fill("1357");
    await sheet(page).locator(".child-code").nth(1).fill("1357");
    await sheet(page).locator('[data-ui="child.on"]').click();
    // the second device follows by itself (the socket), lands on Home, and is filtered
    await told(other.page, /Children mode is on — 7+/);
    await other.page.evaluate(() => { location.hash = "#/movies"; });
    await gridIs(other.page, ["Test Film One"]);
    // the second device's own pictures and video requests are locked too (its cookie)
    const lock = await other.page.evaluate(async () => (await (await fetch("/api/kids/status")).json()).lock);
    assert.equal(lock && lock.profile, mum.id);
    // dad's browser: untouched
    await dad.page.waitForTimeout(1500);
    assert.equal(await kidsOn(dad.page), false);
    await dad.page.evaluate(() => { location.hash = "#/shows"; });
    await dad.page.evaluate(() => { location.hash = "#/movies"; });
    await gridIs(dad.page, ["Test Film One", "Test Film Two"]);

    // off, from the SECOND device: the first follows
    await openFromMenu(other.page, /Leave Children mode/);
    await sheet(other.page).locator(".child-code").fill("1357");
    await sheet(other.page).locator('[data-ui="child.off"]').click();
    await told(page, /Children mode is off/);
    assert.equal(await page.evaluate(async () => (await (await fetch("/api/kids/status")).json()).lock), null, "the first device's lock is gone too");
    await goto("#/movies");
    await gridIs(page, ["Test Film One", "Test Film Two"]);
  } finally {
    await other.context.close();
    await dad.context.close();
  }
});

ui.test("while on: a younger age is a tap; an older one takes the passcode", { allow: [/Failed to load resource.*40[13]/] }, async ({ page, goto, signIn: enter, freshProfile }) => {
  const mum = await freshProfile();
  await enter(mum);
  await goto("#/");
  await page.evaluate(async (id) => fetch(`/api/profiles/${id}/child-mode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxAge: 12, newPasscode: "8642" }) }), mum.id);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-kids"));
  await goto("#/shows");
  await gridIs(page, ["Test Show"]);
  // younger: All ages, one tap, no passcode
  await openFromMenu(page, /Leave Children mode/);
  await sheet(page).locator('.child-ages .chip[data-age="0"]').click();
  await sheet(page).waitFor({ state: "detached" });
  await goto("#/shows");
  await gridIs(page, []);
  // older again: the passcode
  await openFromMenu(page, /Leave Children mode/);
  await sheet(page).locator('.child-ages .chip[data-age="12"]').click();
  assert.match(await sheet(page).textContent(), /Enter the passcode to allow 12\+/);
  await sheet(page).locator(".child-code").fill("1111");
  await sheet(page).locator('.btn-primary[data-ui="child.age"]').click();
  await sheet(page).locator(".pw-error").waitFor({ state: "visible" });
  await sheet(page).locator(".child-code").fill("8642");
  await sheet(page).locator('.btn-primary[data-ui="child.age"]').click();
  await sheet(page).waitFor({ state: "detached" });
  await goto("#/shows");
  await gridIs(page, ["Test Show"]);
});

ui.test("forgot the passcode: the account's own password turns Children mode off", { allow: [/Failed to load resource.*40[13]/] }, async ({ page, goto, signIn: enter, srv }) => {
  const mum = await srv.api.createProfile(`Mum${Date.now().toString(36).slice(-4)}`, { password: "mum-secret-9" });
  await enter(mum);
  await goto("#/");
  await page.evaluate(async (id) => fetch(`/api/profiles/${id}/child-mode`, { method: "POST", headers: { "Content-Type": "application/json", "X-Profile-Token": sessionStorage.getItem(`aurora-token-${id}`) }, body: JSON.stringify({ maxAge: 7, newPasscode: "2468" }) }), mum.id);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-kids"));
  await openFromMenu(page, /Leave Children mode/);
  await sheet(page).locator(".child-forgot").click();
  const pw = sheet(page).locator('input[type="password"]');
  await pw.fill("wrong-one");
  await sheet(page).locator('.btn-primary[data-ui="child.forgot"]').click();
  await sheet(page).locator(".pw-error").waitFor({ state: "visible" });
  assert.match(await sheet(page).locator(".pw-error").textContent(), /not the password/);
  await pw.fill("mum-secret-9");
  await sheet(page).locator('.btn-primary[data-ui="child.forgot"]').click();
  await told(page, /Children mode is off/);
  // the next "Turn on" asks for a new passcode
  await openFromMenu(page);
  assert.equal(await sheet(page).locator(".child-code").count(), 2);
});

// (REFUSED: a picture or a title the page asked for just before the switch
// is refused once Children mode is on — the gate doing its job)
ui.test("phone: More has the line, the ages sit on one row at 320 px, nothing spills", { viewport: { width: 320, height: 640 }, allow: [/Failed to load resource.*403/] }, async ({ page, goto, signIn: enter, freshProfile }) => {
  const mum = await freshProfile();
  await enter(mum);
  await goto("#/");
  await page.click("#nav-more");
  const line = page.locator('[data-more="children"]');
  await line.waitFor();
  assert.match(await line.textContent(), /Children mode/);
  await line.click();
  await sheet(page).waitFor();
  const tops = await sheet(page).locator(".child-ages .chip").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, `the four ages are on one row (${tops})`);
  await assertNoHorizontalOverflow(page);
  await sheet(page).locator('.child-ages .chip[data-age="7"]').click();
  await sheet(page).locator(".child-code").nth(0).fill("2468");
  await sheet(page).locator(".child-code").nth(1).fill("2468");
  await sheet(page).locator('[data-ui="child.on"]').click();
  await told(page, /Children mode is on/);
  await page.click("#nav-more");
  await page.locator('[data-more="children"]').waitFor();
  assert.match(await page.locator('[data-more="children"]').textContent(), /Leave Children mode/);
  assert.equal(await page.locator('[data-more="downloads"]').count(), 0, "no downloads in Children mode");
  assert.equal(await page.locator('[data-more="saved"]').count(), 0);
  assert.equal(await page.locator('[data-more="pair"]').count(), 0, "no signing in a TV in Children mode");
  assert.ok(PHONE);
});

ui.run({ concurrency: 2 });
