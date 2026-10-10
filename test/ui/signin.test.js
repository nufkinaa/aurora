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
    srv.profiles.leaver = await claimed("Leaver");
    // a password, no username: the profile wall's unlock is its only way in
    srv.profiles.walled = await srv.api.createProfile("Walled");
    srv.profiles.walledOut = await srv.api.createProfile("Walkout");
    srv.profiles.live = await srv.api.createProfile("Livewire");
    srv.profiles.stub = await srv.api.createProfile("Stubbed", { open: true });
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

// ---------- the forced password reset: a screen that cannot be got round ----------
const wall = ".reset-wall";
const wallButtons = (page) => page.evaluate(() => [...document.querySelectorAll(".reset-wall button")].map((b) => b.textContent.trim()));
// Everything a person can try to make the screen go away. None of it may.
const tryToDismiss = async (page) => {
  await page.keyboard.press("Escape");            // in a field: leaves the field
  await page.keyboard.press("Escape");            // outside one: the app's Back
  await page.mouse.click(8, 8);                   // "outside" the sheet
  await page.mouse.click(1270, 710);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("ui-back", { cancelable: true })));
  await page.evaluate(() => { location.hash = "#/movies"; });
  await page.evaluate(() => history.back());      // the browser's Back button
  await page.waitForTimeout(400);
  assert.equal(await page.locator(wall).count(), 1, "the screen is still there");
  assert.equal(await page.locator(`${wall} .modal`).isVisible(), true);
  // nothing of the app can be reached behind it
  assert.equal(await page.evaluate(() => {
    const top = document.elementFromPoint(640, 30);
    return !!top && !!top.closest(".reset-wall");
  }), true, "the screen covers the app's navigation");
};
const refusedInPage = (page, url, token = null) => page.evaluate(async ({ url, token }) => {
  const r = await fetch(url, { headers: token ? { "X-Profile-Token": token } : {} });
  const b = await r.json().catch(() => ({}));
  return { status: r.status, reset: b.passwordResetRequired === true };
}, { url, token });
const RESET_401 = /Failed to load resource.*401/;

ui.test("sign-in required: a forced reset blocks everything after signing in — no way round it, a reload and a deep link come back to it, and saving it lets the tab in", {
  allow: [WALL_401],
}, async ({ page, goto, api, srv, profiles }) => {
  const p = profiles.reset;
  const forced = await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: true });
  assert.equal(forced.mustReset, true);
  await setMode(api, "closed");
  try {
    await goto("#/", { wait: false });
    await signInWith(page, p.username, p.password);

    await page.waitForSelector(wall);
    assert.match(await page.textContent(`${wall} h2`), /Pick a new password/);
    assert.match(await page.textContent(`${wall} .reset-wall-why`), /signed out everywhere/);
    // two things on offer, and no way to close it
    assert.deepEqual(await wallButtons(page), ["Set new password", "Sign out"]);
    // the password was typed a moment ago: it is not asked for again
    assert.equal(await page.locator(`${wall} input[type="password"]`).count(), 2);
    // the app is not up behind it: nothing was entered
    assert.equal(await page.locator("#app .screen").count(), 0);
    // and the server means it: this sign-in opens nothing
    for (const url of ["/api/library", "/api/home", `/api/profiles/${p.id}/state`, `/img/${srv.lib.film1.id}`, `/stream/${srv.lib.film1.id}`]) {
      assert.deepEqual(await refusedInPage(page, url), { status: 401, reset: true }, url);
    }
    await tryToDismiss(page);

    // a reload: the same screen (now it has to ask for the current password), not the sign-in screen, not the app
    await page.reload();
    await page.waitForSelector(wall);
    assert.equal(await page.locator(loginCard).count(), 0);
    assert.equal(await page.locator("#app .screen").count(), 0);
    assert.equal(await page.locator(`${wall} input[placeholder="Current password"]`).count(), 1);
    assert.deepEqual(await wallButtons(page), ["Set new password", "Sign out"]);
    // a deep link, opened cold
    await page.goto(`${srv.url}/#/movie/${srv.lib.film1.id}`);
    await page.waitForSelector(wall);
    assert.equal(await page.locator("#app .screen").count(), 0);
    await tryToDismiss(page);

    // what it refuses to save
    const cur = page.locator(`${wall} input[placeholder="Current password"]`);
    const fresh = page.locator(`${wall} input[placeholder^="New password"]`);
    const again = page.locator(`${wall} input[placeholder="Once more"]`);
    const save = page.locator(`${wall} button:has-text("Set new password")`);
    const says = (text) => page.locator(`${wall} .pw-error`, { hasText: text }).waitFor();
    await save.click();
    await says("current password first");
    await cur.fill(p.password);
    await fresh.fill("abc");
    await save.click();
    await says("At least 4");
    await fresh.fill("fresh-pass-1");
    await again.fill("fresh-pass-2");
    await save.click();
    await says("don't match");
    await fresh.fill(p.password);
    await again.fill(p.password);
    await save.click();
    await says("old password");
    await cur.fill("not-my-password");
    await fresh.fill("fresh-pass-1");
    await again.fill("fresh-pass-1");
    await save.click();
    await says("not the current password");
    assert.equal((await api.adminGet("/api/admin/people")).people.find((x) => x.id === p.id).mustReset, true, "still pending");

    // and what it saves: straight into the app, no sign-in screen, no wall
    await cur.fill(p.password);
    await save.click();
    await page.waitForSelector(wall, { state: "detached" });
    await page.waitForFunction(() => document.getElementById("toasts").innerText.includes("New password saved"));
    await waitForScreen(page);
    assert.equal(await page.textContent("#nav-profile-name"), "Resetter");
    assert.equal(await page.locator(loginCard).count(), 0);
    assert.equal((await refusedInPage(page, "/api/library")).status, 200);

    // the server agrees: the old password is gone, the new one signs in with nothing due
    assert.equal((await api.call("POST", "/api/auth/login", { username: p.username, password: p.password })).status, 401);
    const next = await api.post("/api/auth/login", { username: p.username, password: "fresh-pass-1" });
    assert.equal(next.mustReset, false);
    assert.equal((await api.adminGet("/api/admin/people")).people.find((x) => x.id === p.id).mustReset, false);
    p.password = "fresh-pass-1";

    // a reload stays signed in and asks for nothing
    await page.reload();
    await waitForScreen(page);
    assert.equal(await page.locator(wall).count(), 0);
    assert.equal(await page.locator(loginCard).count(), 0);
  } finally {
    await setMode(api, "open");
  }
});

ui.test("sign-in required: \"Sign out\" on the reset screen goes back to the sign-in screen, and the reset is still due", {
  allow: [WALL_401],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.leaver;
  await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: true });
  await setMode(api, "closed");
  try {
    await goto("#/", { wait: false });
    await signInWith(page, p.username, p.password);
    await page.waitForSelector(wall);
    await page.click(`${wall} button:has-text("Sign out")`);
    await page.waitForSelector(loginCard, { timeout: 10000 });
    assert.equal(await page.locator(wall).count(), 0);
    assert.equal(await page.locator("#app .screen").count(), 0);
    assert.equal(await page.evaluate(async () => (await (await fetch("/api/me")).json()).user), null, "the browser holds no sign-in");
    assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), null);
    assert.equal((await api.adminGet("/api/admin/people")).people.find((x) => x.id === p.id).sessions, 0, "the restricted sign-in ended on the server");
    // signing in again meets the same screen
    await signInWith(page, p.username, p.password);
    await page.waitForSelector(wall);
  } finally {
    await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: false });
    await setMode(api, "open");
  }
});

ui.test("the wall: unlocking a profile that owes a new password meets the same screen — reload keeps it, saving enters the profile and stays in", {
  allow: [RESET_401],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.walled;
  await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: true });
  await goto("#/", { wait: false });
  await page.click(`.profiles-gate .profile-tile[title="${p.name}"]`);
  await page.fill('.modal input[type="password"]', p.password);
  await page.click('.modal button:has-text("Unlock")');
  await page.waitForSelector(wall);
  assert.deepEqual(await wallButtons(page), ["Set new password", "Sign out"]);
  assert.equal(await page.locator(`${wall} input[type="password"]`).count(), 2, "the password just typed is not asked for again");
  assert.equal(await page.locator("#app .screen").count(), 0, "the profile was not entered");
  // the unlock this tab was handed opens nothing on the server
  const held = await page.evaluate((id) => sessionStorage.getItem(`aurora-token-${id}`), p.id);
  assert.ok(held);
  for (const url of ["/api/library", `/api/profiles/${p.id}/state`, `/api/profiles/${p.id}/watchlist`]) {
    assert.deepEqual(await refusedInPage(page, url, held), { status: 401, reset: true }, url);
  }
  await tryToDismiss(page);

  // a reload does not drop the tab back at the wall with the question forgotten
  await page.reload();
  await page.waitForSelector(wall);
  assert.equal(await page.locator(".profiles-gate").count(), 0);
  assert.equal(await page.locator("#app .screen").count(), 0);
  assert.equal(await page.locator(`${wall} input[placeholder="Current password"]`).count(), 1);

  await page.fill(`${wall} input[placeholder="Current password"]`, p.password);
  await page.fill(`${wall} input[placeholder^="New password"]`, "walled-new-1");
  await page.fill(`${wall} input[placeholder="Once more"]`, "walled-new-1");
  await page.click(`${wall} button:has-text("Set new password")`);
  await page.waitForSelector(wall, { state: "detached" });
  await page.waitForFunction(() => document.getElementById("toasts").innerText.includes("New password saved"));
  p.password = "walled-new-1";
  await waitForScreen(page);
  assert.equal(await page.textContent("#nav-profile-name"), "Walled");
  assert.equal(await page.locator(".profiles-gate").count(), 0, "no bounce through the wall");
  // the tab holds a fresh unlock: what it asks for next goes through
  const status = await page.evaluate(async (id) => {
    const t = sessionStorage.getItem(`aurora-token-${id}`);
    return (await fetch(`/api/profiles/${id}/state`, { headers: t ? { "X-Profile-Token": t } : {} })).status;
  }, p.id);
  assert.equal(status, 200, "the tab's unlock token opens the profile");
  await goto("#/list");
  await page.waitForFunction(() => document.getElementById("app").innerText.includes("My List"));
  await page.reload();
  await waitForScreen(page);
  assert.equal(await page.locator(".profiles-gate").count(), 0, "a reload stays inside");
  assert.equal(await page.locator(wall).count(), 0);
});

ui.test("the wall: \"Sign out\" on the reset screen goes back to the profile wall; the profile stays locked until a new password is set", {
  allow: [RESET_401],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.walledOut;
  await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: true });
  await goto("#/", { wait: false });
  await page.click(`.profiles-gate .profile-tile[title="${p.name}"]`);
  await page.fill('.modal input[type="password"]', p.password);
  await page.click('.modal button:has-text("Unlock")');
  await page.waitForSelector(wall);
  const held = await page.evaluate((id) => sessionStorage.getItem(`aurora-token-${id}`), p.id);
  await page.click(`${wall} button:has-text("Sign out")`);
  // (the wall was already drawn behind the screen: wait for the reload, not for a tile)
  await page.waitForSelector(wall, { state: "detached" });
  await page.waitForSelector(`.profiles-gate .profile-tile[title="${p.name}"]`);
  assert.equal(await page.locator(wall).count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), null);
  assert.equal(await page.evaluate((id) => sessionStorage.getItem(`aurora-token-${id}`), p.id), null);
  // the unlock it held is over on the server too, and the profile's data stays shut
  assert.equal((await api.call("GET", `/api/profiles/${p.id}/state`, undefined, { "X-Profile-Token": held })).status, 401);
  assert.equal((await api.adminGet("/api/admin/people")).people.find((x) => x.id === p.id).mustReset, true);
  // another profile on the same browser is nobody's business
  await page.click(`.profiles-gate .profile-tile[title="${profiles.stub.name}"]`);
  await waitForScreen(page);
  assert.equal(await page.textContent("#nav-profile-name"), profiles.stub.name);
});

ui.test("a tab that is inside the profile when the admin forces the reset is put out at once, and meets the screen when it comes back", {
  allow: [RESET_401],
}, async ({ page, goto, api, signIn, profiles }) => {
  const p = profiles.live;
  await signIn(p);
  await goto("#/");
  assert.equal(await page.textContent("#nav-profile-name"), p.name);
  // the tab's socket has said who it is
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 40; i++) {
      const people = await api.adminGet("/api/admin/people");
      if ((people.clients || []).some((c) => c.profile === p.name)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("the tab never showed up among the connected clients");
  });
  const r = await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: true });
  assert.equal(r.kicked, 1, "the tab's socket was told");
  await toastSays(page, "asked for a new password");
  // out: the profile wall, nothing of the app left
  await page.waitForSelector(`.profiles-gate .profile-tile[title="${p.name}"]`, { timeout: 10000 });
  assert.equal(await page.locator("#app .screen").count(), 0);
  // back in with the current password: the screen, not the app
  await page.click(`.profiles-gate .profile-tile[title="${p.name}"]`);
  await page.fill('.modal input[type="password"]', p.password);
  await page.click('.modal button:has-text("Unlock")');
  await page.waitForSelector(wall);
  assert.equal(await page.locator("#app .screen").count(), 0);
  await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: false });
});

ui.test("a refusal that says a new password is due raises the screen over a running app, whatever the page", {
  allow: [RESET_401],
}, async ({ page, goto, signIn, profiles }) => {
  // (the server's answers are stood in for: once a reset is forced a tab is
  // signed out first, so a running tab only meets the refusal in a race —
  // this is that race, held still)
  const p = profiles.stub;
  await signIn(p);
  await goto("#/movies");
  await page.route("**/api/me", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ authMode: "open", user: null, passwordResetRequired: true, resetProfile: { id: p.id, name: p.name, avatar: "🦊", color: "#2c9fe0" } }),
  }));
  await page.route(`**/api/profiles/${p.id}/watchlist`, (route) => route.fulfill({
    status: 401, contentType: "application/json",
    body: JSON.stringify({ error: "A new password is needed before this profile can be used again.", signinRequired: true, passwordResetRequired: true, profileId: p.id }),
  }));
  await goto("#/list", { wait: false });
  await page.waitForSelector(wall);
  assert.deepEqual(await wallButtons(page), ["Set new password", "Sign out"]);
  assert.match(await page.textContent(`${wall} .reset-wall-why`), new RegExp(p.name));
  assert.equal(await page.locator(`${wall} input[placeholder="Current password"]`).count(), 1);
  await tryToDismiss(page);
  // one screen, however many requests were refused
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.dispatchEvent(new CustomEvent("aurora-password-reset", { detail: {} })); });
  await page.waitForTimeout(300);
  assert.equal(await page.locator(wall).count(), 1);
});

ui.test("transition mode: a password-less profile does not open while the wall's check fails, and goes on once it is answered", {
  allow: [/Failed to load resource.*\/unlock/],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.stub;
  await setMode(api, "transition");
  try {
    const seen = [];
    page.on("response", (r) => {
      const path = new URL(r.url()).pathname;
      if (/^\/api\/profiles\/[^/]+\/unlock$/.test(path)) seen.push(`unlock ${r.status()}`);
      else if (/^\/api\/auth\/claimable\//.test(path)) seen.push(`claimable ${r.status()}`);
    });
    await goto("#/", { wait: false });
    const tile = `.profiles-gate .profile-tile[title="${p.name}"]`;
    await page.waitForSelector(tile);
    await page.route("**/api/profiles/*/unlock", (route) => route.abort("connectionrefused"));
    await page.click(tile);
    const notice = page.locator(".profiles-gate .profiles-notice");
    await notice.waitFor({ state: "visible" });
    assert.match(await notice.textContent(), /^Can't reach the server — try again\./);
    assert.equal(await page.locator("#app .screen").count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("aurora-profile")), null);
    assert.deepEqual(seen, [], "nothing went on to the one-time sign-in step either");

    await page.unroute("**/api/profiles/*/unlock");
    await notice.locator("button").click();
    // answered: the door's next step in this mode is the one-time sign-in setup
    await page.waitForFunction(() => !!document.querySelector(".modal") || !!document.querySelector("#app .screen"));
    await page.waitForFunction(() => true); // (let the last response land in `seen`)
    assert.deepEqual(seen.slice(0, 2), ["unlock 200", "claimable 200"]);
    assert.equal(await notice.isVisible(), false);
  } finally {
    await setMode(api, "open");
  }
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

ui.test("the server starts to require sign-in under an open tab: the tab goes to the sign-in screen", {
  allow: [WALL_401],
}, async ({ page, goto, api, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/");
  try {
    await setMode(api, "closed");
    // the next thing the viewer does is refused by the wall
    await goto("#/list", { wait: false });
    await toastSays(page, "sign in again");
    await page.waitForSelector(loginCard, { timeout: 10000 });
    assert.equal(await page.locator("#app .screen").count(), 0);
  } finally {
    await setMode(api, "open");
  }
});

ui.run({ concurrency: 1 });
