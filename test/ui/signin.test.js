// Sign-in modes other than "open": the login screen of a server that
// requires sign-in, and what happens to a signed-in tab when its sign-in is
// taken away. The mode is one switch for the whole private server, so these
// run one at a time and each sets the mode it needs.
const assert = require("node:assert/strict");
const { suite, waitForScreen } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    // profiles that sign in: a password and a username each
    const claimed = async (name) => {
      const p = await srv.api.createProfile(name);
      const username = name.toLowerCase();
      await srv.api.post("/api/auth/claim", { profileId: p.id, username }, await srv.api.as(p));
      return { ...p, username };
    };
    srv.profiles.reset = await claimed("Resetter");
    // a password, no username: the profile wall's unlock is its only way in
    srv.profiles.walled = await srv.api.createProfile("Walled");
    srv.profiles.mover = await claimed("Mover");
    srv.profiles.keeper = await claimed("Keeper");
  },
});

const setMode = (api, mode) => api.adminPost("/api/admin/auth-mode", { mode });
// Before the sign-in a closed server refuses the shell's own first requests
// (version, downloads, AI status): the browser prints a line for each.
const WALL_401 = /Failed to load resource.*401/;

const loginCard = ".login-card";
const signInWith = async (page, username, password) => {
  await page.waitForSelector(`${loginCard} input[placeholder="Username or email"]`);
  await page.fill(`${loginCard} input[placeholder="Username or email"]`, username);
  await page.fill(`${loginCard} input[placeholder="Password"]`, password);
  await page.click(`${loginCard} .lbtn.primary`);
};

ui.test("sign-in required: a forced password reset is asked for right after signing in, and saving it clears it", {
  allow: [WALL_401],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.reset;
  await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: true });
  await setMode(api, "closed");
  try {
    await goto("#/", { wait: false });
    await signInWith(page, p.username, p.password);

    // the same sheet the profile wall raises after an unlock
    const sheet = page.locator(".modal", { hasText: "Pick a new password" });
    await sheet.waitFor();
    await waitForScreen(page); // signed in: the app is up behind it
    assert.equal(await page.textContent("#nav-profile-name"), "Resetter");
    // the password was typed a moment ago: it is not asked for again
    assert.equal(await sheet.locator('input[type="password"]').count(), 2);
    assert.equal(await sheet.locator('input[placeholder="Current password"]').count(), 0);

    await sheet.locator('input[placeholder^="New password"]').fill("fresh-pass-1");
    await sheet.locator('input[placeholder="Once more"]').fill("fresh-pass-2");
    await sheet.locator('button:has-text("Save")').click();
    await sheet.locator(".pw-error", { hasText: "don't match" }).waitFor();
    await sheet.locator('input[placeholder="Once more"]').fill("fresh-pass-1");
    await sheet.locator('button:has-text("Save")').click();
    await sheet.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.getElementById("toasts").innerText.includes("New password saved"));

    // the server agrees: the old password is gone, the new one signs in with nothing due
    assert.equal((await api.call("POST", "/api/auth/login", { username: p.username, password: p.password })).status, 401);
    const again = await api.post("/api/auth/login", { username: p.username, password: "fresh-pass-1" });
    assert.equal(again.mustReset, false);
    p.password = "fresh-pass-1";

    // a reload stays signed in and asks for nothing
    await page.reload();
    await waitForScreen(page);
    assert.equal(await page.locator(".modal").count(), 0);
    assert.equal(await page.locator(loginCard).count(), 0);
  } finally {
    await setMode(api, "open");
  }
});

ui.test("the wall: after a forced reset is saved, the tab is still inside the profile (its unlock is renewed)", async ({ page, goto, api, profiles }) => {
  const p = profiles.walled;
  await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: true });
  await goto("#/", { wait: false });
  await page.click(`.profiles-gate .profile-tile[title="${p.name}"]`);
  await page.fill('.modal input[type="password"]', p.password);
  await page.click('.modal button:has-text("Unlock")');
  const sheet = page.locator(".modal", { hasText: "Pick a new password" });
  await sheet.waitFor();
  await sheet.locator('input[placeholder^="New password"]').fill("walled-new-1");
  await sheet.locator('input[placeholder="Once more"]').fill("walled-new-1");
  await sheet.locator('button:has-text("Save")').click();
  await sheet.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.getElementById("toasts").innerText.includes("New password saved"));
  p.password = "walled-new-1";
  // Saving a password ends every unlock of the profile, this tab's included:
  // the tab must hold a fresh one, or everything it asks for next is refused.
  const status = await page.evaluate(async (id) => {
    const t = sessionStorage.getItem(`aurora-token-${id}`);
    return (await fetch(`/api/profiles/${id}/state`, { headers: t ? { "X-Profile-Token": t } : {} })).status;
  }, p.id);
  assert.equal(status, 200, "the tab's unlock token still opens the profile");
  await goto("#/list");
  await page.waitForFunction(() => document.getElementById("app").innerText.includes("My List"));
  await page.reload();
  await waitForScreen(page);
  assert.equal(await page.locator(".profiles-gate").count(), 0, "a reload stays inside");
});

// Another device of the same person: a sign-in of its own, by the API.
const otherDevice = async (api, p) => {
  const r = await api.post("/api/auth/login", { username: p.username, password: p.password });
  return { session: r.session, headers: { "X-Session": r.session } };
};
const toastSays = (page, text) =>
  page.waitForFunction((t) => document.getElementById("toasts").innerText.includes(t), text);

ui.test("\"Sign out everywhere else\" on another device sends this tab to the sign-in screen at once", {
  allow: [WALL_401],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.mover;
  await setMode(api, "closed");
  try {
    await goto("#/", { wait: false });
    await signInWith(page, p.username, p.password);
    await waitForScreen(page);
    const phone = await otherDevice(api, p);
    // The tab's socket connected before the sign-in; it has to have connected
    // again, signed in, for the server to know it as this profile's (a closed
    // server drops what a stranger's socket says). Wait for that.
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 40; i++) {
        const people = await api.adminGet("/api/admin/people");
        if ((people.clients || []).some((c) => c.profile === p.name)) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("the signed-in tab never showed up among the connected clients");
    });

    const r = await api.post(`/api/profiles/${p.id}/signout-everywhere`, {}, phone.headers);
    assert.ok(r.ended >= 1, "the tab's session was ended");
    assert.equal(r.told, 1, "one socket — the tab's — was told");
    await toastSays(page, "signed out from another device");
    await page.waitForSelector(loginCard, { timeout: 10000 });
    assert.equal(await page.locator("#app .screen").count(), 0, "nothing of the app is left behind the sign-in screen");
  } finally {
    await setMode(api, "open");
  }
});

ui.test("the tab that presses \"Sign out everywhere else\" stays signed in; the other device is out", {
  allow: [WALL_401],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.keeper;
  await setMode(api, "closed");
  try {
    await goto("#/", { wait: false });
    await signInWith(page, p.username, p.password);
    await waitForScreen(page);
    const tv = await otherDevice(api, p);
    assert.ok((await api.get("/api/me", tv.headers)).user, "the other device is signed in");

    await goto("#/preferences");
    const more = page.locator(".pref-more-toggle");
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    const button = page.locator('#app button:has-text("Sign out everywhere else")');
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await toastSays(page, "Signed out");
    assert.equal((await api.get("/api/me", tv.headers)).user, null, "the other device's session is gone");

    // this tab: no sign-in screen, no reload, and its requests still go through
    await page.waitForTimeout(2500);
    assert.equal(await page.locator(loginCard).count(), 0);
    assert.equal(await page.locator("#toasts", { hasText: "signed out from another device" }).count(), 0);
    const status = await page.evaluate(async (id) => (await fetch(`/api/profiles/${id}/state`)).status, p.id);
    assert.equal(status, 200);
    await goto("#/list");
    await page.waitForFunction(() => document.getElementById("app").innerText.includes("My List"));
  } finally {
    await setMode(api, "open");
  }
});

ui.run({ concurrency: 1 });
