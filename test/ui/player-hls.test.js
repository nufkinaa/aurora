// The player on a file the browser cannot play as it is (Test Film Two: MKV,
// H.264 video, two AC-3 audio tracks, embedded subtitles). The server
// repackages it — video copied, audio to AAC, one playlist for the whole film
// ("jit") — and hls.js plays that. This is the path seeking restarts, audio
// switching and stall recovery live on.
const assert = require("node:assert/strict");
const { suite, player, warmJit, FILM_SECONDS } = require("./helpers");

// What two viewers of the same film, far apart in it, get when each asks for
// its next segment at the same moment — recorded once, on the fresh server,
// before the segments are warmed (see the last test in this file).
let twoViewers = null;
const ui = suite({
  setup: async (srv) => {
    const base = `${srv.url}/stream/transcode/${srv.lib.film2.id}/jit`;
    const playlist = await (await fetch(`${base}/index.m3u8`)).text();
    const segments = playlist.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
    const get = async (k) => { const r = await fetch(`${base}/${segments[k]}`); await r.arrayBuffer(); return r.status; };
    twoViewers = { near: 0, far: segments.length - 2, statuses: await Promise.all([get(0), get(segments.length - 2)]) };
    await warmJit(srv, srv.lib.film2.id);
  },
});
const near = (actual, expected, tolerance, what) =>
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${what}: at ${actual}s, expected ${expected}s ± ${tolerance}`);

ui.test("the MKV goes through the server's repackaging and plays through hls.js", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const marks = player.marks(page);
  await player.open(page, srv, lib.film2.id);

  assert.equal((await marks.wait((m) => m.name === "mount", 5000)).audio, "ac3");
  assert.equal((await marks.wait((m) => m.name === "path", 5000, "the path mark")).path, "ladder"); // the master playlist (was "jit" before the quality ladder)
  const first = await marks.wait((m) => m.name === "first-frame", 10000, "the first-frame mark");
  assert.equal(first.jit, true);
  assert.equal(first.v, "copy", "the video should be copied, not re-encoded");

  const s = await player.state(page);
  assert.match(s.src, /^blob:/, "hls.js feeds the element through MediaSource");
  assert.equal(await page.evaluate(() => typeof window.Hls), "function");
  near(s.duration, FILM_SECONDS, 1, "duration");
  // the pill up top says what the sound is
  assert.match(await page.textContent(".player-top"), /Dolby Digital/i);
});

ui.test("seeking on the repackaged stream: the timeline, the buttons, the keys", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film2.id, { min: 1 });

  await player.scrubTo(page, 0.6);
  await player.waitClock(page, FILM_SECONDS * 0.6 - 3, FILM_SECONDS * 0.6 + 4);
  await player.playing(page);
  near(await player.clock(page), FILM_SECONDS * 0.6, 5, "after a click at 60%");

  await page.waitForTimeout(1000);
  let before = await player.clock(page);
  await player.press(page, "Back 10 seconds");
  await player.waitClock(page, before - 13, before - 7);
  await player.playing(page);

  await page.waitForTimeout(1000);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  before = await player.clock(page);
  await page.keyboard.press("ArrowRight");
  await player.waitClock(page, before + 7, before + 14);
  await player.playing(page);
  assert.equal(await page.locator(".player .player-error").count(), 0);
});

ui.test("embedded subtitles are listed and show their cues", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  await player.open(page, srv, lib.film2.id);
  const items = (await player.menu(page, "Subtitles")).filter((i) => !/Resync/.test(i.text));
  assert.deepEqual(items.map((i) => [i.text, i.tag]), [["Off", ""], ["English", "Embedded"], ["Hebrew", "Embedded"]]);
  await page.locator(".player .menu .menu-item", { hasText: "Hebrew" }).click();
  await page.waitForFunction(() => {
    const he = [...document.querySelector(".player video").textTracks].find((t) => t.label === "Hebrew");
    return he && he.mode === "showing" && he.activeCues && he.activeCues.length && /^HE cue/.test(he.activeCues[0].text);
  });
  assert.deepEqual((await player.state(page)).showing, ["Hebrew"]);
});

ui.test("the Audio menu switches track, the film carries on from the same place, and the choice is remembered", async ({ page, srv, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  const asked = [];
  page.on("request", (r) => { if (/\/stream\/transcode\//.test(r.url())) asked.push(r.url().replace(srv.url, "")); });
  await player.open(page, srv, lib.film2.id, { min: 1 });
  await player.scrubTo(page, 0.3);
  await player.waitClock(page, FILM_SECONDS * 0.3 - 3, FILM_SECONDS * 0.3 + 4);
  await player.playing(page);

  await player.press(page, "Settings");
  await page.waitForSelector(".player .menu .menu-title");
  const audio = () => page.evaluate(() => {
    const out = [];
    let on = false;
    for (const n of document.querySelector(".player .menu").children) {
      if (n.classList.contains("menu-title")) on = n.textContent.trim() === "Audio";
      else if (on && n.classList.contains("menu-item")) out.push({ name: n.querySelector("span").textContent, tag: (n.querySelector(".tag") || {}).textContent, active: n.classList.contains("active") });
    }
    return out;
  });
  assert.deepEqual(await audio(), [
    { name: "English", tag: "AC3 · 2ch", active: true },
    { name: "Hebrew", tag: "AC3 · 2ch", active: false },
  ]);

  const at = await player.clock(page);
  await page.locator(".player .menu .menu-item", { hasText: "Hebrew" }).first().click();
  // the second track is asked of the server (&a=1)...
  await page.waitForFunction(() => true); // (let the click's handlers run)
  await assert.doesNotReject(page.waitForRequest((r) => /\/stream\/transcode\/.*[?&]a=1/.test(r.url()), { timeout: 10000 }).catch((e) => {
    if (asked.some((u) => /[?&]a=1/.test(u))) return; // it had already gone out
    throw e;
  }));
  // ...and the film is back, where it was, moving
  await player.playing(page, { timeout: 30000 });
  await player.waitClock(page, at - 4, at + 8);
  assert.equal(await page.locator(".player .player-error").count(), 0);

  await player.press(page, "Settings");
  await page.waitForSelector(".player .menu .menu-title");
  assert.deepEqual((await audio()).map((a) => [a.name, a.active]), [["English", false], ["Hebrew", true]]);
  await page.keyboard.press("Escape");
  await page.waitForFunction(async (id) => !!((await (await fetch("/api/profiles")).json()).find((p) => p.id === id).prefs || {}).audioLang, me.id);
  assert.match(String((await api.profile(me.id)).prefs.audioLang), /^he/i);

  // the next time the title opens it starts on that language
  await player.press(page, "Back");
  await page.waitForSelector(".player", { state: "detached" });
  asked.length = 0;
  await player.open(page, srv, lib.film2.id, { query: "?restart=1" });
  assert.ok(asked.some((u) => /[?&]a=1/.test(u)), `reopened without asking for the Hebrew track: ${JSON.stringify(asked.slice(0, 4))}`);
});

ui.test("a repackaged film resumes a few seconds before where it was left", async ({ page, srv, signIn, freshProfile, api, lib }) => {
  const me = await freshProfile();
  await api.setProgress(me, lib.film2.id, 30, FILM_SECONDS);
  await signIn(me);
  await player.open(page, srv, lib.film2.id, { min: 0 });
  await player.waitClock(page, 22, 31);
  const t = await player.clock(page);
  assert.ok(t >= 22 && t <= 31, `resumed at ${t}s, expected a little before 30s`);
  await page.waitForFunction(() => /Resumed at 0:2\d/.test((document.querySelector(".player .resume-pill") || {}).textContent || ""));
  await player.advancing(page);
});

// ---------------------------------------------------------------------------
// Stall recovery ("a stream that silently stops", player.js). Once a second
// the player looks at the media clock; a stream that WAS playing and stops
// advancing with nobody having asked it to gets:
//    6 s   a nudge (play() again, hop a small gap, or restart the loader)
//   20 s   ONE rebuild of the hls.js stream at the same position — only when
//          hls.js itself is idle (nothing in flight, silent for 8 s)
//   then   the "Playback stopped" card, with Try again at the same spot, if
//          the rebuilt stream does not come back
// It stands down while paused, while the tab is hidden, during a seek, at
// the end of the stream, and for 15 s after any stream start.
//
// THE STIMULUS. A buffered stream cannot be made to freeze from outside with
// the loader idle: holding or failing requests keeps hls.js busy, and the
// ladder (correctly) leaves a busy loader alone. So the freeze is made on
// the element: playbackRate = 0. The clock stops, the element is neither
// paused nor ended nor erroring, the buffer is full and hls.js is idle —
// exactly "the picture froze and nothing says why". A rebuild resets the
// element (load()), which puts the rate back to 1, so a rebuilt stream plays.
//
// These take 40–50 s each because the thresholds are real time; they run
// side by side, each in its own page (with two known-bug checks that also
// need real time: the end of a film, at the bottom of the block).
// ---------------------------------------------------------------------------
const freeze = (page) => page.evaluate(() => { document.querySelector(".player video").playbackRate = 0; });
const stallMarks = (marks) => marks.all.filter((m) => m.name === "stall");
// how long after opening the ladder would have reached its rebuild
const PAST_REBUILD_MS = 40000;

ui.test("a frozen stream gets a nudge, then exactly one rebuild at the same position, and plays on", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const marks = player.marks(page);
  await player.open(page, srv, lib.film2.id, { min: 3 });
  await freeze(page);
  const frozenAt = (await player.state(page)).t;

  const nudge = await marks.wait((m) => m.name === "stall" && m.stage === "nudge", 40000, "the nudge");
  assert.equal(nudge.path, "jit");
  near(nudge.position, frozenAt, 2, "the nudge's position");
  assert.equal(stallMarks(marks).filter((m) => m.stage === "rebuild").length, 0, "rebuilt before nudging");

  const rebuild = await marks.wait((m) => m.name === "stall" && m.stage === "rebuild", 30000, "the rebuild");
  near(rebuild.position, frozenAt, 2, "the rebuild's position");

  // back at the same spot, and moving
  await player.playing(page, { min: frozenAt - 2, timeout: 30000 });
  const t = (await player.state(page)).t;
  assert.ok(t >= frozenAt - 2 && t <= frozenAt + 6, `after the rebuild the film is at ${t.toFixed(1)}s; it froze at ${frozenAt.toFixed(1)}s`);
  assert.equal(await page.locator(".player .player-error").count(), 0, "the error card is up over a stream that came back");

  await page.waitForTimeout(4000);
  assert.deepEqual(stallMarks(marks).map((m) => m.stage), ["nudge", "rebuild"], "the ladder took more steps than nudge → one rebuild");
  await player.advancing(page);
});

ui.test("when the rebuilt stream does not come back: the Playback stopped card, and Try again resumes at the same spot", {
  allow: [/Failed to load resource: net::ERR_CONNECTION_REFUSED.*\/stream\/transcode\//],
}, async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const marks = player.marks(page);
  await player.open(page, srv, lib.film2.id, { min: 3 });
  await freeze(page);
  const frozenAt = (await player.state(page)).t;

  await marks.wait((m) => m.name === "stall" && m.stage === "nudge", 40000, "the nudge");
  // from here on the server is "gone" for this stream: what the rebuild
  // asks for is refused
  const refuse = (route) => route.abort("connectionrefused");
  await page.route("**/stream/transcode/**", refuse);
  await marks.wait((m) => m.name === "stall" && m.stage === "rebuild", 30000, "the rebuild");

  const card = page.locator(".player .player-error");
  await card.waitFor({ timeout: 60000 });
  assert.equal(await card.getAttribute("role"), "alert");
  assert.equal(await card.locator("h3").textContent(), "Playback stopped");
  assert.deepEqual((await card.locator("button").allTextContents()).map((t) => t.trim()), ["Try again", "Back"]);

  // the server is back; Try again picks the film up where it froze
  await page.unroute("**/stream/transcode/**", refuse);
  await card.locator("button", { hasText: "Try again" }).click();
  await player.playing(page, { min: frozenAt - 2, timeout: 30000 });
  await card.waitFor({ state: "detached" });
  const t = (await player.state(page)).t;
  assert.ok(t >= frozenAt - 2 && t <= frozenAt + 6, `Try again resumed at ${t.toFixed(1)}s; it froze at ${frozenAt.toFixed(1)}s`);
  await player.advancing(page);
});

ui.test("a paused film is not a stall: nothing is nudged or rebuilt", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const marks = player.marks(page);
  const opened = Date.now();
  await player.open(page, srv, lib.film2.id, { min: 3 });
  await player.press(page, "Play/Pause");
  await page.waitForFunction(() => document.querySelector(".player video").paused);
  const pausedAt = (await player.state(page)).t;

  await page.waitForTimeout(Math.max(0, PAST_REBUILD_MS - (Date.now() - opened)));
  assert.deepEqual(stallMarks(marks), [], "the stall ladder ran on a paused film");
  assert.equal(await page.locator(".player .player-error").count(), 0);
  assert.equal((await player.state(page)).t, pausedAt, "the paused film moved");

  await player.press(page, "Play/Pause");
  await player.playing(page, { min: pausedAt });
});

ui.test("a hidden tab is not a stall: nothing is nudged or rebuilt while it is in the background", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const marks = player.marks(page);
  const opened = Date.now();
  await player.open(page, srv, lib.film2.id, { min: 3 });
  // The tab goes to the background (what the page can see of that), and the
  // clock stops the way a throttled background tab's does.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await freeze(page);

  await page.waitForTimeout(Math.max(0, PAST_REBUILD_MS - (Date.now() - opened)));
  assert.deepEqual(stallMarks(marks), [], "the stall ladder ran in a hidden tab");
  assert.equal(await page.locator(".player .player-error").count(), 0);
});

// APPLICATION BUG (reported, not fixed here). The line watcher in player.js
// calls a stream "starving" when less than 8 s is buffered ahead and the
// buffer is not growing (`ahead < 8 && fill < 0.9`). In the last 8 seconds of
// a film both are true by definition: the buffer ends where the film ends
// and there is nothing left to fetch. Two seconds later stepDown("starving")
// switches a perfectly healthy stream to a 480p re-encode: the server is
// asked for /stream/transcode/<id>/<offset>/index.m3u8?v=h264-480&seek=1 and
// the last seconds play from it (seen: offset 58 of 60, and once offset 61,
// past the end).
for (const [name, key] of [["a repackaged film", "film2"], ["a film that plays directly", "film1"]]) {
  ui.test(`the end of ${name} is not mistaken for a slow connection (no 480p re-encode in the last seconds)`, async ({ page, srv, signIn, freshProfile, lib }) => {
    await signIn(await freshProfile());
    const capped = [];
    page.on("request", (r) => { if (/[?&]v=h264-(480|720)/.test(r.url())) capped.push(r.url().replace(srv.url, "")); });
    await player.open(page, srv, lib[key].id, { min: 1 });
    await player.jump(page, FILM_SECONDS - 11);
    // to the end of the film (the player leaves by itself when it ends)
    await page.waitForSelector(".player", { state: "detached", timeout: 30000 });
    assert.deepEqual(capped, [], "the player asked the server for a smaller re-encode");
  });
}

// APPLICATION BUG (reported, not fixed here) — in the server, found by this
// suite running several pages on one film. src/media/jit.js keeps ONE
// producer (one ffmpeg) per title and ensureSegment re-aims it at any segment
// the running producer is not about to deliver. Two requests for segments far
// apart re-aim it away from each other in turn; each waiter gives up after
// MAX_SPAWNS_PER_WAIT (3) and the route answers "504 Segment not ready" —
// within ~50 ms, having started six ffmpeg processes. Reproduced every time:
// seg 0 and seg 8 of this film asked for together, seg 0 gets 504. Two
// people watching the same repackaged title at different points do this to
// each other for the length of the film (hls.js retries, so it shows as
// stutter rather than an error).
ui.test("two viewers far apart in the same repackaged film are both served their next segment", { todo: "server bug: the single jit producer is re-aimed back and forth and the loser gets 504" }, async () => {
  assert.ok(twoViewers, "the probe did not run");
  assert.deepEqual(twoViewers.statuses, [200, 200], `segments ${twoViewers.near} and ${twoViewers.far}, asked for at the same time`);
});

// (six at once: the last six tests are real-time waits of 15–45 s each)
ui.run({ concurrency: 6 });
