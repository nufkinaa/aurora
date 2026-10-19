// What this browser can play, said to the server, and what it buys (TV round
// 2026-10-19, parity with the TV app): the page reports once per load
// (public/js/avcaps.js → POST /api/caps), the title reads after it carry the
// server's decision (`play`, src/media/playpath.js), the player starts the
// way it says, and Settings → More settings → "On the TV" holds the two
// picture-and-sound settings the TV app applies (stored on the profile).
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, player, warmJit, PHONE, assertNoHorizontalOverflow } = require("./helpers");

const ui = suite({ setup: async (srv) => { await warmJit(srv, srv.lib.film2.id); } });

// screenshots a person looks at (docs/agent-briefs/COMMON-RULES.md): kept
// under the OS temp folder, outside the repository
const SHOTS = path.join(os.tmpdir(), "aurora-agents", "tv-av-quality", "shots");
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
};

const capsIdOf = (page) => page.waitForFunction(() => localStorage.getItem("aurora-caps-id"), null, { timeout: 15000 }).then((h) => h.jsonValue());

ui.test("the page says what it plays; a title read after it carries how it plays here", async ({ page, srv, signIn, freshProfile, lib, goto }) => {
  await signIn(await freshProfile());
  const reported = page.waitForResponse((r) => r.url().endsWith("/api/caps") && r.request().method() === "POST", { timeout: 15000 });
  await goto("#/");
  const res = await reported;
  assert.equal(res.status(), 200);
  const { id } = await res.json();
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(await capsIdOf(page), id);
  // what was said: this browser's own answers, in the server's words
  const kept = await (await fetch(`${srv.url}/api/caps/${id}`)).json();
  assert.equal(kept.client, "web");
  assert.ok(kept.video.h264 && kept.video.h264.profiles.includes("high"), JSON.stringify(kept.video));
  assert.ok(kept.audio.decode.includes("aac"));
  assert.deepEqual(kept.audio.passthrough, [], "a browser passes nothing through");
  const ac3 = await page.evaluate(() => !!document.createElement("video").canPlayType('audio/mp4; codecs="ac-3"'));
  assert.equal(kept.audio.decode.includes("ac3"), ac3, "AC-3 as the browser itself answers it");

  // the title page's read carries ?caps= and the decision
  const itemRead = page.waitForResponse((r) => r.url().includes(`/api/item/${lib.film2.id}`) && r.url().includes(`caps=${id}`), { timeout: 15000 });
  await goto(`#/movie/${lib.film2.id}`);
  const item = await (await itemRead).json();
  assert.ok(item.play, "the item carries the server's decision");
  // Film Two: MKV, H.264, AC-3 — the copy where the browser cannot hear AC-3
  assert.equal(item.play.mode, ac3 ? "direct" : "remux", item.play.why.join(" | "));
  assert.equal(item.play.decodes, true);
  // Film One: MP4, H.264, AAC — as it is
  const one = await page.evaluate(async ({ fid, cid }) => (await (await fetch(`/api/item/${fid}?caps=${cid}`)).json()).play, { fid: lib.film1.id, cid: id });
  assert.equal(one.mode, "direct");
});

ui.test("the player starts the way the server decided", async ({ page, srv, signIn, freshProfile, lib, goto }) => {
  await signIn(await freshProfile());
  await goto("#/");
  await capsIdOf(page);
  // Film One: the file itself
  let marks = player.marks(page);
  await player.open(page, srv, lib.film1.id);
  assert.equal((await marks.wait((m) => m.name === "path", 8000, "the path mark")).path, "direct");
  assert.ok((await player.state(page)).src.endsWith(`/stream/video/${lib.film1.id}`));
  // Film Two (AC-3): the server's copy, the picture untouched — unless this browser hears AC-3
  const ac3 = await page.evaluate(() => !!document.createElement("video").canPlayType('audio/mp4; codecs="ac-3"'));
  await goto("#/movies");
  marks = player.marks(page);
  await player.open(page, srv, lib.film2.id);
  const p = await marks.wait((m) => m.name === "path", 8000, "the path mark");
  if (ac3) assert.equal(p.path, "direct");
  else {
    assert.notEqual(p.path, "direct");
    const first = await marks.wait((m) => m.name === "first-frame", 15000, "the first-frame mark");
    assert.equal(first.v, "copy", "the picture copied, not re-encoded");
  }
});

ui.test('Settings → "On the TV": both settings, kept on the profile, said to be TV-only', async ({ page, srv, signIn, freshProfile, goto, api }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/preferences");
  const more = page.locator(".pref-more-toggle");
  await more.waitFor();
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  const section = page.locator(".pref-section", { has: page.locator(".pref-head", { hasText: "On the TV" }) });
  await section.waitFor();
  assert.match(await section.innerText(), /A browser can't switch your screen's refresh rate/);
  const row = (label) => section.locator(".pref-item", { has: page.locator(".pref-item-label", { hasText: label }) });
  const value = (label) => row(label).locator(".pref-item-value");
  assert.equal((await value("Match frame rate").innerText()).trim(), "Auto");
  assert.equal((await value("Surround sound").innerText()).trim(), "Auto");
  // a choice of named values, never drawn as a switch (not even at "Off")
  assert.equal(await row("Match frame rate").locator('[role="switch"]').count(), 0);
  await section.scrollIntoViewIfNeeded();
  await shot(page, "settings-on-the-tv-desktop");

  await value("Match frame rate").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".pref-item")].some((r) => /Match frame rate/.test(r.innerText) && /\bOff\b/.test(r.querySelector(".pref-item-value").innerText)));
  assert.equal(await row("Match frame rate").locator('[role="switch"]').count(), 0);
  await value("Surround sound").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".pref-item")].some((r) => /Surround sound/.test(r.innerText) && /Stereo only/.test(r.querySelector(".pref-item-value").innerText)));
  // on the profile: what every TV of this person reads
  for (let i = 0; i < 40; i++) {
    const p = await api.profile(me.id);
    if (p.prefs && p.prefs.surround === "stereo" && p.prefs.matchFrameRate === "off") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const p = await api.profile(me.id);
  assert.equal(p.prefs.matchFrameRate, "off");
  assert.equal(p.prefs.surround, "stereo");
  // and back
  await page.reload();
  await page.locator(".pref-section", { has: page.locator(".pref-head", { hasText: "On the TV" }) }).waitFor();
  assert.equal((await value("Match frame rate").innerText()).trim(), "Off");
  assert.equal((await value("Surround sound").innerText()).trim(), "Stereo only");
  await value("Surround sound").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".pref-item")].some((r) => /Surround sound/.test(r.innerText) && /^\s*Auto\s*$/.test(r.querySelector(".pref-item-value").innerText)));
  for (let i = 0; i < 40 && (await api.profile(me.id)).prefs.surround !== "auto"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await api.profile(me.id)).prefs.surround, "auto");
});

ui.test('"On the TV" fits a phone', { viewport: PHONE }, async ({ page, signIn, freshProfile, goto }) => {
  await signIn(await freshProfile());
  await goto("#/preferences");
  const more = page.locator(".pref-more-toggle");
  await more.waitFor();
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  const section = page.locator(".pref-section", { has: page.locator(".pref-head", { hasText: "On the TV" }) });
  await section.waitFor();
  await section.scrollIntoViewIfNeeded();
  await assertNoHorizontalOverflow(page, "Settings with On the TV");
  await shot(page, "settings-on-the-tv-phone");
});

ui.run({ concurrency: 1 });
