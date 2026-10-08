// The player, on a file the browser plays as it is (Test Film One: MP4,
// H.264 + AAC, English and Hebrew sidecar subtitles): transport, seeking,
// speed, subtitles, the settings menu, resume, leaving, Media Session.
// Episodes are in player-episodes.test.js; the repackaged (hls.js) path,
// audio switching and stall recovery are in player-hls.test.js.
const assert = require("node:assert/strict");
const { suite, player, quietFor, waitForScreen, FILM_SECONDS } = require("./helpers");

const ui = suite();
const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: at ${actual.toFixed(2)}s, expected ${expected}s ± ${tolerance}`);

ui.test("the MP4 plays as the file itself, and the clock runs", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const marks = player.marks(page);
  await player.open(page, srv, lib.film1.id);

  const path = await marks.wait((m) => m.name === "path", 5000, "the path mark");
  assert.equal(path.path, "direct", "this file should need no repackaging");
  const s = await player.state(page);
  assert.ok(s.src.endsWith(`/stream/video/${lib.film1.id}`), `playing ${s.src}`);
  near(s.duration, FILM_SECONDS, 0.5, "duration");
  assert.equal(await page.textContent(".player-title"), "Test Film One");
  assert.equal(await page.textContent(".player-subtitle"), "2020");
  await marks.wait((m) => m.name === "first-frame", 5000, "the first-frame mark");
});

ui.test("pause and play: the button, then Space", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);

  await player.press(page, "Play/Pause");
  await page.waitForFunction(() => document.querySelector(".player video").paused);
  const held = (await player.state(page)).t;
  await page.waitForTimeout(600);
  assert.equal((await player.state(page)).t, held, "the clock kept running while paused");

  await player.press(page, "Play/Pause");
  await player.playing(page);

  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector(".player video").paused);
  await page.keyboard.press("Space");
  await player.playing(page);
});

ui.test("the ±10 s buttons and the arrow keys move the film ten seconds", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id, { min: 1 });

  let before = (await player.state(page)).t;
  await player.press(page, "Forward 10 seconds");
  await page.waitForFunction((b) => document.querySelector(".player video").currentTime > b + 9, before);
  near((await player.state(page)).t, before + 10, 2, "after Forward 10");
  await player.advancing(page);
  await page.waitForTimeout(1000); // a second press inside 0.9 s would chain into a bigger jump

  before = (await player.state(page)).t;
  await player.press(page, "Back 10 seconds");
  await page.waitForFunction((b) => document.querySelector(".player video").currentTime < b - 8, before);
  near((await player.state(page)).t, before - 10, 2, "after Back 10");
  await player.advancing(page);
  await page.waitForTimeout(1000);

  // the keyboard: focus is not on a control, so left/right seek
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  before = (await player.state(page)).t;
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((b) => document.querySelector(".player video").currentTime > b + 9, before);
  near((await player.state(page)).t, before + 10, 2, "after ArrowRight");
  await page.waitForTimeout(1000);
  before = (await player.state(page)).t;
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction((b) => document.querySelector(".player video").currentTime < b - 8, before);
  near((await player.state(page)).t, before - 10, 2, "after ArrowLeft");
  await player.advancing(page);
});

ui.test("a click on the timeline lands there and the film keeps playing", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);

  await player.scrubTo(page, 0.5);
  await page.waitForFunction((want) => Math.abs(document.querySelector(".player video").currentTime - want) < 3, FILM_SECONDS / 2);
  near((await player.state(page)).t, FILM_SECONDS / 2, 2.5, "after a click at 50%");
  await player.advancing(page);
  near(await player.clock(page), FILM_SECONDS / 2, 4, "the printed clock");

  // and back, to a quarter
  await player.scrubTo(page, 0.25);
  await page.waitForFunction((want) => Math.abs(document.querySelector(".player video").currentTime - want) < 3, FILM_SECONDS / 4);
  await player.advancing(page);
  assert.equal((await player.state(page)).paused, false);
});

ui.test("the Speed menu changes the playback rate and marks the choice", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);

  const items = await player.menu(page, "Speed");
  assert.deepEqual(items.map((i) => i.text), ["0.5×", "0.75×", "Normal", "1.25×", "1.5×", "2×"]);
  assert.deepEqual(items.filter((i) => i.active).map((i) => i.text), ["Normal"]);

  await page.locator(".player .menu .menu-item", { hasText: "1.5×" }).click();
  await page.waitForFunction(() => document.querySelector(".player video").playbackRate === 1.5);
  assert.deepEqual((await player.menu(page, "Speed")).filter((i) => i.active).map((i) => i.text), ["1.5×"]);
  await page.locator(".player .menu .menu-item", { hasText: "Normal" }).click();
  await page.waitForFunction(() => document.querySelector(".player video").playbackRate === 1);
  await player.advancing(page);
});

ui.test("the Subtitles menu lists the tracks; a pick shows its cues, Off hides them, and the pick is saved to the profile", async ({ page, srv, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await player.open(page, srv, lib.film1.id);

  const items = await player.menu(page, "Subtitles");
  assert.deepEqual(items.map((i) => i.text).filter((t) => !/Resync/.test(t)), ["Off", "English", "Hebrew"]);

  await page.locator(".player .menu .menu-item", { hasText: "Hebrew" }).click();
  await page.waitForFunction(() => {
    const tracks = [...document.querySelector(".player video").textTracks];
    const he = tracks.find((t) => t.label === "Hebrew");
    return he && he.mode === "showing" && he.activeCues && he.activeCues.length && /^HE cue/.test(he.activeCues[0].text);
  });
  assert.deepEqual((await player.state(page)).showing, ["Hebrew"], "exactly one track may show");
  await page.waitForFunction(async (id) => ((await (await fetch("/api/profiles")).json()).find((p) => p.id === id).prefs || {}).subPick === "he", me.id);

  await player.pick(page, "Subtitles", "English");
  await page.waitForFunction(() => {
    const en = [...document.querySelector(".player video").textTracks].find((t) => t.label === "English");
    return en && en.mode === "showing" && en.activeCues && en.activeCues.length && /^EN cue/.test(en.activeCues[0].text);
  });
  assert.deepEqual((await player.state(page)).showing, ["English"]);
  assert.equal((await api.profile(me.id)).prefs.subPick, "en");

  await player.pick(page, "Subtitles", "Off");
  await page.waitForFunction(() => [...document.querySelector(".player video").textTracks].every((t) => t.mode !== "showing"));
  await page.waitForFunction(async (id) => ((await (await fetch("/api/profiles")).json()).find((p) => p.id === id).prefs || {}).subPick === "off", me.id);
  assert.deepEqual((await player.menu(page, "Subtitles")).filter((i) => i.active).map((i) => i.text), ["Off"]);
  await page.keyboard.press("Escape");
  await player.advancing(page);
});

ui.test("the subtitle choice follows the profile to the next title: Hebrew stays Hebrew, Off stays off", async ({ page, srv, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { subPick: "he" } }, await api.as(me));
  await signIn(me);
  await player.open(page, srv, lib.film1.id);
  await page.waitForFunction(() => [...document.querySelector(".player video").textTracks].some((t) => t.label === "Hebrew" && t.mode === "showing"));
  assert.deepEqual((await player.state(page)).showing, ["Hebrew"]);

  // leave, switch the remembered pick to "off" (as the menu would), come back
  await player.press(page, "Back");
  await page.waitForSelector(".player", { state: "detached" });
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { subPick: "off" } }, await api.as(me));
  await page.reload();
  await waitForScreen(page);
  await player.open(page, srv, lib.film1.id);
  await page.waitForTimeout(800); // the auto-pick runs at load: give it the chance to get it wrong
  assert.deepEqual((await player.state(page)).showing, []);
});

ui.test("the Settings menu opens with its sections, each with an icon", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  await player.press(page, "Settings");
  await page.waitForSelector(".player .menu .menu-title");
  const sections = await page.evaluate(() => [...document.querySelectorAll(".player .menu .menu-title")].map((t) => ({ name: t.textContent.trim(), icon: !!t.querySelector("svg") })));
  for (const want of ["Quality", "Playback", "Subtitle style"]) {
    assert.ok(sections.some((s) => s.name === want), `no "${want}" section in ${JSON.stringify(sections)}`);
  }
  assert.deepEqual(sections.filter((s) => !s.icon), [], "sections without an icon");
  // one audio track: no Audio section to choose from
  assert.ok(!sections.some((s) => s.name === "Audio"));
  // "Autoplay next episode" flips in place
  const autoplay = page.locator(".player .menu .menu-item", { hasText: "Autoplay next episode" });
  assert.match(await autoplay.textContent(), /On$/);
  await autoplay.click();
  await page.waitForFunction(() => /Off$/.test([...document.querySelectorAll(".player .menu .menu-item")].find((b) => /Autoplay next episode/.test(b.textContent)).textContent));
  await page.keyboard.press("Escape");
  await page.waitForSelector(".player .menu", { state: "detached" });
  assert.match(await page.evaluate(() => location.hash), /^#\/play\//, "Escape closed the menu, not the film");
});

// APPLICATION BUG (reported, not fixed here). player.js builds the tag of
// Quality → Original as: currentV === "copy" ? "the file as it is" :
// "re-encoded — this device can't play the file's codec". A file that plays
// DIRECTLY has no currentV at all, so the one case where nothing whatsoever
// is re-encoded is labelled as a re-encode.
ui.test("Quality → Original does not claim a re-encode for a file that plays directly", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  const items = await player.menu(page, "Settings");
  const original = items.find((i) => i.text === "Original");
  assert.ok(original, "no Original row");
  assert.doesNotMatch(original.tag, /re-encoded/);
});

ui.test("resume: leave part-way, reopen, and it picks up there (not at 0, not later)", async ({ page, srv, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/movies");
  await player.open(page, srv, lib.film1.id);
  await player.scrubTo(page, 0.5);
  await page.waitForFunction((want) => Math.abs(document.querySelector(".player video").currentTime - want) < 3, FILM_SECONDS / 2);
  await player.advancing(page, { by: 1 });
  const left = (await player.state(page)).t;

  await player.press(page, "Back");
  await page.waitForSelector(".player", { state: "detached" });
  // leaving saves; the title's card says how far in it is
  await page.waitForFunction(async (a) => {
    const [id, token] = a;
    const r = await fetch(`/api/profiles/${id}/state`, { headers: token ? { "X-Profile-Token": token } : {} });
    const p = (await r.json()).progress || {};
    return Object.values(p).some((x) => x.position > 10);
  }, [me.id, null]);
  const saved = (await api.state(me)).progress[lib.film1.id];
  near(saved.position, left, 2, "the saved position");

  await player.open(page, srv, lib.film1.id, { min: 5 });
  const back = (await player.state(page)).t;
  assert.ok(back > 10, `reopened at ${back.toFixed(1)}s: that is the start, not a resume`);
  assert.ok(back <= left + 1.5, `reopened at ${back.toFixed(1)}s, PAST where it was left (${left.toFixed(1)}s)`);
  assert.ok(back >= left - 10, `reopened at ${back.toFixed(1)}s, more than ten seconds before where it was left (${left.toFixed(1)}s)`);
  // and says so
  assert.match(await page.textContent(".player .resume-pill"), /Resumed at 0:\d\d/);
});

ui.test("Start over from the resume pill goes back to the top", async ({ page, srv, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.film1.id, 30, 60);
  await signIn(me);
  await player.open(page, srv, lib.film1.id, { min: 5 });
  await page.click('.player .resume-pill button:has-text("Start over")');
  await page.waitForFunction(() => document.querySelector(".player video").currentTime < 5);
  await player.advancing(page);
});

ui.test("leaving returns to the screen you came from: the Back button, and the Back key", async ({ page, srv, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto("#/movies");
  await player.open(page, srv, lib.film1.id);
  await player.press(page, "Back");
  await page.waitForFunction(() => location.hash === "#/movies");
  await page.waitForSelector(".player", { state: "detached" });
  await page.waitForSelector(".grid .card");

  await goto(`#/movie/${lib.film1.id}`);
  await player.open(page, srv, lib.film1.id);
  // Escape first puts the controls away, then leaves
  await player.wake(page);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".player").classList.contains("controls-hidden"));
  assert.match(await page.evaluate(() => location.hash), /^#\/play\//);
  await page.keyboard.press("Escape");
  await page.waitForFunction((id) => location.hash === `#/movie/${id}`, lib.film1.id);
  await page.waitForSelector(".player", { state: "detached" });
  await page.waitForSelector(".detail-title");
});

ui.test("Media Session carries the title and a picture; PiP is offered; AirPlay is not", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  const ms = await player.mediaSession(page);
  assert.ok(ms, "navigator.mediaSession.metadata is not set");
  assert.equal(ms.title, "Test Film One");
  assert.equal(ms.album, "Aurora");
  assert.ok(ms.artwork >= 1, "no artwork");
  assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), "playing");

  await player.wake(page);
  const pip = page.locator(player.ctrl("Picture in picture"));
  assert.equal(await pip.count(), 1);
  await pip.waitFor({ state: "visible" });
  // AirPlay is Safari's: the button exists and stays hidden everywhere else
  const air = page.locator(player.ctrl("AirPlay"));
  assert.equal(await air.count(), 1);
  assert.ok(await air.evaluate((b) => b.classList.contains("hidden") && getComputedStyle(b).display === "none"), "the AirPlay button is showing in Chrome");

  await player.press(page, "Play/Pause");
  await page.waitForFunction(() => navigator.mediaSession.playbackState === "paused");
});

ui.test("Mute and the M key silence and restore the sound", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film1.id);
  const muted = () => page.evaluate(() => { const v = document.querySelector(".player video"); return v.muted || v.volume === 0; });
  assert.equal(await muted(), false);
  await player.press(page, "Mute");
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return v.muted || v.volume === 0; });
  await page.keyboard.press("m");
  await page.waitForFunction(() => { const v = document.querySelector(".player video"); return !v.muted && v.volume > 0; });
  await player.advancing(page);
});

ui.test("the film plays to its end and returns to where it was opened from", async ({ page, srv, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/movies");
  await player.open(page, srv, lib.film1.id);
  await player.jump(page, FILM_SECONDS - 3);
  await page.waitForSelector(".player", { state: "detached", timeout: 15000 });
  await page.waitForFunction(() => location.hash === "#/movies");
  const p = (await api.state(me)).progress[lib.film1.id];
  assert.ok(p && p.finished, `the film is not marked finished: ${JSON.stringify(p)}`);
});

ui.test("nothing is reported for ten seconds after leaving the player", async ({ page, srv, goto, signIn, freshProfile, lib, problems }) => {
  await signIn(await freshProfile());
  await goto("#/movies");
  await player.open(page, srv, lib.film1.id);
  await player.pick(page, "Subtitles", "Hebrew");
  await player.scrubTo(page, 0.4);
  await player.advancing(page);
  await player.press(page, "Back");
  await page.waitForSelector(".player", { state: "detached" });
  await page.waitForSelector(".grid .card");
  // every timer, listener and request the player owned should be gone
  const requests = [];
  page.on("request", (r) => { if (/\/stream\/|\/api\/play-mark/.test(r.url())) requests.push(r.url()); });
  await quietFor(page, problems, 10000);
  assert.equal(await page.locator("video").count(), 0, "a <video> element outlived the player");
  assert.deepEqual(requests, [], "the player kept asking for media after it was closed");
});

ui.run({ concurrency: 6 });
