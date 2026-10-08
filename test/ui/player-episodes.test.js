// The player across episodes (Test Show S01E01–E03, 45 s each): the Next
// episode button, Up next and its countdown, "Still watching?", what carries
// from one episode to the next, and where leaving an episode lands.
//
// Up next appears when 30 s are left (the window is max(30 s, 5% of the
// runtime), capped at 90 s), i.e. 15 s into these episodes, and counts down
// 15 s before it starts the next one.
const assert = require("node:assert/strict");
const { suite, player, EPISODE_SECONDS } = require("./helpers");

const ui = suite();
const UPNEXT_AT = EPISODE_SECONDS - 30;
const next = player.ctrl("Next episode");

ui.test("the Next episode button is there on episode 1, and pressing it plays episode 2", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.e1.id);
  assert.match(await page.textContent(".player-subtitle"), /^S1 E1/);

  // it learns what is next a moment after the start
  await page.waitForSelector(`${next}:not(.hidden)`, { state: "attached" });
  assert.match(await page.getAttribute(next, "title"), /S1 E2/);

  await player.tag(page);
  await player.press(page, "Next episode");
  await player.playing(page, { id: lib.e2.id, fresh: true });
  assert.match(await page.textContent(".player-subtitle"), /^S1 E2/);
  assert.ok((await player.state(page)).t < 8, "episode 2 did not start at its beginning");
  // a press is not "started by itself": no run is being counted
  assert.equal(await page.evaluate(() => sessionStorage.getItem("aurora-auto-run")), null);
});

ui.test("the last episode has no Next episode button", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.e3.id);
  await page.waitForTimeout(2500); // the lookup runs 1.5 s after the start
  assert.ok(await page.locator(next).evaluate((b) => b.classList.contains("hidden")));
});

ui.test("Up next appears near the end of episode 1, counts down, and starts episode 2 by itself", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.e1.id);
  assert.equal(await page.locator(".player .upnext").count(), 0, "Up next is up at the very start");

  // two seconds before its moment: not yet
  await player.jump(page, UPNEXT_AT - 2);
  await page.waitForFunction((t) => document.querySelector(".player video").currentTime >= t, UPNEXT_AT - 2);
  assert.equal(await page.locator(".player .upnext").count(), 0, "Up next came early");

  const card = page.locator(".player .upnext");
  await card.waitFor({ timeout: 8000 });
  const shownAt = (await player.state(page)).t;
  assert.ok(shownAt >= UPNEXT_AT - 0.5 && shownAt <= UPNEXT_AT + 3, `Up next appeared at ${shownAt.toFixed(1)}s, expected about ${UPNEXT_AT}s`);
  assert.equal(await card.locator(".k").textContent(), "Up next");
  assert.match(await card.locator(".t").textContent(), /S1 E2/);
  assert.equal((await card.locator(".btn-primary").textContent()).trim(), "Play now");
  const count = Number(await card.locator(".ring").textContent());
  assert.ok(count >= 12 && count <= 15, `the countdown reads ${count}`);
  // ...and it is counting
  await page.waitForFunction((c) => Number(document.querySelector(".player .upnext .ring").textContent) < c, count);

  await player.tag(page);
  await player.playing(page, { id: lib.e2.id, fresh: true, timeout: 25000 });
  assert.match(await page.textContent(".player-subtitle"), /^S1 E2/);
  assert.ok((await player.state(page)).t < 8, "episode 2 did not start at its beginning");
  // one episode has now started by itself
  const run = JSON.parse(await page.evaluate(() => sessionStorage.getItem("aurora-auto-run")));
  assert.equal(run.n, 1);
  assert.equal(run.to, lib.e2.id);
  // the lock screen follows to the new episode
  const ms = await player.mediaSession(page);
  assert.ok(ms, "Media Session metadata was wiped by the episode change");
  assert.equal(ms.title, "S1 E2");
  assert.equal(ms.artist, "Test Show");
});

ui.test("Media Session names the episode, and still does after going to the next one", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.e1.id);
  assert.deepEqual(await player.mediaSession(page), { title: "S1 E1", artist: "Test Show", album: "Aurora", artwork: 1 });
  await page.waitForSelector(`${next}:not(.hidden)`, { state: "attached" });
  await player.tag(page);
  await player.press(page, "Next episode");
  await player.playing(page, { id: lib.e2.id, fresh: true });
  // the old player's teardown must not blank what the new one wrote
  await page.waitForTimeout(1500);
  assert.deepEqual(await player.mediaSession(page), { title: "S1 E2", artist: "Test Show", album: "Aurora", artwork: 1 });
  assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), "playing");
});

ui.test("Play now on Up next starts the next episode at once; Dismiss keeps this one", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.e1.id);
  await player.jump(page, UPNEXT_AT + 1);
  const card = page.locator(".player .upnext");
  await card.waitFor({ timeout: 8000 });

  await card.locator("button", { hasText: "Dismiss" }).click();
  await card.waitFor({ state: "detached" });
  await page.waitForTimeout(1500);
  assert.equal(await card.count(), 0, "Up next came back after being dismissed");
  assert.ok((await page.evaluate(() => location.hash)).includes(lib.e1.id));
  await player.advancing(page);

  // a fresh visit: the card again, and this time Play now
  await player.press(page, "Back");
  await page.waitForSelector(".player", { state: "detached" });
  await player.open(page, srv, lib.e1.id, { query: "?restart=1" });
  await player.jump(page, UPNEXT_AT + 1);
  await card.waitFor({ timeout: 8000 });
  await player.tag(page);
  await card.locator(".btn-primary").click();
  await player.playing(page, { id: lib.e2.id, fresh: true });
  assert.equal(await page.evaluate(() => sessionStorage.getItem("aurora-auto-run")), null, "a press of Play now was counted as an automatic start");
});

ui.test("with autoplay off, Up next offers the episode but does not count down or start it", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await page.addInitScript(() => {
    try {
      const all = JSON.parse(localStorage.getItem("aurora-player") || "{}");
      all.autoplayNext = false;
      localStorage.setItem("aurora-player", JSON.stringify(all));
    } catch {}
  });
  await player.open(page, srv, lib.e1.id);
  await player.jump(page, UPNEXT_AT + 1);
  const card = page.locator(".player .upnext");
  await card.waitFor({ timeout: 8000 });
  assert.equal(await card.locator(".ring").count(), 0, "a countdown is showing with autoplay off");
  assert.equal((await card.locator(".btn-primary").textContent()).trim(), "Play now");
  await page.waitForTimeout(2500);
  assert.equal(await card.locator(".ring").count(), 0);
  assert.ok((await page.evaluate(() => location.hash)).includes(lib.e1.id));
});

ui.test("Still watching? replaces the countdown after three episodes started by themselves", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  // what the player itself writes when Up next runs out: { n, to, at }
  await page.addInitScript((id) => {
    try { sessionStorage.setItem("aurora-auto-run", JSON.stringify({ n: 3, to: id, at: Date.now() })); } catch {}
  }, lib.e2.id);
  // straight to the address, the way an automatic start arrives: any key or
  // click on the way would (rightly) end the run
  await page.goto(`${srv.url}/#/play/${lib.e2.id}`);
  await player.playing(page, { id: lib.e2.id });
  await player.jump(page, UPNEXT_AT + 1);

  const card = page.locator(".player .upnext");
  await card.waitFor({ timeout: 8000 });
  assert.ok(await card.evaluate((c) => c.classList.contains("still-watching")), "the ordinary Up next card came up instead");
  assert.equal(await card.locator(".k").textContent(), "Still watching?");
  assert.match(await card.locator(".t").textContent(), /S1 E3/);
  assert.equal(await card.locator(".ring").count(), 0, "there is a countdown on the Still watching card");
  assert.deepEqual((await card.locator("button").allTextContents()).map((t) => t.trim()), ["Keep watching", "I'm done"]);

  // nothing starts by itself: well past where a countdown would have been
  // visibly running, the card is as it was and the episode is the same
  await page.waitForTimeout(4000);
  assert.equal(await card.locator(".ring").count(), 0);
  assert.ok((await page.evaluate(() => location.hash)).includes(lib.e2.id));

  await player.tag(page);
  await card.locator("button", { hasText: "Keep watching" }).click();
  await player.playing(page, { id: lib.e3.id, fresh: true });
  assert.equal(await page.evaluate(() => sessionStorage.getItem("aurora-auto-run")), null, "answering did not end the run");
});

ui.test("a run that belongs to another episode is ignored: the countdown is back", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await page.addInitScript((id) => {
    try { sessionStorage.setItem("aurora-auto-run", JSON.stringify({ n: 3, to: id, at: Date.now() })); } catch {}
  }, lib.e3.id); // names episode 3; episode 1 is what gets opened
  await page.goto(`${srv.url}/#/play/${lib.e1.id}`);
  await player.playing(page, { id: lib.e1.id });
  await player.jump(page, UPNEXT_AT + 1);
  const card = page.locator(".player .upnext");
  await card.waitFor({ timeout: 8000 });
  assert.equal(await card.evaluate((c) => c.classList.contains("still-watching")), false);
  assert.match(await card.locator(".ring").textContent(), /^\d+$/);
});

ui.test("the subtitle picked on one episode is on for the next", async ({ page, srv, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await player.open(page, srv, lib.e1.id);
  await player.pick(page, "Subtitles", "Hebrew");
  await page.waitForFunction(() => [...document.querySelector(".player video").textTracks].some((t) => t.label === "Hebrew" && t.mode === "showing"));
  await page.waitForFunction(async (id) => ((await (await fetch("/api/profiles")).json()).find((p) => p.id === id).prefs || {}).subPick === "he", me.id);
  assert.equal((await api.profile(me.id)).prefs.subPick, "he");

  await page.waitForSelector(`${next}:not(.hidden)`, { state: "attached" });
  await player.tag(page);
  await player.press(page, "Next episode");
  await player.playing(page, { id: lib.e2.id, fresh: true });
  await page.waitForFunction(() => {
    const he = [...document.querySelector(".player video").textTracks].find((t) => t.label === "Hebrew");
    return he && he.mode === "showing" && he.activeCues && he.activeCues.length && /^HE e2 cue/.test(he.activeCues[0].text);
  });
  assert.deepEqual((await player.state(page)).showing, ["Hebrew"]);
});

ui.test("an episode resumes where it was left", async ({ page, srv, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.e2.id, 14, EPISODE_SECONDS);
  await signIn(me);
  await player.open(page, srv, lib.e2.id, { min: 5 });
  const t = (await player.state(page)).t;
  assert.ok(t >= 9 && t <= 16.5, `episode 2 resumed at ${t.toFixed(1)}s, expected just before 14s`);
});

ui.test("leaving an episode lands on its show's page", async ({ page, srv, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto(`#/show/${lib.show.id}`);
  await player.open(page, srv, lib.e1.id);
  await player.jump(page, 12);
  await player.advancing(page);
  await player.press(page, "Back");
  await page.waitForFunction((id) => location.hash === `#/show/${id}`, lib.show.id);
  await page.waitForSelector(".player", { state: "detached" });
  await page.waitForSelector(".episode-list .episode");
  // and the page knows how far the episode got
  await page.waitForFunction(() => !!document.querySelector('.episode[data-ep="1x1"] .episode-bar'));
  const p = (await api.state(me)).progress[lib.e1.id];
  assert.ok(p && p.position >= 11 && p.position <= 16, JSON.stringify(p));
});

// APPLICATION BUG (reported, not fixed here). exit() in player.js leaves an
// episode with navigate(`#/show/<id>`): a NEW history entry on top of
// [show page, player]. Back on that show page (Escape, a remote's Back, the
// browser's button) is history.back() — into the player again, which starts
// the episode. Back from there returns to the show page... and so on: the
// viewer cannot get past the show page with Back. Films leave with
// history.back() and do not have this.
ui.test("after leaving an episode, Back on the show page does not go back into the player", { todo: "app bug: exit() from an episode pushes #/show/<id> instead of going back" }, async ({ page, srv, goto, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await goto("#/shows");
  await goto(`#/show/${lib.show.id}`);
  await player.open(page, srv, lib.e1.id);
  await player.press(page, "Back");
  await page.waitForFunction((id) => location.hash === `#/show/${id}`, lib.show.id);
  await page.waitForSelector(".player", { state: "detached" });
  await page.waitForSelector(".episode-list .episode");

  await page.keyboard.press("Escape"); // Back, from the show's page
  await page.waitForFunction((id) => location.hash !== `#/show/${id}`, lib.show.id, { timeout: 5000 });
  assert.equal(await page.evaluate(() => location.hash), "#/shows", "Back from the show page went somewhere other than where the show was opened from");
});

ui.run({ concurrency: 6 });
