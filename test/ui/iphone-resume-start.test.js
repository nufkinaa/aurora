// An iPhone resuming a repackaged film (2026-10-28, elia: "it took way too
// long to load", 7.6 s on his iPhone). In real Chrome given an iPhone's user
// agent: Chrome plays HLS natively, so the player takes the iPhone's path —
// no hls.js, the jit stream in fMP4 on the element's own src.
//
// The element used to be given the plain playlist and began at the TOP of the
// film; the seek to the resume point came at loadedmetadata, after the top's
// first segments had been made and fetched. Now its address says where it
// begins (?start=&until=) and the playlist says so in HLS's words
// (EXT-X-START), for a player that honours it (Apple's — ASSUMED: no Apple
// device in the rig; Chrome's own HLS ignores the tag, so here the old seek
// still does the work, and must still land). And the start-up mark the
// player posts comes back with the server's own side of the start.
"use strict";
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const IPHONE = { width: 402, height: 683 };
const asIPhone = (page) => page.addInitScript((ua) => { Object.defineProperty(navigator, "userAgent", { get: () => ua }); }, UA);
const srcOf = (page) => page.evaluate(() => document.querySelector(".player video").getAttribute("src") || "");

const ui = suite();

ui.test("an iPhone resuming the jit copy: the address and the playlist say where it begins, it lands there and plays; the start-up line has the server's side", {
  viewport: IPHONE,
}, async ({ page, srv, lib, signIn, freshProfile }) => {
  const p = await freshProfile();
  await signIn(p);
  const film = lib.film2;
  await srv.api.setProgress(p, film.id, 30, film.duration || 60);
  await asIPhone(page);
  const playlists = [];
  page.on("response", async (res) => {
    if (/\/jit\/index\.m3u8/.test(res.url())) { try { playlists.push({ url: res.url(), text: await res.text() }); } catch {} }
  });
  const marks = player.marks(page);
  await player.open(page, srv, film.id, { min: 20 });
  // the element's address: the plain jit playlist plus where it begins (30 − 4 s)
  const src = await srcOf(page);
  const m = /^\/stream\/transcode\/[^/]+\/jit\/index\.m3u8\?seg=fmp4&start=(\d+)&until=(\d+)$/.exec(src);
  assert.ok(m, `the element's address: ${src}`);
  assert.equal(Number(m[1]), 26);
  assert.ok(Math.abs(Number(m[2]) - (Date.now() / 1000 + 300)) < 60, `until ${m[2]}`);
  assert.equal(await page.evaluate(() => !!window.Hls), false, "hls.js never loaded");
  // the playlist the element got says it in HLS's words
  const native = playlists.find((x) => x.url.includes("start=26"));
  assert.ok(native, `the native player's playlist: ${playlists.map((x) => x.url).join(" ")}`);
  assert.match(native.text, /^#EXT-X-START:TIME-OFFSET=26\.000,PRECISE=YES$/m);
  // …and nothing else about it changed: the same segments as the plain one
  const strip = (t) => t.replace(/#EXT-X-START:[^\n]*\n/, "");
  const plain = playlists.find((x) => !x.url.includes("start="));
  if (plain) assert.equal(strip(native.text), strip(plain.text));
  // it plays from the resume point (not from the top)
  const at = await player.clock(page);
  assert.ok(at >= 25 && at < 45, `playing at ${at}`);
  await player.advancing(page, { by: 1 });
  // the start-up mark, and the server's side added to it (lib/starttrace.js)
  await marks.wait((x) => x.name === "start-up", 15000, "the start-up mark");
  let line = null;
  for (let i = 0; i < 40 && !line; i++) {
    line = srv.log().find((l) => l.includes(`[play] ${film.id.slice(0, 12)}`) && / start-up /.test(l) && / srv=/.test(l)) || null;
    if (!line) await page.waitForTimeout(150);
  }
  assert.ok(line, `the start-up log line with the server's side:\n${srv.log().filter((l) => /\[play\]/.test(l)).slice(-6).join("\n")}`);
  assert.match(line, /srv=pl:\d+,init:\d+,seg\d+:\d+@\d+,(made|ready),n:\d+,slow:\d+/);
  await page.screenshot({ path: require("path").join(__dirname, "artifacts", "iphone-resume-start.png") }).catch(() => {});
});

ui.run({ concurrency: 1 });
