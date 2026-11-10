// The press "lens" on a tab, photographed: the bar at rest and with one tab
// held down (Chrome's own :active, forced through the debugger so the still
// is the same every time), over the page as it is and over bright posters.
//
//   node tools/glass-apple/lens.js <outdir> [size,size]
"use strict";
const fs = require("fs");
const path = require("path");
const { launch, openPage, go, sleep } = require("./lib");

(async () => {
  const [out = "lens", sizesArg = "phone,desktop"] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const b = await launch();
  try {
    for (const size of sizesArg.split(",")) {
      const h = await openPage(b, { size, side: "after" });
      const { page } = h;
      const cdp = await h.ctx.newCDPSession(page);
      for (const bd of ["page", "bright"]) {
        await go(h, "home");
        if (bd === "bright") await page.evaluate(([s, f]) => window.__ga.brightRow(s, { frac: f }), [".nav-items", size.startsWith("phone") ? 0.5 : 0.3]);
        await sleep(600);
        const clip = await page.evaluate(() => { const r = document.querySelector(".nav-items").getBoundingClientRect(); return { x: Math.max(0, r.left - 16), y: Math.max(0, r.top - 16), width: Math.min(innerWidth - Math.max(0, r.left - 16), r.width + 32), height: Math.min(innerHeight - Math.max(0, r.top - 16), r.height + 32) }; });
        await page.screenshot({ path: path.join(out, `${size}.${bd}.rest.png`), clip });
        await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
        // the second tab that is not the chosen one
        const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".nav-items .nav-item:not(.active)" });
        const nodeId = nodeIds[1] || nodeIds[0];
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
        await sleep(350);
        await page.screenshot({ path: path.join(out, `${size}.${bd}.pressed.png`), clip });
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      }
      await h.ctx.close();
    }
  } finally { await b.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
