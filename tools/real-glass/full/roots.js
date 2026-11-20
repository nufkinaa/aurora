// What a lensed surface can see behind it: its ancestors that make a
// backdrop root (filter, opacity < 1, backdrop-filter, mask, mix-blend).
//   node tools/real-glass/full/roots.js
"use strict";
const { launch, openPage, go, sleep } = require("../../glass-apple/lib");
const { OPEN } = require("../../glass-apple/targets");
const anc = (sel) => { const e = document.querySelector(sel); if (!e) return sel + ": none"; const out = []; for (let n = e; n && n !== document.documentElement; n = n.parentElement) { const cs = getComputedStyle(n); const why = []; if (cs.filter !== "none") why.push("filter"); if (parseFloat(cs.opacity) < 1) why.push("opacity " + cs.opacity); if (cs.backdropFilter && cs.backdropFilter !== "none") why.push("bdf " + cs.backdropFilter.slice(0, 60)); if (cs.maskImage && cs.maskImage !== "none") why.push("mask"); if (cs.mixBlendMode !== "normal") why.push("blend"); out.push(n.tagName + "." + String(n.className).slice(0, 30) + (why.length ? " [" + why.join("; ") + "]" : "")); } return sel + ":\n   " + out.join("\n   "); };
(async () => {
  const b = await launch();
  try {
    for (const size of ["desktop", "phone-390"]) {
      const h = await openPage(b, { size });
      await go(h, "home"); await OPEN.profileMenu(h.page); await sleep(800);
      console.log(size, await h.page.evaluate(anc, ".nav-menu"));
      await go(h, "home"); await OPEN.sheet(h.page); await sleep(800);
      console.log(size, await h.page.evaluate(anc, ".look-notice"));
      await go(h, "search"); await OPEN.suggest(h.page); await sleep(800);
      console.log(size, await h.page.evaluate(anc, ".search-box"));
      if (size !== "desktop") { await go(h, "home"); await h.page.click(".nav-more"); await sleep(900); console.log(size, await h.page.evaluate(anc, ".nav-more-sheet")); }
      await h.ctx.close();
    }
  } finally { await b.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
