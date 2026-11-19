// Nothing moved: every element's box with today's stylesheet ("before",
// GA_BEFORE_CSS) and with this worktree's, on the screens that carry the glass
// chrome. Real glass gives some surfaces `position: relative` (for the rim's
// ring) — this is the proof that no child was placed against something else.
//
//   node tools/real-glass/layout-same.js
"use strict";
const { launch, openPage, go, sleep } = require("../glass-apple/lib");

const boxes = () => [...document.querySelectorAll("body *")].filter((e) => !e.closest("#rg-defs") && !e.closest("canvas")).map((e) => {
  const r = e.getBoundingClientRect();
  return [e.tagName + "." + String(e.className && e.className.baseVal != null ? e.className.baseVal : e.className).slice(0, 50), Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2];
});

(async () => {
  const b = await launch();
  let bad = 0;
  try {
    for (const size of ["phone-390", "phone-320", "tablet-768", "desktop"]) {
      const sides = {};
      for (const side of ["before", "after"]) {
        const h = await openPage(b, { size, side });
        sides[side] = {};
        for (const route of ["home", "libfilm", "libshow", "film", "downloads", `#/play/${h.inst.lib.film1}`]) {
          await go(h, route);
          if (route.startsWith("#/play")) {
            await h.page.waitForSelector(".player video", { timeout: 25000 });
            await h.page.evaluate(() => { const v = document.querySelector(".player video"); v.pause(); v.currentTime = 5; document.querySelector(".player").classList.remove("controls-hidden"); });
            await sleep(1500);
            await h.page.evaluate(() => document.querySelector(".player").classList.remove("controls-hidden"));
          }
          await sleep(600);
          sides[side][route] = await h.page.evaluate(boxes);
        }
        await h.ctx.close();
      }
      for (const route of Object.keys(sides.before)) {
        const A = sides.before[route], B = sides.after[route];
        let diff = 0;
        const n = Math.min(A.length, B.length);
        for (let i = 0; i < n; i++) {
          // (the same tag: classes change as pictures arrive)
          if (A[i][0].split(".")[0] !== B[i][0].split(".")[0]) { diff = -1; break; }
          if (A[i].slice(1).join() !== B[i].slice(1).join()) { if (diff < 6) console.log("   moved:", JSON.stringify(A[i]), "->", JSON.stringify(B[i].slice(1))); diff++; }
        }
        if (diff || A.length !== B.length) bad++;
        console.log(size, route, "elements", A.length, B.length, diff === -1 ? "DIFFERENT TREE" : `moved ${diff}`);
      }
    }
  } finally { await b.close(); }
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
