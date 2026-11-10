// The blur and saturation numbers, found by looking: the same bar over the
// same posters (and over white text) with each pair of values.
//
//   node tools/glass-apple/blurgrid.js <outdir> [size]
//
// Writes <size>.<backdrop>.b<blur>.s<sat>.png — a crop of the bar.
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, sleep } = require("./lib");

(async () => {
  const [out = "blurgrid", size = "phone"] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  try {
    const h = await openPage(b, { size, side: "after" });
    const { page } = h;
    for (const bd of ["posters", "text"]) {
      await go(h, "home");
      if (bd === "posters") {
        // the fixture's own colourful posters under the bar
        await page.evaluate(() => {
          const bar = document.querySelector(".nav-items").getBoundingClientRect();
          const row = [...document.querySelectorAll(".row")].filter((r) => r.querySelector(".card img") && r.getBoundingClientRect().top + scrollY > innerHeight * 0.75)[0];
          const cr = row.querySelector(".card img").getBoundingClientRect();
          scrollTo(0, Math.round(cr.top + scrollY + cr.height * 0.5 - (bar.top + bar.height / 2)));
        });
      } else await page.evaluate(() => window.__ga.backdrop("text"));
      await sleep(900);
      const clip = await page.evaluate(() => { const r = document.querySelector(".nav-items").getBoundingClientRect(); return { x: Math.max(0, r.left - 12), y: Math.max(0, r.top - 12), width: Math.min(innerWidth - Math.max(0, r.left - 12), r.width + 24), height: r.height + 24 }; });
      for (const blur of [3, 6, 10]) for (const sat of [1.3, 1.8, 2.3]) {
        await page.evaluate(([bl, s]) => document.documentElement.style.setProperty("--g-blur", `blur(${bl}px) saturate(${s})`), [blur, sat]);
        await sleep(250);
        await page.screenshot({ path: path.join(out, `${size}.${bd}.b${blur}.s${sat}.png`), clip });
      }
    }
    await h.ctx.close();
  } finally { await b.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
