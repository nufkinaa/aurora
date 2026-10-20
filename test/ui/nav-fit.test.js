// The top nav on a phone, in both looks: nothing in it is cut off by the
// screen's edge, and the page does not scroll sideways.
//
// Found 2026-10-20: in the classic look at 390 px the nav strip ran past the
// right edge on Search (and every other screen) — "My List" cut in half, New,
// Settings and the profile chip out of sight, to be found only by swiping a
// strip that did not look swipeable. The glass look keeps the logo and the
// profile at the top and the sections in a tab bar at the bottom.
//
// SHOTS=<folder>: also write a screenshot of each case there.
// FIT_LOG=<file>: the measurements, one JSON line per case.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const measure = (page) => page.evaluate(() => {
  const shown = (el) => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && b.width > 0 && b.height > 0; };
  const nav = document.getElementById("nav");
  const items = [...nav.querySelectorAll(".nav-logo, .nav-item, .nav-profile, .nav-dl, .nav-remote")].filter(shown).map((el) => {
    const b = el.getBoundingClientRect();
    return { name: el.getAttribute("data-ui") || el.className.split(" ")[0], text: (el.textContent || "").trim().slice(0, 12), left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, top: Math.round(b.top), bottom: Math.round(b.bottom) };
  });
  return { vw: document.documentElement.clientWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, navScroll: nav.scrollWidth - nav.clientWidth, items };
});

for (const [name, viewport] of [["390", { width: 390, height: 844 }], ["375", { width: 375, height: 667 }]]) {
  for (const look of ["glass", "legacy"]) {
    ui.test(`phone ${name} px, ${look}: every nav item is on screen, on Search, Home and Movies`, { viewport }, async ({ page, api, signIn, freshProfile, goto }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      await signIn(me);
      for (const route of ["#/search", "#/", "#/movies"]) {
        await goto(route);
        await page.waitForTimeout(400); // (the nav's own fade-in)
        const m = await measure(page);
        const where = route.replace("#/", "") || "home";
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `nav-${look}-${name}-${where}.png`) }).catch(() => {});
        if (process.env.FIT_LOG) fs.appendFileSync(process.env.FIT_LOG, JSON.stringify({ case: `${look}-${name}-${where}`, ...m }) + "\n");
        assert.ok(m.sw <= m.vw + 1, `${route}: the page scrolls sideways (${m.sw} > ${m.vw})`);
        for (const want of ["nav.search", "nav.home", "nav.movies", "nav.shows", "nav.mylist", "nav.settings", "nav.profile"]) {
          assert.ok(m.items.some((i) => i.name === want), `${route}: ${want} is not shown at all: ${JSON.stringify(m.items.map((i) => i.name))}`);
        }
        for (const i of m.items) {
          assert.ok(i.left >= -0.5 && i.right <= m.vw + 0.5, `${route}: ${i.name} "${i.text}" is cut off: ${i.left}..${i.right} on a ${m.vw} px screen`);
          assert.ok(i.top >= -0.5 && i.bottom <= m.vh + 0.5, `${route}: ${i.name} is off the screen vertically: ${i.top}..${i.bottom}`);
        }
      }
    });
  }
}

ui.run({ concurrency: 2 });
