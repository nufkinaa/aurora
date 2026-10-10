// Signing a TV in from a phone: the address the TV prints ("open {host}/link
// and type this code") and the confirm screen its QR opens.
const assert = require("node:assert/strict");
const { suite, waitForScreen, assertNoHorizontalOverflow, PHONE } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    // A profile that signs in (a username on it), and a session of its own —
    // what a phone that is already signed in holds.
    const p = await srv.api.createProfile("Pairer");
    const claimed = await srv.api.post("/api/auth/claim", { profileId: p.id, username: "pairer" }, await srv.api.as(p));
    srv.profiles.pairer = { ...p, session: claimed.session };
  },
});

const MISS = /Failed to load resource.*\/api\/auth\/device\/describe/;
const card = ".pair-card";
const field = `${card} .pair-code-input`;
// what a TV does: ask for a code, then poll with its secret
const startPairing = (api) => api.post("/api/auth/device/start");

ui.test("/link with no code opens the code field; a typed code goes on to the same confirm screen the QR opens, and the TV is signed in once", {
  allow: [MISS],
}, async ({ page, context, srv, api, signIn, profiles }) => {
  await context.addCookies([{ name: "aurora_session", value: profiles.pairer.session, url: srv.url }]);
  await signIn(profiles.pairer);
  await page.goto(`${srv.url}/link`, { waitUntil: "domcontentloaded" });
  await waitForScreen(page);
  assert.equal(new URL(page.url()).hash, "#/pair", "the bare /link lands on the code field, not on Home");
  assert.equal((await page.textContent(`${card} h1`)).trim(), "Sign in a TV");

  // too short: answered at the field, nothing asked of the server
  await page.fill(field, "abc");
  await page.click(`${card} button:has-text("Continue")`);
  const err = page.locator(`${card} .pw-error`);
  await err.waitFor({ state: "visible" });
  assert.match(await err.textContent(), /6 letters and numbers/);

  // a well-formed code no TV is showing
  await page.fill(field, "ZZZZZZ");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /No TV is showing that code/.test(document.querySelector(".pair-card .pw-error").textContent));
  assert.equal(new URL(page.url()).hash, "#/pair", "a wrong code stays on the field");

  // the real one, typed the lazy way (lower case)
  const tv = await startPairing(api);
  assert.match(tv.code, /^[A-Z2-9]{6}$/);
  await page.fill(field, tv.code.toLowerCase());
  assert.equal(await page.inputValue(field), tv.code, "the field upper-cases as you type");
  await page.click(`${card} button:has-text("Continue")`);
  await page.waitForFunction((c) => location.hash === `#/pair/${c}`, tv.code);
  await page.waitForSelector(`${card} h1:has-text("Sign this TV in?")`);
  assert.equal((await page.textContent(`${card} .pair-code`)).trim(), tv.code);

  // not approved yet: the TV is still waiting
  assert.deepEqual(await api.post("/api/auth/device/poll", { code: tv.code, secret: tv.secret }), { pending: true });
  await page.click(`${card} button:has-text("sign it in as @pairer")`);
  await page.waitForSelector(`${card} h1:has-text("Done")`);

  // the TV's poll gets a session for that profile — once
  const got = await api.post("/api/auth/device/poll", { code: tv.code, secret: tv.secret });
  assert.equal(got.ok, true);
  assert.equal(got.profile.id, profiles.pairer.id);
  assert.match(got.session, /^[0-9a-f]{64}$/);
  assert.equal((await api.call("POST", "/api/auth/device/poll", { code: tv.code, secret: tv.secret })).status, 410, "a code is single-use");
});

ui.test("a typed code on a phone that is not signed in asks for the sign-in first, and never approves by itself", {
  viewport: PHONE,
}, async ({ page, srv, api, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await page.goto(`${srv.url}/link`, { waitUntil: "domcontentloaded" });
  await waitForScreen(page);
  await page.waitForSelector(field);
  await assertNoHorizontalOverflow(page, "the code field on a phone");
  const tv = await startPairing(api);
  await page.fill(field, tv.code);
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${card} h1:has-text("Sign in to approve")`);
  await assertNoHorizontalOverflow(page, "the confirm screen on a phone");
  assert.equal(await page.locator(`${card} button:has-text("sign it in as")`).count(), 0);
  assert.deepEqual(await api.post("/api/auth/device/poll", { code: tv.code, secret: tv.secret }), { pending: true });
});

ui.test("a code that has run out says so and offers the code field", {
  allow: [MISS],
}, async ({ page, signIn, freshProfile, goto }) => {
  await signIn(await freshProfile());
  await goto("#/pair/QQQQQQ");
  await page.waitForSelector(`${card} h1:has-text("That code expired")`);
  await page.click(`${card} button:has-text("Type a code")`);
  await page.waitForSelector(field);
  assert.equal(await page.evaluate(() => location.hash), "#/pair");
});

ui.run({ concurrency: 1 });
