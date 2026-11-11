// Version C's moving light: the nav island photographed while the pointer
// crosses it (desktop), six frames, stacked by light.py into one strip.
//
//   node tools/glass-options/light.js <outdir>
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, sleep } = require("../glass-apple/lib");

(async () => {
  const out = process.argv[2] || "light";
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  try {
    const h = await openPage(b, { size: "desktop", side: "after", glass: "c", dpr: 2 });
    await go(h, "home");
    const r = await h.page.evaluate(() => { const e = document.querySelector(".nav-items").getBoundingClientRect(); return { x: e.left, y: e.top, w: e.width, h: e.height }; });
    const clip = { x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 16), width: r.w + 32, height: r.h + 32 };
    const n = 6;
    for (let i = 0; i < n; i++) {
      const px = r.x + 20 + ((r.w - 40) * i) / (n - 1);
      const py = r.y + r.h * (i % 2 ? 0.85 : 0.15);
      await h.page.mouse.move(px, py, { steps: 4 });
      await sleep(250);
      await h.page.screenshot({ path: path.join(out, `light-${i}.png`), clip });
      const v = await h.page.evaluate(() => { const e = document.querySelector(".nav-items"); return [e.style.getPropertyValue("--g-mx"), e.style.getPropertyValue("--g-my")]; });
      console.log("frame", i, Math.round(px), Math.round(py), v.join(" "));
    }
    await h.ctx.close();
  } finally { await b.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
