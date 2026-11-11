// The phone's side menu (More) must stay exactly as it is today (elia,
// 2026-11-11): photographed open with today's stylesheet (origin/master's
// bundle, GA_BEFORE_CSS) and this worktree's, at three phone widths in both
// looks, and compared pixel for pixel over the menu's own box.
//
//   node tools/glass-options/more-same.js <outdir>
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, sleep, SIZES } = require("../glass-apple/lib");

SIZES["phone-375"] = SIZES["phone-375"] || { width: 375, height: 812, dpr: 3, mobile: true, ua: SIZES.phone.ua };
SIZES["phone-430"] = SIZES["phone-430"] || { width: 430, height: 932, dpr: 3, mobile: true, ua: SIZES.phone.ua };

(async () => {
  const out = process.argv[2] || "more-same";
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  const rows = [];
  try {
    for (const size of ["phone-390", "phone-375", "phone-430"]) {
      for (const look of ["glass", "legacy"]) {
        const shots = {};
        for (const side of ["before", "after"]) {
          const h = await openPage(b, { size, side, look, dpr: 2 });
          await go(h, "home");
          await h.page.evaluate(() => document.querySelector(".nav-more").click());
          await h.page.waitForSelector(".nav-more-sheet");
          await sleep(900);
          const r = await h.page.evaluate(() => { const e = document.querySelector(".nav-more-sheet").getBoundingClientRect(); return { x: e.left, y: e.top, width: e.width, height: e.height }; });
          const file = path.join(out, `${size}.${look}.${side}.png`);
          await h.page.screenshot({ path: file, clip: r });
          shots[side] = { file, r };
          await h.ctx.close();
        }
        rows.push({ size, look, before: shots.before.file, after: shots.after.file, box: shots.after.r });
        console.log(size, look, "shot");
      }
    }
  } finally { await b.close(); }
  fs.writeFileSync(path.join(out, "pairs.json"), JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
