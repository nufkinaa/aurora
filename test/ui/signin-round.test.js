// The sign-in round (auth-round, 2026-10-31; docs/auth-round.md), in a real
// browser against a private instance whose Google is the test stand-in
// (src/lib/googlemock.js — on only for private test instances):
//   - the sign-in and request-access screens: labels, autofill, Show/Hide,
//     Caps Lock, inline errors that keep what was typed, Enter, the switch;
//   - Google: a new account's request still needs a password; a Google-only
//     profile is asked for a first password;
//   - "Forgot password?": ask the admin (the screen goes on by itself when
//     approved), a reset code, Google; the wall's own "Forgot password?";
//   - phone sizes and right-to-left without sideways scrolling.
// AUTH_SHOTS=1 writes the screenshots in docs/qa/auth-round/after/.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, waitForScreen, PHONE, assertNoHorizontalOverflow } = require("./helpers");

const SHOTS = process.env.AUTH_SHOTS ? path.join(__dirname, "..", "..", "docs", "qa", "auth-round", "after") : null;
const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const ui = suite({
  server: {
    env: { AURORA_GOOGLE_MOCK: "1" },
    seed: {
      // a profile that signs in with Google only (the stand-in's "Cy Test"), no password
      "profiles.json": {
        profiles: [
          { id: "default00001", name: "Watcher", color: "#e05f2c", avatar: "W" },
          { id: "gonly0000001", name: "Cy", color: "#8b7bff", avatar: "C", username: "cy", email: "cy.test@example.test", googleSub: "mock-sub-cy", claimedAt: Date.now() },
        ],
        state: {}, pending: [], access: {},
      },
    },
  },
  setup: async (srv) => {
    const claimed = async (name) => {
      const p = await srv.api.createProfile(name);
      const username = name.toLowerCase();
      await srv.api.post("/api/auth/claim", { profileId: p.id, username }, await srv.api.as(p));
      return { ...p, username };
    };
    srv.profiles.dana = await claimed("Dana");
    srv.profiles.eli = await claimed("Eli");
    srv.profiles.fay = await claimed("Fay");
    srv.profiles.wally = await srv.api.createProfile("Wally"); // a password, no username: the wall only
  },
});

const setMode = (api, mode) => api.adminPost("/api/admin/auth-mode", { mode });
const WALL_401 = /Failed to load resource.*401/;
const card = ".login-card";
const inCard = (sel) => `${card} ${sel}`;
const fieldMsg = (page, name) => page.locator(`${card} .af-field:has(input[name="${name}"]) .af-msg`);
const openSignIn = async (page, goto) => {
  await goto("#/", { wait: false });
  await page.waitForSelector(inCard('input[name="identifier"]'));
};

ui.test("sign in: labels, autofill, Show/Hide, Caps Lock, the switch, and an error that keeps what was typed", {
  allow: [WALL_401],
}, async ({ page, goto, api, profiles }) => {
  await setMode(api, "closed");
  try {
    await openSignIn(page, goto);
    await shot(page, "web-desktop-signin");
    // every field has a visible label tied to it, and the autocomplete a password manager needs
    const fields = await page.$$eval(`${card} input.af-input`, (els) => els.map((i) => ({
      name: i.name, type: i.type, ac: i.autocomplete, label: (document.querySelector(`label[for="${i.id}"]`) || {}).textContent || "",
    })));
    assert.deepEqual(fields, [
      { name: "identifier", type: "text", ac: "username", label: "Username or email" },
      { name: "password", type: "password", ac: "current-password", label: "Password" },
    ]);
    // the switch is a tablist, the first door selected
    assert.deepEqual(await page.$$eval(`${card} [role="tab"]`, (t) => t.map((x) => [x.textContent, x.getAttribute("aria-selected")])), [["Sign in", "true"], ["Request access", "false"]]);
    // "Forgot password?" is drawn on the password's label line, but comes
    // after the password in the tab order (Tab from the username lands in it)
    const forgotBox = await page.locator(inCard('.af-field:has(input[name="password"]) .af-aside button:has-text("Forgot password?")')).boundingBox();
    const labelBox = await page.locator(inCard('.af-field:has(input[name="password"]) .af-label')).boundingBox();
    assert.ok(forgotBox && labelBox && forgotBox.y < labelBox.y + labelBox.height && forgotBox.y + forgotBox.height > labelBox.y, "on the label's line");
    await page.focus(inCard('input[name="identifier"]'));
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.name), "password", "Tab goes from the username to the password");
    // Show / Hide
    const pw = page.locator(inCard('input[name="password"]'));
    await pw.fill("secret-1");
    await page.click(inCard(".af-reveal"));
    assert.equal(await pw.getAttribute("type"), "text");
    // (the name says what a press does next, and holds the visible word)
    assert.equal(await page.getAttribute(inCard(".af-reveal"), "aria-label"), "Hide password");
    await page.click(inCard(".af-reveal"));
    assert.equal(await pw.getAttribute("type"), "password");
    // Caps Lock is said out loud
    await pw.focus();
    await page.keyboard.down("CapsLock");
    await page.keyboard.up("CapsLock");
    await pw.press("A");
    const capsShown = await page.locator(inCard(".af-caps")).isVisible();
    await page.keyboard.down("CapsLock");
    await page.keyboard.up("CapsLock");
    if (capsShown) assert.equal(await page.locator(inCard(".af-caps")).textContent(), "Caps Lock is on.");
    await pw.fill("");

    // empty: the error sits next to the field
    await page.click(inCard(".af-btn.primary"));
    assert.equal(await fieldMsg(page, "identifier").textContent(), "Enter your username or email.");
    assert.equal(await page.getAttribute(inCard('input[name="identifier"]'), "aria-invalid"), "true");
    // Enter moves from the name to the password, and Enter there sends
    await page.fill(inCard('input[name="identifier"]'), profiles.dana.username);
    await page.press(inCard('input[name="identifier"]'), "Enter");
    assert.equal(await page.evaluate(() => document.activeElement.name), "password");
    await page.keyboard.type("not-the-password");
    await page.keyboard.press("Enter");
    const err = page.locator(inCard(".af-formerr"));
    await err.waitFor();
    assert.match(await err.textContent(), /don't match\. Check them, or reset your password\./);
    // nothing typed was thrown away
    assert.equal(await page.inputValue(inCard('input[name="identifier"]')), profiles.dana.username);
    assert.equal(await page.inputValue(inCard('input[name="password"]')), "not-the-password");
    assert.equal(await page.isEnabled(inCard(".af-btn.primary")), true, "the button is back once the answer came");
    await shot(page, "web-desktop-signin-error");
    // the right password signs in
    await page.fill(inCard('input[name="password"]'), profiles.dana.password);
    await page.click(inCard(".af-btn.primary"));
    await waitForScreen(page);
    assert.equal(await page.textContent("#nav-profile-name"), "Dana");
  } finally {
    await setMode(api, "open");
  }
});

ui.test("request access (phone): the rules up front, a strength hint, errors in place, then Request sent", {
  viewport: PHONE, allow: [WALL_401],
}, async ({ page, goto, api }) => {
  await setMode(api, "closed");
  try {
    await openSignIn(page, goto);
    await shot(page, "web-phone-signin");
    await page.click(inCard('[role="tab"]:has-text("Request access")'));
    await page.waitForSelector(inCard('h1:has-text("Request access")'));
    await assertNoHorizontalOverflow(page, "request access");
    // the rule is on screen before anything is typed
    assert.equal(await fieldMsg(page, "password").textContent(), "At least 4 characters. Longer is stronger.");
    assert.equal(await page.getAttribute(inCard('input[name="email"]'), "inputmode"), "email");
    assert.equal(await page.getAttribute(inCard('input[name="password"]'), "autocomplete"), "new-password");
    await shot(page, "web-phone-request");
    await page.click(inCard(".af-btn.primary"));
    assert.equal(await fieldMsg(page, "name").textContent(), "Enter your name.");
    await page.fill(inCard('input[name="name"]'), "Gil");
    await page.fill(inCard('input[name="username"]'), "gil");
    await page.fill(inCard('input[name="password"]'), "abc");
    await page.click(inCard(".af-btn.primary"));
    assert.equal(await fieldMsg(page, "password").textContent(), "Use at least 4 characters.");
    await page.fill(inCard('input[name="password"]'), "gil1");
    assert.match(await page.textContent(inCard(".af-strength-word")), /Strength: Weak/);
    await page.fill(inCard('input[name="password"]'), "Long-Movie-Night-42");
    assert.match(await page.textContent(inCard(".af-strength-word")), /Strength: Strong/);
    await page.fill(inCard('input[name="confirm"]'), "Long-Movie-Night-41");
    await page.click(inCard(".af-btn.primary"));
    assert.equal(await fieldMsg(page, "confirm").textContent(), "The passwords don't match.");
    await shot(page, "web-phone-request-errors");
    await page.fill(inCard('input[name="confirm"]'), "Long-Movie-Night-42");
    await page.click(inCard(".af-btn.primary"));
    await page.waitForSelector(inCard('h1:has-text("Request sent")'));
    const req = (await api.adminGet("/api/admin/people")).requests.find((r) => r.name === "Gil");
    assert.ok(req, "the request reached the admin");
    await api.adminPost(`/api/admin/profile-requests/${req.id}/reject`);
  } finally {
    await setMode(api, "open");
  }
});

ui.test("Google sign-up: a new Google account's request still needs a password", {
  allow: [WALL_401, /status of 400.*\/api\/auth\/signup/],
}, async ({ page, goto, api }) => {
  await setMode(api, "closed");
  try {
    await openSignIn(page, goto);
    await page.click(inCard('[role="tab"]:has-text("Request access")'));
    const google = page.locator(inCard('.af-btn.google:has-text("Sign up with Google")'));
    await google.waitFor();
    const [popup] = await Promise.all([page.waitForEvent("popup"), google.click()]);
    await popup.waitForSelector("#acct-mock-sub-ana");
    await popup.click("#acct-mock-sub-ana");
    await page.waitForSelector(inCard('h1:has-text("Finish your request")'));
    assert.match(await page.textContent(inCard(".auth-verified")), /ana\.test@example\.test/);
    assert.equal(await page.inputValue(inCard('input[name="name"]')), "Ana Test");
    await shot(page, "web-desktop-google-finish");
    // no password: refused here, and by the server if anything got round the form
    await page.click(inCard(".af-btn.primary"));
    assert.equal(await fieldMsg(page, "password").textContent(), "Use at least 4 characters.");
    await page.fill(inCard('input[name="password"]'), "ana-pass-1");
    await page.fill(inCard('input[name="confirm"]'), "ana-pass-1");
    await page.click(inCard(".af-btn.primary"));
    await page.waitForSelector(inCard('h1:has-text("Request sent")'));
    const req = (await api.adminGet("/api/admin/people")).requests.find((r) => r.email === "ana.test@example.test");
    assert.equal(req.viaGoogle, true);
    await api.adminPost(`/api/admin/profile-requests/${req.id}/approve`);
    assert.equal((await api.call("POST", "/api/auth/login", { username: "ana.test@example.test", password: "ana-pass-1" })).status, 200, "the Google profile has its own password");
  } finally {
    await setMode(api, "open");
  }
});

ui.test("a Google-only profile is asked for a first password at its next Google sign-in, and goes in once it is set", {
  allow: [WALL_401, /Failed to load resource.*401/],
}, async ({ page, goto, api }) => {
  await setMode(api, "closed");
  try {
    await openSignIn(page, goto);
    const google = page.locator(inCard('.af-btn.google:has-text("Continue with Google")'));
    await google.waitFor();
    const [popup] = await Promise.all([page.waitForEvent("popup"), google.click()]);
    await popup.waitForSelector("#acct-mock-sub-cy");
    await popup.click("#acct-mock-sub-cy");
    const wall = ".reset-wall";
    await page.waitForSelector(`${wall} h1:has-text("Set a password")`);
    assert.match(await page.textContent(`${wall} .reset-wall-why`), /signs in with Google only/);
    assert.equal(await page.locator(`${wall} input[name="currentPassword"]`).count(), 0, "nothing to ask for: there is no password yet");
    await shot(page, "web-desktop-set-password");
    await page.fill(`${wall} input[name="newPassword"]`, "cy-pass-77");
    await page.fill(`${wall} input[name="confirm"]`, "cy-pass-77");
    await page.click(`${wall} button:has-text("Save password")`);
    await page.waitForSelector(wall, { state: "detached" });
    await waitForScreen(page);
    assert.equal(await page.textContent("#nav-profile-name"), "Cy");
    assert.equal((await api.call("POST", "/api/auth/login", { username: "cy", password: "cy-pass-77" })).status, 200);
  } finally {
    await setMode(api, "open");
  }
});

ui.test("forgot password (phone): ask the admin, the screen goes on by itself once approved, and the other devices are signed out", {
  viewport: PHONE, allow: [WALL_401],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.eli;
  const other = (await api.post("/api/auth/login", { username: p.username, password: p.password })).session;
  await setMode(api, "closed");
  try {
    await openSignIn(page, goto);
    await page.fill(inCard('input[name="identifier"]'), p.username);
    await page.click(inCard('button:has-text("Forgot password?")'));
    await page.waitForSelector(inCard('h1:has-text("Reset your password")'));
    assert.deepEqual(await page.$$eval(`${card} .auth-option-title`, (els) => els.map((e) => e.textContent)),
      ["Use Google", "Ask the admin", "I have a reset code"]);
    assert.match(await page.textContent(card), /Still signed in on your phone or computer\? Change it in Settings there\./);
    await assertNoHorizontalOverflow(page, "reset options");
    await shot(page, "web-phone-forgot");
    await page.click(inCard('.auth-option:has-text("Ask the admin")'));
    assert.equal(await page.inputValue(inCard('input[name="identifier"]')), p.username, "the name typed on sign-in came along");
    await page.click(inCard(".af-btn.primary"));
    await page.waitForSelector(inCard('h1:has-text("Request sent")'));
    await shot(page, "web-phone-ask-admin-waiting");
    const rr = (await api.adminGet("/api/admin/people")).resetRequests.find((r) => r.profileId === p.id);
    assert.ok(rr, "the admin sees it");
    const ap = await api.adminPost(`/api/admin/reset-requests/${rr.id}/approve`);
    assert.match(ap.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await page.waitForSelector(inCard('h1:has-text("Choose a new password")'), { timeout: 15000 });
    assert.equal(await page.isChecked("#af-signout-others"), true, "signing the others out is the default");
    await shot(page, "web-phone-new-password");
    await page.fill(inCard('input[name="newPassword"]'), "eli-new-pass");
    await page.fill(inCard('input[name="confirm"]'), "eli-new-pass");
    await page.click(inCard(".af-btn.primary"));
    await waitForScreen(page);
    assert.equal(await page.textContent("#nav-profile-name"), "Eli");
    assert.equal((await api.call("GET", "/api/me", undefined, { "X-Session": other })).body.user, null, "the other device was signed out");
    assert.equal((await api.call("POST", "/api/auth/login", { username: p.username, password: "eli-new-pass" })).status, 200);
    p.password = "eli-new-pass";
  } finally {
    await setMode(api, "open");
  }
});

ui.test("forgot password: a reset code from the admin; a wrong one is said next to the field", {
  allow: [WALL_401, /status of 400.*\/api\/auth\/reset\/code/],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.fay;
  await setMode(api, "closed");
  try {
    await openSignIn(page, goto);
    await page.click(inCard('button:has-text("Forgot password?")'));
    await page.click(inCard('.auth-option:has-text("I have a reset code")'));
    await page.fill(inCard('input[name="identifier"]'), p.username);
    await page.fill(inCard('input[name="code"]'), "AAAA-AAAA");
    await page.click(inCard(".af-btn.primary"));
    await page.waitForFunction(() => /didn't work/.test((document.querySelector('.login-card .af-field:has(input[name="code"]) .af-msg') || {}).textContent || ""));
    await shot(page, "web-desktop-code-wrong");
    const { code } = await api.adminPost(`/api/admin/profiles/${p.id}/reset-code`);
    await page.fill(inCard('input[name="code"]'), code.toLowerCase());
    await page.click(inCard(".af-btn.primary"));
    await page.waitForSelector(inCard('h1:has-text("Choose a new password")'));
    await page.fill(inCard('input[name="newPassword"]'), "fay-new-pass");
    await page.fill(inCard('input[name="confirm"]'), "fay-new-pass");
    await page.click(inCard(".af-btn.primary"));
    await waitForScreen(page);
    assert.equal(await page.textContent("#nav-profile-name"), "Fay");
    p.password = "fay-new-pass";
  } finally {
    await setMode(api, "open");
  }
});

ui.test("forgot password: Use Google, for a profile linked to Google", {
  allow: [WALL_401],
}, async ({ page, goto, api }) => {
  await setMode(api, "closed");
  try {
    await openSignIn(page, goto);
    await page.click(inCard('button:has-text("Forgot password?")'));
    const g = page.locator(inCard('.auth-option:has-text("Use Google")'));
    await g.waitFor();
    const [popup] = await Promise.all([page.waitForEvent("popup"), g.click()]);
    await popup.click("#acct-mock-sub-cy");
    await page.waitForSelector(inCard('h1:has-text("Choose a new password")'));
    assert.match(await page.textContent(card), /Google confirmed it's you/);
    await page.fill(inCard('input[name="newPassword"]'), "cy-reset-88");
    await page.fill(inCard('input[name="confirm"]'), "cy-reset-88");
    await page.click(inCard(".af-btn.primary"));
    await waitForScreen(page);
    assert.equal(await page.textContent("#nav-profile-name"), "Cy");
  } finally {
    await setMode(api, "open");
  }
});

ui.test("the profile wall's password has the same Forgot password? — a code, then straight into the profile", async ({ page, goto, api, profiles }) => {
  const p = profiles.wally;
  await goto("#/", { wait: false });
  await page.click(`.profile-tile[title="${p.name}"]`);
  await page.waitForSelector('.modal button:has-text("Forgot password?")');
  await page.click('.modal button:has-text("Forgot password?")');
  await page.waitForSelector(inCard('h1:has-text("Reset your password")'));
  assert.match(await page.textContent(card), new RegExp(`For “${p.name}”`));
  await page.click(inCard('.auth-option:has-text("I have a reset code")'));
  assert.equal(await page.locator(inCard('input[name="identifier"]')).count(), 0, "the profile is known: no name to type");
  const { code } = await api.adminPost(`/api/admin/profiles/${p.id}/reset-code`);
  await page.fill(inCard('input[name="code"]'), code);
  await page.click(inCard(".af-btn.primary"));
  await page.waitForSelector(inCard('h1:has-text("Choose a new password")'));
  await page.fill(inCard('input[name="newPassword"]'), "wally-new-1");
  await page.fill(inCard('input[name="confirm"]'), "wally-new-1");
  await page.click(inCard(".af-btn.primary"));
  await waitForScreen(page);
  assert.equal(await page.textContent("#nav-profile-name"), p.name);
  p.password = "wally-new-1";
});

ui.test("every step fits a small phone, right to left too", {
  viewport: { width: 320, height: 640 }, device: { hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, allow: [WALL_401],
}, async ({ page, goto, api }) => {
  await setMode(api, "closed");
  try {
    await openSignIn(page, goto);
    for (const dir of ["ltr", "rtl"]) {
      await page.evaluate((d) => { document.documentElement.dir = d; }, dir);
      await page.click(inCard('[role="tab"]:has-text("Sign in")')).catch(() => {});
      await assertNoHorizontalOverflow(page, `sign in ${dir}`);
      await page.click(inCard('[role="tab"]:has-text("Request access")'));
      await assertNoHorizontalOverflow(page, `request ${dir}`);
      await page.click(inCard('[role="tab"]:has-text("Sign in")'));
      await page.click(inCard('button:has-text("Forgot password?")'));
      await assertNoHorizontalOverflow(page, `forgot ${dir}`);
      // the panel never reaches past the screen's edges
      const box = await page.locator(card).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 320, `${dir}: the panel fits`);
      if (dir === "rtl") await shot(page, "web-phone320-rtl-forgot");
      await page.click(inCard('button:has-text("Back to sign in")'));
    }
    // tap targets: the buttons and links are big enough for a finger
    const small = await page.$$eval(`${card} button, ${card} a`, (els) => els
      .filter((e) => e.offsetParent)
      .map((e) => [e.textContent.trim(), e.getBoundingClientRect().height])
      .filter(([, h]) => h < 40));
    assert.deepEqual(small, [], "every control at least 40 px tall on a touch screen");
  } finally {
    await page.evaluate(() => { document.documentElement.dir = "ltr"; }).catch(() => {});
    await setMode(api, "open");
  }
});

ui.run({ concurrency: 1 });
