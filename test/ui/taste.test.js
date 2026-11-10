// The swipe taste picker (#/taste): one card at a time, three answers.
// Mouse drag, a finger swipe on a touch phone (velocity threshold included),
// the keyboard, Undo, Done, the end of a round and Keep going, the old grid
// as "Edit list", and the answers surviving a reload. The private instance is
// given a well-known list of its own (data/cache/search-known.json) whose
// posters are inline SVGs, so nothing is fetched from outside.
const assert = require("node:assert/strict");
const { suite, waitForScreen, assertNoHorizontalOverflow, PHONE } = require("./helpers");

const GENRES = ["Horror", "Comedy", "Drama", "Sci-Fi", "Animation", "Crime", "Romance", "Documentary", "Thriller", "Fantasy"];
const COLORS = ["#5b3b8c", "#2c6e8f", "#8f4b2c", "#2c8f5a", "#8f2c6a", "#6a8f2c", "#2c3e8f", "#8f7a2c"];
const posterOf = (i, title) =>
  "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="${COLORS[i % COLORS.length]}"/>` +
    `<text x="150" y="225" font-family="sans-serif" font-size="26" fill="#fff" text-anchor="middle">${title}</text></svg>`);
const KNOWN = Array.from({ length: 80 }, (_, i) => {
  const type = i % 3 === 2 ? "series" : "movie";
  const title = `Known ${type === "series" ? "Show" : "Film"} ${i + 1}`;
  return {
    imdbId: `tt8${String(100000 + i).padStart(6, "0")}`, type: type === "series" ? "show" : "movie", title,
    year: 1975 + ((i * 7) % 50), poster: posterOf(i, title), rating: 6.5 + (i % 25) / 10,
    genres: [GENRES[i % GENRES.length], GENRES[(i * 3 + 1) % GENRES.length]], // (HTML-escaped, as Cinemeta sends names: the line must read plain — src/lib/htmltext.js)
    cast: ["Ann O&apos;Actor", "Bo Actor"], director: ["Cy Director"],
    k: i,
  };
});

const ui = suite({
  server: { seed: { "cache/search-known.json": { v: 1, at: Date.now(), tried: Date.now(), titles: KNOWN } } },
});

const TOP = "#app .ts-card.top";
const topId = (page) => page.evaluate((sel) => { const n = document.querySelector(sel); return n ? n.dataset.id : null; }, TOP);
const ready = async (page) => {
  await page.waitForSelector(TOP);
  return topId(page);
};
// the card on show is a different one (the last one has flown)
const nextCard = (page, was) => page.waitForFunction(({ sel, was }) => {
  const n = document.querySelector(sel);
  return n && n.dataset.id !== was;
}, { sel: TOP, was });
const taste = async (api, profile) => (await api.get(`/api/profiles/${profile.id}/taste`, await api.as(profile)));
const countText = (page) => page.textContent("#app .ts-count");
const answeredOnServer = async (api, profile) => {
  const t = await taste(api, profile);
  return t.counts.love + t.counts.nope + t.counts.skip;
};
const waitServer = async (api, profile, n) => {
  for (let i = 0; i < 60; i++) {
    if ((await answeredOnServer(api, profile)) === n) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`the server never had ${n} answers (it has ${await answeredOnServer(api, profile)}: ${JSON.stringify(await taste(api, profile))})`);
};
// a mouse drag from the card's middle by (dx, dy), in `steps` moves over `ms`
const drag = async (page, dx, dy, { steps = 12, ms = 240 } = {}) => {
  const box = await page.locator(TOP).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
    await page.waitForTimeout(ms / steps);
  }
  await page.mouse.up();
};
// a finger on a touch screen (CDP touch events: Chrome turns them into the
// pointer events the card listens to, exactly as on a phone)
const swipe = async (page, dx, dy, { steps = 10, ms = 200 } = {}) => {
  const box = await page.locator(TOP).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const at = (px, py) => [{ x: Math.round(px), y: Math.round(py), id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(x, y) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(x + (dx * i) / steps, y + (dy * i) / steps) });
    await page.waitForTimeout(ms / steps);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
};

// a gesture as the card sees it: pointer events at a set pace
const flick = (page, dx, ms) => page.evaluate(({ sel, dx, ms }) => new Promise((done) => {
  const n = document.querySelector(sel);
  const r = n.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const ev = (type, cx) => n.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "touch", isPrimary: true, bubbles: true, clientX: cx, clientY: y, button: 0 }));
  ev("pointerdown", x);
  const steps = 4;
  let i = 0;
  const tick = () => {
    i++;
    ev("pointermove", x + (dx * i) / steps);
    if (i < steps) setTimeout(tick, ms / steps);
    else { ev("pointerup", x + dx); done(); }
  };
  setTimeout(tick, ms / steps);
}), { sel: TOP, dx, ms });

ui.test("one card at a time: poster, title, year, genres and a line; nothing around it moves when it goes", async ({ page, goto, signIn, freshProfile }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/taste");
  const id = await ready(page);
  assert.ok(id && id.startsWith("tt8"), id);
  const card = await page.evaluate((sel) => {
    const n = document.querySelector(sel);
    return { title: n.querySelector(".ts-title").textContent, meta: n.querySelector(".ts-meta").textContent, line: (n.querySelector(".ts-line") || {}).textContent, img: !!n.querySelector("img.ts-poster") };
  }, TOP);
  assert.match(card.title, /^Known (Film|Show) \d+$/);
  assert.match(card.meta, /^\d{4} · (Film|Series) · /);
  assert.equal(card.line, "Cy Director, with Ann O'Actor and Bo Actor", "the catalogue's &apos; is an apostrophe on the card");
  assert.ok(card.img);
  assert.equal(await countText(page), "0 / 24");
  assert.equal(await page.locator("#app .ts-card.behind").count(), 1, "the next card waits behind");
  // where things are before and after an answer: the stage, the buttons, the head
  const rects = () => page.evaluate(() => ["#app .ts-stage", "#app .ts-answers", "#app .ts-head", "#app .ts-deck"].map((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(",");
  }));
  // (after the screen's own entrance: the head, the stage and the keys rise in)
  await page.waitForFunction(() => [...document.querySelectorAll("#app .screen, #app .ts-head, #app .ts-stage, #app .ts-answers")].every((n) => n.getAnimations().length === 0));
  await page.waitForTimeout(300);
  const before = await rects();
  await page.click('#app [data-ui="taste.love"]');
  await nextCard(page, id);
  await page.waitForTimeout(400);
  assert.deepEqual(await rects(), before, "the layout moved when the card left");
  assert.equal(await countText(page), "1 / 24");
  await assertNoHorizontalOverflow(page, "taste");
});

ui.test("mouse: drag right = Love, left = Not for me, up = Haven't seen; a short slow drag springs back", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/taste");
  const a = await ready(page);
  await drag(page, 260, 10);
  await nextCard(page, a);
  const b = await topId(page);
  await drag(page, -260, -10);
  await nextCard(page, b);
  const c = await topId(page);
  await drag(page, 0, -240);
  await nextCard(page, c);
  const d = await topId(page);
  // 50px, slowly: not an answer — the same card is back in the middle
  await drag(page, 50, 0, { steps: 10, ms: 600 });
  await page.waitForTimeout(400);
  assert.equal(await topId(page), d, "a short, slow drag is not an answer");
  const tf = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).transform, TOP);
  assert.ok(tf === "none" || /matrix\(1, 0, 0, 1, 0, 0\)/.test(tf), `back in the middle (${tf})`);
  await waitServer(api, me, 3);
  const t = await taste(api, me);
  assert.deepEqual(t.liked.map((x) => x.imdbId), [a]);
  assert.deepEqual(t.disliked.map((x) => x.imdbId), [b]);
  assert.equal(t.counts.skip, 1);
  assert.equal(await countText(page), "3 / 24");
});

ui.test("phone: a finger swipe answers (with a little rotation on the way), a quick flick counts, a slow nudge does not", { viewport: PHONE }, async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/taste");
  const a = await ready(page);
  await assertNoHorizontalOverflow(page, "taste on a phone");
  // mid-drag: the card leans the way it is going
  const box = await page.locator(TOP).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  const x0 = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(x0, y0) });
  for (let i = 1; i <= 6; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(x0 + i * 15, y0) }); await page.waitForTimeout(16); }
  const leaning = await page.evaluate((sel) => document.querySelector(sel).style.transform, TOP);
  assert.match(leaning, /rotate\(4\.5deg\)/, leaning);
  const stamp = await page.evaluate((sel) => Number(document.querySelector(`${sel} .ts-stamp.love`).style.opacity), TOP);
  assert.ok(stamp > 0.5, `the LOVE stamp shows while dragging right (${stamp})`);
  for (let i = 7; i <= 14; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(x0 + i * 15, y0) }); await page.waitForTimeout(16); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await nextCard(page, a);
  // a quick flick: 60px in ~40ms is past the speed threshold though short of
  // the distance one. (Pointer events made in the page, so the timing is the
  // test's and not the speed of the automation link.)
  const b = await topId(page);
  await flick(page, -60, 40);
  await nextCard(page, b);
  // the same 60px, slowly, is not
  const c = await topId(page);
  await flick(page, 60, 700);
  await page.waitForTimeout(400);
  assert.equal(await topId(page), c);
  // up = haven't seen
  await swipe(page, 0, -220);
  await nextCard(page, c);
  await waitServer(api, me, 3);
  const t = await taste(api, me);
  assert.deepEqual(t.liked.map((x) => x.imdbId), [a]);
  assert.deepEqual(t.disliked.map((x) => x.imdbId), [b]);
  // the buttons are there for thumbs too
  const d = await topId(page);
  await page.tap('#app [data-ui="taste.nope"]');
  await nextCard(page, d);
});

ui.test("keyboard: → Love, ← Not for me, ↓ Haven't seen, Enter = Love, Z = Undo; arrows in the toolbar move focus instead", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/taste");
  const a = await ready(page);
  await page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), TOP);
  await page.keyboard.press("ArrowRight");
  await nextCard(page, a);
  const b = await topId(page);
  await page.keyboard.press("ArrowLeft");
  await nextCard(page, b);
  const c = await topId(page);
  await page.keyboard.press("ArrowDown");
  await nextCard(page, c);
  const d = await topId(page);
  await page.keyboard.press("Enter");
  await nextCard(page, d);
  await waitServer(api, me, 4);
  let t = await taste(api, me);
  assert.deepEqual(t.liked.map((x) => x.imdbId).sort(), [a, d].sort());
  assert.deepEqual(t.disliked.map((x) => x.imdbId), [b]);
  assert.equal(t.counts.skip, 1);
  // Z: the last one (d, loved with Enter) is back on show, and not loved any more
  await page.keyboard.press("z");
  await page.waitForFunction(({ sel, d }) => (document.querySelector(sel) || {}).dataset?.id === d, { sel: TOP, d });
  await waitServer(api, me, 3);
  t = await taste(api, me);
  assert.deepEqual(t.liked.map((x) => x.imdbId), [a]);
  assert.equal(await countText(page), "3 / 24");
  // focus up in the toolbar: arrows move between its buttons and answer nothing
  await page.focus('#app [data-ui="taste.edit"]');
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  assert.equal(await topId(page), d, "an arrow in the toolbar is not an answer");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.ui), "taste.done");
});

ui.test("Undo walks back several answers and puts back the answer each title had before", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  // an earlier sitting said "not for me" to a title this deck will show first
  await goto("#/taste");
  const first = await ready(page);
  await api.post(`/api/profiles/${me.id}/taste/answer`, { imdbId: first, title: "x", verdict: "nope" }, await api.as(me));
  // (it is on screen already: loving it now, then undoing, must restore the "no")
  const undo = page.locator('#app [data-ui="taste.undo"]');
  assert.equal(await undo.isDisabled(), true, "nothing to undo yet");
  await page.click('#app [data-ui="taste.love"]');
  await nextCard(page, first);
  const second = await topId(page);
  await page.click('#app [data-ui="taste.skip"]');
  await nextCard(page, second);
  await waitServer(api, me, 2);
  await undo.click();
  await page.waitForFunction(({ sel, id }) => (document.querySelector(sel) || {}).dataset?.id === id, { sel: TOP, id: second });
  await undo.click();
  await page.waitForFunction(({ sel, id }) => (document.querySelector(sel) || {}).dataset?.id === id, { sel: TOP, id: first });
  assert.equal(await countText(page), "0 / 24");
  await waitServer(api, me, 1);
  const t = await taste(api, me);
  assert.deepEqual(t.disliked.map((x) => x.imdbId), [first], "the earlier answer is back");
  assert.equal(t.liked.length, 0);
  assert.equal(await undo.isDisabled(), true);
});

ui.test("a round ends at 24 with a summary; Keep going asks for 12 more; Done is always there and leaves", async ({ page, goto, signIn, freshProfile, api }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/preferences");
  await page.click('#app button.pref-link:has-text("Swipe your taste")');
  await page.waitForSelector(TOP);
  for (let i = 0; i < 24; i++) {
    const id = await topId(page);
    await page.keyboard.press(i % 3 === 0 ? "ArrowRight" : i % 3 === 1 ? "ArrowLeft" : "ArrowDown");
    if (i < 23) await nextCard(page, id);
  }
  await page.waitForSelector("#app .ts-end");
  assert.match(await page.textContent("#app .ts-end"), /24 answers/);
  assert.match(await page.textContent("#app .ts-end"), /♥ 8 loved · ✕ 8 not for you · 8 not seen/);
  assert.equal(await countText(page), "24 / 24");
  await page.click('#app .ts-end [data-ui="taste.more"]');
  await page.waitForSelector(TOP);
  assert.equal(await countText(page), "24 / 36");
  await waitServer(api, me, 24);
  // no title was asked about twice
  const t = await taste(api, me);
  const ids = [...t.liked.map((x) => x.imdbId), ...t.disliked.map((x) => x.imdbId)];
  assert.equal(new Set(ids).size, ids.length);
  // Done (the toolbar's) goes back to where the picker was opened from
  await page.click('#app .ts-toolbar [data-ui="taste.done"]');
  await page.waitForFunction(() => location.hash === "#/preferences");
});

ui.test("the answers survive a reload: answered titles are not asked again, and Edit list shows the picks", async ({ page, goto, signIn, freshProfile, api, srv }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/taste");
  await ready(page);
  const seen = [];
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowRight", "ArrowDown"]) {
    const id = await topId(page);
    seen.push(id);
    await page.keyboard.press(key);
    await nextCard(page, id);
  }
  await waitServer(api, me, 4);
  await page.reload();
  await waitForScreen(page);
  await page.waitForSelector(TOP);
  // walk well past the four: none of them comes back
  for (let i = 0; i < 10; i++) {
    const id = await topId(page);
    assert.ok(!seen.includes(id), `${id} was answered before the reload and is asked again`);
    await page.keyboard.press("ArrowDown");
    await nextCard(page, id);
  }
  // Edit list: the old grid, the two loves on, the "no" listed and one tap from undone
  await page.click('#app [data-ui="taste.edit"]');
  await page.waitForFunction(() => location.hash === "#/taste/list");
  await page.waitForSelector("#app .taste-tile");
  assert.match(await page.textContent("#app .browse-head .count"), /^2 loved$/);
  assert.equal(await page.locator("#app .taste-tile.on").count(), 2);
  const chip = page.locator('#app [data-ui="taste.unnope"]');
  assert.equal(await chip.count(), 1);
  await chip.click();
  await page.waitForFunction(() => !document.querySelector('#app [data-ui="taste.unnope"]'));
  const t = await taste(api, me);
  assert.equal(t.counts.nope, 0);
  // and back to swiping
  await page.click('#app [data-ui="taste.back"]');
  await page.waitForSelector(TOP);
  void srv;
});

ui.test("reduced motion: the card fades instead of flying", async ({ page, goto, signIn, freshProfile }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const me = await freshProfile();
  await signIn(me);
  await goto("#/taste");
  const a = await ready(page);
  // the leaving card is caught the moment it becomes one (it is gone ~160ms later)
  await page.evaluate(() => {
    window.__leaving = null;
    const mo = new MutationObserver(() => {
      const n = document.querySelector("#app .ts-card.leaving");
      if (n && !window.__leaving) { window.__leaving = { t: n.style.transform, tr: n.style.transition }; mo.disconnect(); }
    });
    mo.observe(document.querySelector("#app .ts-deck"), { subtree: true, attributes: true, attributeFilter: ["class", "style"] });
  });
  await page.click('#app [data-ui="taste.love"]');
  await page.waitForFunction(() => window.__leaving);
  const leaving = await page.evaluate(() => window.__leaving);
  assert.ok(leaving, "the answered card is leaving");
  assert.equal(leaving.t, "", "no flight");
  assert.match(leaving.tr, /opacity/);
  await nextCard(page, a);
});

// ---- the round as a game ----
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
const meter = (page) => page.evaluate(() => ({
  lit: document.querySelectorAll("#app .pg-meter .pg-pip.on").length,
  of: document.querySelectorAll("#app .pg-meter .pg-pip").length,
  depth: document.querySelector("#app .pg-deck").dataset.depth,
}));
// `n` answers with the keys: love, not for me, haven't seen, round and round
const answerKeys = async (page, n, from = 0) => {
  for (let i = from; i < from + n; i++) {
    const id = await topId(page);
    await page.keyboard.press(i % 3 === 0 ? "ArrowRight" : i % 3 === 1 ? "ArrowLeft" : "ArrowDown");
    await page.waitForFunction(({ sel, was }) => {
      const c = document.querySelector(sel);
      return (c && c.dataset.id !== was) || !!document.querySelector("#app .ts-end");
    }, { sel: TOP, was: id });
  }
};
// What the game left running: its own animations, its sky, a burst.
const leftovers = (page) => page.evaluate(() => ({
  nodes: document.querySelectorAll(".pg-taste, .play-burst, .play-room, .pg-room").length,
  anims: document.getAnimations().filter((a) => a.playState === "running" && /^(play|pg)-/.test(a.animationName || "")).map((a) => a.animationName),
}));

ui.test("the round as a game: the deck has depth, the meter lights a star at each quarter and says something, the end is the one reward", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/taste");
  await ready(page);
  await countBursts(page);
  assert.deepEqual(await meter(page), { lit: 0, of: 4, depth: "4" });

  // a quarter in: the first star of the meter, and a word about it
  await answerKeys(page, 6);
  assert.equal((await meter(page)).lit, 1);
  assert.equal(await page.textContent("#app .pg-callout"), "First stars are lit");
  // halfway: the second star, and what Aurora is starting to see
  await answerKeys(page, 6, 6);
  assert.equal((await meter(page)).lit, 2);
  assert.match(await page.textContent("#app .pg-callout"), /^(A pattern is showing: .+|Halfway there)$/);
  // the deck thins as the round runs down
  await answerKeys(page, 10, 12);
  assert.deepEqual(await meter(page), { lit: 3, of: 4, depth: "2" });
  await answerKeys(page, 1, 22);
  assert.equal((await meter(page)).depth, "1");
  assert.equal(await bursts(page), 0, "a reward before the round was over");

  // the end: the number, the loved titles as a constellation, what Aurora learned — and the one burst
  await answerKeys(page, 1, 23);
  await page.waitForSelector("#app .ts-end.pg-reward");
  await page.waitForFunction(() => window.__bursts === 1, null, { timeout: 5000 });
  // (its parts rise in one after the other: measured when they have landed)
  await page.waitForFunction(() => document.querySelector("#app .ts-end").getAnimations({ subtree: true }).every((a) => a.playState !== "running" || !/^(play|pg)-(rise|pop|drop|fade)/.test(a.animationName || "")));
  const end = await page.evaluate(() => {
    const box = (s) => { const n = document.querySelector(s); const r = n && n.getBoundingClientRect(); return r ? Math.round(r.bottom) : null; };
    return {
      num: document.querySelector("#app .pg-end-num").textContent,
      sky: !!document.querySelector("#app .pg-end-sky svg"),
      said: document.querySelector("#app .pg-end-sky .play-sr").textContent.trim(),
      learned: document.querySelectorAll("#app .pg-learned .pg-tag.lit").length,
      focus: document.activeElement && document.activeElement.dataset.ui,
      more: box('#app .ts-end [data-ui="taste.more"]'), done: box('#app .ts-end [data-ui="taste.done"]'), h: window.innerHeight,
    };
  });
  assert.equal(end.num, "24");
  assert.ok(end.sky, "the loved titles are not drawn as a constellation");
  assert.equal(end.said, "8 stars lit, one for each title you loved.");
  assert.ok(end.learned >= 1, "nothing learned is shown");
  assert.equal(end.focus, "taste.more", "the keys are not on Keep going");
  assert.ok(end.more <= end.h && end.done <= end.h, `the end's keys are under the fold: ${JSON.stringify(end)}`);
  assert.equal((await meter(page)).lit, 4);
  await page.waitForTimeout(1200);
  assert.equal(await bursts(page), 1, "one reward for one round");

  // twelve more: a round of its own, with its own (smaller) burst — never two for one round
  await page.click('#app .ts-end [data-ui="taste.more"]');
  await page.waitForSelector(TOP);
  await answerKeys(page, 12, 24);
  await page.waitForSelector("#app .ts-end.pg-reward");
  await page.waitForFunction(() => window.__bursts === 2, null, { timeout: 5000 });
  assert.equal(await page.textContent("#app .pg-end-num"), "36");

  // away: nothing of the game is left behind
  await goto("#/movies");
  await page.waitForTimeout(500);
  assert.deepEqual(await leftovers(page), { nodes: 0, anims: [] });
});

ui.test("a small phone: the count stays on one line, the answer keys are clear of the tab bar, and the end fits with its keys in reach", { viewport: { width: 375, height: 667 }, device: { reducedMotion: "reduce" } }, async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/taste");
  await ready(page);
  await countBursts(page);
  const head = await page.evaluate(() => {
    const c = document.querySelector("#app .ts-count");
    const keys = [...document.querySelectorAll("#app .ts-answers .ts-answer")].map((k) => {
      const l = k.querySelector(".ts-answer-label").getBoundingClientRect();
      const on = document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2);
      return { label: k.textContent.trim(), bottom: Math.round(l.bottom), seen: !!on && k.contains(on) };
    });
    return { count: c.textContent, lines: Math.round(c.getBoundingClientRect().height / parseFloat(getComputedStyle(c).lineHeight || "0") || 0), keys, h: window.innerHeight };
  });
  assert.equal(head.count, "0 / 24");
  assert.equal(head.lines, 1, `"0 / 24" is on ${head.lines} lines`);
  for (const k of head.keys) assert.ok(k.seen && k.bottom <= head.h, `a key's label is covered or off the screen: ${JSON.stringify(k)}`);
  await assertNoHorizontalOverflow(page, "taste on a small phone");

  await answerKeys(page, 24);
  await page.waitForSelector("#app .ts-end.pg-reward");
  await page.waitForTimeout(600);
  // less motion: the end is simply there — no burst, nothing moving
  assert.equal(await bursts(page), 0, "a meteor burst for someone who asked for less motion");
  const end = await page.evaluate(() => {
    const seen = (s) => {
      const n = document.querySelector(s);
      const r = n.getBoundingClientRect();
      const on = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!on && n.contains(on) && r.bottom <= window.innerHeight;
    };
    return {
      more: seen('#app .ts-end [data-ui="taste.more"]'), done: seen('#app .ts-end [data-ui="taste.done"]'),
      num: document.querySelector("#app .pg-end-num").getBoundingClientRect().top >= 0,
      moving: document.getAnimations().filter((a) => a.playState === "running" && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".pg-taste")).map((a) => a.animationName || a.transitionProperty),
    };
  });
  assert.deepEqual(end, { more: true, done: true, num: true, moving: [] });
  await assertNoHorizontalOverflow(page, "the end on a small phone");
});

ui.test("a profile with nothing to show: the end says so — no spinner left over it, no row of noughts, no reward", async ({ page, goto, signIn, freshProfile }) => {
  // (a young child's profile: nothing in this catalogue carries a rating it may see)
  await signIn(await freshProfile({ kids: { maxAge: 7 } }));
  await goto("#/taste");
  await countBursts(page);
  await page.waitForSelector("#app .ts-end");
  const end = await page.evaluate(() => ({
    title: document.querySelector("#app .pg-end-title").textContent,
    blank: document.querySelector("#app .ts-end").classList.contains("is-blank"),
    tally: getComputedStyle(document.querySelector("#app .ts-end-tally")).display,
    wait: document.querySelectorAll("#app .ts-wait, #app .ts-stage .spinner").length,
    more: document.querySelectorAll('#app .ts-end [data-ui="taste.more"]').length,
    done: document.querySelectorAll('#app .ts-end [data-ui="taste.done"]').length,
  }));
  assert.deepEqual(end, { title: "That's every title we had for you", blank: true, tally: "none", wait: 0, more: 0, done: 1 });
  await page.waitForTimeout(800);
  assert.equal(await bursts(page), 0);
});

ui.run({ concurrency: 1 }); // (touch timing under a second test's load made taps read as long-presses)
