// Aurora Wrapped as a story (2026-11-10, docs/play/wrapped.md): a year of
// viewing seeded into the private instance (support/wrapped-seed.js), then
// the story driven the ways a person drives it — keys, taps, the buttons —
// and the page underneath ("All the numbers"), the teaser for a profile with
// nothing watched, a one-sitting year, a kids profile, reduced motion, the
// share card, and that nothing is left running once the screen is left.
const assert = require("node:assert/strict");
const { suite, PHONE, assertNoHorizontalOverflow } = require("./helpers");
const ws = require("./support/wrapped-seed");

// a real PNG for one poster: the top title's art comes from the metadata
// cache when the title is not on disk
const PNG = ws.plainPng(200, 300, [70, 40, 120]);

const ui = suite({
  server: { seed: ws.seed({ rich: "Wren", tiny: "Tiny", kids: "Kiddo" }, { pngs: { tt8300002: PNG } }) },
  setup: async (srv) => {
    srv.profiles.rich = await srv.api.createProfile("Wren", { open: true });
    srv.profiles.tiny = await srv.api.createProfile("Tiny", { open: true });
    srv.profiles.empty = await srv.api.createProfile("Nobody", { open: true });
    srv.profiles.kids = await srv.api.createProfile("Kiddo", { open: true, kids: { maxAge: 7 } });
  },
});

const chapter = (page) => page.evaluate(() => {
  const all = [...document.querySelectorAll(".play-story .play-chapter:not(.is-leaving)")];
  const c = all[all.length - 1];
  return c ? c.className.match(/play-chapter--(\w+)/)[1] : null;
});
const waitChapter = (page, id) => page.waitForFunction((want) => {
  const all = [...document.querySelectorAll(".play-story .play-chapter:not(.is-leaving)")];
  const c = all[all.length - 1];
  return c && c.classList.contains(`play-chapter--${want}`);
}, id);
const openStory = async (h) => {
  await h.goto("#/wrapped", { selector: ".screen.wr" });
  await h.page.waitForSelector(".play-story .play-chapter--opening");
};

ui.test("the answer carries what the story draws: the week, the day, the nights, the streak, pictures and genres", async ({ api, profiles }) => {
  const w = await api.get(`/api/profiles/${profiles.rich.id}/wrapped`);
  assert.equal(w.byHour.length, 24);
  assert.equal(w.byWeekday.length, 7);
  assert.ok(w.nights.length > 50 && w.nightsFrom);
  assert.equal(w.bestStreak, 13);
  assert.ok(w.streak.from < w.streak.to);
  // a title only the metadata cache knows: its genres count, its poster is there
  assert.equal(w.topTitles[0].name, "Northern Static");
  assert.equal(w.topTitles[0].poster, "/img/meta/tt8300002.png");
  assert.equal(w.topTitles[0].show, true);
  assert.ok(w.topGenres.length >= 3, JSON.stringify(w.topGenres));
  assert.ok(w.topTitles.some((t) => t.name === "הבית ברחוב הירקון"), "the Hebrew title is in the top five");
});

ui.test("the story: arrows move, Space pauses, the summary is one press away, the page is underneath", async (h) => {
  const { page, signIn, profiles } = h;
  await signIn(profiles.rich);
  await openStory(h);
  // the whole frame: one segment a chapter, the name, the buttons
  // (the page underneath is drawn when the story closes)
  assert.equal(await page.locator(".wr-page").count(), 0);
  assert.match(await page.locator("#app .screen.wr").innerText(), /AURORA WRAPPED/i);
  const segs = await page.locator(".play-story .play-seg").count();
  assert.equal(segs, 11);
  assert.match(await page.locator(".play-story-title").innerText(), /Wren/);
  await page.keyboard.press("ArrowRight");
  await waitChapter(page, "hours");
  await page.keyboard.press("ArrowRight");
  await waitChapter(page, "top");
  await page.keyboard.press("ArrowLeft");
  await waitChapter(page, "hours");
  // Space pauses (the clock and every animation), and plays again
  await page.keyboard.press(" ");
  await page.waitForSelector(".play-story.is-paused");
  assert.equal(await page.getAttribute(".play-story [data-ui='story.pause']", "aria-label"), "Play");
  await page.keyboard.press(" ");
  await page.waitForSelector(".play-story:not(.is-paused)");
  // straight to the end
  await page.click("[data-ui='story.skip']");
  await waitChapter(page, "finale");
  await page.waitForSelector(".wr-finale [data-ui='wrapped.share']");
  // the picture is drawn into the finale
  await page.waitForSelector(".wr-share-holder canvas.wr-share-canvas", { timeout: 20000 });
  // All the numbers: the story goes, the page is there with every stat
  await page.click(".wr-finale [data-ui='wrapped.all']");
  await page.waitForSelector(".play-story", { state: "detached" });
  const text = (await page.locator(".wr-page").innerText()).toLowerCase(); // (eyebrows are upper case on screen)
  for (const s of ["All the numbers", "Aurora Wrapped", "Your top five", "Northern Static", "Your genre DNA", "13", "The intervention"]) assert.ok(text.includes(s.toLowerCase()), `the page says ${s}`);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("play-story-open")), false);
  // and it plays again from the page
  await page.click("[data-ui='wrapped.story']");
  await page.waitForSelector(".play-story .play-chapter--opening");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".play-story", { state: "detached" });
  assert.match(page.url(), /#\/wrapped$/);
});

ui.test("the story moves on by itself, and Home / End jump", async (h) => {
  const { page, signIn, profiles } = h;
  await signIn(profiles.rich);
  await openStory(h);
  await waitChapter(page, "hours"); // (the opening lasts ~6 s)
  await page.keyboard.press("End");
  await waitChapter(page, "finale");
  // the finale stays: its segment is full, nothing moves on
  await page.waitForTimeout(1500);
  assert.equal(await chapter(page), "finale");
  await page.keyboard.press("Home");
  await waitChapter(page, "opening");
});

ui.test("the share card: a 1080×1920 picture, handed to the share sheet where there is one, named for the profile", async (h) => {
  const { page, signIn, profiles } = h;
  // the share sheet, stood in for: what would be shared is kept
  await page.addInitScript(() => {
    window.__shared = null;
    navigator.canShare = (d) => !!(d && d.files && d.files.length);
    navigator.share = async (d) => {
      const f = d.files[0];
      const b = new Uint8Array(await f.arrayBuffer());
      const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      window.__shared = { name: f.name, type: f.type, png: String.fromCharCode(b[1], b[2], b[3]), w: u32(16), h: u32(20), title: d.title, text: d.text };
    };
  });
  await signIn(profiles.rich);
  await h.goto("#/wrapped", { selector: ".screen.wr" });
  await page.waitForSelector(".play-story .play-chapter");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".play-story", { state: "detached" });
  assert.match(await page.locator(".wr-page-actions [data-ui='wrapped.share']").innerText(), /Share the picture/);
  await page.click(".wr-page-actions [data-ui='wrapped.share']");
  const shared = await page.waitForFunction(() => window.__shared, null, { timeout: 30000 }).then((x) => x.jsonValue());
  assert.deepEqual({ ...shared, text: undefined }, { name: "aurora-wrapped-wren.png", type: "image/png", png: "PNG", w: 1080, h: 1920, title: "My Aurora Wrapped", text: undefined });
  // what it says goes no further than the profile's own name and numbers
  assert.match(shared.text, /^My Aurora Wrapped: 136 hours, and I'm The /);
});

ui.test("the share card without a share sheet: the picture is downloaded", async (h) => {
  const { page, signIn, profiles } = h;
  await page.addInitScript(() => { navigator.canShare = undefined; navigator.share = undefined; });
  await signIn(profiles.rich);
  await h.goto("#/wrapped", { selector: ".screen.wr" });
  await page.waitForSelector(".play-story .play-chapter");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".play-story", { state: "detached" });
  assert.match(await page.locator(".wr-page-actions [data-ui='wrapped.share']").innerText(), /Save the picture/);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click(".wr-page-actions [data-ui='wrapped.share']")]);
  assert.equal(dl.suggestedFilename(), "aurora-wrapped-wren.png");
  const buf = require("fs").readFileSync(await dl.path());
  assert.equal(buf.subarray(1, 4).toString(), "PNG");
  assert.equal(buf.readUInt32BE(16), 1080);
  assert.equal(buf.readUInt32BE(20), 1920);
  await page.waitForFunction(() => document.getElementById("toasts").innerText.includes("downloads"));
});

ui.test("a phone: tap the right side for next, the left for back; the page fits", { viewport: PHONE }, async (h) => {
  const { page, signIn, profiles } = h;
  await signIn(profiles.rich);
  await openStory(h);
  const vw = PHONE.width;
  await page.mouse.click(vw * 0.85, 420);
  await waitChapter(page, "hours");
  await page.mouse.click(vw * 0.85, 420);
  await waitChapter(page, "top");
  await page.mouse.click(vw * 0.12, 420);
  await waitChapter(page, "hours");
  // the frame's buttons fit the phone: none past the edge, none on another
  const boxes = await page.evaluate(() => [...document.querySelectorAll(".play-story-top button, .play-story-title > *")].map((n) => n.getBoundingClientRect().toJSON()));
  for (const b of boxes) assert.ok(b.left >= 0 && b.right <= vw + 0.5, JSON.stringify(b));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top || b.bottom <= a.top, "the top buttons overlap");
  }
  await page.click("[data-ui='story.close']");
  await page.waitForSelector(".play-story", { state: "detached" });
  await assertNoHorizontalOverflow(page, "Wrapped's page");
});

ui.test("reduced motion: the page first; the story plays still, by hand", async (h) => {
  const { page, signIn, profiles } = h;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(profiles.rich);
  await h.goto("#/wrapped", { selector: ".wr-page" });
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".play-story").count(), 0, "no story starts by itself");
  await page.click("[data-ui='wrapped.story']");
  await page.waitForSelector(".play-story.is-still .play-chapter--opening");
  assert.equal(await page.locator("[data-ui='story.pause']").count(), 0, "nothing to pause");
  await page.waitForTimeout(7000);
  assert.equal(await chapter(page), "opening", "no auto-advance");
  await page.keyboard.press("ArrowRight");
  await waitChapter(page, "hours");
  // the number is there at once, no count-up
  assert.equal(await page.locator(".play-chapter--hours .play-odo").getAttribute("aria-label"), "136");
  assert.equal(await page.locator(".play-chapter--hours .play-odo.is-settled").count(), 1);
  // nothing animates in a still story
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".play-story")).length);
  assert.equal(running, 0);
});

ui.test("nothing watched yet: the teaser, and the way to fill it", async (h) => {
  const { page, signIn, profiles } = h;
  await signIn(profiles.empty);
  await h.goto("#/wrapped", { selector: ".wr-teaser" });
  const text = await page.locator(".wr-teaser").innerText();
  assert.match(text, /Your sky is still dark, Nobody\./);
  assert.equal(await page.locator(".play-story").count(), 0);
  await page.click("[data-ui='wrapped.browse']");
  await page.waitForFunction(() => location.hash === "#/");
});

ui.test("one sitting: the chapters that need more are left out", async (h) => {
  const { page, signIn, profiles } = h;
  await signIn(profiles.tiny);
  await openStory(h);
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const id = await chapter(page);
    ids.push(id);
    if (id === "finale") break;
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((was) => {
      const all = [...document.querySelectorAll(".play-story .play-chapter:not(.is-leaving)")];
      return all.length && !all[all.length - 1].classList.contains(`play-chapter--${was}`);
    }, id);
  }
  assert.deepEqual(ids, ["opening", "hours", "top", "type", "roasts", "finale"]);
  assert.match(await page.locator(".play-chapter--finale").innerText(), /That's a wrap/i);
});

ui.test("the server's own roasts are what the intervention says — four long ones still fit a phone", { viewport: PHONE }, async (h) => {
  const { page, signIn, profiles } = h;
  const long = (n) => `Roast ${n}: you watched so much that the couch files its own taxes now, the remote asked for a holiday and the fridge knows you by first name.`;
  const lines = [1, 2, 3, 4].map(long);
  assert.ok(lines.every((l) => l.length >= 135 && l.length <= 140), String(lines[0].length));
  await page.route(/\/api\/profiles\/[^/]+\/wrapped$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    route.fulfill({ response: res, json: { ...body, roasts: lines } });
  });
  await signIn(profiles.rich);
  await openStory(h);
  await page.keyboard.press("End");
  await waitChapter(page, "finale");
  await page.keyboard.press("ArrowLeft");
  await waitChapter(page, "roasts");
  const texts = await page.locator(".play-chapter--roasts .wr-roast-text").allInnerTexts();
  assert.deepEqual(texts, lines);
  // each line lands in time; the last one on top, whole, inside the screen
  await page.waitForFunction(() => document.querySelector(".play-chapter--roasts .wr-roast:last-child[data-depth='0']"), null, { timeout: 15000 });
  await page.waitForTimeout(800);
  const box = await page.evaluate(() => {
    const li = document.querySelector(".play-chapter--roasts .wr-roast:last-child");
    const t = li.querySelector(".wr-roast-text");
    const r = li.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight, clipped: t.scrollHeight > t.clientHeight + 1 || t.scrollWidth > t.clientWidth + 1 };
  });
  assert.ok(box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh, JSON.stringify(box));
  assert.equal(box.clipped, false);
  // the page says them too
  await page.click("[data-ui='story.close']");
  assert.deepEqual(await page.locator(".wr-roastlist li").allInnerTexts(), lines);
});

ui.test("a kids profile: the highlights, never the intervention", async (h) => {
  const { page, signIn, profiles } = h;
  await signIn(profiles.kids);
  await openStory(h);
  await page.click("[data-ui='story.close']");
  const text = await page.locator(".wr-page").innerText();
  assert.match(text, /The highlights/i);
  assert.doesNotMatch(text, /The intervention|We need to talk|relationship|voicemail/i);
});

ui.test("leaving: the story, its listeners and every animation go with the screen", async (h) => {
  const { page, signIn, profiles, goto } = h;
  await signIn(profiles.rich);
  await openStory(h);
  await page.keyboard.press("ArrowRight");
  await waitChapter(page, "hours");
  await goto("#/new");
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".play-story, .play-room").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("play-story-open")), false);
  const left = await page.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.target && /play-|wr-/.test(String(a.effect.target.className && (a.effect.target.className.baseVal ?? a.effect.target.className)))).length);
  assert.equal(left, 0);
  // the arrows are the app's again (the story's key listener is gone)
  await page.keyboard.press("ArrowRight");
  assert.match(page.url(), /#\/new$/);
});

ui.run();
