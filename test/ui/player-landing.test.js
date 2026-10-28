// A second change made while the first one's stream is still landing keeps
// the film's place. Every change that restarts the stream "from here" (a step
// down, a quality or sound change, a fall-back to the encode) read the place
// off the element — which says 0 while a new stream is being put on it — and
// opened the film at 0:00 far into it (the web ladder "sitting at 0:00 while
// segments are rebuilt" after a step-down; player.js `landing`).
const assert = require("node:assert/strict");
const { suite, player, warmJit, FILM_SECONDS } = require("./helpers");

const ui = suite({
  setup: async (srv) => { await warmJit(srv, srv.lib.film2.id); },
});

const menuPick = async (page, label) => {
  await player.press(page, "Settings");
  await page.waitForSelector(".player .menu .menu-title");
  await page.locator(".player .menu .menu-item", { hasText: label }).first().click();
};

ui.test("two sound switches in a row, the second before the first stream has landed: the film stays where it was", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  // the second track's segments are slow to come: its stream lands late
  await page.route(/\/jit\/seg\d+\.ts\?.*a=1/, async (route) => { await new Promise((r) => setTimeout(r, 4000)); route.continue(); });
  const asked = [];
  page.on("request", (r) => { if (/\/jit\/seg\d+/.test(r.url())) asked.push(r.url().replace(srv.url, "")); });
  await player.open(page, srv, lib.film2.id, { min: 1 });
  await player.scrubTo(page, 0.5);
  await player.waitClock(page, FILM_SECONDS * 0.5 - 4, FILM_SECONDS * 0.5 + 4);
  await player.playing(page);
  const at = await page.evaluate(() => document.querySelector(".player video").currentTime);
  assert.ok(at > FILM_SECONDS * 0.4, `playing at ${at}`);

  await menuPick(page, "Hebrew");
  // (the new stream is on the element and has not landed: its clock reads 0)
  await page.waitForFunction(() => (document.querySelector(".player video").currentTime || 0) < 0.5, null, { timeout: 5000 });
  asked.length = 0;
  await menuPick(page, "English");
  await player.playing(page, { timeout: 30000, min: 0.3 });
  const now = await page.evaluate(() => document.querySelector(".player video").currentTime);
  assert.ok(Math.abs(now - at) < 15, `after the second switch the film plays at ${now.toFixed(1)} s — it was at ${at.toFixed(1)} s`);
  // and the first segment asked for after it was the one at that place, not the film's first
  const first = asked.find((u) => !/a=1/.test(u)) || "";
  assert.doesNotMatch(first, /seg00000\.ts/, `the second switch asked for ${first}`);
});
ui.test("only the subtitle that is on is fetched — at the start and after the stream is rebuilt", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const subs = [];
  page.on("request", (r) => { const m = /\/stream\/embedded\/[^/]+\/(\d+)/.exec(r.url()); if (m) subs.push(Number(m[1])); });
  await player.open(page, srv, lib.film2.id, { min: 1 });
  const showing = async () => (await player.state(page)).showing;
  // a rebuild of the stream (the other sound track), with a subtitle on or off
  await menuPick(page, "Hebrew");
  await player.playing(page, { timeout: 30000, min: 0.3 });
  await page.waitForTimeout(1500);
  const on = await showing();
  assert.ok(new Set(subs).size <= on.length, `fetched tracks ${JSON.stringify([...new Set(subs)])} with ${JSON.stringify(on)} on`);
  // switching one on fetches it
  const items = (await player.menu(page, "Subtitles")).filter((i) => !/Resync|Off/.test(i.text));
  const other = items.find((i) => !on.includes(i.text));
  await page.locator(".player .menu .menu-item", { hasText: other.text }).click();
  await page.waitForFunction((label) => {
    const t = [...document.querySelector(".player video").textTracks].find((x) => x.label === label);
    return t && t.mode === "showing" && t.cues && t.cues.length > 0;
  }, other.text, { timeout: 15000 });
  assert.equal(new Set(subs).size, on.length + 1);
});

ui.test("the subtitle that is on is fetched once the picture is there, not beside the first segment", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const seen = [];
  await page.route(/\/stream\/embedded\//, async (route) => {
    seen.push(await page.evaluate(() => { const v = document.querySelector(".player video"); return v ? v.readyState : -1; }).catch(() => -2));
    route.continue();
  });
  const marks = player.marks(page);
  await player.open(page, srv, lib.film2.id, { min: 1 });
  await marks.wait((m) => m.name === "first-frame", 15000, "the first frame");
  await page.waitForFunction(() => [...document.querySelector(".player video").textTracks].some((t) => t.mode === "showing" && t.cues && t.cues.length), null, { timeout: 15000 });
  assert.ok(seen.length >= 1, "a subtitle was fetched");
  assert.ok(seen[0] >= 2, `the first subtitle request went out with the picture at readyState ${seen[0]} (2+: a frame is there)`);
});

ui.test("a subtitle that is slow to come does not hold the picture — not at the start, not after a seek", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  // the server takes 12 s to have the embedded track (it reads the whole film)
  let asked = 0;
  let answered = 0;
  await page.route(/\/stream\/embedded\//, async (route) => { asked++; await new Promise((r) => setTimeout(r, 12000)); answered++; route.continue(); });
  const marks = player.marks(page);
  await goto0(page, srv, lib.film2.id);
  await marks.wait((m) => m.name === "first-frame", 20000, "the first frame");
  const deadline = Date.now() + 15000;
  while (!asked && Date.now() < deadline) await page.waitForTimeout(200);
  assert.ok(asked >= 1, "the subtitle was asked for");
  const clock = () => page.evaluate(() => document.querySelector(".player video").currentTime);
  // a seek while it is on its way: the picture has to rise again past "current data"
  await player.scrubTo(page, 0.5);
  await page.waitForTimeout(1500);
  const t0 = await clock();
  await page.waitForTimeout(3500);
  const t1 = await clock();
  assert.equal(answered, 0, "still waiting for the subtitle");
  assert.ok(t1 - t0 >= 2, `the picture moved ${(t1 - t0).toFixed(2)} s in 3.5 s while the subtitle was on its way`);
  // …and it comes on when it is here
  await page.waitForFunction(() => [...document.querySelector(".player video").textTracks].some((t) => t.mode === "showing" && t.cues && t.cues.length > 0), null, { timeout: 25000 });
});
const goto0 = async (page, srv, id) => {
  if (!page.url().startsWith(srv.url)) await page.goto(`${srv.url}/#/movies`);
  await page.evaluate((h) => { location.hash = h; }, `#/play/${id}`);
  await page.waitForSelector("#app .player video");
};

ui.run({ concurrency: 1 });
