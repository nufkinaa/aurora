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

ui.run({ concurrency: 1 });
