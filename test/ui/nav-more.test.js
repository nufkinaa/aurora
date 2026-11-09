// Every screen within reach on a small phone, in both looks (2026-11-06).
//
// elia's iPhone (glass): the tab bar held "AI Home Movies Shows My List" and
// the magnifier; New and Saved fell off or needed a sideways swipe nobody
// sees, and on a 320 px phone with AI and Saved on, Search itself went past
// the edge. The bar now holds Home, Movies, Shows, My List, More and Search
// (docs/android-phone/NAV.md, docs/web-nav.md); More's sheet has every other
// place. Checked here, at 320, 360, 375 and 430 px, in a Safari tab and
// from the Home Screen (Chrome's safe-area emulation, as
// iphone-content-clear.test.js does):
//   - the bar holds exactly those six, in that order, all on screen, and no
//     word in it is cut off — also with AI, Saved and New's dot switched on;
//   - each of the sheet's lines is on screen (scrolled to, on a short phone),
//     its words not cut off, and it opens its screen (or sheet);
//   - the bar fits its words when they are larger (text zoom): narrower
//     sides, smaller words, then More as three dots, never a cut;
//   - Your TVs: the top bar's button while a TV is on, and the sheet's line
//     saying which TV is on;
//   - a desktop has no More and keeps its nav.
// SHOTS=<folder>: a screenshot of the bar and of the open sheet per case.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, DESKTOP } = require("./helpers");
const { SimTV } = require("./support/sim-tv");

const ui = suite();
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
// [name, width, height, top inset (0: a Safari tab)]
const CASES = [
  ["320 (SE 1st gen), Safari tab", 320, 568, 0],
  ["320 (SE 1st gen), Home Screen", 320, 568, 20],
  ["360 (Android), browser", 360, 780, 0],
  ["375 (SE), Safari tab", 375, 667, 0],
  ["375 (mini), Home Screen", 375, 812, 47],
  ["430 (Pro Max), Safari tab", 430, 932, 0],
  ["430 (Pro Max), Home Screen", 430, 932, 59],
];
const BAR = ["nav.home", "nav.movies", "nav.shows", "nav.mylist", "nav.more", "nav.search"];
// [data-more, the words, where it leads] — the TV rail's places in its order
// and words, then NAV.md's set and words, then Settings and you at the foot
// (js/navmore.js). "profile" carries the person's name.
const MENU = [
  ["search", "Search", "#/search"],
  ["home", "Home", "#/"],
  ["movies", "Movies", "#/movies"],
  ["shows", "Shows", "#/shows"],
  ["list", "My List", "#/list"],
  ["calendar", "Calendar", "#/calendar"],
  ["pick", "AI", "#/pick"],
  ["new", "What's new", "#/new"],
  ["saved", "Saved on this device", "#/saved"],
  ["downloads", "My downloads", "#/downloads"],
  ["remote", "Your TVs", "#/remote"],
  ["household", "Recommended by your household", "#/household"],
  ["wrapped", "Your Aurora Wrapped", "#/wrapped"],
  ["taste", "Swipe your taste", "#/taste"],
  ["apps", "Get the apps", "/install"],
  ["pair", "Sign in a TV", "#/pair"],
  ["party", "Join a watch party", "sheet:.look-notice-wrap input"],
  ["report", "Report a problem", "sheet:.report-wrap"],
  ["settings", "Settings", "#/preferences"],
  ["profile", null, "sheet:.nav-menu"],
];
const IN_BAR = new Set(["search", "home", "movies", "shows", "list"]);

// The bar as drawn: what is shown, in order, and whether anything spills.
const readBar = () => {
  const vw = document.documentElement.clientWidth;
  const bar = document.querySelector(".nav-items");
  const r = bar.getBoundingClientRect();
  const items = [...bar.children].filter((e) => getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0).map((e) => {
    const b = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    // the words (or the icon) against the room inside the item's padding
    // (not the news dot: a decoration at the word's shoulder)
    const words = [];
    for (const n of e.childNodes) {
      if (n.nodeType === 3) { const range = document.createRange(); range.selectNodeContents(n); words.push(...range.getClientRects()); }
      else if (n.nodeType === 1 && !n.classList.contains("nav-new-dot") && getComputedStyle(n).display !== "none") words.push(...n.getClientRects());
    }
    for (let k = words.length - 1; k >= 0; k--) if (!(words[k].width > 0)) words.splice(k, 1);
    const wl = words.length ? Math.min(...words.map((x) => x.left)) : b.left;
    const wr = words.length ? Math.max(...words.map((x) => x.right)) : b.right;
    const inner = { left: b.left + parseFloat(cs.paddingLeft) - 0.5, right: b.right - parseFloat(cs.paddingRight) + 0.5 };
    return {
      ui: e.dataset.ui, text: (e.innerText || e.getAttribute("aria-label") || "").trim(),
      left: b.left, right: b.right, top: b.top, bottom: b.bottom,
      cut: e.scrollWidth > e.clientWidth + 1 || wl < inner.left - 1 || wr > inner.right + 1,
      oneLine: words.length <= 1 || new Set(words.map((x) => Math.round(x.top))).size === 1,
    };
  }).sort((a, b) => a.left - b.left);
  return { vw, vh: innerHeight, sw: document.documentElement.scrollWidth, bar: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, spill: bar.scrollWidth - bar.clientWidth }, fit: [...bar.classList].filter((c) => c.startsWith("fit-")), items };
};
const assertBar = (m, where) => {
  assert.deepEqual(m.items.map((i) => i.ui), BAR, `${where}: the bar holds ${JSON.stringify(m.items.map((i) => i.ui))}`);
  assert.ok(m.bar.spill <= 1, `${where}: the bar's items spill by ${m.bar.spill}px`);
  assert.ok(m.sw <= m.vw + 1, `${where}: the page scrolls sideways (${m.sw} > ${m.vw})`);
  for (const i of m.items) {
    assert.ok(!i.cut, `${where}: "${i.text}" (${i.ui}) is cut off`);
    assert.ok(i.oneLine, `${where}: "${i.text}" wraps`);
    assert.ok(i.left >= m.bar.left - 0.5 && i.right <= m.bar.right + 0.5, `${where}: ${i.ui} runs out of the bar (${i.left}..${i.right} in ${m.bar.left}..${m.bar.right})`);
    assert.ok(i.left >= -0.5 && i.right <= m.vw + 0.5 && i.top >= -0.5 && i.bottom <= m.vh + 0.5, `${where}: ${i.ui} is off the screen`);
  }
};

const emulate = async (page, context, inset) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: inset, topMax: inset, bottom: inset ? 34 : 0, bottomMax: inset ? 34 : 0 } });
};
// The server of these tests has no AI key; the AI tab (and AI pick) are
// shown exactly as they are when /api/ai/status says it has one.
const aiOn = (page) => page.route("**/api/ai/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) }));

const openSheet = async (page) => {
  await page.locator("#nav-more").click();
  await page.waitForSelector(".nav-more-sheet");
  // (it slides in from the left)
  await page.waitForFunction(() => document.querySelector(".nav-more-sheet").getAnimations().every((a) => a.playState !== "running"));
};
const lineOf = (page, id) => page.evaluate((id) => {
  const row = document.querySelector(`.nav-more-item[data-more="${id}"]`);
  if (!row) return null;
  row.scrollIntoView({ block: "nearest" });
  // the row against what shows of its part of the menu (the scrolling list, or the foot)
  const s = row.parentElement.getBoundingClientRect();
  const p = document.querySelector(".nav-more-sheet").getBoundingClientRect();
  const b = row.getBoundingClientRect();
  const label = row.querySelector(".nav-more-label");
  const l = label.getBoundingClientRect();
  return {
    words: label.textContent, sub: (row.querySelector(".nav-more-sub") || {}).textContent || null,
    inSheet: b.top >= s.top - 0.5 && b.bottom <= s.bottom + 0.5 && b.left >= s.left - 0.5 && b.right <= s.right + 0.5,
    cut: label.scrollWidth > label.clientWidth + 1 || l.right > b.right + 0.5,
    onScreen: p.top >= 0 && p.bottom <= innerHeight + 0.5 && p.left >= 0 && p.right <= document.documentElement.clientWidth,
    tall: b.height,
  };
}, id);
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`) }).catch(() => {});
};

for (const look of ["glass", "legacy"]) {
  for (const [name, width, height, inset] of CASES) {
    const device = { screen: { width, height }, deviceScaleFactor: 2, userAgent: IPHONE };
    // (a library frame the private server has not made yet answers 404 on
    // some of the screens visited: the browser's own line, not a defect)
    ui.test(`${look}, ${name}: the bar fits Home · Movies · Shows · My List · More · Search, and every place in More opens`, { viewport: { width, height }, device, allow: [/Failed to load resource.*\/img\/still\//] }, async ({ page, context, api, signIn, freshProfile, goto }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      await aiOn(page);
      await emulate(page, context, inset);
      await signIn(me);
      await goto("#/");
      await page.waitForFunction(() => !document.getElementById("nav-pick").classList.contains("hidden"));
      await page.waitForTimeout(400);
      assertBar(await page.evaluate(readBar), "Home");
      // AI, Saved and New's dot all on: they stay in More, the bar keeps its six
      await page.evaluate(() => {
        document.getElementById("nav-saved").classList.remove("hidden");
        document.getElementById("nav-new").classList.add("has-new");
      });
      await page.waitForFunction(() => document.getElementById("nav-more").classList.contains("has-new"));
      assertBar(await page.evaluate(readBar), "Home, with AI, Saved and news");
      await shot(page, `${look}-${name}-bar`);

      // the bar's own places
      for (const [ui, hash] of [["nav.movies", "#/movies"], ["nav.shows", "#/shows"], ["nav.mylist", "#/list"], ["nav.search", "#/search"], ["nav.home", "#/"]]) {
        await page.locator(`.nav-items [data-ui="${ui}"]`).click();
        await page.waitForFunction((h) => (location.hash || "#/") === h, hash);
      }

      // every line of More: on screen, its words whole, and where it leads
      await openSheet(page);
      await shot(page, `${look}-${name}-more`);
      const words = await page.$$eval(".nav-more-item .nav-more-label", (ls) => ls.map((l) => l.textContent));
      assert.deepEqual(words, MENU.map(([, w]) => w || me.name), "the menu's lines, in order");
      for (const [id, wordsOf, to] of MENU) {
        const want = wordsOf || me.name;
        if (!(await page.locator(".nav-more-sheet").isVisible())) await openSheet(page);
        const line = await lineOf(page, id);
        assert.ok(line, `${id}: not in the sheet`);
        assert.equal(line.words, want);
        assert.ok(line.inSheet && line.onScreen, `${id}: "${want}" is not on screen in the sheet (${JSON.stringify(line)})`);
        assert.ok(!line.cut, `${id}: "${want}" is cut off`);
        assert.ok(line.tall >= 44, `${id}: a ${line.tall}px line is smaller than a finger`);
        if (to === "/install") {
          assert.equal(await page.locator(`.nav-more-item[data-more="${id}"]`).getAttribute("href"), "/install");
          continue;
        }
        await page.locator(`.nav-more-item[data-more="${id}"]`).click();
        if (to.startsWith("sheet:")) {
          await page.waitForSelector(to.slice(6), { state: "visible" });
          await page.waitForSelector(".nav-more-wrap", { state: "detached" }); // (More gives way to its sheet)
          // (the join sheet's code field keeps Escape for itself: its Cancel)
          if (id === "party") await page.locator(".look-notice-wrap button", { hasText: "Cancel" }).click();
          else await page.keyboard.press("Escape");
          await page.waitForSelector(to.slice(6), { state: "detached" });
          continue;
        }
        await page.waitForFunction((h) => (h === "#/" ? (location.hash || "#/") === "#/" : location.hash.startsWith(h)), to);
        await page.waitForSelector(".nav-more-wrap", { state: "detached" });
        if (id === "remote") {
          // the remote takes the whole screen (its own ⌄ and "Your TVs" at the top)
          await page.waitForSelector(".remote-screen");
          await goto("#/");
          continue;
        }
        // More is lit on a screen only it leads to; the bar's own places light their tab
        if (IN_BAR.has(id)) await page.waitForFunction(() => !document.getElementById("nav-more").classList.contains("active"));
        else await page.waitForFunction(() => document.getElementById("nav-more").classList.contains("active"));
        assert.equal(await page.locator(".nav-items .nav-item.active:visible").count(), 1, `${to}: not exactly one tab lit`);
        // the screen is there with its bar, nothing pushed sideways
        assertBar(await page.evaluate(readBar), to);
      }

      // the menu's look: from the left edge, the whole height, the mark and the word on top
      await openSheet(page);
      const box = await page.evaluate(() => {
        const p = document.querySelector(".nav-more-sheet").getBoundingClientRect();
        return { left: p.left, top: p.top, bottom: p.bottom, width: p.width, brand: document.querySelector(".nav-more-brand").textContent, mark: document.querySelector(".nav-more-logo .logo-mark").getBoundingClientRect().width };
      });
      assert.equal(box.left, 0);
      assert.equal(box.top, 0);
      assert.ok(Math.abs(box.bottom - height) <= 1 && box.width >= 240 && box.width <= Math.min(288, width * 0.86) + 1, JSON.stringify(box));
      assert.equal(box.brand, "Aurora");
      assert.equal(box.mark, 36);
      // closing: a tap beside it, a swipe to the left, Back (on a narrow phone
      // the menu covers More itself, as the TV's panel covers its page)
      await page.mouse.click(width - 6, Math.round(height / 2));
      await page.waitForSelector(".nav-more-wrap", { state: "detached" });
      await openSheet(page);
      const cdp = await context.newCDPSession(page);
      const y = Math.round(height / 2);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y }] });
      for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200 - i * 25, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
      await page.waitForSelector(".nav-more-wrap", { state: "detached" });
      await openSheet(page);
      await page.keyboard.press("Escape");
      await page.waitForSelector(".nav-more-wrap", { state: "detached" });
    });
  }
}

// Larger words (a reader's text zoom): the bar fits itself instead of cutting.
for (const look of ["glass", "legacy"]) {
  // (26px a rem at 320: the bar cannot hold the words without its steps)
  for (const [px, width] of [[18, 320], [22, 320], [26, 320], [24, 360]]) {
    ui.test(`${look}, ${width} px with the words at ${px}px a rem: the bar steps down and nothing is cut`, { viewport: { width, height: 640 }, device: { deviceScaleFactor: 2, userAgent: IPHONE } }, async ({ page, api, signIn, freshProfile, goto }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      await signIn(me);
      await goto("#/");
      await page.waitForTimeout(300);
      await page.evaluate((px) => { document.documentElement.style.fontSize = `${px}px`; window.dispatchEvent(new Event("resize")); }, px);
      // (the fit runs on the next frame)
      await page.waitForFunction(() => {
        const bar = document.querySelector(".nav-items");
        return bar.scrollWidth <= bar.clientWidth + 1 && [...bar.children].every((i) => i.scrollWidth <= i.clientWidth + 1);
      }, null, { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(100);
      const m = await page.evaluate(readBar);
      if (px >= 26) assert.ok(m.fit.length > 0, `at ${px}px the bar took no step: ${JSON.stringify(m.items.map((i) => i.text))}`);
      assertBar(m, `${px}px words`);
      await shot(page, `${look}-${width}-zoom-${px}`);
      // back to the normal size: back to the words as they were
      await page.evaluate(() => { document.documentElement.style.fontSize = ""; window.dispatchEvent(new Event("resize")); });
      await page.waitForTimeout(300);
      const n = await page.evaluate(readBar);
      assert.deepEqual(n.fit, [], "the steps are taken back");
      assertBar(n, "normal words");
    });
  }
}

// Your TVs, one tap away: the top bar's button while a TV is on, the sheet
// says which, and both open the remote.
for (const look of ["glass", "legacy"]) {
  ui.test(`${look}, 320 px: with a TV on, Your TVs is in the top bar and More says which TV`, { viewport: { width: 320, height: 568 }, device: { deviceScaleFactor: 2, userAgent: IPHONE } }, async ({ page, srv, api, signIn, freshProfile, goto }) => {
    const me = await freshProfile();
    if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
    const tv = new SimTV({ url: srv.url, profile: me, name: "Living room TV" });
    await tv.start();
    try {
      await signIn(me);
      await goto("#/");
      await page.waitForSelector("#nav-remote:not([hidden])", { timeout: 20000 });
      // (its look comes with remote.css, fetched when the first TV appears)
      await page.waitForFunction(() => document.getElementById("nav-remote").getBoundingClientRect().width >= 32);
      const top = await page.evaluate(() => {
        const b = document.getElementById("nav-remote").getBoundingClientRect();
        const logo = document.querySelector(".nav-logo").getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, name: document.getElementById("nav-remote").getAttribute("aria-label"), vw: document.documentElement.clientWidth, logoRight: logo.right };
      });
      assert.equal(top.name, "Your TVs");
      assert.ok(top.w >= 32 && top.left > top.logoRight && top.right <= top.vw && top.top >= 0, `the TV button is not clear on screen: ${JSON.stringify(top)}`);
      assertBar(await page.evaluate(readBar), "with a TV on");
      await openSheet(page);
      const line = await lineOf(page, "remote");
      assert.equal(line.sub, "Living room TV · on");
      await shot(page, `${look}-320-tv-on-more`);
      await page.locator('.nav-more-item[data-more="remote"]').click();
      await page.waitForFunction(() => location.hash.startsWith("#/remote"));
      await goto("#/");
      await page.locator("#nav-remote").click();
      await page.waitForFunction(() => location.hash.startsWith("#/remote"));
    } finally {
      await tv.stop();
    }
  });
}

// Swipe your taste's list (#/taste/list): its heading starts where My List's
// does. It added the nav's height twice (the page's own padding on top of its
// .browse-head's), a whole bar of empty screen above "What do you love?".
for (const look of ["glass", "legacy"]) {
  for (const [name, width, height, inset] of [["375, Safari tab", 375, 667, 0], ["430, Home Screen", 430, 932, 59], ["desktop", 1280, 720, 0]]) {
    const device = width < 600 ? { screen: { width, height }, deviceScaleFactor: 2, userAgent: IPHONE } : null;
    ui.test(`${look}, ${name}: the Taste list starts at My List's spacing`, { viewport: { width, height }, ...(device ? { device } : {}) }, async ({ page, context, api, signIn, freshProfile, goto }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      if (inset) await emulate(page, context, inset);
      await signIn(me);
      const top = async (route) => {
        await goto(route);
        await page.locator("#app .browse-head h1").first().waitFor();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);
        return page.evaluate(() => document.querySelector("#app .browse-head h1").getBoundingClientRect().top);
      };
      const list = await top("#/list");
      const taste = await top("#/taste/list");
      assert.ok(Math.abs(taste - list) <= 1, `the Taste list's heading at ${taste}, My List's at ${list}`);
      // (and no stray "null" where the "Not for me" answers go when there are none)
      assert.doesNotMatch(await page.locator("#app .taste").innerText(), /null/);
    });
  }
}

// A desktop: no More; the nav is the one it was.
for (const look of ["glass", "legacy"]) {
  ui.test(`${look}, desktop: no More, the nav keeps its places`, { viewport: DESKTOP }, async ({ page, api, signIn, freshProfile, goto }) => {
    const me = await freshProfile();
    if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
    await signIn(me);
    await goto("#/");
    assert.equal(await page.locator("#nav-more").isVisible(), false);
    for (const ui of ["nav.search", "nav.home", "nav.movies", "nav.shows", "nav.mylist", "nav.settings", "nav.profile"]) {
      assert.equal(await page.locator(`[data-ui="${ui}"]`).isVisible(), true, ui);
    }
    if (look === "glass") assert.equal(await page.locator("#nav-new").isVisible(), true, "the glass desktop keeps New");
  });
}

ui.run({ concurrency: 3 });
