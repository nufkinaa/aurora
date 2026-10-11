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
    // password-less profiles for the tests that make the wall's check fail
    srv.profiles.unsure = await srv.api.createProfile("Unsure", { open: true });
    srv.profiles.changed = await srv.api.createProfile("Changed", { open: true });
    srv.profiles.frozen = await srv.api.createProfile("Frozen", { open: true });
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

ui.test("the password sheet says why it failed: too many attempts, a locked profile, no server — not \"Not quite\"", {
  allow: [/Failed to load resource.*(429|403|503).*\/unlock/, /Failed to load resource.*\/unlock/],
}, async ({ page, goto, profiles }) => {
  await goto("#/", { wait: false });
  await page.click(tile("Locked"));
  const input = page.locator('.modal input[type="password"]');
  await input.waitFor();
  const err = page.locator(".modal .pw-error");
  const answer = async (status, body) => {
    await page.unroute("**/api/profiles/*/unlock").catch(() => {});
    await page.route("**/api/profiles/*/unlock", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
  };
  const attempt = async () => {
    await input.fill(profiles.locked.password);
    await page.click('.modal button:has-text("Unlock")');
    await err.waitFor({ state: "visible" });
    return (await err.textContent()).trim();
  };

  // the server has stopped taking guesses for a while (its own words)
  await answer(429, { error: "too many attempts — try again in a few minutes" });
  assert.equal(await attempt(), "Too many attempts — try again in a few minutes.");
  assert.equal(await input.inputValue(), profiles.locked.password, "the password was not the problem: it is left in the field");

  // the admin locked the profile after the wall was drawn
  await answer(403, { error: "locked by admin" });
  assert.match(await attempt(), /^This profile has been locked\./);

  // the server fell over
  await answer(503, { error: "" });
  assert.match(await attempt(), /^Couldn't reach Aurora/);

  // and a wrong password is still a wrong password
  await page.unroute("**/api/profiles/*/unlock");
  await input.fill("definitely-wrong");
  await page.click('.modal button:has-text("Unlock")');
  await page.waitForFunction(() => /Not quite/.test(document.querySelector(".modal .pw-error").textContent));
  assert.equal(await input.inputValue(), "");
  assert.equal(await page.locator(gate).count(), 1, "still at the wall");
});

// A profile with no password is still asked about at the server before it
// opens, and only a yes opens it. (It used to open on any failure of that
// check — no server, a lock, a password set a moment ago.)
ui.test("a password-less profile does not open while the server cannot confirm it — the wall says so, and Try again opens it once it can", {
  allow: [/Failed to load resource.*\/unlock/],
}, async ({ page, goto, profiles }) => {
  const p = profiles.unsure;
  await goto("#/", { wait: false });
  await page.waitForSelector(tile(p.name));
  const notice = page.locator(`${gate} .profiles-notice`);
  const notIn = async (why) => {
    assert.equal(await page.locator(gate).count(), 1, `${why}: still at the wall`);
    assert.equal(await page.locator("#app .screen").count(), 0, `${why}: nothing was entered`);
    assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), null, `${why}: no profile was remembered`);
  };
  const failWith = async (how) => {
    await page.unroute("**/api/profiles/*/unlock").catch(() => {});
    await page.route("**/api/profiles/*/unlock", how);
  };

  // no answer at all (the server is out of reach)
  await failWith((route) => route.abort("connectionrefused"));
  await page.click(tile(p.name));
  await notice.waitFor({ state: "visible" });
  assert.match(await notice.textContent(), /^Can't reach the server — try again\./);
  assert.equal(await notice.locator("button").textContent(), "Try again");
  await notIn("no connection");

  // the server fell over: the same — no answer is not a yes
  await failWith((route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "" }) }));
  await notice.locator("button").click();
  await page.waitForTimeout(300);
  await notice.waitFor({ state: "visible" });
  assert.match(await notice.textContent(), /^Can't reach the server — try again\./);
  await notIn("503");

  // it has stopped taking tries for a while: its own words, and a way to try again
  await failWith((route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "too many attempts — try again in a few minutes" }) }));
  await page.click(tile(p.name));
  await page.waitForFunction(() => /^Too many attempts — try again in a few minutes\./.test((document.querySelector(".profiles-notice") || {}).textContent || ""));
  await notIn("429");

  // picking another profile clears what was said about this one
  await failWith((route) => route.abort("connectionrefused"));
  await page.click(tile(profiles.open.name));
  await page.waitForFunction(() => /Can't reach the server/.test((document.querySelector(".profiles-notice") || {}).textContent || ""));
  await notIn("another profile, still no connection");

  // the check goes through: Try again opens the profile that was asked for last
  await page.unroute("**/api/profiles/*/unlock");
  await notice.locator("button").click();
  await page.waitForSelector(gate, { state: "detached" });
  await waitForScreen(page);
  assert.equal(await page.textContent("#nav-profile-name"), profiles.open.name);
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), profiles.open.id);
});

ui.test("a password-less profile that got a password, or was locked, since the wall was drawn does not open on the old picture", {
  allow: [/Failed to load resource.*(401|403).*\/unlock/],
}, async ({ page, goto, api, profiles }) => {
  await goto("#/", { wait: false });
  await page.waitForSelector(tile(profiles.changed.name));
  await page.waitForSelector(tile(profiles.frozen.name));
  assert.equal(await page.locator(`${tile(profiles.changed.name)} .profile-lock`).count(), 0, "drawn as a profile with no password");

  // a password is set on it from another device
  await api.post(`/api/profiles/${profiles.changed.id}/password`, { newPassword: "now-private-1", currentPassword: "" });
  profiles.changed.password = "now-private-1";
  await page.click(tile(profiles.changed.name));
  // not entered: the wall catches up (the tile shows its lock) and asks for the password
  const pw = page.locator('.modal input[type="password"]');
  await pw.waitFor();
  assert.equal(await page.locator("#app .screen").count(), 0);
  assert.equal(await page.locator(`${tile(profiles.changed.name)} .profile-lock`).count(), 1);
  await pw.fill("now-private-1");
  await page.click('.modal button:has-text("Unlock")');
  await page.waitForSelector(gate, { state: "detached" });
  await waitForScreen(page);
  assert.equal(await page.textContent("#nav-profile-name"), profiles.changed.name);

  // the admin locks a profile under a wall that still shows it open
  await page.click("#nav-profile");
  await page.click('.nav-menu button:has-text("Switch profile")');
  await page.waitForSelector(tile(profiles.frozen.name));
  await api.adminPost(`/api/admin/profiles/${profiles.frozen.id}/lock`, { locked: true });
  try {
    await page.click(tile(profiles.frozen.name));
    const notice = page.locator(`${gate} .profiles-notice`);
    await notice.waitFor({ state: "visible" });
    assert.match(await notice.textContent(), /“Frozen” has been locked\./);
    assert.equal(await notice.locator("button").count(), 0, "trying again cannot help");
    assert.equal(await page.locator(gate).count(), 1);
    assert.equal(await page.textContent("#nav-profile-name"), profiles.changed.name, "still the profile it was in");
    assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), profiles.changed.id);
  } finally {
    await api.adminPost(`/api/admin/profiles/${profiles.frozen.id}/lock`, { locked: false });
  }
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
