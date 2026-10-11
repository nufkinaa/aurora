// A request that is accepted and never answered (public/js/api.js "how long
// a request may take"). Nothing used to give up: Home sat on its skeleton and
// — when it was the history read boot waits for — the page stayed blank, for
// as long as the browser cared to wait. The limits are tens of seconds, so
// the page's clock is moved by the test (the page's timers; the server and
// the browser's own network stack run in real time).
const assert = require("node:assert/strict");
const { suite, player, waitForScreen, FILM_SECONDS } = require("./helpers");

const ui = suite();

// Held for ever: the request is taken and nothing comes back.
const hold = async (page, pattern) => {
  const held = [];
  await page.route(pattern, (route) => { held.push(route); });
  return {
    get count() { return held.length; },
    release: async () => { await page.unroute(pattern); for (const r of held.splice(0)) r.abort("failed").catch(() => {}); },
  };
};
const reported = (page) => page.evaluate(async () => {
  const tel = await import("/js/telemetry.js");
  // every kind of fault this page has counted, sent or not: "kind|message|where|status"
  return [...tel._state.book.seen];
});

ui.test("Home is accepted and never answered: the skeleton, then \"Couldn't load the library\" with Try again at 45 s — and Try again works", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await page.clock.install();
  const home = await hold(page, "**/api/home?*");
  await goto("#/", { wait: false });
  await page.waitForSelector("#app .screen");
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#app .empty").count(), 0, "no error yet");
  assert.ok(home.count >= 1);

  await page.clock.fastForward(40000);
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#app .empty").count(), 0, "40 s: still waiting — a slow answer is not a dead one");

  await page.clock.fastForward(6000);
  const empty = page.locator("#app .empty");
  await empty.waitFor();
  assert.match(await empty.textContent(), /Couldn't load the library/);
  assert.equal(await page.locator("#app .empty button", { hasText: "Try again" }).count(), 1);
  // the rest of the app is alive around it
  assert.equal(await page.locator("#nav .nav-item").first().isVisible(), true);
  // counted once, as a request that got no answer — not passed over like a cancelled one
  const said = await reported(page);
  assert.ok(said.some((s) => /^http\|GET \/api\/home\?profile\|\|0$/.test(s)), `the error reports: ${JSON.stringify(said)}`);

  await home.release();
  await page.click('#app .empty button:has-text("Try again")');
  await page.waitForSelector("#app .screen .hero-title, #app .screen .card");
  assert.equal(await page.locator("#app .empty").count(), 0);
});

ui.test("the history read never answers: boot goes on after 20 s instead of a blank page for ever — and the player will not save over a history it could not read", async ({ page, srv, goto, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.film1.id, 40, FILM_SECONDS);
  await signIn(me);
  await page.clock.install();
  const history = await hold(page, `**/api/profiles/${me.id}/state`);
  const saves = [];
  page.on("request", (req) => { if (req.method() === "POST" && /\/api\/profiles\/[^/]+\/progress$/.test(new URL(req.url()).pathname)) saves.push(req.postData()); });

  await goto("#/movies", { wait: false });
  await page.waitForTimeout(1500);
  assert.ok(history.count >= 1, "boot asked for the history");
  assert.equal(await page.locator("#app .screen").count(), 0, "boot is waiting for it: nothing on the page yet");

  await page.clock.fastForward(21000);
  await waitForScreen(page);
  await page.waitForSelector("#app .screen .grid .card");
  assert.equal(await page.evaluate(async () => (await import("/js/state.js")).state.historyOf), null, "the history is not known — a read that timed out is a read that failed");
  assert.equal(await page.locator("#toasts > *").count(), 0, "boot itself says nothing");

  // The player reads the history again before it starts (twice, a second
  // apart): both are left unanswered and each is given up on at 20 s.
  const before = history.count;
  await goto(`#/play/${lib.film1.id}`, { wait: false });
  await page.waitForFunction((n) => true, null);
  for (let i = 0; i < 3 && !(await page.evaluate(() => document.getElementById("toasts").innerText.includes("Couldn't read your watch history"))); i++) {
    await page.waitForTimeout(400);
    await page.clock.fastForward(21000);
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => document.getElementById("toasts").innerText.includes("Couldn't read your watch history"));
  assert.ok(history.count - before >= 2, `the read is tried again before giving up (${history.count - before} read(s) on opening)`);
  await player.playing(page, { id: lib.film1.id });
  assert.equal(await page.locator(".player .resume-pill").count(), 0, "nothing to resume from");
  assert.ok((await player.state(page)).t < 15, "started near the beginning");

  // watch past a save tick, pause (which saves), and leave (which saves)
  await player.advancing(page, { by: 6 });
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector(".player video").paused);
  await player.press(page, "Back");
  await page.waitForSelector(".player", { state: "detached" });
  await page.waitForTimeout(800);
  assert.deepEqual(saves, [], "progress was sent to the server");
  const kept = (await api.state(me)).progress[lib.film1.id];
  assert.equal(kept.position, 40, "the resume point on the server was overwritten");
  await history.release();
});

ui.run({ concurrency: 1 });
