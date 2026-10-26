// AirPlay from an iPhone, and the iPhone's own stream when it stops — on a
// private server, in real Chrome given an iPhone's user agent (Matan's, from
// his report of 2026-10-26) and a phone's screen. Chrome plays HLS natively
// (it answers "maybe" for application/vnd.apple.mpegurl, as Safari does), so
// the player takes exactly the iPhone's path: no hls.js, the jit stream in
// fMP4 on the element's own src. WebKit's AirPlay API is stubbed (no Apple
// device in the rig); what a TV fetches is fetched by Node with no cookie
// and no header — all a receiver has.
//
// Matan: "it shows that it's a sound file and not a video" — on a server
// that requires sign-in, iOS handed the TV the session's own address the
// moment AirPlay was picked; the TV was refused it. Now the element is on
// the link's twin of its stream as soon as a TV is in reach (js/airplay.js).
// "…and it still gets stuck" — the iPhone's stream had no way back from a
// stop but the full encode; now: the same stream again, a seek where it
// stands, the stream re-pointed, then the card.
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const MATAN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const IPHONE = { width: 430, height: 745 };

const ui = suite({
  setup: async (srv) => {
    const p = await srv.api.createProfile("Pocket");
    await srv.api.post("/api/auth/claim", { profileId: p.id, username: "pocket" }, await srv.api.as(p));
    srv.profiles.viewer = { ...p, username: "pocket" };
  },
});

const setMode = (api, mode) => api.adminPost("/api/admin/auth-mode", { mode });
const WALL_401 = /Failed to load resource.*401/;

// an iPhone: its user agent (the player decides native HLS from it), and
// WebKit's AirPlay surface on the <video>
const asIPhone = (page) => page.addInitScript((ua) => {
  Object.defineProperty(navigator, "userAgent", { get: () => ua });
  window.__air = { wireless: false, picker: 0 };
  window.WebKitPlaybackTargetAvailabilityEvent = function WebKitPlaybackTargetAvailabilityEvent() {};
  Object.defineProperty(HTMLMediaElement.prototype, "webkitCurrentPlaybackTargetIsWireless", {
    configurable: true,
    get() { return window.__air.wireless; },
  });
  HTMLMediaElement.prototype.webkitShowPlaybackTargetPicker = function () { window.__air.picker++; };
}, MATAN_UA);
const tvInReach = (page) => page.evaluate(() => {
  const e = new Event("webkitplaybacktargetavailabilitychanged");
  e.availability = "available";
  document.querySelector(".player video").dispatchEvent(e);
});
const wireless = (page, on) => page.evaluate((on) => {
  window.__air.wireless = on;
  document.querySelector(".player video").dispatchEvent(new Event("webkitcurrentplaybacktargetiswirelesschanged"));
}, on);
const srcOf = (page) => page.evaluate(() => document.querySelector(".player video").getAttribute("src") || "");
const bare = async (url) => {
  const r = await fetch(url, { redirect: "manual" });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type") || "", text: buf.toString("utf8"), bytes: buf.length };
};
// The controls on a phone-sized page (the shared helpers move the pointer
// at x = 500, off this 430-wide screen)
let wakeX = 150;
const wake = async (page) => {
  wakeX = wakeX === 150 ? 170 : 150;
  await page.mouse.move(wakeX, 300);
  await page.waitForFunction(() => { const p = document.querySelector(".player"); return !!p && !p.classList.contains("controls-hidden"); });
};
const press = async (page, label) => { await wake(page); await page.click(player.ctrl(label)); };
const pick = async (page, label, text) => {
  await press(page, label);
  await page.waitForSelector(".player .menu .menu-item");
  await page.locator(".player .menu .menu-item").filter({ hasText: text }).first().click();
};
const uris = (m3u8) => m3u8.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
// signed in the way a browser is on a closed server: the session cookie
const cookieSignIn = async (srv, context, p) => {
  const login = await fetch(`${srv.url}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: p.username, password: p.password }),
  });
  assert.equal(login.status, 200);
  const sid = /aurora_session=([^;]+)/.exec(login.headers.get("set-cookie"))[1];
  await context.addCookies([{ name: "aurora_session", value: sid, url: srv.url }]);
  return sid;
};
// This page is on 127.0.0.1, which no TV can reach: the server gives its
// home-network address for the link instead (routes/airplay.js), and the
// twin is on that address — which this machine reaches too. The rig answers
// every other address with a 404; that one is let through to the server.
// null (the test is skipped): this machine has no home-network address.
const lanThrough = async (srv, context, sid, id) => {
  const r = await fetch(`${srv.url}/api/airplay/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `aurora_session=${sid}` },
    body: JSON.stringify({ path: `/stream/transcode/${id}/jit/index.m3u8?seg=fmp4` }),
  });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  if (!body.origin) return null;
  const lan = new URL(body.origin).origin;
  await context.route((url) => url.origin === lan, (route) => route.continue());
  return lan;
};
// what a receiver fetches, through the private server's own address
const viaSrv = (srv, url) => { const u = new URL(url); return `${srv.url}${u.pathname}${u.search}`; };

ui.test("an iPhone on a server that requires sign-in: on the link's twin as soon as a TV is in reach; AirPlay hands the TV that address untouched; 'No picture there?' sends the encode; back after", {
  viewport: IPHONE,
  allow: [WALL_401],
}, async ({ page, context, srv, api, lib, profiles, signIn, t }) => {
  const p = profiles.viewer;
  await signIn(p);
  await setMode(api, "closed");
  try {
    const sid = await cookieSignIn(srv, context, p);
    const lan = await lanThrough(srv, context, sid, lib.film2.id);
    if (!lan) return void t.skip("this machine has no home-network address for a TV to reach");
    await asIPhone(page);
    const marks = player.marks(page);
    await player.open(page, srv, lib.film2.id, { min: 1 });
    // the iPhone's own path: native HLS, the jit stream in Apple's fMP4 — no hls.js, no blob
    const plain = await srcOf(page);
    assert.equal(plain, `/stream/transcode/${lib.film2.id}/jit/index.m3u8?seg=fmp4`);
    assert.equal(await page.evaluate(() => !!window.Hls), false, "hls.js never loaded");
    // (and no Web Audio graph on an iPhone: the sound path is the element's own)
    assert.equal(await page.evaluate(() => document.querySelector(".player video").auroraFx.state().built), false);
    // the TV can't fetch that address: the session's own
    assert.equal((await bare(`${srv.url}${plain}`)).status, 401);

    // ---- a TV comes in reach: the twin ----
    await player.waitClock(page, 3, 40);
    const before = await player.clock(page);
    await tvInReach(page);
    await page.waitForFunction(() => /\/air\/[^/]+\/stream\/transcode\//.test(document.querySelector(".player video").getAttribute("src") || ""), null, { timeout: 10000 });
    const twin = await srcOf(page);
    const tu = new URL(twin);
    assert.equal(tu.origin, lan, "on the address the TV reaches (and this machine too)");
    assert.match(tu.pathname, new RegExp(`^/air/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/stream/transcode/${lib.film2.id}/jit/index\\.m3u8$`));
    assert.equal(tu.search, "?seg=fmp4", "exactly the stream it was playing");
    await marks.wait((m) => m.name === "airplay" && m.did === "twin", 5000, "the twin's mark");
    // the film goes on, from where it was — no resume card, no restart
    await player.advancing(page, { by: 1, timeout: 20000 });
    const after = await player.clock(page);
    assert.ok(after >= before - 1, `went on from ${before}s, at ${after}s`);
    assert.equal(await page.locator(".player .resume-card, .player .player-error").count(), 0);
    // what the TV will fetch: no cookie, no header — and it plays
    const media = await bare(viaSrv(srv, twin));
    assert.equal(media.status, 200, media.text);
    assert.match(media.text, /#EXT-X-MAP:URI="init\.mp4/);
    const seg = await bare(viaSrv(srv, new URL(uris(media.text)[1], twin).href));
    assert.equal(seg.status, 200);
    assert.ok(seg.bytes > 1000);

    // ---- AirPlay with a subtitle on (the player put English on by itself):
    // the master that carries it, told what its picture is ----
    assert.deepEqual((await player.state(page)).showing, ["English"]);
    await press(page, "AirPlay");
    assert.equal(await page.evaluate(() => window.__air.picker), 1);
    await wireless(page, true);
    await page.waitForFunction(() => /\/stream\/airplay\//.test(document.querySelector(".player video").getAttribute("src") || ""), null, { timeout: 10000 });
    const withSub = await srcOf(page);
    assert.equal(new URL(withSub).origin, lan);
    assert.match(new URL(withSub).pathname, new RegExp(`^/air/[^/]+/stream/airplay/${lib.film2.id}/master\.m3u8$`));
    assert.equal(new URL(withSub).search, "?seg=fmp4&sub=0");
    const master = await bare(viaSrv(srv, withSub));
    assert.equal(master.status, 200, master.text);
    const inf = /#EXT-X-STREAM-INF:([^\n]*)/.exec(master.text)[1];
    assert.match(inf, /RESOLUTION=\d+x\d+/, inf);
    assert.match(inf, /CODECS="avc1\.[0-9a-f]{6},mp4a\.40\.2"/, inf);
    assert.match(inf, /SUBTITLES="subs"/, inf);
    assert.match(master.text, /#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English"[^\n]*DEFAULT=YES/);
    await page.locator("#toasts .toast", { hasText: "Playing on the TV." }).last().waitFor({ timeout: 5000 });
    await wireless(page, false);
    await page.waitForFunction(() => /\/air\/[^/]+\/stream\/transcode\/[^?]+\/jit\/index\.m3u8\?seg=fmp4$/.test(document.querySelector(".player video").getAttribute("src") || ""), null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector(".player video").readyState >= 2, null, { timeout: 15000 });
    await page.evaluate(() => document.querySelector(".player video").play().catch(() => {}));
    await player.advancing(page, { by: 0.5, timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector("#toasts .toast"), null, { timeout: 10000 });

    // ---- subtitles off, AirPlay again: nothing on the element changes ----
    await pick(page, "Subtitles", "Off");
    const twinNow = await srcOf(page);
    await wireless(page, true);
    const toastAct = page.locator("#toasts .toast", { hasText: "Playing on the TV." }).locator("button.toast-act");
    await toastAct.waitFor({ timeout: 5000 });
    assert.equal(await toastAct.textContent(), "No picture there?");
    assert.equal(await srcOf(page), twinNow, "the TV plays the very address the phone played");
    await page.screenshot({ path: require("path").join(__dirname, "artifacts", "airplay-iphone-on-tv.png") }).catch(() => {});

    // ---- 'No picture there?': the encode, which every Apple TV decodes ----
    await toastAct.click();
    await page.waitForFunction(() => /v=h264/.test(document.querySelector(".player video").getAttribute("src") || ""), null, { timeout: 10000 });
    const simple = await srcOf(page);
    assert.match(new URL(simple).pathname, new RegExp(`^/air/[^/]+/stream/transcode/${lib.film2.id}/jit/index\\.m3u8$`));
    assert.equal(new URL(simple).search, "?v=h264&seg=fmp4");
    const enc = await bare(viaSrv(srv, simple));
    assert.equal(enc.status, 200, enc.text);
    assert.match(enc.text, /#EXTINF/);
    assert.equal(await page.locator(".player .player-error").count(), 0, "no error card while on AirPlay");

    // ---- AirPlay ends: the phone's own stream again (its twin), near where the TV was ----
    await wireless(page, false);
    await page.waitForFunction((id) => {
      const s = document.querySelector(".player video").getAttribute("src") || "";
      return s.includes(`/stream/transcode/${id}/jit/index.m3u8?seg=fmp4`) && !/v=h264/.test(s);
    }, lib.film2.id, { timeout: 15000 });
    assert.match(await srcOf(page), /\/air\//, "a later start uses the twin too");
    await page.waitForFunction(() => document.querySelector(".player video").readyState >= 2, null, { timeout: 15000 });
    await page.evaluate(() => document.querySelector(".player video").play().catch(() => {}));
    await player.advancing(page, { by: 0.5, timeout: 20000 });
    assert.equal(await page.locator(".player .player-error").count(), 0);
  } finally {
    await setMode(api, "open");
  }
});

ui.test("an iPhone's twin stops working (its link expired, or the server restarted): a fresh link, the same stream, the same spot", {
  viewport: IPHONE,
  allow: [WALL_401, /Failed to load resource.*\/air\//],
}, async ({ page, context, srv, api, lib, profiles, signIn, t }) => {
  const p = profiles.viewer;
  await signIn(p);
  await setMode(api, "closed");
  try {
    const sid = await cookieSignIn(srv, context, p);
    const lan = await lanThrough(srv, context, sid, lib.film2.id);
    if (!lan) return void t.skip("this machine has no home-network address for a TV to reach");
    await asIPhone(page);
    const marks = player.marks(page);
    await player.open(page, srv, lib.film2.id, { min: 1 });
    await tvInReach(page);
    await page.waitForFunction(() => /\/air\//.test(document.querySelector(".player video").getAttribute("src") || ""), null, { timeout: 10000 });
    const first = await srcOf(page);
    const tok1 = new URL(first).pathname.split("/")[2];
    await player.advancing(page, { by: 1, timeout: 20000 });
    // the link dies the way an expired one does: 401 on everything under it
    await page.route(`**/air/${tok1}/**`, (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"This AirPlay link has expired","airplay":true}' }));
    const at = await player.clock(page);
    // (Chrome's native player asks for its segments as it goes; the reload makes it ask now)
    await page.evaluate(() => { const v = document.querySelector(".player video"); v.dispatchEvent(new Event("error")); });
    await page.waitForFunction((tok) => {
      const s = document.querySelector(".player video").getAttribute("src") || "";
      return /\/air\//.test(s) && !s.includes(tok);
    }, tok1, { timeout: 10000 });
    const second = await srcOf(page);
    assert.equal(new URL(second).search, new URL(first).search, "the same stream");
    assert.equal(new URL(second).pathname.split("/").slice(3).join("/"), new URL(first).pathname.split("/").slice(3).join("/"));
    await player.advancing(page, { by: 1, timeout: 20000 });
    const now = await player.clock(page);
    assert.ok(now >= at - 2, `the same spot: ${at}s before, ${now}s after`);
    assert.equal(await page.locator(".player .player-error").count(), 0);
    assert.equal(marks.named("airplay").filter((m) => m.did === "twin").length >= 2, true, JSON.stringify(marks.all));
  } finally {
    await setMode(api, "open");
  }
});

ui.test("an iPhone's stream that errors after playing a while is the same stream again at that spot — not the full encode (a far server, a dropped connection)", {
  viewport: IPHONE,
}, async ({ page, srv, lib, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await asIPhone(page);
  const marks = player.marks(page);
  await player.open(page, srv, lib.film2.id, { min: 1 });
  const plain = await srcOf(page);
  assert.match(plain, /\/jit\/index\.m3u8\?seg=fmp4$/);
  // half a minute of the copy, played here: this device decodes it
  await player.waitClock(page, 33, 58, 60000);
  const at = await player.clock(page);
  await page.evaluate(() => document.querySelector(".player video").dispatchEvent(new Event("error")));
  await marks.wait((m) => m.name === "media-error" && m.did === "again", 5000, "the same stream again");
  await player.advancing(page, { by: 1, timeout: 20000 });
  assert.equal(await srcOf(page), plain, "the same stream (no &v=h264, no offset job)");
  const now = await player.clock(page);
  assert.ok(now >= at - 2, `the same spot: ${at}s before, ${now}s after`);
  assert.equal(await page.locator("#toasts .toast", { hasText: "re-encoding" }).count(), 0, "no 'refused the fast path'");
  assert.equal(marks.all.filter((m) => m.name === "media-error" && m.did === "h264").length, 0);
});

ui.test("an iPhone's stream that stops coming (segments asked for and never answered): a nudge, then at 20 s a seek where it stands — and it plays on when the answers come", {
  viewport: IPHONE,
}, async ({ page, srv, lib, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await asIPhone(page);
  const marks = player.marks(page);
  // the first segments come; from the fourth on, the requests are taken and held
  const held = [];
  await page.route(/\/jit\/seg000(0[3-9]|[1-9]\d)\.m4s/, (route) => { held.push(route); });
  await player.open(page, srv, lib.film2.id, { min: 1 });
  const plain = await srcOf(page);
  await marks.wait((m) => m.name === "stall" && m.stage === "nudge", 60000, "the nudge");
  const kick = await marks.wait((m) => m.name === "stall" && m.stage === "kick", 30000, "the kick");
  assert.equal(kick.did, "seek", "no AirPlay link here: a seek where it stands");
  // the phone kept the film's own picture: a short buffer on Safari's own
  // player is no reason to step down onto a live encode (the line is fast)
  assert.equal(marks.named("step-down").length, 0, JSON.stringify(marks.all));
  assert.equal(await srcOf(page), plain, "the same stream, not re-pointed yet");
  assert.ok(held.length >= 1, "the segments were asked for");
  // the answers come
  await page.unroute(/\/jit\/seg000(0[3-9]|[1-9]\d)\.m4s/);
  for (const r of held.splice(0)) r.continue().catch(() => {});
  await player.advancing(page, { by: 1, timeout: 30000 });
  assert.equal(await srcOf(page), plain);
  assert.equal(await page.locator(".player .player-error").count(), 0);
  assert.equal(await page.locator("#toasts .toast", { hasText: "re-encoding" }).count(), 0);
});

ui.run({ concurrency: 1 });
