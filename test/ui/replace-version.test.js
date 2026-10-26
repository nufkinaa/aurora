// "Problem with this copy? → Get another version" in the web app: the title
// page of a film you own, an episode's sources (hold the episode), the
// player's menu — desktop and phone, both looks.
//
// The private instance cannot download anything (no network, no torrent),
// so the answers that would need one are stubbed in the browser with the
// exact shapes src/media/replace.js sends: the source list, the request, the
// cancel. What the server can answer offline — the sheet's opening question
// (the copy, the reasons, who may) and its refusals — is the real server's.
// The replacement itself (the swap, the id, the carry-over) is tested in
// test/replace-version.test.js.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, PHONE, DESKTOP, player, assertNoHorizontalOverflow, certificatesSeed } = require("./helpers");

const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "replace-version");
const shot = async (page, name) => {
  if (!process.env.REPLACE_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(450); // (past the sheet's fade-in)
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
};

const ui = suite({
  // (a kids profile only opens a title rated for it)
  server: { seed: { "cache/certificates.json": certificatesSeed({ film1: 0, show: 7, film2: 18 }) } },
  setup: async (srv) => {
    srv.profiles.kid = await srv.api.createProfile("Kiddo", { open: true, kids: { maxAge: 7 } });
  },
});

const HASH = (c) => String(c).repeat(40);
const stream = (c, over = {}) => ({
  infoHash: HASH(c), fileIdx: 0, quality: "1080p", qualityLabel: "1080p", sizeBytes: 2.1e9, sizeString: "2.1 GB", seeders: 120,
  provider: "TestProv", release: `Test.Film.One.2020.1080p.WEB-${c.toUpperCase()}`, cam: false, dubbed: false, languages: [], tags: [], pack: false, ...over,
});
const STREAMS = [
  stream("b", { recommended: true }),
  stream("c", { quality: "720p", qualityLabel: "720p", sizeBytes: 9e8, seeders: 40, release: "Test.Film.One.2020.720p.BluRay" }),
  stream("d", { release: "Test.Film.One.2020.1080p.HC", badHere: { reason: "burned", label: "Burned-in subtitles" } }),
];

// The answers a real download would need, stubbed: GET …/sources, POST, POST …/cancel.
const stubReplace = async (page, { streams = STREAMS, active = null } = {}) => {
  const calls = { posts: [], cancels: [] };
  let live = active;
  await page.route((url) => /^\/api\/replace\/[^/]+\/sources$/.test(url.pathname), (route) => route.fulfill({ json: { streams, current: { quality: "1080p", sizeBytes: 1.5e9, release: "Test.Film.One.2020.1080p.HC.WEB" } } }));
  await page.route((url) => /^\/api\/replace\/[^/]+\/cancel$/.test(url.pathname), (route) => {
    calls.cancels.push(JSON.parse(route.request().postData() || "{}"));
    live = null;
    route.fulfill({ json: { ok: true } });
  });
  await page.route((url) => /^\/api\/replace\/[^/]+$/.test(url.pathname), async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      calls.posts.push({ url: req.url(), body });
      live = { id: "r1", libraryId: "x", reason: body.reason, reasonLabel: { burned: "Burned-in subtitles", picture: "Bad picture", sound: "Bad sound", language: "Wrong language", other: "Other" }[body.reason], status: "approved", phase: null, progress: 0, waiting: false, jobId: "j1", by: "me", mine: true };
      return route.fulfill({ json: { ok: true, replacement: live, job: { id: "j1", status: "approved" } } });
    }
    if (!live) return route.fallback(); // the real server answers what it can
    const real = await route.fetch();
    const json = await real.json();
    return route.fulfill({ json: { ...json, active: live, can: false, code: "busy" } });
  });
  return calls;
};

const sheet = ".replace-wrap .replace-copy";
const openFromTitle = async (page) => {
  await page.waitForSelector('[data-ui="detail.replace"]');
  await page.click('[data-ui="detail.replace"]');
  await page.waitForSelector(`${sheet} [data-ui="replace.reason"]`);
};

for (const look of ["glass", "legacy"]) {
  for (const [vp, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    ui.test(`${vp}, ${look}: a film you own — say what's wrong, pick another version, it is on its way; Cancel keeps the copy`, { viewport }, async ({ page, api, signIn, freshProfile, goto, lib }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      const calls = await stubReplace(page);
      await signIn(me);
      await goto(`#/movie/${lib.film1.id}`);
      const line = page.locator('[data-ui="detail.replace"]');
      await line.waitFor();
      assert.match(await line.innerText(), /Problem with this copy\?\s*Get another version/);
      await line.evaluate((n) => n.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      const seen = await line.evaluate((n) => {
        const r = n.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { top: r.top, bottom: r.bottom, h: innerHeight, mine: !!hit && n.contains(hit), what: hit ? hit.className : null };
      });
      assert.ok(seen.mine && seen.top >= 0 && seen.bottom <= seen.h, `the line can be seen and pressed: ${JSON.stringify(seen)}`);
      await shot(page, `${vp}-${look}-1-title`);
      await openFromTitle(page);

      // step 1: what is wrong — the real server's reasons
      const card = page.locator(sheet);
      assert.match(await card.innerText(), /What's wrong with this copy\?/);
      const reasons = await page.locator(`${sheet} [data-ui="replace.reason"]`).allInnerTexts();
      assert.deepEqual(reasons, ["Burned-in subtitles", "Bad picture", "Bad sound", "Wrong language", "Other"]);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.textContent), "Burned-in subtitles", "focus lands on the first reason");
      if (vp === "phone") await assertNoHorizontalOverflow(page, "the reasons sheet");
      await shot(page, `${vp}-${look}-2-reasons`);

      // step 2: the other versions
      await page.click(`${sheet} [data-ui="replace.reason"]:has-text("Burned-in subtitles")`);
      await page.waitForSelector(`${sheet} [data-ui="replace.pick"]`);
      assert.match(await card.innerText(), /Get another version/);
      assert.match(await card.innerText(), /Your copy stays playable until the new one is in\./);
      const rows = page.locator(`${sheet} [data-ui="replace.pick"]`);
      assert.equal(await rows.count(), 3);
      assert.match(await rows.nth(0).innerText(), /★ BEST/);
      assert.match(await rows.nth(0).innerText(), /1080p · 2\.\d GB · 120 seeders · TestProv/);
      assert.match(await rows.nth(2).innerText(), /Reported here: Burned-in subtitles/);
      if (vp === "phone") await assertNoHorizontalOverflow(page, "the versions sheet");
      await shot(page, `${vp}-${look}-3-versions`);

      // Back goes to the reasons, not out of the sheet
      await page.click(`${sheet} .rc-back`);
      await page.waitForSelector(`${sheet} [data-ui="replace.reason"]`);
      await page.click(`${sheet} [data-ui="replace.reason"]:has-text("Burned-in subtitles")`);
      await page.waitForSelector(`${sheet} [data-ui="replace.pick"]`);
      await page.fill(`${sheet} .rc-note`, "white letters over the picture");
      await rows.nth(0).click();
      await page.waitForSelector(`${sheet} [data-ui="replace.cancel"]`);
      assert.equal(calls.posts.length, 1);
      const sent = calls.posts[0];
      assert.ok(sent.url.includes(`/api/replace/${lib.film1.id}`));
      assert.equal(sent.body.profile, me.id);
      assert.equal(sent.body.reason, "burned");
      assert.equal(sent.body.note, "white letters over the picture");
      assert.deepEqual(sent.body.source, { infoHash: HASH("b"), fileIdx: 0 });
      const text = await card.innerText();
      assert.match(text, /Another version is on its way/);
      assert.match(text, /Queued to download/);
      assert.match(text, /Reason: Burned-in subtitles/);
      assert.match(await page.locator(".toast").last().innerText(), /Getting another version — your copy stays playable until it's in\./);
      await shot(page, `${vp}-${look}-4-on-its-way`);

      // Cancel — keep this copy
      await page.click(`${sheet} [data-ui="replace.cancel"]`);
      await page.waitForSelector(".replace-wrap", { state: "detached" });
      assert.equal(calls.cancels.length, 1);
      assert.equal(calls.cancels[0].profile, me.id);
      await page.waitForFunction(() => /Cancelled — your copy stays as it was\./.test(document.body.innerText));
    });
  }
}

ui.test("opened again while a replacement is on its way: its state, the reason — and live progress, then ‘waiting for nobody to be playing it’", async ({ page, signIn, freshProfile, goto, lib }) => {
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Real {
      constructor(...a) { super(...a); window.__sockets.push(this); }
    };
  });
  await stubReplace(page, { active: { id: "r1", libraryId: lib.film1.id, reason: "language", reasonLabel: "Wrong language", status: "downloading", phase: "downloading", progress: 0.45, waiting: false, jobId: "j1", by: "Somebody Else", mine: false } });
  await signIn(await freshProfile());
  await goto(`#/movie/${lib.film1.id}`);
  await page.click('[data-ui="detail.replace"]');
  await page.waitForSelector(`${sheet} .rc-status`);
  const card = page.locator(sheet);
  assert.match(await card.innerText(), /Downloading · 45%/);
  assert.match(await card.innerText(), /Reason: Wrong language/);
  assert.match(await card.innerText(), /Asked for by Somebody Else/);
  assert.equal(await page.locator(`${sheet} [data-ui="replace.cancel"]`).count(), 0, "only the person who asked can cancel");
  // the queue's live message moves it on: finished, and the old copy is being played
  await page.evaluate((id) => {
    const msg = { type: "download_update", job: { id: "j1", status: "downloading", phase: "copying", progress: 1, replaceWait: true, replaces: { id: "r1", libraryId: id } } };
    for (const s of window.__sockets || []) if (s.readyState === 1) s.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }, lib.film1.id);
  await page.waitForFunction(() => /Ready — it takes over once nobody is playing this copy\./.test(document.querySelector(".replace-copy").innerText));
  await shot(page, "desktop-glass-5-active-other");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".replace-wrap", { state: "detached" });
});

ui.test("an episode you own: hold it, and its sources carry “Problem with this copy?” — the sheet names the episode", async ({ page, signIn, freshProfile, goto, lib }) => {
  const calls = await stubReplace(page);
  await signIn(await freshProfile());
  await goto(`#/show/${lib.show.id}`);
  const ep = page.locator('[data-ui="detail.episode.play"][data-ep="1x2"]');
  await ep.waitFor();
  await ep.click({ button: "right" });
  const entry = page.locator('[data-ui="detail.episode.replace"]');
  await entry.waitFor();
  await shot(page, "desktop-glass-6-episode-sources");
  await entry.click();
  await page.waitForSelector(`${sheet} [data-ui="replace.reason"]`);
  assert.match(await page.locator(sheet).innerText(), /Test Show · S1 E2/);
  await page.click(`${sheet} [data-ui="replace.reason"]:has-text("Bad sound")`);
  await page.locator(`${sheet} [data-ui="replace.pick"]`).nth(1).click();
  await page.waitForSelector(`${sheet} [data-ui="replace.cancel"]`);
  assert.ok(calls.posts[0].url.includes(`/api/replace/${lib.e2.id}`), "the episode's own library id");
  assert.equal(calls.posts[0].body.reason, "sound");
  assert.deepEqual(calls.posts[0].body.source, { infoHash: HASH("c"), fileIdx: 0 });
});

ui.test("the player's menu: “Problem with this copy?” opens the sheet over the film", async ({ page, srv, signIn, freshProfile, lib }) => {
  await stubReplace(page);
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  const items = await player.menu(page, "Settings");
  const entry = items.find((i) => i.text === "Problem with this copy?");
  assert.ok(entry, `the menu has the entry: ${JSON.stringify(items.map((i) => i.text))}`);
  assert.equal(entry.tag, "Get another version");
  await page.click('.player .menu [data-ui="player.replace"]');
  await page.waitForSelector(`${sheet} [data-ui="replace.reason"]`);
  assert.match(await page.locator(sheet).innerText(), /Test Film One/);
  await shot(page, "desktop-glass-7-player");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".replace-wrap", { state: "detached" });
  assert.ok(await page.locator(".player video").count(), "the player is still there");
});

ui.test("a kids profile: no entry on the title page, and the server refuses it", { allow: [/Failed to load resource.*403.*\/api\/replace\//] }, async ({ page, api, signIn, goto, lib, profiles }) => {
  await signIn(profiles.kid);
  await goto(`#/movie/${lib.film1.id}`);
  await page.waitForSelector(".detail-hero");
  await page.waitForTimeout(400);
  assert.equal(await page.locator('[data-ui="detail.replace"]').count(), 0);
  const r = await api.call("GET", `/api/replace/${lib.film1.id}?profile=${profiles.kid.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.can, false);
  assert.equal(r.body.code, "kids");
  assert.equal(r.body.why, "A kids profile can't replace a copy.");
  const post = await api.call("POST", `/api/replace/${lib.film1.id}`, { profile: profiles.kid.id, reason: "burned", source: { infoHash: HASH("b") } });
  assert.equal(post.status, 403);
  assert.equal(post.body.code, "kids");
});

ui.test("the real server: a grown-up may, a source the title does not offer is refused, nothing to cancel", async ({ api, freshProfile, lib }) => {
  const me = await freshProfile();
  const r = await api.call("GET", `/api/replace/${lib.film1.id}?profile=${me.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.can, true, JSON.stringify(r.body));
  assert.equal(r.body.item.title, "Test Film One");
  assert.equal(r.body.active, null);
  assert.equal(r.body.reasons.length, 5);
  const ep = await api.call("GET", `/api/replace/${lib.e2.id}?profile=${me.id}`);
  assert.equal(ep.body.item.type, "episode");
  assert.equal(ep.body.item.display, "Test Show · S1 E2");
  assert.equal((await api.call("POST", `/api/replace/${lib.film1.id}`, { profile: me.id, reason: "nope", source: { infoHash: HASH("b") } })).body.code, "reason");
  // (offline: the source list cannot be fetched, so nothing can be checked against it — refused)
  const bad = await api.call("POST", `/api/replace/${lib.film1.id}`, { profile: me.id, reason: "burned", source: { infoHash: HASH("b") } });
  assert.ok(bad.status >= 400 && ["provider", "source"].includes(bad.body.code), JSON.stringify(bad));
  assert.equal((await api.call("POST", `/api/replace/${lib.film1.id}/cancel`, { profile: me.id })).status, 404);
  assert.equal((await api.call("GET", "/api/replace/000000000000?profile=" + me.id)).status, 404);
  // the admin's list is there (empty: nothing was replaced)
  assert.deepEqual((await api.adminGet("/api/admin/replacements")).replacements, []);
  const people = await api.adminGet("/api/admin/people");
  assert.ok(people.people.every((p) => Array.isArray(p.replaced)), "every person's sheet carries their replaced copies");
});

ui.test("My downloads: a replacement waiting to take over says so; a finished one says what it replaced", async ({ page, signIn, freshProfile, goto, lib }) => {
  const base = {
    infoHash: HASH("b"), fileIdx: 0, imdbId: "tt9000001", title: "Test Film One", label: "Test Film One — another version", type: "movie",
    season: null, episode: null, quality: "1080p", sizeBytes: 2.1e9, poster: null, provider: null, copyProgress: null, downloadSpeed: 0, peers: 0,
    error: null, at: new Date().toISOString(), approvedAt: new Date().toISOString(), holdReason: null, autoApproved: true, seenAt: null, smart: false,
    resolvedAt: null, race: null, raceNote: null, mine: true, by: "Me", replaces: { id: "r1", libraryId: lib.film1.id, reason: "burned", reasonLabel: "Burned-in subtitles" },
  };
  const jobs = [
    { ...base, id: "aaaaaaaaaaaa", status: "downloading", phase: "copying", progress: 1, doneAt: null, libraryId: null, replaceWait: true },
    { ...base, id: "bbbbbbbbbbbb", status: "done", phase: null, progress: 1, doneAt: new Date().toISOString(), libraryId: lib.film1.id, replaceWait: false, seenAt: new Date().toISOString() },
  ];
  await page.route((url) => url.pathname === "/api/downloads", (route) => route.fulfill({ json: jobs }));
  await signIn(await freshProfile());
  await goto("#/downloads");
  await page.waitForSelector('.dl-row[data-id="aaaaaaaaaaaa"]');
  assert.match(await page.locator('.dl-row[data-id="aaaaaaaaaaaa"] .dl-status').innerText(), /Ready[\s\S]*Waiting for nobody to be playing the old copy/);
  assert.match(await page.locator('.dl-row[data-id="bbbbbbbbbbbb"] .dl-status').innerText(), /Replaced the old copy \(Burned-in subtitles\)/);
  await shot(page, "desktop-glass-8-downloads");
});

ui.test("admin: Inbox lists the replaced copies — who, what, why, old → new, how it went", async ({ page, srv }) => {
  const rows = [{
    id: "r1", at: Date.now() - 60000, by: "x", byName: "Grown Up", libraryId: "y", type: "movie", title: "Test Film One", display: "Test Film One",
    reason: "burned", reasonLabel: "Burned-in subtitles", note: "white letters", status: "done", progress: 1, waiting: false,
    old: { release: "Test.Film.One.2020.1080p.HC.WEB", quality: "1080p", sizeBytes: 1.5e9 }, new: { release: "Test.Film.One.2020.1080p.WEB-B", quality: "1080p", sizeBytes: 2.1e9 },
  }];
  await page.route((url) => url.pathname === "/api/admin/replacements", (route) => route.fulfill({ json: { replacements: rows } }));
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.click('.tab[data-tab="moderation"]');
  await page.waitForFunction(() => /Grown Up/.test((document.querySelector("#replacements") || {}).innerText || ""));
  const text = await page.locator("#replacements").innerText();
  assert.match(text, /Grown Up/);
  assert.match(text, /Test Film One/);
  assert.match(text, /Burned-in subtitles/);
  assert.match(text, /white letters/);
  assert.match(text, /Test\.Film\.One\.2020\.1080p\.HC\.WEB/);
  assert.match(text, /→ Test\.Film\.One\.2020\.1080p\.WEB-B/);
  assert.match(text, /done/);
  await shot(page, "admin-inbox-replaced");
});

ui.run({ concurrency: 2 });
