// Boot's first questions are asked from the page itself, before any code has
// arrived (public/index.html "Boot's first questions", public/js/api.js
// takeEarly): who am I, the profiles, the remembered profile's history, Home.
// What that must not do, whatever the server's sign-in mode and whoever the
// visitor is: show the wrong screen for a moment, raise a toast, report an
// "error" for a refusal it had coming, ask a question twice — or act for the
// visitor (a must-reset profile's sign-in ends when its device "asks for the
// wall's list": an early question is not that — src/lib/resetgate.js).
//
// The sign-in mode is one switch for the whole private server: one at a time.
const assert = require("node:assert/strict");
const { suite, waitForScreen } = require("./helpers");

const PIN = "2468";
const ui = suite({
  setup: async (srv) => {
    const claimed = async (name) => {
      const p = await srv.api.createProfile(name);
      const username = name.toLowerCase();
      await srv.api.post("/api/auth/claim", { profileId: p.id, username }, await srv.api.as(p));
      return { ...p, username };
    };
    srv.profiles.regular = await claimed("Regular");
    srv.profiles.lapsed = await claimed("Lapsed");
    srv.profiles.owing = await claimed("Owing");
    srv.profiles.grown = await srv.api.createProfile("Grown", { open: true });
    srv.profiles.small = await srv.api.createProfile("Small", { open: true });
    const kids = await srv.api.call("GET", "/api/kids/status");
    srv.kidsAvailable = kids.status === 200 && Array.isArray(kids.body.ages);
    if (srv.kidsAvailable) {
      await srv.api.adminPost("/api/admin/kids-pin", { pin: PIN });
      await srv.api.adminPost(`/api/admin/profiles/${srv.profiles.small.id}/kids`, { kids: { maxAge: 7 } });
    }
  },
});

const setMode = (api, mode) => api.adminPost("/api/admin/auth-mode", { mode });
// a closed server refuses the shell's own first requests (version, downloads,
// AI status) until somebody signs in: the browser prints a line for each
const WALL_401 = /Failed to load resource.*401/;
const loginCard = ".login-card";
const wall = ".reset-wall";
const signInWith = async (page, username, password) => {
  await page.waitForSelector(`${loginCard} input[placeholder="Username or email"]`);
  await page.fill(`${loginCard} input[placeholder="Username or email"]`, username);
  await page.fill(`${loginCard} input[placeholder="Password"]`, password);
  await page.click(`${loginCard} .lbtn.primary`);
};

// Everything a load asked the server's API, and everything that ever showed:
// which of the app's big surfaces were in the page at any moment, and every
// toast. Call before the first goto(); `mark()` starts a new load's record.
const QUESTIONS = { me: /\/api\/me$/, info: /\/api\/server-info$/, profiles: /\/api\/profiles$/, state: /\/api\/profiles\/[^/]+\/state$/, home: /\/api\/home\?/ };
const record = async (page) => {
  const log = { asked: [], refused: [] };
  page.on("request", (req) => {
    const path = req.url().replace(/^https?:\/\/[^/]+/, "");
    if (!path.startsWith("/api/") || req.method() !== "GET") return;
    log.asked.push({ path, early: req.headers()["x-early"] === "1", token: !!req.headers()["x-profile-token"] });
  });
  page.on("response", (res) => {
    if (res.status() === 401) log.refused.push(res.url().replace(/^https?:\/\/[^/]+/, ""));
  });
  await page.addInitScript(() => {
    const seen = (window.__seen = { surfaces: [], toasts: [] });
    const WATCH = { login: ".login-card", gate: ".profiles-gate", reset: ".reset-wall", screen: "#app .screen", error: "#app .empty" };
    const look = () => {
      for (const [name, sel] of Object.entries(WATCH)) if (!seen.surfaces.includes(name) && document.querySelector(sel)) seen.surfaces.push(name);
      const t = document.getElementById("toasts");
      if (t) for (const el of t.children) { const s = el.textContent.trim(); if (s && !seen.toasts.includes(s)) seen.toasts.push(s); }
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  });
  const of = (name) => log.asked.filter((a) => QUESTIONS[name].test(a.path));
  return {
    log,
    mark: () => { log.asked.length = 0; log.refused.length = 0; },
    of,
    early: (name) => of(name).filter((a) => a.early).length,
    late: (name) => of(name).filter((a) => !a.early).length,
    seen: () => page.evaluate(() => window.__seen),
  };
};
// what the error reports hold about the boot questions (telemetry.js counts a
// refused request by its shape)
const reportedAboutBoot = (page) => page.evaluate(async () => {
  const tel = await import("/js/telemetry.js");
  // every kind of fault this page has counted, sent or not: "kind|message|where|status"
  return [...tel._state.book.seen].filter((s) => /\/api\/(me|server-info|profiles|home)/.test(s));
});

ui.test("sign-in required, a first visit: the sign-in screen, and nothing was asked that it could not answer", {
  allow: [WALL_401],
}, async ({ page, goto, api }) => {
  await setMode(api, "closed");
  try {
    const r = await record(page);
    await goto("#/", { wait: false });
    await page.waitForSelector(loginCard);
    await page.waitForTimeout(600);
    assert.equal(r.early("me"), 1, "who am I: asked from the page");
    assert.equal(r.late("me"), 0, "...and not a second time by boot");
    assert.equal(r.early("info"), 1);
    for (const q of ["profiles", "state", "home"]) assert.equal(r.of(q).length, 0, `${q} was asked of a server that would refuse it`);
    const seen = await r.seen();
    assert.deepEqual(seen.surfaces, ["login"], "only the sign-in screen ever showed");
    assert.deepEqual(seen.toasts, []);
    assert.deepEqual(await reportedAboutBoot(page), []);
    // the picture proxy is behind the wall like every other picture: a
    // stranger cannot use this server to fetch from the hosts on its list
    const status = (url) => page.evaluate(async (u) => (await fetch(u)).status, url);
    assert.equal(await status(`/img/ext?u=${encodeURIComponent("https://episodes.metahub.space/tt0000004/1/2/w780.jpg")}`), 401);
    assert.equal(await status(`/img/ext?u=${encodeURIComponent("https://image.tmdb.org/t/p/w500/x.jpg")}&w=240`), 401);
    assert.equal(await status("/sw-manifest.json"), 200, "the shell's own list of its files is not data");
  } finally {
    await setMode(api, "open");
  }
});

ui.test("sign-in required, a signed-in visitor comes back: straight to Home, every boot question asked once — from the page — and none refused", {
  allow: [WALL_401],
}, async ({ page, goto, api, profiles }) => {
  const p = profiles.regular;
  await setMode(api, "closed");
  try {
    const r = await record(page);
    await goto("#/", { wait: false });
    await signInWith(page, p.username, p.password);
    await waitForScreen(page);
    assert.equal(await page.evaluate(() => localStorage.getItem("aurora-authmode")), "closed");
    assert.equal(await page.evaluate(() => localStorage.getItem("aurora-early")), "token");

    r.mark();
    await page.reload();
    await waitForScreen(page);
    await page.waitForSelector("#app .screen .hero-title, #app .screen .card");
    assert.equal(await page.textContent("#nav-profile-name"), "Regular");
    for (const q of ["me", "info", "profiles", "state", "home"]) assert.equal(r.early(q), 1, `${q}: asked from the page`);
    // boot took each of those answers instead of asking again (the history is
    // read a second time by design: once to prove the unlock token, once on entry)
    for (const q of ["me", "profiles", "home"]) assert.equal(r.late(q), 0, `${q}: asked a second time`);
    assert.ok(r.late("state") <= 1);
    assert.ok(r.of("me")[0].token && r.of("state")[0].token && r.of("home")[0].token, "asked with the tab's unlock token, as boot asks");
    assert.deepEqual(r.log.refused, [], "nothing was refused");
    const seen = await r.seen();
    assert.deepEqual(seen.surfaces, ["screen"], "no sign-in screen, no profile wall on the way in");
    assert.deepEqual(seen.toasts, []);
    assert.deepEqual(await reportedAboutBoot(page), []);
  } finally {
    await setMode(api, "open");
  }
});

ui.test("sign-in required, the session ran out while the device was away: the sign-in screen at once — no flash of the app, no toast, nothing reported — and the next load asks nothing it cannot have", {
  allow: [WALL_401],
}, async ({ page, context, goto, api, srv, profiles }) => {
  const p = profiles.lapsed;
  await setMode(api, "closed");
  try {
    const r = await record(page);
    await goto("#/", { wait: false });
    await signInWith(page, p.username, p.password);
    await waitForScreen(page);
    // The device goes away (an open tab would be told, and leave by itself —
    // signin.test.js); the session ends on the server; the browser still
    // holds its cookie and everything it remembers.
    await page.goto("about:blank");
    const cookie = (await context.cookies(srv.url)).map((c) => `${c.name}=${c.value}`).join("; ");
    assert.equal((await api.call("POST", "/api/auth/logout", {}, { cookie })).status, 200);
    assert.equal((await api.call("GET", "/api/library", undefined, { cookie })).status, 401, "the session is gone");

    r.mark();
    await page.goto(`${srv.url}/#/`);
    await page.waitForSelector(loginCard);
    await page.waitForTimeout(600);
    let seen = await r.seen();
    assert.deepEqual(seen.surfaces, ["login"], "the sign-in screen and nothing before it");
    assert.deepEqual(seen.toasts, [], "no toast about requests that were bound to be refused");
    assert.equal(r.late("me"), 0);
    // this one load asked as the remembered profile (it could not know) — the
    // page's own early requests, which no screen and no error report ever sees
    assert.ok(r.log.refused.every((u) => /^\/api\//.test(u)));
    assert.deepEqual(await reportedAboutBoot(page), [], "an expected refusal is not an error report");
    assert.equal(await page.evaluate(() => localStorage.getItem("aurora-early")), null, "the device has learned it is signed out");

    // from now on: the two questions a stranger may ask, nothing else
    r.mark();
    await page.reload();
    await page.waitForSelector(loginCard);
    await page.waitForTimeout(600);
    for (const q of ["profiles", "state", "home"]) assert.equal(r.of(q).length, 0, `${q} was asked again`);
    assert.deepEqual(r.log.refused.filter((u) => /\/api\/(me|server-info|profiles|home)/.test(u)), []);
    seen = await r.seen();
    assert.deepEqual(seen.surfaces, ["login"]);

    // and signing in is what it always was
    await signInWith(page, p.username, p.password);
    await waitForScreen(page);
    assert.equal(await page.textContent("#nav-profile-name"), "Lapsed");
  } finally {
    await setMode(api, "open");
  }
});

ui.test("a new password is due: the page's early questions do not end the sign-in it will be saved with — reload after reload the screen is there, and saving lets the tab in", {
  allow: [WALL_401],
}, async ({ page, context, goto, api, srv, profiles }) => {
  const p = profiles.owing;
  await api.adminPost(`/api/admin/profiles/${p.id}/force-reset`, { on: true });
  await setMode(api, "closed");
  try {
    const r = await record(page);
    await goto("#/", { wait: false });
    await signInWith(page, p.username, p.password);
    await page.waitForSelector(wall);
    // The server stops requiring sign-in: from the next load on the page asks
    // for the wall's list early, as every open server's page does — with this
    // browser's cookie, which is a must-reset profile's.
    await setMode(api, "transition");
    const cookie = async () => (await context.cookies(srv.url)).map((c) => `${c.name}=${c.value}`).join("; ");
    const stillDue = async () => (await api.call("GET", "/api/me", undefined, { cookie: await cookie() })).body.passwordResetRequired === true;
    for (const round of [1, 2, 3]) {
      r.mark();
      await page.reload();
      await page.waitForSelector(wall);
      await page.waitForTimeout(400);
      const seen = await r.seen();
      assert.deepEqual(seen.surfaces, ["reset"], `load ${round}: the "pick a new password" screen and nothing else`);
      assert.deepEqual(seen.toasts, []);
      assert.equal(await stillDue(), true, `load ${round}: the sign-in is still there, and still owes a password`);
    }
    assert.equal(await page.evaluate(() => localStorage.getItem("aurora-authmode")), "transition");
    assert.ok(r.early("profiles") >= 1, "the wall's list was asked for early on the last load");
    assert.ok(r.log.refused.some((u) => /\/api\/profiles$/.test(u)), "...and refused, not read as leaving");
    assert.equal(await page.locator("#app .screen").count(), 0);
    assert.deepEqual(await reportedAboutBoot(page), []);

    await page.fill(`${wall} input[placeholder="Current password"]`, p.password);
    await page.fill(`${wall} input[placeholder^="New password"]`, "boot-fresh-1");
    await page.fill(`${wall} input[placeholder="Once more"]`, "boot-fresh-1");
    await page.click(`${wall} button:has-text("Set new password")`);
    await page.waitForSelector(wall, { state: "detached" });
    await waitForScreen(page);
    assert.equal(await page.textContent("#nav-profile-name"), "Owing");
    p.password = "boot-fresh-1";
  } finally {
    await setMode(api, "open");
  }
});

ui.test("no sign-in needed: the picker's list, and a remembered profile's history and Home, are asked once — from the page", async ({ page, goto, signIn, profiles }) => {
  const r = await record(page);
  await signIn(profiles.grown);
  await goto("#/");
  // (the first load of a fresh device knows nothing yet: it learns the mode and how this profile is entered)
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-early")), "open");
  r.mark();
  await page.reload();
  await waitForScreen(page);
  await page.waitForSelector("#app .screen .hero-title, #app .screen .card");
  for (const q of ["me", "info", "profiles", "state", "home"]) assert.equal(r.early(q), 1, `${q}: asked from the page`);
  for (const q of ["me", "profiles", "state", "home"]) assert.equal(r.late(q), 0, `${q}: asked a second time`);
  assert.deepEqual(r.log.refused, []);
  assert.deepEqual((await r.seen()).surfaces, ["screen"]);

  // a page opened on another screen does not ask for Home
  r.mark();
  await page.goto(`${page.url().split("#")[0]}#/movies`);
  await page.reload();
  await waitForScreen(page);
  assert.equal(r.of("home").length, 0, "Home was fetched for a page that is not Home");
  assert.equal(r.early("state"), 1);
});

ui.test("the kids hop: a kids profile is never asked for early (its door runs first), and a grown-up who comes back through the PIN is", async ({ page, goto, signIn, srv, profiles }) => {
  if (!srv.kidsAvailable) return;
  const r = await record(page);
  await signIn(profiles.grown);
  await goto("#/");
  // grown-up → kids profile, through the wall
  await page.click("#nav-profile");
  await page.click('.nav-menu button:has-text("Switch profile")');
  await page.click('.profiles-gate .profile-tile[title="Small"]');
  await page.waitForSelector(".profiles-gate", { state: "detached" });
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-kids"));
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-early")), null, "a kids profile is entered through its door, never ahead of it");

  r.mark();
  await page.reload();
  await waitForScreen(page);
  await page.waitForFunction(() => document.getElementById("nav-profile-name").textContent === "Small");
  assert.equal(r.early("state"), 0);
  assert.equal(r.early("home"), 0);
  assert.equal(r.early("profiles"), 1, "the list itself is anyone's");
  assert.equal(r.late("profiles"), 0);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-kids")), true);
  // (its Home is an empty one here — nothing in this library is rated for it)
  assert.deepEqual((await r.seen()).surfaces.filter((s) => s !== "error"), ["screen"], "the kids profile comes straight back, no wall on the way");
  assert.deepEqual(r.log.refused, []);

  // kids profile → grown-up: the PIN, then early again as the grown-up
  await page.click("#nav-profile");
  await page.click('.nav-menu button:has-text("Switch profile")');
  await page.click('.profiles-gate .profile-tile[title="Grown"]');
  const sheet = page.locator(".modal", { hasText: "Grown-ups only" });
  await sheet.waitFor();
  await sheet.locator("input.kids-pin-input").fill(PIN);
  await sheet.locator("button", { hasText: "Unlock" }).click();
  await page.waitForSelector(".profiles-gate", { state: "detached" });
  await page.waitForFunction(() => document.getElementById("nav-profile-name").textContent === "Grown");
  assert.equal(await page.evaluate(() => localStorage.getItem("aurora-early")), "open");
  r.mark();
  await page.reload();
  await waitForScreen(page);
  assert.equal(r.early("state"), 1);
  assert.equal(r.late("state"), 0);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-kids")), false);
  assert.deepEqual(r.log.refused, []);
});

ui.run({ concurrency: 1 });
