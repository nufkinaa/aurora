// The top controls on an iPhone, in both looks: under the status bar, a
// little lower on a Dynamic Island iPhone (14 Pro and later) and nowhere
// else, with everything placed under them moving the same amount.
//
// elia, 2026-10-29, a photo of his island iPhone (Safari, glass, Home): the
// logo pill, the downloads button, the gear and the avatar sat right up
// against the status bar, and looked soft.
//
// The insets are Chrome's own safe-area emulation (DevTools'
// Emulation.setSafeAreaInsetsOverride), on a 3x screen with an iPhone's user
// agent and screen size:
//   standalone (Home Screen app)  the page runs under the status bar: the top
//                                 inset is 59-62 on an island phone, 47 on a
//                                 notch one, 20 on an old one
//   a Safari tab                  the top inset is 0 on every iPhone; the
//                                 boot script knows an island phone by its
//                                 screen (html.ios-island)
//
// SHOTS=<folder>: also write a screenshot of the top of each case there.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

// [case, width, height, top inset, user agent, island gap expected]
const CASES = [
  ["15 Pro, Home Screen", 393, 852, 59, IPHONE, 10],
  ["15 Pro, Safari tab", 393, 852, 0, IPHONE, 10],
  ["15 Pro Max, Home Screen", 430, 932, 59, IPHONE, 10],
  ["15 Pro Max, Safari tab", 430, 932, 0, IPHONE, 10],
  ["16 Pro, Home Screen", 402, 874, 62, IPHONE, 10],
  ["14 (notch), Home Screen", 390, 844, 47, IPHONE, 0],
  ["14 (notch), Safari tab", 390, 844, 0, IPHONE, 0],
  ["14 Plus (notch), Safari tab", 428, 926, 0, IPHONE, 0],
  ["12 mini (notch), Home Screen", 375, 812, 50, IPHONE, 0],
  ["SE (old), Home Screen", 375, 667, 20, IPHONE, 0],
  // the inset alone decides from the Home Screen (no user-agent sniffing)
  ["an island-sized inset, any browser", 393, 852, 59, ANDROID, 10],
  ["a phone-sized screen, not an iPhone", 393, 852, 0, ANDROID, 0],
];

const measure = (page) => page.evaluate(() => {
  const px = (css) => {
    const el = document.createElement("div");
    el.style.cssText = `position:fixed;top:0;left:0;width:1px;visibility:hidden;height:${css}`;
    document.body.append(el);
    const h = el.getBoundingClientRect().height;
    el.remove();
    return h;
  };
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return b.width ? { top: b.top, bottom: b.bottom } : null;
  };
  const nav = document.getElementById("nav");
  const mark = document.querySelector(".nav-logo .logo-mark");
  const h1 = [...document.querySelectorAll("#app .screen h1")].find((e) => e.getBoundingClientRect().height > 0);
  return {
    sat: px("env(safe-area-inset-top, 0px)"),
    gap: px("var(--top-gap, 0px)"),
    island: document.documentElement.classList.contains("ios-island"),
    logo: box(".nav-logo"), gear: box(".nav-gear"), profile: box(".nav-profile"),
    navTop: nav.getBoundingClientRect().top,
    navPadTop: parseFloat(getComputedStyle(nav).paddingTop),
    navOverflow: getComputedStyle(nav).overflowX,
    markFilter: getComputedStyle(mark).filter,
    glowFilter: getComputedStyle(mark, "::before").filter,
    heading: h1 ? h1.getBoundingClientRect().top : null,
    vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
  };
});

const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1, `${what}: ${a} (expected ${b})`);

// the reference for the page heading: the notch phone in a Safari tab (no
// inset, no gap) — it runs first
const REF = "14 (notch), Safari tab";
const ordered = [CASES.find((c) => c[0] === REF), ...CASES.filter((c) => c[0] !== REF)];
const headings = {};
const profiles = {};

for (const look of ["glass", "legacy"]) {
  for (const [name, width, height, inset, userAgent, wantGap] of ordered) {
    const device = { screen: { width, height }, deviceScaleFactor: 3, userAgent };
    ui.test(`${look}, ${name}: the top controls ${wantGap ? "sit lower" : "keep their place"}, the page under them moves with them`, { viewport: { width, height }, device }, async ({ page, context, api, signIn, freshProfile, goto }) => {
      if (!profiles[look]) {
        const me = await freshProfile();
        if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
        profiles[look] = me;
      }
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: inset, topMax: inset, bottom: inset ? 34 : 0, bottomMax: inset ? 34 : 0 } });
      await signIn(profiles[look]);
      await goto("#/list");
      await page.waitForTimeout(300);
      const m = await measure(page);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${look}-${name.replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "").toLowerCase()}.png`), clip: { x: 0, y: 0, width, height: 200 } }).catch(() => {});

      near(m.sat, inset, "the emulated top inset");
      near(m.gap, wantGap, "the island gap");
      assert.equal(m.island, userAgent === IPHONE && wantGap > 0, "html.ios-island");
      assert.ok(m.sw <= m.vw + 1, `the page scrolls sideways (${m.sw} > ${m.vw})`);
      // nothing of the top controls under the status bar (or beside the island)
      for (const k of ["logo", "gear", "profile"]) {
        assert.ok(m[k], `${k} is not on screen`);
        assert.ok(m[k].top >= inset + wantGap, `${k} starts at ${m[k].top}, under the status bar (${inset}) + gap (${wantGap})`);
      }
      if (look === "glass") {
        // the pills: max(10, inset) down, plus the gap
        near(m.navPadTop, Math.max(10, inset) + wantGap, "the nav's top padding");
        near(m.logo.top, Math.max(10, inset) + 4 + wantGap, "the logo pill's top");
        near(m.gear.top, Math.max(10, inset) + 2 + wantGap, "the gear's top");
        near(m.profile.top, Math.max(10, inset) + 3 + wantGap, "the avatar's top");
        // an iOS rasterisation guard: the glass phone nav is not a scroll box
        assert.equal(m.navOverflow, "visible", "the glass phone nav is a scroll box again");
      } else {
        // the classic bar starts at the top and pads itself under the status bar
        near(m.navTop, 0, "the bar's top");
        near(m.navPadTop, inset + wantGap, "the bar's top padding");
      }
      // the other guard: the logo mark is drawn without a filter, its glow is a layer under it
      assert.equal(m.markFilter, "none", `the logo mark itself is filtered (${m.markFilter})`);
      assert.match(m.glowFilter, /drop-shadow/, "the logo's glow is gone");
      // the page heading moves with the controls (and, classic, below the status bar)
      assert.ok(m.heading !== null, "no page heading");
      if (name === REF) headings[look] = m.heading;
      else if (headings[look] != null) near(m.heading, headings[look] + wantGap + (look === "legacy" ? inset : 0), "the page heading's top");
    });
  }
}

ui.run({ concurrency: 1 });
