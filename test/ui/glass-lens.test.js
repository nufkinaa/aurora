// Real glass (glass.css "Real glass", js/glasslens.js): the things that would
// hurt if they broke.
//
//   - A rim belongs to its own surface. Between a phone and a wide desktop the
//     nav island is not centred any more; when it was also not placed, its
//     ring (::before) became the whole top bar's — a 999 px circle with lit
//     ends at the screen's edges (2026-11-19). Every ring is its surface's
//     size, at every width.
//   - The lens is Chromium's alone, and on a phone the tab bar's alone. An
//     iPhone never gets html[data-lens] (Safari would drop the whole backdrop
//     filter, the dim that holds the words with it).
//   - The maps live in one hidden <svg>. If it leaves the page it comes back
//     at once, and every lens points at a map that exists: a url() to
//     nothing makes Chromium draw no backdrop filter at all.
//   - The player's chrome takes the lens only while the film is paused (a
//     playing film changes every frame); the small buttons never do.
//   - The classic look gets no lens and no maps.
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();
const SCOPE = ".nav-items,.nav-logo,.nav-profile,.nav-gear,.nav-dl,.nav-remote,.hero-actions .btn:not(.btn-primary),.detail-actions .btn:not(.btn-primary),.player-bottom,.player-top > div,.player-top .pbtn,.upnext,.resume-card,.quality-pill,.party-pill";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

// every surface with a ring: is the ring the surface's own size?
const rings = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth > 0).map((e) => {
  const p = getComputedStyle(e, "::before");
  if (p.content === "none") return null;
  const pad = p.boxSizing === "border-box" ? 0 : 1;
  const w = parseFloat(p.width) + pad * (parseFloat(p.paddingLeft) + parseFloat(p.paddingRight)), h = parseFloat(p.height) + pad * (parseFloat(p.paddingTop) + parseFloat(p.paddingBottom));
  return { name: `${e.tagName.toLowerCase()}.${String(e.className).split(" ").slice(0, 2).join(".")}`, placed: getComputedStyle(e).position !== "static", own: Math.abs(w - e.offsetWidth) <= 2.5 && Math.abs(h - e.offsetHeight) <= 2.5, size: `${e.offsetWidth}x${e.offsetHeight}`, ring: `${Math.round(w)}x${Math.round(h)}` };
}).filter(Boolean);
// what the lens has done to the page
const lens = (sel) => ({
  on: document.documentElement.dataset.lens || null,
  defs: !!document.getElementById("rg-defs"),
  worn: [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth > 0).map((e) => {
    const m = /url\(#(rg-\d+)\)/.exec(e.style.getPropertyValue("--rg-lens"));
    return { name: String(e.className).split(" ")[0], id: m ? m[1] : null, there: m ? !!document.getElementById(m[1]) : null, filter: getComputedStyle(e).backdropFilter };
  }),
});
const lensReady = (page) => page.waitForFunction(() => document.documentElement.dataset.lens === "1" && /rg-[1-9]/.test(document.querySelector(".nav-items").style.getPropertyValue("--rg-lens")), null, { timeout: 15000 });

for (const [name, viewport] of [["1440", { width: 1440, height: 900 }], ["1024", { width: 1024, height: 768 }], ["768", { width: 768, height: 1024 }], ["390", { width: 390, height: 844 }]]) {
  ui.test(`glass, ${name} px: every rim is its own surface's, on Home and on a film's page`, { viewport }, async ({ page, signIn, freshProfile, goto, lib }) => {
    const me = await freshProfile();
    await signIn(me);
    for (const route of ["#/", `#/movie/${lib.film1.id}`]) {
      await goto(route);
      await page.waitForTimeout(500);
      const r = await page.evaluate(rings, SCOPE);
      assert.ok(r.some((x) => x.name.includes("nav-items")), `${route}: the nav's ring is there`);
      for (const x of r) assert.ok(x.placed && x.own, `${route}: the ring of ${x.name} (${x.size}) is ${x.ring}${x.placed ? "" : ", and the surface is not placed"}`);
    }
  });
}

// The second pass (2026-11-20): every glass pane in the page wears the nav's
// ring — a search field and its suggestions, Settings, a show's episodes, the
// Calendar, a sheet, the profile menu, the phone's side menu. Each ring is its
// own pane's (a pane that was not placed is given a place at no weight).
const PANES = ".menu,.nav-menu,.dropdown,.suggest-list,.toast,.peek,.look-notice,.party-panel,.trailer-box,.search-box,.claim-modal,.pref-section,.pair-card,.request-sent,.dl-callout,.detail-rate,.season-island,.calg-panel,.calg-next,.wn-card,.hero-unmute,.hero-pick,.episode,.source-row-wrap,.taste-tile,.party-strip-item,.profile-tile,.cal-entry,.chip,.cat-pill,.season-pill,.source-filter,.picker-btn,.hero-kicker,.calg-arrow,.episode-wrap > .ep-action,.btn:not(.btn-primary)";
for (const [name, viewport] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]]) {
  ui.test(`glass, ${name} px: every pane in the page wears the nav's ring, its own size`, { viewport }, async ({ page, signIn, freshProfile, goto, lib }) => {
    const me = await freshProfile();
    await signIn(me);
    const show = lib.show;
    const seen = new Set();
    const check = async (where) => {
      await page.waitForTimeout(400);
      const r = await page.evaluate(rings, PANES);
      for (const x of r) { seen.add(x.name.split(".")[1]); assert.ok(x.placed && x.own, `${where}: the ring of ${x.name} (${x.size}) is ${x.ring}${x.placed ? "" : ", and the pane is not placed"}`); }
    };
    await goto("#/search");
    await page.locator(".search-box input").fill("te");
    await page.waitForSelector(".suggest-list", { timeout: 8000 });
    await check("search");
    for (const route of ["#/preferences", `#/show/${show.id}`, "#/calendar"]) { await goto(route); await check(route); }
    await goto("#/");
    await page.evaluate(async () => (await import("/js/ui.js")).confirmSheet({ title: "Remove it?", text: "A sheet.", ok: "Remove", cancel: "Keep it" }));
    await page.waitForSelector(".look-notice");
    await check("a sheet");
    for (const k of ["search-box", "suggest-list", "pref-section", "episode", "look-notice"]) assert.ok(seen.has(k), `a ring on .${k}`);
    // what the ring draws: the nav's rim and glint, no light along the top
    const ring = await page.evaluate(() => getComputedStyle(document.querySelector(".look-notice"), "::before").backgroundImage);
    assert.match(ring, /radial-gradient/, "the glint");
    assert.match(ring, /linear-gradient\(rgba\(255, 255, 255, 0\.05\)/, "the Fresnel rim starts dim at the top");
  });
}

// The live lens on the one surface that stands alone where it is cheap
// (WHILE_OPEN): the search field, from tablet width up. Never a repeated
// item, never a sheet; on a phone the bar's alone (the field's and the side
// menu's lenses cost more than the runs vary there).
for (const [name, viewport] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]]) {
  ui.test(`glass, ${name} px: ${name === "390" ? "no lens on the search field or the side menu" : "the search field wears a lens that exists"}; a sheet and an episode card never do`, { viewport }, async ({ page, signIn, freshProfile, goto, lib }) => {
    const me = await freshProfile();
    await signIn(me);
    const filterOf = (sel) => page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).backdropFilter, sel);
    await goto("#/search");
    await lensReady(page);
    if (name === "390") {
      await page.waitForTimeout(600);
      assert.doesNotMatch(await filterOf(".search-box"), /url\(/, "a phone's search field keeps its plain frost");
    } else {
      await page.waitForFunction(() => { const e = document.querySelector(".search-box"); const m = e && /url\(#(rg-[1-9]\d*)\)/.exec(e.style.getPropertyValue("--rg-lens")); return !!(m && document.getElementById(m[1]) && /url\(/.test(getComputedStyle(e).backdropFilter)); }, null, { timeout: 8000 });
    }
    await goto("#/");
    await lensReady(page);
    await page.evaluate(async () => (await import("/js/ui.js")).confirmSheet({ title: "Remove it?", text: "A sheet.", ok: "Remove", cancel: "Keep it" }));
    await page.waitForSelector(".look-notice");
    await page.waitForTimeout(500);
    assert.doesNotMatch(await filterOf(".look-notice"), /url\(/, "a sheet keeps its plain frost");
    if (name === "390") {
      await goto("#/");
      await page.locator(".nav-more").click();
      await page.waitForSelector(".nav-more-sheet");
      await page.waitForTimeout(500);
      assert.doesNotMatch(await filterOf(".nav-more-sheet"), /url\(/, "the side menu has no lens");
    }
    await goto(`#/show/${lib.show.id}`);
    await page.waitForSelector(".episode");
    await page.waitForTimeout(600);
    const cards = await page.evaluate(() => [...document.querySelectorAll(".episode, .dl-row, .calg-day, .chip")].filter((e) => /url\(/.test(getComputedStyle(e).backdropFilter) || e.style.getPropertyValue("--rg-lens")).length);
    assert.equal(cards, 0, "no repeated item wears a lens");
  });
}

ui.test("glass, desktop Chrome: the bar and the buttons wear a lens that exists; the maps come back if they are taken out", async ({ page, signIn, freshProfile, goto }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/");
  await lensReady(page);
  let l = await page.evaluate(lens, SCOPE);
  assert.ok(l.defs, "the maps are in the page");
  const bar = l.worn.find((x) => x.name === "nav-items");
  assert.ok(bar.id && bar.there, "the bar's lens is a map that exists");
  assert.match(bar.filter, /url\(/, "the bar's backdrop is drawn through it");
  assert.match(bar.filter, /brightness/, "and still dimmed");
  for (const x of l.worn) if (x.id) assert.ok(x.there, `${x.name} points at a map that exists`);
  // the hidden <svg> is taken out of the page
  await page.evaluate(() => document.getElementById("rg-defs").remove());
  await page.waitForFunction(() => !!document.getElementById("rg-defs"), null, { timeout: 5000 });
  await page.waitForTimeout(200);
  l = await page.evaluate(lens, SCOPE);
  for (const x of l.worn) if (x.id) assert.ok(x.there, `after the maps were taken out, ${x.name} points at a map that exists`);
  assert.ok(l.worn.find((x) => x.name === "nav-items").id, "the bar wears a lens again");
});

ui.test("glass, an Android phone: the lens is the tab bar's alone", { viewport: { width: 390, height: 844 } }, async ({ page, signIn, freshProfile, goto }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/");
  await lensReady(page);
  const l = await page.evaluate(lens, SCOPE);
  for (const x of l.worn) {
    if (x.name === "nav-items") { assert.ok(x.id && x.there, "the tab bar's lens exists"); assert.match(x.filter, /url\(/); }
    else { assert.equal(x.id, null, `${x.name} has no map on a phone`); assert.doesNotMatch(x.filter, /url\(/, `${x.name} keeps the plain backdrop`); }
  }
});

ui.test("glass, an iPhone: no lens at all, and the tab bar keeps its dim", { viewport: { width: 390, height: 844 }, device: { userAgent: IPHONE } }, async ({ page, signIn, freshProfile, goto }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/");
  await page.waitForTimeout(1200);
  const l = await page.evaluate(lens, SCOPE);
  assert.equal(l.on, null, "html[data-lens] is not set");
  assert.equal(l.defs, false, "no maps are drawn");
  for (const x of l.worn) assert.doesNotMatch(x.filter, /url\(/, `${x.name}: no url() in the backdrop filter`);
  assert.match(l.worn.find((x) => x.name === "nav-items").filter, /brightness/, "the tab bar is still dimmed");
});

ui.test("the player's chrome takes the lens only while the film is paused", async ({ page, signIn, freshProfile, goto, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto(`#/play/${lib.film1.id}`);
  await page.waitForSelector(".player .player-bottom", { timeout: 25000 });
  const sel = ".player-bottom,.player-top > div,.player-top .pbtn";
  const state = () => page.evaluate((s) => ({
    paused: document.querySelector(".player video").paused,
    cls: document.querySelector(".player").classList.contains("is-paused"),
    filters: [...document.querySelectorAll(s)].filter((e) => e.offsetWidth > 0).map((e) => getComputedStyle(e).backdropFilter),
  }), sel);
  // playing: no lens anywhere on the chrome (a film changes every frame)
  await page.evaluate(async () => { const v = document.querySelector(".player video"); v.muted = true; await v.play().catch(() => {}); });
  await page.waitForFunction(() => !document.querySelector(".player video").paused, null, { timeout: 15000 });
  await page.waitForTimeout(1500); // (the maps are drawn at an idle moment: even with them there, nothing is shown)
  let st = await state();
  assert.equal(st.cls, false, "a playing film: .player is not .is-paused");
  assert.ok(st.filters.length >= 2, "the player's chrome is up");
  for (const f of st.filters) assert.doesNotMatch(f, /url\(/, "no lens over a playing film");
  // paused: the dock wears its lens, and it is a map that exists
  await page.evaluate(() => document.querySelector(".player video").pause());
  await page.waitForFunction(() => document.querySelector(".player").classList.contains("is-paused"), null, { timeout: 5000 });
  await page.waitForFunction(() => /url\(/.test(getComputedStyle(document.querySelector(".player-bottom")).backdropFilter), null, { timeout: 8000 });
  const dock = await page.evaluate(() => { const m = /url\(#(rg-\d+)\)/.exec(document.querySelector(".player-bottom").style.getPropertyValue("--rg-lens")); return { id: m && m[1], there: !!(m && document.getElementById(m[1])), filter: getComputedStyle(document.querySelector(".player-bottom")).backdropFilter }; });
  assert.ok(dock.id && dock.there, "the paused dock's lens is a map that exists");
  assert.match(dock.filter, /brightness/, "and still dimmed");
  // ten seconds of nothing moving: the lens rests (the page behind the player still draws frames)
  await page.evaluate(() => document.querySelector(".player").classList.add("glass-rest"));
  const rest = await page.evaluate(() => getComputedStyle(document.querySelector(".player-bottom")).backdropFilter);
  assert.doesNotMatch(rest, /url\(/, "resting: no bend");
  assert.equal(rest.replace(/url\([^)]*\)\s*/, ""), dock.filter.replace(/url\([^)]*\)\s*/, ""), "resting: the same frost and the same dim, so nothing jumps");
  await page.mouse.move(300, 300); await page.mouse.move(320, 320);
  await page.waitForFunction(() => !document.querySelector(".player").classList.contains("glass-rest"), null, { timeout: 4000 });
  // playing again: gone again
  await page.evaluate(() => document.querySelector(".player video").play().catch(() => {}));
  await page.waitForFunction(() => !document.querySelector(".player").classList.contains("is-paused"), null, { timeout: 5000 });
  st = await state();
  for (const f of st.filters) assert.doesNotMatch(f, /url\(/, "playing again: no lens");
  const r = await page.evaluate(rings, sel);
  assert.ok(r.length >= 2, "its rims are drawn");
  for (const x of r) assert.ok(x.placed && x.own, `the ring of ${x.name} (${x.size}) is ${x.ring}`);
});

for (const [mw, mh] of [[1024, 768], [768, 1024]]) ui.test(`glass, ${mw} px: the profile menu opens above the bar`, { viewport: { width: mw, height: mh } }, async ({ page, signIn, freshProfile, goto }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/");
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector(".nav-profile").click());
  await page.waitForSelector(".nav-menu", { timeout: 8000 });
  await page.waitForTimeout(400);
  // every corner region of the menu is the menu's own (nothing of the bar paints or catches clicks over it)
  const hits = await page.evaluate(() => {
    const m = document.querySelector(".nav-menu"), r = m.getBoundingClientRect();
    return [[0.1, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9]].map(([fx, fy]) => { const e = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy); return !!e && (m.contains(e) || e === m); });
  });
  assert.deepEqual(hits, [true, true, true, true, true], "the menu is on top everywhere");
});

ui.test("the classic look: no lens, no maps", async ({ page, api, signIn, freshProfile, goto }) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
  await signIn(me);
  await goto("#/");
  await page.waitForTimeout(1200);
  const l = await page.evaluate(lens, SCOPE);
  assert.equal(l.on, null);
  assert.equal(l.defs, false);
  for (const x of l.worn) assert.equal(x.id, null, `${x.name} has no map`);
});

ui.run({ concurrency: 2 });
