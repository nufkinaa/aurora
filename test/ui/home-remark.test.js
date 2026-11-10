// Home's remark (src/lib/remarks via public/js/remark.js): a line of the
// page's own at once, the server's line once it answers, and nothing on the
// page moves when one replaces the other; within ten minutes the same line
// comes back with no request at all. A desktop (the greeting under the
// billboard) and an iPhone held upright (the greeting on it).
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite, DESKTOP } = require("./helpers");

const ui = suite();
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const LOCAL = [...fs.readFileSync(path.join(__dirname, "../../public/js/remark.js"), "utf8")
  .matchAll(/^\s+"([^"\n]+)",$/gm)].map((m) => m[1]);

const boxes = (page) => page.evaluate(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height }; };
  const greet = document.querySelector(".home-greeting");
  let next = greet && greet.nextElementSibling;
  while (next && !next.getBoundingClientRect().height) next = next.nextElementSibling;
  return {
    text: document.querySelector(".home-greeting .greet-sub")?.textContent || "",
    greet: r(greet), next: r(next), info: r(document.querySelector(".hero .hero-info")),
    onHero: !!(greet && greet.parentElement && greet.parentElement.classList.contains("hero")),
  };
});

const run = async ({ page, signIn, freshProfile, goto }, { onHero }) => {
  assert.ok(LOCAL.length >= 20, `the page's own lines (${LOCAL.length})`);
  const me = await freshProfile();
  await page.addInitScript(() => {
    window.__shifts = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shifts.push({ t: e.startTime, v: e.value }); })
        .observe({ type: "layout-shift", buffered: true });
    } catch {}
  });
  // the server answers late, so the page's own line is seen first
  let asked = 0;
  let served = null;
  await page.route("**/api/profiles/*/remark*", async (route) => {
    asked++;
    const resp = await route.fetch();
    const body = await resp.text();
    await new Promise((r) => setTimeout(r, 2000));
    try { served = JSON.parse(body); } catch {}
    await route.fulfill({ response: resp, body });
  });
  await signIn(me);
  await goto("#/");
  await page.locator(".home-greeting .greet-sub").waitFor();
  // watch the swap itself: where things were on the last frame before it,
  // and where they are right after it (document coordinates)
  await page.evaluate(() => {
    const sub = document.querySelector(".home-greeting .greet-sub");
    const greet = sub.closest(".home-greeting");
    const nextOf = () => { let n = greet.nextElementSibling; while (n && !n.getBoundingClientRect().height) n = n.nextElementSibling; return n; };
    const snap = () => {
      const g = greet.getBoundingClientRect(); const n = nextOf(); const y = window.scrollY || document.body.scrollTop || 0;
      return { text: sub.textContent, top: g.top + y, h: g.height, next: n ? n.getBoundingClientRect().top + y : null, at: performance.now() };
    };
    window.__swap = null;
    window.__first = snap();
    let last = window.__first;
    const tick = () => { if (!window.__swap) { last = snap(); requestAnimationFrame(tick); } };
    requestAnimationFrame(tick);
    new MutationObserver(() => { if (!window.__swap && sub.textContent !== last.text) window.__swap = { before: last, after: snap() }; })
      .observe(sub, { childList: true, characterData: true, subtree: true });
  });
  const first = await page.evaluate(() => window.__first);
  assert.ok(LOCAL.includes(first.text), `first, a line of the page's own: "${first.text}"`);
  assert.equal((await boxes(page)).onHero, onHero);
  for (let i = 0; i < 180 && !served; i++) await page.waitForTimeout(500);
  const server = served;
  assert.ok(server && server.id && server.text.length <= 64, JSON.stringify(server));
  await page.waitForFunction((t) => document.querySelector(".home-greeting .greet-sub")?.textContent === t, server.text, { timeout: 5000 })
    .catch(() => {}); // (under the billboard a taller line is not swapped in: checked below)
  await page.waitForTimeout(600);
  const after = await boxes(page);
  const swap = await page.evaluate(() => window.__swap);
  if (onHero) {
    assert.equal(after.text, server.text, "on the billboard the server's line always comes in");
    assert.ok(after.info.top - after.greet.bottom >= 11.5, "the remark runs into the billboard's words");
  } else if (swap) {
    assert.equal(swap.after.text, server.text);
    assert.equal(swap.after.top, swap.before.top, "the greeting moved");
    assert.equal(swap.after.h, swap.before.h, "the greeting changed height");
    assert.equal(swap.after.next, swap.before.next, "what is under the greeting moved");
  } else {
    assert.equal(after.text, first.text, "no swap seen, yet the text changed");
  }
  if (swap) {
    const during = await page.evaluate((t) => window.__shifts.filter((e) => e.t >= t - 20 && e.t <= t + 400).reduce((a, e) => a + e.v, 0), swap.before.at);
    assert.ok(during < 0.001, `layout shift during the swap: ${during}`);
  }
  // back within ten minutes: the same line, at once, no request
  const n = asked;
  await goto("#/search");
  await goto("#/");
  await page.locator(".home-greeting .greet-sub").waitFor();
  await page.waitForTimeout(300);
  const back = await boxes(page);
  if (after.text === server.text) assert.equal(back.text, server.text, "the line did not hold");
  assert.equal(asked, n, "asked the server again within the hold");
};

ui.test("a desktop: the page's line, then the server's, nothing moves", { viewport: DESKTOP }, async (fx) => {
  await run(fx, { onHero: false });
});

ui.test("an iPhone upright: the server's line on the billboard, clear of its words", {
  viewport: { width: 402, height: 750 }, device: { screen: { width: 402, height: 874 }, deviceScaleFactor: 3, userAgent: IPHONE },
}, async (fx) => {
  await run(fx, { onHero: true });
});
ui.run({ concurrency: 1 });
