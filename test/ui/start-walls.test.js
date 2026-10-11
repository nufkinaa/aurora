// The start of a repackaged film (the requests the player sends ahead of the
// press, the server's warm-up, the goodbye beacon, segments played as they
// arrive) against the walls the server has: sign-in required, kids profiles,
// the usage-statistics switch — and beside the things a viewer does around a
// start: the person sheet, a watch party, subtitles that come on by
// themselves.
//
// Test Film Two is the repackaged one (MKV + AC-3: playlists, segments,
// hls.js). It is rated 7+ here: the 12+ kids profile may play it, the
// all-ages one may not.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { suite, player, signIn: signInAs, goto: gotoOn, certificatesSeed, IDS } = require("./helpers");
const { seed: personSeed } = require("./support/person-seed");

const xray = personSeed()["cache/xray.json"][`t|movie|${IDS.film1}`];
const ui = suite({
  server: {
    seed: {
      ...personSeed(),
      "cache/certificates.json": certificatesSeed({ film1: 0, show: 7, film2: 7 }),
      "cache/xray.json": {
        [`t|movie|${IDS.film1}`]: xray,
        [`t|movie|${IDS.film2}`]: { ...xray, data: { ...xray.data, title: "Test Film Two" } },
      },
    },
  },
  setup: async (srv) => {
    const p = await srv.api.createProfile("Starter");
    await srv.api.post("/api/auth/claim", { profileId: p.id, username: "starter" }, await srv.api.as(p));
    srv.profiles.member = { ...p, username: "starter" };
    srv.profiles.tiny = await srv.api.createProfile("Tiny", { open: true, kids: { maxAge: 0 } });
    srv.profiles.teen = await srv.api.createProfile("Teen", { open: true, kids: { maxAge: 12 } });
  },
});

const PRIMARY = ".detail-actions > .btn-primary";
const REFUSED_403 = /Failed to load resource.*403/;
const WALL_401 = /Failed to load resource.*401/;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const pictures = (page) => page.route("**/img/ext**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));

// Every /stream answer the page gets, as "<status> <path?query>".
const streams = (page) => {
  const all = [];
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (u.pathname.startsWith("/stream/")) all.push({ status: res.status(), method: res.request().method(), path: u.pathname + u.search, warm: res.headers()["x-aurora-warm"] || null });
  });
  return {
    all,
    of: (re) => all.filter((r) => re.test(r.path)),
    bad: () => all.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.method} ${r.path}`),
  };
};
// The jit cache of the private instance: one folder per rendition that was ever started.
const jitDirs = (srv) => {
  try { return fs.readdirSync(path.join(srv.dataDir, "cache", "jit")); } catch { return []; }
};
const pressPlay = async (page) => {
  await page.locator(PRIMARY).waitFor();
  await page.click(PRIMARY);
  await page.waitForSelector("#app .player video");
};
const firstFrame = (marks) => marks.wait((m) => m.name === "first-frame", 30000, "the first-frame mark");

// ---------- kids (first: the server has made nothing yet) ----------
ui.test("a kids profile over the limit: the title, its playlists, a warm-up and a goodbye are all refused — and no encoder was ever started", {
  allow: [REFUSED_403],
}, async ({ page, goto, signIn, profiles, lib, srv }) => {
  const id = lib.film2.id;
  await signIn(profiles.tiny);
  await goto("#/");
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-kids"));
  const base = `/stream/transcode/${id}/jit`;
  const ask = (url, init) => page.evaluate(async ({ url, init }) => {
    const r = await fetch(url, init);
    return r.status;
  }, { url, init });
  // the title page's own request (it is what warms the keyframe table and the probe)
  assert.equal(await ask(`/api/item/${id}`), 403);
  // the playlists, with the start hint that makes the server begin the first segment
  assert.equal(await ask(`${base}/master.m3u8`, { headers: { "X-Aurora-Start": "at=0; kbps=3000" } }), 403);
  assert.equal(await ask(`${base}/index.m3u8?v=copy`, { headers: { "X-Aurora-Start": "at=0" } }), 403);
  // the warm-up itself, for the film's own video and for an encoded rendition
  assert.equal(await ask(`${base}/seg00000.ts?v=copy&warm=1`), 403);
  assert.equal(await ask(`${base}/seg00000.ts?v=h264-480&warm=1`), 403);
  assert.equal(await ask(`${base}/seg00000.ts?v=copy`), 403);
  // the goodbye (it may stop nothing of a film this profile is not allowed in)
  assert.equal(await ask(`${base}/bye`, { method: "POST" }), 403);
  assert.equal(await page.evaluate((u) => navigator.sendBeacon(u), `${base}/bye`), true);
  // the player, by its address: sent away, no <video>
  await page.evaluate((h) => { location.hash = h; }, `#/play/${id}`);
  await page.waitForFunction(() => /kids profile/i.test(document.getElementById("toasts").innerText));
  await page.waitForFunction(() => location.hash === "#/" || location.hash === "");
  assert.equal(await page.locator(".player video").count(), 0);
  await page.waitForTimeout(500);
  // nothing was made: no rendition folder, no producer, no warm-up in the server's log
  assert.deepEqual(jitDirs(srv), []);
  assert.deepEqual(srv.log().filter((l) => /\[jit\]/.test(l)), []);
});

ui.test("a kids profile within the limit starts the same film from its page: playlists, warm-up and segments all answered", async ({ page, goto, signIn, profiles, lib }) => {
  const id = lib.film2.id;
  await signIn(profiles.teen);
  const seen = streams(page);
  const marks = player.marks(page);
  await goto(`#/movie/${id}`);
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-kids"));
  await pressPlay(page);
  await player.playing(page, { id });
  await firstFrame(marks);
  assert.deepEqual(seen.bad(), []);
  assert.ok(seen.of(/\.m3u8/).length >= 1, "no playlist was asked for");
  assert.ok(seen.of(/seg\d+\.ts/).some((r) => r.status === 200), "no segment was served");
});

// ---------- sign-in required ----------
ui.test("sign-in required: a start from the title page — the requests sent ahead, the warm-up, playlists, segments and the goodbye all pass as the signed-in person, and none of them without a sign-in", {
  allow: [WALL_401],
}, async ({ page, goto, api, srv, profiles, lib }) => {
  const id = lib.film2.id;
  const base = `/stream/transcode/${id}/jit`;
  await api.adminPost("/api/admin/auth-mode", { mode: "closed" });
  try {
    // nobody: every one of the start's requests is refused at the wall
    const nobody = async (url, init) => {
      const r = await fetch(srv.url + url, init);
      const b = await r.json().catch(() => ({}));
      return `${r.status}${b.signinRequired ? " signin" : ""}`;
    };
    for (const [url, init] of [
      [`/api/item/${id}`],
      [`${base}/master.m3u8`, { headers: { "X-Aurora-Start": "at=0; kbps=3000" } }],
      [`${base}/index.m3u8?v=copy`],
      [`${base}/seg00000.ts?v=copy&warm=1`],
      [`${base}/seg00000.ts?v=copy`],
      [`${base}/bye`, { method: "POST" }],
      ["/api/tv/tuning"],
    ]) assert.equal(await nobody(url, init), "401 signin", url);
    // …and a session that does not exist is nobody
    assert.equal(await nobody(`${base}/bye`, { method: "POST", headers: { Cookie: "aurora_session=not-a-session", "X-Session": "not-a-session" } }), "401 signin");

    // somebody: sign in (the cookie is all the page's media requests carry)
    await goto("#/", { wait: false });
    await page.waitForSelector('.login-card input[placeholder="Username or email"]');
    await page.fill('.login-card input[placeholder="Username or email"]', profiles.member.username);
    await page.fill('.login-card input[placeholder="Password"]', profiles.member.password);
    await page.click(".login-card .lbtn.primary");
    await page.waitForSelector("#app .screen");
    const seen = streams(page);
    const marks = player.marks(page);
    const byes = [];
    page.on("request", (r) => { if (/\/jit\/bye$/.test(new URL(r.url()).pathname)) byes.push(r); });

    await goto(`#/movie/${id}`);
    await page.locator(PRIMARY).waitFor();
    // the page itself asks ahead once it is idle: the two playlists
    await page.waitForResponse((r) => /\/jit\/(master|index)\.m3u8/.test(r.url()), { timeout: 10000 });
    await page.hover(PRIMARY);
    await page.waitForTimeout(300);
    await pressPlay(page);
    await player.playing(page, { id });
    await firstFrame(marks);
    assert.deepEqual(seen.bad(), [], "a request of the start was refused in sign-in mode");
    assert.ok(seen.of(/\.m3u8/).every((r) => r.status === 200) && seen.of(/\.m3u8/).length >= 2);
    const warm = seen.of(/[?&]warm=1/);
    assert.ok(warm.length >= 1, "the first segment was never asked for ahead (&warm=1)");
    assert.ok(warm.every((r) => r.status === 204 && r.warm), `warm-up answers: ${JSON.stringify(warm)}`);
    assert.ok(seen.of(/seg\d+\.ts\?(?!.*warm=1)/).some((r) => r.status === 200));
    // the tuning route answers a signed-in client
    assert.equal(await page.evaluate(async () => (await fetch("/api/tv/tuning")).status), 200);

    // leaving the player says goodbye — a beacon, with nothing but the cookie
    await gotoOn(page, srv, "#/movies");
    await page.waitForFunction(() => !document.querySelector(".player"));
    for (let i = 0; i < 40 && !byes.length; i++) await page.waitForTimeout(50);
    assert.equal(byes.length >= 1, true, "no goodbye was sent");
    assert.equal(byes[0].method(), "POST");
    const res = await Promise.race([byes[0].response().catch(() => null), new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (res) assert.equal(res.status(), 204);
    // (the same request made where its answer can be read)
    assert.equal(await page.evaluate(async (u) => (await fetch(u, { method: "POST", keepalive: true })).status, `${base}/bye`), 204);
  } finally {
    await api.adminPost("/api/admin/auth-mode", { mode: "open" });
  }
});

// ---------- the usage-statistics switch ----------
const sendNow = (page) => page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
ui.test("usage stats off: the film starts the same, its start is still logged for the admin, and nothing is sent to the statistics", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { usageStats: false } }, await api.as(me));
  const usage = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/usage") usage.push(r.method()); });
  const seen = streams(page);
  const marks = player.marks(page);
  await signIn(me);
  await goto(`#/movie/${lib.film2.id}`);
  await pressPlay(page);
  await player.playing(page, { id: lib.film2.id });
  const ff = await firstFrame(marks);
  assert.ok(ff.ms > 0 && ff.ms < 30000);
  assert.deepEqual(seen.bad(), []);
  await sendNow(page);
  await page.waitForTimeout(700);
  assert.deepEqual(usage, [], "a profile with usage stats off sent a batch");
});

ui.test("usage stats on: the analytics timing of a start is the play mark's own number — one first frame, defined once", async ({ page, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  const marks = player.marks(page);
  const batches = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/usage") { try { batches.push(JSON.parse(r.postData() || "null")); } catch {} } });
  await signIn(me);
  // the page's own record of what was presented, to hold the mark against
  // (before any of the app's code: it keeps its own reference to createElement)
  await page.addInitScript(() => {
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function (name, ...rest) {
      const el = create.call(this, name, ...rest);
      // (every <video>: the app makes a few just to ask what the browser can play)
      if (String(name).toLowerCase() === "video" && el.requestVideoFrameCallback) {
        const rec = { videoAt: performance.now(), frames: [], playingAt: null }; // the player builds its <video> right after it notes its mount
        (window.__videos = window.__videos || []).push(rec);
        const on = (now, meta) => { rec.frames.push({ at: now, mt: meta.mediaTime, seeking: el.seeking }); if (rec.frames.length < 40) el.requestVideoFrameCallback(on); };
        el.requestVideoFrameCallback(on);
        el.addEventListener("playing", () => { if (!rec.playingAt) rec.playingAt = performance.now(); });
      }
      return el;
    };
  });
  await goto(`#/movie/${lib.film2.id}`);
  await pressPlay(page);
  await player.playing(page, { id: lib.film2.id });
  const ff = await firstFrame(marks);
  const mount = marks.all.find((m) => m.name === "mount");
  assert.ok(mount && mount.ms === 0);
  // the mark is the first frame presented, not the `playing` event after it
  const { frames, playingAt, videoAt } = await page.evaluate(() => (window.__videos || []).filter((r) => r.frames.length).pop() || { frames: [] });
  assert.ok(frames.length > 0, "no frame was seen by the page");
  // The mark counts from the player's mount; the page saw the <video> made a
  // few milliseconds after that. So "first frame − mark" is the mount, and
  // has to sit just before the element's creation — which it only does if
  // the mark carries the FIRST PRESENTED FRAME's own stamp.
  const first = frames.find((f) => !f.seeking);
  const mountAt = first.at - ff.ms;
  assert.ok(mountAt <= videoAt + 2 && videoAt - mountAt < 80, `the mark (${ff.ms} ms) is not the first presented frame: frame at ${first.at.toFixed(0)}, <video> made at ${videoAt.toFixed(0)}, playing at ${playingAt && playingAt.toFixed(0)}`);
  // what the page hands the statistics: the same number, to the millisecond
  await sendNow(page);
  let sent = null;
  for (let i = 0; i < 40 && !sent; i++) {
    for (const body of batches) for (const t of (body && body.tel && body.tel.t) || []) if (t[0] === "play_first_frame") sent = t;
    if (!sent) await page.waitForTimeout(100);
  }
  assert.ok(sent, `no batch carried the start's timing: ${JSON.stringify(batches).slice(0, 300)}`);
  assert.equal(sent[1], ff.ms, "the analytics timing and the play mark are two readings");
  assert.equal(batches.filter((b) => b && b.tel && (b.tel.t || []).some((t) => t[0] === "play_first_frame")).length, 1, "the start was timed more than once");
});

// ---------- the person sheet, around a start ----------
ui.test("from a person's sheet to a film's page to Play: the sheet is gone, the film starts and is not left paused", async ({ page, goto, signIn, freshProfile, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await pictures(page);
  const marks = player.marks(page);
  const seen = streams(page);
  await goto(`#/movie/${lib.film1.id}`);
  await page.locator(".detail-actions .btn-xray").click();
  await page.locator('.xray-panel .xr-person:has(.xr-name:text-is("Nora Chris")):has(.xr-role:text-is("Director"))').first().click();
  await page.locator(".person-wrap .person-sheet .person-section").first().waitFor();
  // Details of the repackaged film, from inside the sheet
  await page.locator('.person-wrap .person-sheet .pt:has(.pt-title:text-is("Test Film Two")) .pt-card').click({ button: "right" });
  await page.waitForFunction((h) => location.hash === h, `#/movie/${lib.film2.id}`);
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  await pressPlay(page);
  await player.playing(page, { id: lib.film2.id });
  await firstFrame(marks);
  assert.equal(await page.locator(".person-wrap, .xray-panel").count(), 0);
  assert.equal((await player.state(page)).paused, false);
  assert.deepEqual(seen.bad(), []);
});

ui.test("over a repackaged film, just started: X-Ray and a person's sheet hold it paused — nothing of the start un-pauses it — and it plays on when they close", async ({ page, srv, signIn, freshProfile, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await pictures(page);
  const marks = player.marks(page);
  await player.open(page, srv, lib.film2.id, { min: 0.2 });
  await player.press(page, "X-Ray");
  await page.locator('.player .xray-sheet .xr-person:has(.xr-name:text-is("Nora Chris"))').first().waitFor();
  assert.equal((await player.state(page)).paused, true, "X-Ray pauses the film");
  await page.locator('.player .xray-sheet .xr-person:has(.xr-name:text-is("Nora Chris"))').first().click();
  await page.locator(".person-wrap .person-sheet .person-section").first().waitFor();
  const at = (await player.state(page)).t;
  // the first seconds of a start are when the player acts on its own (the
  // start watch, the resume playhead, the first frame's bookkeeping, the
  // line watcher waking up): none of it may move a film the viewer paused
  await page.waitForTimeout(7000);
  const later = await player.state(page);
  assert.equal(later.paused, true, "the film started playing under the sheet");
  assert.ok(Math.abs(later.t - at) < 0.3, `the film moved under the sheet: ${at} → ${later.t}`);
  assert.equal(marks.named("first-frame").length, 1, "one first frame, however long the film then stood paused");
  await page.keyboard.press("Escape");
  await page.locator(".person-wrap").waitFor({ state: "detached" });
  assert.equal((await player.state(page)).paused, true, "closing the sheet alone resumed the film (X-Ray is still open)");
  await page.keyboard.press("Escape");
  await page.locator(".player .xray-sheet").waitFor({ state: "detached" });
  await player.playing(page, { id: lib.film2.id });
});

// ---------- subtitles that come on by themselves ----------
ui.test("subtitles on by default: a repackaged film starts with its embedded track showing, and the track's extraction does not hold the first frame up", async ({ page, goto, signIn, freshProfile, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  const marks = player.marks(page);
  const seen = streams(page);
  await goto(`#/movie/${lib.film2.id}`);
  await pressPlay(page);
  await player.playing(page, { id: lib.film2.id });
  await firstFrame(marks);
  await page.waitForFunction(() => {
    const v = document.querySelector(".player video");
    return !!v && [...v.textTracks].some((t) => t.mode === "showing" && t.activeCues && t.activeCues.length > 0);
  }, null, { timeout: 15000 });
  const st = await player.state(page);
  assert.equal(st.showing.length, 1, `showing: ${JSON.stringify(st.showing)}`);
  assert.match(st.tracks.find((t) => t.mode === "showing").cue, /cue \d+/);
  assert.ok(seen.of(/^\/stream\/embedded\//).some((r) => r.status === 200), "the embedded track was not fetched");
  assert.deepEqual(seen.bad(), []);
});

// ---------- a watch party ----------
ui.test("a watch party on a repackaged film: the guest joins where the host is, and a pause, a jump and a play are followed", async ({ page, srv, context, signIn, freshProfile, lib }) => {
  const id = lib.film2.id;
  const host = await freshProfile();
  const guest = await freshProfile();
  await signIn(host);
  await player.open(page, srv, id);
  await player.jump(page, 14);
  await player.advancing(page);
  await player.press(page, "Watch together");
  await page.click('.player [data-ui="player.party.start"]');
  await page.waitForSelector(".player .party-code");
  const code = (await page.textContent(".player .party-code")).trim();
  assert.match(code, /^[A-Z0-9]{4}$/);

  const ctx2 = await context.browser().newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
  try {
    const page2 = await ctx2.newPage();
    page2.setDefaultTimeout(15000);
    const errors = [];
    page2.on("pageerror", (e) => errors.push(String(e)));
    const seen2 = streams(page2);
    const marks2 = player.marks(page2);
    await signInAs(page2, srv, guest);
    await gotoOn(page2, srv, "#/movies");
    await gotoOn(page2, srv, `#/play/${id}?party=${code}`, { selector: "#app .player video" });
    await page2.waitForFunction(() => /Joined/.test(document.getElementById("toasts").innerText), null, { timeout: 15000 });
    await player.playing(page2, { id });
    await firstFrame(marks2);
    const clocks = async () => {
      const [a, b] = await Promise.all([player.state(page), player.state(page2)]);
      return { host: a, guest: b, apart: Math.abs(a.t - b.t) };
    };
    // in step: guests correct themselves when more than 2.5 s out
    await page2.waitForFunction(() => document.querySelector(".player video").currentTime > 14);
    await player.advancing(page2);
    let c = await clocks();
    assert.ok(c.apart < 3, `after joining: host ${c.host.t.toFixed(1)} s, guest ${c.guest.t.toFixed(1)} s`);
    assert.ok(c.guest.t >= 13, `the guest did not land where the host is: ${c.guest.t}`);

    // the host pauses: the guest stops
    await player.press(page, "Play/Pause");
    await page.waitForFunction(() => document.querySelector(".player video").paused);
    await page2.waitForFunction(() => document.querySelector(".player video").paused, null, { timeout: 8000 });
    // the host jumps and plays: the guest follows to the same place
    await player.jump(page, 36);
    await player.press(page, "Play/Pause");
    await player.advancing(page);
    await page2.waitForFunction(() => { const v = document.querySelector(".player video"); return !v.paused && v.currentTime > 35; }, null, { timeout: 15000 });
    await player.advancing(page2);
    c = await clocks();
    assert.ok(c.apart < 3, `after the jump: host ${c.host.t.toFixed(1)} s, guest ${c.guest.t.toFixed(1)} s`);
    // the guest leaves (its goodbye is its own): the host plays on
    await gotoOn(page2, srv, "#/movies");
    await page2.waitForFunction(() => !document.querySelector(".player"));
    await player.advancing(page, { by: 1.5 });
    assert.deepEqual(seen2.bad(), []);
    assert.deepEqual(errors, []);
  } finally {
    await ctx2.close().catch(() => {});
  }
});

ui.run();
