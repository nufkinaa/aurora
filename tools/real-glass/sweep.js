// The sweep's photographs: every kind of glass pane in the page, today's
// stylesheet (GA_BEFORE_CSS) and this worktree's, on the private instance.
//
//   node tools/real-glass/sweep.js <outdir> [a,e] [scene,…]
//
// Writes <outdir>/<scene>.<a|e>.png (the whole screen; desktop 2x, phone 3x).
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, settle, sleep } = require("../glass-apple/lib");
const { OPEN } = require("../glass-apple/targets");

const scroll = (y) => async (page) => { await page.evaluate((v) => scrollTo(0, v), y); await page.waitForTimeout(400); };
const type = (text) => async (page) => {
  const input = await page.waitForSelector(".search-box input, input.search-input, input[type='search']", { timeout: 8000 });
  await input.click(); await input.type(text, { delay: 50 });
  await page.waitForTimeout(1200);
};
const SCENES = [
  { id: "episodes", route: "libshow", stage: [scroll(430)] },
  { id: "search", route: "search", stage: [type("te")] },
  { id: "search-results", route: "#/search/Test" },
  { id: "calendar", route: "#/calendar" },
  { id: "calendar-month", route: "#/calendar?grid=1" },
  { id: "movies", route: "movies" },
  { id: "settings", route: "settings" },
  { id: "downloads", route: "downloads" },
  { id: "title", route: "libfilm" },
  { id: "menu", route: "home", stage: [OPEN.profileMenu] },
  { id: "toast", route: "home", stage: [OPEN.toast] },
  { id: "sheet", route: "home", stage: [OPEN.sheet] },
  { id: "new", route: "#/new" },
  // (phones: the side menu, More)
  { id: "more", route: "home", phone: true, stage: [async (page) => { await page.click(".nav-more"); await page.waitForTimeout(900); }] },
];
(async () => {
  const [out = "sweep", vArg = "a,e", only = ""] = process.argv.slice(2);
  const pick = only ? only.split(",") : null;
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  try {
    for (const v of vArg.split(",")) for (const size of ["desktop", "phone-390"]) {
      const h = await openPage(b, { size, side: v === "a" ? "before" : "after", dpr: size === "desktop" ? 2 : 3 });
      for (const s of SCENES.filter((x) => (!pick || pick.includes(x.id)) && !(x.phone && size === "desktop"))) {
        try {
          await go(h, s.route);
          for (const step of s.stage || []) { await step(h.page); await sleep(250); }
          await settle(h.page, h.pending, { quietMs: 500, capMs: 8000 });
          await sleep(400);
          await h.page.screenshot({ path: path.join(out, `${s.id}.${size === "desktop" ? "d" : "p"}.${v}.png`) });
        } catch (e) { console.log(v, size, s.id, "FAILED", e.message.split("\n")[0]); }
      }
      await h.ctx.close();
    }
  } finally { await b.close(); }
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
