// The AI page keeps its last answer so that coming back to it costs nothing —
// for the profile that asked, and nobody else.
// The recommender itself needs the outside world; its answer is stubbed.
const assert = require("node:assert/strict");
const { suite, PHONE, assertNoHorizontalOverflow } = require("./helpers");

const ui = suite({
  setup: async (srv) => {
    srv.profiles.asker = await srv.api.createProfile("Asker", { open: true });
    srv.profiles.next = await srv.api.createProfile("Nextone", { open: true });
  },
});

const picksOf = (lib) => ({
  items: [
    { ...lib.film1, why: "Because the test asked for it." },
    { ...lib.film2, why: "And this one for good measure." },
  ],
  cached: false,
});
const switchTo = async (page, profile) => {
  await page.click("#nav-profile");
  await page.click('.nav-menu-item:has-text("Switch profile")');
  await page.click(`.profiles-gate .profile-tile[title="${profile.name}"]`);
  await page.waitForSelector(".profiles-gate", { state: "detached" });
  await page.waitForFunction((name) => document.getElementById("nav-profile-name").textContent === name, profile.name);
};
const ask = async (page, vibe) => {
  await page.fill(".pfm-input", vibe);
  await page.click(".pfm-ask button");
};

ui.test("the last answer is there when the same profile comes back, and gone for the next profile", async ({ page, goto, signIn, profiles, lib }) => {
  await page.route("**/api/ai/recommend", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(picksOf(lib)) }));
  await signIn(profiles.asker);
  await goto("#/pick");
  await ask(page, "something quiet for a test");
  await page.waitForSelector(".pfm-pick");
  assert.equal(await page.locator(".pfm-pick").count(), 2);

  // same profile, away and back: still there (the point of remembering it)
  await goto("#/movies");
  await goto("#/pick");
  assert.equal(await page.locator(".pfm-pick").count(), 2);
  assert.equal(await page.inputValue(".pfm-input"), "something quiet for a test");

  // the next person on this tab starts from an empty page
  await switchTo(page, profiles.next);
  await goto("#/pick");
  assert.equal(await page.locator(".pfm-pick").count(), 0, "the previous profile's picks are showing");
  assert.equal(await page.inputValue(".pfm-input"), "", "the previous profile's question is in the box");
  assert.doesNotMatch(await page.textContent("#app"), /something quiet for a test|Because the test asked/);

  // and going back to the first profile does not bring it back either (it was dropped, not hidden)
  await switchTo(page, profiles.asker);
  await goto("#/pick");
  assert.equal(await page.locator(".pfm-pick").count(), 0);
});

ui.test("an answer that lands after the profile was switched is not kept for the new profile", async ({ page, goto, signIn, profiles, lib }) => {
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/api/ai/recommend", async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(picksOf(lib)) });
  });
  await signIn(profiles.asker);
  await goto("#/pick");
  await ask(page, "slow answer for a test");
  await page.waitForSelector(".pfm-wait, .pfm-waiting, .pfm-stage, .skeleton", { state: "attached" }).catch(() => {});

  await switchTo(page, profiles.next);
  const answered = page.waitForResponse((r) => /\/api\/ai\/recommend$/.test(r.url()));
  release();
  await answered;
  await page.waitForTimeout(300);
  await goto("#/pick");
  assert.equal(await page.locator(".pfm-pick").count(), 0, "the answer to the previous profile's question is showing");
  assert.equal(await page.inputValue(".pfm-input"), "");
});

// ---- the draw: the pick is drawn, not listed ----
// Every meteor burst put on the page from now on is counted (it takes itself
// off when it is over, so counting what is there would miss it).
const countBursts = (page) => page.evaluate(() => {
  window.__bursts = 0;
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && (n.matches(".play-burst") || n.querySelector(".play-burst"))) window.__bursts++;
    }
  }).observe(document.body, { childList: true, subtree: true });
});
const bursts = (page) => page.evaluate(() => window.__bursts);
// What the games left running: their own animations, their sky, a burst.
const leftovers = (page) => page.evaluate(() => ({
  nodes: document.querySelectorAll(".pg-draw, .play-burst, .play-room, .pg-room").length,
  anims: document.getAnimations().filter((a) => a.playState === "running" && /^(play|pg)-/.test(a.animationName || "")).map((a) => a.animationName),
}));
const prize = (page) => page.evaluate(() => ({
  state: document.querySelector(".pg-draw")?.dataset.state,
  title: document.querySelector(".pg-won-title")?.textContent,
  kicker: document.querySelector(".pg-won-kicker")?.textContent,
  why: document.querySelector(".pg-won-why")?.textContent,
  said: document.querySelector(".pg-draw [role=status]")?.textContent,
  drawn: [...document.querySelectorAll(".pfm-pick")].map((n) => n.classList.contains("is-drawn")),
}));
const answerAfter = (page, body, ms) => page.route("**/api/ai/recommend", (route) =>
  setTimeout(() => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {}), ms));

ui.test("the pick is drawn: card backs while it thinks, the reel lands on the first pick, one reward, 'Another one' deals the next", async ({ page, goto, signIn, profiles, lib }) => {
  await answerAfter(page, picksOf(lib), 700);
  await signIn(profiles.asker);
  await goto("#/pick");
  await countBursts(page);
  assert.equal(await page.locator(".pg-draw").isVisible(), false, "the stage shows before anything was asked");
  await ask(page, "a draw for a test");

  // thinking: the stage is up at once, nothing won yet, no list yet
  await page.waitForSelector('.pg-draw[data-state="waiting"]');
  assert.equal(await page.locator(".pfm-pick").count(), 0);
  assert.equal(await page.locator(".pg-reel-strip.is-spinning").count(), 1, "the card backs go round while it thinks");

  // the answer: the reel takes the real posters and stops on the first pick
  await page.waitForSelector('.pg-draw[data-state="won"]');
  let p = await prize(page);
  assert.equal(p.title, lib.film1.title);
  assert.match(p.kicker, /Tonight's pick\s*·\s*1 of 2/);
  assert.match(p.why, /Because the test asked for it/);
  assert.equal(p.said, `Tonight's pick: ${lib.film1.title}`, "the landing is said in words too");
  assert.deepEqual(p.drawn, [true, false], "the drawn pick is marked in the whole hand");
  assert.equal(await bursts(page), 1, "one reward for the landing");
  assert.equal(await page.locator('[data-ui="pick.open"]').isVisible(), true);
  assert.equal(await page.locator('[data-ui="pick.another"]').isVisible(), true);
  // the whole hand is still there, every pick with its reason (what the page always gave)
  assert.equal(await page.locator(".pfm-pick").count(), 2);
  assert.equal(await page.locator(".pfm-pick .pfm-why").count(), 2);

  // "Another one": the next pick in the server's order — no second reward
  await page.click('[data-ui="pick.another"]');
  await page.waitForFunction((t) => document.querySelector(".pg-won-title").textContent === t && document.querySelector(".pg-won").classList.contains("is-in"), lib.film2.title);
  p = await prize(page);
  assert.match(p.kicker, /2 of 2/);
  assert.match(p.why, /And this one for good measure/);
  assert.deepEqual(p.drawn, [false, true]);
  assert.equal(await bursts(page), 1, "a second reward for 'Another one'");

  // away: nothing of the game is left behind — no stage, no sky, nothing still moving
  await goto("#/movies");
  await page.waitForTimeout(400);
  assert.deepEqual(await leftovers(page), { nodes: 0, anims: [] });

  // and back: the pick that was showing, as it was left — no spin, no reward
  await goto("#/pick");
  await page.waitForSelector('.pg-draw.is-still[data-state="won"]');
  p = await prize(page);
  assert.equal(p.title, lib.film2.title, "the draw that was showing is not the one that came back");
  assert.match(p.kicker, /2 of 2/);
  await page.waitForTimeout(500);
  assert.equal(await bursts(page), 1, "coming back was rewarded again");

  // round to the first again, and Open goes to that title
  await page.click('[data-ui="pick.another"]');
  await page.waitForFunction((t) => document.querySelector(".pg-won-title").textContent === t && document.querySelector(".pg-won").classList.contains("is-in"), lib.film1.title);
  await page.click('[data-ui="pick.open"]');
  await page.waitForFunction((id) => location.hash === `#/movie/${id}`, lib.film1.id);
});

ui.test("the draw on a phone that asked for less motion: the stage comes into view, the prize is there at once, nothing moves", { viewport: PHONE, device: { reducedMotion: "reduce" } }, async ({ page, goto, signIn, profiles, lib }) => {
  await answerAfter(page, picksOf(lib), 400);
  await signIn(profiles.asker);
  await goto("#/pick");
  await countBursts(page);
  await ask(page, "a still draw for a test");
  await page.waitForSelector('.pg-draw[data-state="won"]');
  const p = await prize(page);
  assert.equal(p.title, lib.film1.title);
  assert.equal(await bursts(page), 0, "a meteor burst for someone who asked for less motion");
  // (pressing the button on a phone used to show nothing: the answer was under the fold)
  const where = () => page.evaluate(() => {
    const r = document.querySelector(".pg-draw").getBoundingClientRect();
    const title = document.querySelector(".pg-won-title").getBoundingClientRect();
    const open = document.querySelector('[data-ui="pick.open"]').getBoundingClientRect();
    return {
      top: Math.round(r.top), titleTop: Math.round(title.top), openBottom: Math.round(open.bottom), h: window.innerHeight,
      moving: document.getAnimations().filter((a) => a.playState === "running" && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".pg-pick")).map((a) => a.animationName || a.transitionProperty),
    };
  });
  const inView = (s) => s.titleTop >= 0 && s.openBottom <= s.h && s.top > -s.h / 2 && s.top < s.h / 2;
  let seen = await where();
  for (let i = 0; i < 20 && !(inView(seen) && !seen.moving.length); i++) { await page.waitForTimeout(150); seen = await where(); }
  assert.ok(inView(seen), `the prize is not in view: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen.moving, [], "something is still moving on the page");
  await assertNoHorizontalOverflow(page, "the draw on a phone");
});

// The box takes the focus a moment after the page is shown. A question asked
// inside that moment (the run of this file caught it once in a while) had the
// box take the focus back afterwards — and the page went up with it, away
// from the draw. Asked here from inside the page, in the same breath as the
// screen is shown: sooner than any hand, the same order every time.
ui.test("a question asked the moment the page shows: the box does not take the focus back and pull the page up from the draw", { viewport: PHONE, device: { reducedMotion: "reduce" } }, async ({ page, goto, signIn, profiles, lib }) => {
  await answerAfter(page, picksOf(lib), 300);
  await signIn(profiles.asker);
  await page.addInitScript(() => {
    const watch = new MutationObserver(() => {
      const screen = document.querySelector("#app .screen.pfm");
      const box = screen && screen.querySelector(".pfm-input");
      if (!box || screen.style.visibility === "hidden") return;
      watch.disconnect();
      box.value = "asked at once, for a test";
      // (a finger's press, not a key's: nothing else moves the focus afterwards)
      screen.querySelector(".pfm-ask button").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      window.__askedAt = performance.now();
    });
    watch.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  });
  await goto("#/pick");
  await page.waitForSelector('.pg-draw[data-state="won"]');
  await page.waitForFunction(() => performance.now() - window.__askedAt > 700); // (well past the box's moment)
  const seen = await page.evaluate(() => {
    const title = document.querySelector(".pg-won-title").getBoundingClientRect();
    const open = document.querySelector('[data-ui="pick.open"]').getBoundingClientRect();
    return { titleTop: Math.round(title.top), openBottom: Math.round(open.bottom), h: window.innerHeight, y: Math.round(window.scrollY), onBox: document.activeElement === document.querySelector(".pfm-input") };
  });
  assert.equal(seen.onBox, false, "the question box took the focus after the question was asked");
  assert.ok(seen.titleTop >= 0 && seen.openBottom <= seen.h, `the prize is not in view: ${JSON.stringify(seen)}`);
  assert.equal((await prize(page)).title, lib.film1.title);
});

ui.test("the whole hand is dealt in even rows, whatever the window", { viewport: { width: 1280, height: 800 }, device: { reducedMotion: "reduce" } }, async ({ page, goto, signIn, profiles, lib }) => {
  const six = { items: Array.from({ length: 6 }, (_, i) => ({ ...lib.film1, id: `${lib.film1.id}-${i}`, title: `Pick number ${i + 1}`, why: `Reason ${i + 1}.` })), cached: false };
  await answerAfter(page, six, 100);
  await signIn(profiles.asker);
  await goto("#/pick");
  await ask(page, "six for a test");
  await page.waitForSelector('.pg-draw[data-state="won"]');
  const rows = () => page.evaluate(() => {
    const by = new Map();
    for (const n of document.querySelectorAll(".pfm-pick")) {
      const top = Math.round(n.getBoundingClientRect().top);
      by.set(top, (by.get(top) || 0) + 1);
    }
    return [...by.values()];
  });
  for (const width of [1280, 1100, 900, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    const r = await rows();
    assert.equal(r.reduce((a, b) => a + b, 0), 6);
    assert.equal(new Set(r).size, 1, `at ${width} px the rows are ${r.join(" + ")}`);
    await assertNoHorizontalOverflow(page, `the hand at ${width} px`);
  }
});

ui.run({ concurrency: 1 });
