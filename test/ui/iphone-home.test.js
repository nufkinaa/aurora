// Home on an iPhone held upright, glass look (elia, 2026-11-10, a photo from
// his iPhone's Home Screen): the billboard ran up under the status bar and
// the top buttons, and the greeting sat under it as a block of its own.
// Three rules, pinned here (glass.css "Home on a phone held upright"):
//   1. the billboard starts under the top buttons, 10px clear of them;
//   2. its bottom is no lower than where the greeting used to end (the old
//      slab: 8px down, min(60vh, 530px) tall; then the greeting: 114px, or
//      90px on a screen under 700px), and the first shelf is 12px under it;
//   3. the greeting is ON the billboard, clear of the billboard's own words.
// Plus the top-left logo is a 42px circle level with the gear, the tab bar
// at the bottom is 59px tall (53 before), and the picture is not dimmed:
// one fade from the bottom, a shade from the top behind the greeting.
//
// The insets are Chrome's own safe-area emulation (as in iphone-topbar.test.js),
// on a 3x screen with an iPhone's user agent and screen size.
const assert = require("node:assert/strict");
const { suite, DESKTOP } = require("./helpers");

const ui = suite();

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

// [case, width, height, top inset, screen height]
const CASES = [
  ["16 Pro, Home Screen (elia's photo)", 402, 874, 62, 874],
  ["16 Pro, Safari tab", 402, 750, 0, 874],
  ["SE, Safari tab", 375, 548, 0, 667],
  ["SE (1st), Home Screen", 320, 568, 20, 568],
];

const measure = (page) => page.evaluate(() => {
  const box = (el) => {
    if (typeof el === "string") el = document.querySelector(el);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return b.width || b.height ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height } : null;
  };
  const buttons = [".nav-logo", ".nav-dl", ".nav-gear", ".nav-profile"].map((s) => box(s)).filter(Boolean);
  const greet = document.querySelector(".home-greeting");
  const row = [...document.querySelectorAll("#app .row-title")].find((e) => e.getBoundingClientRect().height > 0);
  return {
    vh: innerHeight,
    buttonsBottom: Math.max(...buttons.map((b) => b.bottom)),
    hero: box(".hero"), info: box(".hero-info"), title: box(".hero-title"),
    greet: box(greet), greetOnHero: !!(greet && greet.parentElement && greet.parentElement.classList.contains("hero")),
    row: box(row),
    logo: box(".nav-logo"), gear: box(".nav-gear"), mark: box(".nav-logo .logo-mark"),
    tabbar: box(".nav-items"),
    picFilter: (() => { const e = document.querySelector(".hero .hero-backdrop.on"); return e ? getComputedStyle(e).filter : null; })(),
    fade: getComputedStyle(document.querySelector(".hero .hero-fade")).backgroundImage,
    shade: greet ? (() => { const cs = getComputedStyle(greet, "::before"); return { image: cs.backgroundImage, h: parseFloat(cs.height) }; })() : null,
    titleShadow: getComputedStyle(document.querySelector(".hero-title")).textShadow,
    cls: window.__cls,
    sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
  };
});

// Home, painted, with its first slide and the greeting in place
const openHome = async (page, goto) => {
  await page.addInitScript(() => {
    window.__cls = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
        .observe({ type: "layout-shift", buffered: true });
    } catch {}
  });
  await goto("#/");
  await page.locator(".hero .hero-title").waitFor();
  await page.locator(".home-greeting .greet-name").waitFor();
  await page.waitForTimeout(400);
};

let me = null;
for (const [name, width, height, inset, screenH] of CASES) {
  const device = { screen: { width, height: screenH }, deviceScaleFactor: 3, userAgent: IPHONE };
  ui.test(`${name}: the billboard under the top buttons, no lower than the old greeting, the greeting on it`, { viewport: { width, height }, device }, async ({ page, context, signIn, freshProfile, goto }) => {
    me = me || await freshProfile();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: inset, topMax: inset, bottom: inset ? 34 : 0, bottomMax: inset ? 34 : 0 } });
    await signIn(me);
    await openHome(page, goto);
    const m = await measure(page);
    assert.ok(m.sw <= m.vw + 1, `the page scrolls sideways (${m.sw} > ${m.vw})`);

    // 1. under the buttons, 10px clear
    assert.ok(Math.abs(m.hero.top - (m.buttonsBottom + 10)) <= 1, `the billboard starts at ${m.hero.top}, the buttons end at ${m.buttonsBottom} (want 10px between)`);
    // 2. no lower than where the greeting ended before; the shelf 12px under it
    const room = height < 700 ? 90 : 114;
    const oldEnd = 8 + Math.min(0.6 * m.vh, 530) + room;
    assert.ok(m.hero.bottom <= oldEnd + 0.5, `the billboard ends at ${m.hero.bottom}, lower than the greeting used to (${oldEnd})`);
    assert.ok(m.hero.bottom >= oldEnd - 1.5, `the billboard ends at ${m.hero.bottom}, short of the old greeting's end (${oldEnd})`);
    assert.ok(m.row, "no shelf title");
    assert.ok(Math.abs(m.row.top - (m.hero.bottom + 12)) <= 1, `the first shelf's title at ${m.row.top}, the billboard ends at ${m.hero.bottom}`);
    // 3. the greeting on the billboard, inside it, clear of its words
    assert.ok(m.greetOnHero, "the greeting is not on the billboard");
    assert.ok(m.greet.top >= m.hero.top - 0.5 && m.greet.bottom <= m.hero.bottom, "the greeting runs out of the billboard");
    assert.ok(m.info.top - m.greet.bottom >= 11.5, `the greeting (ends ${m.greet.bottom}) runs into the billboard's words (from ${m.info.top})`);
    assert.ok(m.title.top >= m.hero.top, "the title runs out of the top of the billboard");
    // the picture at full brightness (elia, 2026-11-10), one fade from the
    // bottom, and a shade from the top as deep as the greeting (+56px) — not
    // a halo on the letters
    assert.ok(!/brightness/.test(m.picFilter || ""), `the picture is dimmed (${m.picFilter})`);
    assert.equal((m.fade.match(/linear-gradient/g) || []).length, 1, `more than the bottom fade over the picture: ${m.fade}`);
    assert.match(m.fade, /to top|0deg/, "the fade is not from the bottom");
    assert.match(m.shade.image, /linear-gradient/, "no shade from the top behind the greeting");
    assert.ok(Math.abs(m.shade.h - (m.greet.bottom - m.greet.top + 56)) <= 1, `the top shade is ${m.shade.h}px, the greeting ${m.greet.bottom - m.greet.top}px`);
    assert.ok(m.shade.h < m.hero.bottom - m.hero.top - 150, "the top shade reaches the middle of the picture");
    assert.ok((m.titleShadow.match(/rgba?\(/g) || []).length <= 1, `the title wears a halo of shadows: ${m.titleShadow}`);
    // nothing jumped while it came in
    assert.ok(m.cls < 0.01, `Home's layout shifted by ${m.cls.toFixed(4)} while it loaded`);

    // the logo: a circle like the gear, level with it
    assert.ok(Math.abs(m.logo.w - 42) <= 0.5 && Math.abs(m.logo.h - 42) <= 0.5, `the logo's glass is ${m.logo.w} x ${m.logo.h}`);
    assert.ok(Math.abs(m.logo.top - m.gear.top) <= 0.5, `the logo (${m.logo.top}) is not level with the gear (${m.gear.top})`);
    const cx = (b) => (b.left + b.right) / 2, cy = (b) => (b.top + b.bottom) / 2;
    assert.ok(Math.abs(cx(m.mark) - cx(m.logo)) <= 0.5 && Math.abs(cy(m.mark) - cy(m.logo)) <= 0.5, "the mark is not centred in its glass");
    // the tab bar: 59px
    assert.ok(Math.abs(m.tabbar.h - 59) <= 1, `the tab bar is ${m.tabbar.h}px tall`);
  });
}

// A long title on a short screen: the remark gives way before anything meets.
ui.test("SE (1st) in a Safari tab, a long title: the greeting gives way, nothing meets", { viewport: { width: 320, height: 460 }, device: { screen: { width: 320, height: 568 }, deviceScaleFactor: 3, userAgent: IPHONE } }, async ({ page, signIn, freshProfile, goto }) => {
  await page.route(/\/api\/home\?/, async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    if (data.hero && data.hero[0]) data.hero[0].title = "The Extraordinary and Completely Unbelievable Adventures of Someone";
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await signIn(await freshProfile());
  await openHome(page, goto);
  const m = await measure(page);
  assert.ok(m.greetOnHero, "the greeting is not on the billboard");
  assert.ok(m.info.top - m.greet.bottom >= 11.5, `the greeting (ends ${m.greet.bottom}) runs into the billboard's words (from ${m.info.top})`);
  assert.ok(m.title.top >= m.hero.top, "the title runs out of the top of the billboard");
  const roomLeft = await page.evaluate(() => document.querySelector(".hero").dataset.room);
  assert.ok(Number(roomLeft) < 2, `the remark kept its two lines (room ${roomLeft})`);
});

// The tab bar clears what the phone keeps at the bottom: an iPhone's home
// indicator (34px inset: the bar 20px up, as before) and an Android gesture
// bar (24px inset: 18px up — it used to sit 10px up, on the handle).
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
for (const [name, ua, inset, bottomInset, want] of [["an iPhone from the Home Screen", IPHONE, 59, 34, 20], ["an Android phone, installed, gesture bar", ANDROID, 36, 24, 18], ["an Android phone in Chrome", ANDROID, 0, 0, 10]]) {
  ui.test(`${name}: the tab bar sits ${want}px up`, { viewport: { width: 393, height: 852 }, device: { screen: { width: 393, height: 852 }, deviceScaleFactor: 3, userAgent: ua } }, async ({ page, context, signIn, freshProfile, goto }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: inset, topMax: inset, bottom: bottomInset, bottomMax: bottomInset } });
    await signIn(await freshProfile());
    await openHome(page, goto);
    const m = await measure(page);
    assert.ok(Math.abs(m.vh - m.tabbar.bottom - want) <= 0.5, `the tab bar ends ${m.vh - m.tabbar.bottom}px above the bottom (want ${want})`);
    assert.ok(Math.abs(m.hero.top - (m.buttonsBottom + 10)) <= 1, `the billboard starts at ${m.hero.top}, the buttons end at ${m.buttonsBottom}`);
  });
}

// Elsewhere the greeting stays where it was: under the billboard.
ui.test("a desktop: the greeting under the billboard, the logo with its word", { viewport: DESKTOP }, async ({ page, signIn, freshProfile, goto }) => {
  await signIn(await freshProfile());
  await openHome(page, goto);
  const m = await measure(page);
  assert.ok(!m.greetOnHero, "the greeting moved onto the billboard on a desktop");
  assert.ok(m.greet.top >= m.hero.bottom - 0.5, "the greeting is not under the billboard");
  assert.ok(m.logo.w > 80, `the logo lost its word (${m.logo.w}px wide)`);
});
ui.test("an iPhone in the classic look: the greeting under the billboard", { viewport: { width: 402, height: 874 }, device: { screen: { width: 402, height: 874 }, deviceScaleFactor: 3, userAgent: IPHONE } }, async ({ page, api, signIn, freshProfile, goto }) => {
  const p = await freshProfile();
  await api.ok("PUT", `/api/profiles/${p.id}`, { look: "legacy" }, await api.as(p));
  await signIn(p);
  await openHome(page, goto);
  const m = await measure(page);
  assert.ok(!m.greetOnHero, "the greeting moved onto the billboard in the classic look");
  assert.ok(m.greet.top >= m.hero.bottom - 0.5, "the greeting is not under the billboard");
});
// Turned on its side: back under the billboard (and onto it again upright).
ui.test("an iPhone turned on its side and back: the greeting follows", { viewport: { width: 402, height: 874 }, device: { screen: { width: 402, height: 874 }, deviceScaleFactor: 3, userAgent: IPHONE } }, async ({ page, signIn, freshProfile, goto }) => {
  await signIn(await freshProfile());
  await openHome(page, goto);
  assert.ok((await measure(page)).greetOnHero, "upright: not on the billboard");
  await page.setViewportSize({ width: 874, height: 402 });
  await page.waitForFunction(() => !document.querySelector(".hero > .home-greeting"));
  const m = await measure(page);
  assert.ok(m.greet.top >= m.hero.bottom - 0.5, "on its side: the greeting is not under the billboard");
  await page.setViewportSize({ width: 402, height: 874 });
  await page.waitForFunction(() => !!document.querySelector(".hero > .home-greeting"));
});

ui.run({ concurrency: 1 });
