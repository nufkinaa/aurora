// Boot and the profile wall: who is watching, unlocking a protected profile,
// the one-time notices, switching profile.
const assert = require("node:assert/strict");
const { suite, waitForScreen } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    // "Watcher" is the profile every fresh server starts with: no password,
    // and it has not seen the "new look" note yet.
    srv.profiles.watcher = { id: "default", name: "Watcher", password: "" };
    srv.profiles.locked = await srv.api.createProfile("Locked");
    srv.profiles.open = await srv.api.createProfile("Open", { open: true });
  },
});

const gate = ".profiles-gate";
const tile = (name) => `${gate} .profile-tile[title="${name}"]`;

ui.test("the wall lists every profile, marks the protected one, and offers Add profile", async ({ page, goto }) => {
  await goto("#/", { wait: false });
  await page.waitForSelector(`${gate} h1`);
  assert.equal(await page.textContent(`${gate} h1`), "Who's watching?");
  for (const name of ["Watcher", "Locked", "Open"]) await page.waitForSelector(tile(name));
  assert.equal(await page.locator(`${tile("Locked")} .profile-lock`).count(), 1, "the protected profile shows a lock");
  assert.equal(await page.locator(`${tile("Open")} .profile-lock`).count(), 0);
  assert.equal(await page.locator(`${gate} .profile-tile.add`).count(), 1);
  // nothing behind the wall has been rendered yet
  assert.equal(await page.locator("#app .screen").count(), 0);
});

ui.test("a wrong password shows the error and does not enter; the right one does", {
  allow: [/Failed to load resource.*401.*\/unlock/],
}, async ({ page, goto, profiles }) => {
  await goto("#/", { wait: false });
  await page.click(tile("Locked"));
  const input = page.locator('.modal input[type="password"]');
  await input.waitFor();

  await input.fill("definitely-wrong");
  await page.click('.modal button:has-text("Unlock")');
  const err = page.locator(".modal .pw-error");
  await err.waitFor({ state: "visible" });
  assert.match(await err.textContent(), /Try again/);
  assert.equal(await input.inputValue(), "", "the field is cleared for another try");
  assert.equal(await page.locator(gate).count(), 1, "still at the wall");
  assert.equal(await page.locator("#app .screen").count(), 0, "nothing was entered");
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), null);

  await input.fill(profiles.locked.password);
  await input.press("Enter");
  await page.waitForSelector(gate, { state: "detached" });
  await waitForScreen(page);
  assert.equal(await page.textContent("#nav-profile-name"), "Locked");
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), profiles.locked.id);
});

ui.test("a reload of a protected profile stays in (this tab still holds its unlock)", async ({ page, goto, profiles }) => {
  await goto("#/", { wait: false });
  await page.click(tile("Locked"));
  await page.fill('.modal input[type="password"]', profiles.locked.password);
  await page.click('.modal button:has-text("Unlock")');
  await waitForScreen(page);
  await page.reload();
  await waitForScreen(page);
  assert.equal(await page.locator(gate).count(), 0);
  assert.equal(await page.textContent("#nav-profile-name"), "Locked");
});

ui.test("the one-time notices appear once, do not block, and stay dismissed", async ({ page, goto, api }) => {
  // (no signIn(): this browser has never been here, so every first-visit note is due)
  await goto("#/", { wait: false });
  await page.click(tile("Watcher"));
  await waitForScreen(page);

  // "Aurora has a new look", once per profile
  const notice = page.locator(".look-notice");
  await notice.waitFor({ timeout: 5000 });
  assert.match(await notice.textContent(), /new look/);
  // it describes what is there: Home has no "Tonight row"
  assert.doesNotMatch(await notice.textContent(), /Tonight row/);
  await page.click('.look-notice button:has-text("Got it")');
  await page.waitForSelector(".look-notice-wrap", { state: "detached" });
  await page.waitForFunction(async () => (await (await fetch("/api/profiles")).json()).find((p) => p.id === "default").lookNoticeSeen === true);

  // the app underneath is live: a nav click goes somewhere
  await page.click('#nav a[data-route="#/movies"]');
  await page.waitForFunction(() => location.hash === "#/movies");
  await waitForScreen(page);
  await page.waitForSelector('.grid .card[aria-label^="Test Film One"]');

  // not again on the next load
  await page.reload();
  await waitForScreen(page);
  await page.waitForTimeout(1500); // the note is scheduled 900 ms after entry
  assert.equal(await page.locator(".look-notice").count(), 0, "the note came back after a reload");
  assert.equal((await api.profile("default")).lookNoticeSeen, true);
});

ui.test("Switch profile: the menu opens the wall, Escape leaves it, picking another profile enters it", async ({ page, goto, signIn, profiles }) => {
  await signIn(profiles.open);
  await goto("#/movies");
  assert.equal(await page.textContent("#nav-profile-name"), "Open");

  await page.click("#nav-profile");
  await page.click('.nav-menu button:has-text("Switch profile")');
  await page.waitForSelector(tile("Locked"));
  // opened over a running app, the wall can be dismissed
  await page.keyboard.press("Escape");
  await page.waitForSelector(gate, { state: "detached" });
  assert.equal(await page.evaluate(() => location.hash), "#/movies", "dismissing the wall leaves you where you were");

  await page.click("#nav-profile");
  await page.click('.nav-menu button:has-text("Switch profile")');
  await page.click(tile("Locked"));
  await page.fill('.modal input[type="password"]', profiles.locked.password);
  await page.click('.modal button:has-text("Unlock")');
  await page.waitForSelector(gate, { state: "detached" });
  await page.waitForFunction(() => document.getElementById("nav-profile-name").textContent === "Locked");
  assert.equal(await page.evaluate(() => location.hash), "#/", "a new profile starts at Home");
  await waitForScreen(page);
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), profiles.locked.id);
});

ui.test("a remembered open profile skips the wall", async ({ page, goto, signIn, profiles }) => {
  await signIn(profiles.open);
  await goto("#/");
  assert.equal(await page.locator(gate).count(), 0);
  assert.equal(await page.textContent("#nav-profile-name"), "Open");
  await page.waitForSelector(".hero .hero-title");
});

ui.run({ concurrency: 2 });
