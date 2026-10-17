// AirPlay from the web player, end to end on a private server — with
// WebKit's AirPlay API stubbed into Chrome (no Apple device is in reach in
// the test rig; docs/qa/airplay/REPORT.md has the steps for a real one).
//
// What a real Apple TV does that is played here by hand: Safari says a TV is
// in reach (webkitplaybacktargetavailabilitychanged), the element starts and
// stops playing to it (webkitcurrentplaybacktargetiswirelesschanged), and the
// TV fetches the address it was given ITSELF — here, Node's fetch with no
// cookie and no header, exactly what a receiver has.
//
// Ratings for the kids test (data/cache/certificates.json, seeded):
//   Test Film One  all ages      Test Show  7+      Test Film Two  18+
const assert = require("node:assert/strict");
const { suite, player, certificatesSeed } = require("./helpers");

const ui = suite({
  server: { seed: { "cache/certificates.json": certificatesSeed({ film1: 0, show: 7, film2: 18 }) } },
  setup: async (srv) => {
    const p = await srv.api.createProfile("Airy");
    await srv.api.post("/api/auth/claim", { profileId: p.id, username: "airy" }, await srv.api.as(p));
    srv.profiles.viewer = { ...p, username: "airy" };
    srv.profiles.kid = await srv.api.createProfile("Airkid", { open: true, kids: { maxAge: 7 } });
    srv.profiles.grown = await srv.api.createProfile("Airgrown", { open: true });
  },
});

const setMode = (api, mode) => api.adminPost("/api/admin/auth-mode", { mode });
const WALL_401 = /Failed to load resource.*401/;
// the element asking for the TV's stream at this machine's home-network
// address, which the rig fences off (and Chrome could not play it anyway)
const TV_STREAM = /Failed to load resource.*\/air\//;

// WebKit's AirPlay surface, as Safari has it, on Chrome's <video>
const stubWebKit = (page) => page.addInitScript(() => {
  window.__air = { wireless: false, picker: 0 };
  window.WebKitPlaybackTargetAvailabilityEvent = function WebKitPlaybackTargetAvailabilityEvent() {};
  Object.defineProperty(HTMLMediaElement.prototype, "webkitCurrentPlaybackTargetIsWireless", {
    configurable: true,
    get() { return window.__air.wireless; },
  });
  HTMLMediaElement.prototype.webkitShowPlaybackTargetPicker = function () { window.__air.picker++; };
});
const tvInReach = (page, on = true) => page.evaluate((on) => {
  const e = new Event("webkitplaybacktargetavailabilitychanged");
  e.availability = on ? "available" : "not-available";
  document.querySelector(".player video").dispatchEvent(e);
}, on);
const wireless = (page, on) => page.evaluate((on) => {
  window.__air.wireless = on;
  document.querySelector(".player video").dispatchEvent(new Event("webkitcurrentplaybacktargetiswirelesschanged"));
}, on);
const airBtn = '.player .pbtn[aria-label="AirPlay"]';
const hidden = (page) => page.evaluate((sel) => { const b = document.querySelector(sel); return !b || b.classList.contains("hidden"); }, airBtn);

// What a receiver fetches: nothing but the address.
const bare = async (url) => {
  const r = await fetch(url, { redirect: "manual" });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type") || "", text: buf.toString("utf8"), bytes: buf.length };
};
const uris = (m3u8) => m3u8.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));

ui.test("a server that requires sign-in: the TV's link plays with no credential, for this title only; the player switches to it on AirPlay and back after", {
  allow: [WALL_401, TV_STREAM],
}, async ({ page, context, srv, api, lib, profiles, signIn }) => {
  const p = profiles.viewer;
  await signIn(p); // (the remembered profile; asked while the server is still open)
  await setMode(api, "closed");
  try {
    // signed in the way a browser is: the session cookie
    const login = await fetch(`${srv.url}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: p.username, password: p.password }),
    });
    assert.equal(login.status, 200);
    const sid = /aurora_session=([^;]+)/.exec(login.headers.get("set-cookie"))[1];
    await context.addCookies([{ name: "aurora_session", value: sid, url: srv.url }]);
    await stubWebKit(page);

    await player.open(page, srv, lib.film2.id, { min: 1 });
    // hls.js plays it; no TV yet, no button
    assert.match((await player.state(page)).src, /^blob:/);
    assert.equal(await hidden(page), true, "no AirPlay button before a TV is in reach");
    await tvInReach(page);
    await page.waitForFunction((sel) => !document.querySelector(sel).classList.contains("hidden"), airBtn);
    await player.press(page, "AirPlay");
    assert.equal(await page.evaluate(() => window.__air.picker), 1, "the press opens Safari's picker");

    await player.waitClock(page, 3, 40);
    const before = await player.clock(page);
    await wireless(page, true);
    await page.waitForFunction(() => /\/air\//.test(document.querySelector(".player video").getAttribute("src") || ""), null, { timeout: 10000 });
    const given = await page.evaluate(() => document.querySelector(".player video").getAttribute("src"));
    // absolute (the TV is another device), signed, the AirPlay master (Film Two has subtitles).
    // This page is on 127.0.0.1, which a TV can't reach: the server gives
    // its home-network address instead when this machine has one.
    const u = new URL(given);
    assert.equal(u.port, new URL(srv.url).port);
    assert.ok(u.hostname === "127.0.0.1" || /^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\./.test(u.hostname), given);
    // (fetched through the private server's own address: it may not listen on the LAN)
    const src = `${srv.url}${u.pathname}${u.search}`;
    assert.match(u.pathname, new RegExp(`^/air/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/stream/airplay/${lib.film2.id}/master\\.m3u8$`));
    assert.match(u.search, /seg=fmp4/);
    assert.equal(await page.evaluate(() => document.querySelector(".player video").querySelectorAll("source").length), 0, "no <source> left from hls.js");

    // ---- the receiver's fetches: no cookie, no header ----
    const master = await bare(src);
    assert.equal(master.status, 200, master.text);
    assert.match(master.type, /mpegurl/i);
    assert.match(master.text, /#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"/);
    assert.match(master.text, /#EXT-X-STREAM-INF:BANDWIDTH=\d+,SUBTITLES="subs"/);
    const variant = new URL(uris(master.text)[0], src).href;
    assert.ok(variant.includes(u.pathname.split("/stream/")[0] + "/stream/transcode/"), "the variant keeps the token");
    const media = await bare(variant);
    assert.equal(media.status, 200, media.text);
    assert.match(media.text, /#EXT-X-MAP:URI="init\.mp4/);
    const init = await bare(new URL(/URI="([^"]+)"/.exec(media.text)[1], variant).href);
    assert.equal(init.status, 200);
    assert.match(init.type, /video\/mp4/);
    const seg0 = await bare(new URL(uris(media.text)[0], variant).href);
    assert.equal(seg0.status, 200);
    assert.ok(seg0.bytes > 1000, "a real segment");
    const subUri = /#EXT-X-MEDIA:TYPE=SUBTITLES[^\n]*URI="([^"]+)"/.exec(master.text)[1];
    const subList = await bare(new URL(subUri, src).href);
    assert.equal(subList.status, 200);
    const vtt = await bare(new URL(uris(subList.text)[0], new URL(subUri, src)).href);
    assert.equal(vtt.status, 200, vtt.text);
    assert.match(vtt.text, /^WEBVTT[^\n]*\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00\.000\n/);
    assert.match(vtt.text, /-->/);

    // ---- and nothing else ----
    const token = u.pathname.split("/")[2];
    assert.equal((await bare(`${srv.url}/air/${token}/stream/video/${lib.film1.id}`)).status, 403, "another title");
    assert.equal((await bare(`${srv.url}/air/${token}/api/library`)).status, 403, "the API");
    assert.equal((await bare(`${srv.url}/air/${token}/stream/download/${lib.film2.id}`)).status, 403, "taking the file away");
    assert.equal((await bare(`${srv.url}/stream/transcode/${lib.film2.id}/jit/index.m3u8?seg=fmp4`)).status, 401, "the same stream without the link");
    assert.equal((await bare(`${srv.url}/air/${token.slice(0, -3)}abc/stream/airplay/${lib.film2.id}/master.m3u8`)).status, 401, "a changed token");

    // Chrome cannot play what an Apple TV plays: the element's error is
    // AirPlay's (a fresh link, then a word) — not the player's fallbacks
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(".player .player-error").count(), 0, "no error card while on AirPlay");

    // ---- AirPlay ends: hls.js again, near where it was ----
    await wireless(page, false);
    await page.waitForFunction(() => /^blob:/.test(document.querySelector(".player video").currentSrc || ""), null, { timeout: 15000 });
    // (Chrome never played the TV's stream, so the element stood paused —
    // a TV that was paused comes back paused; this one is started by hand)
    await page.waitForFunction(() => document.querySelector(".player video").readyState >= 2, null, { timeout: 15000 });
    await page.evaluate(() => document.querySelector(".player video").play().catch(() => {}));
    await player.playing(page, { min: 0 });
    const after = await player.clock(page);
    assert.ok(after >= before - 4, `picked up near ${before}s, at ${after}s`);
    assert.equal(await page.locator(".player .player-error").count(), 0);

    // ---- signing out ends the link ----
    await fetch(`${srv.url}/api/auth/logout`, { method: "POST", headers: { Cookie: `aurora_session=${sid}` } });
    const dead = await bare(src);
    assert.equal(dead.status, 401);
    assert.match(dead.text, /sign-in has ended/);
  } finally {
    await setMode(api, "open");
  }
});

ui.test("kids rules: no link for a title the kids profile may not see; a grown-up's link stops when the profile becomes a kids one", async ({ api, srv, lib, profiles }) => {
  const ask = async (profile, path) => api.call("POST", "/api/airplay/link", { path }, await api.as(profile));
  const kid = profiles.kid;
  const no = await ask(kid, `/stream/transcode/${lib.film2.id}/jit/index.m3u8?seg=fmp4`);
  assert.equal(no.status, 403);
  assert.equal(no.body.kids, true);
  const yes = await ask(kid, `/stream/video/${lib.film1.id}`);
  assert.equal(yes.status, 200);
  assert.match(yes.body.url, new RegExp(`^/air/[^/]+/stream/video/${lib.film1.id}$`));
  assert.equal(yes.body.needed, false, "an open server: the plain address plays for anyone on the network");
  assert.equal((await fetch(srv.url + yes.body.url)).status, 200);
  // a path no link may open is not signed at all
  for (const path of [`/stream/download/${lib.film1.id}`, "/api/library", `/img/still/${lib.film1.id}`, "/stream/video/x/../y"]) {
    assert.equal((await ask(kid, path)).status, 400, path);
  }
  assert.equal((await ask(kid, `/stream/video/${lib.film1.id}?u=https://x`)).status, 400, "a query is the stream's own words only");
  assert.equal((await ask(kid, "/stream/video/000000000000")).status, 404);

  const grown = profiles.grown;
  const link = await ask(grown, `/stream/transcode/${lib.film2.id}/jit/index.m3u8?seg=fmp4`);
  assert.equal(link.status, 200);
  assert.equal((await fetch(srv.url + link.body.url)).status, 200);
  await api.adminPost(`/api/admin/profiles/${grown.id}/kids`, { kids: { maxAge: 7 } });
  try {
    const r = await fetch(srv.url + link.body.url);
    assert.equal(r.status, 403, "judged by the profile's rules NOW");
    assert.equal((await r.json()).kids, true);
  } finally {
    await api.adminPost(`/api/admin/profiles/${grown.id}/kids`, { kids: null });
  }
  assert.equal((await fetch(srv.url + link.body.url)).status, 200);
});

ui.test("a browser without AirPlay (Chrome): no button, and remote playback (Chromecast's Remote Playback API) left as it was", async ({ page, srv, lib, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  assert.equal(await hidden(page), true);
  const v = await page.evaluate(() => {
    const el = document.querySelector(".player video");
    return { drp: el.disableRemotePlayback, remote: !!el.remote, sources: el.querySelectorAll("source").length };
  });
  assert.equal(v.drp, false);
  assert.equal(v.sources, 0);
  await player.open(page, srv, lib.film2.id);
  assert.equal(await page.evaluate(() => document.querySelector(".player video").disableRemotePlayback), false, "hls.js on plain MediaSource leaves it alone too");
  assert.equal(await hidden(page), true);
});

ui.run({ concurrency: 1 });
