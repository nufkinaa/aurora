// Settings: every section renders, switches flip and stay flipped across
// navigation and a reload, the look changes, the notifications switch copes
// with a browser that says no.
const assert = require("node:assert/strict");
const { suite, waitForScreen, PHONE, assertNoHorizontalOverflow } = require("./helpers");

const ui = suite();

// What the page is made of: three sections up front, the rest behind "More settings".
const UP_FRONT = ["Your profile", "Appearance", "Watching", "Subtitles"];
// (A "Sign-in" section joins these once sign-in mode is transition/closed;
// the private instance runs in mode "open", where it is not rendered.)
const BEHIND_MORE = ["Your home page", "Downloads", "Internet", "Watch without internet", "Privacy", "What's new"];

const headings = (page, onlyVisible = false) =>
  page.evaluate((onlyVisible) => [...document.querySelectorAll("#app .pref-section")]
    .filter((s) => !onlyVisible || s.offsetParent !== null)
    .map((s) => (s.querySelector(".pref-head") || {}).textContent.trim()), onlyVisible);
const sw = (label) => `#app button[role="switch"][aria-label="${label}"]`;
// the rows are built after the screen appears (some wait on the server)
const SWITCHES = 8;
const ready = (page) => page.waitForFunction((n) => document.querySelectorAll('#app button[role="switch"]').length >= n, SWITCHES);
const openMore = async (page) => {
  await ready(page);
  const more = page.locator(".pref-more-toggle");
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await page.waitForSelector(".pref-more.open");
};

ui.test("every section renders, and More settings opens the rest", async ({ page, goto, signIn, freshProfile }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/preferences");
  assert.match(await page.textContent(".browse-head"), new RegExp(`Settings\\s*for ${me.name}`));
  assert.equal(await page.textContent(".pref-profile-name"), me.name);

  const all = await headings(page);
  for (const name of [...UP_FRONT, ...BEHIND_MORE]) assert.ok(all.includes(name), `no "${name}" section; the page has ${JSON.stringify(all)}`);

  const more = page.locator(".pref-more-toggle");
  assert.equal(await more.getAttribute("aria-expanded"), "false");
  const before = await headings(page, true);
  for (const name of UP_FRONT) assert.ok(before.includes(name), `"${name}" should be visible without opening More settings`);
  for (const name of BEHIND_MORE) assert.ok(!before.includes(name), `"${name}" is visible before More settings is opened`);

  await more.click();
  assert.equal(await more.getAttribute("aria-expanded"), "true");
  await page.waitForFunction((want) => {
    const seen = [...document.querySelectorAll("#app .pref-section")].filter((s) => s.offsetParent !== null).map((s) => s.querySelector(".pref-head").textContent.trim());
    return want.every((w) => seen.includes(w));
  }, BEHIND_MORE);
  // no section is an empty shell
  const empty = await page.evaluate(() => [...document.querySelectorAll("#app .pref-section")]
    .filter((s) => s.offsetParent !== null && s.innerText.trim().length <= s.querySelector(".pref-head").textContent.trim().length)
    .map((s) => s.querySelector(".pref-head").textContent.trim()));
  assert.deepEqual(empty, [], "sections with nothing in them");

  // open stays open on the next visit
  await goto("#/movies");
  await goto("#/preferences");
  assert.equal(await page.locator(".pref-more-toggle").getAttribute("aria-expanded"), "true");
});

ui.test("the page fits a phone, sections and all", { viewport: PHONE }, async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/preferences");
  await assertNoHorizontalOverflow(page, "Settings");
  await openMore(page);
  await assertNoHorizontalOverflow(page, "Settings with More settings open");
  assert.ok((await headings(page, true)).length >= 9);
});

ui.test("every switch flips, and stays flipped across navigation and a reload", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/preferences");
  await openMore(page);
  // (the notifications switch asks the browser first, and "Help improve
  // Aurora" does not persist — a reported bug: each has its own test below)
  const labels = (await page.evaluate(() => [...document.querySelectorAll('#app button[role="switch"]')].map((b) => b.getAttribute("aria-label"))))
    .filter((l) => l !== "Tell me when it's ready" && l !== "Help improve Aurora");
  for (const want of ["Trailers on the home page", "Play the next episode", "Subtitles on by themselves", "Dark box behind subtitles", "Get the next episode ready", "Tidy up after watching"]) {
    assert.ok(labels.includes(want), `no "${want}" switch; found ${JSON.stringify(labels)}`);
  }

  const read = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#app button[role="switch"]')].map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-checked")])));
  const start = await read();
  for (const label of labels) {
    const flipped = start[label] === "true" ? "false" : "true";
    await page.click(sw(label));
    await page.waitForFunction(([sel, v]) => document.querySelector(sel).getAttribute("aria-checked") === v, [sw(label), flipped]);
    // the word on the switch agrees with its state
    assert.equal((await page.textContent(sw(label))).trim(), flipped === "true" ? "On" : "Off", label);
  }
  const want = Object.fromEntries(labels.map((l) => [l, start[l] === "true" ? "false" : "true"]));
  const only = (o) => Object.fromEntries(labels.map((l) => [l, o[l]]));

  // the two that live on the profile reached the server
  await page.waitForFunction(async (id) => {
    const p = ((await (await fetch("/api/profiles")).json()).find((x) => x.id === id).prefs) || {};
    return p.smartDownloads === false;
  }, me.id);

  await goto("#/movies");
  await goto("#/preferences");
  await ready(page);
  assert.deepEqual(only(await read()), want, "after going to Movies and back");

  await page.reload();
  await waitForScreen(page);
  await ready(page);
  assert.deepEqual(only(await read()), want, "after a reload");
  assert.equal((await api.profile(me.id)).prefs.smartDownloads, false);

  // and back again: a switch is not a one-way door
  await openMore(page);
  for (const label of labels) {
    await page.click(sw(label));
    await page.waitForFunction(([sel, v]) => document.querySelector(sel).getAttribute("aria-checked") === v, [sw(label), start[label]]);
  }
  assert.deepEqual(only(await read()), only(start));
});

// APPLICATION BUG (reported, not fixed here). Settings → Privacy → "Help
// improve Aurora" saves { prefs: { usageStats: false } } with PUT
// /api/profiles/:id, but profiles.update() in src/profiles.js only keeps the
// boolean prefs it names — ["smartDownloads", "smartCleanup"] — so the server
// drops it without a word. The switch reads Off until the page is loaded
// again; then it is On, and usage events are sent again (public/js/usage.js
// reads the same field). The opt-out does not survive a reload or reach
// another device.
ui.test("turning \"Help improve Aurora\" off survives a reload", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/preferences");
  await openMore(page);
  const label = "Help improve Aurora";
  assert.equal(await page.getAttribute(sw(label), "aria-checked"), "true");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/profiles/${me.id}`));
  await page.click(sw(label));
  await page.waitForFunction((sel) => document.querySelector(sel).getAttribute("aria-checked") === "false", sw(label));
  await saved;
  assert.equal((await api.profile(me.id)).prefs.usageStats, false, "the server did not keep the opt-out");
  await page.reload();
  await waitForScreen(page);
  await ready(page);
  assert.equal(await page.getAttribute(sw(label), "aria-checked"), "false", "the switch is back On after a reload");
});

ui.test("\"Play the next episode\" is the player's own autoplay setting", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/preferences");
  await ready(page);
  const stored = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem("aurora-player") || "{}").autoplayNext; } catch { return "unreadable"; } });
  assert.notEqual(await stored(), false);
  await page.click(sw("Play the next episode"));
  await page.waitForFunction((sel) => document.querySelector(sel).getAttribute("aria-checked") === "false", sw("Play the next episode"));
  assert.equal(await stored(), false);
});

ui.test("Subtitle language cycles, and is saved on the profile", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/preferences");
  const row = page.locator('#app .pref-item:has(.pref-item-label:text-is("Subtitle language"))');
  const value = row.locator(".pref-item-value");
  const first = (await value.textContent()).trim();
  const seen = [first];
  for (let i = 0; i < 6; i++) {
    const was = (await value.textContent()).trim();
    await value.click();
    await page.waitForFunction(([w]) => {
      const rows = [...document.querySelectorAll("#app .pref-item")].filter((r) => r.querySelector(".pref-item-label").textContent === "Subtitle language");
      return rows.length && rows[0].querySelector(".pref-item-value").textContent.trim() !== w;
    }, [was]);
    const now = (await value.textContent()).trim();
    if (now === first) break;
    seen.push(now);
  }
  assert.ok(seen.length >= 3, `the row only ever showed ${JSON.stringify(seen)}`);
  assert.ok(seen.some((s) => /Hebrew/i.test(s)) && seen.some((s) => /English/i.test(s)), JSON.stringify(seen));

  // settle on Hebrew and check it rode to the server
  for (let i = 0; i < 6 && !/Hebrew/i.test(await value.textContent()); i++) await value.click();
  await page.waitForFunction(async (id) => ((await (await fetch("/api/profiles")).json()).find((x) => x.id === id).prefs || {}).subLang === "he", me.id);
  assert.equal((await api.profile(me.id)).prefs.subLang, "he");
});

ui.test("the look can be switched to Legacy and back; it is on the page at once and on the profile", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/preferences");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.look), "glass");
  const pick = (name) => page.locator("#app .look-pick", { hasText: name });

  await pick("Legacy").click();
  await page.waitForFunction(() => !document.documentElement.dataset.look);
  await page.waitForFunction(() => /\bon\b/.test([...document.querySelectorAll("#app .look-pick")].find((b) => /Legacy/.test(b.textContent)).className));
  assert.equal((await api.profile(me.id)).look, "legacy");
  // the choice is there before the stylesheets on the next cold load
  await page.reload();
  await waitForScreen(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.look), undefined);

  await pick("Glass").click();
  await page.waitForFunction(() => document.documentElement.dataset.look === "glass");
  assert.equal((await api.profile(me.id)).look, "glass");
});

ui.test("the notifications switch, in a browser that refuses: a toast, the switch stays off, nothing throws", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  // The viewer answers "Block" to the browser's question. (Playwright can
  // grant a permission but has no way to deny one, and a real prompt would
  // sit there for ever in a headed run — so the answer is given here.)
  await page.addInitScript(() => {
    if ("Notification" in window) Notification.requestPermission = () => Promise.resolve("denied");
  });
  await goto("#/preferences");
  await openMore(page);
  assert.notEqual(await page.evaluate(() => Notification.permission), "granted");

  const toggle = page.locator(sw("Tell me when it's ready"));
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click();
  await page.waitForFunction(() => /Notifications are blocked for Aurora/.test(document.getElementById("toasts").innerText));
  assert.equal(await toggle.getAttribute("aria-checked"), "false", "the switch says On in a browser that refused");
  assert.notEqual(await page.evaluate(() => localStorage.getItem("aurora-notify-ready")), "1");
  // (the wrapper fails this test on any uncaught error or console.error)
});

ui.test("Sign out everywhere else keeps this device in", async ({ page, goto, signIn, freshProfile, t }) => {
  await signIn(await freshProfile());
  await goto("#/preferences");
  await openMore(page);
  const btn = page.locator('#app button:has-text("Sign out everywhere else")');
  if ((await btn.count()) === 0) {
    // The button belongs to the signed-in view of the Sign-in section, which
    // only exists once sign-in mode is "transition"/"closed" and the profile
    // has been claimed. The private instance runs in mode "open".
    t.skip("not rendered in sign-in mode \"open\" (needs a claimed profile in transition/closed mode)");
    return;
  }
  await btn.click();
  await page.waitForFunction(() => /signed out|Signed out/.test(document.getElementById("toasts").innerText));
  await goto("#/movies");
  await page.waitForSelector(".grid .card");
  assert.equal(await page.locator(".profiles-gate").count(), 0, "this device was signed out too");
});

ui.run({ concurrency: 3 });
